import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { createBackupRepository, CLEAR_BACKUP_TABLES } from '../backupRepository';
import { connWith, stubDb } from './helpers';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

describe('backupRepository', () => {
    it('clearDatabase：备份 → 清业务表 → 统计钩子 → 自增重置（顺序不变）', async () => {
        const { db, executes } = stubDb();
        const repo = createBackupRepository({ conn: await connWith(db) });
        const clearStats = vi.fn(async () => {});

        await repo.clearDatabase(clearStats);

        const sqls = executes.map((c) => c.sql);
        expect(sqls.slice(0, 10)).toEqual(
            CLEAR_BACKUP_TABLES.flatMap(({ src, backup }) => [`DROP TABLE IF EXISTS ${backup}`, `CREATE TABLE ${backup} AS SELECT * FROM ${src}`]),
        );
        expect(sqls.slice(10, 13)).toEqual(['DELETE FROM clipboard', 'DELETE FROM note', 'DELETE FROM todo']);
        expect(clearStats).toHaveBeenCalledTimes(1);
        // 统计钩子在业务表之后、sqlite_sequence 重置之前
        expect(sqls[13]).toBe("DELETE FROM sqlite_sequence WHERE name IN ('clipboard', 'note', 'todo')");
    });

    it('undoClearDatabase：无备份返回 false；有备份整表还原并删除备份', async () => {
        const noneRepo = createBackupRepository({ conn: await connWith(stubDb().db) });
        expect(await noneRepo.undoClearDatabase()).toBe(false);

        // 仅 clear_backup_clipboard 存在（按 tableExists 的参数区分）
        const { db, executes } = stubDb((sql, params) =>
            (sql.includes('sqlite_master') && params?.[0] === 'clear_backup_clipboard' ? [{ name: 'clear_backup_clipboard' }] : []));
        const repo = createBackupRepository({ conn: await connWith(db) });

        expect(await repo.undoClearDatabase()).toBe(true);
        const sqls = executes.filter((c) => !c.sql.includes('sqlite_master')).map((c) => c.sql);
        expect(sqls).toEqual([
            'DELETE FROM clipboard', 'INSERT INTO clipboard SELECT * FROM clear_backup_clipboard', 'DROP TABLE clear_backup_clipboard',
        ]);
    });

    it('finalizeClear：删除未被当前表再引用的图片孤儿文件，随后丢弃全部备份', async () => {
        const { db, selects, executes } = stubDb(() => [{ content: 'imgfile:orphan.png' }]);
        const repo = createBackupRepository({ conn: await connWith(db) });

        await repo.finalizeClear();

        expect(vi.mocked(invoke)).toHaveBeenCalledWith('delete_clipboard_image_file', { file: 'orphan.png' });
        const drops = executes.filter((c) => c.sql.startsWith('DROP TABLE IF EXISTS')).map((c) => c.sql);
        expect(drops).toHaveLength(CLEAR_BACKUP_TABLES.length);
        // 孤儿查询只取当前 clipboard 表未引用的 imgfile: 条目（SELECT 记录在 selects，前面是连接 PRAGMA）
        const orphanQuery = selects.find((c) => c.sql.includes('clear_backup_clipboard'));
        expect(orphanQuery?.sql).toContain("WHERE type = 'image' AND content LIKE 'imgfile:%'");
        expect(orphanQuery?.sql).toContain('AND content NOT IN (SELECT content FROM clipboard)');
    });

    it('finalizeClear：孤儿查询失败（备份表不存在）静默跳过，备份仍被丢弃', async () => {
        const { db, executes } = stubDb(() => { throw new Error('no such table'); });
        const repo = createBackupRepository({ conn: await connWith(db) });

        await expect(repo.finalizeClear()).resolves.toBeUndefined();
        expect(executes.filter((c) => c.sql.startsWith('DROP TABLE IF EXISTS'))).toHaveLength(CLEAR_BACKUP_TABLES.length);
    });
});
