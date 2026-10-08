//! 自动备份文件存取（app_data/backups/）：
//! 前端每日首启导出数据包后调用 write_auto_backup 落盘；设置页恢复入口经
//! list/read/delete_auto_backup 管理备份。路径由 Rust 侧固定为 app_data/backups，
//! 文件名经白名单校验（字母数字/-/. 且 .json 结尾、禁 ..）防路径穿越。

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// 备份目录名（app_data/backups）
const BACKUP_DIR_NAME: &str = "backups";

/// 备份目录（不存在则创建）
fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位 app_data 失败: {e}"))?
        .join(BACKUP_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    Ok(dir)
}

/// 文件名白名单校验：防路径穿越与非法字符（目录由 Rust 侧固定，仅信任文件名本身）
fn validate_name(name: &str) -> Result<String, String> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && name.ends_with(".json")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.contains("..");
    if ok {
        Ok(name.to_string())
    } else {
        Err(format!("非法备份文件名: {name}"))
    }
}

/// 写入自动备份（原子写：临时文件 + rename；同名覆盖——当天重启动以最新内容覆盖，当日快照语义）
#[tauri::command]
pub fn write_auto_backup(app: tauri::AppHandle, name: String, contents: String) -> Result<(), String> {
    let file = backup_dir(&app)?.join(validate_name(&name)?);
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, contents).map_err(|e| format!("写入备份失败: {e}"))?;
    fs::rename(&tmp, &file).map_err(|e| format!("落盘备份失败: {e}"))?;
    Ok(())
}

/// 列出自动备份文件名（按文件名倒序 = 日期倒序；仅 .json 文件）
#[tauri::command]
pub fn list_auto_backups(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = backup_dir(&app)?;
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| format!("读取备份目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".json") && !n.ends_with(".json.tmp"))
        .collect();
    names.sort();
    names.reverse();
    Ok(names)
}

/// 读取自动备份内容（设置页恢复入口；替换式导入由前端 importData 完成）
#[tauri::command]
pub fn read_auto_backup(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let file = backup_dir(&app)?.join(validate_name(&name)?);
    fs::read_to_string(&file).map_err(|e| format!("读取备份失败: {e}"))
}

/// 删除自动备份（前端按保留份数裁剪多余文件时逐个调用）
#[tauri::command]
pub fn delete_auto_backup(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let file = backup_dir(&app)?.join(validate_name(&name)?);
    fs::remove_file(&file).map_err(|e| format!("删除备份失败: {e}"))
}
