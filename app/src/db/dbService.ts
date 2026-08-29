import Database from "@tauri-apps/plugin-sql";
import { onTextUpdate, onSomethingUpdate, readImageBase64, startListening } from 'tauri-plugin-clipboard-api';
import type { ClipboardData,Note,Todo,ReminderRule,PinnedClip } from "../Entities";
import statsService from "~/src/statistics/statsService";

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
 * 解析 remind_rules JSON（容错损坏数据）；旧数据无规则但有 remindAt（单一自定义时刻）
 * 时自动折算为一条 at 规则，保证老配置继续生效。
 */
function mapTodoRemindRules(row: Todo): Todo {
    const rules: ReminderRule[] = [];
    const raw = (row as unknown as { remind_rules?: string }).remind_rules;
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
    if (rules.length === 0 && row.remindMode === 'custom' && row.remindAt) {
        rules.push({ id: 'legacy', kind: 'at', value: row.remindAt });
    }
    return { ...row, remindRules: rules };
}


class ClipboardService {
    private static instance: ClipboardService;
    private db: Database | undefined;

    private constructor() {}

    public static getInstance(): ClipboardService {
        if (!ClipboardService.instance) {
            ClipboardService.instance = new ClipboardService();
        }
        return ClipboardService.instance;
    }

    private async initDatabase() {
        const dbName = 'sqlite:s1d3_board.db';
        this.db = await Database.load(dbName);
        await this.ensureFeatureColumns();
    }

    /**
     * 兜底列迁移（幂等）：部分环境下 Rust 侧 tauri-plugin-sql 迁移可能未执行
     * （如运行了旧可执行文件、迁移环节静默失败），导致新功能的列缺失、SQL 报错。
     * 此处在连接建立后按 PRAGMA 检查并补齐功能所需列；列已存在则跳过，
     * 与 Rust 侧 migration（同 DDL）互不冲突。
     */
    private async ensureFeatureColumns() {
        const wanted = [
            { table: 'todo', column: 'remind_mode', ddl: 'ALTER TABLE todo ADD COLUMN remind_mode TEXT' },
            { table: 'todo', column: 'remind_at', ddl: 'ALTER TABLE todo ADD COLUMN remind_at TEXT' },
            { table: 'todo', column: 'priority_level', ddl: 'ALTER TABLE todo ADD COLUMN priority_level INTEGER' },
            { table: 'todo', column: 'remind_rules', ddl: 'ALTER TABLE todo ADD COLUMN remind_rules TEXT' },
            { table: 'daily_stat', column: 'todo_reminded', ddl: 'ALTER TABLE daily_stat ADD COLUMN todo_reminded INTEGER NOT NULL DEFAULT 0' },
            { table: 'daily_stat', column: 'todo_chars', ddl: 'ALTER TABLE daily_stat ADD COLUMN todo_chars INTEGER NOT NULL DEFAULT 0' },
        ];
        for (const { table, column, ddl } of wanted) {
            try {
                const cols = await this.db!.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
                if (Array.isArray(cols) && !cols.some(c => c.name === column)) {
                    await this.db!.execute(ddl);
                    console.info(`[db] 补齐列 ${table}.${column}`);
                }
            } catch (e) {
                // 单列补齐失败（如表尚未创建）不影响其余列与其余功能
                console.warn(`[db] 检查/补齐列 ${table}.${column} 失败:`, e);
            }
        }
        let addedPriorityLevel = false;
        if (wanted.some(w => w.column === 'priority_level')) {
            try {
                const cols = await this.db!.select<{ name: string }[]>("PRAGMA table_info(todo)");
                addedPriorityLevel = Array.isArray(cols) && !cols.some(c => c.name === 'priority_level');
            } catch { addedPriorityLevel = false; }
        }
        if (addedPriorityLevel) {
            // 刚补建 priority_level 时回填存量数据：旧三档文本 → 0/127/255（WHERE 保证幂等）
            try {
                await this.db!.execute(
                    "UPDATE todo SET priority_level = CASE priority WHEN 'low' THEN 0 WHEN 'medium' THEN 127 WHEN 'high' THEN 255 ELSE 127 END WHERE priority_level IS NULL"
                );
                console.info('[db] 已回填 priority_level 存量数据');
            } catch (e) {
                console.warn('[db] 回填 priority_level 失败:', e);
            }
        }
    }

    public async ensureDbInitialized() {
        if (!this.db) {
            await this.initDatabase();
        }
    }

    public async startClipboardListener() {
        await this.ensureDbInitialized();

        // 文本更新
        await onTextUpdate(async (newText) => {
            await this.saveClipboard(newText, 'text');
        });

        // 图片更新：onImageUpdate 在某些平台/格式下回传的是文件路径而非 base64，
        // 改用 onSomethingUpdate 判定类型后主动 readImageBase64() 获取真实数据。
        await onSomethingUpdate(async (updated) => {
            if (!updated.image) return;
            try {
                const base64 = await readImageBase64();
                if (!base64) return;
                // 拼上 data URL 前缀（无前缀时浏览器会把它当相对路径向 dev server 发请求导致 431）
                const dataUrl = base64.startsWith('data:')
                    ? base64
                    : `data:image/png;base64,${base64}`;
                await this.saveClipboard(dataUrl, 'image');
            } catch (err) {
                console.error('读取剪贴板图片失败:', err);
            }
        });

        // 注意：startListening 的 listenTypes 参数会整体覆盖默认值
        // （默认 text/html/rtf/image/files 全开），必须显式传入 text + image，
        // 只传 { image: true } 会关闭文本监听，导致 TEXT_CHANGED 永不触发。
        await startListening({ text: true, image: true });
        console.log("Clipboard listener started");
    }

    /**
     * 写入一条剪贴板记录（文本或图片）。
     * - 同类型 + 同内容已存在则仅递增使用次数；否则插入新行。
     */
    private async saveClipboard(content: string, type: 'text' | 'image'): Promise<void> {
        const now = Math.floor(Date.now());
        const existingRecord: ClipboardData[] = await this.db!.select(
            "SELECT id FROM clipboard WHERE content = $1 AND type = $2",
            [content, type]
        );

        if (existingRecord.length === 0) {
            const result = await this.db!.execute(
                "INSERT INTO clipboard (content, category, type, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) ",
                [content, 'T', type, now, now]
            );
            console.log(`New ${type} record inserted:`, result);
            // 统计埋点（fire-and-forget）：插入新文本/图片剪贴 +1；文本额外累加字符量（图片 base64 不计入"打字量"）
            if (type === 'text') {
                void statsService.record({ clip_text: 1, clip_chars: content.length });
            } else {
                void statsService.record({ clip_image: 1 });
            }
            // 插入新记录后按「剪贴板最大存储数量」裁剪最旧记录
            await this.trimClipboard();
        } else {
            const record = existingRecord[0];
            if (record && record.id !== undefined) {
                const result = await this.db!.execute(
                    "UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1",
                    [record.id, now]
                );
                console.log(`Count incremented (${type}):`, result);
            } else {
                console.error("Existing record is missing an ID:", existingRecord);
                throw new Error("Existing record is missing an ID");
            }
        }
    }


    /**
     * 按设置项「剪贴板最大存储数量」（max_save_count）裁剪剪贴板：
     * 超出上限时删除最旧记录；未设置或值为无效数字时不裁剪。
     */
    private async trimClipboard(): Promise<void> {
        try {
            const maxRaw = await this.getKeyValue('max_save_count');
            const max = parseInt(maxRaw ?? '', 10);
            if (!max || max <= 0) return;

            const rows: any[] = await this.db!.select("SELECT COUNT(*) AS cnt FROM clipboard");
            const count = rows?.[0]?.cnt as number | undefined;
            if (count === undefined || count <= max) return;

            const excess = count - max;
            await this.db!.execute(
                "DELETE FROM clipboard WHERE id IN " +
                "(SELECT id FROM clipboard ORDER BY updated_at ASC, id ASC LIMIT $1)",
                [excess]
            );
        } catch (e) {
            console.error('裁剪剪贴板失败:', e);
        }
    }

    public async fetchClipboardData(filter: any): Promise<ClipboardData[]> {
        await this.ensureDbInitialized();

        const favorite: number = filter.value.favorite;
        const content: string = filter.value.searchContent;
        const type: string = filter.value.type ?? 'all';

        // 统一收集 WHERE 条件，按 $1/$2… 顺序编号参数
        const conds: string[] = [];
        const params: any[] = [];
        let paramIdx = 0;

        if (favorite === 1) {
            paramIdx += 1;
            conds.push(`is_favorite = $${paramIdx}`);
            params.push(favorite);
        }

        if (type === 'image') {
            // 仅图片：图片无文本内容，忽略搜索关键字
            conds.push("type = 'image'");
        } else if (type === 'text') {
            conds.push("type = 'text'");
        } else if (content) {
            // 默认（全部）：图片不参与文本搜索，仅在文本中匹配
            paramIdx += 1;
            conds.push(`content LIKE $${paramIdx} AND type = 'text'`);
            params.push(`%${content}%`);
        }

        const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE 1=1';

        // 查询上限随「剪贴板最大存储数量」（max_save_count）动态调整；
        // 收藏列表仍保持 100 条上限；未设置时回退默认值。
        let limit = favorite === 1 ? 100 : 500;
        const maxRaw = await this.getKeyValue('max_save_count');
        const parsed = parseInt(maxRaw ?? '', 10);
        if (parsed > 0) {
            limit = favorite === 1 ? Math.min(parsed, 100) : parsed;
        }

        const sql = `SELECT * FROM clipboard ${whereSql} ORDER BY updated_at DESC LIMIT ${limit}`;
        return await this.db!.select(sql, params) as ClipboardData[];
    }

    public async fetchClipboardSingleData(id: number): Promise<ClipboardData> {
        const data =  await this.db!.select("SELECT * FROM clipboard WHERE id = $1", [id]) as ClipboardData[]
        return data[0] as ClipboardData
    }

    public async updateFavorite(id: number, value: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("UPDATE clipboard SET is_favorite = $2 WHERE id = $1", [id, value]);
        // 统计埋点（fire-and-forget）：收藏/取消收藏切换 +1
        void statsService.record({ favorite_toggle: 1 });
    }

    public async increaseUseCount(id: number): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute("UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1", [id, now]);
        // 统计埋点（fire-and-forget）：粘贴使用 +1
        void statsService.record({ clip_use: 1 });
    }

    public async deleteClipboardData(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM clipboard WHERE id = $1", [id]);
    }

    // ===== 常用剪贴（pinned_clip）=====

    /**
     * 获取常用剪贴列表（最多 10 条）。
     * 排序：置顶项优先（按置顶时间倒序），其余按时间倒序（最新在前）。
     */
    public async fetchPinnedClips(): Promise<PinnedClip[]> {
        await this.ensureDbInitialized();
        return await this.db!.select(
            "SELECT * FROM pinned_clip ORDER BY " +
            "CASE WHEN pinned_at IS NOT NULL AND pinned_at != '' THEN 1 ELSE 0 END DESC, " +
            "pinned_at DESC, created_at DESC, id DESC LIMIT 10"
        ) as PinnedClip[];
    }

    /** 获取单个常用剪贴项 */
    public async fetchPinnedClip(id: number): Promise<PinnedClip | undefined> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select("SELECT * FROM pinned_clip WHERE id = $1", [id]) as PinnedClip[];
        return rows[0];
    }

    /**
     * 新增常用剪贴项（最新一条排最前）。
     * 超过 10 条时自动删除最旧（未置顶的最旧优先）记录。
     */
    public async insertPinnedClip(content: string, type: 'text' | 'image', name?: string, source?: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "INSERT INTO pinned_clip (content, type, name, source, sort_order, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [content, type, name || '', source || '', 0, now, now]
        );
        // 超限裁剪：保留按展示顺序的前 10 条（置顶优先，再按时间倒序）
        await this.db!.execute(
            "DELETE FROM pinned_clip WHERE id NOT IN (" +
            "SELECT id FROM pinned_clip ORDER BY " +
            "CASE WHEN pinned_at IS NOT NULL AND pinned_at != '' THEN 1 ELSE 0 END DESC, " +
            "pinned_at DESC, created_at DESC, id DESC LIMIT 10)"
        );
    }

    /**
     * 判断常用剪贴中是否已存在相同内容（按 content + type 去重）。
     * 用于 Ctrl+U「添加为常用」时避免重复添加。
     */
    public async isPinnedContentExist(content: string, type: 'text' | 'image'): Promise<boolean> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select(
            "SELECT id FROM pinned_clip WHERE content = $1 AND type = $2 LIMIT 1",
            [content, type]
        ) as { id: number }[];
        return rows.length > 0;
    }

    /** 更新常用剪贴项（文本可改内容；图片替换传新 base64；name 可编辑） */
    public async updatePinnedClip(id: number, content: string, name: string, type: 'text' | 'image'): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE pinned_clip SET content = $2, name = $3, type = $4, updated_at = $5 WHERE id = $1",
            [id, content, name, type, now]
        );
    }

    /** 置顶/取消置顶常用剪贴项（置顶后排序优先；pinned=false 取消置顶） */
    public async pinPinnedClip(id: number, pinned: boolean): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE pinned_clip SET pinned_at = $2, updated_at = $3 WHERE id = $1",
            [id, pinned ? `${now}` : '', now]
        );
    }

    /** 删除常用剪贴项 */
    public async deletePinnedClip(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM pinned_clip WHERE id = $1", [id]);
    }

    /**
     * 清空所有业务数据（剪贴板 / 便签 / 待办），保留配置表（settings、shortcut_binding）。
     * 同时重置各表的自增主键计数。
     */
    public async clearDatabase(): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM clipboard");
        await this.db!.execute("DELETE FROM note");
        await this.db!.execute("DELETE FROM todo");
        await this.db!.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('clipboard', 'note', 'todo')"
        );
    }

    public  async  getShortcutSetting():Promise<any> {
        await this.ensureDbInitialized();
        return  await this.db!.select("SELECT * FROM settings WHERE type = $1", ['shortcut']);
    }

    /**
     * 保存单个快捷键到 shortcut_binding 规范化表（按 shortcut_id upsert）
     */
    public async saveShortcutSetting(id: string, value: string, scope: string, title: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const existing: any[] = await this.db!.select(
            "SELECT id FROM shortcut_binding WHERE shortcut_id = $1",
            [id]
        );
        if (existing.length > 0) {
            await this.db!.execute(
                "UPDATE shortcut_binding SET key = $1, scope = $2, description = $3, updated_at = $4 WHERE shortcut_id = $5",
                [value, scope, title, now, id]
            );
        } else {
            await this.db!.execute(
                "INSERT INTO shortcut_binding (shortcut_id, key, scope, description, updated_at) VALUES ($1, $2, $3, $4, $5)",
                [id, value, scope, title, now]
            );
        }
    }

    /** 加载已保存的快捷键配置（返回 { id, value }[]） */
    public async loadShortcutSettings(): Promise<{ id: string; value: string }[]> {
        await this.ensureDbInitialized();
        const rows: any[] = await this.db!.select(
            "SELECT shortcut_id, key FROM shortcut_binding WHERE key IS NOT NULL AND key != ''"
        );
        return rows
            .filter(r => typeof r.shortcut_id === 'string')
            .map(r => ({ id: r.shortcut_id, value: r.key }));
    }

    public async setKeyValue(key : string,value: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        // UPSERT：首次设置的 key（表中尚无对应行）也能持久化，避免仅 UPDATE 导致新 key 无法写入
        await this.db!.execute(
            "INSERT INTO settings (key, value, type, updated_at) VALUES ($1, $2, 'other', $3) " +
            "ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = $3",
            [key, value, now]
        );
    }

    public async getKeyValue(key:string): Promise<string> {
        await this.ensureDbInitialized();
        const result: any[] = await this.db!.select("SELECT value FROM settings WHERE key = $1", [key]);
        return result.length > 0 ? result[0].value : '';
    }

    public async insertNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        console.log(note)
        await this.db!.execute(
            "INSERT INTO note (id,content, color, created_at, updated_at) VALUES ($1,$2, $3, $4, $5)",
            [note.id,note.content, note.color || '', now, now]
        );
        // 统计埋点（fire-and-forget）：新建便签 +1
        void statsService.record({ note_added: 1 });
    }

    public async updateNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE note SET content = $1, color = $2, updated_at = $3 WHERE id = $4",
            [note.content, note.color || '', now, note.id]
        );
    }

    public async deleteNote(noteId: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM note WHERE id = $1", [noteId]);
        // 统计埋点（fire-and-forget）：删除便签 +1
        void statsService.record({ note_deleted: 1 });
    }

    public async fetchNotes(filter: any): Promise<Note[]> {
        await this.ensureDbInitialized();

        const content: string = filter.value.searchContent;

        return await this.db!.select(
            "SELECT * FROM note WHERE content LIKE $1 ORDER BY updated_at DESC LIMIT 500",
            [`%${content}%`]
        ) as Note[];
    }

    public async fetchSingleNote(noteId: string): Promise<Note> {
        const data = await this.db!.select("SELECT * FROM note WHERE id = $1", [noteId]) as Note[];
        return data[0] as Note;
    }


    public async insertTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const level = clampPriorityLevel(todo.priorityLevel);
        await this.db!.execute(
            "INSERT INTO todo (id,title, description, completed, priority, priority_level, category, created_at, updated_at, dueDate, remind_mode, remind_at, remind_rules) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
            [todo.id,todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules)]
        );
        // 统计埋点（fire-and-forget）：新建待办 +1，并累计任务标题+描述的字符数
        const todoChars = (todo.title?.length ?? 0) + (todo.description?.length ?? 0);
        void statsService.record({ todo_added: 1, todo_chars: todoChars });
    }

    public async updateTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const level = clampPriorityLevel(todo.priorityLevel);
        await this.db!.execute(
            "UPDATE todo SET title = $1, description = $2, completed = $3, priority = $4, priority_level = $5, category = $6, updated_at = $7, dueDate = $8, remind_mode = $9, remind_at = $10, remind_rules = $11 WHERE id = $12",
            [todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules), todo.id]
        );
    }

    public async deleteTodo(todoId: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM todo WHERE id = $1", [todoId]);
        // 统计埋点（fire-and-forget）：删除待办 +1
        void statsService.record({ todo_deleted: 1 });
    }

    public async fetchTodos(filter: any): Promise<Todo[]> {
        await this.ensureDbInitialized();

        const content: string = filter.value.searchContent;

        const rows = await this.db!.select(
            "SELECT * FROM todo WHERE title LIKE $1 ORDER BY updated_at DESC LIMIT 500",
            [`%${content}%`]
        ) as Todo[];
        return rows.map(mapTodoRemindRules);
    }

    public async fetchSingleTodo(todoId: string): Promise<Todo> {
        const data = await this.db!.select("SELECT * FROM todo WHERE id = $1", [todoId]) as Todo[];
        return data[0] ? mapTodoRemindRules(data[0]) : data[0];
    }


}

const clipboardService = ClipboardService.getInstance();

export default clipboardService
