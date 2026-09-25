//! 剪贴板图片文件存储：原图不进 SQLite——base64 直接落库有 ~33% 体积膨胀，
//! 且 SELECT * 全量拉取时把所有原图读进内存拖垮列表查询（调研 CopyQ/Ditto/PasteBar/
//! Gwen 的共识做法：图片存文件系统，DB 只存引用）。
//! 落盘 %APPDATA%/S1d3Board/images/<sha256 前 16 hex>.png，DB content 存 `imgfile:<文件名>`。
//! 内容 hash 命名天然去重：重复复制同一张图只占一份磁盘；DB 侧同 content 走
//! saveClipboard 的 ON CONFLICT 合并计数。文件名来自内容 hash，读取/删除命令
//! 严格校验纯文件名（防路径穿越）。
//!
//! 核心读写删逻辑抽为以目录为参数的内部函数（可测），
//! `FsImageStore` 实现 traits::ImageStore 抽象（lib.rs 装配注入 managed state），
//! 三个 #[tauri::command] 仅做 State 解析后委托，前端 invoke 签名不变。

use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::core::traits::{ImageStore, ImageStoreHandle};

/// 单张图片存盘上限（base64 解码后字节数）：CopyQ 默认单条 10MB、Ditto 可设单条上限，
/// 均为防极端膨胀；4K 截图 PNG 通常 1~8MB，20MB 足够覆盖正常场景，超限拒存（条目仍建，
/// 缩略图可见，粘贴回落系统剪贴板现内容）。
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// images 目录：%APPDATA%/S1d3Board/images（与其他数据同根，备份/迁移随目录整体走）
fn images_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?.join("images");
    if !dir.exists() {
        fs::create_dir_all(&dir).ok()?;
    }
    Some(dir)
}

/// 从 data URL / 裸 base64 解出图片字节（与 clipboard_thumb 的嗅探语义一致：
/// 按 base64, 分段取真身，前缀不影响）
fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let b64 = data_url
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()
}

/// 文件名合法性：只允许纯文件名（hash.png），拒绝任何路径成分（防 ../、绝对路径穿越）
fn sanitize_file_name(file: &str) -> Option<&str> {
    let f = file.trim();
    if f.is_empty()
        || f.contains('/')
        || f.contains('\\')
        || f.contains("..")
        || f.contains(':')
    {
        return None;
    }
    Some(f)
}

/// 路径双保险：文件名已消毒，再确认父目录确为 images 目录（防符号链接等绕过）
fn valid_image_path(path: &Path) -> bool {
    path.parent()
        .map(|p| p.file_name().map(|n| n == "images").unwrap_or(false))
        .unwrap_or(false)
        && path.is_file()
}

// ===================== 核心逻辑（以目录为参数，可测） =====================

/// 保存核心：解码 → sha256 内容寻址命名 → 写盘（已存在直接复用，天然去重）。
/// 返回 `imgfile:<文件名>` 引用（DB content 直接存此值）；解码失败/超限/写盘失败返回 None。
fn save_to_dir(dir: &Path, data_url: &str) -> Option<String> {
    let bytes = decode_data_url(data_url)?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = format!("{:x}", hasher.finalize());
    // 取 hash 前 16 hex 字符：内容寻址天然去重，碰撞概率对去重场景可忽略
    let name = format!("{}.png", &hex[..16]);
    let path = dir.join(&name);
    if !path.exists() {
        fs::write(&path, &bytes).ok()?;
    }
    Some(format!("imgfile:{}", name))
}

/// 读取核心：文件 → data URL。文件缺失/非法文件名/路径双保险不过返回 None。
fn read_from_dir(dir: &Path, file: &str) -> Option<String> {
    let name = sanitize_file_name(file)?;
    let path: PathBuf = dir.join(name);
    if !valid_image_path(&path) {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// RGBA 像素直接落盘核心：PNG 编码 → sha256 内容寻址 → 写盘，返回 `imgfile:` 引用。
/// clipboard_capture_image 快速通道用：剪贴板位图在 Rust 侧一步落盘，
/// 原图字节不经前端 IPC 往返（旧链路多 MB base64 来回搬运是截图延迟入列主因）。
pub(crate) fn save_rgba_to_dir(dir: &Path, w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())?;
    let mut png = Cursor::new(Vec::new());
    image::DynamicImage::from(img)
        .write_to(&mut png, image::ImageFormat::Png)
        .ok()?;
    let bytes = png.into_inner();
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = format!("{:x}", hasher.finalize());
    // 取 hash 前 16 hex 字符：与 save_to_dir 同规则，同内容天然去重
    let name = format!("{}.png", &hex[..16]);
    let path = dir.join(&name);
    if !path.exists() {
        fs::write(&path, &bytes).ok()?;
    }
    Some(format!("imgfile:{}", name))
}

/// RGBA 像素直接落盘（以 AppHandle 解析 images 目录后委托 save_rgba_to_dir）
pub(crate) fn save_rgba_image(app: &AppHandle, w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    images_dir(app).and_then(|dir| save_rgba_to_dir(&dir, w, h, rgba))
}

/// 删除核心：文件不存在视为已删除（幂等 true）；删除失败返回 false（不致命，调用方仅记日志）。
fn delete_from_dir(dir: &Path, file: &str) -> bool {
    match sanitize_file_name(file) {
        Some(name) => match fs::remove_file(dir.join(name)) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        },
        None => false,
    }
}

// ===================== trait 实现（lib.rs 装配注入） =====================

/// traits::ImageStore 的文件系统实现：按 AppHandle 解析 images 目录后委托核心逻辑
pub(crate) struct FsImageStore {
    app: AppHandle,
}

impl FsImageStore {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl ImageStore for FsImageStore {
    fn save(&self, data_url: &str) -> Option<String> {
        images_dir(&self.app).and_then(|dir| save_to_dir(&dir, data_url))
    }

    fn read(&self, file: &str) -> Option<String> {
        images_dir(&self.app).and_then(|dir| read_from_dir(&dir, file))
    }

    fn delete(&self, file: &str) -> bool {
        match images_dir(&self.app) {
            Some(dir) => delete_from_dir(&dir, file),
            None => false,
        }
    }
}

// ===================== Tauri 命令（State 注入，前端 invoke 签名不变） =====================

/// 保存图片：解码 → sha256 内容寻址命名 → 写盘（已存在直接复用，天然去重）。
/// 返回 `imgfile:<文件名>` 引用（DB content 直接存此值）；解码失败/超限返回 None。
#[tauri::command]
pub fn save_clipboard_image(
    store: tauri::State<'_, ImageStoreHandle>,
    data_url: String,
) -> Option<String> {
    store.0.save(&data_url)
}

/// 读取图片 → data URL（粘贴历史图片写剪贴板、查看器显示原图用）。
/// 文件缺失/非法文件名返回 None。
#[tauri::command]
pub fn read_clipboard_image_file(
    store: tauri::State<'_, ImageStoreHandle>,
    file: String,
) -> Option<String> {
    store.0.read(&file)
}

/// 批量读取图片 → data URL 列表（与入参顺序一一对应，读不到的槽位为 null）。
/// 列表一次刷新含整页图片：单条命令逐图 IPC 往返开销可观，批量一次往返拉全；
/// async 定义使其离开主线程执行（Tauri 约束：async 命令持有 State 须返回 Result），
/// 大图磁盘读 + base64 编码不再阻塞事件循环。
#[tauri::command]
pub async fn read_clipboard_image_files(
    store: tauri::State<'_, ImageStoreHandle>,
    files: Vec<String>,
) -> Result<Vec<Option<String>>, ()> {
    Ok(files.iter().map(|f| store.0.read(f)).collect())
}

/// 删除图片文件（条目删除/裁剪联动清理，防孤儿文件堆积）。
/// 文件不存在视为已删除（幂等 true）；删除失败返回 false（不致命，调用方仅记日志）。
#[tauri::command]
pub fn delete_clipboard_image_file(
    store: tauri::State<'_, ImageStoreHandle>,
    file: String,
) -> bool {
    store.0.delete(&file)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

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
}
