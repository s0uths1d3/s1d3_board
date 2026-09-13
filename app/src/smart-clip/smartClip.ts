import type { ClipExtractor, ClipRule, ClipScheme } from '../entities';
import type { CopyEventDetail, ProcessContext, Segment, SmartClipEntry, SmartClipMode } from './types';
import { parseByRule } from './ruleEngine';
import { runScheme, renderSchemeBody, renderAiDirect } from './template';
import { broadcastCopy } from './openApi';
import { readStoredExtractors } from './extractors';
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
let activeScheme: ClipScheme | null = null;
let activeExtractors: ClipExtractor[] = [];
let configReady = false;
/** 配置快照版本号：每次配置变更递增，用于判定已有解析结果是否过期（需重解析） */
let configVersion = 0;

/** 设置页 / 启动时推送配置快照（高内聚：调用方无需感知内部缓存形态） */
export function updateSmartClipConfig(cfg: {
    mode: SmartClipMode;
    rule: ClipRule | null;
    scheme: ClipScheme | null;
    extractors: ClipExtractor[];
}): void {
    mode = cfg.mode;
    activeRule = cfg.rule;
    activeScheme = cfg.scheme;
    activeExtractors = cfg.extractors;
    configReady = true;
    // 规则/方案/提取器变化后旧解析结果不再可信：递增版本号，Ctrl+B 等按需解析会重跑管道
    configVersion += 1;
}

/** 处理管道统一入口（设计文档 §2）：off 直通单段 / rule 规则拆分 / ai 方案（多提取器集成） */
async function processContent(content: string, ctx: ProcessContext): Promise<Segment[]> {
    if (ctx.mode === 'off') return single(content, 'rule');

    const ruleSegs = ctx.rule ? parseByRule(content, ctx.rule) : single(content, 'rule');
    if (ctx.mode === 'rule') return ruleSegs;

    // ai 模式：执行默认方案（按成员提取器顺序合并片段 + 可选 body 排版）；
    // 无方案时按默认指令直接 AI 加工。失败一律降级为规则片段，保证数据不丢。
    try {
        if (ctx.scheme && ctx.scheme.enabled === 1) {
            const segs = await runScheme(ctx.scheme, ctx.extractors, content);
            if (segs.length === 0) return ruleSegs;
            return renderSchemeBody(ctx.scheme, content, segs);
        }
        return await renderAiDirect(content);
    } catch (e) {
        console.error('[smart-clip] 方案/AI 加工失败，降级为规则片段:', e);
        return ruleSegs;
    }
}

function single(content: string, source: Segment['source']): Segment[] {
    return [{ index: 0, text: content, source }];
}

/** 配置快照未就绪时的兜底：从 settings 按需拉取一次（此后以推送为准） */
async function resolveContext(): Promise<ProcessContext> {
    if (configReady) return { mode, rule: activeRule, scheme: activeScheme, extractors: activeExtractors };
    try {
        const [m, ruleId, schemeId, legacySchemeId, rules, schemes] = await Promise.all([
            dbService.getKeyValue('smart_clip_mode'),
            dbService.getKeyValue('smart_default_rule_id'),
            dbService.getKeyValue('smart_default_scheme_id'),
            dbService.getKeyValue('smart_default_template_id'),
            dbService.fetchClipRules(),
            dbService.fetchClipSchemes(),
        ]);
        mode = (['off', 'rule', 'ai'] as const).includes(m as SmartClipMode) ? (m as SmartClipMode) : 'off';
        const ruleIdStr = typeof ruleId === 'string' ? ruleId : '';
        const schemeIdStr = (typeof schemeId === 'string' && schemeId) ? schemeId : (typeof legacySchemeId === 'string' ? legacySchemeId : '');
        activeRule = rules.find((r) => r.id === ruleIdStr && r.enabled === 1) ?? null;
        activeScheme = schemes.find((t) => t.id === schemeIdStr && t.enabled === 1) ?? null;
        activeExtractors = await readStoredExtractors();
        configReady = true;
    } catch (e) {
        console.error('[smart-clip] 处理配置恢复失败，按关闭模式处理:', e);
    }
    return { mode, rule: activeRule, scheme: activeScheme, extractors: activeExtractors };
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
    pushEntry({ id: detail.id, content: detail.content, segments, ts: detail.ts, configVersion });
    // 开放 API：复制成功事件推送给外部订阅者（SSE；服务未启用时 Rust 侧 no-op）
    void broadcastCopy(detail.content, segments);
}

/**
 * 按需解析指定剪贴板条目（Ctrl+B 气泡窗口对「当前选中项」调用）。
 *
 * - 命中缓存（同 id、同内容、且规则/模板配置未变）直接复用，避免重复调用 AI；
 * - 否则走与复制事件一致的处理管道（off 直通 / rule 规则 / ai 模板+AI），结果写入内存 store；
 * - 不广播开放 API 复制事件：这不是一次新的复制，避免订阅方收到重复推送。
 */
export async function parseClipItem(id: number, content: string, ts: number): Promise<SmartClipEntry> {
    const cached = entries.find((e) => e.id === id && e.content === content && e.configVersion === configVersion);
    if (cached) return cached;
    const ctx = await resolveContext();
    const segments = await processContent(content, ctx);
    const entry: SmartClipEntry = { id, content, segments, ts, configVersion };
    pushEntry(entry);
    return entry;
}

/** 初始化：挂载复制事件监听（同一窗口上下文投递；仅主窗口调用，见 app.vue） */
export function initSmartClipListener(): void {
    window.addEventListener(COPY_EVENT, (ev) => {
        const detail = (ev as CustomEvent<CopyEventDetail>).detail;
        if (!detail || typeof detail.content !== 'string' || detail.content.length === 0) return;
        void handleCopyEvent(detail);
    });
}
