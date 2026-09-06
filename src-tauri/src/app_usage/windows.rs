//! Windows 平台实现：SetWinEventHook 前台切换监听 + 消息循环，
//! 图标经 SHGetFileInfo → HICON → GetDIBits 提取（含 AND 掩码透明度还原）。

#[cfg(target_os = "windows")]
use super::{state, AppUsageState, Sample};
use base64::Engine;
use std::io::Cursor;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{CloseHandle, HWND};
use windows_sys::Win32::Graphics::Gdi::{
CreateCompatibleDC, GetDC, GetDIBits, GetObjectW, ReleaseDC, DeleteDC, DeleteObject,
BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
DestroyIcon, DispatchMessageW, GetIconInfo, GetMessageW, GetForegroundWindow,
GetWindowThreadProcessId, TranslateMessage, EVENT_SYSTEM_FOREGROUND, HICON, ICONINFO,
MSG, WINEVENT_OUTOFCONTEXT,
};
/// 常驻状态引用（WinEventProc 回调无上下文参数，经全局取用；仿 set_menu_theme 的 OnceLock 先例）
static STATE_REF: OnceLock<&'static AppUsageState> = OnceLock::new();
fn state_ref() -> &'static AppUsageState {
*STATE_REF.get_or_init(state)
}
pub fn start() {
std::thread::spawn(|| unsafe {
    // 前台切换钩子：WINEVENT_OUTOFCONTEXT 要求调用线程有消息循环
    let hook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        std::ptr::null_mut(),
        Some(winevent_proc),
        0,
        0,
        WINEVENT_OUTOFCONTEXT,
    );
    if hook.is_null() {
        log::error!("[app_usage] SetWinEventHook 注册失败，前台监听不可用");
        return;
    }
    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
});
}
unsafe extern "system" fn winevent_proc(
_hook: HWINEVENTHOOK,
event: u32,
hwnd: HWND,
id_object: i32,
_id_child: i32,
_thread: u32,
_time: u32,
) {
// OBJID_WINDOW = 0：仅响应顶层窗口的前台切换
if event != EVENT_SYSTEM_FOREGROUND || id_object != 0 || hwnd.is_null() {
    return;
}
if let Some(sample) = sample_of_hwnd(hwnd) {
    state_ref().on_switch(sample);
}
}
/// hwnd → 采样（进程名 + 图标）。无法获取进程名归入 "system" 桶，不丢时长。
fn sample_of_hwnd(hwnd: HWND) -> Option<Sample> {
unsafe {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 {
        return Some(Sample { name: "system".to_string(), icon: None });
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
        return Some(Sample { name: "system".to_string(), icon: None });
    }
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
    CloseHandle(handle);
    if ok == 0 || len == 0 {
        return Some(Sample { name: "system".to_string(), icon: None });
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
    let name = name.strip_suffix(".exe").unwrap_or(name).to_lowercase();
    let name = if name.is_empty() { "system".to_string() } else { name };
    // 图标：仅在该应用尚无缓存记录（含失败标记）时提取（回调线程阻塞几毫秒，单应用一次）
    let icon = if state_ref().icon_recorded(&name) {
        None
    } else {
        icon_data_url_of_path(&path)
    };
    Some(Sample { name, icon })
}
}
/// exe 路径 → 图标 PNG data URL（SHGetFileInfo 取大图标 → GetDIBits 转 RGBA → PNG）
fn icon_data_url_of_path(path: &str) -> Option<String> {
unsafe {
    let mut path16: Vec<u16> = path.encode_utf16().collect();
    path16.push(0);
    let mut sfi: SHFILEINFOW = std::mem::zeroed();
    let ok = SHGetFileInfoW(
        path16.as_ptr(),
        0,
        &mut sfi,
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if ok == 0 || sfi.hIcon.is_null() {
        return None;
    }
    let png = hicon_to_png(sfi.hIcon);
    DestroyIcon(sfi.hIcon);
    png.map(|bytes| {
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    })
}
}
/// HICON → 32 位 BGRA 位图 → RGBA PNG
fn hicon_to_png(hicon: HICON) -> Option<Vec<u8>> {
unsafe {
    let mut info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut info) == 0 {
        return None;
    }
    let result = (|| {
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(
            info.hbmColor as _,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bm as *mut _ as *mut _,
        ) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 {
            return None;
        }
        let hdc = GetDC(std::ptr::null_mut());
        let mem = CreateCompatibleDC(hdc);
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // 负值 = 自上而下
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem,
            info.hbmColor,
            0,
            h as u32,
            buf.as_mut_ptr() as _,
            &mut bi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
        DeleteDC(mem);
        if lines == 0 {
            return None;
        }
        // BGRA → RGBA
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        // 带 alpha 通道的现代图标：保持原透明度。
        // 若把 alpha=0 的透明像素（RGB 通常存纯黑）置为不透明，会出现黑边。
        let has_alpha = buf.chunks_exact(4).any(|px| px[3] != 0);
        if !has_alpha {
            // 旧格式图标：透明度来自 AND 掩码（hbmMask 高度 = 2h，下半为 AND 掩码，
            // 掩码位 = 1 表示透明）。读取掩码还原透明度。
            let stride = (((w as usize) + 31) / 32) * 4;
            let mut mask = vec![0u8; stride * (h as usize) * 2];
            let mut mi: BITMAPINFO = std::mem::zeroed();
            mi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -(h * 2),
                biPlanes: 1,
                biBitCount: 1,
                biCompression: 0, // BI_RGB
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let mask_dc = GetDC(std::ptr::null_mut());
            let got = GetDIBits(
                mask_dc,
                info.hbmMask,
                0,
                (h * 2) as u32,
                mask.as_mut_ptr() as _,
                &mut mi,
                DIB_RGB_COLORS,
            );
            ReleaseDC(std::ptr::null_mut(), mask_dc);
            let mut applied = false;
            if got == h * 2 {
                let and = &mask[stride * (h as usize)..];
                for y in 0..h as usize {
                    for x in 0..w as usize {
                        let bit = (and[y * stride + x / 8] >> (7 - (x % 8))) & 1;
                        if bit == 1 {
                            buf[(y * w as usize + x) * 4 + 3] = 0; // 掩码置位 = 透明
                            applied = true;
                        }
                    }
                }
            }
            // 无掩码信息可用的极端情况：整图按不透明兜底
            if !applied {
                for px in buf.chunks_exact_mut(4) {
                    px[3] = 255;
                }
            }
        }
        let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)?;
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).ok()?;
        Some(out.into_inner())
    })();
    if !info.hbmColor.is_null() {
        DeleteObject(info.hbmColor);
    }
    if !info.hbmMask.is_null() {
        DeleteObject(info.hbmMask);
    }
    result
}
}
pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
unsafe {
    let hwnd = GetForegroundWindow();
    if hwnd.is_null() {
        return None;
    }
    sample_of_hwnd(hwnd)
}
}
pub fn idle_secs() -> u64 {
unsafe {
    let mut li = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if GetLastInputInfo(&mut li) == 0 {
        return 0;
    }
    // dwTime 为系统启动毫秒计数，回绕安全（wrapping）
    (GetTickCount().wrapping_sub(li.dwTime)) as u64 / 1000
}
}

