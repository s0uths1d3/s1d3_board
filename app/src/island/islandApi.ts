import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '~/utils/env';
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

/** 历史查询桥参数上限：limit 钳制上限 */
const HISTORY_LIMIT_MAX = 1000;

/**
 * 历史查询桥（主窗口挂载，GET /api/history 的 DB 执行端）：
 * Rust 收到查询后 emit island-history:query（requestId + 原始 query），此处查库并
 * invoke island_history_result 回传完整 JSON 信封（Rust 原样回包给调用方）。
 * 参数：limit（1..=1000，默认 100）/ kind（精确匹配）/ from&to（本地毫秒时间戳，
 * 含头不含尾，可单侧使用）。过滤在 SQL 侧执行（先 WHERE 后 LIMIT）。
 * 注意 Number(null) === 0，参数存在性必须用 get() 返回 null 判断，禁止直接 Number()。
 */
export async function setupIslandHistoryBridge(): Promise<void> {
    if (!isTauri()) return;
    await listen<{ requestId?: string; query?: string }>('island-history:query', async (ev) => {
        const requestId = ev.payload?.requestId;
        if (!requestId) return;
        let payload: string;
        try {
            const params = new URLSearchParams(ev.payload?.query ?? '');
            const limit = Math.min(HISTORY_LIMIT_MAX, Math.max(1, Math.floor(Number(params.get('limit')) || 100)));
            const numOrNull = (key: string): number | undefined => {
                const raw = params.get(key);
                if (raw === null || raw.trim() === '') return undefined;
                const n = Number(raw);
                return Number.isFinite(n) ? n : undefined;
            };
            const rows = await dbService.getIslandHistory(limit, {
                kind: params.get('kind') ?? undefined,
                from: numOrNull('from'),
                to: numOrNull('to'),
            });
            payload = JSON.stringify({ ok: true, data: { count: rows.length, items: rows } });
        } catch (e) {
            payload = JSON.stringify({ ok: false, error: { code: 'history_error', message: String(e).slice(0, 200) } });
        }
        await invoke('island_history_result', { requestId, payload }).catch(() => {});
    }).catch(() => {});
}
