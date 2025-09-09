import Database from "@tauri-apps/plugin-sql";
import { onTextUpdate, startListening } from 'tauri-plugin-clipboard-api';
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
        const dbName = 'sqlite:s1de_board.db';
        this.db = await Database.load(dbName);
    }

    public async ensureDbInitialized() {
        if (!this.db) {
            await this.initDatabase();
        }
    }

    public async startClipboardListener() {
        await this.ensureDbInitialized();

        await onTextUpdate(async (newText) => {
            const now = Math.floor(Date.now());
            const existingRecord: ClipboardData[] = await this.db!.select(
                "SELECT id FROM clipboard WHERE content = $1",
                [newText]
            );

            if (existingRecord.length === 0) {
                const result = await this.db!.execute(
                    "INSERT INTO clipboard (content, category, created_at, updated_at) VALUES ($1, $2, $3, $4) ",
                    [newText, 'T', now, now]
                );
                console.log("New record inserted:", result);
            } else {
                const record = existingRecord[0];
                if (record && record.id !== undefined) {
                    const result = await this.db!.execute(
                        "UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1",
                        [record.id, now]
                    );
                    console.log("Count incremented:", result);
                } else {
                    console.error("Existing record is missing an ID:", existingRecord);
                    throw new Error("Existing record is missing an ID");
                }
            }
        });
        await startListening();
        console.log("Clipboard listener started");
    }


    public async fetchClipboardData(filter: any): Promise<ClipboardData[]> {
        await this.ensureDbInitialized();

        const favorite: number = filter.value.favorite;
        const content: string = filter.value.searchContent;

        let sql = `SELECT * FROM clipboard WHERE content like '%${content}%' ORDER BY updated_at DESC LIMIT 500`;
        if (favorite === 1) {
            sql = `SELECT * FROM clipboard WHERE is_favorite = ${favorite} and content like '%${content}%' ORDER BY updated_at DESC LIMIT 100`;
        }
        return await this.db!.select(sql) as ClipboardData[];
    }

    public async fetchClipboardSingleData(id: number): Promise<ClipboardData> {
        let sql = `SELECT * FROM clipboard WHERE id = ${id}`;
        const data =  await this.db!.select(sql) as ClipboardData[]
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

    public  async  getShortcutSetting():Promise<any> {
        await this.ensureDbInitialized();
        return  await this.db!.select("SELECT * FROM settings WHERE type = $1", ['shortcut']);
    }

    public async setKeyValue(key : string,value: string): Promise<void> {
        console.log(value);
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute("UPDATE settings SET value = $1, last_modified = $2 WHERE key = $3", [value, now,key]);
    }

    public async getKeyValue(key:string): Promise<string> {
        await this.ensureDbInitialized();
        const result: any[] = await this.db!.select("SELECT value FROM settings WHERE key = $1", [key]);
        return result[0].value;
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

        let sql = `SELECT * FROM note WHERE content like '%${content}%' ORDER BY updated_at DESC LIMIT 500`;
        return await this.db!.select(sql) as Note[];
    }

    public async fetchSingleNote(noteId: string): Promise<Note> {
        let sql = `SELECT * FROM note WHERE id = ${noteId}`;
        const data = await this.db!.select(sql) as Note[];
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

        let sql = `SELECT * FROM todo WHERE title like '%${content}%' ORDER BY updated_at DESC LIMIT 500`;
        return await this.db!.select(sql) as Todo[];
    }

    public async fetchSingleTodo(todoId: string): Promise<Todo> {
        let sql = `SELECT * FROM todo WHERE id = ${todoId}`;
        const data = await this.db!.select(sql) as Todo[];
        return data[0] as Todo;
    }


}

const clipboardService = ClipboardService.getInstance();

export default clipboardService
