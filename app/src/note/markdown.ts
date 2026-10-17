/**
 * 便签轻量渲染层（便签 §3 清单模式 / §8 轻量格式）：
 * content 保持纯文本（Markdown 惯用语法），仅展示增强——手写轻量解析，不引入 markdown-it。
 *
 * 支持语法（子集）：
 * - 标题：`# ` / `## ` / `### `（行首）
 * - 清单：`- [ ] ` 未完成 / `- [x] ` 已完成（`*` 亦可）
 * - 普通列表：`- ` / `* `
 * - 行内：`**粗体**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``
 *
 * 渲染产出 token 数组（非 HTML 字符串），由模板直接渲染——无 v-html、无 XSS 面。
 * 搜索高亮作为第二 pass 注入 token（大小写不敏感整词不限制，与 HighlightText 观感一致）。
 */

/** 行内 token：type 决定包裹元素；hl=true 的片段包搜索高亮底色 */
export interface InlineToken {
    type: 'text' | 'bold' | 'italic' | 'strike' | 'code';
    text: string;
    hl?: boolean;
}

/** 行类型：heading 标题 / list 普通列表项 / checklist 勾选行（checked 状态）/ text 普通段 / empty 空行 */
export type NoteLine =
    | { kind: 'heading'; level: 1 | 2 | 3; tokens: InlineToken[]; srcIndex: number }
    | { kind: 'list'; tokens: InlineToken[]; srcIndex: number }
    | { kind: 'checklist'; checked: boolean; tokens: InlineToken[]; srcIndex: number }
    | { kind: 'text'; tokens: InlineToken[]; srcIndex: number }
    | { kind: 'empty'; srcIndex: number };

export interface RenderedNote {
    lines: NoteLine[];
    /** 字数（CJK 按字符、连续拉丁按词），卡片右下角展示 */
    charCount: number;
}

/** 清单行前缀：匹配 `- [ ] ` / `- [x] ` / `* [ ] ` / `* [x] `（大小写 X 兼容），捕获勾选态与其余文本 */
const CHECK_RE = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/;
const LIST_RE = /^\s*[-*]\s+(?!\[)(.*)$/;
const HEADING_RE = /^\s*(#{1,3})\s+(.*)$/;

/** 行内语法解析：先切行内代码（内部不再解析其余语法），再依次 bold → strike → italic */
function tokenizeInline(text: string): InlineToken[] {
    const out: InlineToken[] = [];
    // 行内代码分段（`...` 不嵌套）
    const codeParts = text.split(/(`[^`]*`)/g);
    for (const part of codeParts) {
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
            if (part.length > 2) out.push({ type: 'code', text: part.slice(1, -1) });
            continue;
        }
        // 递归拆 bold（**x**）→ strike（~~x~~）→ italic（*x*）
        tokenizeMarks(part, out);
    }
    return out;
}

function tokenizeMarks(text: string, out: InlineToken[]) {
    // 匹配最早出现的标记对：**bold** / ~~strike~~ / *italic*
    // italic 两侧加 lookbehind/lookahead 排除 **（未闭合的 ** 与斜体不互相误配）
    const MARK = /\*\*([^*]+)\*\*|~~([^~]+)~~|(?<!\*)\*([^*\s][^*]*?)\*(?!\*)/;
    let rest = text;
    for (;;) {
        const m = rest.match(MARK);
        if (!m || m.index === undefined) break;
        if (m.index > 0) out.push({ type: 'text', text: rest.slice(0, m.index) });
        if (m[1] !== undefined) out.push({ type: 'bold', text: m[1] });
        else if (m[2] !== undefined) out.push({ type: 'strike', text: m[2] });
        else if (m[3] !== undefined) out.push({ type: 'italic', text: m[3] });
        rest = rest.slice(m.index + m[0].length);
    }
    if (rest) out.push({ type: 'text', text: rest });
}

/** 高亮注入 pass：对每个 token 的 text 按关键词分段（大小写不敏感），命中片段标 hl */
function applyHighlight(tokens: InlineToken[], highlight: string): InlineToken[] {
    const q = highlight.trim();
    if (!q) return tokens;
    const lower = q.toLowerCase();
    const out: InlineToken[] = [];
    for (const tk of tokens) {
        let rest = tk.text;
        for (;;) {
            const idx = rest.toLowerCase().indexOf(lower);
            if (idx < 0) break;
            if (idx > 0) out.push({ ...tk, text: rest.slice(0, idx), hl: undefined });
            out.push({ ...tk, text: rest.slice(idx, idx + q.length), hl: true });
            rest = rest.slice(idx + q.length);
        }
        if (rest) out.push({ ...tk, text: rest, hl: undefined });
    }
    return out;
}

/** 字数 = 非空白字符逐个计数（中英文/数字/标点/emoji 同权），与「N 字」文案的字符直觉一致 */
export function countNoteChars(content: string): number {
    let count = 0;
    for (const ch of content) {
        if (/\S/.test(ch)) count += 1;
    }
    return count;
}

/** 主入口：content → 行结构 + 字数；highlight 非空时注入搜索高亮 */
export function renderNote(content: string, highlight = ''): RenderedNote {
    const rawLines = content.split('\n');
    const lines: NoteLine[] = rawLines.map((raw, srcIndex) => {
        const heading = raw.match(HEADING_RE);
        if (heading && heading[1] && heading[2] !== undefined) {
            return { kind: 'heading', level: heading[1].length as 1 | 2 | 3, tokens: applyHighlight(tokenizeInline(heading[2]), highlight), srcIndex };
        }
        const check = raw.match(CHECK_RE);
        if (check && check[2] !== undefined) {
            return { kind: 'checklist', checked: check[1] !== ' ', tokens: applyHighlight(tokenizeInline(check[2]), highlight), srcIndex };
        }
        const list = raw.match(LIST_RE);
        if (list && list[1] !== undefined && raw.trim() !== '') {
            return { kind: 'list', tokens: applyHighlight(tokenizeInline(list[1]), highlight), srcIndex };
        }
        if (raw.trim() === '') return { kind: 'empty', srcIndex };
        return { kind: 'text', tokens: applyHighlight(tokenizeInline(raw), highlight), srcIndex };
    });
    return { lines, charCount: countNoteChars(content) };
}

/**
 * 勾选切换：把第 srcIndex 行（源行号）在 `[ ]`/`[x]` 间改写（大小写 X 统一为 x）。
 * 行号无效或该行不是清单行时原样返回（调用方据此跳过保存）。
 */
export function toggleChecklistLine(content: string, srcIndex: number): string {
    const lines = content.split('\n');
    const line = lines[srcIndex];
    if (line === undefined) return content;
    const check = line.match(CHECK_RE);
    if (!check || check[2] === undefined) return content;
    const next = check[1] === ' ' ? 'x' : ' ';
    lines[srcIndex] = line.replace(CHECK_RE, (_m, _c, body) => `- [${next}] ${body}`);
    return lines.join('\n');
}
