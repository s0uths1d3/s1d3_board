import type { ClipExtractor } from '../entities';
import dbService from '../db/dbService';

/**
 * 提取器（原「预设」）：智能剪贴板里**单个内容的提取单元**。
 *
 * 与「方案」的分工：
 * - 提取器 = 一个单元：一次正则/分隔符/AI 指令，产出 0..n 条片段（如"提取链接"）；
 * - 方案 = 集成体：按序引用多个提取器，把各自的产出合并成最终片段序列。
 *
 * 存储：settings 表 KV `clip_extractors`（整表 JSON 数组）。数量少、无需迁移，
 * 与导航配置 `nav_tab_config` 同一模式；首次读取为空/损坏时用内置提取器 seed。
 */

export type Translator = (key: string) => string;

/** settings 表 KV 键：提取器列表 JSON */
const EXTRACTORS_KEY = 'clip_extractors';

/**
 * seed 版本：内置提取器文案调整时 +1。加载时若存量版本更低，把**未删除的内置项**
 * 刷新为当前语言的最新文案（自定义项不动）。注意：这会覆盖用户对内置项的手工编辑。
 */
const SEED_VERSION = 1;

/** KV 存储结构：版本号 + 列表 */
interface StoredExtractors {
    v: number;
    list: ClipExtractor[];
}

function uid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return 'x-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

/** 内置提取器定义（i18n key + 内容）：seed 与「恢复内置」共用的唯一来源 */
interface BuiltinExtractorDef {
    id: string;
    method: ClipExtractor['method'];
    nameKey: string;
    descKey: string;
    sampleKey?: string;
    /** 表达式：正则/分隔符直接给字面量；AI 走 instructionKey（i18n） */
    expression?: string;
    instructionKey?: string;
}

export const BUILTIN_EXTRACTOR_DEFS: BuiltinExtractorDef[] = [
    {
        id: 'url_extract',
        method: 'regex',
        nameKey: 'extractor.url_extract.name',
        descKey: 'extractor.url_extract.desc',
        expression: 'https?://\\S+',
    },
    {
        id: 'email_extract',
        method: 'regex',
        nameKey: 'extractor.email_extract.name',
        descKey: 'extractor.email_extract.desc',
        expression: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+',
    },
    {
        id: 'smart_tokenize',
        method: 'regex',
        nameKey: 'extractor.smart_tokenize.name',
        descKey: 'extractor.smart_tokenize.desc',
        sampleKey: 'extractor.smart_tokenize.sample',
        expression: '([^\\n,，、]+)',
    },
    {
        id: 'netdisk_extract',
        method: 'regex',
        nameKey: 'extractor.netdisk_extract.name',
        descKey: 'extractor.netdisk_extract.desc',
        sampleKey: 'extractor.netdisk_extract.sample',
        expression: '链接[:：]\\s*(\\S+).*?提取码[:：]\\s*(\\S+)',
    },
    {
        id: 'ai_netdisk',
        method: 'ai',
        nameKey: 'extractor.ai_netdisk.name',
        descKey: 'extractor.ai_netdisk.desc',
        instructionKey: 'extractor.ai_netdisk.instruction',
    },
    {
        id: 'ai_summarize',
        method: 'ai',
        nameKey: 'extractor.ai_summarize.name',
        descKey: 'extractor.ai_summarize.desc',
        instructionKey: 'extractor.ai_summarize.instruction',
    },
];

/** 按当前语言生成内置提取器（id 固定 = 内置 def id，供「恢复内置」去重） */
export function buildBuiltinExtractors(t: Translator): ClipExtractor[] {
    return BUILTIN_EXTRACTOR_DEFS.map((d) => ({
        id: d.id,
        name: t(d.nameKey),
        desc: t(d.descKey),
        method: d.method,
        expression: d.expression ?? (d.instructionKey ? t(d.instructionKey) : ''),
        sample: d.sampleKey ? t(d.sampleKey) : '',
        builtin: 1 as const,
    }));
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/** 反序列化兜底：脏数据（手改 KV）不导致设置页白屏 */
function normalize(raw: unknown): ClipExtractor | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const method = r.method === 'separator' || r.method === 'ai' ? r.method : 'regex';
    return {
        id: str(r.id) || uid(),
        name: str(r.name),
        desc: str(r.desc),
        method,
        expression: str(r.expression),
        sample: str(r.sample),
        builtin: r.builtin === 1 ? 1 : 0,
    };
}

/** 把列表中未删除的内置项刷新为当前语言最新文案（自定义项原样保留） */
function refreshBuiltinTexts(list: ClipExtractor[], t: Translator): ClipExtractor[] {
    const built = new Map(buildBuiltinExtractors(t).map((p) => [p.id, p]));
    return list.map((p) => (p.builtin === 1 && built.has(p.id) ? { ...built.get(p.id)! } : p));
}

/**
 * 只读已存储的提取器（**不 seed、不翻译**）：处理层 smartClip 解析时使用，
 * 避免在管道里依赖 i18n（文案由设置页 seed 时确定）。
 */
export async function readStoredExtractors(): Promise<ClipExtractor[]> {
    try {
        const raw = await dbService.getKeyValue(EXTRACTORS_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        const list: unknown[] = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as StoredExtractors | null)?.list)
                ? ((parsed as StoredExtractors).list as unknown[])
                : [];
        return list.map(normalize).filter((x): x is ClipExtractor => x !== null);
    } catch (e) {
        console.warn('[smart-clip] 读取提取器失败，按无提取器处理:', e);
        return [];
    }
}

/** 读取提取器列表；首次（KV 为空/损坏）用内置 seed 并落库，旧版本刷新内置文案 */
export async function loadExtractors(t: Translator): Promise<ClipExtractor[]> {
    try {
        const raw = await dbService.getKeyValue(EXTRACTORS_KEY);
        if (raw) {
            const parsed: unknown = JSON.parse(raw);
            const stored: StoredExtractors | null = Array.isArray(parsed)
                ? { v: 1, list: parsed }
                : parsed && typeof parsed === 'object' && Array.isArray((parsed as StoredExtractors).list)
                    ? { v: Number((parsed as StoredExtractors).v) || 1, list: (parsed as StoredExtractors).list }
                    : null;
            if (stored) {
                const list = stored.list.map(normalize).filter((x): x is ClipExtractor => x !== null);
                if (list.length > 0) {
                    if (stored.v < SEED_VERSION) {
                        const refreshed = refreshBuiltinTexts(list, t);
                        await persistExtractors(refreshed);
                        return refreshed;
                    }
                    return list;
                }
            }
        }
    } catch (e) {
        console.warn('[smart-clip] 提取器读取失败，回退内置:', e);
    }
    const seeded = buildBuiltinExtractors(t);
    await persistExtractors(seeded);
    return seeded;
}

/** 整体写回提取器列表，带当前 seed 版本号 */
export async function persistExtractors(list: ClipExtractor[]): Promise<void> {
    try {
        const payload: StoredExtractors = { v: SEED_VERSION, list };
        await dbService.setKeyValue(EXTRACTORS_KEY, JSON.stringify(payload));
    } catch (e) {
        console.error('[smart-clip] 提取器写入失败:', e);
    }
}

/** 当前列表中缺失的内置提取器（按 id 判定，已存在/已改过的不覆盖） */
export function missingBuiltinExtractors(list: ClipExtractor[], t: Translator): ClipExtractor[] {
    const has = new Set(list.map((p) => p.id));
    return buildBuiltinExtractors(t).filter((p) => !has.has(p.id));
}

/** 新建空白提取器 */
export function createExtractor(name: string): ClipExtractor {
    return { id: uid(), name, desc: '', method: 'regex', expression: '', sample: '', builtin: 0 };
}
