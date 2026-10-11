import { aiComplete, loadAiConfig } from '../smart-clip/aiClient';

/**
 * 自然语言录入（待办 §11）：一句话描述 → AI 抽取任务字段 → 回填新增表单（不直接落库）。
 * 依赖设置页已配置的 AI 接入（复用 smart-clip 的 aiClient）；失败抛错由调用方提示。
 */

/** 解析结果（字段已白名单化，可直接展开进表单） */
export interface TodoNlpResult {
    title: string;
    description: string;
    /** 'YYYY-MM-DDTHH:mm'；无法确定时间为 '' */
    dueDate: string;
    /** 0-255，默认 127 */
    priorityLevel: number;
    /** 命中已有分类时回填，否则 ''（保持表单默认分类） */
    category: string;
    tags: string[];
}

/** 抛给调用方的稳定错误码（UI 侧映射 i18n 文案） */
export const NLP_ERR_NOT_CONFIGURED = 'AI_NOT_CONFIGURED';
export const NLP_ERR_BAD_RESPONSE = 'AI_BAD_RESPONSE';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 注入 prompt 的本地时间上下文：让 AI 能推算「明天 / 下周三 / 3 天后」等相对日期 */
function localTimeContext(): string {
    const d = new Date();
    const week = '日一二三四五六'[d.getDay()];
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
        + `T${pad2(d.getHours())}:${pad2(d.getMinutes())}（周${week}）`;
}

const SYSTEM_PROMPT = `你是待办任务解析助手。从用户的一句话中抽取任务信息，严格只输出一个 JSON 对象（禁止 markdown 代码块、禁止解释），字段如下：
{"title":"简短任务标题(必填)","description":"补充说明，无则空串","dueDate":"YYYY-MM-DDTHH:mm 或空串","priorityLevel":整数,"category":"分类名或空串","tags":["标签","…"]}
规则：
- dueDate：用户提到截止/提醒时间时输出，相对日期（今天/明天/下周三/3天后）按给定当前时间推算；只说了日期没说时刻时用 09:00；未提及时间为空串。
- priorityLevel：0-255 越大越紧急，默认 127；「高优先级/紧急」约 220，「低」约 40。
- category：只能是「工作/学习/生活/娱乐/其他」之一，无法判断输出空串。
- tags：用户提到的主题关键字（如「标签工作」→ ["工作"]），无则 []。`;

/** 剥 ```json 围栏 + 截取首尾大括号，容错模型输出前后噪声 */
function extractJson(raw: string): unknown {
    let s = raw.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
    if (fence) {
        const inner = fence[1];
        if (inner !== undefined) s = inner.trim();
    }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
    return JSON.parse(s);
}

/** dueDate 白名单：合法 'YYYY-MM-DDTHH:mm'（容忍日期-only 补 09:00 / 带秒截断），非法返回 '' */
function normalizeDue(value: unknown): string {
    if (typeof value !== 'string') return '';
    const s = value.trim();
    const full = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
    const text = full ? `${full[1]}T${full[2]}` : dateOnly ? `${dateOnly[1]}T09:00` : '';
    if (!text) return '';
    return Number.isNaN(new Date(text).getTime()) ? '' : text;
}

/** 解析结果字段白名单化：非法值丢弃回退默认；title 为空视为解析失败 */
function whitelist(parsed: unknown, categories: string[]): TodoNlpResult | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (!title) return null;

    const level = Math.round(Number(p.priorityLevel));
    const category = typeof p.category === 'string' ? p.category.trim() : '';
    const rawTags = Array.isArray(p.tags) ? p.tags : [];
    // 先去重再截断：保证恰好保留 8 个不同标签
    const tags = [...new Set(
        rawTags
            .filter((x): x is string => typeof x === 'string')
            .map(x => x.trim())
            .filter(Boolean),
    )].slice(0, 8);

    return {
        title: title.slice(0, 200),
        description: typeof p.description === 'string' ? p.description.trim().slice(0, 2000) : '',
        dueDate: normalizeDue(p.dueDate),
        priorityLevel: Number.isFinite(level) ? Math.min(255, Math.max(0, level)) : 127,
        category: categories.includes(category) ? category : '',
        tags,
    };
}

/**
 * AI 解析一句话任务描述。失败抛 Error：
 * - NLP_ERR_NOT_CONFIGURED：未配置 AI（引导去设置页）
 * - NLP_ERR_BAD_RESPONSE：响应不可解析/无标题
 * - 其余透传底层错误（网络/鉴权等，调用方经 briefAiError 缩短展示）
 */
export async function parseTodoFromText(text: string, options?: { categories?: string[] }): Promise<TodoNlpResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(NLP_ERR_BAD_RESPONSE);
    const cfg = await loadAiConfig();
    if (!cfg.apiKey || !cfg.baseUrl) throw new Error(NLP_ERR_NOT_CONFIGURED);
    const raw = await aiComplete(cfg, SYSTEM_PROMPT, `${trimmed}\n\n当前本地时间：${localTimeContext()}`);
    let parsed: unknown;
    try {
        parsed = extractJson(raw);
    } catch {
        throw new Error(NLP_ERR_BAD_RESPONSE);
    }
    const result = whitelist(parsed, options?.categories ?? []);
    if (!result) throw new Error(NLP_ERR_BAD_RESPONSE);
    return result;
}
