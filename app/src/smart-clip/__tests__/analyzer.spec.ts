import { describe, it, expect } from 'vitest';
import { analyzeVerdict } from '../analyzer';

/** 用户实际粘贴的说明文：含顿号/分号/逗号，此前被分隔符层判为 structured 而永远跳过 AI */
const RELEASE_NOTES =
    '我们的发布流程分为三段：提交前本地自测、合并前 CI 校验、合并后灰度发布。本地自测要求跑通单元测试与静态检查；CI 会额外执行端到端用例与依赖漏洞扫描；灰度发布按 1%、10%、100% 三档放量，每档观察 30 分钟错误率与延迟。';

describe('analyzeVerdict 分流（分隔符/多行放行）', () => {
    it('含顿号/分号/逗号的说明文进入散文分支，可送 AI', () => {
        expect(analyzeVerdict(RELEASE_NOTES, 1000).verdict).toBe('prose');
    });

    it('多行自然语言分段同样进入散文分支', () => {
        const text = `${RELEASE_NOTES}\n${RELEASE_NOTES}`;
        expect(analyzeVerdict(text, 10000).verdict).toBe('prose');
    });

    it('机器结构（JSON）仍判结构化，不送 AI', () => {
        const json = '{"name":"demo","steps":["build","test"],"retry":3}';
        expect(analyzeVerdict(json, 1000)).toEqual({ verdict: 'structured', layer: 'json' });
    });

    it('代码内容仍被技术工件拦截', () => {
        const code = [
            'function greet(name) {',
            '  // 打招呼',
            '  const msg = `hello ${name}`;',
            '  return msg;',
            '}',
        ].join('\n');
        expect(analyzeVerdict(code, 1000).verdict).toBe('tech');
    });

    it('纯数字噪声 / 超长 / 过短分支保持原样', () => {
        expect(analyzeVerdict('123 456 789 000 111 222', 1000).verdict).toBe('noise');
        expect(analyzeVerdict(RELEASE_NOTES, 50).verdict).toBe('too_long');
        expect(analyzeVerdict('好的', 1000).verdict).toBe('too_short');
    });
});

describe('analyzeVerdict 长度边界（防误判）', () => {
    it('完整说明文（117 字）必须进散文分支，不得判过短', () => {
        expect(RELEASE_NOTES.length).toBeGreaterThanOrEqual(100);
        expect(analyzeVerdict(RELEASE_NOTES, 1000).verdict).toBe('prose');
    });

    it('阈值边界：恰好 20 字进散文，19 字判过短', () => {
        expect(analyzeVerdict('测'.repeat(20), 1000).verdict).toBe('prose');
        expect(analyzeVerdict('测'.repeat(19), 1000).verdict).toBe('too_short');
    });

    it('首尾空白 / BOM / 零宽字符不影响长度判定（sanitize 后仍按原文算）', () => {
        const wrapped = `\uFEFF\u200B  ${RELEASE_NOTES}\n\n`;
        expect(analyzeVerdict(wrapped, 1000).verdict).toBe('prose');
    });

    it('长度恰好等于上限不算超长', () => {
        expect(analyzeVerdict(RELEASE_NOTES, RELEASE_NOTES.length).verdict).toBe('prose');
        expect(analyzeVerdict(RELEASE_NOTES, RELEASE_NOTES.length - 1).verdict).toBe('too_long');
    });

    it('回归：19 字灵动岛提示原文确实判过短（当时剪贴板里是它）', () => {
        const islandText = '剪贴板图片未识别到二维码，暂不支持提取';
        expect(islandText.length).toBe(19);
        expect(analyzeVerdict(islandText, 1000).verdict).toBe('too_short');
    });
});
