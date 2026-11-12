import dbService from '../db/dbService';
import { detectTechArtifact } from './analyzer';

/**
 * 用户习惯画像（.docs/smart-clip-ai-analysis.md）：
 * 仅本地采集存储（KV ai_habit_profile），**不参与 AI 请求内容**（输入零注入原则）：
 * 画像只用于本地统计与缓存分区版本号（版本化失效），发往 AI 的永远只有本次剪贴板内容。
 */

const KV_KEY = 'ai_habit_profile';
const SCHEMA_VERSION = 1;

export interface HabitProfile {
    /** schema 结构版本：解析不认识的高版本按无数据处理 */
    version: number;
    pasteLengthDist: { short: number; medium: number; long: number };
    pasteTypeDist: { link: number; text: number; number: number; code: number };
    pasteLangDist: { zh: number; en: number };
    aiAdoption: { shown: number; pasted: number };
    topExtractors: Array<{ id: string; count: number }>;
    updatedAt: number;
}

const EMPTY: HabitProfile = {
    version: SCHEMA_VERSION,
    pasteLengthDist: { short: 0, medium: 0, long: 0 },
    pasteTypeDist: { link: 0, text: 0, number: 0, code: 0 },
    pasteLangDist: { zh: 0, en: 0 },
    aiAdoption: { shown: 0, pasted: 0 },
    topExtractors: [],
    updatedAt: 0,
};

function normalize(raw: unknown): HabitProfile {
    if (!raw || typeof raw !== 'object') return { ...EMPTY };
    const r = raw as Partial<HabitProfile>;
    return {
        version: typeof r.version === 'number' ? r.version : SCHEMA_VERSION,
        pasteLengthDist: { ...EMPTY.pasteLengthDist, ...(r.pasteLengthDist ?? {}) },
        pasteTypeDist: { ...EMPTY.pasteTypeDist, ...(r.pasteTypeDist ?? {}) },
        pasteLangDist: { ...EMPTY.pasteLangDist, ...(r.pasteLangDist ?? {}) },
        aiAdoption: { ...EMPTY.aiAdoption, ...(r.aiAdoption ?? {}) },
        topExtractors: Array.isArray(r.topExtractors)
            ? r.topExtractors.filter((x) => x && typeof x.id === 'string' && typeof x.count === 'number')
            : [],
        updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
    };
}

async function load(): Promise<HabitProfile> {
    try {
        const raw = await dbService.getKeyValue(KV_KEY);
        return raw ? normalize(JSON.parse(raw)) : { ...EMPTY };
    } catch {
        return { ...EMPTY }; // 损坏/高版本 schema：静默按无数据，重新积累
    }
}

async function save(p: HabitProfile): Promise<void> {
    p.updatedAt = Date.now();
    await dbService.setKeyValue(KV_KEY, JSON.stringify(p));
}

/** 偏好摘要版本号（AI 分析缓存键用）：任何计数变更 updatedAt 即更新，旧缓存自然失效 */
export async function getDigestVersion(): Promise<string> {
    return String((await load()).updatedAt);
}

function classifyLength(text: string): keyof HabitProfile['pasteLengthDist'] {
    const len = text.trim().length;
    return len < 10 ? 'short' : len <= 50 ? 'medium' : 'long';
}

function classifyType(text: string): keyof HabitProfile['pasteTypeDist'] {
    const t = text.trim();
    if (/^(?:https?:\/\/|www\.)/i.test(t) || /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(t)) return 'link';
    const compact = t.replace(/\s/g, '');
    if (compact && compact.replace(/[^\p{L}\d]/gu, '').length / compact.length < 0.5 && /\d/.test(compact)) return 'number';
    if (detectTechArtifact(t)) return 'code';
    return 'text';
}

function classifyLang(text: string): keyof HabitProfile['pasteLangDist'] {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    return cjk * 2 >= latin ? 'zh' : 'en'; // 中英混排按汉字权重归中文
}

/** 本地片段被用户粘贴：采集长度/类型/语言分布与提取器计数（粘贴路径调用） */
export async function recordPaste(segmentText: string, extractorId: string): Promise<void> {
    try {
        const p = await load();
        if (!segmentText.trim()) return;
        p.pasteLengthDist[classifyLength(segmentText)]++;
        p.pasteTypeDist[classifyType(segmentText)]++;
        p.pasteLangDist[classifyLang(segmentText)]++;
        if (extractorId) {
            const e = p.topExtractors.find((x) => x.id === extractorId);
            if (e) e.count++;
            else p.topExtractors.push({ id: extractorId, count: 1 });
            p.topExtractors.sort((a, b) => b.count - a.count);
        }
        await save(p);
    } catch { /* 画像采集失败不影响粘贴主流程 */ }
}

/** AI 分析产出入环展示：记采纳率分母（产出即视为展示） */
export async function recordAnalysisShown(n: number): Promise<void> {
    if (n <= 0) return;
    try {
        const p = await load();
        p.aiAdoption.shown += n;
        await save(p);
    } catch { /* ignore */ }
}

/** AI 产出片段被用户实际粘贴：采纳率分子（决定下次关键词粒度指令） */
export async function recordAiAdoption(): Promise<void> {
    try {
        const p = await load();
        p.aiAdoption.pasted++;
        await save(p);
    } catch { /* ignore */ }
}


