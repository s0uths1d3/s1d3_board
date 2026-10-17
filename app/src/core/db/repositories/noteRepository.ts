import type { DatabaseConnection } from '../connection';
import type { Note } from '../../../entities';
import { withPage, buildLikeGroups, type PageQuery } from '../sql';

/**
 * 便签领域仓储（note 表）。
 * 便签功能扩展（便签 §0-§5）：全列 update / 软删回收站 / 置顶 / 标签 / 提醒时刻。
 * tags 与待办同模式：DB 存 JSON 字符串数组文本，仓储层解析/序列化，应用层拿 string[]。
 */

export interface NoteRepository {
    insertNote(note: Note): Promise<void>;
    updateNote(note: Note): Promise<void>;
    /** 软删（进回收站）：写 deleted_at；真删走 purgeNote */
    deleteNote(noteId: string): Promise<void>;
    /** 彻底删除：真 DELETE */
    purgeNote(noteId: string): Promise<void>;
    /** 从回收站恢复：清 deleted_at */
    restoreNote(noteId: string): Promise<void>;
    /** 批量写手动排序（拖动重排持久化）：整区回填 0..n-1，不触碰 updated_at（时间排序不受影响） */
    updateNoteSortOrder(items: Array<{ id: string; sortOrder: number }>): Promise<void>;
    /** 未删除便签查询（主列表/提醒调度等场景） */
    fetchNotes(filter: any, page?: PageQuery): Promise<Note[]>;
    /** 回收站列表：deleted_at IS NOT NULL，按删除时间倒序 */
    fetchDeletedNotes(page?: PageQuery): Promise<Note[]>;
    fetchSingleNote(noteId: string): Promise<Note | undefined>;
}

/** 统计埋点依赖（注入 statsService.record，仓储不直接依赖统计服务实现） */
export type RecordStats = (partial: { [key: string]: number | undefined }) => Promise<void> | void;

/** DB 行 tags JSON 文本 → string[]（容错：非法 JSON / 非数组 / 非字符串成员回退空数组） */
function parseNoteTags(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw === '') return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string') : [];
    } catch {
        return [];
    }
}

/** string[] → DB 存储文本（空数组存 ''，与待办 stringifyTags 同语义） */
function stringifyNoteTags(tags?: string[]): string {
    return tags && tags.length ? JSON.stringify(tags) : '';
}

/** DB 行 → 应用层 Note（tags 解析；pinned/sort_order 兜底 0） */
function mapNoteRow(row: any): Note {
    return { ...row, pinned: row.pinned ?? 0, sort_order: row.sort_order ?? 0, tags: parseNoteTags(row.tags) };
}

export function createNoteRepository({ conn, recordStats }: { conn: DatabaseConnection; recordStats: RecordStats }): NoteRepository {
    return {
        async insertNote(note: Note): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            // sort_order 取未删除区最大值 +1：新便签在手动排序下排区末尾（其它排序模式忽略该列）
            await db.execute(
                "INSERT INTO note (id, content, color, created_at, updated_at, pinned, tags, remind_at, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM note WHERE deleted_at IS NULL))",
                [note.id, note.content, note.color || '', now, now, note.pinned ?? 0, stringifyNoteTags(note.tags), note.remind_at || '']
            );
            // 统计埋点（fire-and-forget）：新建便签 +1
            void recordStats({ note_added: 1 });
        },

        async updateNote(note: Note): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            // 全列 SET：调用方传入的对象即完整状态（软删/置顶等状态切换均走本方法）
            await db.execute(
                "UPDATE note SET content = $1, color = $2, updated_at = $3, pinned = $4, tags = $5, remind_at = $6 WHERE id = $7",
                [note.content, note.color || '', now, note.pinned ?? 0, stringifyNoteTags(note.tags), note.remind_at || '', note.id]
            );
        },

        async deleteNote(noteId: string): Promise<void> {
            const db = await conn.ready();
            // 软删（进回收站）：写 deleted_at；updated_at 不动（主列表按 updated_at 排序，软删行退出列表）
            await db.execute("UPDATE note SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL", [String(Date.now()), noteId]);
            // 统计埋点（fire-and-forget）：删除便签 +1（真删 purgeNote 不重复计数）
            void recordStats({ note_deleted: 1 });
        },

        async purgeNote(noteId: string): Promise<void> {
            const db = await conn.ready();
            await db.execute("DELETE FROM note WHERE id = $1", [noteId]);
        },

        async restoreNote(noteId: string): Promise<void> {
            const db = await conn.ready();
            await db.execute("UPDATE note SET deleted_at = NULL WHERE id = $1", [noteId]);
        },

        async updateNoteSortOrder(items: Array<{ id: string; sortOrder: number }>): Promise<void> {
            if (items.length === 0) return
            const db = await conn.ready();
            // 单条 CASE WHEN 批量 UPDATE（原子落位，只动 sort_order 不触碰 updated_at）。
            // 不用 BEGIN/COMMIT：tauri-plugin-sql 的 execute 走连接池，事务语句可能落在
            // 不同连接上（COMMIT 时当前连接无事务 → "cannot commit - no transaction is active"）；
            // 单条语句天然原子，无需显式事务
            const n = items.length;
            const cases = items.map((_, i) => `WHEN $${i + 1} THEN $${n + i + 1}`).join(' ');
            const inList = items.map((_, i) => `$${i + 1}`).join(',');
            const params = [...items.map(it => it.id), ...items.map(it => it.sortOrder)];
            await db.execute(`UPDATE note SET sort_order = CASE id ${cases} END WHERE id IN (${inList})`, params);
        },

        async fetchNotes(filter: any, page?: PageQuery): Promise<Note[]> {
            const db = await conn.ready();

            const content: string = filter.value.searchContent;
            // 高级搜索：与剪贴板同一套词法（buildLikeGroups 收编 parseSearchTokens + searchPattern）——
            // 空格拆词 AND、双引号整句、* ? 通配符、| 组内 OR；开关随 filter.advanced（缺省视为开启，同剪贴板）。
            // 大小写区分开关随 filter.caseSensitive（缺省不区分）：区分时切 GLOB 算子，词法语义不变。
            // 空搜索词无匹配条件（全量），全量查询行为不变
            const { sql: likeSql, params } = buildLikeGroups(content, 'content', filter.value.advanced !== false, filter.value.caseSensitive === true);
            const baseSql = `SELECT * FROM note WHERE deleted_at IS NULL${likeSql ? ` AND ${likeSql}` : ''} ORDER BY updated_at DESC, id DESC`;

            if (page) {
                const { sql, params: pageParams } = withPage(page, params);
                return (await db.select(baseSql + sql, pageParams) as any[]).map(mapNoteRow);
            }
            // 未传分页（全量查询，用于搜索"全部范围"等场景）：保留 500 条上限防止极端数据拉爆内存
            return (await db.select(baseSql + " LIMIT 500", params) as any[]).map(mapNoteRow);
        },

        async fetchDeletedNotes(page?: PageQuery): Promise<Note[]> {
            const db = await conn.ready();
            const baseSql = "SELECT * FROM note WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC";
            if (page) {
                const { sql, params } = withPage(page, []);
                return (await db.select(baseSql + sql, params) as any[]).map(mapNoteRow);
            }
            return (await db.select(baseSql) as any[]).map(mapNoteRow);
        },

        async fetchSingleNote(noteId: string): Promise<Note | undefined> {
            const db = await conn.ready();
            const data = await db.select("SELECT * FROM note WHERE id = $1", [noteId]) as any[];
            return data[0] ? mapNoteRow(data[0]) : undefined;
        },
    };
}
