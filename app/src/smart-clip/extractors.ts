import type { ExtractRule } from '../entities';
import dbService from '../db/dbService';

/**
 * 自定义提取规则（单层模型，设计文档 .docs/ctrl-b-refactor-design.md §14）。
 *
 * 概念收敛：原「提取器（regex/separator/ai）+ 方案（成员编排 + body 模板）」两级模型
 * 替换为「内置切分器（编译进代码、用户不可见）+ 用户自定义规则（可选列表）」。
 *
 * 存储：settings 表 KV `clip_extract_rules`（{v, list, disabledAi}）。
 * 旧键 `clip_extractors` 只读保留：首次读取时把自定义 regex/separator 迁移过来，
 * 自定义 AI 提取器只计数（停用提示）不迁移执行。
 */

/** settings 表 KV 键：单层提取规则 JSON */
const RULES_KEY = 'clip_extract_rules';
/** 旧键：提取器列表（提取器+方案时代），仅迁移读取，不删除 */
const LEGACY_EXTRACTORS_KEY = 'clip_extractors';

/** KV 存储结构版本 */
const SCHEMA_VERSION = 1;

/** 自定义规则数量上限：规则按序执行，过多会拖慢每次 Ctrl+B 的本地切分 */
export const MAX_EXTRACT_RULES = 10;

interface StoredRules {
    v: number;
    /** KV 原文的列表（脏数据由 normalizeRule 逐项校验） */
    list: unknown[];
    /** 迁移时发现的、已停用的自定义 AI 提取器数量（设置页提示用） */
    disabledAi: number;
}

/**
 * 内置切分器：链接 → 邮箱 → 分词。编译进代码，用户不可见、不可编辑。
 * id 参与片段习惯统计（`Segment.extractorId`），不可变更。
 * 分词排在最后：用户自定义规则优先于默认分词（规则配置才有意义）。
 */
export const BUILTIN_SPLIT_RULES: readonly ExtractRule[] = [
    { id: 'url_extract', name: 'URL', type: 'regex', expression: 'https?://\\S+', enabled: 1 },
    { id: 'email_extract', name: 'Email', type: 'regex', expression: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', enabled: 1 },
    { id: 'smart_tokenize', name: 'Tokenize', type: 'regex', expression: '([^\\n,，、]+)', enabled: 1 },
];

/** 内置切分器 id：按此顺序先跑（分词作为自定义规则之后的兜底） */
const BUILTIN_PRECISE_IDS = ['url_extract', 'email_extract'] as const;

/** 精确内置切分器（自定义规则之前执行） */
export const BUILTIN_PRECISE_RULES: readonly ExtractRule[] = BUILTIN_SPLIT_RULES.filter(
    (r) => (BUILTIN_PRECISE_IDS as readonly string[]).includes(r.id),
);

/** 分词兜底切分器（自定义规则之后执行） */
export const BUILTIN_TOKENIZE_RULE: ExtractRule =
    BUILTIN_SPLIT_RULES.find((r) => r.id === 'smart_tokenize')!;

function uid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return 'x-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

/** 反序列化兜底：脏数据（手改 KV）不导致设置页白屏 */
function normalizeRule(raw: unknown): ExtractRule | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const expression = str(r.expression);
    if (!expression.trim()) return null;
    return {
        id: str(r.id) || uid(),
        name: str(r.name),
        type: r.type === 'separator' ? 'separator' : 'regex',
        expression,
        enabled: r.enabled === 0 ? 0 : 1,
    };
}

/** 列表解析：兼容裸数组与 {v,list} 两种历史形态 */
function parseList(raw: string): unknown[] {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    const list = (parsed as { list?: unknown } | null)?.list;
    return Array.isArray(list) ? list : [];
}

async function readStoredRules(): Promise<StoredRules | null> {
    const raw = await dbService.getKeyValue(RULES_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    return {
        v: Number(obj.v) || SCHEMA_VERSION,
        list: Array.isArray(obj.list) ? (obj.list as unknown[]) : [],
        disabledAi: Number(obj.disabledAi) || 0,
    };
}

/** 旧「提取器」列表（只读，供迁移）：字段做最小校验，非法项跳过 */
async function readLegacyExtractors(): Promise<Array<{
    id: string; name: string; method: string; expression: string; builtin: number;
}>> {
    try {
        const raw = await dbService.getKeyValue(LEGACY_EXTRACTORS_KEY);
        if (!raw) return [];
        return parseList(raw)
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map((x) => ({
                id: str(x.id) || uid(),
                name: str(x.name),
                method: str(x.method) || 'regex',
                expression: str(x.expression),
                builtin: x.builtin === 1 ? 1 : 0,
            }));
    } catch {
        return [];
    }
}

export interface ExtractRulesState {
    rules: ExtractRule[];
    /** 已停用的自定义 AI 提取器数量（>0 时设置页给出提示） */
    disabledAiCount: number;
}

/**
 * 读取自定义规则；新键不存在时执行一次性迁移（幂等：迁移完即写入新键，后续直读）。
 * 迁移规则：内置项丢弃（由代码内置）；自定义 regex/separator 保留；自定义 ai 不迁移、只计数。
 */
export async function loadExtractRules(): Promise<ExtractRulesState> {
    try {
        const stored = await readStoredRules();
        if (stored) {
            return {
                rules: stored.list.map(normalizeRule).filter((x): x is ExtractRule => x !== null),
                disabledAiCount: stored.disabledAi,
            };
        }
        const legacy = await readLegacyExtractors();
        const rules = legacy
            .filter((x) => x.builtin !== 1 && x.method !== 'ai')
            .slice(0, MAX_EXTRACT_RULES)
            .map((x) => ({
                id: x.id,
                name: x.name,
                type: (x.method === 'separator' ? 'separator' : 'regex') as ExtractRule['type'],
                expression: x.expression,
                enabled: 1 as const,
            }))
            .filter((x) => x.expression.trim().length > 0);
        const disabledAiCount = legacy.filter((x) => x.method === 'ai').length;
        await dbService.setKeyValue(RULES_KEY, JSON.stringify({
            v: SCHEMA_VERSION,
            list: rules,
            disabledAi: disabledAiCount,
        }));
        return { rules, disabledAiCount };
    } catch (e) {
        console.warn('[smart-clip] 读取提取规则失败，按无自定义规则处理:', e);
        return { rules: [], disabledAiCount: 0 };
    }
}

/** 整体写回自定义规则（保留迁移时记录的停用计数，供设置页持续提示） */
export async function persistExtractRules(list: ExtractRule[]): Promise<void> {
    try {
        const stored = await readStoredRules().catch(() => null);
        await dbService.setKeyValue(RULES_KEY, JSON.stringify({
            v: SCHEMA_VERSION,
            list: list.slice(0, MAX_EXTRACT_RULES),
            disabledAi: stored?.disabledAi ?? 0,
        }));
    } catch (e) {
        console.error('[smart-clip] 提取规则写入失败:', e);
    }
}

/** 新建空白规则 */
export function createExtractRule(name: string): ExtractRule {
    return { id: uid(), name, type: 'regex', expression: '', enabled: 1 };
}

/** 规则可用性：空表达式、非法正则都视为不可执行（设置页标红，执行时跳过） */
export function isExtractRuleValid(rule: ExtractRule): boolean {
    const expression = rule.expression.trim();
    if (!expression) return false;
    if (rule.type === 'separator') return true;
    try {
        new RegExp(expression);
        return true;
    } catch {
        return false;
    }
}
