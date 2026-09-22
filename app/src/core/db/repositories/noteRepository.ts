import type { DatabaseConnection } from '../connection';
import type { Note } from '../../../entities';
import { escapeLike, withPage, type PageQuery } from '../sql';

/**
 * 便签领域仓储（note 表）。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface NoteRepository {
    insertNote(note: Note): Promise<void>;
    updateNote(note: Note): Promise<void>;
    deleteNote(noteId: string): Promise<void>;
    fetchNotes(filter: any, page?: PageQuery): Promise<Note[]>;
    fetchSingleNote(noteId: string): Promise<Note | undefined>;
}

/** 统计埋点依赖（注入 statsService.record，仓储不直接依赖统计服务实现） */
export type RecordStats = (partial: { [key: string]: number | undefined }) => Promise<void> | void;

export function createNoteRepository({ conn, recordStats }: { conn: DatabaseConnection; recordStats: RecordStats }): NoteRepository {
    return {
        async insertNote(note: Note): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            console.log(note)
            await db.execute(
                "INSERT INTO note (id,content, color, created_at, updated_at) VALUES ($1,$2, $3, $4, $5)",
                [note.id,note.content, note.color || '', now, now]
            );
            // 统计埋点（fire-and-forget）：新建便签 +1
            void recordStats({ note_added: 1 });
        },

        async updateNote(note: Note): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            await db.execute(
                "UPDATE note SET content = $1, color = $2, updated_at = $3 WHERE id = $4",
                [note.content, note.color || '', now, note.id]
            );
        },

        async deleteNote(noteId: string): Promise<void> {
            const db = await conn.ready();
            await db.execute("DELETE FROM note WHERE id = $1", [noteId]);
            // 统计埋点（fire-and-forget）：删除便签 +1
            void recordStats({ note_deleted: 1 });
        },

        async fetchNotes(filter: any, page?: PageQuery): Promise<Note[]> {
            const db = await conn.ready();

            const content: string = filter.value.searchContent;
            const baseSql = "SELECT * FROM note WHERE content LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC, id DESC";
            const params = [`%${escapeLike(content)}%`];

            if (page) {
                const { sql, params: pageParams } = withPage(page, params);
                return await db.select(baseSql + sql, pageParams) as Note[];
            }
            // 未传分页（全量查询，用于搜索"全部范围"等场景）：保留 500 条上限防止极端数据拉爆内存
            return await db.select(baseSql + " LIMIT 500", params) as Note[];
        },

        async fetchSingleNote(noteId: string): Promise<Note | undefined> {
            const db = await conn.ready();
            const data = await db.select("SELECT * FROM note WHERE id = $1", [noteId]) as Note[];
            return data[0];
        },
    };
}
