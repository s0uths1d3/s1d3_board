import { describe, expect, it, vi } from 'vitest';
import { createSchemeRepository } from '../schemeRepository';
import { connWith, stubDb } from './helpers';

describe('schemeRepository', () => {
    it('fetchClipSchemes：title 兜底 name、members JSON 解析、脏数据空数组', async () => {
        const { db } = stubDb(() => [
            { id: 's1', name: '旧名', title: '', description: null, members: '["a","b"]', body: 'B', enabled: 1, created_at: 't', updated_at: 't' },
            { id: 's2', name: '旧名2', title: '新题', members: '{broken', body: '', enabled: 0, created_at: 't', updated_at: 't' },
        ]);
        const repo = createSchemeRepository({ conn: await connWith(db) });

        const schemes = await repo.fetchClipSchemes();

        expect(schemes[0]).toMatchObject({ id: 's1', title: '旧名', members: ['a', 'b'], description: '' });
        expect(schemes[1]).toMatchObject({ id: 's2', title: '新题', members: [] });
    });

    it('saveClipScheme：UPSERT 且 name 列同步写 title', async () => {
        const { db, executes } = stubDb();
        const repo = createSchemeRepository({ conn: await connWith(db) });

        await repo.saveClipScheme({ id: 's1', title: '方案', description: 'D', members: ['x'], body: 'B', enabled: 1, created_at: '', updated_at: '' });

        expect(executes[0]?.sql).toContain('INSERT INTO clip_templates');
        expect(executes[0]?.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
        expect(executes[0]?.params).toEqual(['s1', '方案', '方案', 'D', '["x"]', 'B', 1]);
    });

    it('insertClipHabit：插入 + 裁剪保留最近 500 条', async () => {
        const { db, executes } = stubDb();
        const repo = createSchemeRepository({ conn: await connWith(db) });

        await repo.insertClipHabit({ contentHash: 'h', extractorId: 'url', action: 'paste', segmentText: 's' });

        expect(executes[0]?.sql).toContain('INSERT INTO clip_habits');
        expect(executes[1]?.sql).toContain('DELETE FROM clip_habits WHERE id NOT IN');
    });

    it('fetchHabitDigest：snake_case → camelCase + 数值化', async () => {
        const { db } = stubDb(() => [{ extractor_id: 'url', count: '3' }]);
        const repo = createSchemeRepository({ conn: await connWith(db) });

        expect(await repo.fetchHabitDigest()).toEqual([{ extractorId: 'url', count: 3 }]);
    });

    it('getAiCache：windowSec=0 不查库；命中返回；过期返回 null', async () => {
        const zeroRepo = createSchemeRepository({ conn: await connWith(stubDb().db) });
        expect(await zeroRepo.getAiCache('k', 0)).toBeNull();

        const freshDb = stubDb(() => [{ output: 'OUT', created_at: Date.now() }]);
        const freshRepo = createSchemeRepository({ conn: await connWith(freshDb.db) });
        expect(await freshRepo.getAiCache('k', 60)).toBe('OUT');

        const staleRepo = createSchemeRepository({
            conn: await connWith(stubDb(() => [{ output: 'OUT', created_at: Date.now() - 61_000 }]).db),
        });
        expect(await staleRepo.getAiCache('k', 60)).toBeNull();
    });

    it('setAiCache：ON CONFLICT 覆盖写', async () => {
        const { db, executes } = stubDb();
        const repo = createSchemeRepository({ conn: await connWith(db) });

        await repo.setAiCache('k', 'v');

        expect(executes[0]?.sql).toContain('INSERT INTO clip_ai_cache');
        expect(executes[0]?.sql).toContain('ON CONFLICT(key) DO UPDATE SET output = $2, created_at = $3');
    });

    it('deleteClipScheme：按 id 删除', async () => {
        const { db, executes } = stubDb();
        const repo = createSchemeRepository({ conn: await connWith(db) });

        await repo.deleteClipScheme('s1');

        expect(executes[0]?.sql).toBe('DELETE FROM clip_templates WHERE id = $1');
    });
});
