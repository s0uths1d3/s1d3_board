import { describe, expect, it } from 'vitest';
import { createStatsRepository } from '../statsRepository';
import { connWith, stubDb } from './helpers';

describe('statsRepository', () => {
    it('upsertDailyStat：pending 列展开为参数化 UPSERT（冲突按列累加）', async () => {
        const { db, executes } = stubDb();
        const repo = createStatsRepository({ conn: await connWith(db) });

        await repo.upsertDailyStat('2026-09-22', ['clip_text', 'clip_chars'], [3, 42]);

        expect(executes[0]?.sql).toContain('INSERT INTO daily_stat (stat_date, clip_text, clip_chars)');
        expect(executes[0]?.sql).toContain('VALUES ($1, $2, $3)');
        expect(executes[0]?.sql).toContain('ON CONFLICT(stat_date) DO UPDATE SET clip_text = clip_text + excluded.clip_text, clip_chars = clip_chars + excluded.clip_chars');
        expect(executes[0]?.params).toEqual(['2026-09-22', 3, 42]);
    });

    it('upsertAppUsage / upsertAppIcon：冲突累加与覆盖写', async () => {
        const { db, executes } = stubDb();
        const repo = createStatsRepository({ conn: await connWith(db) });

        await repo.upsertAppUsage('2026-09-22', 'Code', 30, 12);
        expect(executes[0]?.sql).toContain('ON CONFLICT(stat_date, app_name) DO UPDATE SET');
        expect(executes[0]?.params).toEqual(['2026-09-22', 'Code', 30, 12]);

        await repo.upsertAppIcon('Code', 'data:image/png;base64,i');
        expect(executes[1]?.sql).toContain('INSERT INTO app_icons (app_name, icon)');
        expect(executes[1]?.sql).toContain('ON CONFLICT(app_name) DO UPDATE SET icon = excluded.icon');
    });

    it('clearStatsTables：daily_stat → app_usage → app_icons 顺序清空', async () => {
        const { db, executes } = stubDb();
        const repo = createStatsRepository({ conn: await connWith(db) });

        await repo.clearStatsTables();

        expect(executes.map((c) => c.sql)).toEqual(['DELETE FROM daily_stat', 'DELETE FROM app_usage', 'DELETE FROM app_icons']);
    });

    it('fetchDailySeries：按月降采样与逐日两种 SQL 形态', async () => {
        const downDb = stubDb(() => [{ stat_date: '2026-09', value: 7 }]);
        const downRepo = createStatsRepository({ conn: await connWith(downDb.db) });
        const rows = await downRepo.fetchDailySeries('2026-01-01', '2026-09-22', ['clip_text', 'clip_use'], true);
        expect(rows[0]).toEqual({ stat_date: '2026-09', value: 7 });
        expect(downDb.selects.at(-1)?.sql).toContain("strftime('%Y-%m', stat_date)");
        expect(downDb.selects.at(-1)?.sql).toContain('COALESCE(clip_text, 0) + COALESCE(clip_use, 0) AS value');

        const dayDb = stubDb(() => [{ stat_date: '2026-09-21', value: 2 }]);
        const dayRepo = createStatsRepository({ conn: await connWith(dayDb.db) });
        await dayRepo.fetchDailySeries('2026-09-20', '2026-09-22', ['clip_text'], false);
        expect(dayDb.selects.at(-1)?.sql).toContain('SELECT stat_date, COALESCE(clip_text, 0) AS value');
    });

    it('fetchAppUsageRange：JOIN app_icons + SUM 聚合 + 降序', async () => {
        const { db, selects } = stubDb(() => [{ app_name: 'Code', total: 100, active: 40, icon: null }]);
        const repo = createStatsRepository({ conn: await connWith(db) });

        const rows = await repo.fetchAppUsageRange('2026-09-01', '2026-09-22');

        expect(rows[0]?.app_name).toBe('Code');
        const sql = selects.at(-1)?.sql ?? '';
        expect(sql).toContain('LEFT JOIN app_icons i ON i.app_name = u.app_name');
        expect(sql).toContain('ORDER BY SUM(u.usage_seconds) DESC');
    });
});
