import type { DatabaseConnection } from '../connection';

/**
 * 灵动岛历史领域仓储（island_history 表）：全部弹岛来源汇聚写入，FIFO 保留最近 500 条。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface IslandHistoryRepository {
    insertIslandHistory(h: { kind: string; text: string }): Promise<void>;
    getIslandHistory(limit?: number, filter?: { kind?: string; from?: number; to?: number }): Promise<Array<{ id: number; kind: string; text: string; createdAt: number }>>;
    clearIslandHistory(): Promise<void>;
}

export function createIslandHistoryRepository({ conn }: { conn: DatabaseConnection }): IslandHistoryRepository {
    return {
        async insertIslandHistory(h: { kind: string; text: string }): Promise<void> {
            await conn.executeWithRetry(
                'INSERT INTO island_history (kind, text, created_at) VALUES ($1, $2, $3)',
                [h.kind, h.text, Date.now()],
            );
            await conn.executeWithRetry(
                'DELETE FROM island_history WHERE id NOT IN (SELECT id FROM island_history ORDER BY id DESC LIMIT 500)',
                [],
            );
        },

        /**
         * 灵动岛历史查询（GET /api/history 的数据源）：按时间倒序（最新在前）。
         * 过滤在 SQL 侧执行（先 WHERE 后 LIMIT）：kind 精确匹配；from/to 为毫秒时间戳
         * 区间（含头不含尾，可单侧使用）；limit 为过滤后的返回上限。
         */
        async getIslandHistory(
            limit = 500,
            filter?: { kind?: string; from?: number; to?: number },
        ): Promise<Array<{ id: number; kind: string; text: string; createdAt: number }>> {
            const db = await conn.ready();
            const where: string[] = [];
            const params: unknown[] = [];
            if (filter?.kind) {
                where.push(`kind = $${params.length + 1}`);
                params.push(filter.kind);
            }
            if (typeof filter?.from === 'number') {
                where.push(`created_at >= $${params.length + 1}`);
                params.push(filter.from);
            }
            if (typeof filter?.to === 'number') {
                where.push(`created_at < $${params.length + 1}`);
                params.push(filter.to);
            }
            const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
            params.push(limit);
            const rows = await db.select(
                `SELECT id, kind, text, created_at FROM island_history${clause} ORDER BY id DESC LIMIT $${params.length}`,
                params,
            ) as Array<{ id: number; kind: string; text: string; created_at: number }>;
            return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: r.created_at }));
        },

        /** 清空灵动岛历史 */
        async clearIslandHistory(): Promise<void> {
            const db = await conn.ready();
            await db.execute('DELETE FROM island_history');
        },
    };
}
