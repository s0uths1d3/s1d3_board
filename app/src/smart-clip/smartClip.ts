import type { ClipExtractor, ClipScheme } from '../entities';
import type { CopyEventDetail, ProcessContext, Segment, SmartClipEntry, SmartClipMode } from './types';
import { bus } from '../core/events';
import { runScheme, renderSchemeBody } from './template';
import { autoSplit } from './autoSplit';
import { readStoredExtractors } from './extractors';
import dbService from '../db/dbService';

/**
 * 智能剪贴板处理层（设计文档 §2 / §4.1）
 *
 * 数据流：dbService 新文本入库广播 'smart-clip:copy' → processByMode 解析 → 内存 store
 * （气泡窗口只读 store，不感知解析细节）。
 *
 * 配置快照：设置页变更时调用 updateSmartClipConfig 推送（避免每次解析查库）；
 * 启动竞态（快照未就绪）时 resolveContext 按需从 settings 兜底拉取一次。
 */

/** 内存 store 容量上限（气泡窗口只消费最近 N 条） */
const MAX_ENTRIES = 30;

const entries: SmartClipEntry[] = [];

let mode: SmartClipMode = 'on';
let activeScheme: ClipScheme | null = null;
let activeExtractors: ClipExtractor[] = [];
let configReady = false;
/** 配置快照版本号：每次配置变更递增，用于判定已有解析结果是否过期（需重解析） */
let configVersion = 0;

/** 设置页 / 启动时推送配置快照（高内聚：调用方无需感知内部缓存形态） */
export function updateSmartClipConfig(cfg: {
    mode: SmartClipMode;
    scheme: ClipScheme | null;
    extractors: ClipExtractor[];
}): void {
    mode = cfg.mode;
    activeScheme = cfg.scheme;
    activeExtractors = cfg.extractors;
    configReady = true;
    // 方案/提取器变化后旧解析结果不再可信：递增版本号，Ctrl+B 等按需解析会重跑管道
    configVersion += 1;
}

/** 处理管道统一入口：off 直通单段原文 / on 单一管线（默认方案叠加在智能切分之上） */
async function processContent(content: string, ctx: ProcessContext, onSoftError?: (e: unknown) => void): Promise<Segment[]> {
    if (ctx.mode === 'off') return single(content, 'rule');

    // 有启用中的默认方案 → 执行方案（成员为空 = 全部提取器；非空 = 指定子集）+ 可选 body 排版；
    // 无方案 → 直接智能切分。方案零产出、仅产出「原文整段」（提取器实际没切分任何东西：
    // 如单行内容过换行分隔提取器，split 后仍是整段）或执行失败时，一律降级为智能切分，
    // 保证数据不丢；降级同时经 onSoftError 把错误暴露给调用方（Ctrl+B 弹岛提示失败原因）。
    if (ctx.scheme && ctx.scheme.enabled === 1) {
        try {
            const segs = await runScheme(ctx.scheme, ctx.extractors, content);
            if (segs.length === 0 || isUnsplitPassThrough(segs, content)) return autoSplit(content);
            return renderSchemeBody(ctx.scheme, content, segs);
        } catch (e) {
            console.error('[smart-clip] 方案加工失败，降级为智能切分:', e);
            onSoftError?.(e);
            return autoSplit(content);
        }
    }
    return autoSplit(content);
}

/** 方案产出是否只是「原文整段直通」：单段且与原文空白归一化后相同 = 无有效加工 */
function isUnsplitPassThrough(segs: Segment[], content: string): boolean {
    if (segs.length !== 1) return false;
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    return norm(segs[0]?.text ?? '') === norm(content);
}

function single(content: string, source: Segment['source']): Segment[] {
    return [{ index: 0, text: content, source }];
}

/** 配置快照未就绪时的兜底：从 settings 按需拉取一次（此后以推送为准） */
async function resolveContext(): Promise<ProcessContext> {
    if (configReady) return { mode, scheme: activeScheme, extractors: activeExtractors };
    try {
        const [m, schemeId, legacySchemeId, schemes] = await Promise.all([
            dbService.getKeyValue('smart_clip_mode'),
            dbService.getKeyValue('smart_default_scheme_id'),
            dbService.getKeyValue('smart_default_template_id'),
            dbService.fetchClipSchemes(),
        ]);
        // 旧值 'auto'/'scheme'/'ai' 及已移除的 'rule'、未知值统一归一为 'on'（单一管线）
        mode = m === 'off' ? 'off' : 'on';
        const schemeIdStr = (typeof schemeId === 'string' && schemeId) ? schemeId : (typeof legacySchemeId === 'string' ? legacySchemeId : '');
        activeScheme = schemes.find((t) => t.id === schemeIdStr && t.enabled === 1) ?? null;
        activeExtractors = await readStoredExtractors();
        configReady = true;
    } catch (e) {
        console.error('[smart-clip] 处理配置恢复失败，按关闭模式处理:', e);
    }
    return { mode, scheme: activeScheme, extractors: activeExtractors };
}

/** 同 id 覆盖 + 新条目置顶 + 容量截断 */
function pushEntry(entry: SmartClipEntry): void {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries.splice(i, 1);
    entries.unshift(entry);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

/** 气泡窗口消费：最近解析结果（副本，防外部误改内部状态） */
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
}

/**
 * 按需解析指定剪贴板条目（Ctrl+B 气泡窗口对「当前选中项」调用）。
 *
 * - 命中缓存（同 id、同内容、且规则/模板配置未变）直接复用，避免重复调用 AI；
 * - 否则走与复制事件一致的处理管道（off 直通 / on 单一管线：方案叠加在智能切分之上），结果写入内存 store。
 */
export async function parseClipItem(
    id: number,
    content: string,
    ts: number,
    /** 降级软错误回调（AI 提取失败等，管道仍返回降级结果）；Ctrl+B 用它弹岛提示失败原因 */
    onSoftError?: (e: unknown) => void,
): Promise<SmartClipEntry> {
    const cached = entries.find((e) => e.id === id && e.content === content && e.configVersion === configVersion);
    if (cached) return cached;
    const ctx = await resolveContext();
    let softError: unknown;
    const segments = await processContent(content, ctx, (e) => {
        softError = e;
        onSoftError?.(e);
    });
    const entry: SmartClipEntry = { id, content, segments, ts, configVersion };
    // 失败降级结果不缓存：AI 失败（如模型名配错）只影响本次，修复配置后下次调用真实重试 AI；
    // 若缓存降级结果，后续同内容永远命中缓存、不再调 AI，错误提示也无法复现。
    if (!softError) pushEntry(entry);
    return entry;
}

/** 初始化：挂载复制事件监听（同一窗口上下文投递；仅主窗口调用，见 app.vue） */
export function initSmartClipListener(): void {
    bus.on('smart-clip:copy', (detail) => {
        if (!detail || typeof detail.content !== 'string' || detail.content.length === 0) return;
        void handleCopyEvent(detail);
    });
}
