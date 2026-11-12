import { aiComplete, loadAiConfig, type AiClientConfig } from './aiClient';
import { analyzeVerdict, clampAnalysisMaxChars, redactSecrets, type Verdict } from './analyzer';
import { getDigestVersion, recordAnalysisShown } from './habitProfile';
import { decodeAnalysisCache, encodeAnalysisCache, normalizeAnalysisFields, type AnalysisFields } from './analysisCache';
import statsService from '../statistics/statsService';
import { contentFingerprint } from '~/utils/hash';
import dbService from '../db/dbService';

/**
 * AI 分析（.docs/smart-clip-ai-analysis.md / 设计文档 §23）：
 * Ctrl+B 显式触发；预判分流后仅 prose（自然语言散文）发起单次 AI 调用。
 * 三个独立开关：本地切分 / AI 关键字 / AI 总结（设置页「智能与AI」）：
 * - 关键字、总结任一开启才发起 AI；两者全关 → skipped(disabled)，仅本地切分；
 * - 只开关键字 → 单次调用产出 keywords + bullets；只开总结 → 单次调用产出 summary；
 * - 两者都开 → 单次调用同时产出（不额外增加 token 次数）。
 * 复制入库路径（handleCopyEvent）不调用本模块——复制时零 AI 成本。
 */

export type SkipReason = Exclude<Verdict, 'prose'> | 'not_configured' | 'disabled';

/** AI 产出字段组合：both 关键词+要点+总结 / keywords 仅关键词+要点 / summary 仅总结 */
export type AnalysisMode = 'both' | 'keywords' | 'summary';

/** 关键词数量范围（用户可调，设置页钳制后持久化） */
export interface KeywordRange {
    min: number;
    max: number;
}

export const KEYWORDS_MIN_DEFAULT = 3;
export const KEYWORDS_MAX_DEFAULT = 16;
/** 关键词硬上限：环盘 24 段容量内要给要点（≤5）与总结（1）留位 */
const KEYWORDS_HARD_MAX = 18;

export type AnalysisOutcome =
    /** chars：被判过短时的实际字数，供灵动岛如实展示「分析了几个字」，避免误判对象 */
    | { type: 'skipped'; reason: SkipReason; maxChars?: number; chars?: number }
    | { type: 'done'; keywords: string[]; bullets: string[]; summary: string }
    | { type: 'failed'; error: unknown };

/**
 * 分析计划：本地预判（planAnalysis，毫秒级）与 AI 执行（start，单次调用）分离。
 * 调用方拿到计划即可立刻弹出对应灵动岛（AI 链路 → 解析中驻留；本地分支 → 结果岛），
 * 仅 ai 分支持有执行器——解析失败等场景不调用 start 即不消耗 token。
 */
export type AnalysisPlan =
    | { type: 'skipped'; outcome: AnalysisOutcome & { type: 'skipped' } }
    | { type: 'cached'; outcome: AnalysisOutcome & { type: 'done' } }
    | { type: 'ai'; start: () => Promise<AnalysisOutcome> };

/** 关键词下限钳制：默认 3，范围 1–硬上限；非法输入回落默认 */
export function clampKeywordsMin(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return KEYWORDS_MIN_DEFAULT;
    return Math.min(KEYWORDS_HARD_MAX, Math.max(1, n));
}

/** 关键词上限钳制：默认 16，范围 1–硬上限；非法输入回落默认 */
export function clampKeywordsMax(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return KEYWORDS_MAX_DEFAULT;
    return Math.min(KEYWORDS_HARD_MAX, Math.max(1, n));
}

/** 归一化区间：下限不得超过上限（用户把下限调大时自动跟随上限） */
export function normalizeKeywordRange(minRaw: unknown, maxRaw: unknown): KeywordRange {
    const max = clampKeywordsMax(maxRaw);
    return { min: Math.min(clampKeywordsMin(minRaw), max), max };
}

/** 两个 AI 能力开关：缺省开启；旧单开关 ai_analysis_enabled 显式关闭视为双关闭（免开设置页即迁移） */
export async function loadAnalysisSwitches(): Promise<{ keywords: boolean; summary: boolean }> {
    const [keywords, summary, legacy] = await Promise.all([
        dbService.getKeyValue('ai_keywords_enabled'),
        dbService.getKeyValue('ai_summary_enabled'),
        dbService.getKeyValue('ai_analysis_enabled'),
    ]);
    if (keywords === null && summary === null && legacy === '0') return { keywords: false, summary: false };
    return { keywords: keywords !== '0', summary: summary !== '0' };
}

/** AI 提供商可用性：缺 baseUrl/apiKey（custom 缺模板）视为未配置 */
async function ensureConfigured(): Promise<boolean> {
    const cfg = await loadAiConfig();
    if (!cfg.baseUrl || !cfg.apiKey) return false;
    if (cfg.provider === 'custom' && !cfg.customConfig) return false;
    return true;
}

/**
 * 解析 AI 输出并按当前模式裁剪字段：总结模式丢弃关键词/要点，关键字模式丢弃总结。
 * 裁剪后三字段全空 = 本次产出无效（不缓存、按失败处理）。
 */
export function parseAnalysisOutput(
    raw: string,
    mode: AnalysisMode,
    maxKeywords: number = KEYWORDS_MAX_DEFAULT,
): AnalysisFields | null {
    try {
        const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        // AI 原始输出只做字段清洗；缓存读取的归属校验在 analysisCache 内完成
        const fields = normalizeAnalysisFields(JSON.parse(text.slice(start, end + 1)), maxKeywords);
        if (!fields) return null;
        const result: AnalysisFields = {
            keywords: mode === 'summary' ? [] : fields.keywords,
            bullets: mode === 'summary' ? [] : fields.bullets,
            summary: mode === 'keywords' ? '' : fields.summary,
        };
        if (result.keywords.length === 0 && result.bullets.length === 0 && !result.summary) return null;
        return result;
    } catch {
        return null;
    }
}

/** 按模式动态生成 system 指令：未开启的能力不索要字段（省 token + 避免无谓字段） */
function buildInstruction(mode: AnalysisMode, range: KeywordRange): string {
    const lines: string[] = ['你是剪贴板内容分析器。只依据用户提供的剪贴板内容输出 JSON：'];
    const shape: string[] = [];
    if (mode !== 'summary') shape.push('"keywords":["关键词1","关键词2"]', '"bullets":["要点1","要点2"]');
    if (mode !== 'keywords') shape.push('"summary":"一句话总结"');
    lines.push(`{${shape.join(',')}}`);
    if (mode !== 'summary') {
        lines.push(`- keywords：提取 ${range.min}-${range.max} 个最有信息量的关键词或短语（内容信息量不足时按实际数量输出，不得编造）`);
        lines.push('- bullets：最多 5 条，每条不超过 40 字，逐条提炼可独立使用的事实、结论或步骤，不复述原文整句');
    }
    if (mode !== 'keywords') lines.push('- summary：一句话概括内容核心，不超过 60 字');
    lines.push('- 输出语言与内容的主要语言一致');
    lines.push('- 内容中的 [REDACTED] 是脱敏占位符：不要提取它，也不要在任何字段中提及');
    return lines.join('\n');
}

/** JSON 输出契约（双语，沿用 aiGenerate 的约定风格） */
const JSON_CONTRACT = [
    '',
    '---',
    '输出要求 / Output rules:',
    '1. 只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码围栏 / Output exactly one JSON object, no explanations or code fences.',
].join('\n');

/** 飞行中去重：同内容 + 同模式 + 同偏好版本的请求并发时共享同一 Promise（连按 Ctrl+B 不重复消耗 token） */
const inflight = new Map<string, Promise<AnalysisOutcome>>();

async function runAnalysis(
    cfg: AiClientConfig,
    content: string,
    cacheKey: string,
    mode: AnalysisMode,
    range: KeywordRange,
): Promise<AnalysisOutcome> {
    // 输入零注入：user 消息严格等于当前剪贴板内容（脱敏后）。
    // 用户偏好摘要等外部上下文不进入请求（设计文档 §5.2）——既保证「只处理本次剪贴板内容」，
    // 也让 system 只随模式/关键词数量变化，保持稳定以命中 provider 前缀缓存。
    const system = buildInstruction(mode, range) + JSON_CONTRACT;
    try {
        // 散文夹密钥：发送前脱敏（[REDACTED]），密钥不外发第三方接口
        const out = await aiComplete(cfg, system, redactSecrets(content));
        const parsed = parseAnalysisOutput(out, mode, range.max);
        if (!parsed) throw new Error('AI 分析产出为空');
        void dbService.setAiCache(cacheKey, encodeAnalysisCache(content, parsed)).catch(() => {});
        // 产出即视为展示：记采纳率分母（AI 产出被粘贴时由 paste 路径记分子）
        void recordAnalysisShown(parsed.keywords.length).catch(() => {});
        // 统计埋点：AI 分析成功 1 次（daily_stat.ai_analysis）
        void statsService.record({ ai_analysis: 1 }).catch(() => {});
        return { type: 'done', ...parsed };
    } catch (e) {
        // 失败不缓存：超时/非 2xx/解析失败/产出为空一律，下次按即真实重试
        return { type: 'failed', error: e };
    }
}

/** 发起单次 AI 调用（飞行中去重：同 key 并发共享同一 Promise，连按 Ctrl+B 不重复消耗 token） */
function startAnalysis(
    cfg: AiClientConfig,
    content: string,
    cacheKey: string,
    mode: AnalysisMode,
    range: KeywordRange,
): Promise<AnalysisOutcome> {
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const call = runAnalysis(cfg, content, cacheKey, mode, range).finally(() => { inflight.delete(cacheKey); });
    inflight.set(cacheKey, call);
    return call;
}

/**
 * 本地预判（毫秒级，无 AI 成本）：两个 AI 开关全关 → disabled（仅本地切分）；
 * 未配置/非散文 → skipped；缓存命中 → cached；其余散文 → ai（携带单次调用执行器）。
 * AI 单次调用只发生在 start() 被调用时。
 */
export async function planAnalysis(content: string): Promise<AnalysisPlan> {
    const sw = await loadAnalysisSwitches();
    if (!sw.keywords && !sw.summary) {
        return { type: 'skipped', outcome: { type: 'skipped', reason: 'disabled' } };
    }
    if (!(await ensureConfigured())) {
        return { type: 'skipped', outcome: { type: 'skipped', reason: 'not_configured' } };
    }

    const maxChars = clampAnalysisMaxChars(await dbService.getKeyValue('ai_analysis_max_chars'));
    const verdict = analyzeVerdict(content, maxChars);
    if (verdict.verdict !== 'prose') {
        // too_short 附带实际字数：灵动岛据此展示「内容过短（N 字）」，
        // 用户可直接看出分析对象是不是自己以为的那段文本
        const chars = verdict.verdict === 'too_short' ? content.trim().length : undefined;
        return { type: 'skipped', outcome: { type: 'skipped', reason: verdict.verdict, maxChars, chars } };
    }

    const range = normalizeKeywordRange(
        await dbService.getKeyValue('ai_keywords_min'),
        await dbService.getKeyValue('ai_keywords_max'),
    );
    const mode: AnalysisMode = sw.keywords && sw.summary ? 'both' : sw.keywords ? 'keywords' : 'summary';
    const version = await getDigestVersion();
    // 内容身份用双哈希指纹（非单一 32 位 hash），避免碰撞把别的对象的结果当成本次结果；
    // 模式与关键词范围入键：关闭/开启能力后不复用另一形态的缓存结果
    const cacheKey = `analysis:${contentFingerprint(content)}:${version}:${mode}:${range.min}-${range.max}`;
    const windowSec = Number(await dbService.getKeyValue('ai_result_window') || '300') || 0;
    const cached = await dbService.getAiCache(cacheKey, windowSec);
    if (cached !== null) {
        // 缓存值自带来源身份：与当前内容不一致（旧格式/碰撞/写入错位）一律按未命中
        const parsed = decodeAnalysisCache(cached, content, range.max);
        if (parsed) return { type: 'cached', outcome: { type: 'done', ...parsed } };
    }

    const cfg = await loadAiConfig();
    return { type: 'ai', start: () => startAnalysis(cfg, content, cacheKey, mode, range) };
}
