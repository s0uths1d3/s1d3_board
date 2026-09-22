import { afterAll, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { runDatabaseMigrations } from '../migrator';
import { connWith, stubDb, type RecordedCall } from '../repositories/__tests__/helpers';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

describe('migrator', () => {
    afterAll(() => { vi.useRealTimers(); });

    it('兜底建表 + 补列 + 遗留备份丢弃 + 图片迁移触发，且进程内幂等 once', async () => {
        const { db, executes } = stubDb((sql) => {
            // 存量图片迁移：候选行与批量取回
            if (sql.includes("content NOT LIKE 'imgfile:%'")) return [{ id: 1 }];
            if (sql.includes('WHERE id IN')) return [{ id: 1, content: 'data:image/png;base64,OLD' }];
            return [];
        });
        const conn = await connWith(db);

        await runDatabaseMigrations(conn);
        // 迁移主体同步完成后，fire-and-forget 的存量图片迁移带 3s 启动延迟（真实定时器）
        await vi.waitFor(() => {
            expect(vi.mocked(invoke)).toHaveBeenCalledWith('save_clipboard_image', { dataUrl: 'data:image/png;base64,OLD' });
        }, { timeout: 6000, interval: 100 });

        // 兜底建表
        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE TABLE IF NOT EXISTS app_usage'))).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE TABLE IF NOT EXISTS clip_templates'))).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE TABLE IF NOT EXISTS island_history'))).toBe(true);
        // 补列：无列信息（空 PRAGMA 结果）→ 全部 wanted 都 ALTER
        expect(executes.some((c: RecordedCall) => c.sql === 'ALTER TABLE todo ADD COLUMN remind_mode TEXT')).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql === 'ALTER TABLE clipboard ADD COLUMN source_app TEXT')).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql === 'ALTER TABLE clipboard ADD COLUMN qr_text TEXT')).toBe(true);
        // priority_level 补建后回填存量
        expect(executes.some((c: RecordedCall) => c.sql.includes('UPDATE todo SET priority_level = CASE priority'))).toBe(true);
        // 遗留清空备份丢弃
        expect(executes.some((c: RecordedCall) => c.sql === 'DROP TABLE IF EXISTS clear_backup_clipboard')).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql === 'DROP TABLE IF EXISTS clear_backup_app_usage')).toBe(true);
        // 图片超限/失败保留原样：invoke 桩返回 null → 不执行 NOT EXISTS 守卫 UPDATE
        expect(executes.some((c: RecordedCall) => c.sql.includes('NOT EXISTS (SELECT 1 FROM clipboard WHERE content = $1)'))).toBe(false);

        // 幂等 once：第二次调用不重复执行
        const firstCount = executes.length;
        await runDatabaseMigrations(conn);
        expect(executes.length).toBe(firstCount);
    });
});
