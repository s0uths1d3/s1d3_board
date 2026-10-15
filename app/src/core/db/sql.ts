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
 * 高级搜索词元 → LIKE 模式：`*` 映射为任意串通配符（SQL %）、`?` 映射为单字符通配符（SQL _），
 * 其余字符按字面转义。
 * 如 `*小曲` → `%%小曲`（命中"空城计の小曲"）；`第?章` → `第_章`；`50%` → `50\%`（字面百分号）。
 * 仅高级搜索开启时使用；关闭时整串走 escapeLike 纯字面（见 parseSearchTokens）。
 */
export function likePatternFromToken(token: string): string {
    // \0/\1 占位：先摘出 * ?，转义 % _ \ 后再还原为 % _，避免被 escapeLike 误转义
    const STAR = '\u0000';
    const QMARK = '\u0001';
    return escapeLike(token.split('*').join(STAR).split('?').join(QMARK))
        .split(STAR).join('%')
        .split(QMARK).join('_');
}

/**
 * 搜索输入 → SQL LIKE 条件与参数（待办/便签搜索共用，剪贴板为跨列 OR 自行拼接）：
 * 组内 OR、组间 AND（与 parseSearchTokens 分组语义对应）。advanced=false 时整串
 * 字面单词元（同剪贴板「关闭高级搜索」语义）。field 为 LIKE 左侧列名，
 * 占位符按拼接顺序从 $1 编号——调用方的其他条件须拼在其后（withPage 追加分页参数亦然）。
 */
export function buildLikeGroups(input: string, field: string, advanced = true): { sql: string; params: string[] } {
    const groups = parseSearchTokens(input, advanced).map((group) =>
        group.map((kw) => (advanced ? likePatternFromToken(kw) : escapeLike(kw))),
    );
    const params: string[] = [];
    const conds = groups.map((group) => {
        const parts = group.map((pattern) => {
            params.push(`%${pattern}%`);
            return `${field} LIKE $${params.length} ESCAPE '\\'`;
        });
        return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
    });
    return { sql: conds.join(' AND '), params };
}

/**
 * 搜索输入解析（OR 分组）：
 * - 返回分组列表：组内任一词元命中即可（OR），组与组之间需全部命中（AND）；
 * - 双引号短语为单词元（短语内空格与 | 均按字面），可作为 | 的操作数；
 * - 引号外的 | 为 OR 分隔符（可独立成词，也可紧贴词元，如 `小曲 | 空城`、`小曲|空城`）；
 *   缺少操作数的孤立 |（开头/结尾/连续）忽略；
 * - 未成对的引号视为普通字符参与字面匹配。
 * 如 `会议 a|b c` → [[会议], [a, b], [c]]，即 会议 AND (a OR b) AND c。
 * advanced=false（关闭高级搜索）：整串 trim 后作为单个字面词元，无任何语法含义。
 * SQL 拆词与前端高亮必须共用本函数（传同一 advanced 值），保证"搜什么就高亮什么"。
 */
export function parseSearchTokens(input: string, advanced = true): string[][] {
    if (!advanced) {
        const raw = (input ?? '').trim();
        return raw ? [[raw]] : [];
    }
    // 展平为词元流：word = 词元（引号短语或按 | 拆出的子词），pipe = 引号外的 OR 分隔符
    type Unit = { word: string } | { pipe: true };
    const stream: Unit[] = [];
    const re = /"([^"]+)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input ?? '')) !== null) {
        if (m[1] !== undefined) {
            stream.push({ word: m[1] });
            continue;
        }
        // 引号外文本按 | 拆分：空段丢弃，每个分隔符记一个 pipe（连续 | 语义相同）
        const parts = m[2]!.split('|');
        for (let i = 0; i < parts.length; i++) {
            if (parts[i]) stream.push({ word: parts[i]! });
            if (i < parts.length - 1) stream.push({ pipe: true });
        }
    }
    // 组内 OR / 组间 AND：普通词元入当前组，pipe 标记下一词元与当前组 OR 相连；
    // pendingOr 时当前组为空（如开头就是 |）则该 | 无左操作数，按普通词元开新组处理
    const groups: string[][] = [];
    let current: string[] = [];
    let pendingOr = false;
    for (const unit of stream) {
        if ('pipe' in unit) {
            pendingOr = true;
            continue;
        }
        if (pendingOr && current.length > 0) {
            current.push(unit.word);
        } else {
            if (current.length > 0) groups.push(current);
            current = [unit.word];
        }
        pendingOr = false;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}
