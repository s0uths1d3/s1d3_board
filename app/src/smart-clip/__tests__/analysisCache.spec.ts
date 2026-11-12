import { describe, it, expect } from 'vitest';
import { decodeAnalysisCache, encodeAnalysisCache, normalizeAnalysisFields } from '../analysisCache';
import { contentFingerprint, hashText } from '../../../utils/hash';

const RESULT = { keywords: ['剪贴板', '分析'], bullets: ['要点'], summary: '一句话总结' };

describe('分析缓存归属校验', () => {
    it('内容指纹：稳定且随内容变化（同时混合长度）', () => {
        expect(contentFingerprint('hello')).toBe(contentFingerprint('hello'));
        expect(contentFingerprint('hello')).not.toBe(contentFingerprint('hellO'));
        expect(contentFingerprint('hello')).not.toBe(contentFingerprint('hello '));
        expect(contentFingerprint('')).toContain('-0');
    });

    it('信封往返：当前内容读回自身结果', () => {
        const raw = encodeAnalysisCache('今天下午三点开会讨论项目排期', RESULT);
        expect(decodeAnalysisCache(raw, '今天下午三点开会讨论项目排期')).toEqual(RESULT);
    });

    it('内容不符：即便 hash 键相同也拒绝（归属校验否决碰撞）', () => {
        const content = '今天下午三点开会讨论项目排期';
        const raw = encodeAnalysisCache(content, RESULT);
        expect(decodeAnalysisCache(raw, '明天下午三点开会讨论项目排期')).toBeNull();
    });

    it('旧格式（无归属信封）一律按未命中处理', () => {
        expect(decodeAnalysisCache(JSON.stringify(RESULT), '今天下午三点开会讨论项目排期')).toBeNull();
    });

    it('信封被篡改（长度/首尾采样）即拒绝', () => {
        const content = '今天下午三点开会讨论项目排期';
        const raw = JSON.parse(encodeAnalysisCache(content, RESULT));
        expect(decodeAnalysisCache(JSON.stringify({ ...raw, len: raw.len + 1 }), content)).toBeNull();
        expect(decodeAnalysisCache(JSON.stringify({ ...raw, head: '别的开头' }), content)).toBeNull();
        expect(decodeAnalysisCache(JSON.stringify({ ...raw, tail: '别的结尾' }), content)).toBeNull();
    });

    it('损坏 JSON / 空产出：不命中', () => {
        expect(decodeAnalysisCache('not json', 'x')).toBeNull();
        const raw = encodeAnalysisCache('内容内容内容内容内容', { keywords: [], bullets: [], summary: '' });
        expect(decodeAnalysisCache(raw, '内容内容内容内容内容')).toBeNull();
    });

    it('字段清洗：去空、去脱敏占位符、关键词按上限封顶、要点固定 5 条', () => {
        const parsed = normalizeAnalysisFields({
            keywords: ['k1', ' ', 'k2', '[REDACTED]', 'k3', 'k4', 'k5', 'k6'],
            bullets: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
            summary: ' s ',
        }, 3);
        expect(parsed).toEqual({
            keywords: ['k1', 'k2', 'k3'],
            bullets: ['b1', 'b2', 'b3', 'b4', 'b5'],
            summary: 's',
        });
        // 未传上限时按兜底上限（20）保留，不再固定截断为 5 条
        expect(normalizeAnalysisFields({ keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'] })?.keywords).toHaveLength(6);
    });

    it('习惯分组用的 hashText 仍保持原有语义（未被指纹替换）', () => {
        expect(hashText('abc')).toBe(hashText('abc'));
        expect(hashText('abc')).not.toBe(contentFingerprint('abc'));
    });
});
