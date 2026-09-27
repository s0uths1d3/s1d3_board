import { invoke } from "@tauri-apps/api/core";
import type { DatabaseConnection } from '../connection';
import { resolveImageContent } from '../imageRef';

/**
 * 数据备份领域仓储（导出/导入 JSON）：剪贴历史是核心资产，换机不丢数据。
 * 与 backupRepository（清空撤回的 clear_backup_* 机制）无关。
 *
 * 设计取舍：
 * - 导出表集 = 剪贴板 / 便签 / 待办 / 常用剪贴 / 逐日统计 / 应用时长（6 张数据表）；
 *   配置类（settings KV、快捷键绑定、常用剪贴方案）与可再生数据（island_history、
 *   app_icons）不参与备份——前者可能含 API key 等敏感配置，后者可重新生成；
 * - 导出包自包含：图片条目的 imgfile: 文件引用解析为原图 dataUrl 写进 JSON，
 *   换机无需携带图片目录；导入端先按 dataUrl 重建落盘文件（sha256 内容寻址，
 *   同内容得到与导出前一致的 imgfile: 文件名）再写行，落盘失败保留 dataUrl
 *   （展示端按旧 base64 语义回退，不丢数据）；
 * - 导入为替换式恢复：先清空 6 张表再整批写入（快照语义，避免新旧混杂）。
 */

export const DATA_BUNDLE_VERSION = 1;

/** 导出数据包（JSON 序列化后即备份文件内容） */
export interface DataBundle {
    version: number;
    exported_at: string;
    tables: {
        clipboard: Row[];
        note: Row[];
        todo: Row[];
        pinned_clip: Row[];
        daily_stat: Row[];
        app_usage: Row[];
    };
}

type Row = Record<string, unknown>;

const EXPORT_TABLES = ['clipboard', 'note', 'todo', 'pinned_clip', 'daily_stat', 'app_usage'] as const;

/** 图片内容参与的表（导入时 dataUrl → 落盘重建 imgfile: 引用） */
const IMAGE_TABLES = ['clipboard', 'pinned_clip'] as const;

export interface DataTransferRepository {
    /** 导出全部数据表（图片条目解析为原图 dataUrl，自包含） */
    exportData(): Promise<DataBundle>;
    /** 替换式导入：重建图片文件 → 清空 6 表 → 整批写入 */
    importData(bundle: DataBundle): Promise<void>;
}

export function createDataTransferRepository({ conn }: { conn: DatabaseConnection }): DataTransferRepository {
    /** 表内整批写入：按行自有列集构造 INSERT（容纳 schema 演进的新列） */
    async function insertRows(table: string, rows: Row[]): Promise<void> {
        for (const row of rows) {
            const cols = Object.keys(row).filter(k => row[k] !== undefined);
            if (cols.length === 0) continue;
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            await conn.executeWithRetry(
                `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
                cols.map(c => row[c]),
            );
        }
    }

    return {
        async exportData(): Promise<DataBundle> {
            const db = await conn.ready();
            const tables = {} as DataBundle['tables'];
            for (const name of EXPORT_TABLES) {
                const rows = await db.select(`SELECT * FROM ${name}`) as Row[];
                // 图片条目：imgfile: 引用解析为原图 dataUrl（失败保留原引用，导入端兜底）
                if (IMAGE_TABLES.includes(name as typeof IMAGE_TABLES[number])) {
                    for (const row of rows) {
                        if (typeof row.content === 'string' && row.content.startsWith('imgfile:')) {
                            row.content = await resolveImageContent(row.content).catch(() => row.content);
                        }
                    }
                }
                tables[name] = rows;
            }
            return { version: DATA_BUNDLE_VERSION, exported_at: new Date().toISOString(), tables };
        },

        async importData(bundle: DataBundle): Promise<void> {
            if (!bundle || typeof bundle !== 'object' || typeof bundle.tables !== 'object' || bundle.tables === null) {
                throw new Error('invalid data bundle');
            }
            const db = await conn.ready();
            // 图片先行落盘：dataUrl → imgfile: 引用（sha256 内容寻址，同内容得到原文件名）
            for (const name of IMAGE_TABLES) {
                for (const row of (bundle.tables[name] ?? []) as Row[]) {
                    if (typeof row.content === 'string' && row.content.startsWith('data:image/')) {
                        try {
                            const ref = await invoke<string | null>('save_clipboard_image', { dataUrl: row.content });
                            if (ref) row.content = ref;
                        } catch { /* 落盘失败保留 dataUrl */ }
                    }
                }
            }
            // 替换式恢复：先清空再整批写入（与 clearDatabase 不同的是不动 sqlite_sequence——
            // 导入行自带原 id，后续自增以 max(id) 继续即可）
            await db.execute('DELETE FROM clipboard');
            await db.execute('DELETE FROM note');
            await db.execute('DELETE FROM todo');
            await db.execute('DELETE FROM pinned_clip');
            await db.execute('DELETE FROM daily_stat');
            await db.execute('DELETE FROM app_usage');
            for (const name of EXPORT_TABLES) {
                await insertRows(name, ((bundle.tables[name] ?? []) as Row[]));
            }
        },
    };
}
