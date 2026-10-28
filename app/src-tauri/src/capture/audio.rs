//! Stream audio through Windows process loopback (Windows 10 2004+), like Discord:
//! - sharing a window: only that application's sound (its process tree);
//! - sharing a screen: everything except Linkord itself, so viewers never hear the voice chat echoed back.
//! Delivers 20 ms chunks of 48 kHz stereo f32, ready for the Opus encoder.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use windows::core::{implement, Interface, HRESULT, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IAgileObject, IAgileObject_Impl, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

pub const FRAME: usize = 960;
const CHANNELS: usize = 2;

/// Diagnostics for the stream stats: the device's own mix format (0 when Windows doesn't say, as for process
/// loopback) and how often WASAPI reported a gap in the captured audio.
pub static MIX_RATE: AtomicU32 = AtomicU32::new(0);
pub static MIX_CHANNELS: AtomicU32 = AtomicU32::new(0);
pub static DISCONTINUITIES: AtomicU32 = AtomicU32::new(0);

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// PROPVARIANT holding a VT_BLOB, laid out like the C struct (the activation API wants a blob of params).
#[repr(C)]
struct BlobVariant {
    vt: u16,
    reserved: [u16; 3],
    size: u32,
    data: *const u8,
}

pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

/// What the stream's audio contains.
#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    /// Only this process tree (sharing an app).
    Only(u32),
    /// Everything except this process tree (sharing a screen).
    AllExcept(u32),
    /// Plain loopback of the default output device. Windows 10 has nothing finer.
    System,
}

impl AudioCapture {
    pub fn start(source: Source, mut on_chunk: impl FnMut(Vec<u8>) + Send + 'static) -> Result<AudioCapture, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let flag = stop.clone();
        let thread = std::thread::spawn(move || {
            let activated = unsafe {
                match source {
                    Source::Only(pid) => activate_process(pid, true),
                    Source::AllExcept(pid) => activate_process(pid, false),
                    Source::System => activate_system(),
                }
            };
            let client = match activated {
                Ok(c) => c,
                Err(e) => return drop(ready_tx.send(Err(format!("audio capture unavailable: {e}")))),
            };
            let _ = ready_tx.send(Ok(()));
            if let Err(e) = unsafe { run(client, &flag, &mut on_chunk) } {
                eprintln!("stream audio stopped: {e}");
            }
        });
        ready_rx.recv().map_err(|e| e.to_string())??;
        Ok(AudioCapture { stop, thread: Some(thread) })
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Process loopback needs Windows build 20348+ (Windows 11 on desktops).
pub fn process_loopback_supported() -> bool {
    windows_build() >= 20348
}

fn windows_build() -> u32 {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info = OSVERSIONINFOW { dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    unsafe { RtlGetVersion(&mut info) }.ok().map(|_| info.dwBuildNumber).unwrap_or(0)
}

unsafe fn activate_system() -> windows::core::Result<IAudioClient> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
}

unsafe fn activate_process(pid: u32, include: bool) -> windows::core::Result<IAudioClient> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
            },
        },
    };
    let blob = BlobVariant {
        vt: 65, // VT_BLOB
        reserved: [0; 3],
        size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        data: &params as *const _ as *const u8,
    };
    let (tx, rx) = mpsc::channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Activated(tx).into();
    let op = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        Some(&blob as *const BlobVariant as *const PROPVARIANT),
        &handler,
    )?;
    rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| windows::core::Error::from(HRESULT(0x8000_000Au32 as i32)))?;
    let mut hr = HRESULT(0);
    let mut unknown = None;
    op.GetActivateResult(&mut hr, &mut unknown)?;
    hr.ok()?;
    unknown.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?.cast()
}

unsafe fn run(client: IAudioClient, stop: &AtomicBool, on_chunk: &mut dyn FnMut(Vec<u8>)) -> windows::core::Result<()> {
    let (rate, channels) = match client.GetMixFormat() {
        Ok(mix) if !mix.is_null() => {
            let found = ((*mix).nSamplesPerSec, (*mix).nChannels as u32);
            CoTaskMemFree(Some(mix as *const _));
            found
        }
        _ => (0, 0),
    };
    MIX_RATE.store(rate, Ordering::Relaxed);
    MIX_CHANNELS.store(channels, Ordering::Relaxed);
    DISCONTINUITIES.store(0, Ordering::Relaxed);
    let format = WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: CHANNELS as u16,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 8,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        2_000_000, // 200 ms buffer
        0,
        &format,
        None,
    )?;
    let event = CreateEventW(None, false, false, PCWSTR::null())?;
    client.SetEventHandle(event)?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;

    let chunk_bytes = FRAME * CHANNELS * 4;
    let mut pending: Vec<u8> = Vec::with_capacity(chunk_bytes * 4);
    while !stop.load(Ordering::Relaxed) {
        if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
            continue;
        }
        while capture.GetNextPacketSize()? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let bytes = frames as usize * CHANNELS * 4;
            if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                DISCONTINUITIES.fetch_add(1, Ordering::Relaxed);
            }
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                pending.resize(pending.len() + bytes, 0);
            } else {
                pending.extend_from_slice(std::slice::from_raw_parts(data, bytes));
            }
            capture.ReleaseBuffer(frames)?;
        }
        while pending.len() >= chunk_bytes {
            let rest = pending.split_off(chunk_bytes);
            on_chunk(std::mem::replace(&mut pending, rest));
        }
    }
    let _ = client.Stop();
    let _ = CloseHandle(event);
    Ok(())
}
