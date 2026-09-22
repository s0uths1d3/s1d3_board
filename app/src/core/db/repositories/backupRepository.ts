import type { DatabaseConnection } from '../connection';
import { deleteImageFileByRef } from '../imageRef';

/**
 * 清空撤回领域仓储（clear_backup_* 三件套）。
 * 自 dbService 原样平移，SQL 逐字保留。
 */

/**
 * 清空撤回机制的备份表映射：清空前各业务/统计表整表复制到 clear_backup_*，
 * 5 秒撤回窗口内可整表恢复，窗口结束或应用重启后丢弃。
 */
export const CLEAR_BACKUP_TABLES = [
    { src: 'clipboard', backup: 'clear_backup_clipboard' },
    { src: 'note', backup: 'clear_backup_note' },
    { src: 'todo', backup: 'clear_backup_todo' },
    { src: 'daily_stat', backup: 'clear_backup_daily_stat' },
    { src: 'app_usage', backup: 'clear_backup_app_usage' },
] as const;

export interface BackupRepository {
    /**
     * 清空业务数据（剪贴板 / 便签 / 待办）与统计数据（daily_stat），
     * 保留配置表（settings、shortcut_binding）与常用剪贴（pinned_clip，重置不动它，单条删除走 deletePinnedClip）。
     * 同时重置各表的自增主键计数。
     *
     * 清空前把上述表完整备份到 clear_backup_* 表，配合 undoClearDatabase（5 秒
     * 撤回窗口内整表恢复）与 finalizeClear（窗口结束后丢弃备份）实现可撤回清空；
     * 上次会话遗留的备份在启动迁移（migrator）中清理。
     * clearStats = 统计清空钩子（statsService.clearAll：先丢内存累加器再删统计表），保持原调用顺序。
     */
    clearDatabase(clearStats: () => Promise<void>): Promise<void>;
    /** 撤回清空：把 clear_backup_* 备份整表还原。返回是否有备份被恢复。 */
    undoClearDatabase(): Promise<boolean>;
    /** 撤回窗口结束：丢弃备份，清空彻底生效（幂等，可在无备份时安全调用） */
    finalizeClear(): Promise<void>;
}

export function createBackupRepository({ conn }: { conn: DatabaseConnection }): BackupRepository {
    async function tableExists(name: string): Promise<boolean> {
        const db = await conn.ready();
        const rows = await db.select<{ name: string }[]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
            [name]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    return {
        async clearDatabase(clearStats: () => Promise<void>): Promise<void> {
            const db = await conn.ready();
            for (const { src, backup } of CLEAR_BACKUP_TABLES) {
                await db.execute(`DROP TABLE IF EXISTS ${backup}`);
                await db.execute(`CREATE TABLE ${backup} AS SELECT * FROM ${src}`);
            }
            await db.execute("DELETE FROM clipboard");
            await db.execute("DELETE FROM note");
            await db.execute("DELETE FROM todo");
            // 统计数据一并清空（clearStats 钩子会同时丢弃内存累加器，避免清表后被写回）
            await clearStats();
            await db.execute(
                "DELETE FROM sqlite_sequence WHERE name IN ('clipboard', 'note', 'todo')"
            );
        },

        async undoClearDatabase(): Promise<boolean> {
            const db = await conn.ready();
            const restorable: { src: string; backup: string }[] = [];
            for (const entry of CLEAR_BACKUP_TABLES) {
                if (await tableExists(entry.backup)) restorable.push(entry);
            }
            if (restorable.length === 0) return false;
            for (const { src, backup } of restorable) {
                await db.execute(`DELETE FROM ${src}`);
                await db.execute(`INSERT INTO ${src} SELECT * FROM ${backup}`);
                await db.execute(`DROP TABLE ${backup}`);
            }
            return true;
        },

        async finalizeClear(): Promise<void> {
            const db = await conn.ready();
            // 撤回窗口已过：清理被清空图片条目的原图文件。clearDatabase 阶段不删文件——
            // 5s 撤回窗口内 undoClearDatabase 恢复行后引用必须仍有效。只删当前 clipboard 表
            // 未再引用的文件（清空后用户可能重新复制了同一张图：新条目与备份引用同一文件）
            try {
                const orphans = await db.select(
                    "SELECT content FROM clear_backup_clipboard WHERE type = 'image' AND content LIKE 'imgfile:%' " +
                    "AND content NOT IN (SELECT content FROM clipboard)"
                ) as { content: string }[];
                for (const row of orphans) deleteImageFileByRef(row.content);
            } catch { /* 备份表可能不存在（异常路径/重复调用），跳过文件清理 */ }
            for (const { backup } of CLEAR_BACKUP_TABLES) {
                await db.execute(`DROP TABLE IF EXISTS ${backup}`);
            }
        },
    };
}
