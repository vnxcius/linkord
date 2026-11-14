//! A stand-in "game" for measuring what REC costs games (Windows): a borderless fullscreen window on the primary
//! monitor, a flip-model swap chain presenting without vsync (tearing allowed, so Windows can give it the direct
//! "independent flip" path like a real game), and GPU work every frame. Prints frames per second, then the average.
//!
//!   cargo run --release --example rec_standin -- <seconds=20> <work=40>
//!
//! `work` = full-screen clears of a 4K target per frame; raise it until the fps is in a game's range (~150-250).
//! Run it alone, then again with `cargo run --release --example rec_probe` going, and compare the averages.

#[cfg(windows)]
fn main() {
    imp::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}

#[cfg(windows)]
mod imp {
    use std::time::{Duration, Instant};

    use windows::core::{w, Interface, BOOL};
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;
    use windows::Win32::Graphics::Dxgi::*;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if msg == WM_DESTROY || (msg == WM_KEYDOWN && w.0 == 0x1b) {
            PostQuitMessage(0);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, w, l)
    }

    pub fn main() {
        // Physical pixels, so the window really covers the monitor.
        unsafe {
            use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let args: Vec<String> = std::env::args().collect();
        let seconds: u64 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(20);
        let work: u32 = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(40);
        unsafe { run(seconds, work) }.expect("stand-in failed");
    }

    unsafe fn run(seconds: u64, work: u32) -> windows::core::Result<()> {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(monitor, &mut info);
        let r = info.rcMonitor;
        let (width, height) = ((r.right - r.left) as u32, (r.bottom - r.top) as u32);

        let instance = GetModuleHandleW(None)?;
        let class = w!("PottiraRecStandIn");
        RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() });
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("REC stand-in"),
            WS_POPUP | WS_VISIBLE,
            r.left,
            r.top,
            width as i32,
            height as i32,
            None,
            None,
            Some(instance.into()),
            None,
        )?;

        // In front and on top, like a game being played (REC only records a covered window while it's in front).
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
        let _ = SetForegroundWindow(hwnd);
        let (mut device, mut context) = (None, None);
        D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))?;
        let (device, context): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), context.unwrap());
        let factory: IDXGIFactory2 = CreateDXGIFactory1()?;
        let mut tearing = BOOL(0);
        let tearing_ok = factory
            .cast::<IDXGIFactory5>()
            .and_then(|f| f.CheckFeatureSupport(DXGI_FEATURE_PRESENT_ALLOW_TEARING, &mut tearing as *mut BOOL as *mut _, 4))
            .is_ok()
            && tearing.as_bool();
        let flags = if tearing_ok { DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING.0 as u32 } else { 0 };
        let desc = DXGI_SWAP_CHAIN_DESC1 {
            Width: width,
            Height: height,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 2,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            Flags: flags,
            ..Default::default()
        };
        let swap = factory.CreateSwapChainForHwnd(&device, hwnd, &desc, None, None)?;
        let back: ID3D11Texture2D = swap.GetBuffer(0)?;
        let mut back_view = None;
        device.CreateRenderTargetView(&back, None, Some(&mut back_view))?;
        let back_view = back_view.unwrap();

        // The "game's" work: a 4K target cleared over and over (memory bandwidth, like rendering passes).
        let work_desc = D3D11_TEXTURE2D_DESC {
            Width: 3840,
            Height: 2160,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R16G16B16A16_FLOAT,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            ..Default::default()
        };
        let mut target = None;
        device.CreateTexture2D(&work_desc, None, Some(&mut target))?;
        let mut target_view = None;
        device.CreateRenderTargetView(&target.unwrap(), None, Some(&mut target_view))?;
        let target_view = target_view.unwrap();

        println!("stand-in: {width}x{height}, tearing {}, work {work}, {seconds} s", if tearing_ok { "on" } else { "off" });
        let started = Instant::now();
        let mut second = Instant::now();
        let (mut frames, mut total) = (0u32, 0u64);
        let mut per_second = Vec::new();
        let mut n = 0u32;
        'frames: while started.elapsed() < Duration::from_secs(seconds) {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    break 'frames;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            for i in 0..work {
                context.ClearRenderTargetView(&target_view, &[i as f32 / work as f32, 0.2, 0.3, 1.0]);
            }
            n = n.wrapping_add(1);
            let shade = (n % 120) as f32 / 120.0;
            // A changing picture every frame, like a game (Duplication only hands out changed frames).
            context.ClearRenderTargetView(&back_view, &[shade, 0.1, 1.0 - shade, 1.0]);
            let present_flags = if tearing_ok { DXGI_PRESENT_ALLOW_TEARING } else { DXGI_PRESENT(0) };
            let _ = swap.Present(0, present_flags);
            frames += 1;
            total += 1;
            if second.elapsed() >= Duration::from_secs(1) {
                let fps = frames as f64 / second.elapsed().as_secs_f64();
                println!("{fps:.0} fps");
                per_second.push(fps);
                frames = 0;
                second = Instant::now();
            }
        }
        // The first two seconds are the window settling in.
        let steady: Vec<f64> = per_second.iter().skip(2).copied().collect();
        let avg = steady.iter().sum::<f64>() / steady.len().max(1) as f64;
        println!("average {avg:.1} fps over {} s ({total} frames)", steady.len());
        DestroyWindow(hwnd)?;
        Ok(())
    }
}
