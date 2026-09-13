import { invoke } from '@tauri-apps/api/core';
import dbService from '../db/dbService';

/**
 * 开放 API 前端客户端（设计文档 §4.5）：
 * - applyOpenApi：设置变更时应用/重启/停止 Rust 侧 HTTP/SSE 服务
 * - restoreOpenApiSetting：应用启动时按持久化配置恢复
 * - broadcastCopy：复制事件推送（smartClip 处理层调用；服务未启用时 Rust 侧 no-op）
 */

export const OPEN_API_DEFAULT_PORT = 12935;

export async function applyOpenApi(enabled: boolean, port: number, token: string): Promise<void> {
    try {
        await invoke('open_api_apply', { enabled, port, token });
    } catch (e) {
        console.error('[open-api] 应用配置失败:', e);
    }
}

export async function restoreOpenApiSetting(): Promise<void> {
    try {
        const [enabled, port, token] = await Promise.all([
            dbService.getKeyValue('open_api_enabled'),
            dbService.getKeyValue('open_api_port'),
            dbService.getKeyValue('open_api_token'),
        ]);
        if (enabled === '1') {
            await applyOpenApi(true, Number(port) || OPEN_API_DEFAULT_PORT, token);
        }
    } catch { /* 非 Tauri 环境忽略 */ }
}

export async function broadcastCopy(
    content: string,
    segments: { index: number; text: string; source: string }[],
): Promise<void> {
    try {
        await invoke('open_api_broadcast_copy', {
            content,
            segments: segments.map((s) => ({ index: s.index, text: s.text, source: s.source })),
        });
    } catch { /* 服务未启用 / 非 Tauri 环境静默忽略 */ }
}
