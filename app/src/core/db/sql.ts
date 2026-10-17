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
 * GLOB 字面转义：GLOB 元字符 * ? [ 包成 [x] 字符类以按字面匹配（GLOB 无 ESCAPE 子句）。
 * `]` 在类外是字面量，无需转义；`*`/`?`/`[` 三个元字符必须转义。
 */
export function globLiteral(input: string): string {
    return input.replace(/[[*?]/g, (ch) => `[${ch}]`);
}

/**
 * 高级搜索词元 → GLOB 模式（大小写区分模式专用）：`*` `?` 保留为 GLOB 原生通配符
 * （语义与 LIKE 的 % _ 一致：任意串 / 单字符），`[` 转义为字符类字面量，其余字符原样。
 */
export function globPatternFromToken(token: string): string {
    return token.replace(/\[/g, '[[]');
}

/**
 * 搜索词元 → 匹配模式（大小写语义的单一出口）：
 * - 不区分（默认）：LIKE 词法（% _ 通配 + ESCAPE 转义）
 * - 区分：GLOB 词法（* ? 通配 + [x] 字面转义，天然区分大小写）
 * 剪贴板仓储的跨列自行拼接与 buildLikeGroups 共用，保证三模块词法逐字一致。
 */
export function searchPattern(token: string, advanced: boolean, caseSensitive: boolean): string {
    if (!advanced) return caseSensitive ? globLiteral(token) : escapeLike(token);
    return caseSensitive ? globPatternFromToken(token) : likePatternFromToken(token);
}

/** SQL 比较算子包（按大小写语义选择）：op + 后缀子句 + 包裹函数（%x% / *x*）由各仓储拼接复用 */
export interface SearchMatcher {
    op: 'LIKE' | 'GLOB';
    /** LIKE 的 ESCAPE 子句（GLOB 无）；拼接形如 `${field} ${op} $${n}${suffix}` */
    suffix: string;
    /** 模式包裹：两侧通配（包含匹配） */
    wrap: (pattern: string) => string;
}

export function createSearchMatcher(caseSensitive: boolean): SearchMatcher {
    return caseSensitive
        ? { op: 'GLOB', suffix: '', wrap: (pattern) => `*${pattern}*` }
        : { op: 'LIKE', suffix: " ESCAPE '\\'", wrap: (pattern) => `%${pattern}%` };
}

/**
 * 搜索输入 → SQL 匹配条件与参数（待办/便签搜索共用，剪贴板为跨列 OR 自行拼接）：
 * 组内 OR、组间 AND（与 parseSearchTokens 分组语义对应）。advanced=false 时整串
 * 字面单词元（同剪贴板「关闭高级搜索」语义）。field 为比较左侧列名，
 * 占位符按拼接顺序从 $1 编号——调用方的其他条件须拼在其后（withPage 追加分页参数亦然）。
 * caseSensitive=true 时切 GLOB 算子（天然区分大小写，* ? 通配语义不变）。
 */
export function buildLikeGroups(input: string, field: string, advanced = true, caseSensitive = false): { sql: string; params: string[] } {
    const matcher = createSearchMatcher(caseSensitive);
    const groups = parseSearchTokens(input, advanced).map((group) =>
        group.map((kw) => searchPattern(kw, advanced, caseSensitive)),
    );
    const params: string[] = [];
    const conds = groups.map((group) => {
        const parts = group.map((pattern) => {
            params.push(matcher.wrap(pattern));
            return `${field} ${matcher.op} $${params.length}${matcher.suffix}`;
        });
        return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
    });
    return { sql: conds.join(' AND '), params };
}

// ===== 前端统一匹配（与 SQL 词法同源） =====

/** 正则元字符转义（前端匹配用） */
function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 搜索词元 → 正则源（advanced 时 * → .*、? → .，其余转义；\0/\1 占位防被误转义） */
function tokenToRegExpSource(token: string, advanced: boolean): string {
    if (!advanced) return escapeRegExp(token);
    const STAR = '\u0000';
    const QMARK = '\u0001';
    return escapeRegExp(token.split('*').join(STAR).split('?').join(QMARK))
        .split(STAR).join('.*')
        .split(QMARK).join('.');
}

/**
 * 前端文本匹配（便签「当前范围」过滤等纯前端搜索复用）：与 parseSearchTokens/buildLikeGroups
 * 同一套解析与通配语义，保证"搜什么就匹配什么"（组内 OR、组间 AND、* ? 通配、引号整句）。
 * caseSensitive=true 时按字面大小写匹配（与 SQL GLOB 行为一致）。
 */
export function matchesSearch(text: string, input: string, advanced = true, caseSensitive = false): boolean {
    const groups = parseSearchTokens(input, advanced);
    if (groups.length === 0) return true;
    const flags = caseSensitive ? '' : 'i';
    return groups.every((group) =>
        group.some((token) => new RegExp(tokenToRegExpSource(token, advanced), flags).test(text ?? '')),
    );
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
