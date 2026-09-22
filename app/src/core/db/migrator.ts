import type { DatabaseConnection, SqlDatabase } from './connection';
import { invoke } from "@tauri-apps/api/core";
import { CLEAR_BACKUP_TABLES } from './repositories/backupRepository';

/**
 * 数据库迁移（core/db/migrator）：
 * 自 dbService.initDatabase / ensureFeatureColumns / migrateClipboardImagesToFiles
 * 原样平移（逻辑不重写），由 runDatabaseMigrations 以进程级 once 守卫驱动——
 * 连接就绪（PRAGMA/quick_check 由 connection.ts 负责）后执行：
 * 1. ensureFeatureColumns 兜底列迁移；2. 丢弃上次会话遗留的清空备份；3. 存量图片迁移（后台）。
 */

/**
 * 兜底列迁移（幂等）：部分环境下 Rust 侧 tauri-plugin-sql 迁移可能未执行
 * （如运行了旧可执行文件、迁移环节静默失败），导致新功能的列缺失、SQL 报错。
 * 此处在连接建立后按 PRAGMA 检查并补齐功能所需列；列已存在则跳过，
 * 与 Rust 侧 migration（同 DDL）互不冲突。
 */
async function ensureFeatureColumns(db: SqlDatabase) {
    // 兜底建表：app_usage / app_icons / clip_templates（方案）
    // ——防止旧二进制（无对应迁移）下前端查询/写入报 no such table
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS app_usage
            (
                stat_date      TEXT NOT NULL,
                app_name       TEXT NOT NULL,
                usage_seconds  INTEGER NOT NULL DEFAULT 0,
                active_seconds INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (stat_date, app_name)
            )
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS app_icons
            (
                app_name TEXT PRIMARY KEY,
                icon     TEXT NOT NULL
            )
        `);
        // 智能剪贴板：方案表（clip_templates，v17），与 Rust 侧 migration 同 DDL
        await db.execute(`
            CREATE TABLE IF NOT EXISTS clip_templates
            (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                body       TEXT NOT NULL,
                enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
        // 用户习惯记录（环形气泡选择/粘贴行为）与 AI 结果冷却缓存
        await db.execute(`
            CREATE TABLE IF NOT EXISTS clip_habits
            (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                content_hash  TEXT NOT NULL,
                extractor_id  TEXT NOT NULL DEFAULT '',
                action        TEXT NOT NULL,
                segment_text  TEXT NOT NULL DEFAULT '',
                created_at    INTEGER NOT NULL
            )
        `);
        await db.execute(`
            CREATE TABLE IF NOT EXISTS clip_ai_cache
            (
                key        TEXT PRIMARY KEY,
                output     TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        `);
        // 灵动岛历史消息（全部弹岛来源汇聚写入，FIFO 保留最近 500 条）
        await db.execute(`
            CREATE TABLE IF NOT EXISTS island_history
            (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kind       TEXT NOT NULL,
                text       TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL
            )
        `);
    } catch (e) {
        console.warn('[db] 兜底建表 app_usage/app_icons/clip_templates/clip_habits/clip_ai_cache 失败:', e);
    }
    const wanted = [
        { table: 'todo', column: 'remind_mode', ddl: 'ALTER TABLE todo ADD COLUMN remind_mode TEXT' },
        { table: 'todo', column: 'remind_at', ddl: 'ALTER TABLE todo ADD COLUMN remind_at TEXT' },
        { table: 'todo', column: 'priority_level', ddl: 'ALTER TABLE todo ADD COLUMN priority_level INTEGER' },
        { table: 'todo', column: 'remind_rules', ddl: 'ALTER TABLE todo ADD COLUMN remind_rules TEXT' },
        { table: 'daily_stat', column: 'todo_reminded', ddl: 'ALTER TABLE daily_stat ADD COLUMN todo_reminded INTEGER NOT NULL DEFAULT 0' },
        { table: 'daily_stat', column: 'todo_chars', ddl: 'ALTER TABLE daily_stat ADD COLUMN todo_chars INTEGER NOT NULL DEFAULT 0' },
        { table: 'daily_stat', column: 'tab_app_usage', ddl: 'ALTER TABLE daily_stat ADD COLUMN tab_app_usage INTEGER NOT NULL DEFAULT 0' },
        // 智能剪贴板统计：AI 分析成功次数 / 剪切（Ctrl+X）成功次数
        { table: 'daily_stat', column: 'ai_analysis', ddl: 'ALTER TABLE daily_stat ADD COLUMN ai_analysis INTEGER NOT NULL DEFAULT 0' },
        { table: 'daily_stat', column: 'clip_cut', ddl: 'ALTER TABLE daily_stat ADD COLUMN clip_cut INTEGER NOT NULL DEFAULT 0' },
        { table: 'app_usage', column: 'active_seconds', ddl: 'ALTER TABLE app_usage ADD COLUMN active_seconds INTEGER NOT NULL DEFAULT 0' },
        // 智能剪贴板「方案」（原模板）：独立标题/描述 + 成员提取器 id 列表（JSON）
        { table: 'clip_templates', column: 'title', ddl: 'ALTER TABLE clip_templates ADD COLUMN title TEXT' },
        { table: 'clip_templates', column: 'description', ddl: 'ALTER TABLE clip_templates ADD COLUMN description TEXT' },
        { table: 'clip_templates', column: 'members', ddl: 'ALTER TABLE clip_templates ADD COLUMN members TEXT' },
        // 剪贴条目来源应用（复制瞬间的前台进程名；存量数据为 NULL，UI 空值不显示）
        { table: 'clipboard', column: 'source_app', ddl: 'ALTER TABLE clipboard ADD COLUMN source_app TEXT' },
        // 剪贴图片二维码识别结果（复制时 Rust 侧解码；存量未扫描 NULL，已扫无码 ''）
        { table: 'clipboard', column: 'qr_text', ddl: 'ALTER TABLE clipboard ADD COLUMN qr_text TEXT' },
    ];
    let addedPriorityLevel = false;
    for (const { table, column, ddl } of wanted) {
        try {
            const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
            if (Array.isArray(cols) && !cols.some(c => c.name === column)) {
                await db.execute(ddl);
                console.info(`[db] 补齐列 ${table}.${column}`);
                // 记录"本次实际执行的补列"，供补列后的数据回填判断使用
                if (table === 'todo' && column === 'priority_level') {
                    addedPriorityLevel = true;
                }
            }
        } catch (e) {
            // 单列补齐失败（如表尚未创建）不影响其余列与其余功能
            console.warn(`[db] 检查/补齐列 ${table}.${column} 失败:`, e);
        }
    }
    if (addedPriorityLevel) {
        // 刚补建 priority_level 时回填存量数据：旧三档文本 → 0/127/255（WHERE 保证幂等）
        try {
            await db.execute(
                "UPDATE todo SET priority_level = CASE priority WHEN 'low' THEN 0 WHEN 'medium' THEN 127 WHEN 'high' THEN 255 ELSE 127 END WHERE priority_level IS NULL"
            );
            console.info('[db] 已回填 priority_level 存量数据');
        } catch (e) {
            console.warn('[db] 回填 priority_level 失败:', e);
        }
    }
}

/**
 * 存量图片迁移（fire-and-forget 后台任务）：旧版本把图片 base64 整包存 DB（库体积膨胀主因），
 * 分批调 Rust 落盘（sha256 去重 + 20MB 上限），content 就地替换为 imgfile: 引用。
 * - 目标引用已存在（同一图片新旧两条记录并存）：跳过保留原 base64 行，不删行不合并不动收藏标记；
 * - 超过单条上限 / 落盘失败 / 单条异常：保留原样，下次启动自动重试；
 * - 批间串行逐条处理，启动延迟 3s 避开首屏查询与岛窗口预建高峰。
 */
async function migrateClipboardImagesToFiles(db: SqlDatabase): Promise<void> {
    await new Promise((r) => setTimeout(r, 3000));
    try {
        const rows = await db.select(
            "SELECT id FROM clipboard WHERE type = 'image' AND content NOT LIKE 'imgfile:%'"
        ) as { id: number }[];
        const BATCH = 50;
        for (let i = 0; i < rows.length; i += BATCH) {
            const ids = rows.slice(i, i + BATCH).map((r) => r.id);
            if (ids.length === 0) break;
            const batch = await db.select(
                `SELECT id, content FROM clipboard WHERE id IN (${ids.map((_, j) => `$${j + 1}`).join(',')})`,
                ids
            ) as { id: number; content: string }[];
            for (const row of batch) {
                try {
                    const ref = await invoke<string | null>('save_clipboard_image', { dataUrl: row.content });
                    if (!ref) continue; // 超限/解码失败：保留原样，下次启动重试
                    // NOT EXISTS 守卫：目标引用已存在（同图重复条目）时不更新，避免撞 content UNIQUE
                    await db.execute(
                        "UPDATE clipboard SET content = $1 WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM clipboard WHERE content = $1)",
                        [ref, row.id]
                    );
                } catch { /* 单条失败不影响其余 */ }
            }
        }
    } catch (e) {
        console.warn('[db] 存量图片迁移失败（下次启动重试）:', e);
    }
}

// 进程级 once 守卫：迁移只跑一次；失败清空 in-flight，下次调用重试（与原 ensureDbInitialized
// 失败后整体重试 initDatabase 的语义一致）
let migrationsDone = false;
let migrationsInFlight: Promise<void> | undefined;

/**
 * 启动迁移入口：连接就绪后执行兜底列迁移 + 丢弃遗留清空备份 + 触发存量图片迁移。
 * 幂等（进程内仅一次）；并发调用共享同一次执行。
 */
export function runDatabaseMigrations(conn: DatabaseConnection): Promise<void> {
    if (migrationsDone) return Promise.resolve();
    migrationsInFlight ??= (async () => {
        const db = await conn.ready();
        await ensureFeatureColumns(db);
        // 上次会话遗留的清空备份：撤回窗口随进程结束已失效，直接丢弃（幂等）
        for (const { backup } of CLEAR_BACKUP_TABLES) {
            await db.execute(`DROP TABLE IF EXISTS ${backup}`).catch(() => {});
        }
        // 存量图片迁移（fire-and-forget 后台任务）：旧 base64 条目分批落盘换 imgfile: 引用，
        // 失败/超限保留原样下次重试，不阻塞启动
        void migrateClipboardImagesToFiles(db);
    })()
        .then(() => { migrationsDone = true; })
        .catch((e) => { migrationsInFlight = undefined; throw e; });
    return migrationsInFlight;
}
