import { describe, expect, it } from 'vitest';
import { createIslandHistoryRepository } from '../islandHistoryRepository';
import { connWith, stubDb } from './helpers';

describe('islandHistoryRepository', () => {
    it('insertIslandHistory：INSERT + FIFO 裁剪保留最近 500 条（走锁重试通道）', async () => {
        const { db, executes } = stubDb();
        const repo = createIslandHistoryRepository({ conn: await connWith(db) });

        await repo.insertIslandHistory({ kind: 'copy', text: 'hello' });

        expect(executes[0]?.sql).toBe('INSERT INTO island_history (kind, text, created_at) VALUES ($1, $2, $3)');
        expect(executes[1]?.sql).toBe('DELETE FROM island_history WHERE id NOT IN (SELECT id FROM island_history ORDER BY id DESC LIMIT 500)');
    });

    it('getIslandHistory：无过滤 = WHERE 省略；kind/from/to 过滤在 SQL 侧执行', async () => {
        const { db, selects } = stubDb(() => [{ id: 2, kind: 'copy', text: 't', created_at: 123 }]);
        const repo = createIslandHistoryRepository({ conn: await connWith(db) });

        const rows = await repo.getIslandHistory();
        expect(rows).toEqual([{ id: 2, kind: 'copy', text: 't', createdAt: 123 }]);
        expect(selects.at(-1)?.sql).toBe('SELECT id, kind, text, created_at FROM island_history ORDER BY id DESC LIMIT $1');
        expect(selects.at(-1)?.params).toEqual([500]);

        await repo.getIslandHistory(10, { kind: 'paste', from: 100, to: 200 });
        const filtered = selects.at(-1)?.sql ?? '';
        expect(filtered).toContain('WHERE kind = $1 AND created_at >= $2 AND created_at < $3');
        expect(filtered).toContain('ORDER BY id DESC LIMIT $4');
        expect(selects.at(-1)?.params).toEqual(['paste', 100, 200, 10]);
    });

    it('clearIslandHistory：DELETE 全表', async () => {
        const { db, executes } = stubDb();
        const repo = createIslandHistoryRepository({ conn: await connWith(db) });

        await repo.clearIslandHistory();

        expect(executes[0]?.sql).toBe('DELETE FROM island_history');
        expect(executes).toHaveLength(1);
    });
});
