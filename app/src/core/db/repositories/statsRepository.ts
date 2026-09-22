import type { DatabaseConnection } from '../connection';

/**
 * 统计领域仓储（daily_stat / app_usage / app_icons 底层读写）。
 * 只承载 SQL（statsService 委托调用）：内存累加、节流落库、pending 合并等
 * 服务逻辑保留在 statsService。自 dbService/statsService 原样平移，SQL 逐字保留。
 */
export interface StatsRepository {
    /** 单日统计 UPSERT（cols/vals 由服务层 pending 累加器展开，冲突按列累加） */
    upsertDailyStat(date: string, cols: string[], vals: number[]): Promise<void>;
    /** app_usage 单行 UPSERT（按天×应用，冲突累加两个时长列） */
    upsertAppUsage(date: string, app: string, total: number, active: number): Promise<void>;
    /** 应用图标持久化（Rust 采样提取的 PNG data URL，INSERT 覆盖写） */
    upsertAppIcon(app: string, icon: string): Promise<void>;
    /** 清空统计三表（daily_stat/app_usage/app_icons，调用方需先丢弃内存累加器） */
    clearStatsTables(): Promise<void>;
    /** 单日聚合原始行（fields 已由服务层按查询裁剪传入） */
    fetchDaily(date: string, fields: string[]): Promise<any[]>;
    /** 区间聚合原始行 */
    fetchStatsRange(from: string, to: string, fields: string[]): Promise<any[]>;
    /** 趋势明细原始行（downsample = 区间超过阈值按月聚合，见 §14.4） */
    fetchDailySeries(from: string, to: string, fields: string[], downsample: boolean): Promise<any[]>;
    /** 区间内按应用聚合的使用时长（总时长降序；含图标） */
    fetchAppUsageRange(from: string, to: string): Promise<{ app_name: string; total: number; active: number; icon: string | null }[]>;
    /** 最常复制的文本项原始行（趣味数据"复制之王"） */
    fetchTopClipboardRow(): Promise<any[]>;
    /** 区间内活跃天数（有统计记录的天数） */
    fetchActiveDaysRow(from: string, to: string): Promise<any[]>;
    /** 最早一条统计日期原始行 */
    fetchEarliestDateRow(): Promise<any[]>;
    /** 统计表是否已有任何数据 */
    fetchCountRow(): Promise<any[]>;
}

export function createStatsRepository({ conn }: { conn: DatabaseConnection }): StatsRepository {
    return {
        async upsertDailyStat(date: string, cols: string[], vals: number[]): Promise<void> {
            const db = await conn.ready();
            const setClause = cols.map(k => `${k} = ${k} + excluded.${k}`).join(', ');
            await db.execute(
                `INSERT INTO daily_stat (stat_date, ${cols.join(', ')})
                 VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(', ')})
                 ON CONFLICT(stat_date) DO UPDATE SET ${setClause}`,
                [date, ...vals]
            );
        },

        async upsertAppUsage(date: string, app: string, total: number, active: number): Promise<void> {
            const db = await conn.ready();
            await db.execute(
                `INSERT INTO app_usage (stat_date, app_name, usage_seconds, active_seconds)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT(stat_date, app_name) DO UPDATE SET
                   usage_seconds = usage_seconds + excluded.usage_seconds,
                   active_seconds = active_seconds + excluded.active_seconds`,
                [date, app, total, active],
            );
        },

        async upsertAppIcon(app: string, icon: string): Promise<void> {
            const db = await conn.ready();
            await db.execute(
                `INSERT INTO app_icons (app_name, icon) VALUES ($1, $2)
                 ON CONFLICT(app_name) DO UPDATE SET icon = excluded.icon`,
                [app, icon],
            );
        },

        async clearStatsTables(): Promise<void> {
            const db = await conn.ready();
            await db.execute("DELETE FROM daily_stat");
            await db.execute("DELETE FROM app_usage");
            await db.execute("DELETE FROM app_icons");
        },

        async fetchDaily(date: string, fields: string[]): Promise<any[]> {
            const db = await conn.ready();
            const selectFields = fields.map(f => `COALESCE(${f}, 0) AS ${f}`).join(', ');
            return await db.select(
                `SELECT ${selectFields} FROM daily_stat WHERE stat_date = $1`,
                [date]
            );
        },

        async fetchStatsRange(from: string, to: string, fields: string[]): Promise<any[]> {
            const db = await conn.ready();
            const sumCols = fields.map(f => `COALESCE(SUM(${f}), 0) AS ${f}`).join(', ');
            return await db.select(
                `SELECT ${sumCols} FROM daily_stat WHERE stat_date BETWEEN $1 AND $2`,
                [from, to]
            );
        },

        async fetchDailySeries(from: string, to: string, fields: string[], downsample: boolean): Promise<any[]> {
            const db = await conn.ready();
            const sumExpr = fields.map(f => `COALESCE(${f}, 0)`).join(' + ');
            if (downsample) {
                // §14.4 按月降采样：服务端 strftime GROUP BY，不把上千行灌入前端
                return await db.select(
                    `SELECT strftime('%Y-%m', stat_date) AS stat_date, ${sumExpr} AS value
                     FROM daily_stat WHERE stat_date BETWEEN $1 AND $2
                     GROUP BY strftime('%Y-%m', stat_date) ORDER BY stat_date`,
                    [from, to]
                );
            }
            return await db.select(
                `SELECT stat_date, ${sumExpr} AS value FROM daily_stat WHERE stat_date BETWEEN $1 AND $2 ORDER BY stat_date`,
                [from, to]
            );
        },

        async fetchAppUsageRange(from: string, to: string): Promise<{ app_name: string; total: number; active: number; icon: string | null }[]> {
            const db = await conn.ready();
            return await db.select<{
                app_name: string; total: number; active: number; icon: string | null;
            }[]>(
                `SELECT u.app_name AS app_name,
                        SUM(u.usage_seconds) AS total,
                        SUM(u.active_seconds) AS active,
                        i.icon AS icon
                 FROM app_usage u
                 LEFT JOIN app_icons i ON i.app_name = u.app_name
                 WHERE u.stat_date BETWEEN $1 AND $2
                 GROUP BY u.app_name, i.icon
                 ORDER BY SUM(u.usage_seconds) DESC`,
                [from, to],
            );
        },

        async fetchTopClipboardRow(): Promise<any[]> {
            const db = await conn.ready();
            return await db.select(
                `SELECT content, count FROM clipboard WHERE type = 'text' ORDER BY count DESC LIMIT 1`
            );
        },

        async fetchActiveDaysRow(from: string, to: string): Promise<any[]> {
            const db = await conn.ready();
            return await db.select(
                `SELECT COUNT(DISTINCT stat_date) AS days FROM daily_stat WHERE stat_date BETWEEN $1 AND $2`,
                [from, to]
            );
        },

        async fetchEarliestDateRow(): Promise<any[]> {
            const db = await conn.ready();
            return await db.select(`SELECT MIN(stat_date) AS d FROM daily_stat`);
        },

        async fetchCountRow(): Promise<any[]> {
            const db = await conn.ready();
            return await db.select(`SELECT COUNT(*) AS cnt FROM daily_stat`);
        },
    };
}
