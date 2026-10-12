import { describe, expect, it } from 'vitest';
import { createPinnedClipRepository } from '../pinnedClipRepository';
import { connWith, stubDb } from './helpers';

describe('pinnedClipRepository', () => {
    it('fetchPinnedClips：手动顺序优先 + 未排序存量时间兜底 + 分页参数化', async () => {
        const { db, selects } = stubDb(() => [{ id: 1, content: 'x', type: 'text' }]);
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        const rows = await repo.fetchPinnedClips({ offset: 40, limit: 20 });

        expect(rows).toHaveLength(1);
        const sql = selects.at(-1)?.sql ?? '';
        expect(sql).toContain("CASE WHEN sort_order > 0 THEN 0 ELSE 1 END");
        expect(sql).toContain('LIMIT $1 OFFSET $2');
        expect(selects.at(-1)?.params).toEqual([20, 40]);
    });

    it('updatePinnedClipSortOrder：单条 CASE WHEN 批量回填（空列表不执行）', async () => {
        const { db, executes } = stubDb();
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        await repo.updatePinnedClipSortOrder([]);
        expect(executes).toHaveLength(0);

        await repo.updatePinnedClipSortOrder([{ id: 7, sortOrder: 1 }, { id: 3, sortOrder: 2 }]);
        expect(executes[0]?.sql).toContain('UPDATE pinned_clip SET sort_order = CASE id WHEN $1 THEN $3 WHEN $2 THEN $4 END');
        expect(executes[0]?.sql).toContain('WHERE id IN ($1, $2)');
        expect(executes[0]?.params).toEqual([7, 3, 1, 2]);
    });

    it('insertPinnedClip：name/source 缺省写空串', async () => {
        const { db, executes } = stubDb();
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        await repo.insertPinnedClip('hello', 'text');

        expect(executes[0]?.sql).toContain('INSERT INTO pinned_clip (content, type, name, source, sort_order, created_at, updated_at)');
        expect(executes[0]?.params).toEqual(['hello', 'text', '', '', 0, expect.any(Number), expect.any(Number)]);
    });

    it('isPinnedContentExist：按 content + type 查重', async () => {
        const hit = createPinnedClipRepository({ conn: await connWith(stubDb(() => [{ id: 1 }]).db) });
        expect(await hit.isPinnedContentExist('a', 'text')).toBe(true);

        const miss = createPinnedClipRepository({ conn: await connWith(stubDb().db) });
        expect(await miss.isPinnedContentExist('a', 'text')).toBe(false);
    });

    it('pinPinnedClip：置顶写时间戳，取消置顶清空', async () => {
        const { db, executes } = stubDb();
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        await repo.pinPinnedClip(5, true);
        expect(executes[0]?.params).toEqual([5, expect.any(Number), expect.any(Number)]);

        await repo.pinPinnedClip(5, false);
        expect(executes[1]?.params).toEqual([5, '', expect.any(Number)]);
    });

    it('deletePinnedClip：仅删常用剪贴条目', async () => {
        const { db, executes } = stubDb();
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        await repo.deletePinnedClip(9);

        expect(executes[0]?.sql).toBe('DELETE FROM pinned_clip WHERE id = $1');
        expect(executes[0]?.params).toEqual([9]);
    });
});
