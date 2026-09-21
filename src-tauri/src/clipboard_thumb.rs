//! 剪贴板图片缩略图（灵动岛显示提速）：复制图片时前端经插件读原图 base64（数 MB），
//! 岛窗口整包接收 + 全图解码是复杂图片显示慢的根因。剪贴板位图在 Rust 侧本就是
//! 解码好的像素数据——resize + PNG 编码毫秒级完成，前端/岛全程只传几十 KB 小图。
//! 仅 Windows 实现（CF_DIB 解析）；其他平台返回 None，前端回退原图链路（行为不劣化）。

/// 读取当前剪贴板图片并缩略（高 ≤ max_h，只缩不放），返回 data URL（PNG base64）。
/// 剪贴板打开冲突（插件轮询并发持有）时短暂重试，仍失败返回 None 由前端兜底。
#[tauri::command]
pub fn clipboard_image_thumb(max_h: u32) -> Option<String> {
    platform_impl(max_h)
}

#[cfg(target_os = "windows")]
fn platform_impl(max_h: u32) -> Option<String> {
use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows_sys::Win32::Foundation::HGLOBAL;
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
unsafe {
    // 剪贴板是全局互斥资源：clipboard 插件的 200ms 轮询可能正持有打开状态，
    // OpenClipboard 失败短暂重试（10ms × 3），仍失败放弃（宁缺勿错）
    let mut opened = false;
    for _ in 0..3 {
        if OpenClipboard(std::ptr::null_mut()) != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !opened {
        return None;
    }
    let result = (|| {
        // 8 = CF_DIB：BITMAPINFOHEADER（+调色板/掩码）+ 原始像素
        let h = GetClipboardData(8u32);
        if h.is_null() {
            return None;
        }
        let hglobal = h as HGLOBAL;
        let size = GlobalSize(hglobal);
        if size == 0 {
            return None;
        }
        let ptr = GlobalLock(hglobal) as *const u8;
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr, size);
        let decoded = parse_dib(bytes);
        GlobalUnlock(hglobal);
        let (w, h, rgba) = decoded?;
        thumb_png(w, h, rgba, max_h)
    })();
    CloseClipboard();
    result
}
}

/// 解析 CF_DIB 内存布局 → (宽, 高, RGBA 像素)。
/// 仅支持 24/32bpp 的 BI_RGB(0) / BI_BITFIELDS(3)——主流截图与图片工具的产出形态，
/// 其余格式（16bpp/压缩）返回 None 由前端兜底。
#[cfg(target_os = "windows")]
fn parse_dib(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    if bytes.len() < 40 {
        return None;
    }
    // 读取小端 u32/i32：越界返回 None（闭包显式 Option，调用处 ? 传播）
    let rd_u32 = |o: usize| -> Option<u32> {
        Some(u32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?))
    };
    let rd_i32 = |o: usize| -> Option<i32> {
        Some(i32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?))
    };
    let header_size = rd_u32(0)? as usize;
    if header_size < 40 || header_size > bytes.len() {
        return None;
    }
    let w = rd_i32(4)?;
    let height = rd_i32(8)?;
    let bpp = u16::from_le_bytes(bytes.get(14..16)?.try_into().ok()?) as u32;
    let compression = rd_u32(16)?;
    if w <= 0 || height == 0 || !matches!(bpp, 24 | 32) {
        return None;
    }
    if !matches!(compression, 0 | 3) {
        return None;
    }
    let top_down = height < 0;
    let h = height.unsigned_abs();
    let w = w as u32;
    // 像素数据偏移：header（V4/V5 头内嵌掩码）+ BI_BITFIELDS 时旧式头（40B）后的 3 个 mask
    let mut offset = header_size;
    if compression == 3 && header_size < 108 {
        offset += 12;
    }
    let stride = ((w * bpp + 31) / 32 * 4) as usize;
    if bytes.len() < offset + stride * h as usize {
        return None;
    }
    // u64 计算像素总量，防超大图 w*h*4 溢出 u32
    let total = (w as u64) * (h as u64) * 4;
    let mut rgba = vec![0u8; total as usize];
    for y in 0..h as usize {
        // DIB 默认 bottom-up（biHeight 正值），翻转为自上而下
        let src_y = if top_down { y } else { h as usize - 1 - y };
        let row = &bytes[offset + src_y * stride..];
        for x in 0..w as usize {
            let dst = &mut rgba[(y * w as usize + x) * 4..][..4];
            if bpp == 32 {
                // BGRA → RGBA（标准 mask：R 0x00FF0000 / G 0x0000FF00 / B 0x000000FF）
                dst[0] = row[x * 4 + 2];
                dst[1] = row[x * 4 + 1];
                dst[2] = row[x * 4];
                dst[3] = row[x * 4 + 3];
            } else {
                dst[0] = row[x * 3 + 2];
                dst[1] = row[x * 3 + 1];
                dst[2] = row[x * 3];
                dst[3] = 255;
            }
        }
    }
    // 截图等来源的 alpha 位常无效（全 0）：按不透明兜底，防整图透明不可见
    if bpp == 32 && !rgba.chunks_exact(4).any(|px| px[3] != 0) {
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    Some((w, h, rgba))
}

/// RGBA 像素 → 缩放（高 ≤ max_h，只缩不放，Triangle 滤镜）→ PNG → data URL
#[cfg(target_os = "windows")]
fn thumb_png(w: u32, h: u32, rgba: Vec<u8>, max_h: u32) -> Option<String> {
    use base64::Engine;
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba)?;
    let scale = if max_h > 0 && h > max_h {
        max_h as f64 / h as f64
    } else {
        1.0
    };
    let out: image::DynamicImage = if scale < 1.0 {
        let nw = ((w as f64 * scale).round() as u32).max(1);
        let nh = ((h as f64 * scale).round() as u32).max(1);
        image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle).into()
    } else {
        img.into()
    };
    let mut png = Cursor::new(Vec::new());
    out.write_to(&mut png, image::ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png.into_inner())
    ))
}

#[cfg(not(target_os = "windows"))]
fn platform_impl(_max_h: u32) -> Option<String> {
    // macOS/Linux 暂不实现：返回 None，前端回退原图链路（与既有行为一致，不劣化）
    None
}
