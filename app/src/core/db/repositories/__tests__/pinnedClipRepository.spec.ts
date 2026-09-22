import { describe, expect, it } from 'vitest';
import { createPinnedClipRepository } from '../pinnedClipRepository';
import { connWith, stubDb } from './helpers';

describe('pinnedClipRepository', () => {
    it('fetchPinnedClips：置顶优先排序 + 分页参数化', async () => {
        const { db, selects } = stubDb(() => [{ id: 1, content: 'x', type: 'text' }]);
        const repo = createPinnedClipRepository({ conn: await connWith(db) });

        const rows = await repo.fetchPinnedClips({ offset: 40, limit: 20 });

        expect(rows).toHaveLength(1);
        const sql = selects.at(-1)?.sql ?? '';
        expect(sql).toContain("CASE WHEN pinned_at IS NOT NULL AND pinned_at != '' THEN 1 ELSE 0 END DESC");
        expect(sql).toContain('LIMIT $1 OFFSET $2');
        expect(selects.at(-1)?.params).toEqual([20, 40]);
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
