import type { DatabaseConnection } from '../connection';
import type { Todo, ReminderRule } from '../../../entities';
import { escapeLike, withPage, type PageQuery } from '../sql';
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
 * DB 行 → Todo 的提醒规则映射：
 * 先做列名归一——SELECT * 返回行键为 DB 列名（remind_mode/remind_at/priority_level，snake_case），
 * 与 Todo 类型字段（remindMode/remindAt/priorityLevel，camelCase）不一致，不归一则每次
 * 轮询/翻页刷新后 remindMode 恒为 undefined，界面回退显示「智能」、自定义闹钟设置被冲掉。
 * 再解析 remind_rules JSON（容错损坏数据）；旧数据无规则但有 remindAt（单一自定义时刻）
 * 时自动折算为一条 at 规则，保证老配置继续生效。
 */
function mapTodoRemindRules(row: Todo): Todo {
    const raw = row.remind_rules;
    // 行键可能来自 SELECT *（DB 列名，snake_case），经 unknown 中转读取兼容两种形态
    const rawRow = row as unknown as Record<string, unknown>;
    const remindMode = (rawRow.remind_mode ?? row.remindMode) as Todo['remindMode'];
    const remindAt = (rawRow.remind_at ?? row.remindAt) as string;
    const priorityLevel = (rawRow.priority_level ?? row.priorityLevel) as number | undefined;
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
    return { ...row, remindMode, remindAt, priorityLevel, remindRules: rules };
}

/**
 * 待办领域仓储（todo 表）：写入/更新/删除/查询，含提醒规则 JSON 列与
 * 数值优先级（priority_level + legacy 三档文本）的双轨维护。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface TodoRepository {
    insertTodo(todo: Todo): Promise<void>;
    updateTodo(todo: Todo): Promise<void>;
    deleteTodo(todoId: string): Promise<void>;
    fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]>;
    fetchSingleTodo(todoId: string): Promise<Todo | undefined>;
}

export function createTodoRepository({ conn, recordStats }: { conn: DatabaseConnection; recordStats: RecordStats }): TodoRepository {
    return {
        async insertTodo(todo: Todo): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            const level = clampPriorityLevel(todo.priorityLevel);
            await db.execute(
                "INSERT INTO todo (id,title, description, completed, priority, priority_level, category, created_at, updated_at, dueDate, remind_mode, remind_at, remind_rules) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
                [todo.id,todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules)]
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
                "UPDATE todo SET title = $1, description = $2, completed = $3, priority = $4, priority_level = $5, category = $6, updated_at = $7, dueDate = $8, remind_mode = $9, remind_at = $10, remind_rules = $11 WHERE id = $12",
                [todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules), todo.id]
            );
        },

        async deleteTodo(todoId: string): Promise<void> {
            const db = await conn.ready();
            await db.execute("DELETE FROM todo WHERE id = $1", [todoId]);
            // 统计埋点（fire-and-forget）：删除待办 +1
            void recordStats({ todo_deleted: 1 });
        },

        async fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]> {
            const db = await conn.ready();

            const content: string = filter.value.searchContent;
            const baseSql = "SELECT * FROM todo WHERE title LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC, id DESC";
            const params = [`%${escapeLike(content)}%`];

            let rows: Todo[];
            if (page) {
                const { sql, params: pageParams } = withPage(page, params);
                rows = await db.select(baseSql + sql, pageParams) as Todo[];
            } else {
                // 未传分页（全量查询，用于提醒调度 sync 等场景）：保留 500 条上限
                rows = await db.select(baseSql + " LIMIT 500", params) as Todo[];
            }
            return rows.map(mapTodoRemindRules);
        },

        async fetchSingleTodo(todoId: string): Promise<Todo | undefined> {
            const db = await conn.ready();
            const data = await db.select("SELECT * FROM todo WHERE id = $1", [todoId]) as Todo[];
            return data[0] ? mapTodoRemindRules(data[0]) : undefined;
        },
    };
}
