import type { ExtractRule } from '../entities';
import type { CopyEventDetail, ProcessContext, Segment, SmartClipEntry, SmartClipMode } from './types';
import { bus } from '../core/events';
import { splitByPipeline } from './pipeline';
import { loadExtractRules } from './extractors';
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
let activeRules: ExtractRule[] = [];
/** 本地切分开关（settings: local_split_enabled）；AI 关键字关闭时恒为 false（互斥约束） */
let splitEnabled = true;
let configReady = false;
/** 配置快照版本号：每次配置变更递增，用于判定已有解析结果是否过期（需重解析） */
let configVersion = 0;

/** 设置页 / 启动时推送配置快照（高内聚：调用方无需感知内部缓存形态） */
export function updateSmartClipConfig(cfg: {
    mode: SmartClipMode;
    rules: ExtractRule[];
    splitEnabled?: boolean;
}): void {
    mode = cfg.mode;
    activeRules = cfg.rules;
    // 未显式传入时沿用当前值（旧调用点兼容）
    splitEnabled = cfg.splitEnabled ?? splitEnabled;
    configReady = true;
    // 规则变化后旧解析结果不再可信：递增版本号，Ctrl+B 等按需解析会重跑管道
    configVersion += 1;
}

/** 处理管道统一入口：off / 本地切分关闭 → 直通单段原文；on → 单层切分管线 */
async function processContent(content: string, ctx: ProcessContext, onSoftError?: (e: unknown) => void): Promise<Segment[]> {
    if (ctx.mode === 'off' || !ctx.splitEnabled) return single(content, 'rule');
    try {
        return splitByPipeline(content, ctx.rules);
    } catch (e) {
        // 管线内部已逐层兜底，这里只兜「管线本身抛错」的极端情况：保内容不丢 + 暴露原因
        console.error('[smart-clip] 切分管线失败，降级为原文单段:', e);
        onSoftError?.(e);
        return single(content, 'rule');
    }
}

function single(content: string, source: Segment['source']): Segment[] {
    return [{ index: 0, text: content, source }];
}

/** 配置快照未就绪时的兜底：从 settings 按需拉取一次（此后以推送为准） */
async function resolveContext(): Promise<ProcessContext> {
    if (configReady) return { mode, rules: activeRules, splitEnabled };
    try {
        const [m, splitKV, keywordsKV, legacyKV, state] = await Promise.all([
            dbService.getKeyValue('smart_clip_mode'),
            dbService.getKeyValue('local_split_enabled'),
            dbService.getKeyValue('ai_keywords_enabled'),
            dbService.getKeyValue('ai_analysis_enabled'),
            loadExtractRules(),
        ]);
        // 旧值 'auto'/'scheme'/'ai' 及已移除的 'rule'、未知值统一归一为 'on'（单层管线）
        mode = m === 'off' ? 'off' : 'on';
        // 互斥约束：AI 关键字关闭时本地切分不得启用（缺省均视为开启；旧单开关显式关闭等同关键字关闭）
        const keywordsOn = keywordsKV === null && legacyKV === '0' ? false : keywordsKV !== '0';
        splitEnabled = keywordsOn && splitKV !== '0';
        activeRules = state.rules;
        configReady = true;
    } catch (e) {
        console.error('[smart-clip] 处理配置恢复失败，按关闭模式处理:', e);
    }
    return { mode, rules: activeRules, splitEnabled };
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
 * 按需解析指定内容（Ctrl+B 气泡窗口对「本次剪贴板内容」调用；id 固定传 0）。
 *
 * - 命中缓存（同 id、同内容、且规则配置未变）直接复用；
 * - 否则走与复制事件一致的处理管道（off 直通 / on 单层切分管线），结果写入内存 store。
 */
export async function parseClipItem(
    id: number,
    content: string,
    ts: number,
    /** 降级软错误回调（管线失败但已降级返回原文）；Ctrl+B 用它弹岛提示失败原因 */
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
