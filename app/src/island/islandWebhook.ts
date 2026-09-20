import { invoke } from '@tauri-apps/api/core';
import dbService from '../db/dbService';

/**
 * 灵动岛 Webhook 出站推送前端客户端（文档：`.docs/island-api.md` §7）：
 * - applyIslandWebhook：配置变更时下发 Rust 侧（校验 + 替换内存态）
 * - testIslandWebhook：对全部启用目标各发一条测试消息（单次、3s 超时、不重试）
 * - restoreIslandWebhookSetting：应用启动时按持久化配置恢复
 * 事件源在 Rust 侧（island:show → dispatch），本模块仅负责配置与测试。
 */

export interface WebhookTarget {
    id: string;
    url: string;
    secret: string;
    /** 订阅事件类型；当前仅 "island.show"，字段为多事件预留 */
    events: string[];
    enabled: boolean;
}

export interface WebhookConfig {
    enabled: boolean;
    targets: WebhookTarget[];
}

export interface WebhookTestResult {
    id: string;
    ok: boolean;
    error: string;
}

const CONFIG_KEY = 'island_webhook_config';

/** URL 白名单前端预校验（与 Rust 侧 validate_url 同规则）：https 任意 / http 仅回环 */
export function validateWebhookUrl(url: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol === 'https:') return true;
        if (u.protocol === 'http:') {
            return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
        }
        return false;
    } catch {
        return false;
    }
}

export async function applyIslandWebhook(config: WebhookConfig): Promise<void> {
    try {
        await invoke('island_webhook_apply', { config: JSON.stringify(config) });
    } catch (e) {
        console.error('[island-webhook] 应用配置失败:', e);
    }
}

export async function testIslandWebhook(): Promise<WebhookTestResult[]> {
    return invoke<WebhookTestResult[]>('island_webhook_test');
}

export async function saveIslandWebhookConfig(config: WebhookConfig): Promise<void> {
    await dbService.setKeyValue(CONFIG_KEY, JSON.stringify(config));
    await applyIslandWebhook(config);
}

export async function loadIslandWebhookConfig(): Promise<WebhookConfig> {
    const raw = await dbService.getKeyValue(CONFIG_KEY);
    if (!raw) return { enabled: false, targets: [] };
    try {
        const parsed = JSON.parse(raw) as WebhookConfig;
        return {
            enabled: !!parsed.enabled,
            targets: (parsed.targets ?? []).map((t) => ({
                id: String(t.id ?? ''),
                url: String(t.url ?? ''),
                secret: String(t.secret ?? ''),
                events: Array.isArray(t.events) && t.events.length ? t.events : ['island.show'],
                enabled: t.enabled !== false,
            })),
        };
    } catch {
        return { enabled: false, targets: [] };
    }
}

export async function restoreIslandWebhookSetting(): Promise<void> {
    try {
        const config = await loadIslandWebhookConfig();
        if (config.enabled || config.targets.length) {
            await applyIslandWebhook(config);
        }
    } catch { /* 非 Tauri 环境忽略 */ }
}
