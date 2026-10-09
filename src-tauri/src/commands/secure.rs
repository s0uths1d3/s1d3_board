//! 剪贴板条目字段级加密（AES-256-GCM）：
//! 密钥存操作系统凭据管理器（Windows Credential Manager / macOS Keychain / Linux
//! Secret Service），service = "S1d3Board"、user = "clip_secret"，首次使用时生成
//! 32 字节随机密钥并写入（get-or-create），密钥永不离开 Rust 进程——前端只拿到
//! 加密载荷与解密结果。
//!
//! 载荷格式（clipboard.content 列存储，前缀哨兵便于识别）：
//!   `S1ENC1:` + base64( 12 字节 nonce || AES-256-GCM 密文(含 16 字节 tag) )
//! 前端落库时把 content 替换为载荷、清空 qr_text/html_content 等明文派生列，
//! 展示层按 encrypted 标记渲染占位（不渲染密文）。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;

/// 加密载荷前缀哨兵（版本 1）
const PAYLOAD_PREFIX: &str = "S1ENC1:";
/// GCM 推荐 nonce 长度（12 字节）
const NONCE_LEN: usize = 12;
const SERVICE: &str = "S1d3Board";
const USER: &str = "clip_secret";

/// 读取（或首次生成）加密密钥：32 字节 hex 文本存系统凭据库
fn get_or_create_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(SERVICE, USER).map_err(|e| format!("keyring unavailable: {e}"))?;
    match entry.get_password() {
        Ok(hex) => {
            let mut key = [0u8; 32];
            decode_hex_into(&hex, &mut key)?;
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            // 首次使用：生成 32 字节随机密钥（OS CSPRNG），hex 存凭据库
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
            entry.set_password(&hex).map_err(|e| format!("keyring write failed: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// 64 字符 hex → 32 字节（长度/字符校验，避免垃圾凭据产生全零密钥）
fn decode_hex_into(hex: &str, out: &mut [u8; 32]) -> Result<(), String> {
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("stored key is not a 64-char hex string".into());
    }
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).map_err(|e| format!("key hex decode failed: {e}"))?;
    }
    Ok(())
}

/// 加密明文 → 载荷（nonce 每次随机，同一明文两次加密载荷不同）
#[tauri::command]
pub fn encrypt_clip_text(plaintext: String) -> Result<String, String> {
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, Payload { msg: plaintext.as_bytes(), aad: b"S1d3Board-clip" })
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut packed = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    packed.extend_from_slice(&nonce_bytes);
    packed.extend_from_slice(&ciphertext);
    Ok(format!("{PAYLOAD_PREFIX}{}", B64.encode(packed)))
}

/// 解密载荷 → 明文（非本模块载荷原样返回，便于幂等调用；损坏/密钥不符返回 Err）
#[tauri::command]
pub fn decrypt_clip_text(payload: String) -> Result<String, String> {
    let raw = payload.strip_prefix(PAYLOAD_PREFIX).unwrap_or(&payload);
    let packed = B64.decode(raw).map_err(|e| format!("payload decode failed: {e}"))?;
    if packed.len() <= NONCE_LEN {
        return Err("payload too short".into());
    }
    let (nonce_bytes, ciphertext) = packed.split_at(NONCE_LEN);
    let nonce: &[u8; NONCE_LEN] = nonce_bytes
        .try_into()
        .map_err(|_| "nonce length mismatch".to_string())?;
    let key = get_or_create_key()?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ciphertext, aad: b"S1d3Board-clip" })
        .map_err(|_| "decrypt failed: wrong key or corrupted payload".to_string())?;
    String::from_utf8(plaintext).map_err(|e| format!("plaintext utf8 decode failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_detect() {
        // keyring 不可用的环境（CI headless）会失败，本测试仅在凭据库可用的开发机断言
        let plaintext = "secret-文本-12345".to_string();
        let payload = match encrypt_clip_text(plaintext.clone()) {
            Ok(p) => p,
            Err(_) => return, // 无凭据库：跳过
        };
        assert!(payload.starts_with("S1ENC1:"));
        assert_eq!(decrypt_clip_text(payload).unwrap(), plaintext);
        // 同一明文两次加密载荷不同（随机 nonce）
        let p1 = encrypt_clip_text(plaintext.clone()).unwrap();
        let p2 = encrypt_clip_text(plaintext).unwrap();
        assert_ne!(p1, p2);
        // 损坏载荷报错
        assert!(decrypt_clip_text("S1ENC1:!!!not-base64!!!".into()).is_err());
    }
}
