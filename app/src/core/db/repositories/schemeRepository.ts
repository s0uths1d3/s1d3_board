import type { DatabaseConnection } from '../connection';
import type { ClipScheme } from '../../../entities';

/**
 * 智能剪贴板领域仓储：方案（clip_templates）+ 用户习惯（clip_habits）+ AI 结果缓存（clip_ai_cache）。
 * 注：原「分词规则」clip_rules 已废弃——用户侧只维护提取器（单个提取单元）与方案（多提取器集成），
 * 拆分能力由提取器的正则/分隔符承担，表与旧数据保留但不再读写。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface SchemeRepository {
    /** 全量方案：按更新时间倒序（旧数据 name 兜底 title，见实现注释） */
    fetchClipSchemes(): Promise<ClipScheme[]>;
    /** UPSERT 单条方案（name 列同步写 title，兼容旧二进制/旧查询） */
    saveClipScheme(scheme: ClipScheme): Promise<void>;
    deleteClipScheme(id: string): Promise<void>;
    /** 记录一次强信号用户动作（paste / pin），顺带裁剪只保留最近 500 条 */
    insertClipHabit(h: { contentHash: string; extractorId: string; action: 'paste' | 'pin'; segmentText: string }): Promise<void>;
    /** 偏好摘要：最近 100 次 paste 中，各提取器产出被粘贴的次数（降序 Top5） */
    fetchHabitDigest(): Promise<Array<{ extractorId: string; count: number }>>;
    /** 读取 AI 结果缓存：窗口期内命中返回输出，过期/不存在返回 null（windowSec = 0 表示每次重新生成） */
    getAiCache(key: string, windowSec: number): Promise<string | null>;
    /** 写入/刷新 AI 结果缓存 */
    setAiCache(key: string, output: string): Promise<void>;
}

/** 方案成员（提取器 id 列表）JSON 列 → 字符串数组；脏数据返回空数组（= 自动接入全部提取器） */
function parseMembers(raw?: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export function createSchemeRepository({ conn }: { conn: DatabaseConnection }): SchemeRepository {
    return {
        /**
         * 全量方案：按更新时间倒序。
         * 表沿用 clip_templates（表重命名需迁移），title/description/members 由 ensureFeatureColumns 补齐；
         * 旧数据（只有 name）以 name 兜底 title，members 空串/脏数据视为空数组（= 自动接入全部提取器）。
         */
        async fetchClipSchemes(): Promise<ClipScheme[]> {
            const db = await conn.ready();
            const rows = await db.select(
                'SELECT * FROM clip_templates ORDER BY updated_at DESC',
            ) as (ClipScheme & { name?: string; members?: string | null })[];
            return rows.map((r) => ({
                id: r.id,
                title: r.title || r.name || '',
                description: r.description ?? '',
                members: parseMembers(r.members),
                body: r.body ?? '',
                enabled: r.enabled,
                created_at: r.created_at,
                updated_at: r.updated_at,
            }));
        },

        async saveClipScheme(scheme: ClipScheme): Promise<void> {
            const db = await conn.ready();
            await db.execute(
                `INSERT INTO clip_templates (id, name, title, description, members, body, enabled, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   title = excluded.title,
                   description = excluded.description,
                   members = excluded.members,
                   body = excluded.body,
                   enabled = excluded.enabled,
                   updated_at = CURRENT_TIMESTAMP`,
                [
                    scheme.id,
                    scheme.title,
                    scheme.title,
                    scheme.description ?? '',
                    JSON.stringify(scheme.members ?? []),
                    scheme.body ?? '',
                    scheme.enabled,
                ],
            );
        },

        async deleteClipScheme(id: string): Promise<void> {
            const db = await conn.ready();
            await db.execute('DELETE FROM clip_templates WHERE id = $1', [id]);
        },

        /**
         * 记录一次强信号用户动作（paste / pin）。
         * 只记强信号：箭头切换等中间态是噪声，落库反而稀释偏好统计。
         * 每次插入顺带裁剪，只保留最近 500 条。
         */
        async insertClipHabit(h: {
            contentHash: string;
            extractorId: string;
            action: 'paste' | 'pin';
            segmentText: string;
        }): Promise<void> {
            const db = await conn.ready();
            await db.execute(
                'INSERT INTO clip_habits (content_hash, extractor_id, action, segment_text, created_at) VALUES ($1, $2, $3, $4, $5)',
                [h.contentHash, h.extractorId, h.action, h.segmentText, Date.now()],
            );
            await db.execute(
                'DELETE FROM clip_habits WHERE id NOT IN (SELECT id FROM clip_habits ORDER BY id DESC LIMIT 500)',
            );
        },

        async fetchHabitDigest(): Promise<Array<{ extractorId: string; count: number }>> {
            const db = await conn.ready();
            const rows = await db.select(
                "SELECT extractor_id, COUNT(*) AS count FROM clip_habits WHERE action = 'paste' " +
                'GROUP BY extractor_id ORDER BY count DESC LIMIT 5',
            ) as Array<{ extractor_id: string; count: number }>;
            return rows.map((r) => ({ extractorId: r.extractor_id, count: Number(r.count) }));
        },

        async getAiCache(key: string, windowSec: number): Promise<string | null> {
            const db = await conn.ready();
            if (windowSec <= 0) return null;
            const rows = await db.select(
                'SELECT output, created_at FROM clip_ai_cache WHERE key = $1',
                [key],
            ) as Array<{ output: string; created_at: number }>;
            if (rows.length === 0) return null;
            if (Date.now() - Number(rows[0]!.created_at) > windowSec * 1000) return null;
            return rows[0]!.output;
        },

        async setAiCache(key: string, output: string): Promise<void> {
            const db = await conn.ready();
            await db.execute(
                'INSERT INTO clip_ai_cache (key, output, created_at) VALUES ($1, $2, $3) ' +
                'ON CONFLICT(key) DO UPDATE SET output = $2, created_at = $3',
                [key, output, Date.now()],
            );
        },
    };
}
