import { aiComplete, loadAiConfig, type AiClientConfig } from './aiClient';
import { analyzeVerdict, clampAnalysisMaxChars, redactSecrets, type Verdict } from './analyzer';
import { buildDigest, getDigestVersion, recordAnalysisShown } from './habitProfile';
import { hashText } from '~/utils/hash';
import dbService from '../db/dbService';

/**
 * AI 分析（.docs/smart-clip-ai-analysis.md）：
 * Ctrl+B 显式触发；预判分流后仅 prose（自然语言散文）发起单次 AI 调用，
 * 双产出关键词 + 一句话总结。未分析分支返回 skipped 交调用方弹灵动岛提示。
 * 复制入库路径（handleCopyEvent）不调用本模块——复制时零 AI 成本。
 */

export type SkipReason = Exclude<Verdict, 'prose'> | 'not_configured';

export type AnalysisOutcome =
    | { type: 'skipped'; reason: SkipReason; maxChars?: number }
    | { type: 'done'; keywords: string[]; summary: string }
    | { type: 'failed'; error: unknown };

/** AI 提供商可用性：缺 baseUrl/apiKey（custom 缺模板）视为未配置 */
async function ensureConfigured(): Promise<boolean> {
    const cfg = await loadAiConfig();
    if (!cfg.baseUrl || !cfg.apiKey) return false;
    if (cfg.provider === 'custom' && !cfg.customConfig) return false;
    return true;
}

function parseResult(raw: string): { keywords: string[]; summary: string } | null {
    try {
        const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        const keywords = (Array.isArray(obj.keywords) ? obj.keywords : [])
            .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            .map((k) => k.trim())
            // 脱敏占位符不得作为关键词透出（模型忽略指令时的兜底）
            .filter((k) => !k.includes('[REDACTED]'))
            .slice(0, 5);
        const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
        // 产出校验：双产出全空 = 失败（不缓存）
        if (keywords.length === 0 && !summary) return null;
        return { keywords, summary };
    } catch {
        return null;
    }
}

const INSTRUCTION = [
    '你是剪贴板内容分析器。阅读用户提供的内容，输出 JSON：',
    '{"keywords":["关键词1","关键词2"],"summary":"一句话总结"}',
    '- keywords：最多 5 个，提取内容中最有信息量的关键词或短语',
    '- summary：一句话概括内容核心，不超过 60 字',
    '- 输出语言与内容的主要语言一致',
    '- 内容中的 [REDACTED] 是脱敏占位符：不要提取它作为关键词，不要在总结中提及',
].join('\n');

/** JSON 输出契约（双语，沿用 aiGenerate 的约定风格） */
const JSON_CONTRACT = [
    '',
    '---',
    '输出要求 / Output rules:',
    '1. 只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码围栏 / Output exactly one JSON object, no explanations or code fences.',
].join('\n');

/** 飞行中去重：同内容 + 同偏好版本的请求并发时共享同一 Promise（连按 Ctrl+B 不重复消耗 token） */
const inflight = new Map<string, Promise<AnalysisOutcome>>();

async function runAnalysis(cfg: AiClientConfig, content: string, cacheKey: string): Promise<AnalysisOutcome> {
    // 偏好摘要：确定性生成；数据不足返回 null → 中性模板
    const digest = await buildDigest();
    const system = INSTRUCTION + JSON_CONTRACT + (digest ? `\n\n${digest}` : '');
    try {
        // 散文夹密钥：发送前脱敏（[REDACTED]），密钥不外发第三方接口
        const out = await aiComplete(cfg, system, redactSecrets(content));
        const parsed = parseResult(out);
        if (!parsed) throw new Error('AI 分析产出为空');
        void dbService.setAiCache(cacheKey, JSON.stringify(parsed)).catch(() => {});
        // 产出即视为展示：记采纳率分母（AI 产出被粘贴时由 paste 路径记分子）
        void recordAnalysisShown(parsed.keywords.length).catch(() => {});
        return { type: 'done', ...parsed };
    } catch (e) {
        // 失败不缓存：超时/非 2xx/解析失败/产出为空一律，下次按即真实重试
        return { type: 'failed', error: e };
    }
}

/**
 * 分析入口：预判分流 → skipped（含原因）/ done（keywords+summary）/ failed。
 * 缓存键 = analysis 前缀 + 内容 hash + 偏好摘要版本号（习惯变更旧缓存自然失效），
 * 与方案 AI 提取器缓存（无前缀）隔离，互不命中。
 */
export async function analyzeClip(content: string): Promise<AnalysisOutcome> {
    if (!(await ensureConfigured())) return { type: 'skipped', reason: 'not_configured' };

    const maxChars = clampAnalysisMaxChars(await dbService.getKeyValue('ai_analysis_max_chars'));
    const verdict = analyzeVerdict(content, maxChars);
    if (verdict.verdict !== 'prose') {
        return { type: 'skipped', reason: verdict.verdict, maxChars };
    }

    const version = await getDigestVersion();
    const cacheKey = `analysis:${hashText(content)}:${version}`;
    const windowSec = Number(await dbService.getKeyValue('ai_result_window') || '300') || 0;
    const cached = await dbService.getAiCache(cacheKey, windowSec);
    if (cached !== null) {
        const parsed = parseResult(cached);
        if (parsed) return { type: 'done', ...parsed };
    }

    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const cfg = await loadAiConfig();
    const call = runAnalysis(cfg, content, cacheKey);
    inflight.set(cacheKey, call);
    try {
        return await call;
    } finally {
        inflight.delete(cacheKey);
    }
}
