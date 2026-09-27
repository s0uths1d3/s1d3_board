import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import HighlightText from '../HighlightText.vue';

/**
 * 搜索高亮渲染组件测试（搜索筛选的呈现侧）：
 * 解析逻辑 parseSearchTokens 已有 sql.spec.ts 纯函数层覆盖，
 * 此处验证「tokens → 分片 DOM」的组件行为：
 * - 高亮片段 = <span class="rounded bg-gold/30 text-ink">（模板中唯一的 span）
 * - 普通片段 = 纯文本节点（无 span 包裹）
 *
 * 组件根为 fragment（template v-for），wrapper.text() 对相邻文本节点
 * 拼接时会丢失首尾空格——全文断言统一走 document.body.textContent
 * （attachTo 挂载，文本节点原样拼接）。
 */

const mountHl = (text: string, highlightString: string, active = true, advanced = true) =>
    mount(HighlightText, { props: { text, highlightString, active, advanced }, attachTo: document.body });

/** 高亮片段文本列表（按出现顺序） */
const highlights = (wrapper: ReturnType<typeof mount>) =>
    wrapper.findAll('span').map((s) => s.text());

/** body 全文（含普通片段与高亮片段的原文拼接） */
const bodyText = () => document.body.textContent ?? '';

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('HighlightText 搜索高亮渲染', () => {
    it('未开启高亮（active=false）：整段单片段，无高亮 span', () => {
        const w = mountHl('hello world', 'hello', false);
        expect(w.findAll('span')).toHaveLength(0);
        expect(bodyText()).toBe('hello world');
    });

    it('无搜索词：无高亮 span，全文渲染', () => {
        const w = mountHl('hello world', '', true);
        expect(w.findAll('span')).toHaveLength(0);
        expect(bodyText()).toBe('hello world');
    });

    it('空文本：渲染为空', () => {
        mountHl('', 'x', true);
        expect(bodyText()).toBe('');
    });

    it('单词命中：命中段高亮，前后普通片段保留空格', () => {
        const w = mountHl('the quick brown fox', 'quick');
        expect(highlights(w)).toEqual(['quick']);
        expect(bodyText()).toBe('the quick brown fox');
    });

    it('多词命中：多个高亮片段按出现顺序排列', () => {
        const w = mountHl('foo bar baz', 'foo baz');
        expect(highlights(w)).toEqual(['foo', 'baz']);
        expect(bodyText()).toBe('foo bar baz');
    });

    it('大小写不敏感：命中段保留原文大小写', () => {
        const w = mountHl('Hello WORLD', 'world');
        expect(highlights(w)).toEqual(['WORLD']);
    });

    it('正则元字符按字面匹配：不误配不抛错', () => {
        const w = mountHl('a.b (c) [d]', 'a.b');
        expect(highlights(w)).toEqual(['a.b']);
        expect(bodyText()).toBe('a.b (c) [d]');
    });

    it('高级搜索 * 通配符：跨字符匹配整段', () => {
        const w = mountHl('foo123bar', 'foo*bar');
        expect(highlights(w)).toEqual(['foo123bar']);
    });

    it('引号短语作为整句词元（短语内空格不拆分）', () => {
        const w = mountHl('say hello world now', '"hello world"');
        expect(highlights(w)).toEqual(['hello world']);
    });

    it('搜索词全为通配符：贪婪匹配高亮整段（与 SQL LIKE % 语义一致），尾部空匹配不死循环', () => {
        const w = mountHl('abc', '*');
        expect(highlights(w)).toEqual(['abc']);
        expect(bodyText()).toBe('abc');
    });
});
