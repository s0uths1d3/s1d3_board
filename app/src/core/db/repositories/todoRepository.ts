import type { DatabaseConnection } from '../connection';
import type { Todo, ReminderRule, TodoRecurrence, TodoLink } from '../../../entities';
import { withPage, buildLikeGroups, type PageQuery } from '../sql';
import type { RecordStats } from './noteRepository';

/** 优先级数值收敛：整数 0-255（越界/非法回退 127 中档） */
function clampPriorityLevel(level?: number): number {
    const n = Math.round(Number(level));
    if (!Number.isFinite(n)) return 127;
    return Math.min(255, Math.max(0, n));
}

/** 旧版三档文本列（legacy）随数值同步：低 <64 / 中 64-191 / 高 ≥192 */
function tierOf(level: number): 'low' | 'medium' | 'high' {
    return level >= 192 ? 'high' : level >= 64 ? 'medium' : 'low';
}

/** 提醒规则列表 → JSON 文本列（空列表存 ''） */
function stringifyRemindRules(rules?: ReminderRule[]): string {
    if (!rules || rules.length === 0) return '';
    try {
        return JSON.stringify(rules.filter(r => r && typeof r.id === 'string'));
    } catch {
        return '';
    }
}

/**
 * 循环规则白名单化（写入与读取共用）：非法整体丢弃（undefined），非法字段剔除。
 * interval 收敛为 1-999 整数；weekly 只保留 0-6 星期、monthly 只保留 1-31 日；from 缺省 due。
 */
function normalizeRecurrence(rule: unknown): TodoRecurrence | undefined {
    if (!rule || typeof rule !== 'object') return undefined;
    const r = rule as Partial<TodoRecurrence>;
    if (r.freq !== 'daily' && r.freq !== 'weekly' && r.freq !== 'monthly' && r.freq !== 'yearly') return undefined;
    const interval = Math.round(Number(r.interval));
    if (!Number.isFinite(interval) || interval < 1) return undefined;
    const out: TodoRecurrence = {
        freq: r.freq,
        interval: Math.min(999, interval),
        from: r.from === 'complete' ? 'complete' : 'due',
    };
    if (r.freq === 'weekly' && Array.isArray(r.weekdays)) {
        const ws = [...new Set(r.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
        if (ws.length) out.weekdays = ws;
    }
    if (r.freq === 'monthly' && Number.isFinite(Number(r.monthDay))) {
        const d = Math.round(Number(r.monthDay));
        if (d >= 1 && d <= 31) out.monthDay = d;
    }
    return out;
}

/** 循环规则 → JSON 文本列（无规则存 ''） */
function stringifyRecurrence(rule?: TodoRecurrence): string {
    const n = rule ? normalizeRecurrence(rule) : undefined;
    return n ? JSON.stringify(n) : '';
}

/** JSON 文本 → 循环规则（容错损坏数据） */
function parseRecurrence(raw: unknown): TodoRecurrence | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    try {
        return normalizeRecurrence(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

/** 标签清洗（写入与读取共用）：仅留非空字符串、去首尾空格、去重；空数组 = 无标签 */
function cleanTags(tags: unknown): string[] | undefined {
    if (!Array.isArray(tags)) return undefined;
    const arr = tags.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean);
    return arr.length ? [...new Set(arr)] : undefined;
}

/** 标签列表 → JSON 文本列（对齐 pinned_clip tags：无标签存 ''） */
function stringifyTags(tags?: string[]): string {
    const n = cleanTags(tags);
    return n ? JSON.stringify(n) : '';
}

/** JSON 文本 → 标签列表（容错损坏数据） */
function parseTags(raw: unknown): string[] | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    try {
        return cleanTags(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

/** 链接条目清洗（写入与读取共用）：url 必填非空（自动补 https:// 由 UI 层负责），title 缺省 '' */
function cleanLinks(links: unknown): TodoLink[] | undefined {
    if (!Array.isArray(links)) return undefined;
    const arr: TodoLink[] = [];
    for (const l of links) {
        if (!l || typeof l !== 'object') continue;
        const url = String((l as Partial<TodoLink>).url ?? '').trim();
        if (!url) continue;
        const title = (l as Partial<TodoLink>).title;
        arr.push({ title: typeof title === 'string' ? title.trim() : '', url });
    }
    return arr.length ? arr : undefined;
}

/** 链接列表 → JSON 文本列（无链接存 ''） */
function stringifyLinks(links?: TodoLink[]): string {
    const n = cleanLinks(links);
    return n ? JSON.stringify(n) : '';
}

/** JSON 文本 → 链接列表（容错损坏数据） */
function parseLinks(raw: unknown): TodoLink[] | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    try {
        return cleanLinks(JSON.parse(raw));
    } catch {
        return undefined;
    }
}

/**
 * DB 行 → Todo 的列名归一与 JSON 列解析：
 * 先做列名归一——SELECT * 返回行键为 DB 列名（remind_mode/remind_at/priority_level/parent_id/
 * sort_order/deleted_at，snake_case），与 Todo 类型字段（remindMode/remindAt/priorityLevel/
 * parentId/sortOrder/deletedAt，camelCase）不一致，不归一则每次轮询/翻页刷新后 remindMode
 * 恒为 undefined，界面回退显示「智能」、自定义闹钟设置被冲掉。
 * 再解析各 JSON 文本列（remind_rules/recurrence/tags/links，容错损坏数据）；旧数据无规则
 * 但有 remindAt（单一自定义时刻）时自动折算为一条 at 规则，保证老配置继续生效。
 */
function mapTodoRow(row: Todo): Todo {
    const raw = row.remind_rules;
    // 行键可能来自 SELECT *（DB 列名，snake_case），经 unknown 中转读取兼容两种形态
    const rawRow = row as unknown as Record<string, unknown>;
    const remindMode = (rawRow.remind_mode ?? row.remindMode) as Todo['remindMode'];
    const remindAt = (rawRow.remind_at ?? row.remindAt) as string;
    const priorityLevel = (rawRow.priority_level ?? row.priorityLevel) as number | undefined;
    const parentId = (rawRow.parent_id ?? row.parentId) as string | undefined;
    const sortOrder = (rawRow.sort_order ?? row.sortOrder) as number | undefined;
    // deleted_at 的 NULL 是有效值（未删除），不能用 ?? 归一（null 会被误穿透成 undefined）
    const deletedAt = (rawRow.deleted_at !== undefined ? rawRow.deleted_at : row.deletedAt) as string | null | undefined;
    const rules: ReminderRule[] = [];
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const r of parsed as ReminderRule[]) {
                    if (!r || typeof r.id !== 'string') continue;
                    if (r.kind === 'percent' || r.kind === 'offset') {
                        const v = Math.round(Number(r.value));
                        if (Number.isFinite(v) && v > 0) rules.push({ id: r.id, kind: r.kind, value: v });
                    } else if (r.kind === 'at' && typeof r.value === 'string' && r.value) {
                        rules.push({ id: r.id, kind: 'at', value: r.value });
                    }
                }
            }
        } catch { /* JSON 损坏视为无规则 */ }
    }
    if (rules.length === 0 && remindMode === 'custom' && remindAt) {
        rules.push({ id: 'legacy', kind: 'at', value: remindAt });
    }
    return {
        ...row,
        remindMode,
        remindAt,
        priorityLevel,
        remindRules: rules,
        parentId,
        sortOrder,
        deletedAt,
        recurrence: parseRecurrence(rawRow.recurrence ?? row.recurrence),
        tags: parseTags(rawRow.tags ?? row.tags),
        links: parseLinks(rawRow.links ?? row.links),
    };
}

/**
 * 待办领域仓储（todo 表）：写入/更新/软删/恢复/彻底删除/查询，含提醒规则 JSON 列与
 * 数值优先级（priority_level + legacy 三档文本）的双轨维护，以及待办扩展列
 * （recurrence/parent_id/tags/sort_order/deleted_at/links）的 JSON 序列化与行映射。
 */
export interface TodoRepository {
    insertTodo(todo: Todo): Promise<void>;
    updateTodo(todo: Todo): Promise<void>;
    /** 软删（进回收站）：写 deleted_at，子任务随父级联；真删走 purgeTodo */
    deleteTodo(todoId: string): Promise<void>;
    /** 彻底删除：真 DELETE，父任务连带子任务 */
    purgeTodo(todoId: string): Promise<void>;
    /** 从回收站恢复：清 deleted_at，子任务随父级联 */
    restoreTodo(todoId: string): Promise<void>;
    /** 未删除任务查询（主列表/提醒调度等场景） */
    fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]>;
    /** 回收站列表：deleted_at IS NOT NULL，按删除时间倒序 */
    fetchDeletedTodos(page?: PageQuery): Promise<Todo[]>;
    fetchSingleTodo(todoId: string): Promise<Todo | undefined>;
}

export function createTodoRepository({ conn, recordStats }: { conn: DatabaseConnection; recordStats: RecordStats }): TodoRepository {
    return {
        async insertTodo(todo: Todo): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            const level = clampPriorityLevel(todo.priorityLevel);
            // sort_order 未显式提供（null）时自动取同父级（parent_id IS $19 兼容 NULL 顶级作用域）
            // 未删除兄弟的最大值 +1；软删兄弟占用的序号释放回收
            await db.execute(
                "INSERT INTO todo (id, title, description, completed, priority, priority_level, category, created_at, updated_at, dueDate, remind_mode, remind_at, remind_rules, recurrence, parent_id, tags, links, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, (SELECT MAX(sort_order) + 1 FROM todo WHERE deleted_at IS NULL AND parent_id IS $19)))",
                [todo.id, todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules), stringifyRecurrence(todo.recurrence), todo.parentId ?? null, stringifyTags(todo.tags), stringifyLinks(todo.links), todo.sortOrder ?? null, todo.parentId ?? null]
            );
            // 统计埋点（fire-and-forget）：新建待办 +1，并累计任务标题+描述的字符数
            const todoChars = (todo.title?.length ?? 0) + (todo.description?.length ?? 0);
            void recordStats({ todo_added: 1, todo_chars: todoChars });
        },

        async updateTodo(todo: Todo): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            const level = clampPriorityLevel(todo.priorityLevel);
            await db.execute(
                "UPDATE todo SET title = $1, description = $2, completed = $3, priority = $4, priority_level = $5, category = $6, updated_at = $7, dueDate = $8, remind_mode = $9, remind_at = $10, remind_rules = $11, recurrence = $12, parent_id = $13, tags = $14, links = $15, sort_order = $16 WHERE id = $17",
                [todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules), stringifyRecurrence(todo.recurrence), todo.parentId ?? null, stringifyTags(todo.tags), stringifyLinks(todo.links), todo.sortOrder ?? 0, todo.id]
            );
        },

        async deleteTodo(todoId: string): Promise<void> {
            const db = await conn.ready();
            // 软删（进回收站）：写 deleted_at，子任务随父级联；已软删的子任务保留各自删除时间。
            // updated_at 不动：主列表按 updated_at 排序，软删行退出列表后不参与排序。
            await db.execute(
                "UPDATE todo SET deleted_at = $2 WHERE (id = $1 OR parent_id = $1) AND deleted_at IS NULL",
                [todoId, String(Date.now())]
            );
            // 统计埋点（fire-and-forget）：删除待办 +1（真删 purgeTodo 不重复计数）
            void recordStats({ todo_deleted: 1 });
        },

        async purgeTodo(todoId: string): Promise<void> {
            const db = await conn.ready();
            // 彻底删除：真 DELETE，父任务连带子任务（回收站中二者均已软删）
            await db.execute("DELETE FROM todo WHERE id = $1 OR parent_id = $1", [todoId]);
        },

        async restoreTodo(todoId: string): Promise<void> {
            const db = await conn.ready();
            // 恢复：清 deleted_at，子任务随父级联
            await db.execute("UPDATE todo SET deleted_at = NULL WHERE id = $1 OR parent_id = $1", [todoId]);
        },

        async fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]> {
            const db = await conn.ready();

            const content: string = filter.value.searchContent;
            // 高级搜索：与剪贴板同一套词法（buildLikeGroups 收编 parseSearchTokens + searchPattern）——
            // 空格拆词 AND、双引号整句、* ? 通配符、| 组内 OR；开关随 filter.advanced（缺省视为开启，同剪贴板）。
            // 大小写区分开关随 filter.caseSensitive（缺省不区分）：区分时切 GLOB 算子，词法语义不变。
            // 空搜索词无匹配条件（全量），提醒调度 sync 行为不变
            const { sql: likeSql, params } = buildLikeGroups(content, 'title', filter.value.advanced !== false, filter.value.caseSensitive === true);
            const baseSql = `SELECT * FROM todo WHERE deleted_at IS NULL${likeSql ? ` AND ${likeSql}` : ''} ORDER BY updated_at DESC, id DESC`;

            let rows: Todo[];
            if (page) {
                const { sql, params: pageParams } = withPage(page, params);
                rows = await db.select(baseSql + sql, pageParams) as Todo[];
            } else {
                // 未传分页（全量查询，用于提醒调度 sync 等场景）：保留 500 条上限
                rows = await db.select(baseSql + " LIMIT 500", params) as Todo[];
            }
            return rows.map(mapTodoRow);
        },

        async fetchDeletedTodos(page?: PageQuery): Promise<Todo[]> {
            const db = await conn.ready();
            const baseSql = "SELECT * FROM todo WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC";
            let rows: Todo[];
            if (page) {
                const { sql, params } = withPage(page, []);
                rows = await db.select(baseSql + sql, params) as Todo[];
            } else {
                rows = await db.select(baseSql) as Todo[];
            }
            return rows.map(mapTodoRow);
        },

        async fetchSingleTodo(todoId: string): Promise<Todo | undefined> {
            const db = await conn.ready();
            // 已软删任务不返回：提醒调度等活跃场景不应再命中回收站中的任务
            const data = await db.select("SELECT * FROM todo WHERE id = $1 AND deleted_at IS NULL", [todoId]) as Todo[];
            return data[0] ? mapTodoRow(data[0]) : undefined;
        },
    };
}
