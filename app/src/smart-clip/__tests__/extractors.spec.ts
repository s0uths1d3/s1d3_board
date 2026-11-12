import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
    const kv = new Map<string, string>();
    return {
        kv,
        getKeyValue: vi.fn((k: string) => kv.get(k) ?? null),
        setKeyValue: vi.fn((k: string, v: string) => { kv.set(k, v); }),
    };
});

vi.mock('~/src/db/dbService', () => ({
    default: {
        getKeyValue: h.getKeyValue,
        setKeyValue: h.setKeyValue,
    },
}));

import {
    loadExtractRules, persistExtractRules, createExtractRule,
    isExtractRuleValid, MAX_EXTRACT_RULES, BUILTIN_SPLIT_RULES,
} from '../extractors';

const RULES_KEY = 'clip_extract_rules';
const LEGACY_KEY = 'clip_extractors';

describe('自定义提取规则：存储与一次性迁移', () => {
    beforeEach(() => {
        h.kv.clear();
        h.getKeyValue.mockClear();
        h.setKeyValue.mockClear();
    });

    it('首次读取无旧配置：返回空规则并把新键落库（标记迁移完成）', async () => {
        const state = await loadExtractRules();
        expect(state).toEqual({ rules: [], disabledAiCount: 0 });
        expect(JSON.parse(h.kv.get(RULES_KEY)!)).toMatchObject({ list: [], disabledAi: 0 });
    });

    it('旧提取器迁移：丢弃内置项、保留自定义 regex/separator、AI 项只计数', async () => {
        h.kv.set(LEGACY_KEY, JSON.stringify([
            { id: 'url_extract', name: 'URL', method: 'regex', expression: 'https?://\\S+', builtin: 1 },
            { id: 'smart_tokenize', name: '分词', method: 'regex', expression: '([^\\n,，、]+)', builtin: 1 },
            { id: 'my_regex', name: '订单号', method: 'regex', expression: '\\d{6,}', builtin: 0 },
            { id: 'my_sep', name: '横线', method: 'separator', expression: '|', builtin: 0 },
            { id: 'ai_netdisk', name: '网盘', method: 'ai', expression: '提取链接', builtin: 1 },
            { id: 'ai_mine', name: '我的 AI', method: 'ai', expression: '自定义指令', builtin: 0 },
        ]));

        const state = await loadExtractRules();

        expect(state.disabledAiCount).toBe(2);
        expect(state.rules.map((r) => r.id)).toEqual(['my_regex', 'my_sep']);
        expect(state.rules[1]).toMatchObject({ type: 'separator', expression: '|', enabled: 1 });
        // 迁移结果写入新键，旧键保留不动（可回滚）
        expect(JSON.parse(h.kv.get(RULES_KEY)!)).toMatchObject({ disabledAi: 2 });
        expect(h.kv.has(LEGACY_KEY)).toBe(true);
    });

    it('迁移幂等：新键存在后不再读取旧键', async () => {
        h.kv.set(LEGACY_KEY, JSON.stringify([
            { id: 'a', name: 'A', method: 'regex', expression: '\\d+', builtin: 0 },
        ]));
        await loadExtractRules();
        h.getKeyValue.mockClear();

        h.kv.set(LEGACY_KEY, JSON.stringify([
            { id: 'b', name: 'B', method: 'regex', expression: '\\w+', builtin: 0 },
        ]));
        const second = await loadExtractRules();

        expect(second.rules.map((r) => r.id)).toEqual(['a']);
        expect(h.getKeyValue.mock.calls.every(([k]) => k === RULES_KEY)).toBe(true);
    });

    it('脏数据逐项兜底：缺表达式丢弃、未知类型回落 regex', async () => {
        h.kv.set(RULES_KEY, JSON.stringify({
            v: 1,
            list: [
                { id: 'x', name: '缺表达式', type: 'regex', expression: '   ' },
                { id: 'y', name: '未知类型', type: 'weird', expression: '\\d+' },
                'not-an-object',
            ],
            disabledAi: 0,
        }));
        const state = await loadExtractRules();
        expect(state.rules).toHaveLength(1);
        expect(state.rules[0]).toMatchObject({ id: 'y', type: 'regex' });
    });

    it('持久化保留停用计数，并截断到上限', async () => {
        h.kv.set(RULES_KEY, JSON.stringify({ v: 1, list: [], disabledAi: 3 }));
        const many = Array.from({ length: MAX_EXTRACT_RULES + 5 }, (_, i) => ({
            id: `r${i}`, name: `R${i}`, type: 'regex' as const, expression: '\\d+', enabled: 1 as const,
        }));
        await persistExtractRules(many);
        const stored = JSON.parse(h.kv.get(RULES_KEY)!);
        expect(stored.disabledAi).toBe(3);
        expect(stored.list).toHaveLength(MAX_EXTRACT_RULES);
    });

    it('内置切分器 id 固定且只含链接/邮箱/分词（不可联网）', () => {
        expect(BUILTIN_SPLIT_RULES.map((r) => r.id)).toEqual([
            'url_extract', 'email_extract', 'smart_tokenize',
        ]);
        expect(BUILTIN_SPLIT_RULES.every((r) => r.type === 'regex')).toBe(true);
    });

    it('规则有效性：空表达式/非法正则不可执行，分隔符只看非空', () => {
        const empty = createExtractRule('空');
        expect(isExtractRuleValid(empty)).toBe(false);
        expect(isExtractRuleValid({ ...empty, expression: '(' })).toBe(false);
        expect(isExtractRuleValid({ ...empty, expression: '\\d+' })).toBe(true);
        expect(isExtractRuleValid({ ...empty, type: 'separator', expression: '(' })).toBe(true);
    });
});
