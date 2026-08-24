import Database from "@tauri-apps/plugin-sql";
import { onTextUpdate, onSomethingUpdate, readImageBase64, startListening } from 'tauri-plugin-clipboard-api';
import type { ClipboardData,Note,Todo } from "../Entities";


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
        const limit = favorite === 1 ? 100 : 500;
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
    }

    public async increaseUseCount(id: number): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute("UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1", [id, now]);
    }

    public async deleteClipboardData(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM clipboard WHERE id = $1", [id]);
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
        await this.db!.execute(
            "INSERT INTO todo (id,title, description, completed, priority, category, created_at, updated_at, dueDate) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [todo.id,todo.title, todo.description || '', todo.completed, todo.priority, todo.category || '', now, now, todo.dueDate || '']
        );
    }

    public async updateTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE todo SET title = $1, description = $2, completed = $3, priority = $4, category = $5, updated_at = $6, dueDate = $7 WHERE id = $8",
            [todo.title, todo.description || '', todo.completed, todo.priority, todo.category || '', now, todo.dueDate || '', todo.id]
        );
    }

    public async deleteTodo(todoId: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM todo WHERE id = $1", [todoId]);
    }

    public async fetchTodos(filter: any): Promise<Todo[]> {
        await this.ensureDbInitialized();

        const content: string = filter.value.searchContent;

        return await this.db!.select(
            "SELECT * FROM todo WHERE title LIKE $1 ORDER BY updated_at DESC LIMIT 500",
            [`%${content}%`]
        ) as Todo[];
    }

    public async fetchSingleTodo(todoId: string): Promise<Todo> {
        const data = await this.db!.select("SELECT * FROM todo WHERE id = $1", [todoId]) as Todo[];
        return data[0] as Todo;
    }


}

const clipboardService = ClipboardService.getInstance();

export default clipboardService
