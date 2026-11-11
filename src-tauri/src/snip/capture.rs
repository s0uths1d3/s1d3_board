//! 截图捕获与融合命令：
//! - `snip_capture_screen`：光标所在显示器整屏 BitBlt → PNG 落盘（imgfile: 引用）。
//!   P0 单屏语义：光标在哪屏截哪屏；先于覆盖窗创建执行（自绘遮罩不入镜）。
//! - `snip_crop_region`：物理像素坐标裁剪，产出新引用 + 岛显示缩略图 + 二维码扫描。
//! - `snip_write_clipboard_dib`：读盘 → 构造 CF_DIB（32bpp BI_RGB bottom-up BGRA，
//!   parse_dib 的逆变换）→ SetClipboardData，避让剪贴板插件轮询锁。
//! - `snip_windows_at_point`：光标处根窗口矩形（窗口吸附高亮），物理像素。
//! - `snip_export_file`：imgfile 引用 → 任意路径导出（保存到文件；jpeg 按质量重编码）。
//! - `snip_capture_region`：指定物理矩形捕获（长截图逐帧）/ `snip_stitch_vertical`
//!   竖向拼接（行签名重叠检测，纯函数暴露给集成测试）。
//!
//! 纯函数（build_dib_bgra_bottomup / find_vertical_overlap / stitch_vertical）
//! 暴露给集成测试 roundtrip。

use serde::Serialize;
use tauri::AppHandle;

// ===================== 载荷结构 =====================

/// 整屏捕获结果：file_ref = 整屏 PNG 落盘引用；x/y/width/height 为物理像素（屏幕全局坐标）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipCapture {
    /// 预览图 PNG data URL（热路径即时返回：长边 ≤2560 的缩小快编）。覆盖窗冻结
    /// 画面直接显示它——遮罩与交互即刻可用；全分辨率引用由后台线程落盘后经
    /// `snip:full-ready` 事件补发（确认裁剪时前端等待）
    pub preview_url: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// 捕获瞬间的光标全局物理坐标：前端据此定位光标所在显示器，取其 scaleFactor
    /// （scope=all 时捕获矩形是虚拟桌面并集，无法再用矩形反查显示器）
    pub cursor_x: i32,
    pub cursor_y: i32,
}

/// 区域裁剪结果：file_ref = 裁剪图引用；thumb = 岛显示缩略图（384px PNG data URL）；
/// qr_text = 二维码识别（NULL=未扫出）；width/height = 裁剪图物理尺寸；
/// data_url = 裁剪图原图 data URL（贴图窗显示用，与捕获同理）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipCrop {
    pub file_ref: String,
    pub thumb: Option<String>,
    pub qr_text: Option<String>,
    pub data_url: String,
    pub width: i32,
    pub height: i32,
}

/// 窗口吸附：光标处根窗口矩形（物理像素，屏幕全局坐标）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnipWindowRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

// ===================== P0-T1 整屏捕获 =====================

/// 预览长边上限（物理像素）：≤2560（2K）的屏预览即原图零损耗；4K 缩小到 2560
/// 保编码 <100ms 且冻结画面视觉足够锐利
const PREVIEW_MAX_SIDE: u32 = 2560;

/// 区域捕获结果（长截图逐帧拍摄用）：data_url = 该区域全分辨率 PNG data URL；
/// file_ref = 内容寻址落盘引用（相同画面 → 相同引用，前端据此跳过未滚动帧）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipRegion {
    pub data_url: String,
    pub file_ref: Option<String>,
    pub width: i32,
    pub height: i32,
}

/// 长截图拼接结果：file_ref = 合成图引用；data_url = 合成图 data URL（预览用）；
/// overlap = 最后一次拼接采用的重叠行数（0 = 未检测到重叠，直接首尾相接）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipStitch {
    pub file_ref: String,
    pub data_url: String,
    pub width: i32,
    pub height: i32,
    pub overlap: i32,
}

/// 捕获范围：all = 虚拟桌面（所有显示器并集，跨屏框选）；cursor = 光标所在显示器
fn capture_rect(scope: Option<&str>) -> Option<windows_rect::Rect> {
    #[cfg(target_os = "windows")]
    {
        match scope.unwrap_or("all") {
            "cursor" => cursor_monitor_rect().map(windows_rect::Rect::from),
            _ => virtual_screen_rect().map(windows_rect::Rect::from),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = scope;
        None
    }
}

/// 跨平台矩形抽象（非 Windows 平台占位，避免 cfg 泄漏到调用方）
mod windows_rect {
    #[derive(Clone, Copy, Debug)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    #[cfg(target_os = "windows")]
    impl From<windows_sys::Win32::Foundation::RECT> for Rect {
        fn from(r: windows_sys::Win32::Foundation::RECT) -> Self {
            Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        }
    }
}

/// 整屏/虚拟桌面截图（即时返回预览；全分辨率后台落盘）。
/// 捕获失败（非 Windows/无显示器/GDI 失败）返回 None，前端弹岛降级。
/// include_cursor：把系统光标绘制进画面（snip_capture_cursor 设置）。
/// scope：all（默认，虚拟桌面并集，支持跨屏框选）/ cursor（光标所在屏）。
///
/// 延迟架构（用户实测「打开特别慢」的修复）：原实现热键路径同步等全分辨率
/// PNG 编码（4K 约 200~500ms）+ 页面读盘跨 IPC + 解码，叠加 0.5~1.5s。现热路径
/// 只做 BitBlt + 缩小 + 快编（预览 ≤~150ms），全分辨率 PNG 编码落盘移入后台线程，
/// 完成后经 `snip:full-ready` 事件补发 fileRef——用户框选的数秒内早已完成，
/// 确认裁剪时才被前端等待（裁剪走全分辨率原图，产物无损）。
#[tauri::command]
pub async fn snip_capture_screen(
    app: AppHandle,
    include_cursor: Option<bool>,
    scope: Option<String>,
) -> Option<SnipCapture> {
    #[cfg(target_os = "windows")]
    {
        use base64::Engine;
        use tauri::Emitter;
        let rect = capture_rect(scope.as_deref())?;
        let (w, h, rgba) = blit_capture(&rect, include_cursor.unwrap_or(false))?;
        // 1) 预览（热路径）+ 编码复用：≤2K 时预览即原图，热路径编码出的 PNG 字节
        //    直接交给后台线程落盘（省一次全图重复编码）；4K 则缩小另编预览
        let (preview_url, encoded_full) = if w.max(h) <= PREVIEW_MAX_SIDE {
            let bytes = crate::clipboard::image_store::encode_rgba_png(w, h, &rgba)?;
            let url = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            );
            (url, Some(bytes))
        } else {
            (build_preview_url(w, h, &rgba)?, None)
        };
        // 2) 全分辨率：后台线程（已编码则仅 sha256+落盘）→ 事件补发引用
        let bg_app = app.clone();
        std::thread::spawn(move || {
            if let Some(file_ref) = save_full_screenshot(&bg_app, w, h, &rgba, encoded_full) {
                let _ = bg_app.emit(
                    "snip:full-ready",
                    serde_json::json!({ "fileRef": file_ref }),
                );
            }
        });
        Some(SnipCapture {
            preview_url,
            x: rect.left,
            y: rect.top,
            width: w as i32,
            height: h as i32,
            cursor_x: cursor_pos().map(|p| p.0).unwrap_or(rect.left),
            cursor_y: cursor_pos().map(|p| p.1).unwrap_or(rect.top),
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, include_cursor, scope);
        None
    }
}

/// 全分辨率落盘（后台线程内执行，不阻塞热路径）。
/// pre_encoded：热路径已编码的 PNG 字节（≤2K 复用，免二次编码）；None 则现编 */
fn save_full_screenshot(
    app: &AppHandle,
    w: u32,
    h: u32,
    rgba: &[u8],
    pre_encoded: Option<Vec<u8>>,
) -> Option<String> {
    let bytes = pre_encoded
        .or_else(|| crate::clipboard::image_store::encode_rgba_png(w, h, rgba))?;
    let dir = crate::clipboard::image_store::images_dir(app)?;
    crate::clipboard::image_store::save_png_bytes_to_dir(&dir, &bytes)
}

/// 预览图 data URL（仅长边 > PREVIEW_MAX_SIDE 的缩小路径；≤2K 走调用方复用分支）
fn build_preview_url(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    use base64::Engine;
    let scale = PREVIEW_MAX_SIDE as f64 / w.max(h) as f64;
    let pw = ((w as f64 * scale).round() as u32).max(1);
    let ph = ((h as f64 * scale).round() as u32).max(1);
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let small = image::imageops::resize(&img, pw, ph, image::imageops::FilterType::Triangle);
    let bytes = crate::clipboard::image_store::encode_rgba_png(pw, ph, small.as_raw())?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 光标全局物理坐标（失败返回 None）
#[cfg(target_os = "windows")]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        Some((pt.x, pt.y))
    }
}

/// 光标所在显示器的 rcMonitor（物理像素）。GetCursorPos + MonitorFromPoint(NEAREST)。
#[cfg(target_os = "windows")]
fn cursor_monitor_rect() -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    unsafe {
        let (x, y) = cursor_pos()?;
        let pt = windows_sys::Win32::Foundation::POINT { x, y };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if hmon.is_null() {
            return None;
        }
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) == 0 {
            return None;
        }
        Some(mi.rcMonitor)
    }
}

/// 虚拟桌面并集矩形（所有显示器覆盖范围；多屏可负坐标/非矩形排列）。
/// SM_XVIRTUALSCREEN 等系统度量即物理像素（进程 Per-Monitor-V2 DPI aware）。
#[cfg(target_os = "windows")]
fn virtual_screen_rect() -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if w <= 0 || h <= 0 {
            return None;
        }
        Some(windows_sys::Win32::Foundation::RECT { left: x, top: y, right: x + w, bottom: y + h })
    }
}

/// GDI BitBlt 整屏捕获 → RGBA（top-down）。include_cursor 时用 GetCursorInfo 取
/// 全局光标句柄，DrawIconEx 画进 memDC（BitBlt 本身不含光标；坐标 = 屏幕物理 - 显示器原点）。
#[cfg(target_os = "windows")]
fn blit_capture(rect: &windows_rect::Rect, include_cursor: bool) -> Option<(u32, u32, Vec<u8>)> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS,
        SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo,
    };
    unsafe {
        let hdc_screen = GetDC(std::ptr::null_mut());
        if hdc_screen.is_null() {
            return None;
        }
        let w = (rect.right - rect.left).max(1);
        let h = (rect.bottom - rect.top).max(1);
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, hbmp as _);
        let mut result: Option<(u32, u32, Vec<u8>)> = None;
        if BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT) != 0 {
            if include_cursor {
                let mut ci: CURSORINFO = std::mem::zeroed();
                ci.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
                if GetCursorInfo(&mut ci) != 0
                    && (ci.flags & CURSOR_SHOWING) != 0
                    && !ci.hCursor.is_null()
                {
                    DrawIconEx(
                        hdc_mem,
                        ci.ptScreenPos.x - rect.left,
                        ci.ptScreenPos.y - rect.top,
                        ci.hCursor,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        DI_NORMAL,
                    );
                }
            }
            // 负高 = top-down 行序，免翻转；32bpp 与 parse_dib 的消费形态对齐
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h;
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let got = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                h as u32,
                buf.as_mut_ptr().cast(),
                &mut bi,
                DIB_RGB_COLORS,
            );
            if got == h {
                for px in buf.chunks_exact_mut(4) {
                    px.swap(0, 2); // BGRA → RGBA
                }
                result = Some((w as u32, h as u32, buf));
            }
        }
        SelectObject(hdc_mem, old);
        DeleteObject(hbmp as _);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);
        result
    }
}

// ===================== P0-T2 区域裁剪 =====================

/// 物理像素坐标裁剪（x/y 相对整屏图左上角）。产出独立 imgfile 引用（sha256 寻址，
/// 同区域重复裁剪天然去重），缩略图与二维码扫描一并完成（复用 thumb 管线）。
#[tauri::command]
pub async fn snip_crop_region(
    app: AppHandle,
    file_ref: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Option<SnipCrop> {
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    if x < 0 || y < 0 || w <= 0 || h <= 0 {
        return None;
    }
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    // 钳制到整屏图内（越界部分裁掉；越界后宽高归零视为无效选区）
    let sx = x.clamp(0, iw);
    let sy = y.clamp(0, ih);
    let sw = (w.min(iw - sx)).max(0);
    let sh = (h.min(ih - sy)).max(0);
    if sw == 0 || sh == 0 {
        return None;
    }
    let cropped = image::imageops::crop_imm(&img, sx as u32, sy as u32, sw as u32, sh as u32).to_image();
    let (cw, ch) = (cropped.width(), cropped.height());
    let rgba = cropped.into_raw();
    let dir = crate::clipboard::image_store::images_dir(&app)?;
    // PNG 编码一次：字节同时落盘（imgfile 引用）与回传（data URL，贴图窗显示用）
    let out_bytes = crate::clipboard::image_store::encode_rgba_png(cw, ch, &rgba)?;
    let out_ref = crate::clipboard::image_store::save_png_bytes_to_dir(&dir, &out_bytes)?;
    let thumb = crate::clipboard::thumb::thumb_png(cw, ch, &rgba, 384);
    let qr_text = crate::clipboard::thumb::scan_qr_rgba(cw, ch, &rgba);
    use base64::Engine;
    let data_url = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&out_bytes)
    );
    Some(SnipCrop {
        file_ref: out_ref,
        thumb,
        qr_text,
        data_url,
        width: cw as i32,
        height: ch as i32,
    })
}

// ===================== P0-T3 写系统剪贴板 =====================

/// 裁剪图写入系统剪贴板（CF_DIB）。调用方（前端）负责先调双抑制
/// （suppressIslandCopy + suppressUseCountBump）——本命令不感知岛与计数。
#[tauri::command]
pub async fn snip_write_clipboard_dib(app: AppHandle, file_ref: String) -> Result<(), String> {
    write_dib_impl(&app, &file_ref).ok_or_else(|| "写入剪贴板失败（可能被其他程序占用）".to_string())
}

#[cfg(target_os = "windows")]
fn write_dib_impl(app: &AppHandle, file_ref: &str) -> Option<()> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    let bytes = crate::clipboard::image_store::read_png_bytes(app, file_ref)?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let dib = build_dib_bgra_bottomup(w, h, &img.into_raw());
    unsafe {
        // 与 with_clipboard_dib（thumb.rs:85-127）同款避让：clipboard 插件 200ms 轮询
        // 可能正持有打开状态，25ms × 8 重试窗口内仍失败才放弃
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            return None;
        }
        let result = (|| {
            if EmptyClipboard() == 0 {
                return None;
            }
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, dib.len());
            if hglobal.is_null() {
                return None;
            }
            let ptr = GlobalLock(hglobal) as *mut u8;
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
            GlobalUnlock(hglobal);
            // SetClipboardData 成功后句柄归系统所有，禁止 GlobalFree
            if SetClipboardData(8u32 /* CF_DIB */, hglobal).is_null() {
                None
            } else {
                Some(())
            }
        })();
        CloseClipboard();
        result
    }
}

/// RGBA(top-down) → CF_DIB 字节（32bpp BI_RGB、正高 bottom-up、BGRA）。
/// 与 clipboard::thumb::parse_dib 互为逆变换（roundtrip 集成测试覆盖）。
#[cfg(target_os = "windows")]
pub fn build_dib_bgra_bottomup(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(40usize + (w * h * 4) as usize);
    out.extend_from_slice(&40u32.to_le_bytes()); // biSize = sizeof(BITMAPINFOHEADER)
    out.extend_from_slice(&(w as i32).to_le_bytes()); // biWidth
    out.extend_from_slice(&(h as i32).to_le_bytes()); // biHeight > 0 = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&((w * h * 4) as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&[0u8; 16]); // biXPelsPerMeter .. biClrImportant
    for row in (0..h).rev() {
        for col in 0..w {
            let i = ((row * w + col) * 4) as usize;
            out.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]]);
        }
    }
    out
}

// ===================== P0-T4 窗口探测 =====================

/// 窗口可视矩形：DWM 扩展边框优先（剔除不可见阴影/resize 边距，UWP/Chrome 贴合
/// 可视区），失败回退 GetWindowRect。物理像素。
#[cfg(target_os = "windows")]
fn window_visible_rect(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    unsafe {
        let mut r: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
        if get_window_rect_fallback(hwnd, &mut r) == 0 {
            return None;
        }
        let mut dwm: windows_sys::Win32::Foundation::RECT = std::mem::zeroed();
        let hr = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut dwm as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<windows_sys::Win32::Foundation::RECT>() as u32,
        );
        if hr == 0 && dwm.right > dwm.left && dwm.bottom > dwm.top {
            r = dwm;
        }
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        if w <= 0 || h <= 0 {
            return None;
        }
        Some(r)
    }
}

/// GetWindowRect 的非宏包装（避免多处 use 冲突的简单封装）。
#[cfg(target_os = "windows")]
unsafe fn get_window_rect_fallback(
    hwnd: windows_sys::Win32::Foundation::HWND,
    r: &mut windows_sys::Win32::Foundation::RECT,
) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    GetWindowRect(hwnd, r)
}

/// 光标/给定点处的根窗口矩形（物理像素，屏幕全局坐标）。用于覆盖窗「窗口吸附」高亮。
///
/// 截图覆盖窗自身（label `snip-overlay`）由 AppHandle 解析后排除——WindowFromPoint
/// 命中的最顶层窗口就是覆盖窗自己（透明但可命中、置顶），直接返回会永远得到整屏
/// 矩形。命中自身时沿 Z 序向下找第一个包含该点的可见顶层窗口（Snipaste 同款做法），
/// 并跳过 UWP 幽灵窗口（DWMWA_CLOAKED）。
#[tauri::command]
pub fn snip_windows_at_point(app: tauri::AppHandle, x: i32, y: i32) -> Option<SnipWindowRect> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetWindow, IsWindowVisible, WindowFromPoint, GA_ROOT, GW_HWNDNEXT,
        };
        unsafe {
            // 排除窗口：覆盖窗自身（AppHandle 解析 → HWND）。tauri 的 HWND 为
            // windows crate 指针新类型，`.0` 取裸指针后与 windows-sys 的 HWND 同形
            let exclude_hwnd: Option<windows_sys::Win32::Foundation::HWND> = app
                .get_webview_window("snip-overlay")
                .and_then(|w| w.hwnd().ok())
                .map(|h| h.0 as windows_sys::Win32::Foundation::HWND);
            let pt = POINT { x, y };
            let hit = WindowFromPoint(pt);
            if hit.is_null() {
                return None;
            }
            let mut root = GetAncestor(hit, GA_ROOT);
            if root.is_null() {
                return None;
            }
            // 命中自身（或指定的排除窗口）：走 Z 序向下找可见且含点的窗口
            if Some(root) == exclude_hwnd {
                let mut candidate: Option<windows_sys::Win32::Foundation::HWND> = None;
                let mut h = GetWindow(root, GW_HWNDNEXT);
                while !h.is_null() {
                    if IsWindowVisible(h) != 0 {
                        // 跳过 UWP 幽灵窗口（ApplicationFrameWindow 的挂起壳）
                        let mut cloaked: u32 = 0;
                        let hr = DwmGetWindowAttribute(
                            h,
                            DWMWA_CLOAKED as u32,
                            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                            4,
                        );
                        let is_cloaked = hr == 0 && cloaked != 0;
                        if !is_cloaked {
                            if let Some(r) = window_visible_rect(h) {
                                if pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom {
                                    candidate = Some(h);
                                    break;
                                }
                            }
                        }
                    }
                    h = GetWindow(h, GW_HWNDNEXT);
                }
                root = candidate?;
            }
            if IsWindowVisible(root) == 0 {
                return None;
            }
            let r = window_visible_rect(root)?;
            Some(SnipWindowRect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y);
        None
    }
}

// ===================== P0-T5 导出文件 =====================

/// 把 imgfile 引用指向的截图导出到用户选定的绝对路径（前端 dialog 插件产出）。
/// format: "png"（默认，字节直拷）或 "jpeg"（按 quality 重编码，60~100）。
#[tauri::command]
pub async fn snip_export_file(
    app: AppHandle,
    file_ref: String,
    dest_path: String,
    format: Option<String>,
    quality: Option<u32>,
) -> Result<(), String> {
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)
        .ok_or_else(|| "读取截图失败".to_string())?;
    match format.as_deref() {
        Some("jpeg") => {
            let img = image::load_from_memory(&bytes)
                .map_err(|e| format!("解码截图失败: {e}"))?
                .to_rgb8();
            let q = quality.unwrap_or(90).clamp(60, 100) as u8;
            let mut out = std::io::Cursor::new(Vec::new());
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, q);
            use image::ImageEncoder;
            encoder
                .write_image(
                    img.as_raw(),
                    img.width(),
                    img.height(),
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| format!("JPEG 编码失败: {e}"))?;
            std::fs::write(&dest_path, out.into_inner())
                .map_err(|e| format!("保存文件失败: {e}"))
        }
        // PNG（默认）：内容寻址产物即 PNG 字节，直拷零重编码
        _ => std::fs::write(&dest_path, &bytes).map_err(|e| format!("保存文件失败: {e}")),
    }
}

// ===================== P1-T6 捕获鼠标光标（保留位） =====================
// include_cursor 设置项 P0 已存 KV；绘制实现（GetIconInfo + DrawIconEx 到 memDC，
// 坐标 = pt - rect.left/top）在 P1 落地，见 spec P1-T6。

// ===================== P1-T7 长截图（逐帧捕获 + 竖向拼接） =====================

/// 指定物理矩形捕获（长截图逐帧；区域通常为屏幕一部分，编码耗时可接受）。
/// 返回全分辨率 PNG data URL——逐帧回传页面做进度预览，最终拼接走引用落盘。
#[tauri::command]
pub async fn snip_capture_region(
    app: AppHandle,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    include_cursor: Option<bool>,
) -> Option<SnipRegion> {
    #[cfg(target_os = "windows")]
    {
        use base64::Engine;
        if w <= 0 || h <= 0 {
            return None;
        }
        let rect = windows_rect::Rect { left: x, top: y, right: x + w, bottom: y + h };
        let (rw, rh, rgba) = blit_capture(&rect, include_cursor.unwrap_or(false))?;
        let bytes = crate::clipboard::image_store::encode_rgba_png(rw, rh, &rgba)?;
        // 内容寻址落盘：同画面复用同一引用（长截图循环据此判定「未滚动」）
        let file_ref = crate::clipboard::image_store::images_dir(&app)
            .and_then(|dir| crate::clipboard::image_store::save_png_bytes_to_dir(&dir, &bytes));
        Some(SnipRegion {
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ),
            file_ref,
            width: rw as i32,
            height: rh as i32,
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, x, y, w, h, include_cursor);
        None
    }
}

/// 重叠检测采样列数 / 最小重叠行数 / 可接受的平均灰度差
const OVERLAP_COLS: u32 = 64;
const OVERLAP_MIN_ROWS: u32 = 8;
const OVERLAP_MAX_DIFF: f32 = 10.0;
/// 右侧排除宽度：滚动条滑块在两帧间必然移动，参与比对会污染重叠检测
const OVERLAP_RIGHT_GUARD: u32 = 24;

/// 单行灰度签名（采样列，排除右侧滚动条区域）
fn row_signature(buf: &[u8], w: u32, y: u32) -> Vec<u8> {
    let usable = w.saturating_sub(OVERLAP_RIGHT_GUARD).max(1);
    let cols = OVERLAP_COLS.min(usable).max(1);
    (0..cols)
        .map(|i| {
            let x = if cols <= 1 {
                0
            } else {
                (i as u64 * (usable as u64 - 1) / (cols as u64 - 1)) as u32
            };
            let p = ((y as u64 * w as u64 + x as u64) * 4) as usize;
            if p + 2 >= buf.len() {
                return 0;
            }
            ((buf[p] as u32 * 30 + buf[p + 1] as u32 * 59 + buf[p + 2] as u32 * 11) / 100) as u8
        })
        .collect()
}

/// 竖向重叠检测：返回 bottom 顶部与 top 底部的重叠行数。
///
/// 思路（滚动截图逐帧对齐）：候选重叠量 ov 从大到小（大重叠优先——页面滚动幅度
/// 通常小于一屏），比较 top 的末 ov 行与 bottom 的前 ov 行；每行取 64 列灰度签名，
/// 抽 24 行计算平均绝对差。分数 <2 提前接受（无损截图通常为 0），最优分数超过
/// 阈值视为无重叠返回 None。
///
/// 两处刻意拒绝：完全重叠（两帧一致）视为「页面未滚动」（否则会拼出重复内容）。
pub fn find_vertical_overlap(
    top: &[u8],
    tw: u32,
    th: u32,
    bottom: &[u8],
    bw: u32,
    bh: u32,
) -> Option<u32> {
    if tw == 0 || bw == 0 || th == 0 || bh == 0 {
        return None;
    }
    if top.len() < (tw as usize * th as usize * 4) || bottom.len() < (bw as usize * bh as usize * 4)
    {
        return None;
    }
    let max_ov = th.min(bh);
    if max_ov < OVERLAP_MIN_ROWS {
        return None;
    }
    // 预计算各自用于比对的末段/前段行签名
    let top_rows: Vec<Vec<u8>> = (0..max_ov)
        .map(|i| row_signature(top, tw, th - max_ov + i))
        .collect();
    let bottom_rows: Vec<Vec<u8>> = (0..max_ov).map(|i| row_signature(bottom, bw, i)).collect();

    let mut best: Option<(u32, f32)> = None;
    for ov in (OVERLAP_MIN_ROWS..=max_ov).rev() {
        let samples = 24u32.min(ov).max(1);
        let mut sum = 0u64;
        let mut cnt = 0u64;
        for s in 0..samples {
            let k = if samples <= 1 { 0 } else { s * (ov - 1) / (samples - 1) };
            // top 末 ov 行里第 k 行 = 预计算数组下标 (max_ov - ov + k)
            let ts = &top_rows[(max_ov - ov + k) as usize];
            let bs = &bottom_rows[k as usize];
            for i in 0..ts.len().min(bs.len()) {
                sum += (ts[i] as i32 - bs[i] as i32).unsigned_abs() as u64;
                cnt += 1;
            }
        }
        let score = sum as f32 / cnt.max(1) as f32;
        if best.map_or(true, |(_, bs)| score < bs) {
            best = Some((ov, score));
        }
        if score < 2.0 {
            break;
        }
    }
    let (ov, score) = best?;
    if score > OVERLAP_MAX_DIFF {
        return None;
    }
    // 完全重叠 = 两帧一致（页面未滚动）：拒绝，交由调用方提示
    if ov >= th.min(bh) {
        return None;
    }
    Some(ov)
}

/// 竖向拼接：top 全量 + bottom 去掉与 top 重叠的 ov 行。宽度必须一致。
pub fn stitch_vertical(
    top: &[u8],
    tw: u32,
    th: u32,
    bottom: &[u8],
    bw: u32,
    bh: u32,
    overlap: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    if tw == 0 || th == 0 || bh == 0 || tw != bw {
        return None;
    }
    let need_top = tw as usize * th as usize * 4;
    let need_bottom = bw as usize * bh as usize * 4;
    if top.len() < need_top || bottom.len() < need_bottom {
        return None;
    }
    let ov = overlap.min(bh).min(th);
    let nh = th + bh - ov;
    let mut out = Vec::with_capacity(tw as usize * nh as usize * 4);
    out.extend_from_slice(&top[..need_top]);
    let start = ov as usize * tw as usize * 4;
    out.extend_from_slice(&bottom[start..need_bottom]);
    Some((tw, nh, out))
}

/// 多帧竖向拼接（纯函数，单元测试覆盖）：
/// 按顺序检测相邻重叠并累积；无重叠帧（未滚动 / 滚动过头）跳过而不是整帧追加，
/// 否则会拼出重复或断裂内容。宽度不一致直接报错。
pub fn stitch_frames(frames: &[(u32, u32, Vec<u8>)]) -> Result<(u32, u32, Vec<u8>, i32), String> {
    if frames.is_empty() {
        return Err("没有可拼接的截图".to_string());
    }
    let mut acc: Option<(u32, u32, Vec<u8>)> = None;
    let mut last_overlap = 0i32;
    for (w, h, raw) in frames {
        let Some((aw, ah, araw)) = acc.take() else {
            acc = Some((*w, *h, raw.clone()));
            continue;
        };
        if *w != aw {
            return Err("各帧宽度不一致，无法拼接".to_string());
        }
        let Some(ov) = find_vertical_overlap(&araw, aw, ah, raw, *w, *h) else {
            // 跳过该帧但保留已拼内容（不能丢 acc）
            acc = Some((aw, ah, araw));
            continue;
        };
        let (nw, nh, nraw) =
            stitch_vertical(&araw, aw, ah, raw, *w, *h, ov).ok_or("拼接失败")?;
        last_overlap = ov as i32;
        acc = Some((nw, nh, nraw));
    }
    let (w, h, raw) = acc.ok_or("没有可拼接的截图".to_string())?;
    Ok((w, h, raw, last_overlap))
}

/// 长截图拼接命令：按顺序读取多帧，逐帧检测重叠并累积拼接，产出新 imgfile 引用。
/// 任一帧宽度不一致 / 解码失败返回 Err（前端弹岛提示重拍）。
#[tauri::command]
pub async fn snip_stitch_vertical(app: AppHandle, file_refs: Vec<String>) -> Result<SnipStitch, String> {
    if file_refs.len() < 2 {
        return Err("至少需要两帧才能拼接".to_string());
    }
    let dir = crate::clipboard::image_store::images_dir(&app).ok_or("无法定位图片目录")?;
    let mut frames: Vec<(u32, u32, Vec<u8>)> = Vec::with_capacity(file_refs.len());
    for (i, r) in file_refs.iter().enumerate() {
        let bytes = crate::clipboard::image_store::read_png_bytes(&app, r)
            .ok_or_else(|| format!("读取第 {} 帧失败", i + 1))?;
        let img = image::load_from_memory(&bytes)
            .map_err(|e| format!("解码第 {} 帧失败: {e}", i + 1))?
            .to_rgba8();
        frames.push((img.width(), img.height(), img.into_raw()));
    }
    let (w, h, raw, last_overlap) = stitch_frames(&frames)?;
    let out_bytes = crate::clipboard::image_store::encode_rgba_png(w, h, &raw).ok_or("编码失败")?;
    let file_ref =
        crate::clipboard::image_store::save_png_bytes_to_dir(&dir, &out_bytes).ok_or("落盘失败")?;
    use base64::Engine;
    Ok(SnipStitch {
        file_ref,
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&out_bytes)
        ),
        width: w as i32,
        height: h as i32,
        overlap: last_overlap,
    })
}

/// 上传截图到自建/图床地址（设置页 snip_upload_url）。
///
/// 协议约定（够用且不绑定具体服务）：把 PNG 原字节作为请求体 POST 到该地址
/// （Content-Type: image/png），响应若是 JSON 则依次取 url / data.url / data.link /
/// link；否则把响应正文当结果（如纯文本 URL）。返回结果由前端复制到剪贴板。
/// 安全：只允许 https（本机回环允许 http），避免明文外传截图。
#[tauri::command]
pub async fn snip_upload_image(
    store: tauri::State<'_, crate::core::traits::ImageStoreHandle>,
    file_ref: String,
    url: String,
) -> Result<String, String> {
    let target = url.trim().to_string();
    let allowed = target.starts_with("https://")
        || target.starts_with("http://127.0.0.1")
        || target.starts_with("http://localhost");
    if !allowed {
        return Err("上传地址必须是 https://（本机可用 http://localhost）".to_string());
    }
    let data_url = store.0.read(&file_ref).ok_or_else(|| "读取截图失败".to_string())?;
    let bytes = crate::clipboard::image_store::decode_data_url(&data_url)
        .ok_or_else(|| "解码截图失败".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let resp = client
        .post(&target)
        .header(reqwest::header::CONTENT_TYPE, "image/png")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("上传请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        let preview: String = text.chars().take(200).collect();
        return Err(format!("上传失败（HTTP {}）：{}", status.as_u16(), preview));
    }
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        for path in [&["url"][..], &["data", "url"][..], &["data", "link"][..], &["link"][..]] {
            let mut cur = &json;
            for key in path {
                cur = &cur[*key];
            }
            if let Some(s) = cur.as_str() {
                if s.starts_with("http") {
                    return Ok(s.trim().to_string());
                }
            }
        }
    }
    let plain = text.trim();
    if plain.is_empty() {
        return Err("上传成功但响应为空".to_string());
    }
    Ok(plain.chars().take(2000).collect())
}
