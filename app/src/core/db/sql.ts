/**
 * 共享 SQL 辅助（core/db）：
 * 多个领域仓储共用的查询拼接工具，自 dbService 原样平移（逻辑不重写）。
 */

/**
 * 流式分页参数：offset 起始偏移，limit 页大小。
 * 传入后查询追加 `LIMIT limit OFFSET offset`；不传则保持原有全量行为。
 */
export interface PageQuery {
    offset: number;
    limit: number;
}

/** 追加 LIMIT/OFFSET 到查询尾部（$1/$2 参数化，配合 params 数组） */
export function withPage(page: PageQuery | undefined, params: unknown[]): { sql: string; params: unknown[] } {
    if (!page) return { sql: '', params };
    return { sql: ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2), params: [...params, page.limit, page.offset] };
}

/** LIKE 通配符转义：搜索词中的 % _ \ 按字面匹配（配合 ESCAPE '\'） */
export function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 高级搜索词元 → LIKE 模式：`*` 映射为任意串通配符（SQL %），其余字符按字面转义。
 * 如 `*小曲` → `%%小曲`（命中"空城计の小曲"）；`50%` → `50\%`（字面百分号）。
 * 仅高级搜索开启时使用；关闭时整串走 escapeLike 纯字面（见 parseSearchTokens）。
 */
export function likePatternFromToken(token: string): string {
    // \0 占位：先摘出 *，转义 % _ \ 后再还原为 %，避免被 escapeLike 误转义
    const STAR = '\u0000';
    return escapeLike(token.split('*').join(STAR)).split(STAR).join('%');
}

/**
 * 搜索输入解析：双引号包裹的短语作为单个词元（短语内空格不拆分、按字面匹配），
 * 其余文本按空白拆分为多词 AND；未成对的引号视为普通字符参与字面匹配。
 * advanced=false（关闭高级搜索）：整串 trim 后作为单个字面词元，无任何语法含义。
 * SQL 拆词与前端高亮必须共用本函数（传同一 advanced 值），保证"搜什么就高亮什么"。
 */
export function parseSearchTokens(input: string, advanced = true): string[] {
    if (!advanced) {
        const raw = (input ?? '').trim();
        return raw ? [raw] : [];
    }
    const tokens: string[] = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input ?? '')) !== null) {
        const tok = m[1] ?? m[2];
        if (tok) tokens.push(tok);
    }
    return tokens;
}
