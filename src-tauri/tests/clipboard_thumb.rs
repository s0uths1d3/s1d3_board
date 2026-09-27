//! 剪贴板 CF_DIB 位图解析集成测试（独立于核心代码，`cargo test --test clipboard_thumb` 运行）。
//! 被测对象：`clipboard::thumb::parse_dib`——CF_DIB 内存布局 → (宽, 高, RGBA 像素) 的纯解析函数。
//! 覆盖：32bpp bottom-up 行序翻转、24bpp 顶down + stride 对齐 padding、BI_BITFIELDS 旧头
//! 掩码偏移（+12B）、32bpp alpha 全 0 兜底 255，以及非法格式（短头 / 16bpp / RLE 压缩 /
//! 零宽 / 零高）拒绝。
//! parse_dib 仅为 Windows 实现，整个测试文件以 #![cfg(target_os = "windows")] 门控，
//! 其他平台编译为空测试二进制（0 个测试）。
#![cfg(target_os = "windows")]

use app_lib::thumb::parse_dib;

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
