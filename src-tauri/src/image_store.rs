//! 剪贴板图片文件存储：原图不进 SQLite——base64 直接落库有 ~33% 体积膨胀，
//! 且 SELECT * 全量拉取时把所有原图读进内存拖垮列表查询（调研 CopyQ/Ditto/PasteBar/
//! Gwen 的共识做法：图片存文件系统，DB 只存引用）。
//! 落盘 %APPDATA%/S1d3Board/images/<sha256 前 16 hex>.png，DB content 存 `imgfile:<文件名>`。
//! 内容 hash 命名天然去重：重复复制同一张图只占一份磁盘；DB 侧同 content 走
//! saveClipboard 的 ON CONFLICT 合并计数。文件名来自内容 hash，读取/删除命令
//! 严格校验纯文件名（防路径穿越）。

use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

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

/// 保存图片：解码 → sha256 内容寻址命名 → 写盘（已存在直接复用，天然去重）。
/// 返回 `imgfile:<文件名>` 引用（DB content 直接存此值）；解码失败/超限返回 None。
#[tauri::command]
pub fn save_clipboard_image(app: AppHandle, data_url: String) -> Option<String> {
    let bytes = decode_data_url(&data_url)?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = format!("{:x}", hasher.finalize());
    // 取 hash 前 16 hex 字符：内容寻址天然去重，碰撞概率对去重场景可忽略
    let name = format!("{}.png", &hex[..16]);
    let dir = images_dir(&app)?;
    let path = dir.join(&name);
    if !path.exists() {
        fs::write(&path, &bytes).ok()?;
    }
    Some(format!("imgfile:{}", name))
}

/// 读取图片 → data URL（粘贴历史图片写剪贴板、查看器显示原图用）。
/// 文件缺失/非法文件名返回 None。
#[tauri::command]
pub fn read_clipboard_image_file(app: AppHandle, file: String) -> Option<String> {
    use base64::Engine as _;
    let name = sanitize_file_name(&file)?;
    let dir = images_dir(&app)?;
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

/// 删除图片文件（条目删除/裁剪联动清理，防孤儿文件堆积）。
/// 文件不存在视为已删除（幂等 true）；删除失败返回 false（不致命，调用方仅记日志）。
#[tauri::command]
pub fn delete_clipboard_image_file(app: AppHandle, file: String) -> bool {
    match sanitize_file_name(&file) {
        Some(name) => match images_dir(&app) {
            Some(dir) => match fs::remove_file(dir.join(name)) {
                Ok(()) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(_) => false,
            },
            None => false,
        },
        None => false,
    }
}

/// 路径双保险：文件名已消毒，再确认父目录确为 images 目录（防符号链接等绕过）
fn valid_image_path(path: &Path) -> bool {
    path.parent()
        .map(|p| p.file_name().map(|n| n == "images").unwrap_or(false))
        .unwrap_or(false)
        && path.is_file()
}
