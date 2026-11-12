import { describe, it, expect, vi } from 'vitest';

// pipeline 只用到内置规则常量，不触库；mock 掉 dbService 避免真实 DB 初始化
vi.mock('~/src/db/dbService', () => ({ default: {} }));

import { splitByPipeline, runExtractRule } from '../pipeline';
import type { ExtractRule } from '../../entities';

function rule(partial: Partial<ExtractRule> & { expression: string }): ExtractRule {
    return {
        id: 'custom',
        name: '自定义',
        type: 'regex',
        enabled: 1,
        ...partial,
    };
}

describe('单层切分管线（内置切分器 + 自定义规则）', () => {
    it('内置链接切分器：散文中命中 ≥2 条链接时按链接出段', () => {
        // 散文占多数（链接覆盖率 < 50%），链接结构层不命中 → 交内置链接切分器
        const content = 'This is a long note about the project background and goals. Reference docs live at '
            + 'https://a.example.com/x and https://b.example.com/y please read them carefully before you start';
        const segs = splitByPipeline(content, []);
        expect(segs.map((s) => s.text)).toEqual([
            'https://a.example.com/x',
            'https://b.example.com/y',
        ]);
        expect(segs.every((s) => s.extractorId === 'url_extract')).toBe(true);
    });

    it('自定义正则规则：无内置命中时按规则提取，片段带规则 id', () => {
        const segs = splitByPipeline('订单 123456 与 654321 已发货', [
            rule({ id: 'order_no', expression: '\\d{6,}' }),
        ]);
        expect(segs.map((s) => s.text)).toEqual(['123456', '654321']);
        expect(segs.every((s) => s.extractorId === 'order_no')).toBe(true);
    });

    it('自定义分隔符规则优先于内置分词兜底', () => {
        const segs = splitByPipeline('甲#乙#丙', [
            rule({ id: 'hash', type: 'separator', expression: '#' }),
        ]);
        expect(segs.map((s) => s.text)).toEqual(['甲', '乙', '丙']);
        expect(segs.every((s) => s.extractorId === 'hash')).toBe(true);
    });

    it('first-match-wins：前一条规则命中后，后续规则不再执行', () => {
        const segs = splitByPipeline('甲#乙#丙 12345 67890', [
            rule({ id: 'first', type: 'separator', expression: '#' }),
            rule({ id: 'second', expression: '\\d{4,}' }),
        ]);
        expect(segs.every((s) => s.extractorId === 'first')).toBe(true);
    });

    it('禁用规则与无效规则不参与切分', () => {
        const segs = splitByPipeline('甲#乙#丙', [
            rule({ id: 'off', type: 'separator', expression: '#', enabled: 0 }),
            rule({ id: 'broken', expression: '(' }),
        ]);
        // 落到内置分词：整段（无逗号/换行）→ 原文单段
        expect(segs).toHaveLength(1);
        expect(segs[0]!.text).toBe('甲#乙#丙');
    });

    it('代码保护：代码相关内容跳过自定义规则与分词，保留原文单段', () => {
        const content = 'const total = items.reduce((a, b) => a + b, 0);';
        const segs = splitByPipeline(content, [
            rule({ id: 'comma', type: 'separator', expression: ',' }),
        ]);
        expect(segs).toHaveLength(1);
        expect(segs[0]!.text).toBe(content);
    });

    it('结构层优先：JSON 内容不进入自定义规则', () => {
        const content = '{"a":1,"b":2}';
        const segs = splitByPipeline(content, [
            rule({ id: 'num', expression: '\\d' }),
        ]);
        expect(segs.map((s) => s.text)).toEqual(['a: 1', 'b: 2']);
        expect(segs.every((s) => s.extractorId === undefined)).toBe(true);
    });

    it('runExtractRule：单条产出少于 2 段视为不命中，异常不抛出', () => {
        expect(runExtractRule(rule({ expression: '\\d+' }), '只有 123 一个')).toBeNull();
        expect(runExtractRule(rule({ expression: '(' }), '123 456')).toBeNull();
    });

    it('runExtractRule：去重并封顶 24 段', () => {
        const repeated = Array.from({ length: 30 }, (_, i) => `v${i}`).join('|');
        const segs = runExtractRule(rule({ type: 'separator', expression: '|' }), repeated);
        expect(segs).toHaveLength(24);
        expect(runExtractRule(rule({ type: 'separator', expression: '|' }), 'a|a|b')).toHaveLength(2);
    });
});
