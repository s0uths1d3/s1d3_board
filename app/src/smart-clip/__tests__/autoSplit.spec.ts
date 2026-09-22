import { describe, expect, it } from 'vitest';
import {
    autoSplit,
    codeTokenRatio,
    detectStructured,
    isCodeRelated,
    isSimpleWords,
    sanitize,
} from '../autoSplit';
import type { Segment } from '../types';

/** 提取纯文本序列，便于断言切分结果 */
function texts(segments: Segment[]): string[] {
    return segments.map((s) => s.text);
}

// ---------------------------------------------------------------------------
// sanitize：BOM / 零宽字符清洗
// ---------------------------------------------------------------------------
describe('sanitize', () => {
    it('清除 BOM 与零宽字符并修剪首尾空白', () => {
        expect(sanitize('\uFEFF hello \u200Bworld\u200D ')).toBe('hello world');
    });
});

// ---------------------------------------------------------------------------
// 结构化分层（JSON > 链接 > 日志 > 路径 > 多行 > 分隔符）
// ---------------------------------------------------------------------------
describe('autoSplit 结构层', () => {
    it('JSON 对象拆为「键: 值」对', () => {
        expect(texts(autoSplit('{"a": "hello", "b": 2}'))).toEqual(['a: hello', 'b: 2']);
    });

    it('双链接且覆盖大半文本 → 提取链接项', () => {
        const content = 'visit https://a.com and https://b.com now';
        expect(texts(autoSplit(content))).toEqual(['https://a.com', 'https://b.com']);
    });

    it('日志行拆出 时间/来源/级别/错误码/消息', () => {
        const content = '[2026-09-22 10:00:00][auth][ERROR] Login failed code=0x80070005';
        expect(texts(autoSplit(content))).toEqual([
            '2026-09-22 10:00:00',
            'auth',
            'ERROR',
            '0x80070005',
            'Login failed code=0x80070005',
        ]);
    });

    it('路径按分隔符拆层级，盘符并入首段', () => {
        expect(texts(autoSplit('e:\\dev\\s1d3\\app\\utils\\aiError.ts'))).toEqual([
            'e:\\dev',
            's1d3',
            'app',
            'utils',
            'aiError.ts',
        ]);
    });

    it('多行文本逐行成段', () => {
        expect(texts(autoSplit('line one\nline two'))).toEqual(['line one', 'line two']);
    });

    it('逗号分隔文本按顶层切分', () => {
        expect(texts(autoSplit('apple, banana, cherry'))).toEqual(['apple', 'banana', 'cherry']);
    });

    it('引号内的逗号不当分隔点（深度感知）', () => {
        expect(texts(autoSplit('Error("a, b"), code'))).toEqual(['Error("a, b")', 'code']);
    });

    it('detectStructured 各层命中判定', () => {
        expect(detectStructured('{"a": 1, "b": 2}')).toBe('json');
        expect(detectStructured('e:\\dev\\s1d3\\app\\utils\\aiError.ts')).toBe('path');
        expect(detectStructured('line one\nline two')).toBe('multiline');
    });

    it('detectStructured：多行但平均行长超 60 视为分段散文（非结构化）', () => {
        const long1 = 'x'.repeat(70);
        const long2 = 'y'.repeat(70);
        expect(detectStructured(`${long1}\n${long2}`)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 分流与兜底（简单词串 / 代码 / 关键词 / 超长分块 / 单段）
// ---------------------------------------------------------------------------
describe('autoSplit 分流与兜底', () => {
    it('isSimpleWords：无句读短词串判定', () => {
        expect(isSimpleWords('hello world foo')).toBe(true);
        expect(isSimpleWords('hello.')).toBe(false);
        expect(isSimpleWords('hello')).toBe(false);
        expect(isSimpleWords('a'.repeat(60))).toBe(false);
    });

    it('简单词串按空白直拆', () => {
        expect(texts(autoSplit('alpha beta gamma'))).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('代码内容不分词，保持原文单段', () => {
        const segments = autoSplit('const user_name = getValue();');
        expect(segments).toHaveLength(1);
        expect(segments[0]?.text).toBe('const user_name = getValue();');
        expect(segments[0]?.source).toBe('auto');
    });

    it('单链接不拆分（链接层需 ≥2 个命中）', () => {
        expect(texts(autoSplit('https://a.com'))).toEqual(['https://a.com']);
    });

    it('含句读的长散文提取高频关键词（Kubernetes/node 各 3 次）', () => {
        const content =
            'Kubernetes deploy failed because the node was not ready. '
            + 'The Kubernetes node was NotReady. '
            + 'Kubernetes requires the node ready state before scheduling pods.';
        expect(texts(autoSplit(content))).toEqual(['Kubernetes', 'node']);
    });

    it('超 1000 字无结构单块按句读/空白边界分块', () => {
        // 1200 字输入经 sanitize 去尾部空格后为 1199 字，分块 300+300+599
        const segments = autoSplit('abc '.repeat(300));
        expect(segments).toHaveLength(3);
        expect(segments[0]?.text).toHaveLength(300);
        expect(segments[1]?.text).toHaveLength(300);
        expect(segments[2]?.text).toHaveLength(599);
    });

    it('超 24 段封顶：超出部分并入末段不丢内容', () => {
        const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
        const segments = autoSplit(content);
        expect(segments).toHaveLength(24);
        expect(segments[23]?.text).toContain(' ');
        expect(segments[23]?.text.startsWith('line23 ')).toBe(true);
    });

    it('空白输入降级为原文单段，不抛错', () => {
        expect(autoSplit('   ')).toHaveLength(1);
    });

    it('括号引号未闭合等异常输入不抛错，至少返回单段', () => {
        const segments = autoSplit('(((("unclosed');
        expect(segments.length).toBeGreaterThanOrEqual(1);
    });

    it('片段 index 连续且 source=auto', () => {
        const segments = autoSplit('apple, banana, cherry');
        expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
        expect(segments.every((s) => s.source === 'auto')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// 代码相关性判定（预判 tech、跳过分词的依据）
// ---------------------------------------------------------------------------
describe('代码相关性', () => {
    it('codeTokenRatio：普通词串为 0，snake_case 计入', () => {
        expect(codeTokenRatio('foo bar')).toBe(0);
        expect(codeTokenRatio('user_name foo')).toBe(0.5);
    });

    it('isCodeRelated：代码形态 token 占比 ≥20% 判真', () => {
        expect(isCodeRelated('const x = 1;')).toBe(true);
        expect(isCodeRelated('hello world')).toBe(false);
    });
});
