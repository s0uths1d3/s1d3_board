//! snip 截图域纯函数测试（Windows 门控）：
//! DIB 构造 ↔ parse_dib roundtrip（写剪贴板的字节必须能被本应用自己的读取管线还原）。

#![cfg(target_os = "windows")]

use app_lib::capture::build_dib_bgra_bottomup;
use app_lib::thumb::parse_dib;

#[test]
fn dib_roundtrip_32bpp() {
    let (w, h) = (7u32, 5u32);
    // alpha 全非 0：roundtrip 应逐字节还原（parse_dib 对 alpha=0 有不透明兜底，不纳入等价断言）
    let rgba: Vec<u8> = (0..(w * h * 4))
        .map(|i| if i % 4 == 3 { 255 } else { (i % 251) as u8 })
        .collect();
    let dib = build_dib_bgra_bottomup(w, h, &rgba);
    // 头部结构断言：40 字节 INFOHEADER + 正高 bottom-up + 32bpp BI_RGB
    assert_eq!(&dib[0..4], &40u32.to_le_bytes());
    assert_eq!(&dib[4..8], &(w as i32).to_le_bytes());
    assert_eq!(&dib[8..12], &(h as i32).to_le_bytes());
    assert_eq!(&dib[12..14], &1u16.to_le_bytes());
    assert_eq!(&dib[14..16], &32u16.to_le_bytes());
    assert_eq!(&dib[16..20], &0u32.to_le_bytes()); // BI_RGB

    let (rw, rh, rrgba) = parse_dib(&dib).expect("parse_dib 应接受自产 DIB");
    assert_eq!((rw, rh), (w, h));
    assert_eq!(rrgba, rgba);
}

#[test]
fn dib_roundtrip_1x1() {
    let rgba = vec![10u8, 20, 30, 255];
    let dib = build_dib_bgra_bottomup(1, 1, &rgba);
    let (w, h, r) = parse_dib(&dib).expect("1x1 应可解析");
    assert_eq!((w, h), (1, 1));
    assert_eq!(r, rgba);
}
