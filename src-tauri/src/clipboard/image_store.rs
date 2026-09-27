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

use crate::core::traits::{ImageStore, ImageStoreHandle, ImageFileEntry};

/// 单张图片存盘上限（base64 解码后字节数）：CopyQ 默认单条 10MB、Ditto 可设单条上限，
/// 均为防极端膨胀；4K 截图 PNG 通常 1~8MB，20MB 足够覆盖正常场景，超限拒存（条目仍建，
/// 缩略图可见，粘贴回落系统剪贴板现内容）。
pub const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

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
pub fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let b64 = data_url
        .split_once("base64,")
        .map(|(_, b)| b)
        .unwrap_or(data_url);
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()
}

/// 文件名合法性：只允许纯文件名（hash.png），拒绝任何路径成分（防 ../、绝对路径穿越）
pub fn sanitize_file_name(file: &str) -> Option<&str> {
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
pub fn valid_image_path(path: &Path) -> bool {
    path.parent()
        .map(|p| p.file_name().map(|n| n == "images").unwrap_or(false))
        .unwrap_or(false)
        && path.is_file()
}

// ===================== 核心逻辑（以目录为参数，可测） =====================

/// 保存核心：解码 → sha256 内容寻址命名 → 写盘（已存在直接复用，天然去重）。
/// 返回 `imgfile:<文件名>` 引用（DB content 直接存此值）；解码失败/超限/写盘失败返回 None。
pub fn save_to_dir(dir: &Path, data_url: &str) -> Option<String> {
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
pub fn read_from_dir(dir: &Path, file: &str) -> Option<String> {
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
pub fn save_rgba_to_dir(dir: &Path, w: u32, h: u32, rgba: &[u8]) -> Option<String> {
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
pub fn delete_from_dir(dir: &Path, file: &str) -> bool {
    match sanitize_file_name(file) {
        Some(name) => match fs::remove_file(dir.join(name)) {
            Ok(()) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        },
        None => false,
    }
}

/// 列举核心：images 目录下全部 .png 文件（文件名 + 字节数）。
/// 目录缺失/读失败返回空（前端按"无文件可清理"处理）；非法 Unicode 文件名跳过。
pub fn list_from_dir(dir: &Path) -> Vec<ImageFileEntry> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 只认 .png（本模块唯一落盘格式）；扩展名比较按小写，防 .PNG 手工改名混入
        if path.extension().map(|e| !e.eq_ignore_ascii_case("png")).unwrap_or(true) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push(ImageFileEntry { name: name.to_string(), size: meta.len() });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 批量删除核心：逐个走 delete_from_dir（文件名消毒 + 幂等），返回成功删除个数。
/// 单个文件失败不中断批次（孤儿残留无害，下次清理重试）。
pub fn delete_batch_from_dir(dir: &Path, files: &[String]) -> usize {
    files.iter().filter(|f| delete_from_dir(dir, f)).count()
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

    fn list(&self) -> Vec<ImageFileEntry> {
        images_dir(&self.app).map(|dir| list_from_dir(&dir)).unwrap_or_default()
    }

    fn delete_batch(&self, files: &[String]) -> usize {
        match images_dir(&self.app) {
            Some(dir) => delete_batch_from_dir(&dir, files),
            None => 0,
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

/// 磁盘图片清单（清理策略输入）：images 目录全部 .png 的文件名 + 字节数。
/// 目录缺失/读失败返回空列表（前端按"无文件可清理"处理）。
#[tauri::command]
pub fn list_clipboard_image_files(store: tauri::State<'_, ImageStoreHandle>) -> Vec<ImageFileEntry> {
    store.0.list()
}

/// 批量删除图片文件（磁盘占用清理）：逐个消毒 + 幂等删除，
/// 返回成功删除个数；单个失败不中断批次（残留无害，下次清理重试）。
#[tauri::command]
pub fn delete_clipboard_image_files(
    store: tauri::State<'_, ImageStoreHandle>,
    files: Vec<String>,
) -> usize {
    store.0.delete_batch(&files)
}

