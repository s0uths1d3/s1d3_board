//! snip 截图域纯函数测试（Windows 门控）：
//! DIB 构造 ↔ parse_dib roundtrip（写剪贴板的字节必须能被本应用自己的读取管线还原）。

#![cfg(target_os = "windows")]

use app_lib::capture::build_dib_bgra_bottomup;
use app_lib::capture::{find_vertical_overlap, stitch_frames, stitch_vertical};
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

// ===================== 长截图：竖向拼接 =====================

/// 文档第 y 行的确定颜色（整行同色，行间差异明显）
fn doc_row_color(y: u32) -> [u8; 4] {
    [
        ((y * 37 + 11) % 256) as u8,
        ((y * 91 + 53) % 256) as u8,
        ((y * 53 + 7) % 256) as u8,
        255,
    ]
}

/// 从虚拟文档截取 [start, start+h) 行（宽 w；右侧 30px 模拟滚动条区域，
/// 内容随帧变化——验证检测器已排除滚动条干扰）
fn doc_slice(w: u32, h: u32, start: u32, scrollbar_phase: u32) -> Vec<u8> {
    let mut buf = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        let c = doc_row_color(start + y);
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            // 右侧 30px：滚动条（两帧滑块位置不同）
            if x + 30 >= w {
                let v = ((y + scrollbar_phase) * 17 % 200) as u8;
                buf[i..i + 4].copy_from_slice(&[v, v, v, 255]);
            } else {
                buf[i..i + 4].copy_from_slice(&c);
            }
        }
    }
    buf
}

#[test]
fn overlap_detected_exact() {
    let (w, h, scroll) = (200u32, 40u32, 12u32);
    let top = doc_slice(w, h, 0, 0);
    let bottom = doc_slice(w, h, scroll, 7);
    // 重叠 = 40 - 12 = 28
    assert_eq!(find_vertical_overlap(&top, w, h, &bottom, w, h), Some(28));
}

#[test]
fn overlap_detected_multiple_scroll_sizes() {
    for scroll in [5u32, 10, 17, 25] {
        let (w, h) = (120u32, 60u32);
        let top = doc_slice(w, h, 100, 0);
        let bottom = doc_slice(w, h, 100 + scroll, 3);
        assert_eq!(
            find_vertical_overlap(&top, w, h, &bottom, w, h),
            Some(h - scroll),
            "scroll={scroll} 应检出重叠 {}",
            h - scroll
        );
    }
}

#[test]
fn overlap_rejects_no_scroll() {
    // 两帧完全相同 = 页面未滚动：重叠达 100% 必须拒绝（否则拼出重复内容）
    let (w, h) = (80u32, 50u32);
    let a = doc_slice(w, h, 0, 0);
    assert_eq!(find_vertical_overlap(&a, w, h, &a, w, h), None);
}

#[test]
fn overlap_rejects_unrelated() {
    let (w, h) = (80u32, 50u32);
    let top = doc_slice(w, h, 0, 0);
    // 完全不同的文档段 → 无匹配
    let mut bottom = doc_slice(w, h, 500, 0);
    // 再加噪声，避免灰度签名偶然相同
    for (i, b) in bottom.iter_mut().enumerate() {
        if i % 4 != 3 {
            *b = b.wrapping_add(((i / 4) % 97) as u8);
        }
    }
    assert_eq!(find_vertical_overlap(&top, w, h, &bottom, w, h), None);
}

#[test]
fn overlap_rejects_tiny_images() {
    let (w, h) = (20u32, 4u32);
    let a = doc_slice(w, h, 0, 0);
    let b = doc_slice(w, h, 1, 0);
    assert_eq!(find_vertical_overlap(&a, w, h, &b, w, h), None);
}

#[test]
fn stitch_drops_overlap_rows() {
    let (w, h) = (16u32, 10u32);
    let top = doc_slice(w, h, 0, 0);
    let bottom = doc_slice(w, h, 6, 0); // 重叠 4 行
    let (nw, nh, out) = stitch_vertical(&top, w, h, &bottom, w, h, 4).expect("应可拼接");
    assert_eq!((nw, nh), (w, 16));
    assert_eq!(out.len(), (w * 16 * 4) as usize);
    // 第 9 行（top 最后一行）与拼接图第 9 行一致
    let row = |buf: &[u8], y: u32| {
        let i = (y * w * 4) as usize;
        buf[i..i + (w * 4) as usize].to_vec()
    };
    assert_eq!(row(&out, 9), row(&top, 9));
    // 拼接图第 10 行 = bottom 第 4 行（跳过重叠的 4 行）
    assert_eq!(row(&out, 10), row(&bottom, 4));
}

#[test]
fn stitch_rejects_width_mismatch() {
    let top = doc_slice(10, 5, 0, 0);
    let bottom = doc_slice(12, 5, 2, 0);
    assert!(stitch_vertical(&top, 10, 5, &bottom, 12, 5, 1).is_none());
}

// ===================== 长截图：多帧序列（命令核心） =====================

#[test]
fn frames_stitch_three_scrolls() {
    // 三帧：每帧下滚 10 行（帧高 40 → 相邻重叠 30），内容并集 = 0..60 共 60 行
    let (w, h) = (100u32, 40u32);
    let frames = vec![
        (w, h, doc_slice(w, h, 0, 0)),
        (w, h, doc_slice(w, h, 10, 4)),
        (w, h, doc_slice(w, h, 20, 9)),
    ];
    let (nw, nh, out, ov) = stitch_frames(&frames).expect("三帧应可拼接");
    assert_eq!(nw, w);
    assert_eq!(nh, 60);
    assert_eq!(ov, 30);
    assert_eq!(out.len(), (nw * nh * 4) as usize);
}

#[test]
fn frames_skip_duplicate_frame() {
    // 第二帧与第一帧完全相同（未滚动）：必须跳过，不得拼出重复内容
    let (w, h) = (60u32, 30u32);
    let a = doc_slice(w, h, 0, 0);
    let frames = vec![(w, h, a.clone()), (w, h, a.clone())];
    let (nw, nh, _, ov) = stitch_frames(&frames).expect("同帧应返回首帧");
    assert_eq!((nw, nh), (w, h));
    assert_eq!(ov, 0);
}

#[test]
fn frames_skip_unrelated_frame_keep_rest() {
    // 首帧 → 无关帧（滚动过头）跳过 → 正常帧仍可拼接
    let (w, h) = (60u32, 30u32);
    // 确定性伪随机字节：保证与文档内容不可能产生行签名匹配
    let mut seed = 12345u32;
    let junk: Vec<u8> = (0..(w * h * 4))
        .map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 24) as u8
        })
        .collect();
    let frames = vec![
        (w, h, doc_slice(w, h, 0, 0)),
        (w, h, junk),
        (w, h, doc_slice(w, h, 12, 2)),
    ];
    let (_, nh, _, ov) = stitch_frames(&frames).expect("应跳过无关帧");
    assert_eq!(nh, h + 12);
    assert_eq!(ov, 18);
}

#[test]
fn frames_reject_width_mismatch() {
    let frames = vec![
        (10u32, 5u32, doc_slice(10, 5, 0, 0)),
        (12u32, 5u32, doc_slice(12, 5, 2, 0)),
    ];
    assert!(stitch_frames(&frames).is_err());
}

#[test]
fn frames_reject_empty() {
    assert!(stitch_frames(&[]).is_err());
}
