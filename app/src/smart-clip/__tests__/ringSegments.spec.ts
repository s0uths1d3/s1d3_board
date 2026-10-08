import { describe, expect, it } from 'vitest';
import {
    blankNormalize,
    buildSeen,
    mergeAiSegments,
    normalizeSegments,
    ringPageCount,
    ringPageRange,
    RING_MAX_SEGMENTS,
    RING_PAGE_SIZE,
} from '../ringSegments';

describe('blankNormalize', () => {
    it('折叠空白并去首尾', () => {
        expect(blankNormalize('  a\r\nb\t c  ')).toBe('a b c');
    });

    it('纯空白归一为空串', () => {
        expect(blankNormalize(' \r\n\t ')).toBe('');
    });
});

describe('normalizeSegments', () => {
    it('trim、丢弃空片段并保留提取器 id', () => {
        expect(normalizeSegments([
            { text: '  hello  ' },
            { text: '', extractorId: 'x' },
            { text: 'world', extractorId: 'kw' },
        ])).toEqual([
            { text: 'hello', extractorId: '' },
            { text: 'world', extractorId: 'kw' },
        ]);
    });

    it('空白差异不判等为重复（Windows 剪贴板场景）', () => {
        expect(normalizeSegments([
            { text: 'a  b\r\nc' },
            { text: 'a b c' },
        ])).toEqual([{ text: 'a  b\r\nc', extractorId: '' }]);
    });

    it('封顶 cap：超出部分丢弃', () => {
        const raw = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}` }));
        expect(normalizeSegments(raw, 3)).toHaveLength(3);
    });

    it('默认封顶 RING_MAX_SEGMENTS', () => {
        const raw = Array.from({ length: RING_MAX_SEGMENTS + 5 }, (_, i) => ({ text: `t${i}` }));
        expect(normalizeSegments(raw)).toHaveLength(RING_MAX_SEGMENTS);
    });
});

describe('mergeAiSegments', () => {
    const base = normalizeSegments([{ text: '本地 片段' }, { text: '另一段' }]);

    it('AI 产出去重后追加，标记 ai-analysis', () => {
        const added = mergeAiSegments(base, { keywords: ['关键词'], summary: '一句话总结' });
        expect(added).toEqual([
            { text: '关键词', extractorId: 'ai-analysis' },
            { text: '一句话总结', extractorId: 'ai-analysis' },
        ]);
    });

    it('与基础片段重复（含空白差异）的产出被过滤', () => {
        const added = mergeAiSegments(base, { keywords: ['本地  片段', '新词'], summary: '另一段 ' });
        expect(added).toEqual([{ text: '新词', extractorId: 'ai-analysis' }]);
    });    it('关键词之间互判重复', () => {
        const added = mergeAiSegments([], { keywords: ['a', 'a '], summary: '' });
        expect(added).toHaveLength(1);
    });

    it('总长度封顶：不把基础列表挤超 cap', () => {
        const near = normalizeSegments([{ text: 'x' }], 1);
        const added = mergeAiSegments(near, { keywords: ['k1', 'k2'], summary: 's' }, 2);
        expect(added).toEqual([{ text: 'k1', extractorId: 'ai-analysis' }]);
    });

    it('空关键词与空总结产出为空', () => {
        expect(mergeAiSegments(base, { keywords: [], summary: '' })).toEqual([]);
    });
});

describe('buildSeen', () => {
    it('空白归一化后构建键集合', () => {
        expect(buildSeen([{ text: ' a b', extractorId: '' }, { text: 'c', extractorId: '' }]))
            .toEqual(new Set(['a b', 'c']));
    });
});

describe('分页计算', () => {
    it('页数向上取整且至少 1 页', () => {
        expect(ringPageCount(0)).toBe(1);
        expect(ringPageCount(1)).toBe(1);
        expect(ringPageCount(RING_PAGE_SIZE)).toBe(1);
        expect(ringPageCount(RING_PAGE_SIZE + 1)).toBe(2);
        expect(ringPageCount(RING_MAX_SEGMENTS)).toBe(3);
    });

    it('页区间 [start, end) 按页尺寸切分', () => {
        expect(ringPageRange(20, 0)).toEqual([0, 8]);
        expect(ringRangeEquals(ringPageRange(20, 1), 8, 16)).toBe(true);
        expect(ringPageRange(20, 2)).toEqual([16, 20]);
    });

    it('页码越界钳制到最后一页', () => {
        expect(ringPageRange(20, 99)).toEqual([16, 20]);
        expect(ringPageRange(20, -1)).toEqual([0, 8]);
    });
});

function ringRangeEquals(range: [number, number], start: number, end: number): boolean {
    return range[0] === start && range[1] === end;
}
