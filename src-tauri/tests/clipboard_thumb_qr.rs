//! 二维码识别集成测试（独立于核心代码，`cargo test --test clipboard_thumb_qr` 运行）。
//! 被测对象：`clipboard_thumb` 模块的二维码扫描纯函数与 data URL 解码命令——
//! - `scan_qr_rgba`：RGBA 像素 → 灰度化（≤512px 缩放）→ rqrr 识别；
//! - `clipboard_qr_from_data_url`：base64 图片 → 字节嗅探格式 → 解码。
//! 测试用二维码图片由 `qrcode` dev-dependency 现场生成（不落盘、不依赖固定资源文件）。

use app_lib::clipboard_thumb::{clipboard_qr_from_data_url, scan_qr_rgba, scan_qr_thorough};

/// 用 qrcode crate 生成二维码灰度图并转 RGBA（Pixel 实现在 image::Luma<u8> 上）
fn qr_rgba(text: &str) -> (u32, u32, Vec<u8>) {
    let code =
        qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M).unwrap();
    let img = code.render::<image::Luma<u8>>().quiet_zone(true).min_dimensions(200, 200).build();
    let (w, h) = (img.width(), img.height());
    let rgba = img.into_raw().into_iter().flat_map(|g| [g, g, g, 255]).collect();
    (w, h, rgba)
}

/// 最近邻放大（模拟复杂大图触发 SCAN_MAX=512 缩放扫描路径）
fn upscale_nearest(rgba: &[u8], w: u32, h: u32, factor: u32) -> (u32, u32, Vec<u8>) {
    let (nw, nh) = (w * factor, h * factor);
    let mut out = vec![0u8; nw as usize * nh as usize * 4];
    for y in 0..nh {
        for x in 0..nw {
            let src = ((y / factor) * w + (x / factor)) as usize * 4;
            let dst = (y * nw + x) as usize * 4;
            out[dst..dst + 4].copy_from_slice(&rgba[src..src + 4]);
        }
    }
    (nw, nh, out)
}

/// RGBA → 编码图片 → data URL（JPEG 需转 RGB8：编码器不支持 RGBA 通道）
fn to_data_url(rgba: &[u8], w: u32, h: u32, format: image::ImageFormat) -> String {
    use base64::Engine;
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).unwrap();
    let dyn_img = image::DynamicImage::ImageRgba8(img).to_rgb8();
    let mut buf = std::io::Cursor::new(Vec::new());
    dyn_img.write_to(&mut buf, format).unwrap();
    let mime = if format == image::ImageFormat::Jpeg { "jpeg" } else { "png" };
    format!(
        "data:image/{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    )
}

#[test]
fn scan_recognizes_basic_qr() {
    let (w, h, rgba) = qr_rgba("https://example.com/hello");
    assert_eq!(
        scan_qr_rgba(w, h, &rgba).as_deref(),
        Some("https://example.com/hello")
    );
}

#[test]
fn scan_downscales_large_qr_above_scan_max() {
    let (w, h, rgba) = qr_rgba("https://example.com/large-image");
    let (nw, nh, big) = upscale_nearest(&rgba, w, h, 4);
    assert!(nw.max(nh) > 512, "测试前提：大图应触发缩放路径");
    assert_eq!(
        scan_qr_rgba(nw, nh, &big).as_deref(),
        Some("https://example.com/large-image")
    );
}

#[test]
fn scan_returns_none_for_blank_image() {
    let rgba = vec![255u8; 120 * 120 * 4];
    assert_eq!(scan_qr_rgba(120, 120, &rgba), None);
}

#[test]
fn scan_guards_invalid_input() {
    assert_eq!(scan_qr_rgba(0, 10, &[]), None); // 零宽
    assert_eq!(scan_qr_rgba(10, 0, &[]), None); // 零高
    assert_eq!(scan_qr_rgba(10, 10, &[0u8; 16]), None); // 像素长度不足
}

#[test]
fn data_url_roundtrip_png() {
    let (w, h, rgba) = qr_rgba("https://s1d3.board/roundtrip");
    let url = to_data_url(&rgba, w, h, image::ImageFormat::Png);
    assert_eq!(
        clipboard_qr_from_data_url(url, None).as_deref(),
        Some("https://s1d3.board/roundtrip")
    );
}

#[test]
fn data_url_sniffs_real_format_over_prefix() {
    // data URL 前缀谎报 png、真实字节是 JPEG：按字节嗅探应成功识别（剪贴板来源前缀不可信）
    let (w, h, rgba) = qr_rgba("https://s1d3.board/jpeg");
    let url =
        to_data_url(&rgba, w, h, image::ImageFormat::Jpeg).replacen("image/jpeg", "image/png", 1);
    assert_eq!(
        clipboard_qr_from_data_url(url, None).as_deref(),
        Some("https://s1d3.board/jpeg")
    );
}

#[test]
fn data_url_accepts_raw_base64_without_prefix() {
    use base64::Engine;
    let (w, h, rgba) = qr_rgba("https://s1d3.board/raw");
    let img = image::RgbaImage::from_raw(w, h, rgba).unwrap();
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .to_rgb8()
        .write_to(&mut buf, image::ImageFormat::Png)
        .unwrap();
    let raw = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    assert_eq!(
        clipboard_qr_from_data_url(raw, None).as_deref(),
        Some("https://s1d3.board/raw")
    );
}

#[test]
fn data_url_rejects_garbage_input() {
    assert_eq!(clipboard_qr_from_data_url(String::new(), None), None); // 空串
    assert_eq!(clipboard_qr_from_data_url("not-a-data-url".into(), None), None); // 非 base64
    assert_eq!(
        clipboard_qr_from_data_url("data:image/png;base64,@@@@".into(), None),
        None // 坏 base64
    );
    assert_eq!(
        clipboard_qr_from_data_url("data:image/png;base64,QUJD".into(), None),
        None // 合法 base64 但非图片字节
    );
}

#[test]
fn thorough_finds_small_qr_in_large_canvas() {
    // 小码嵌大图（截图角落场景）：快扫 512px 档大概率失败，彻底扫描应在高档（1024/2048）解码
    let (w, h, rgba) = qr_rgba("https://s1d3.board/tiny-in-canvas");
    let qr = image::RgbaImage::from_raw(w, h, rgba).unwrap();
    let mut canvas = image::RgbaImage::from_pixel(2000, 2000, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut canvas, &qr, 1600, 1600);
    let (cw, ch) = (canvas.width(), canvas.height());
    let raw = canvas.into_raw();
    assert_eq!(
        scan_qr_thorough(cw, ch, &raw).as_deref(),
        Some("https://s1d3.board/tiny-in-canvas")
    );
}
