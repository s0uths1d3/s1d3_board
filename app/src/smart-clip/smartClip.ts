import type { ClipRule, ClipTemplate } from '../entities';
import type { CopyEventDetail, ProcessContext, Segment, SmartClipEntry, SmartClipMode } from './types';
import { parseByRule } from './ruleEngine';
import { renderTemplate, renderAiDirect } from './template';
import { broadcastCopy } from './openApi';
import dbService from '../db/dbService';

/**
 * 智能剪贴板处理层（设计文档 §2 / §4.1）
 *
 * 数据流：dbService 新文本入库广播 'smart-clip:copy' → processByMode 解析 → 内存 store
 * （气泡窗口 / 开放 API 只读 store，不感知解析细节）。
 *
 * 配置快照：设置页变更时调用 updateSmartClipConfig 推送（避免每次解析查库）；
 * 启动竞态（快照未就绪）时 resolveContext 按需从 settings 兜底拉取一次。
 */

/** 内存 store 容量上限（气泡窗口只消费最近 N 条） */
const MAX_ENTRIES = 30;
/** 事件名：与 dbService.saveClipboard 的广播约定一致 */
const COPY_EVENT = 'smart-clip:copy';

const entries: SmartClipEntry[] = [];

let mode: SmartClipMode = 'off';
let activeRule: ClipRule | null = null;
let activeTemplate: ClipTemplate | null = null;
let configReady = false;

/** 设置页 / 启动时推送配置快照（高内聚：调用方无需感知内部缓存形态） */
export function updateSmartClipConfig(cfg: {
    mode: SmartClipMode;
    rule: ClipRule | null;
    template: ClipTemplate | null;
}): void {
    mode = cfg.mode;
    activeRule = cfg.rule;
    activeTemplate = cfg.template;
    configReady = true;
}

/** 处理管道统一入口（设计文档 §2）：off 直通单段 / rule 规则拆分 / ai 模板与 AI 加工 */
async function processContent(content: string, ctx: ProcessContext): Promise<Segment[]> {
    if (ctx.mode === 'off') return single(content, 'rule');

    const ruleSegs = ctx.rule ? parseByRule(content, ctx.rule) : single(content, 'rule');
    if (ctx.mode === 'rule') return ruleSegs;

    // ai 模式：优先默认模板（可含 {ai:指令} 与 {segN} 重组）；无模板时按默认指令直接 AI 加工。
    // AI 失败一律降级为规则片段，保证数据不丢。
    try {
        if (ctx.template && ctx.template.enabled === 1) {
            return await renderTemplate(ctx.template, content, ruleSegs);
        }
        return await renderAiDirect(content);
    } catch (e) {
        console.error('[smart-clip] AI 加工失败，降级为规则片段:', e);
        return ruleSegs;
    }
}

function single(content: string, source: Segment['source']): Segment[] {
    return [{ index: 0, text: content, source }];
}

/** 配置快照未就绪时的兜底：从 settings 按需拉取一次（此后以推送为准） */
async function resolveContext(): Promise<ProcessContext> {
    if (configReady) return { mode, rule: activeRule, template: activeTemplate };
    try {
        const [m, ruleId, templateId, rules, templates] = await Promise.all([
            dbService.getKeyValue('smart_clip_mode'),
            dbService.getKeyValue('smart_default_rule_id'),
            dbService.getKeyValue('smart_default_template_id'),
            dbService.fetchClipRules(),
            dbService.fetchClipTemplates(),
        ]);
        mode = (['off', 'rule', 'ai'] as const).includes(m as SmartClipMode) ? (m as SmartClipMode) : 'off';
        const ruleIdStr = typeof ruleId === 'string' ? ruleId : '';
        const templateIdStr = typeof templateId === 'string' ? templateId : '';
        activeRule = rules.find((r) => r.id === ruleIdStr && r.enabled === 1) ?? null;
        activeTemplate = templates.find((t) => t.id === templateIdStr && t.enabled === 1) ?? null;
        configReady = true;
    } catch (e) {
        console.error('[smart-clip] 处理配置恢复失败，按关闭模式处理:', e);
    }
    return { mode, rule: activeRule, template: activeTemplate };
}

/** 同 id 覆盖 + 新条目置顶 + 容量截断 */
function pushEntry(entry: SmartClipEntry): void {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries.splice(i, 1);
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

/** 气泡窗口 / 开放 API 消费：最近解析结果（副本，防外部误改内部状态） */
export function getSmartClipEntries(): SmartClipEntry[] {
    return [...entries];
}

export function getSmartClipEntry(id: number): SmartClipEntry | undefined {
    return entries.find((e) => e.id === id);
}

async function handleCopyEvent(detail: CopyEventDetail): Promise<void> {
    const ctx = await resolveContext();
    const segments = await processContent(detail.content, ctx);
    pushEntry({ id: detail.id, content: detail.content, segments, ts: detail.ts });
    // 开放 API：复制成功事件推送给外部订阅者（SSE；服务未启用时 Rust 侧 no-op）
    void broadcastCopy(detail.content, segments);
}

/** 初始化：挂载复制事件监听（同一窗口上下文投递；仅主窗口调用，见 app.vue） */
export function initSmartClipListener(): void {
    window.addEventListener(COPY_EVENT, (ev) => {
        const detail = (ev as CustomEvent<CopyEventDetail>).detail;
        if (!detail || typeof detail.content !== 'string' || detail.content.length === 0) return;
        void handleCopyEvent(detail);
    });
}
