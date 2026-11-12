import { contentFingerprint } from '../../utils/hash';

/**
 * AI 分析结果缓存的归属校验（.docs/smart-clip-ai-analysis.md「缓存」）：
 *
 * 缓存一旦命中，结果会被直接当作**当前内容**的分析展示，因此缓存值必须自带来源
 * 身份，并在读取时与当前内容逐项比对。只凭 32 位内容 hash 作键时，哈希碰撞（或
 * 任何键拼接错误）都会把别的条目的分析结果静默套到当前对象上——这正是「无法分析
 * 的对象显示了历史分析结果」的成因。
 *
 * 信封结构（v2）：
 * `{ v: 2, fp, len, head, tail, result }`
 * - fp：双 32 位内容指纹（utils/hash.contentFingerprint）
 * - len / head / tail：内容长度与首尾 64 字符采样，用于否决指纹层面的碰撞
 * 任一项与当前内容不符 → 视为未命中，交由调用方重新分析；旧格式（无信封）同样
 * 按未命中处理（旧值无法证明归属，宁可不命中也不误用）。
 */

export interface AnalysisFields {
    keywords: string[];
    bullets: string[];
    summary: string;
}

/** 信封版本：变更结构必须同时递增，旧版本自动失效 */
const ENVELOPE_VERSION = 2;

/** 首尾采样长度（字符） */
const SAMPLE_LEN = 64;

interface AnalysisCacheEnvelope {
    v: number;
    fp: string;
    len: number;
    head: string;
    tail: string;
    result: unknown;
}

/** 关键词条数兜底上限（调用方按用户设置传入实际上限） */
const KEYWORDS_CAP_FALLBACK = 20;

/**
 * 结果字段清洗：去空、去脱敏占位符、各字段封顶；三字段全空视为无有效产出。
 * 同时用于「AI 原始输出解析」与「缓存信封校验通过后的结果重建」。
 */
export function normalizeAnalysisFields(raw: unknown, maxKeywords: number = KEYWORDS_CAP_FALLBACK): AnalysisFields | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    /** 字符串数组字段清洗：去空、去脱敏占位符、封顶 n 条 */
    const strings = (v: unknown, n: number): string[] =>
        (Array.isArray(v) ? v : [])
            .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            .map((k) => k.trim())
            // 脱敏占位符不得透出（模型忽略指令时的兜底）
            .filter((k) => !k.includes('[REDACTED]'))
            .slice(0, n);
    const keywords = strings(obj.keywords, maxKeywords);
    // 要点为可选字段：旧产出无 bullets 时返回 []，行为与改造前一致
    const bullets = strings(obj.bullets, 5);
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    // 产出校验：三字段全空 = 失败（不缓存）
    if (keywords.length === 0 && bullets.length === 0 && !summary) return null;
    return { keywords, bullets, summary };
}

/** 写入缓存：把来源内容身份与分析结果一起封进信封 */
export function encodeAnalysisCache(content: string, result: AnalysisFields): string {
    const envelope: AnalysisCacheEnvelope = {
        v: ENVELOPE_VERSION,
        fp: contentFingerprint(content),
        len: content.length,
        head: content.slice(0, SAMPLE_LEN),
        tail: content.slice(-SAMPLE_LEN),
        result,
    };
    return JSON.stringify(envelope);
}

/**
 * 读取缓存：先校验信封归属（当前内容 = 写缓存时的内容？），再重建结果。
 * 任何不匹配都返回 null，调用方按未命中处理，绝不复用他者结果。
 */
export function decodeAnalysisCache(
    raw: string,
    content: string,
    maxKeywords: number = KEYWORDS_CAP_FALLBACK,
): AnalysisFields | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const env = parsed as Partial<AnalysisCacheEnvelope>;
    if (env.v !== ENVELOPE_VERSION) return null; // 旧格式无法证明归属：不采用
    if (env.len !== content.length) return null;
    if (env.fp !== contentFingerprint(content)) return null;
    if (env.head !== content.slice(0, SAMPLE_LEN) || env.tail !== content.slice(-SAMPLE_LEN)) return null;
    return normalizeAnalysisFields(env.result, maxKeywords);
}
