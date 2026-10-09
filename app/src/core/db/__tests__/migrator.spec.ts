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

    // runDatabaseMigrations 为进程级 once 守卫：各场景经 resetModules 取全新模块状态独立执行
    async function freshRun(db: Parameters<typeof connWith>[0]) {
        vi.resetModules();
        const { runDatabaseMigrations } = await import('../migrator');
        const conn = await connWith(db);
        await runDatabaseMigrations(conn);
    }

    it('clipboard 重建中断自愈：clipboard 缺失但 v18 残留 → 补完 RENAME 恢复数据（DROP/RENAME 之间被杀场景）', async () => {
        const { db, executes } = stubDb((sql) => {
            if (sql.includes('sqlite_master') && sql.includes("name IN ('clipboard', 'clipboard_v18')")) {
                return [{ name: 'clipboard_v18', sql: 'CREATE TABLE clipboard_v18 (...)' }];
            }
            return [];
        });

        await freshRun(db);

        const renameIdx = executes.findIndex((c: RecordedCall) => c.sql === 'ALTER TABLE clipboard_v18 RENAME TO clipboard');
        expect(renameIdx).toBeGreaterThanOrEqual(0);
        // 收尾：索引补齐 + AUTOINCREMENT 序列校正
        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE INDEX IF NOT EXISTS idx_clip_updated'))).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql.includes("UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM clipboard)"))).toBe(true);
        // 不应再走常规重建（无 DROP/INSERT 拷贝）
        expect(executes.some((c: RecordedCall) => c.sql.includes('INSERT INTO clipboard_v18'))).toBe(false);
    });

    it('clipboard 表完全缺失：按 v18 结构兜底建表，避免 no such table 卡死全功能', async () => {
        const { db, executes } = stubDb(); // 探测返回空：clipboard 与 clipboard_v18 均不存在

        await freshRun(db);

        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE TABLE clipboard') && c.sql.includes('html_content'))).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE INDEX IF NOT EXISTS idx_clip_updated'))).toBe(true);
    });

    it('旧 CHECK 重建前先清 v18 残留：防止重试时 CREATE TABLE clipboard_v18 报 already exists 卡死', async () => {
        const { db, executes } = stubDb((sql) => {
            if (sql.includes('sqlite_master') && sql.includes("name IN ('clipboard', 'clipboard_v18')")) {
                return [
                    { name: 'clipboard', sql: "CREATE TABLE clipboard (type TEXT DEFAULT 'text' CHECK (type IN ('text', 'image')))" },
                    { name: 'clipboard_v18', sql: 'CREATE TABLE clipboard_v18 (上次 INSERT 阶段失败的残留)' },
                ];
            }
            return [];
        });

        await freshRun(db);

        const dropIdx = executes.findIndex((c: RecordedCall) => c.sql === 'DROP TABLE IF EXISTS clipboard_v18');
        const createIdx = executes.findIndex((c: RecordedCall) => c.sql.includes('CREATE TABLE clipboard_v18'));
        expect(dropIdx).toBeGreaterThanOrEqual(0);
        expect(createIdx).toBeGreaterThan(dropIdx);
        expect(executes.some((c: RecordedCall) => c.sql.includes('INSERT INTO clipboard_v18'))).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql === 'DROP TABLE clipboard')).toBe(true);
        expect(executes.some((c: RecordedCall) => c.sql === 'ALTER TABLE clipboard_v18 RENAME TO clipboard')).toBe(true);
    });

    it('clipboard 已是放宽约束的新结构（无旧 CHECK）：不再重建', async () => {
        const { db, executes } = stubDb((sql) => {
            if (sql.includes('sqlite_master') && sql.includes("name IN ('clipboard', 'clipboard_v18')")) {
                return [{ name: 'clipboard', sql: "CREATE TABLE clipboard (type TEXT DEFAULT 'text', html_content TEXT, encrypted INTEGER NOT NULL DEFAULT 0)" }];
            }
            return [];
        });

        await freshRun(db);

        expect(executes.some((c: RecordedCall) => c.sql.includes('CREATE TABLE clipboard_v18'))).toBe(false);
        expect(executes.some((c: RecordedCall) => c.sql === 'DROP TABLE clipboard')).toBe(false);
    });
});
