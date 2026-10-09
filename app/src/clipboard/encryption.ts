import { invoke } from '@tauri-apps/api/core';

/**
 * 剪贴板条目字段级加密的前端薄封装：
 * 加解密全部在 Rust 侧完成（密钥存 OS 凭据库，永不进入 WebView），
 * 前端只搬运「明文 ↔ S1ENC1: 载荷」。载荷格式与加解密实现见
 * src-tauri/src/commands/secure.rs。
 */

/** 加密载荷前缀哨兵（版本 1，与 Rust PAYLOAD_PREFIX 一致） */
export const ENCRYPTED_PREFIX = 'S1ENC1:';

/** 内容是否为加密载荷（展示层据此渲染占位，不渲染密文） */
export function isEncryptedContent(content: string | null | undefined): boolean {
    return !!content && content.startsWith(ENCRYPTED_PREFIX);
}

/** 加密明文 → 载荷（失败抛出，调用方提示用户） */
export function encryptClipText(plaintext: string): Promise<string> {
    return invoke<string>('encrypt_clip_text', { plaintext });
}

/** 解密载荷 → 明文（密钥不符/载荷损坏抛出） */
export function decryptClipText(payload: string): Promise<string> {
    return invoke<string>('decrypt_clip_text', { payload });
}
