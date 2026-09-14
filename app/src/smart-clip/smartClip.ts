import type { ClipExtractor, ClipScheme } from '../entities';
import type { CopyEventDetail, ProcessContext, Segment, SmartClipEntry, SmartClipMode } from './types';
import { runScheme, renderSchemeBody } from './template';
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
/** 事件名：与 dbService.saveClipboard 的广播约定一致 */
const COPY_EVENT = 'smart-clip:copy';

const entries: SmartClipEntry[] = [];

let mode: SmartClipMode = 'off';
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

/** 处理管道统一入口：off 直通单段原文 / scheme 按默认方案加工 */
async function processContent(content: string, ctx: ProcessContext): Promise<Segment[]> {
    if (ctx.mode === 'off') return single(content, 'rule');

    // 方案模式：执行方案（成员为空 = 全部提取器；非空 = 指定子集）+ 可选 body 排版；
    // 未启用方案或无产出时退回原文单段。失败一律降级为原文，保证数据不丢。
    try {
        if (ctx.scheme && ctx.scheme.enabled === 1) {
            const segs = await runScheme(ctx.scheme, ctx.extractors, content);
            if (segs.length === 0) return single(content, 'rule');
            return renderSchemeBody(ctx.scheme, content, segs);
        }
        return single(content, 'rule');
    } catch (e) {
        console.error('[smart-clip] 方案加工失败，降级为原文单段:', e);
        return single(content, 'rule');
    }
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
        // 旧版本存的 'ai' 按 'scheme' 处理；已移除的 'rule' 无对应规则，按关闭处理
        mode = m === 'scheme' || m === 'ai' ? 'scheme' : 'off';
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
 * - 否则走与复制事件一致的处理管道（off 直通 / rule 规则 / ai 模板+AI），结果写入内存 store。
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
