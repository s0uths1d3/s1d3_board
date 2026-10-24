//! 截图捕获与融合命令：
//! - `snip_capture_screen`：光标所在显示器整屏 BitBlt → PNG 落盘（imgfile: 引用）。
//!   P0 单屏语义：光标在哪屏截哪屏；先于覆盖窗创建执行（自绘遮罩不入镜）。
//! - `snip_crop_region`：物理像素坐标裁剪，产出新引用 + 岛显示缩略图 + 二维码扫描。
//! - `snip_write_clipboard_dib`：读盘 → 构造 CF_DIB（32bpp BI_RGB bottom-up BGRA，
//!   parse_dib 的逆变换）→ SetClipboardData，避让剪贴板插件轮询锁。
//! - `snip_windows_at_point`：光标处根窗口矩形（窗口吸附高亮），物理像素。
//! - `snip_export_file`：imgfile 引用 → 任意路径导出（保存到文件；jpeg 按质量重编码）。
//!
//! 纯函数（build_dib_bgra_bottomup / rgba_to_jpeg_bytes）暴露给集成测试 roundtrip。

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

/// 光标所在显示器整屏截图（即时返回预览；全分辨率后台落盘）。
/// 捕获失败（非 Windows/无显示器/GDI 失败/超 20MB 上限）返回 None，前端弹岛降级。
/// include_cursor：把系统光标绘制进画面（snip_capture_cursor 设置）。
///
/// 延迟架构（用户实测「打开特别慢」的修复）：原实现热键路径同步等全分辨率
/// PNG 编码（4K 约 200~500ms）+ 页面读盘跨 IPC + 解码，叠加 0.5~1.5s。现热路径
/// 只做 BitBlt + 缩小 + 快编（预览 ≤~150ms），全分辨率 PNG 编码落盘移入后台线程，
/// 完成后经 `snip:full-ready` 事件补发 fileRef——用户框选的数秒内早已完成，
/// 确认裁剪时才被前端等待（裁剪走全分辨率原图，产物无损）。
#[tauri::command]
pub async fn snip_capture_screen(app: AppHandle, include_cursor: Option<bool>) -> Option<SnipCapture> {
    #[cfg(target_os = "windows")]
    {
        use base64::Engine;
        use tauri::Emitter;
        let rect = cursor_monitor_rect()?;
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
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, include_cursor);
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

/// 光标所在显示器的 rcMonitor（物理像素）。GetCursorPos + MonitorFromPoint(NEAREST)。
#[cfg(target_os = "windows")]
fn cursor_monitor_rect() -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
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

/// GDI BitBlt 整屏捕获 → RGBA（top-down）。include_cursor 时用 GetCursorInfo 取
/// 全局光标句柄，DrawIconEx 画进 memDC（BitBlt 本身不含光标；坐标 = 屏幕物理 - 显示器原点）。
#[cfg(target_os = "windows")]
fn blit_capture(rect: &windows_sys::Win32::Foundation::RECT, include_cursor: bool) -> Option<(u32, u32, Vec<u8>)> {
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
        if GetWindowRectFallback(hwnd, &mut r) == 0 {
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
unsafe fn GetWindowRectFallback(
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
