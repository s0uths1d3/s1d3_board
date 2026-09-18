import { aiComplete, loadAiConfig, type AiClientConfig } from './aiClient';
import { analyzeVerdict, clampAnalysisMaxChars, redactSecrets, type Verdict } from './analyzer';
import { buildDigest, getDigestVersion, recordAnalysisShown } from './habitProfile';
import statsService from '../statistics/statsService';
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

/**
 * 分析计划：本地预判（planAnalysis，毫秒级）与 AI 执行（start，单次调用）分离。
 * 调用方拿到计划即可立刻弹出对应灵动岛（AI 链路 → 解析中驻留；本地分支 → 结果岛），
 * 仅 ai 分支持有执行器——解析失败等场景不调用 start 即不消耗 token。
 */
export type AnalysisPlan =
    | { type: 'skipped'; outcome: AnalysisOutcome & { type: 'skipped' } }
    | { type: 'cached'; outcome: AnalysisOutcome & { type: 'done' } }
    | { type: 'ai'; start: () => Promise<AnalysisOutcome> };

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
    // 偏好摘要：确定性生成；数据不足返回 null → 中性模板。
    // 摘要拼在 **user 消息头部**而非 system——digest 随每次粘贴行为变化，若进 system
    // 会令「静态指令前缀」整体失效：provider 前缀缓存（DeepSeek/Qwen 自动上下文缓存、
    // OpenAI ≥1024 token 自动缓存）每次调用全部未命中，token 全价。
    // system 保持纯静态 → 逐次调用稳定命中缓存；digest 置于 user 首部（相对稳定在前、
    // 每次变化的内容在后），同一 digest 周期内连续分析时 user 前缀也部分复用。
    const digest = await buildDigest();
    const system = INSTRUCTION + JSON_CONTRACT;
    const user = digest ? `${digest}\n\n${content}` : content;
    try {
        // 散文夹密钥：发送前脱敏（[REDACTED]），密钥不外发第三方接口
        const out = await aiComplete(cfg, system, redactSecrets(user));
        const parsed = parseResult(out);
        if (!parsed) throw new Error('AI 分析产出为空');
        void dbService.setAiCache(cacheKey, JSON.stringify(parsed)).catch(() => {});
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
function startAnalysis(cfg: AiClientConfig, content: string, cacheKey: string): Promise<AnalysisOutcome> {
    const pending = inflight.get(cacheKey);
    if (pending) return pending;
    const call = runAnalysis(cfg, content, cacheKey).finally(() => { inflight.delete(cacheKey); });
    inflight.set(cacheKey, call);
    return call;
}

/**
 * 本地预判（毫秒级，无 AI 成本）：未配置/非散文 → skipped；缓存命中 → cached；
 * 其余散文 → ai（携带单次调用执行器）。AI 单次调用只发生在 start() 被调用时。
 */
export async function planAnalysis(content: string): Promise<AnalysisPlan> {
    if (!(await ensureConfigured())) {
        return { type: 'skipped', outcome: { type: 'skipped', reason: 'not_configured' } };
    }

    const maxChars = clampAnalysisMaxChars(await dbService.getKeyValue('ai_analysis_max_chars'));
    const verdict = analyzeVerdict(content, maxChars);
    if (verdict.verdict !== 'prose') {
        return { type: 'skipped', outcome: { type: 'skipped', reason: verdict.verdict, maxChars } };
    }

    const version = await getDigestVersion();
    const cacheKey = `analysis:${hashText(content)}:${version}`;
    const windowSec = Number(await dbService.getKeyValue('ai_result_window') || '300') || 0;
    const cached = await dbService.getAiCache(cacheKey, windowSec);
    if (cached !== null) {
        const parsed = parseResult(cached);
        if (parsed) return { type: 'cached', outcome: { type: 'done', ...parsed } };
    }

    const cfg = await loadAiConfig();
    return { type: 'ai', start: () => startAnalysis(cfg, content, cacheKey) };
}
