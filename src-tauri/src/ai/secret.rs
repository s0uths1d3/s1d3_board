//! AI API Key 系统凭据库存储：
//! Key 明文不再落 SQLite（settings 表全库可被任意进程/导出读取），改存操作系统凭据管理器
//! （Windows Credential Manager / macOS Keychain / Linux Secret Service）。
//! service = "S1d3Board"、user = "ai_api_key" 唯一命名空间；前端负责旧明文 KV 迁移与
//! 凭据库故障时的降级警示（Rust 不接触前端 KV）。

const SERVICE: &str = "S1d3Board";
const USER: &str = "ai_api_key";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, USER).map_err(|e| format!("keyring unavailable: {e}"))
}

/// 读取 API Key：未存储返回空串；凭据库故障返回 Err（前端据此降级读 KV 明文）
#[tauri::command]
pub fn ai_key_get() -> Result<String, String> {
    let entry = entry()?;
    match entry.get_password() {
        Ok(p) => Ok(p),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// 写入 API Key（key 为空 = 删除凭据，幂等：无凭据视为已删除）
#[tauri::command]
pub fn ai_key_set(key: String) -> Result<(), String> {
    let entry = entry()?;
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete failed: {e}")),
        }
    } else {
        entry.set_password(&key).map_err(|e| format!("keyring write failed: {e}"))
    }
}
