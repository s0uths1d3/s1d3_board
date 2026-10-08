import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '~/utils/env';
import dbService from '../db/dbService';
import { bus } from '../core/events';
import { useI18n } from '~/composables/useI18n';
import { notifyIsland } from '~/composables/useCopyIsland';

/**
 * 灵动岛 API 前端客户端（接入文档：`.docs/island-api.md`）：
 * - applyIslandApi：设置变更时应用/重启/停止 Rust 侧 HTTP/SSE 服务
 * - restoreIslandApiSetting：应用启动时按持久化配置恢复
 * 第三方显示请求由 Rust 侧直接 emit('island-api:show') → useCopyIsland 消费弹岛，不经过本模块。
 */

export const ISLAND_API_DEFAULT_PORT = 12935;

/**
 * 生成新访问令牌：32 字节 CSPRNG → 64 位 hex（crypto.getRandomValues，WebView 内置密码学安全
 * 随机源）。令牌运行时生成，源码中不存在可推导的默认值；64 hex = 256 bit 熵，防暴力枚举。
 */
export function generateIslandApiToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 确保访问令牌存在（强制鉴权：所有端点必须 Bearer token，Rust 侧空 token 拒绝启动）。
 * KV 为空（首次开启/升级前老配置）时自动生成并持久化；同一安装每用户一套令牌，
 * 重新生成走设置页（生成后由 watch 持久化并重启服务）。
 */
export async function ensureIslandApiToken(): Promise<string> {
    const existing = await dbService.getKeyValue('island_api_token');
    if (existing) return existing;
    const token = generateIslandApiToken();
    await dbService.setKeyValue('island_api_token', token);
    return token;
}

/** 最近一次 API 启动失败原因（进程内记忆）：设置页挂载时回填展示，成功应用后清除 */
let lastApiFailure = '';

export function lastIslandApiFailure(): string {
    return lastApiFailure;
}

export async function applyIslandApi(enabled: boolean, port: number, token: string): Promise<void> {
    try {
        await invoke('island_api_apply', { enabled, port, token });
        lastApiFailure = '';
    } catch (e) {
        // 典型失败：开启时 token 为空（v1.5.0 强制鉴权守卫）
        console.error('[island-api] 应用配置失败:', e);
        lastApiFailure = String(e);
    }
}

export async function restoreIslandApiSetting(): Promise<void> {
    try {
        const enabled = await dbService.getKeyValue('island_api_enabled');
        if (enabled === '1') {
            const port = await dbService.getKeyValue('island_api_port');
            // 令牌强制：老配置为空时自动生成并持久化后再启动服务
            const token = await ensureIslandApiToken();
            await applyIslandApi(true, Number(port) || ISLAND_API_DEFAULT_PORT, token);
        }
    } catch { /* 非 Tauri 环境忽略 */ }
}

/**
 * API 启动失败监听（常驻，主窗口）：Rust 服务线程绑定失败（端口占用等）或鉴权守卫
 * 拒绝启动时 emit island-api:failed（载荷为失败原因）。此处转发总线事件供设置页
 * 内联展示 + 弹岛提示（notifyIsland 内部检查灵动岛开关），并记忆原因供设置页
 * 稍后打开时回填（启动期失败发生在设置页挂载前，仅弹岛不足以让用户感知）。
 */
export async function setupIslandApiFailureListener(): Promise<void> {
    if (!isTauri()) return;
    await listen<string>('island-api:failed', (ev) => {
        const reason = typeof ev.payload === 'string' && ev.payload ? ev.payload : String(ev.payload ?? '');
        lastApiFailure = reason;
        bus.emit('island-api:failed', reason);
        const { t } = useI18n();
        notifyIsland({ kind: 'error', title: t('island_api.section'), text: t('island_api.failed', { reason }) });
    }).catch(() => { /* 监听注册失败静默：不影响主流程 */ });
}

/** macOS 粘贴感知权限缺失（Rust CGEventTap 创建失败）→ 弹岛引导用户授予辅助功能权限。
 * 仅 macOS 会触发该事件，其余平台监听注册后不会收到（注册本身无副作用） */
export async function setupPastePermissionListener(): Promise<void> {
    if (!isTauri()) return;
    await listen<void>('paste:permission-missing', () => {
        const { t } = useI18n();
        notifyIsland({
            kind: 'error',
            title: t('paste_permission.missing_title'),
            text: t('paste_permission.missing_text'),
        });
    }).catch(() => { /* 监听注册失败静默：不影响主流程 */ });
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
