//! Stream audio through Windows process loopback (Windows 10 2004+), like Discord:
//! - sharing a window: only that application's sound (its process tree);
//! - sharing a screen: everything except Pottira itself, so viewers never hear the voice chat echoed back.
//! Delivers 20 ms chunks of 48 kHz stereo f32, ready for the Opus encoder.
//!
//! REC uses the same captures for a game's sound (`start_quiet`, which leaves the stream readout's counters alone)
//! and a microphone (`start_mic`).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

use windows::core::{implement, Interface, HRESULT, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantToStringAlloc, PROPVARIANT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IAgileObject, IAgileObject_Impl, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
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
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Source {
    /// Only this process tree (sharing an app).
    Only(u32),
    /// Everything except this process tree (sharing a screen).
    AllExcept(u32),
    /// Plain loopback of the default output device. Windows 10 has nothing finer.
    System,
}

/// How a capture runs.
#[derive(Clone, Copy)]
struct Mode {
    /// Loopback (what's played) rather than an input device.
    loopback: bool,
    /// Feeds the stream readout's counters (MIX_RATE, ...). Only the stream's capture does.
    diagnostics: bool,
}

impl AudioCapture {
    /// The stream's audio.
    pub fn start(source: Source, on_chunk: impl FnMut(Vec<u8>) + Send + 'static) -> Result<AudioCapture, String> {
        Self::spawn(move || unsafe { activate(source) }, Mode { loopback: true, diagnostics: true }, on_chunk)
    }

    /// Like `start`, without touching the stream readout's counters (REC's game sound).
    pub fn start_quiet(source: Source, on_chunk: impl FnMut(Vec<u8>) + Send + 'static) -> Result<AudioCapture, String> {
        Self::spawn(move || unsafe { activate(source) }, Mode { loopback: true, diagnostics: false }, on_chunk)
    }

    /// A microphone: the one whose name is `name` (as the app lists devices), else Windows' communications mic.
    /// Mono mics come out as stereo, like everything else here.
    pub fn start_mic(name: Option<String>, on_chunk: impl FnMut(Vec<u8>) + Send + 'static) -> Result<AudioCapture, String> {
        Self::spawn(move || unsafe { activate_mic(name.as_deref()) }, Mode { loopback: false, diagnostics: false }, on_chunk)
    }

    /// What one output device plays (REC's "sound from" device), by name; else the default output, like `System`.
    pub fn start_output(name: String, on_chunk: impl FnMut(Vec<u8>) + Send + 'static) -> Result<AudioCapture, String> {
        Self::spawn(move || unsafe { activate_output(&name) }, Mode { loopback: true, diagnostics: false }, on_chunk)
    }

    fn spawn(
        activate: impl FnOnce() -> windows::core::Result<IAudioClient> + Send + 'static,
        mode: Mode,
        mut on_chunk: impl FnMut(Vec<u8>) + Send + 'static,
    ) -> Result<AudioCapture, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let flag = stop.clone();
        let thread = std::thread::spawn(move || {
            let client = match activate() {
                Ok(c) => c,
                Err(e) => return drop(ready_tx.send(Err(format!("audio capture unavailable: {e}")))),
            };
            let _ = ready_tx.send(Ok(()));
            if let Err(e) = unsafe { run(client, &flag, &mut on_chunk, mode) } {
                eprintln!("audio capture stopped: {e}");
            }
        });
        ready_rx.recv().map_err(|e| e.to_string())??;
        Ok(AudioCapture { stop, thread: Some(thread) })
    }
}

unsafe fn activate(source: Source) -> windows::core::Result<IAudioClient> {
    match source {
        Source::Only(pid) => activate_process(pid, true),
        Source::AllExcept(pid) => activate_process(pid, false),
        Source::System => activate_system(),
    }
}

unsafe fn activate_mic(name: Option<&str>) -> windows::core::Result<IAudioClient> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        let list = devices.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)?;
        for i in 0..list.GetCount()? {
            let device = list.Item(i)?;
            if friendly_name(&device).is_some_and(|n| same_device(&n, name)) {
                return device.Activate(CLSCTX_ALL, None);
            }
        }
    }
    devices.GetDefaultAudioEndpoint(eCapture, eCommunications)?.Activate(CLSCTX_ALL, None)
}

unsafe fn activate_output(name: &str) -> windows::core::Result<IAudioClient> {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let list = devices.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
    for i in 0..list.GetCount()? {
        let device = list.Item(i)?;
        if friendly_name(&device).is_some_and(|n| same_device(&n, name)) {
            return device.Activate(CLSCTX_ALL, None);
        }
    }
    activate_system()
}

/// Windows' name and the app's label for the same mic: Chromium adds the USB ids (" (2b89:5854)") to some labels.
fn same_device(windows_name: &str, app_label: &str) -> bool {
    let label = app_label.trim();
    label == windows_name || label.strip_prefix(windows_name).is_some_and(|rest| rest.trim_start().starts_with('(') && rest.trim_end().ends_with(')'))
}

unsafe fn friendly_name(device: &IMMDevice) -> Option<String> {
    let value = device.OpenPropertyStore(STGM_READ).ok()?.GetValue(&PKEY_Device_FriendlyName).ok()?;
    let text = PropVariantToStringAlloc(&value).ok()?;
    let name = text.to_string().ok();
    CoTaskMemFree(Some(text.0 as *const _));
    name
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

unsafe fn run(client: IAudioClient, stop: &AtomicBool, on_chunk: &mut dyn FnMut(Vec<u8>), mode: Mode) -> windows::core::Result<()> {
    if mode.diagnostics {
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
    }
    let loopback = if mode.loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
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
        loopback | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
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
            if mode.diagnostics && flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
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

#[cfg(test)]
mod tests {
    #[test]
    fn app_labels_with_usb_ids_match_windows_names() {
        let windows = "Digital Audio Interface (UGREEN 25854)";
        assert!(super::same_device(windows, "Digital Audio Interface (UGREEN 25854) (2b89:5854)"));
        assert!(super::same_device(windows, windows));
        assert!(!super::same_device("Microphone", "Microphone Array"));
        assert!(!super::same_device("Mic (A)", "Mic (B)"));
    }
}
