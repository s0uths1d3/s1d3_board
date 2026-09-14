import { invoke } from '@tauri-apps/api/core';
import dbService from '../db/dbService';

/**
 * 灵动岛 API 前端客户端（接入文档：`.docs/island-api.md`）：
 * - applyIslandApi：设置变更时应用/重启/停止 Rust 侧 HTTP/SSE 服务
 * - restoreIslandApiSetting：应用启动时按持久化配置恢复
 * 第三方显示请求由 Rust 侧直接 emit('island-api:show') → useCopyIsland 消费弹岛，不经过本模块。
 */

export const ISLAND_API_DEFAULT_PORT = 12935;

export async function applyIslandApi(enabled: boolean, port: number, token: string): Promise<void> {
    try {
        await invoke('island_api_apply', { enabled, port, token });
    } catch (e) {
        console.error('[island-api] 应用配置失败:', e);
    }
}

export async function restoreIslandApiSetting(): Promise<void> {
    try {
        const [enabled, port, token] = await Promise.all([
            dbService.getKeyValue('island_api_enabled'),
            dbService.getKeyValue('island_api_port'),
            dbService.getKeyValue('island_api_token'),
        ]);
        if (enabled === '1') {
            await applyIslandApi(true, Number(port) || ISLAND_API_DEFAULT_PORT, token ?? '');
        }
    } catch { /* 非 Tauri 环境忽略 */ }
}
