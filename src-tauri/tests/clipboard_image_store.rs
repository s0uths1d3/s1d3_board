//! 剪贴板图片文件存储集成测试（独立于核心代码，`cargo test --test clipboard_image_store` 运行）。
//! 被测对象：`clipboard::image_store` 模块以目录为参数的核心读写删函数——
//! - `decode_data_url`：data URL / 裸 base64 → 图片字节（前缀剥离、空白 trim、坏输入拒绝）；
//! - `sanitize_file_name`：文件名消毒（拒绝路径成分 / 冒号，防穿越与 NTFS 备用数据流）；
//! - `valid_image_path`：路径双保险（父目录必须为 images 且文件存在）；
//! - `save_to_dir` / `read_from_dir` / `delete_from_dir`：内容寻址落盘、读取回环、幂等删除；
//! - `save_rgba_to_dir`：RGBA 像素直接 PNG 落盘（截图快速通道），回环解码校验尺寸；
//! - `list_from_dir` / `delete_batch_from_dir`：磁盘清单与批量删除（清理策略支撑）。
//! 临时目录用 std::env::temp_dir + 纳秒时间戳现建现删，不依赖 tempfile 等外部 crate。

use app_lib::image_store::{
    decode_data_url, delete_batch_from_dir, delete_from_dir, list_from_dir, read_from_dir,
    sanitize_file_name, save_rgba_to_dir, save_to_dir, valid_image_path, MAX_IMAGE_BYTES,
};
use base64::Engine;
use std::fs;
use std::path::PathBuf;

/// 构造临时 images 目录：temp 根下唯一子目录 images/，返回（根目录, images 目录）。
/// 根目录名刻意不叫 images，用于 valid_image_path 双保险的反例。
fn temp_images_dir(tag: &str) -> (PathBuf, PathBuf) {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("s1d3_imgstore_{}_{}", tag, nanos));
    let images = root.join("images");
    fs::create_dir_all(&images).expect("创建临时 images 目录失败");
    (root, images)
}

// ---------- decode_data_url ----------

#[test]
fn decode_data_url_with_prefix() {
    // data:image/png;base64, 前缀被剥掉，只解码真身
    let bytes = decode_data_url("data:image/png;base64,aGVsbG8=").expect("应解码成功");
    assert_eq!(bytes, b"hello");
}

#[test]
fn decode_data_url_bare_base64() {
    let bytes = decode_data_url("aGVsbG8=").expect("裸 base64 应解码成功");
    assert_eq!(bytes, b"hello");
}

#[test]
fn decode_data_url_trims_surrounding_whitespace() {
    // trim 只剥首尾空白（换行/空格），真身解码不受影响
    let bytes = decode_data_url("  aGVsbG8=\n").expect("首尾空白应 trim 后解码成功");
    assert_eq!(bytes, b"hello");
}

#[test]
fn decode_data_url_internal_whitespace_fails() {
    // 内部空白非合法 base64 字符 → None（与 base64 crate 标准引擎语义一致）
    assert!(decode_data_url("aGVs bG8=").is_none());
}

#[test]
fn decode_data_url_invalid_returns_none() {
    assert!(decode_data_url("!!!!不是base64!!!!").is_none());
}

#[test]
fn decode_data_url_empty_returns_none() {
    // 空串解码为空字节，此处返回 Ok(vec![])——超限/空判定在 save_to_dir 中做
    assert_eq!(decode_data_url("").unwrap(), Vec::<u8>::new());
}

// ---------- sanitize_file_name ----------

#[test]
fn sanitize_allows_plain_hash_name() {
    assert_eq!(sanitize_file_name("abcdef0123456789.png"), Some("abcdef0123456789.png"));
}

#[test]
fn sanitize_trims_surrounding_spaces() {
    assert_eq!(sanitize_file_name("  a.png  "), Some("a.png"));
}

#[test]
fn sanitize_rejects_empty() {
    assert_eq!(sanitize_file_name(""), None);
    assert_eq!(sanitize_file_name("   "), None);
}

#[test]
fn sanitize_rejects_slashes() {
    assert_eq!(sanitize_file_name("sub/a.png"), None);
    assert_eq!(sanitize_file_name("sub\\a.png"), None);
}

#[test]
fn sanitize_rejects_dotdot_traversal() {
    assert_eq!(sanitize_file_name(".."), None);
    assert_eq!(sanitize_file_name("../a.png"), None);
    assert_eq!(sanitize_file_name("a..png"), None);
}

#[test]
fn sanitize_rejects_colon() {
    // 盘符 / NTFS 备用数据流均含冒号
    assert_eq!(sanitize_file_name("C:a.png"), None);
    assert_eq!(sanitize_file_name("a.png:ads"), None);
}

// ---------- valid_image_path ----------

#[test]
fn valid_image_path_accepts_images_dir_file() {
    let (root, images) = temp_images_dir("valid_ok");
    let file = images.join("a.png");
    fs::write(&file, b"x").expect("写测试文件失败");
    assert!(valid_image_path(&file));
    fs::remove_dir_all(root).ok();
}

#[test]
fn valid_image_path_rejects_non_images_parent() {
    // 父目录名不是 images → 双保险拒绝（防换目录绕过）
    let (root, images) = temp_images_dir("valid_parent");
    let other = root.join("not_images");
    fs::create_dir_all(&other).expect("建目录失败");
    let file = other.join("a.png");
    fs::write(&file, b"x").expect("写测试文件失败");
    assert!(!valid_image_path(&file));
    let _ = images; // images 目录一并随 root 清理
    fs::remove_dir_all(root).ok();
}

#[test]
fn valid_image_path_rejects_missing_file() {
    let (root, images) = temp_images_dir("valid_missing");
    let file = images.join("ghost.png");
    assert!(!valid_image_path(&file)); // 目录名对但文件不存在
    fs::remove_dir_all(root).ok();
}

// ---------- save / read / delete 核心逻辑（目录级回环） ----------

#[test]
fn save_roundtrip_and_dedup() {
    let (root, images) = temp_images_dir("roundtrip");
    // "hello" 的 PNG 假图（内容任意，解码即可）
    let data_url = "data:image/png;base64,aGVsbG8=";
    let ref1 = save_to_dir(&images, data_url).expect("保存应成功");
    assert!(ref1.starts_with("imgfile:"));
    let name = ref1.trim_start_matches("imgfile:").to_string();
    assert_eq!(name.len(), "0123456789abcdef.png".len()); // 16 hex + .png
    // 同内容再次保存 → 同引用（内容寻址去重）
    let ref2 = save_to_dir(&images, data_url).expect("二次保存应成功");
    assert_eq!(ref1, ref2);
    // 读取回环 → data URL 包含原 base64 真身
    let out = read_from_dir(&images, &name).expect("读取应成功");
    assert!(out.starts_with("data:image/png;base64,"));
    assert!(out.ends_with("aGVsbG8="));
    // 删除 → 幂等
    assert!(delete_from_dir(&images, &name));
    assert!(delete_from_dir(&images, &name)); // 不存在仍 true
    assert!(read_from_dir(&images, &name).is_none());
    fs::remove_dir_all(root).ok();
}

#[test]
fn save_rejects_oversize_and_empty() {
    let (root, images) = temp_images_dir("limits");
    // 空字节拒存
    assert!(save_to_dir(&images, "").is_none());
    // 超过 20MB 拒存（构造 20MB+1 字节的有效 base64）
    let big = vec![0u8; MAX_IMAGE_BYTES + 1];
    let b64 = base64::engine::general_purpose::STANDARD.encode(&big);
    assert!(save_to_dir(&images, &b64).is_none());
    fs::remove_dir_all(root).ok();
}

#[test]
fn read_rejects_traversal_names() {
    let (root, images) = temp_images_dir("traversal");
    assert!(read_from_dir(&images, "../secret.txt").is_none());
    assert!(read_from_dir(&images, "C:\\boot.png").is_none());
    assert!(delete_from_dir(&images, "../secret.txt") == false);
    fs::remove_dir_all(root).ok();
}

#[test]
fn save_rgba_to_dir_roundtrip_and_dedup() {
    let (root, images) = temp_images_dir("rgba");
    // 2×1 红蓝像素：RGBA → 落盘 → 读回 data URL 可解码出同尺寸 PNG
    let rgba = [255u8, 0, 0, 255, 0, 0, 255, 255];
    let ref1 = save_rgba_to_dir(&images, 2, 1, &rgba).expect("落盘应成功");
    assert!(ref1.starts_with("imgfile:"));
    let name = ref1.trim_start_matches("imgfile:").to_string();
    assert_eq!(name.len(), "0123456789abcdef.png".len());
    // 同像素再次落盘 → 同引用（内容寻址去重）
    assert_eq!(ref1, save_rgba_to_dir(&images, 2, 1, &rgba).expect("二次落盘应成功"));
    // 读回字节是合法 PNG 且尺寸一致
    let out = read_from_dir(&images, &name).expect("读取应成功");
    let b64 = out.split_once("base64,").unwrap().1;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    let img = image::load_from_memory(&bytes).unwrap();
    assert_eq!((img.width(), img.height()), (2, 1));
    fs::remove_dir_all(root).ok();
}

// ---------- list / delete_batch（清理策略支撑） ----------

#[test]
fn list_from_dir_missing_returns_empty() {
    let root = std::env::temp_dir().join(format!(
        "s1d3_imgstore_list_missing_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    // 目录不存在：返回空而非报错（前端按"无文件可清理"处理）
    assert!(list_from_dir(&root).is_empty());
}

#[test]
fn list_and_delete_batch_roundtrip() {
    let (root, images) = temp_images_dir("list_batch");
    let ref_a = save_to_dir(&images, "data:image/png;base64,aGVsbG8=").unwrap();
    let ref_b = save_to_dir(&images, "data:image/png;base64,d29ybGQ=").unwrap();
    // 非png文件混入：不应进清单
    fs::write(images.join("note.txt"), b"txt").unwrap();

    let list = list_from_dir(&images);
    assert_eq!(list.len(), 2, "只应列出两个 png");
    let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&ref_a.trim_start_matches("imgfile:")));
    assert!(names.contains(&ref_b.trim_start_matches("imgfile:")));
    assert!(list.iter().all(|e| e.size > 0), "每个条目应带字节数");

    // 批量删除：真实文件 2 个 + 幂等命中 1 个（ghost 不存在视为已删除）= 3；
    // 非法文件名被消毒拒绝，不计入成功数也不报错
    let files = vec![
        ref_a.trim_start_matches("imgfile:").to_string(),
        ref_b.trim_start_matches("imgfile:").to_string(),
        "../evil.png".to_string(),
        "ghost.png".to_string(), // 幂等：不存在视为已删除，仍计数
    ];
    assert_eq!(delete_batch_from_dir(&images, &files), 3);
    assert!(list_from_dir(&images).is_empty());
    fs::remove_dir_all(root).ok();
}
