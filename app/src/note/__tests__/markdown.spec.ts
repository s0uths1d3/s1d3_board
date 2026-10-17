import { describe, expect, it } from 'vitest';
import { renderNote, toggleChecklistLine, countNoteChars } from '../markdown';

describe('renderNote：行类型解析', () => {
    it('标题 / 清单 / 列表 / 文本 / 空行 分型正确', () => {
        const { lines } = renderNote('# 标题一\n## 标题二\n- [ ] 待办项\n- [x] 已完成\n- 普通列表\n普通文本\n\n尾行');
        expect(lines.map(l => l.kind)).toEqual(['heading', 'heading', 'checklist', 'checklist', 'list', 'text', 'empty', 'text']);
        expect(lines[0]).toMatchObject({ level: 1, tokens: [{ type: 'text', text: '标题一' }] });
        expect(lines[2]).toMatchObject({ checked: false });
        expect(lines[3]).toMatchObject({ checked: true });
        // srcIndex 与源行号一致（勾选写回按此定位）
        expect(lines.map(l => (l as { srcIndex?: number }).srcIndex ?? -1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('行内语法：粗体 / 斜体 / 删除线 / 行内代码', () => {
        const { lines } = renderNote('**粗**与*斜*与~~删~~与`code`尾');
        const tokens = (lines[0] as { tokens: { type: string; text: string }[] }).tokens;
        expect(tokens.map(t => `${t.type}:${t.text}`)).toEqual([
            'bold:粗', 'text:与', 'italic:斜', 'text:与', 'strike:删', 'text:与', 'code:code', 'text:尾',
        ]);
    });

    it('行内代码内部不解析其余语法', () => {
        const { lines } = renderNote('`**不是粗体**`');
        const tokens = (lines[0] as { tokens: { type: string; text: string }[] }).tokens;
        expect(tokens).toEqual([{ type: 'code', text: '**不是粗体**' }]);
    });

    it('未闭合标记按普通文本处理', () => {
        const { lines } = renderNote('**未闭合与*斜体*正常');
        const tokens = (lines[0] as { tokens: { type: string; text: string }[] }).tokens;
        // ** 未闭合 → 保留 ** 文本；其后独立 *斜体* 正常解析
        expect(tokens.some(t => t.type === 'text' && t.text.startsWith('**未闭合'))).toBe(true);
        expect(tokens.some(t => t.type === 'italic' && t.text === '斜体')).toBe(true);
    });

    it('搜索高亮注入：大小写不敏感、跨 token 生效', () => {
        const { lines } = renderNote('Abc 与 **Abd**', 'ab');
        const all = lines.flatMap(l => (l.kind === 'empty' ? [] : (l as { tokens: { hl?: boolean; text: string }[] }).tokens));
        expect(all.filter(t => t.hl).map(t => t.text)).toEqual(['Ab', 'Ab']);
    });
});

describe('toggleChecklistLine：勾选写回', () => {
    it('[ ] 与 [x] 互切，其余行不动', () => {
        const src = '- [ ] 甲\n普通\n- [x] 乙';
        expect(toggleChecklistLine(src, 0)).toBe('- [x] 甲\n普通\n- [x] 乙');
        expect(toggleChecklistLine(src, 2)).toBe('- [ ] 甲\n普通\n- [ ] 乙');
    });

    it('星号清单与大小写 X 兼容', () => {
        expect(toggleChecklistLine('* [X] 项', 0)).toBe('- [ ] 项');
        expect(toggleChecklistLine('* [ ] 项', 0)).toBe('- [x] 项');
    });

    it('行号越界 / 非清单行原样返回', () => {
        const src = '普通行';
        expect(toggleChecklistLine(src, 0)).toBe(src);
        expect(toggleChecklistLine(src, 99)).toBe(src);
    });
});

describe('countNoteChars：字数', () => {
    it('CJK 逐字、拉丁连词、标点空白不计', () => {
        expect(countNoteChars('你好 world 123，!')).toBe(12); // 非空白逐字：你好(2)+world(5)+123(3)+，(1)+!(1)
        expect(countNoteChars('222222222222')).toBe(12); // 连续相同字符逐个计（词合并口径的历史 bug）
        expect(countNoteChars('  \n ')).toBe(0); // 空白不计
        expect(countNoteChars('')).toBe(0);
    });
});
