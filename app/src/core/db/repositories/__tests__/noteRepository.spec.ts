import { describe, expect, it, vi } from 'vitest';
import { createNoteRepository } from '../noteRepository';
import { connWith, stubDb } from './helpers';

describe('noteRepository', () => {
    it('insertNote：INSERT 全列（pinned/tags/remind_at 兜底，sort_order 子查询取区末）+ 统计埋点 note_added', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createNoteRepository({ conn: await connWith(db), recordStats });

        await repo.insertNote({ id: 'n1', content: '内容', color: 'amber', updated_at: '' });
        expect(executes[0]?.sql).toContain('INSERT INTO note (id, content, color, created_at, updated_at, pinned, tags, remind_at, sort_order)');
        expect(executes[0]?.sql).toContain('(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM note WHERE deleted_at IS NULL)');
        expect(executes[0]?.params).toEqual(['n1', '内容', 'amber', expect.any(Number), expect.any(Number), 0, '', '']);
        expect(recordStats).toHaveBeenCalledWith({ note_added: 1 });

        // 带 tags / pinned / remind_at：tags 序列化为 JSON 文本
        await repo.insertNote({ id: 'n2', content: 'x', color: '', updated_at: '', pinned: 1, tags: ['工作', '速记'], remind_at: '2026-10-11T09:00' });
        expect(executes[1]?.params).toEqual(['n2', 'x', '', expect.any(Number), expect.any(Number), 1, '["工作","速记"]', '2026-10-11T09:00']);
    });

    it('updateNote：全列 SET（content/color/pinned/tags/remind_at）', async () => {
        const { db, executes } = stubDb();
        const repo = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        await repo.updateNote({ id: 'n1', content: '新内容', color: '', updated_at: '', pinned: 1, tags: ['a'] });
        expect(executes[0]?.sql).toBe('UPDATE note SET content = $1, color = $2, updated_at = $3, pinned = $4, tags = $5, remind_at = $6 WHERE id = $7');
        expect(executes[0]?.params).toEqual(['新内容', '', expect.any(Number), 1, '["a"]', '', 'n1']);
    });

    it('deleteNote：软删写 deleted_at（幂等守卫）；purgeNote 真 DELETE；restoreNote 清 deleted_at', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createNoteRepository({ conn: await connWith(db), recordStats });

        await repo.deleteNote('n1');
        expect(executes[0]?.sql).toBe("UPDATE note SET deleted_at = $1 WHERE id = $2 AND deleted_at IS NULL");
        expect(executes[0]?.params?.[0]).toMatch(/^\d+$/); // deleted_at = 毫秒时间戳文本
        expect(executes[0]?.params?.[1]).toBe('n1');
        expect(recordStats).toHaveBeenCalledWith({ note_deleted: 1 });

        await repo.restoreNote('n1');
        expect(executes[1]?.sql).toBe('UPDATE note SET deleted_at = NULL WHERE id = $1');

        await repo.purgeNote('n1');
        expect(executes[2]?.sql).toBe('DELETE FROM note WHERE id = $1');
        // purge 不重复计删除埋点
        expect(recordStats).toHaveBeenCalledTimes(1);
    });

    it('updateNoteSortOrder：单条 CASE WHEN 批量 UPDATE（原子落位，只动 sort_order）', async () => {
        const { db, executes } = stubDb();
        const repo = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        await repo.updateNoteSortOrder([
            { id: 'n1', sortOrder: 0 },
            { id: 'n2', sortOrder: 1 },
        ]);
        // 单条语句天然原子：不走 BEGIN/COMMIT——tauri-plugin-sql execute 走连接池，
        // 事务语句可能落不同连接（"cannot commit - no transaction is active"）
        expect(executes).toHaveLength(1);
        const first = executes[0];
        expect(first?.sql).toContain('UPDATE note SET sort_order = CASE id');
        expect(first?.sql).toContain('WHEN $1 THEN $3');
        expect(first?.sql).toContain('WHEN $2 THEN $4');
        expect(first?.sql).toContain('WHERE id IN ($1,$2)');
        expect(first?.params).toEqual(['n1', 'n2', 0, 1]);

        // 空列表：不执行任何 SQL
        await repo.updateNoteSortOrder([]);
        expect(executes).toHaveLength(1);

        // 失败直接上抛（单条语句无需 ROLLBACK）
        const failing = stubDb();
        failing.db.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
            failing.executes.push({ sql, params });
            throw new Error('boom');
        });
        const repo2 = createNoteRepository({ conn: await connWith(failing.db), recordStats: vi.fn(async () => {}) });
        await expect(repo2.updateNoteSortOrder([{ id: 'n1', sortOrder: 0 }])).rejects.toThrow('boom');
        expect(failing.executes).toHaveLength(1);
    });

    it('fetchNotes：过滤软删 + LIKE 搜索转义 + 分页与 500 条上限', async () => {
        const { db, selects } = stubDb(() => [{ id: 'n1', content: 'x', tags: '["a"]', pinned: null }]);
        const repo = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        const paged = await repo.fetchNotes({ value: { searchContent: 'a%b' } }, { offset: 10, limit: 5 });
        expect(selects.at(-1)?.sql).toContain('WHERE deleted_at IS NULL AND content LIKE $1');
        expect(selects.at(-1)?.sql).toContain('LIMIT $2 OFFSET $3');
        expect(selects.at(-1)?.params).toEqual(['%a\\%b%', 5, 10]);
        // 行映射：tags JSON 解析、pinned/sort_order 兜底 0
        expect(paged[0]).toEqual({ id: 'n1', content: 'x', tags: ['a'], pinned: 0, sort_order: 0 });

        const full = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });
        await full.fetchNotes({ value: { searchContent: 'x' } });
        expect(selects.at(-1)?.sql.endsWith('LIMIT 500')).toBe(true);
    });

    it('fetchDeletedNotes：deleted_at IS NOT NULL 倒序', async () => {
        const { db, selects } = stubDb(() => []);
        const repo = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        await repo.fetchDeletedNotes();
        expect(selects.at(-1)?.sql).toContain('WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    });

    it('mapNoteRow 容错：tags 非法 JSON / 非数组 / 非字符串成员回退空数组', async () => {
        const { db } = stubDb(() => [{ id: 'n1', tags: '{oops', pinned: undefined }]);
        const repo = createNoteRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });
        const note = await repo.fetchSingleNote('n1');
        expect(note?.tags).toEqual([]);
        expect(note?.pinned).toBe(0);
    });
});
