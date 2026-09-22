import { invoke } from "@tauri-apps/api/core";
import type { DatabaseConnection } from '../connection';
import type { ClipboardData } from '../../../entities';
import { bus } from '../../events';
import { resolveImageRows, deleteImageFileByRef } from '../imageRef';
import { escapeLike, withPage, type PageQuery } from '../sql';
import type { RecordStats } from './noteRepository';

/** 剪贴板默认保留上限：设置项 max_save_count 未设置/无效时生效（防 DB 无限膨胀） */
const DEFAULT_MAX_SAVE_COUNT = 1000;

/**
 * 剪贴板领域仓储（clipboard 表）：写入 upsert / 查询 / 收藏 / 使用计数 / 删除 /
 * 按上限裁剪（trim）与二维码补识别（decodeQrText）。
 * 图片引用（imgfile:）解析与原图文件删除在 core/db/imageRef.ts。
 * 自 dbService 原样平移，SQL 与事件派发时序逐字保留。
 */
export interface ClipboardRepository {
    /**
     * 写入一条剪贴板记录（文本或图片；sourceApp = 复制瞬间的前台进程名，可空；
     * qrText = 图片条目的二维码识别结果，可空）。
     * - 图片条目 content 存 imgfile: 文件引用（原图落盘）；islandImageContent = 岛事件用的
     *   原图 data URL（island:copy 的消费方按原图语义处理：岛回退渲染/出站推送/历史缩略图，
     *   引用串对它们无意义）。首次派发与本次二次派发传同一 dataUrl，内容去重不重复弹岛；
     * - 使用 INSERT ... ON CONFLICT(content) 单语句 upsert：并发监听回调同时到达时
     *   不会撞 content UNIQUE 约束（此前的"先查后插"存在竞态，第二条会抛错丢事件）；
     * - 新插入时额外做统计埋点与按上限裁剪；
     * - source_app / qr_text 仅在新插入时写入：应用自身粘贴也会写剪贴板（触发本函数），
     *   冲突时若更新会把历史条目的原始来源/识别结果覆盖为本次写入。
     */
    saveClipboard(content: string, type: 'text' | 'image', sourceApp?: string | null, qrText?: string | null, islandImageContent?: string): Promise<void>;
    /** 标记"即将由本应用粘贴流程写剪贴板"：与 suppressIslandCopy 同源时序，写入前调用 */
    suppressUseCountBump(ms?: number): void;
    /** 存量图片条目的二维码补识别（见 dbService 门面同名方法的完整注释） */
    decodeQrText(id: number, content: string): Promise<string | null>;
    fetchClipboardData(filter: any, page?: PageQuery): Promise<ClipboardData[]>;
    fetchClipboardSingleData(id: number): Promise<ClipboardData | undefined>;
    updateFavorite(id: number, value: number): Promise<void>;
    increaseUseCount(id: number): Promise<void>;
    increaseUseCountByContent(content: string): Promise<void>;
    deleteClipboardData(id: number): Promise<void>;
}

export function createClipboardRepository({ conn, getKeyValue, recordStats }: {
    conn: DatabaseConnection;
    /** 读取设置 KV（裁剪上限 max_save_count / 全量查询动态上限）——注入设置仓储，避免反向依赖 */
    getKeyValue: (key: string) => Promise<string>;
    /** 统计埋点（fire-and-forget）——注入统计服务，仓储不直接依赖统计实现 */
    recordStats: RecordStats;
}): ClipboardRepository {
    /** 本应用粘贴写入抑制窗口：窗口内 saveClipboard 的 ON CONFLICT 不递增 count
     *  （粘贴流程已由命令层显式 increaseUseCount，剪贴板监听再 bump 会双计） */
    let useCountSuppressUntil = 0;

    /**
     * 按设置项「剪贴板最大存储数量」（max_save_count）裁剪剪贴板：
     * 超出上限时删除最旧记录。未设置或值无效时按默认上限（1000）裁剪，
     * 防止数据库无限膨胀。
     * 收藏项（is_favorite=1）豁免裁剪；常用剪贴（pinned_clip）为独立内容副本表，天然不受影响。
     * 图片条目删除时联动删除原图文件（imgfile: 引用）。
     */
    async function trimClipboard(): Promise<void> {
        try {
            const maxRaw = await getKeyValue('max_save_count');
            const parsed = parseInt(maxRaw ?? '', 10);
            // 未设置/空串/0/负数/非数字 → 默认上限（0 无「存 0 条」的实际意义，视为未配置）
            const max = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SAVE_COUNT;

            const db = await conn.ready();
            const rows: any[] = await db.select("SELECT COUNT(*) AS cnt FROM clipboard");
            const count = rows?.[0]?.cnt as number | undefined;
            if (count === undefined || count <= max) return;

            const excess = count - max;
            // 先取出将被淘汰的行（候选条件与删除完全一致），图片条目联动删原图文件；
            // 裁剪候选排除收藏项（is_favorite=1）：收藏是用户显式标记要留的内容，不被上限挤掉；
            // 收藏占比高时可能删完 excess 后仍超上限——下次插入时再继续淘汰，语义可接受
            const victims: { id: number; type: string; content: string }[] = await db.select(
                "SELECT id, type, content FROM clipboard WHERE is_favorite <> 1 ORDER BY updated_at ASC, id ASC LIMIT $1",
                [excess]
            );
            if (victims.length === 0) return;
            // 分批按 id 删除（SQL 参数上限约束；新插入的 updated_at 更大不会挤进候选集，集合稳定）
            const ids = victims.map((v) => v.id);
            for (let i = 0; i < ids.length; i += 500) {
                const chunk = ids.slice(i, i + 500);
                await conn.executeWithRetry(
                    `DELETE FROM clipboard WHERE id IN (${chunk.map((_, j) => `$${j + 1}`).join(',')})`,
                    chunk
                );
            }
            for (const v of victims) {
                if (v.type === 'image') deleteImageFileByRef(v.content);
            }
        } catch (e) {
            console.error('裁剪剪贴板失败:', e);
        }
    }

    return {
        suppressUseCountBump(ms = 1200): void {
            useCountSuppressUntil = Date.now() + ms;
        },

        async saveClipboard(content: string, type: 'text' | 'image', sourceApp?: string | null, qrText?: string | null, islandImageContent?: string): Promise<void> {
            const db = await conn.ready();
            const now = Math.floor(Date.now());
            // 先查一次用于区分"新插入 / 计数递增"（统计与裁剪只应发生在新插入时）；
            // 写入本身用 ON CONFLICT 单语句 upsert，即使并发事件在查询后插入也不会撞 UNIQUE 丢事件。
            const existingRecord: ClipboardData[] = await db.select(
                "SELECT id FROM clipboard WHERE content = $1",
                [content]
            );
            const isNew = existingRecord.length === 0;
            // 本应用粘贴流程的写入：命令层已显式计数，重复复制 bump 抑制为 +0，防双计
            const bump = Date.now() >= useCountSuppressUntil ? 1 : 0;

            const result = await conn.executeWithRetry<{ lastInsertId?: number | bigint }>(
                "INSERT INTO clipboard (content, category, type, created_at, updated_at, source_app, qr_text) VALUES ($1, $2, $3, $4, $5, $7, $8) " +
                "ON CONFLICT(content) DO UPDATE SET count = count + $6, updated_at = $5",
                [content, 'T', type, now, now, bump, sourceApp ?? null, qrText ?? null]
            );
            console.log(`Clipboard ${type} saved (upsert):`, result);
            // 灵动岛：复制行为反馈（文本/图片、重复复制同一内容同样提示；
            // 本应用粘贴流程的写入由 island 模块抑制，不会误报"已复制"）。
            // 图片传 islandImageContent（原图 data URL）而非 content（文件引用）：
            // 与监听回调的首次派发同串，lastShownCopy 按内容去重不重复弹岛
            bus.emit('island:copy', {
                content: type === 'image' && islandImageContent ? islandImageContent : content, type, qrText,
            });
            if (!isNew) return;

            // 统计埋点（fire-and-forget）：新插入文本/图片剪贴 +1；文本额外累加字符量（图片 base64 不计入"打字量"）
            if (type === 'text') {
                void recordStats({ clip_text: 1, clip_chars: content.length });
            } else {
                void recordStats({ clip_image: 1 });
            }
            // 新记录插入后按「剪贴板最大存储数量」裁剪最旧记录
            await trimClipboard();

            // 智能剪贴板：新文本入库 → 广播复制事件（处理层 smartClip 解析进内存 store；
            // 设计文档 §4.1 触发点）。仅文本参与解析管道。
            if (type === 'text') {
                const insertedId = Number(result.lastInsertId);
                bus.emit('smart-clip:copy', {
                    id: insertedId, content, ts: Date.now(),
                });
            }
        },

        /**
         * 存量图片条目的二维码补识别：复制时未扫出的老数据（qr_text IS NULL）在列表可见时
         * 惰性调用——Rust 侧从 data URL 解码（纯 Rust 全平台可用），结果写库。
         * 已扫无码写 ''（哨兵：自动路径防每次渲染重复扫描），已识别写文本。
         * 守卫：NULL（未扫描）与 ''（已扫无码）可写入（右键主动重试允许覆盖空哨兵重扫），已有识别结果不覆盖。
         * 返回写入值：'' = 已扫无码，二维码文本 = 识别成功，null = 命令/写库失败（库未变更，可重试）。
         */
        async decodeQrText(id: number, content: string): Promise<string | null> {
            // 与原实现一致：db 未初始化时 execute 抛错被 catch 归为 null（不主动触发连接加载）
            if (!conn.peek()) return null;
            try {
                const qrText = (await invoke<string | null>('clipboard_qr_from_data_url', { dataUrl: content })) ?? '';
                await conn.executeWithRetry(
                    "UPDATE clipboard SET qr_text = $1 WHERE id = $2 AND (qr_text IS NULL OR qr_text = '')",
                    [qrText, id]
                );
                return qrText;
            } catch {
                return null;
            }
        },

        async fetchClipboardData(filter: any, page?: PageQuery): Promise<ClipboardData[]> {
            const db = await conn.ready();

            const favorite: number = filter.value.favorite;
            const content: string = filter.value.searchContent;
            const type: string = filter.value.type ?? 'all';

            // 统一收集 WHERE 条件，按 $1/$2… 顺序编号参数
            const conds: string[] = [];
            const params: any[] = [];
            let paramIdx = 0;

            if (favorite === 1) {
                paramIdx += 1;
                conds.push(`is_favorite = $${paramIdx}`);
                params.push(favorite);
            }

            if (type === 'image') {
                // 仅图片：图片无文本内容，忽略搜索关键字
                conds.push("type = 'image'");
            } else if (type === 'text') {
                conds.push("type = 'text'");
            } else if (content) {
                // 默认（全部）：图片不参与文本搜索，仅在文本中匹配；
                // 搜索词转义 % _ \，保证按字面匹配
                paramIdx += 1;
                conds.push(`content LIKE $${paramIdx} ESCAPE '\\' AND type = 'text'`);
                params.push(`%${escapeLike(content)}%`);
            }

            const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : 'WHERE 1=1';

            // 全量查询的上限随「剪贴板最大存储数量」（max_save_count）动态调整；
            // 收藏列表仍保持 100 条上限；未设置时回退默认值。上限钳制到 1 万，
            // 防止极端配置一次性把全表（含图片 base64）拉进内存。
            // 传入 page 时为流式分页查询：以 page.limit 为准（收藏列表受 100 条上限约束），
            // 避免每次滚动把全表（含图片 base64）拉进内存。
            let limit = favorite === 1 ? 100 : 500;
            if (page) {
                limit = favorite === 1 ? Math.min(page.limit, 100 - page.offset) : page.limit;
                if (limit <= 0) return [];
            } else {
                const maxRaw = await getKeyValue('max_save_count');
                const parsed = parseInt(maxRaw ?? '', 10);
                if (parsed > 0) {
                    limit = favorite === 1 ? Math.min(parsed, 100) : Math.min(parsed, 10000);
                }
            }

            const baseSql = `SELECT * FROM clipboard ${whereSql} ORDER BY updated_at DESC, id DESC`;
            let rows: ClipboardData[];
            if (page) {
                const { sql, params: pageParams } = withPage(page, params);
                rows = await db.select(baseSql + sql, pageParams) as ClipboardData[];
            } else {
                rows = await db.select(baseSql + ` LIMIT ${limit}`, params) as ClipboardData[];
            }
            // 图片条目 content 为 imgfile: 文件引用：读取边界统一换回原图 data URL，
            // 列表/tooltip/查看器/粘贴等下游消费与旧 base64 时代完全一致
            return await resolveImageRows(rows);
        },

        async fetchClipboardSingleData(id: number): Promise<ClipboardData | undefined> {
            const db = await conn.ready();
            const data = await db.select("SELECT * FROM clipboard WHERE id = $1", [id]) as ClipboardData[]
            return (await resolveImageRows(data))[0]
        },

        async updateFavorite(id: number, value: number): Promise<void> {
            await conn.executeWithRetry("UPDATE clipboard SET is_favorite = $2 WHERE id = $1", [id, value]);
            // 统计埋点（fire-and-forget）：收藏/取消收藏切换 +1
            void recordStats({ favorite_toggle: 1 });
        },

        async increaseUseCount(id: number): Promise<void> {
            const now = Math.floor(Date.now());
            await conn.executeWithRetry("UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1", [id, now]);
            // 统计埋点（fire-and-forget）：粘贴使用 +1
            void recordStats({ clip_use: 1 });
        },

        /**
         * 全局 Ctrl+V 粘贴感知计数：按内容精确匹配剪贴板条目并复用 increaseUseCount
         * （count+1 + updated_at + clip_use 统计）。内容不在剪贴板历史中（应用未运行时复制、
         * 已被上限裁剪）时不计数；图片 base64 编码不稳定，调用方仅对文本调用。
         * 应用自身粘贴由 Rust PASTE_INJECTING 拦截不 emit，与此处无双计。
         */
        async increaseUseCountByContent(content: string): Promise<void> {
            const db = await conn.ready();
            const rows = await db.select("SELECT id FROM clipboard WHERE content = $1 LIMIT 1", [content]) as { id: number }[];
            if (rows.length === 0) return;
            await this.increaseUseCount(rows[0]!.id);
        },

        async deleteClipboardData(id: number): Promise<void> {
            const db = await conn.ready();
            // 删库前取出条目：图片条目联动删除原图文件（imgfile: 引用；旧 base64 条目自动跳过）
            const rows = await db.select(
                "SELECT type, content FROM clipboard WHERE id = $1", [id]
            ) as { type: string; content: string }[];
            await db.execute("DELETE FROM clipboard WHERE id = $1", [id]);
            if (rows[0]?.type === 'image') deleteImageFileByRef(rows[0].content);
        },
    };
}
