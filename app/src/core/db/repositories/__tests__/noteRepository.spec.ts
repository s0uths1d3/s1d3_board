import { describe, expect, it, vi } from 'vitest';
import { createNoteRepository } from '../noteRepository';
import { connWith, stubDb } from './helpers';

describe('noteRepository', () => {
    it('insertNote：INSERT 全列 + 统计埋点 note_added', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createNoteRepository({ conn: await connWith(db), recordStats });

        await repo.insertNote({ id: 'n1', content: '内容', color: 'amber', updated_at: '' });

        expect(executes[0]?.sql).toContain('INSERT INTO note (id,content, color, created_at, updated_at)');
        expect(executes[0]?.params).toEqual(['n1', '内容', 'amber', expect.any(Number), expect.any(Number)]);
        expect(recordStats).toHaveBeenCalledWith({ note_added: 1 });
    });

    it('updateNote / deleteNote：更新与删除 + 删除埋点', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createNoteRepository({ conn: await connWith(db), recordStats });

        await repo.updateNote({ id: 'n1', content: '新内容', color: '', updated_at: '' });
        expect(executes[0]?.sql).toBe('UPDATE note SET content = $1, color = $2, updated_at = $3 WHERE id = $4');

        await repo.deleteNote('n1');
        expect(executes[1]?.sql).toBe('DELETE FROM note WHERE id = $1');
        expect(recordStats).toHaveBeenCalledWith({ note_deleted: 1 });
    });

    it('fetchNotes：LIKE 搜索转义 + 分页与 500 条上限', async () => {
        const { db, selects } = stubDb(() => [{ id: 'n1', content: 'x' }]);
        const recordStats = vi.fn(async () => {});
        const repo = createNoteRepository({ conn: await connWith(db), recordStats });

        const paged = await repo.fetchNotes({ value: { searchContent: 'a%b' } }, { offset: 10, limit: 5 });
        expect(paged).toHaveLength(1);
        expect(selects.at(-1)?.sql).toContain('LIMIT $2 OFFSET $3');
        expect(selects.at(-1)?.params).toEqual(['%a\\%b%', 5, 10]);

        // 未传分页：500 条上限（复用同一 db 桩，selects 继续累计可断言）
        const full = createNoteRepository({ conn: await connWith(db), recordStats });
        await full.fetchNotes({ value: { searchContent: 'x' } });
        expect(selects.at(-1)?.sql.endsWith('LIMIT 500')).toBe(true);
    });

    it('fetchSingleNote：单条或 undefined', async () => {
        const recordStats = vi.fn(async () => {});
        const hit = createNoteRepository({ conn: await connWith(stubDb(() => [{ id: 'n1' }]).db), recordStats });
        expect(await hit.fetchSingleNote('n1')).toEqual({ id: 'n1' });

        const miss = createNoteRepository({ conn: await connWith(stubDb().db), recordStats });
        expect(await miss.fetchSingleNote('nope')).toBeUndefined();
    });
});
