import type { DatabaseConnection } from '../connection';

/**
 * 设置领域仓储（settings KV + shortcut_binding 快捷键绑定）。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface SettingsRepository {
    setKeyValue(key: string, value: string): Promise<void>;
    getKeyValue(key: string): Promise<string>;
    saveShortcutSetting(id: string, value: string, scope: string, title: string): Promise<void>;
    loadShortcutSettings(): Promise<{ id: string; value: string }[]>;
}

export function createSettingsRepository({ conn }: { conn: DatabaseConnection }): SettingsRepository {
    return {
        async setKeyValue(key: string, value: string): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            // UPSERT：首次设置的 key（表中尚无对应行）也能持久化，避免仅 UPDATE 导致新 key 无法写入
            await db.execute(
                "INSERT INTO settings (key, value, type, updated_at) VALUES ($1, $2, 'other', $3) " +
                "ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = $3",
                [key, value, now]
            );
        },

        async getKeyValue(key: string): Promise<string> {
            const db = await conn.ready();
            const result: any[] = await db.select("SELECT value FROM settings WHERE key = $1", [key]);
            return result.length > 0 ? result[0].value : '';
        },

        /**
         * 保存单个快捷键到 shortcut_binding 规范化表（按 shortcut_id upsert）
         */
        async saveShortcutSetting(id: string, value: string, scope: string, title: string): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            const existing: any[] = await db.select(
                "SELECT id FROM shortcut_binding WHERE shortcut_id = $1",
                [id]
            );
            if (existing.length > 0) {
                await db.execute(
                    "UPDATE shortcut_binding SET key = $1, scope = $2, description = $3, updated_at = $4 WHERE shortcut_id = $5",
                    [value, scope, title, now, id]
                );
            } else {
                await db.execute(
                    "INSERT INTO shortcut_binding (shortcut_id, key, scope, description, updated_at) VALUES ($1, $2, $3, $4, $5)",
                    [id, value, scope, title, now]
                );
            }
        },

        /** 加载已保存的快捷键配置（返回 { id, value }[]） */
        async loadShortcutSettings(): Promise<{ id: string; value: string }[]> {
            const db = await conn.ready();
            const rows: any[] = await db.select(
                "SELECT shortcut_id, key FROM shortcut_binding WHERE key IS NOT NULL AND key != ''"
            );
            return rows
                .filter(r => typeof r.shortcut_id === 'string')
                .map(r => ({ id: r.shortcut_id, value: r.key }));
        },
    };
}
