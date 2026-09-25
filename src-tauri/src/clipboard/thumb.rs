//! 剪贴板图片缩略图（灵动岛显示提速）+ 二维码识别：复制图片时前端经插件读原图 base64（数 MB），
//! 岛窗口整包接收 + 全图解码是复杂图片显示慢的根因。剪贴板位图在 Rust 侧本就是
//! 解码好的像素数据——resize + PNG 编码毫秒级完成，前端/岛全程只传几十 KB 小图。
//! 同一次解码顺手做二维码扫描（quircs：C 库 quirc 绑定）：识别出 QR 内容随缩略图一并返回，
//! 前端据此在灵动岛显示链接、Ctrl+B 环盘把链接当文本切分，避免二次跨 IPC 传大图。
//! 缩略图仅 Windows 实现（CF_DIB 解析）；其他平台返回 None，前端回退原图链路（行为不劣化）。
//! 二维码补解码命令 clipboard_qr_from_data_url 为纯 Rust 实现，全平台可用。

/// 剪贴板图片处理结果：thumb = 岛显示缩略图（data URL，None 回退原图）；
/// qrText = 图片中识别出的二维码文本（非二维码/解码失败为 None）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageInfo {
    pub thumb: Option<String>,
    pub qr_text: Option<String>,
}

/// 读取当前剪贴板图片并缩略（高 ≤ max_h，只缩不放）+ 二维码扫描。
/// 剪贴板打开冲突（插件轮询并发持有）时短暂重试，仍失败返回 None 由前端兜底。
#[tauri::command]
pub fn clipboard_image_thumb(max_h: u32) -> Option<ClipboardImageInfo> {
    platform_impl(max_h)
}

/// 从 data URL（base64 图片）解码二维码文本：存量图片条目补识别 / 右键判定用。
/// thorough=true（默认）走多尺度彻底扫描（512/1024/2048 三档，慢但全）；
/// false 走单档 512px 快扫（复制路径时序敏感）。按真实字节嗅探格式；无码/失败返回 None。
#[tauri::command]
pub fn clipboard_qr_from_data_url(data_url: String, thorough: Option<bool>) -> Option<String> {
    use base64::Engine;
    let b64 = data_url.split_once("base64,").map(|(_, b)| b).unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    let rgba = img.to_rgba8().into_raw();
    if thorough.unwrap_or(true) {
        scan_qr_thorough(w, h, &rgba)
    } else {
        scan_qr_rgba(w, h, &rgba)
    }
}

#[cfg(target_os = "windows")]
fn platform_impl(max_h: u32) -> Option<ClipboardImageInfo> {
with_clipboard_dib(|w, h, rgba| {
    let thumb = thumb_png(w, h, rgba, max_h);
    let qr_text = scan_qr_rgba(w, h, rgba);
    Some(ClipboardImageInfo { thumb, qr_text })
})
}

/// 打开剪贴板读 CF_DIB 解析为 RGBA 交给回调消费（thumb / capture 共用）。
/// 剪贴板是全局互斥资源：clipboard 插件的 200ms 轮询可能正持有打开状态，
/// OpenClipboard 失败短暂重试（10ms × 3），仍失败放弃（宁缺勿错）。
#[cfg(target_os = "windows")]
fn with_clipboard_dib<T>(consume: impl FnOnce(u32, u32, &[u8]) -> Option<T>) -> Option<T> {
use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows_sys::Win32::Foundation::HGLOBAL;
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
unsafe {
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
        consume(w, h, &rgba)
    })();
    CloseClipboard();
    result
}
}

// ===================== 复制快速通道：单命令捕获 =====================

/// 单命令捕获结果：file_ref = 原图落盘引用（DB 直接存）；thumb = 岛显示缩略图；
/// qr_text = 二维码文本；original = 原图 data URL（岛事件/出站的原图语义不变）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedClipboardImage {
    pub file_ref: String,
    pub thumb: Option<String>,
    pub qr_text: Option<String>,
    pub original: String,
}

/// 复制图片快速通道（取代旧三段串行链路）：剪贴板位图读一次，PNG 落盘 +
/// 缩略图 + 二维码扫描一并完成。旧链路「插件 readImageBase64（多 MB IPC）→
/// save_clipboard_image（多 MB 回传落盘）→ clipboard_image_thumb（重复读剪贴板）」
/// 把数 MB 原图跨进程搬运 3 次，串行排队是截图后延迟入列的主因；快速通道
/// 原图只随本命令返回一次。async 定义使落盘/编码离开主线程。
/// 捕获失败（非 Windows/剪贴板锁冲突/格式不支持/超限）返回 None，前端回退旧链路。
#[tauri::command]
pub async fn clipboard_capture_image(
    app: tauri::AppHandle,
    max_h: u32,
) -> Option<CapturedClipboardImage> {
    platform_capture(&app, max_h)
}

#[cfg(target_os = "windows")]
fn platform_capture(app: &tauri::AppHandle, max_h: u32) -> Option<CapturedClipboardImage> {
with_clipboard_dib(|w, h, rgba| {
    // 原图直接落盘（内容寻址）：失败（超限等）返回 None 整体回退旧链路
    let file_ref = crate::clipboard::image_store::save_rgba_image(app, w, h, rgba)?;
    let original = png_data_url(w, h, rgba, None)?;
    let thumb = thumb_png(w, h, rgba, max_h);
    let qr_text = scan_qr_rgba(w, h, rgba);
    Some(CapturedClipboardImage { file_ref, thumb, qr_text, original })
})
}

#[cfg(not(target_os = "windows"))]
fn platform_capture(_app: &tauri::AppHandle, _max_h: u32) -> Option<CapturedClipboardImage> {
// macOS/Linux 暂无缩略/落盘链路：返回 None，前端回退旧链路（行为不劣化）
None
}

/// 二维码快速扫描（复制时序敏感路径）：RGBA 像素 → 等比缩到 ≤512px（Triangle 均值降采样，
/// 避免点采样混叠破坏 QR 模块网格）→ 逐像素灰度化 → rqrr 网格检测 + 解码。
/// 无码/失败返回 None（零成本跳过，不影响非二维码图片链路）；彻底识别走 scan_qr_thorough。
pub fn scan_qr_rgba(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    scan_at_scale(&img, SCAN_MAX)
}

/// 二维码彻底扫描（右键判定/懒解码路径）：依次尝试 512 / 1024 / 2048px 三档缩放
/// （任一档成功即返回）。小码嵌大图（截图角落）在低档失败、高档成功；细模块大码
/// 在低档即可解码，高档兜底。三档全失败返回 None。
pub fn scan_qr_thorough(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    for target in [SCAN_MAX, 1024, 2048] {
        if let Some(text) = scan_at_scale(&img, target) {
            return Some(text);
        }
    }
    None
}

/// 快速档目标尺寸（复制路径单尺度扫描用）
const SCAN_MAX: u32 = 512;

/// 单档扫描：最长边 > target 时 Triangle 降采样（面积均值，抗混叠），否则按原图；
/// BT.601 整数灰度 → rqrr 自适应二值化 + 网格检测 + 解码，返回首个非空文本。
fn scan_at_scale(img: &image::RgbaImage, target: u32) -> Option<String> {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let long = w.max(h);
    let scaled: image::RgbaImage = if long > target {
        let s = target as f64 / long as f64;
        let nw = ((w as f64 * s).round() as u32).max(1);
        let nh = ((h as f64 * s).round() as u32).max(1);
        image::imageops::resize(img, nw, nh, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let (sw, sh) = (scaled.width() as usize, scaled.height() as usize);
    let rgba = scaled.as_raw();
    let mut gray: Vec<u8> = vec![0; sw * sh];
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        // ITU-R BT.601 整数近似灰度（77/151/28），QR 阈值检测对灰度精度不敏感
        gray[i] = ((px[0] as u32 * 77 + px[1] as u32 * 151 + px[2] as u32 * 28) >> 8) as u8;
    }
    // quircs（C 库 quirc 绑定）识别：内置 Otsu 自适应二值化 + 网格检测 + 纠错解码，
    // 对 Logo 遮挡码（微信/QQ 群二维码）的识别强于 rqrr。逐个解码取首个非空文本。
    let mut decoder = quircs::Quirc::new();
    for code in decoder.identify(sw, sh, &gray) {
        let Ok(code) = code else { continue };
        if let Ok(data) = code.decode() {
            let text = String::from_utf8_lossy(&data.payload).trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
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

/// RGBA 像素 → 缩放（max_h 有值且高 > max_h 时只缩不放，Triangle 滤镜）→ PNG → data URL。
/// max_h=None 编码原图（capture 快速通道返回原图 data URL 用）。
#[cfg(target_os = "windows")]
fn png_data_url(w: u32, h: u32, rgba: &[u8], max_h: Option<u32>) -> Option<String> {
    use base64::Engine;
    use std::io::Cursor;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let max = max_h.unwrap_or(0);
    let scale = if max > 0 && h > max {
        max as f64 / h as f64
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

/// RGBA 像素 → 缩略图 data URL（高 ≤ max_h，只缩不放）
#[cfg(target_os = "windows")]
fn thumb_png(w: u32, h: u32, rgba: &[u8], max_h: u32) -> Option<String> {
    png_data_url(w, h, rgba, Some(max_h))
}

#[cfg(not(target_os = "windows"))]
fn platform_impl(_max_h: u32) -> Option<ClipboardImageInfo> {
    // macOS/Linux 暂不实现缩略：返回 None，前端回退原图链路（与既有行为一致，不劣化）
    None
}

// ===================== 单元测试 =====================

/// 测试用 QR 图生成：qrcode dev-dep 生成矩阵 → 每模块 scale 像素 + 4 模块静区 → RGBA。
/// （qrcode 仅在 dev-dependencies，运行时不引入。）
#[cfg(test)]
fn make_qr_rgba(text: &str, scale: usize) -> (u32, u32, Vec<u8>) {
    use qrcode::{Color, EcLevel, QrCode, Version};
    let code = QrCode::with_version(text.as_bytes(), Version::Normal(5), EcLevel::M)
        .expect("QR 生成失败");
    let qw = code.width();
    let colors = code.to_colors();
    assert_eq!(colors.len(), qw * qw);
    let quiet = 4usize;
    let total = (qw + quiet * 2) * scale;
    let mut img = vec![255u8; total * total * 4]; // 白底（RGB 各 255，alpha 255）
    for (i, c) in colors.iter().enumerate() {
        let (mx, my) = (i % qw, i / qw);
        for dy in 0..scale {
            for dx in 0..scale {
                let off = (((quiet + my) * scale + dy) * total + (quiet + mx) * scale + dx) * 4;
                let v = if *c == Color::Dark { 0u8 } else { 255u8 };
                img[off] = v;
                img[off + 1] = v;
                img[off + 2] = v;
                img[off + 3] = 255;
            }
        }
    }
    (total as u32, total as u32, img)
}

#[cfg(test)]
mod qr_tests {
    use super::*;

    const TEXT: &str = "https://s1d3.example/roundtrip";

    #[test]
    fn scan_qr_rgba_roundtrip() {
        let (w, h, rgba) = make_qr_rgba(TEXT, 8);
        assert_eq!(scan_qr_rgba(w, h, &rgba).as_deref(), Some(TEXT));
    }

    #[test]
    fn scan_qr_thorough_roundtrip() {
        let (w, h, rgba) = make_qr_rgba(TEXT, 8);
        assert_eq!(scan_qr_thorough(w, h, &rgba).as_deref(), Some(TEXT));
    }

    #[test]
    fn scan_plain_image_returns_none() {
        // 纯白图无码 → None（零成本跳过路径）
        let (w, h, rgba) = (64u32, 64u32, vec![255u8; 64 * 64 * 4]);
        assert_eq!(scan_qr_rgba(w, h, &rgba), None);
        assert_eq!(scan_qr_thorough(w, h, &rgba), None);
    }

    #[test]
    fn scan_rejects_zero_dimension() {
        assert_eq!(scan_qr_rgba(0, 10, &[]), None);
        assert_eq!(scan_qr_thorough(10, 0, &[]), None);
    }

    #[test]
    fn clipboard_qr_from_data_url_roundtrip() {
        // 命令入口回环：QR RGBA → PNG → data URL → clipboard_qr_from_data_url 解出原文
        use base64::Engine;
        use std::io::Cursor;
        let (w, h, rgba) = make_qr_rgba(TEXT, 8);
        let img = image::RgbaImage::from_raw(w, h, rgba).expect("构造图片失败");
        let mut png = Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).expect("PNG 编码失败");
        let data_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.into_inner())
        );
        assert_eq!(
            clipboard_qr_from_data_url(data_url, Some(false)).as_deref(),
            Some(TEXT)
        );
    }
}

/// CF_DIB 解析测试（仅 Windows：parse_dib 为 Windows 路径）
#[cfg(all(test, target_os = "windows"))]
mod dib_tests {
    use super::*;

    /// 构造 BITMAPINFOHEADER（header_size 字节，V3 最小 40）
    fn header(header_size: u32, w: i32, height: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut h = vec![0u8; header_size as usize];
        h[0..4].copy_from_slice(&header_size.to_le_bytes());
        h[4..8].copy_from_slice(&w.to_le_bytes());
        h[8..12].copy_from_slice(&height.to_le_bytes());
        h[12..14].copy_from_slice(&1u16.to_le_bytes()); // biPlanes
        h[14..16].copy_from_slice(&bpp.to_le_bytes());
        h[16..20].copy_from_slice(&compression.to_le_bytes());
        h
    }

    #[test]
    fn parse_dib_32bpp_bottom_up_flip() {
        // 1×2 32bpp BI_RGB：正值高度 = bottom-up。底行 BGRA(10,20,30,255)、顶行 BGRA(100,110,120,255)
        let mut dib = header(40, 1, 2, 32, 0);
        dib.extend_from_slice(&[10, 20, 30, 255]); // bottom row
        dib.extend_from_slice(&[100, 110, 120, 255]); // top row
        let (w, h, rgba) = parse_dib(&dib).expect("应解析成功");
        assert_eq!((w, h), (1, 2));
        // 翻转为自上而下：首行是顶行，BGRA → RGBA
        assert_eq!(&rgba[0..4], &[120, 110, 100, 255]);
        assert_eq!(&rgba[4..8], &[30, 20, 10, 255]);
    }

    #[test]
    fn parse_dib_24bpp_top_down_with_stride_padding() {
        // 2×1 24bpp 顶down（负高度）：行宽 6B，stride 对齐到 8B（2B padding 不参与）
        let mut dib = header(40, 2, -1, 24, 0);
        dib.extend_from_slice(&[1, 2, 3, 4, 5, 6, 0, 0]); // BGR,BGR + padding
        let (w, h, rgba) = parse_dib(&dib).expect("应解析成功");
        assert_eq!((w, h), (2, 1));
        assert_eq!(&rgba[0..4], &[3, 2, 1, 255]); // BGR→RGBA，alpha 兜底 255
        assert_eq!(&rgba[4..8], &[6, 5, 4, 255]);
    }

    #[test]
    fn parse_dib_bitfields_legacy_header_offset_masks() {
        // BI_BITFIELDS(3) + 40B 旧头：头后跟 3 个 4B 掩码，像素偏移 +12
        let mut dib = header(40, 1, 1, 32, 3);
        dib.extend_from_slice(&[0, 0, 0, 0]); // R mask（占位）
        dib.extend_from_slice(&[0, 0, 0, 0]); // G mask
        dib.extend_from_slice(&[0, 0, 0, 0]); // B mask
        dib.extend_from_slice(&[10, 20, 30, 255]);
        let (_, _, rgba) = parse_dib(&dib).expect("BITFIELDS 旧头应解析成功");
        assert_eq!(&rgba[0..4], &[30, 20, 10, 255]);
    }

    #[test]
    fn parse_dib_bumps_all_zero_alpha() {
        // 32bpp alpha 全 0（截图常见）→ 兜底 255
        let mut dib = header(40, 1, 1, 32, 0);
        dib.extend_from_slice(&[10, 20, 30, 0]);
        let (_, _, rgba) = parse_dib(&dib).expect("应解析成功");
        assert_eq!(&rgba[0..4], &[30, 20, 10, 255]);
    }

    #[test]
    fn parse_dib_rejects_unsupported() {
        assert!(parse_dib(&[0u8; 39]).is_none(), "短于 40B 头应拒绝");
        assert!(parse_dib(&header(40, 1, 1, 16, 0)).is_none(), "16bpp 应拒绝");
        assert!(parse_dib(&header(40, 1, 1, 32, 1)).is_none(), "RLE 压缩应拒绝");
        assert!(parse_dib(&header(40, 0, 1, 32, 0)).is_none(), "宽 0 应拒绝");
        assert!(parse_dib(&header(40, 1, 0, 32, 0)).is_none(), "高 0 应拒绝");
    }
}
