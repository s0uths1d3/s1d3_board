import type { DatabaseConnection } from '../connection';
import type { PinnedClip } from '../../../entities';
import { withPage, type PageQuery } from '../sql';

/**
 * 常用剪贴领域仓储（pinned_clip）。
 * 自 dbService 原样平移，SQL 逐字保留。
 */
export interface PinnedClipRepository {
    /** 获取常用剪贴列表（不限量，可无限存储；传 page 时按流式分页返回）。
     *  排序：置顶项优先（按置顶时间倒序），其余按时间倒序（最新在前）。 */
    fetchPinnedClips(page?: PageQuery): Promise<PinnedClip[]>;
    /** 获取单个常用剪贴项 */
    fetchPinnedClip(id: number): Promise<PinnedClip | undefined>;
    /** 新增常用剪贴项（最新一条排最前）。常用剪贴不限量存储：不会自动裁剪旧数据。 */
    insertPinnedClip(content: string, type: 'text' | 'image', name?: string, source?: string): Promise<void>;
    /** 判断常用剪贴中是否已存在相同内容（按 content + type 去重）。用于 Ctrl+U「添加为常用」时避免重复添加。 */
    isPinnedContentExist(content: string, type: 'text' | 'image'): Promise<boolean>;
    /**
     * 更新常用剪贴项（文本可改内容；图片替换传新 base64；name 可编辑）。
     * tags：条目标签数组（JSON 字符串落 tags 列，null/undefined 清空或不变——
     * 见实现：tags 传 undefined 保持原值，null 或数组则覆盖）。
     */
    updatePinnedClip(id: number, content: string, name: string, type: 'text' | 'image',
        tags?: string[] | null): Promise<void>;
    /** 置顶/取消置顶常用剪贴项（置顶后排序优先；pinned=false 取消置顶） */
    pinPinnedClip(id: number, pinned: boolean): Promise<void>;
    /** 删除单条常用剪贴项（仅从常用剪贴移除，不影响剪贴板主列表原条目） */
    deletePinnedClip(id: number): Promise<void>;
}

export function createPinnedClipRepository({ conn }: { conn: DatabaseConnection }): PinnedClipRepository {
    return {
        async fetchPinnedClips(page?: PageQuery): Promise<PinnedClip[]> {
            const db = await conn.ready();
            const baseSql =
                "SELECT * FROM pinned_clip ORDER BY " +
                "CASE WHEN pinned_at IS NOT NULL AND pinned_at != '' THEN 1 ELSE 0 END DESC, " +
                "pinned_at DESC, created_at DESC, id DESC";
            if (page) {
                const { sql, params } = withPage(page, []);
                return await db.select(baseSql + sql, params) as PinnedClip[];
            }
            return await db.select(baseSql) as PinnedClip[];
        },

        async fetchPinnedClip(id: number): Promise<PinnedClip | undefined> {
            const db = await conn.ready();
            const rows = await db.select("SELECT * FROM pinned_clip WHERE id = $1", [id]) as PinnedClip[];
            return rows[0];
        },

        async insertPinnedClip(content: string, type: 'text' | 'image', name?: string, source?: string): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            await db.execute(
                "INSERT INTO pinned_clip (content, type, name, source, sort_order, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
                [content, type, name || '', source || '', 0, now, now]
            );
        },

        async isPinnedContentExist(content: string, type: 'text' | 'image'): Promise<boolean> {
            const db = await conn.ready();
            const rows = await db.select(
                "SELECT id FROM pinned_clip WHERE content = $1 AND type = $2 LIMIT 1",
                [content, type]
            ) as { id: number }[];
            return rows.length > 0;
        },

        /**
         * 更新常用剪贴项（文本可改内容；图片替换传新 base64；name 可编辑）。
         * tags 可选字段：undefined = 不变（兼容既有调用方），null/'' = 清空，
         * 有值 = 覆盖（tags 数组序列化为 JSON 字符串落 tags 列）。
         */
        async updatePinnedClip(id: number, content: string, name: string, type: 'text' | 'image',
            tags?: string[] | null): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            const sets = ["content = $2", "name = $3", "type = $4", "updated_at = $5"];
            const params: any[] = [id, content, name, type, now];
            let idx = 5;
            if (tags !== undefined) {
                idx += 1;
                sets.push(`tags = $${idx}`);
                params.push(tags === null ? '' : JSON.stringify(tags));
            }
            await db.execute(`UPDATE pinned_clip SET ${sets.join(', ')} WHERE id = $1`, params);
        },

        async pinPinnedClip(id: number, pinned: boolean): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            await db.execute(
                "UPDATE pinned_clip SET pinned_at = $2, updated_at = $3 WHERE id = $1",
                [id, pinned ? now : '', now]
            );
        },

        async deletePinnedClip(id: number): Promise<void> {
            const db = await conn.ready();
            await db.execute("DELETE FROM pinned_clip WHERE id = $1", [id]);
        },
    };
}
