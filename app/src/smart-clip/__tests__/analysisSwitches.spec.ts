import { describe, it, expect } from 'vitest';
import {
    clampKeywordsMax,
    clampKeywordsMin,
    KEYWORDS_MAX_DEFAULT,
    KEYWORDS_MIN_DEFAULT,
    normalizeKeywordRange,
    parseAnalysisOutput,
} from '../analysis';

describe('关键词数量范围', () => {
    it('默认上限 16、下限 3；非法输入回落默认值', () => {
        expect(KEYWORDS_MAX_DEFAULT).toBe(16);
        expect(KEYWORDS_MIN_DEFAULT).toBe(3);
        expect(clampKeywordsMax(undefined)).toBe(16);
        expect(clampKeywordsMax('abc')).toBe(16);
        expect(clampKeywordsMax('0')).toBe(16);
        expect(clampKeywordsMin(null)).toBe(3);
    });

    it('钳制到 1–18：上限 18 保护环盘 24 段容量', () => {
        expect(clampKeywordsMax(99)).toBe(18);
        expect(clampKeywordsMax('8')).toBe(8);
        expect(clampKeywordsMin(99)).toBe(18);
        expect(clampKeywordsMin('5')).toBe(5);
        expect(clampKeywordsMin(0)).toBe(3);
    });

    it('区间归一：下限不得超过上限', () => {
        expect(normalizeKeywordRange(2, 10)).toEqual({ min: 2, max: 10 });
        expect(normalizeKeywordRange(12, 6)).toEqual({ min: 6, max: 6 });
        expect(normalizeKeywordRange(undefined, undefined)).toEqual({ min: 3, max: 16 });
    });
});

describe('按开关模式裁剪 AI 产出', () => {
    const raw = '{"keywords":["甲","乙"],"bullets":["要点一"],"summary":"一句总结"}';

    it('both：关键词、要点、总结全保留', () => {
        expect(parseAnalysisOutput(raw, 'both', 16)).toEqual({
            keywords: ['甲', '乙'],
            bullets: ['要点一'],
            summary: '一句总结',
        });
    });

    it('keywords：丢弃总结字段', () => {
        expect(parseAnalysisOutput(raw, 'keywords', 16)).toEqual({
            keywords: ['甲', '乙'],
            bullets: ['要点一'],
            summary: '',
        });
    });

    it('summary：只保留总结字段', () => {
        expect(parseAnalysisOutput(raw, 'summary', 16)).toEqual({
            keywords: [],
            bullets: [],
            summary: '一句总结',
        });
    });

    it('关键词按设置上限截断（不再固定 5 条）', () => {
        const eight = '{"keywords":["1","2","3","4","5","6","7","8"],"summary":""}';
        expect(parseAnalysisOutput(eight, 'keywords', 6)?.keywords).toHaveLength(6);
        expect(parseAnalysisOutput(eight, 'keywords', 16)?.keywords).toHaveLength(8);
    });

    it('模式裁剪后无任何字段 = 无效产出（按失败处理）', () => {
        const onlyKeywords = '{"keywords":["甲"]}';
        expect(parseAnalysisOutput(onlyKeywords, 'summary', 16)).toBeNull();
        expect(parseAnalysisOutput('not json', 'both', 16)).toBeNull();
        expect(parseAnalysisOutput('{}', 'both', 16)).toBeNull();
    });
});
