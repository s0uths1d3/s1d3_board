import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { onTextUpdate, onSomethingUpdate, readImageBase64, startListening } from 'tauri-plugin-clipboard-api';
import type { ClipboardData,Note,Todo,ReminderRule,PinnedClip,ClipScheme } from "../entities";
import statsService from "~/src/statistics/statsService";

/** 优先级数值收敛：整数 0-255（越界/非法回退 127 中档） */
function clampPriorityLevel(level?: number): number {
    const n = Math.round(Number(level));
    if (!Number.isFinite(n)) return 127;
    return Math.min(255, Math.max(0, n));
}

/** 旧版三档文本列（legacy）随数值同步：低 <64 / 中 64-191 / 高 ≥192 */
function tierOf(level: number): 'low' | 'medium' | 'high' {
    return level >= 192 ? 'high' : level >= 64 ? 'medium' : 'low';
}

/** 提醒规则列表 → JSON 文本列（空列表存 ''） */
function stringifyRemindRules(rules?: ReminderRule[]): string {
    if (!rules || rules.length === 0) return '';
    try {
        return JSON.stringify(rules.filter(r => r && typeof r.id === 'string'));
    } catch {
        return '';
    }
}

/**
 * DB 行 → Todo 的提醒规则映射：
 * 先做列名归一——SELECT * 返回行键为 DB 列名（remind_mode/remind_at/priority_level，snake_case），
 * 与 Todo 类型字段（remindMode/remindAt/priorityLevel，camelCase）不一致，不归一则每次
 * 轮询/翻页刷新后 remindMode 恒为 undefined，界面回退显示「智能」、自定义闹钟设置被冲掉。
 * 再解析 remind_rules JSON（容错损坏数据）；旧数据无规则但有 remindAt（单一自定义时刻）
 * 时自动折算为一条 at 规则，保证老配置继续生效。
 */
function mapTodoRemindRules(row: Todo): Todo {
    const raw = row.remind_rules;
    // 行键可能来自 SELECT *（DB 列名，snake_case），经 unknown 中转读取兼容两种形态
    const rawRow = row as unknown as Record<string, unknown>;
    const remindMode = (rawRow.remind_mode ?? row.remindMode) as Todo['remindMode'];
    const remindAt = (rawRow.remind_at ?? row.remindAt) as string;
    const priorityLevel = (rawRow.priority_level ?? row.priorityLevel) as number | undefined;
    const rules: ReminderRule[] = [];
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const r of parsed as ReminderRule[]) {
                    if (!r || typeof r.id !== 'string') continue;
                    if (r.kind === 'percent' || r.kind === 'offset') {
                        const v = Math.round(Number(r.value));
                        if (Number.isFinite(v) && v > 0) rules.push({ id: r.id, kind: r.kind, value: v });
                    } else if (r.kind === 'at' && typeof r.value === 'string' && r.value) {
                        rules.push({ id: r.id, kind: 'at', value: r.value });
                    }
                }
            }
        } catch { /* JSON 损坏视为无规则 */ }
    }
    if (rules.length === 0 && remindMode === 'custom' && remindAt) {
        rules.push({ id: 'legacy', kind: 'at', value: remindAt });
    }
    return { ...row, remindMode, remindAt, priorityLevel, remindRules: rules };
}


/** LIKE 通配符转义：搜索词中的 % _ \ 按字面匹配（配合 ESCAPE '\'） */
function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
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

/**
 * 流式分页参数：offset 起始偏移，limit 页大小。
 * 传入后查询追加 `LIMIT limit OFFSET offset`；不传则保持原有全量行为。
 */
export interface PageQuery {
    offset: number;
    limit: number;
}

/** 追加 LIMIT/OFFSET 到查询尾部（$1/$2 参数化，配合 params 数组） */
function withPage(page: PageQuery | undefined, params: unknown[]): { sql: string; params: unknown[] } {
    if (!page) return { sql: '', params };
    return { sql: ' LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2), params: [...params, page.limit, page.offset] };
}

/**
 * 清空撤回机制的备份表映射：清空前各业务/统计表整表复制到 clear_backup_*，
 * 5 秒撤回窗口内可整表恢复，窗口结束或应用重启后丢弃。
 */
const CLEAR_BACKUP_TABLES = [
    { src: 'clipboard', backup: 'clear_backup_clipboard' },
    { src: 'note', backup: 'clear_backup_note' },
    { src: 'todo', backup: 'clear_backup_todo' },
    { src: 'daily_stat', backup: 'clear_backup_daily_stat' },
    { src: 'app_usage', backup: 'clear_backup_app_usage' },
] as const;

class DatabaseService {
    private static instance: DatabaseService;
    private db: Database | undefined;

    private constructor() {}

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    private async initDatabase() {
        const dbName = 'sqlite:s1d3_board.db';
        this.db = await Database.load(dbName);
        // WAL 日志模式：持久写入 DB 文件头（一次设置，所有连接/窗口生效）。
        // 读写不再互斥，显著缩短写锁等待——修复收藏/粘贴等高频写操作报
        // "database is locked"(517) 与并发冲突。
        await this.db.select('PRAGMA journal_mode=WAL').catch(() => {});
        // 完整性自检（quick_check，轻量）：文件损坏（malformed, 267）无法由代码凭空修复，
        // 启动时显式暴露，日志给出恢复指引，避免后续随机报错难以定位。
        void this.db.select<{ quick_check: string }[]>('PRAGMA quick_check')
            .then((rows) => {
                const result = rows[0]?.quick_check ?? 'ok';
                if (result !== 'ok') {
                    console.error(`[db] 数据库完整性检查失败: ${result}。文件已损坏，请关闭应用后备份 %APPDATA%/S1d3Board/s1d3_board.db，并用 sqlite3 ".recover" 或 DB Browser for SQLite 导出重建。`);
                }
            })
            .catch(() => {});
        await this.ensureFeatureColumns();
        // 上次会话遗留的清空备份：撤回窗口随进程结束已失效，直接丢弃（幂等）
        for (const { backup } of CLEAR_BACKUP_TABLES) {
            await this.db!.execute(`DROP TABLE IF EXISTS ${backup}`).catch(() => {});
        }
    }

    /**
     * 兜底列迁移（幂等）：部分环境下 Rust 侧 tauri-plugin-sql 迁移可能未执行
     * （如运行了旧可执行文件、迁移环节静默失败），导致新功能的列缺失、SQL 报错。
     * 此处在连接建立后按 PRAGMA 检查并补齐功能所需列；列已存在则跳过，
     * 与 Rust 侧 migration（同 DDL）互不冲突。
     */
    private async ensureFeatureColumns() {
        // 兜底建表：app_usage / app_icons / clip_templates（方案）
        // ——防止旧二进制（无对应迁移）下前端查询/写入报 no such table
        try {
            await this.db!.execute(`
                CREATE TABLE IF NOT EXISTS app_usage
                (
                    stat_date      TEXT NOT NULL,
                    app_name       TEXT NOT NULL,
                    usage_seconds  INTEGER NOT NULL DEFAULT 0,
                    active_seconds INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (stat_date, app_name)
                )
            `);
            await this.db!.execute(`
                CREATE TABLE IF NOT EXISTS app_icons
                (
                    app_name TEXT PRIMARY KEY,
                    icon     TEXT NOT NULL
                )
            `);
            // 智能剪贴板：方案表（clip_templates，v17），与 Rust 侧 migration 同 DDL
            await this.db!.execute(`
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
            await this.db!.execute(`
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
            await this.db!.execute(`
                CREATE TABLE IF NOT EXISTS clip_ai_cache
                (
                    key        TEXT PRIMARY KEY,
                    output     TEXT NOT NULL,
                    created_at INTEGER NOT NULL
                )
            `);
            // 灵动岛历史消息（全部弹岛来源汇聚写入，FIFO 保留最近 500 条）
            await this.db!.execute(`
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
        ];
        let addedPriorityLevel = false;
        for (const { table, column, ddl } of wanted) {
            try {
                const cols = await this.db!.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
                if (Array.isArray(cols) && !cols.some(c => c.name === column)) {
                    await this.db!.execute(ddl);
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
                await this.db!.execute(
                    "UPDATE todo SET priority_level = CASE priority WHEN 'low' THEN 0 WHEN 'medium' THEN 127 WHEN 'high' THEN 255 ELSE 127 END WHERE priority_level IS NULL"
                );
                console.info('[db] 已回填 priority_level 存量数据');
            } catch (e) {
                console.warn('[db] 回填 priority_level 失败:', e);
            }
        }
    }

    public async ensureDbInitialized() {
        if (!this.db) {
            await this.initDatabase();
        }
    }

    public async startClipboardListener() {
        await this.ensureDbInitialized();

        // 复制瞬间的来源应用：查询当前前台进程名（复制不切换焦点，监听回调触发时前台仍是复制方）。
        // 查询失败不阻断入库（来源留空，UI 不显示）。
        const queryForegroundApp = async (): Promise<string | null> => {
            try {
                return (await invoke<string | null>('foreground_app_name')) ?? null;
            } catch { return null; }
        };

        // 文本更新
        await onTextUpdate(async (newText) => {
            try {
                await this.saveClipboard(newText, 'text', await queryForegroundApp());
                // 写库成功后通知前端列表立即刷新（事件驱动，替代每秒轮询）
                window.dispatchEvent(new CustomEvent('clipboard:changed'));
            } catch (err) {
                console.error('保存剪贴板文本失败:', err);
            }
        });

        // 图片更新：onImageUpdate 在某些平台/格式下回传的是文件路径而非 base64，
        // 改用 onSomethingUpdate 判定类型后主动 readImageBase64() 获取真实数据。
        await onSomethingUpdate(async (updated) => {
            if (!updated.image) return;
            try {
                const base64 = await readImageBase64();
                if (!base64) return;
                // 拼上 data URL 前缀（无前缀时浏览器会把它当相对路径向 dev server 发请求导致 431）
                const dataUrl = base64.startsWith('data:')
                    ? base64
                    : `data:image/png;base64,${base64}`;
                await this.saveClipboard(dataUrl, 'image', await queryForegroundApp());
                // 写库成功后通知前端列表立即刷新（事件驱动，替代每秒轮询）
                window.dispatchEvent(new CustomEvent('clipboard:changed'));
            } catch (err) {
                console.error('读取剪贴板图片失败:', err);
            }
        });

        // 注意：startListening 的 listenTypes 参数会整体覆盖默认值
        // （默认 text/html/rtf/image/files 全开），必须显式传入 text + image，
        // 只传 { image: true } 会关闭文本监听，导致 TEXT_CHANGED 永不触发。
        await startListening({ text: true, image: true });
        console.log("Clipboard listener started");
    }

    /**
     * 写入一条剪贴板记录（文本或图片）。
     * - 使用 INSERT ... ON CONFLICT(content) 单语句 upsert：并发监听回调同时到达时
     *   不会撞 content UNIQUE 约束（此前的"先查后插"存在竞态，第二条会抛错丢事件）；
     * - 新插入时额外做统计埋点与按上限裁剪。
     */
    /** 本应用粘贴写入抑制窗口：窗口内 saveClipboard 的 ON CONFLICT 不递增 count
     *  （粘贴流程已由命令层显式 increaseUseCount，剪贴板监听再 bump 会双计） */
    private useCountSuppressUntil = 0;

    /** 标记"即将由本应用粘贴流程写剪贴板"：与 suppressIslandCopy 同源时序，写入前调用 */
    public suppressUseCountBump(ms = 1200): void {
        this.useCountSuppressUntil = Date.now() + ms;
    }

    /** 写入一条剪贴板记录（文本或图片；sourceApp = 复制瞬间的前台进程名，可空）。
     * - 使用 INSERT ... ON CONFLICT(content) 单语句 upsert：并发监听回调同时到达时
     *   不会撞 content UNIQUE 约束（此前的"先查后插"存在竞态，第二条会抛错丢事件）；
     * - 新插入时额外做统计埋点与按上限裁剪；
     * - source_app 仅在新插入时写入：应用自身粘贴也会写剪贴板（触发本函数），
     *   冲突时若更新来源会把历史条目的原始来源覆盖为 S1d3 Board。 */
    private async saveClipboard(content: string, type: 'text' | 'image', sourceApp?: string | null): Promise<void> {
        const now = Math.floor(Date.now());
        // 先查一次用于区分"新插入 / 计数递增"（统计与裁剪只应发生在新插入时）；
        // 写入本身用 ON CONFLICT 单语句 upsert，即使并发事件在查询后插入也不会撞 UNIQUE 丢事件。
        const existingRecord: ClipboardData[] = await this.db!.select(
            "SELECT id FROM clipboard WHERE content = $1",
            [content]
        );
        const isNew = existingRecord.length === 0;
        // 本应用粘贴流程的写入：命令层已显式计数，重复复制 bump 抑制为 +0，防双计
        const bump = Date.now() >= this.useCountSuppressUntil ? 1 : 0;

        const result = await this.db!.execute(
            "INSERT INTO clipboard (content, category, type, created_at, updated_at, source_app) VALUES ($1, $2, $3, $4, $5, $7) " +
            "ON CONFLICT(content) DO UPDATE SET count = count + $6, updated_at = $5",
            [content, 'T', type, now, now, bump, sourceApp ?? null]
        );
        console.log(`Clipboard ${type} saved (upsert):`, result);
        // 灵动岛：复制行为反馈（文本/图片、重复复制同一内容同样提示；
        // 本应用粘贴流程的写入由 island 模块抑制，不会误报"已复制"）
        window.dispatchEvent(new CustomEvent('island:copy', { detail: { content, type } }));
        if (!isNew) return;

        // 统计埋点（fire-and-forget）：新插入文本/图片剪贴 +1；文本额外累加字符量（图片 base64 不计入"打字量"）
        if (type === 'text') {
            void statsService.record({ clip_text: 1, clip_chars: content.length });
        } else {
            void statsService.record({ clip_image: 1 });
        }
        // 新记录插入后按「剪贴板最大存储数量」裁剪最旧记录
        await this.trimClipboard();

        // 智能剪贴板：新文本入库 → 广播复制事件（处理层 smartClip 解析进内存 store；
        // 设计文档 §4.1 触发点）。仅文本参与解析管道。
        if (type === 'text') {
            const insertedId = Number((result as { lastInsertId?: number | bigint }).lastInsertId);
            window.dispatchEvent(new CustomEvent('smart-clip:copy', {
                detail: { id: insertedId, content, ts: Date.now() },
            }));
        }
    }


    /**
     * 按设置项「剪贴板最大存储数量」（max_save_count）裁剪剪贴板：
     * 超出上限时删除最旧记录；未设置或值为无效数字时不裁剪。
     */
    private async trimClipboard(): Promise<void> {
        try {
            const maxRaw = await this.getKeyValue('max_save_count');
            const max = parseInt(maxRaw ?? '', 10);
            if (!max || max <= 0) return;

            const rows: any[] = await this.db!.select("SELECT COUNT(*) AS cnt FROM clipboard");
            const count = rows?.[0]?.cnt as number | undefined;
            if (count === undefined || count <= max) return;

            const excess = count - max;
            await this.db!.execute(
                "DELETE FROM clipboard WHERE id IN " +
                "(SELECT id FROM clipboard ORDER BY updated_at ASC, id ASC LIMIT $1)",
                [excess]
            );
        } catch (e) {
            console.error('裁剪剪贴板失败:', e);
        }
    }

    public async fetchClipboardData(filter: any, page?: PageQuery): Promise<ClipboardData[]> {
        await this.ensureDbInitialized();

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
            const maxRaw = await this.getKeyValue('max_save_count');
            const parsed = parseInt(maxRaw ?? '', 10);
            if (parsed > 0) {
                limit = favorite === 1 ? Math.min(parsed, 100) : Math.min(parsed, 10000);
            }
        }

        const baseSql = `SELECT * FROM clipboard ${whereSql} ORDER BY updated_at DESC, id DESC`;
        if (page) {
            const { sql, params: pageParams } = withPage(page, params);
            return await this.db!.select(baseSql + sql, pageParams) as ClipboardData[];
        }
        return await this.db!.select(baseSql + ` LIMIT ${limit}`, params) as ClipboardData[];
    }

    public async fetchClipboardSingleData(id: number): Promise<ClipboardData | undefined> {
        await this.ensureDbInitialized();
        const data = await this.db!.select("SELECT * FROM clipboard WHERE id = $1", [id]) as ClipboardData[]
        return data[0]
    }

    public async updateFavorite(id: number, value: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("UPDATE clipboard SET is_favorite = $2 WHERE id = $1", [id, value]);
        // 统计埋点（fire-and-forget）：收藏/取消收藏切换 +1
        void statsService.record({ favorite_toggle: 1 });
    }

    public async increaseUseCount(id: number): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute("UPDATE clipboard SET count = count + 1, updated_at = $2 WHERE id = $1", [id, now]);
        // 统计埋点（fire-and-forget）：粘贴使用 +1
        void statsService.record({ clip_use: 1 });
    }

    /**
     * 全局 Ctrl+V 粘贴感知计数：按内容精确匹配剪贴板条目并复用 increaseUseCount
     * （count+1 + updated_at + clip_use 统计）。内容不在剪贴板历史中（应用未运行时复制、
     * 已被上限裁剪）时不计数；图片 base64 编码不稳定，调用方仅对文本调用。
     * 应用自身粘贴由 Rust PASTE_INJECTING 拦截不 emit，与此处无双计。
     */
    public async increaseUseCountByContent(content: string): Promise<void> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select("SELECT id FROM clipboard WHERE content = $1 LIMIT 1", [content]) as { id: number }[];
        if (rows.length === 0) return;
        await this.increaseUseCount(rows[0].id);
    }

    public async deleteClipboardData(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM clipboard WHERE id = $1", [id]);
    }

    // ===== 常用剪贴（pinned_clip）=====

    /**
     * 获取常用剪贴列表（不限量，可无限存储；传 page 时按流式分页返回）。
     * 排序：置顶项优先（按置顶时间倒序），其余按时间倒序（最新在前）。
     */
    public async fetchPinnedClips(page?: PageQuery): Promise<PinnedClip[]> {
        await this.ensureDbInitialized();
        const baseSql =
            "SELECT * FROM pinned_clip ORDER BY " +
            "CASE WHEN pinned_at IS NOT NULL AND pinned_at != '' THEN 1 ELSE 0 END DESC, " +
            "pinned_at DESC, created_at DESC, id DESC";
        if (page) {
            const { sql, params } = withPage(page, []);
            return await this.db!.select(baseSql + sql, params) as PinnedClip[];
        }
        return await this.db!.select(baseSql) as PinnedClip[];
    }

    /** 获取单个常用剪贴项 */
    public async fetchPinnedClip(id: number): Promise<PinnedClip | undefined> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select("SELECT * FROM pinned_clip WHERE id = $1", [id]) as PinnedClip[];
        return rows[0];
    }

    /**
     * 新增常用剪贴项（最新一条排最前）。
     * 常用剪贴不限量存储：不会自动裁剪旧数据。
     */
    public async insertPinnedClip(content: string, type: 'text' | 'image', name?: string, source?: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "INSERT INTO pinned_clip (content, type, name, source, sort_order, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [content, type, name || '', source || '', 0, now, now]
        );
    }

    /**
     * 判断常用剪贴中是否已存在相同内容（按 content + type 去重）。
     * 用于 Ctrl+U「添加为常用」时避免重复添加。
     */
    public async isPinnedContentExist(content: string, type: 'text' | 'image'): Promise<boolean> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select(
            "SELECT id FROM pinned_clip WHERE content = $1 AND type = $2 LIMIT 1",
            [content, type]
        ) as { id: number }[];
        return rows.length > 0;
    }

    /** 更新常用剪贴项（文本可改内容；图片替换传新 base64；name 可编辑） */
    public async updatePinnedClip(id: number, content: string, name: string, type: 'text' | 'image'): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE pinned_clip SET content = $2, name = $3, type = $4, updated_at = $5 WHERE id = $1",
            [id, content, name, type, now]
        );
    }

    /** 置顶/取消置顶常用剪贴项（置顶后排序优先；pinned=false 取消置顶） */
    public async pinPinnedClip(id: number, pinned: boolean): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE pinned_clip SET pinned_at = $2, updated_at = $3 WHERE id = $1",
            [id, pinned ? now : '', now]
        );
    }

    /** 删除单条常用剪贴项（仅从常用剪贴移除，不影响剪贴板主列表原条目） */
    public async deletePinnedClip(id: number): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM pinned_clip WHERE id = $1", [id]);
    }

    /**
     * 清空业务数据（剪贴板 / 便签 / 待办）与统计数据（daily_stat），
     * 保留配置表（settings、shortcut_binding）与常用剪贴（pinned_clip，重置不动它，单条删除走 deletePinnedClip）。
     * 同时重置各表的自增主键计数。
     *
     * 清空前把上述表完整备份到 clear_backup_* 表，配合 undoClearDatabase（5 秒
     * 撤回窗口内整表恢复）与 finalizeClear（窗口结束后丢弃备份）实现可撤回清空；
     * 上次会话遗留的备份在 initDatabase 中清理。
     */
    public async clearDatabase(): Promise<void> {
        await this.ensureDbInitialized();
        for (const { src, backup } of CLEAR_BACKUP_TABLES) {
            await this.db!.execute(`DROP TABLE IF EXISTS ${backup}`);
            await this.db!.execute(`CREATE TABLE ${backup} AS SELECT * FROM ${src}`);
        }
        await this.db!.execute("DELETE FROM clipboard");
        await this.db!.execute("DELETE FROM note");
        await this.db!.execute("DELETE FROM todo");
        // 统计数据一并清空（statsService.clearAll 会同时丢弃内存累加器，避免清表后被写回）
        await statsService.clearAll();
        await this.db!.execute(
            "DELETE FROM sqlite_sequence WHERE name IN ('clipboard', 'note', 'todo')"
        );
    }

    /**
     * 撤回清空：把 clear_backup_* 备份整表还原。返回是否有备份被恢复。
     * 撤回窗口内新写入的数据先被清掉，保证恢复后与"清空前"状态完全一致；
     * 剪贴板全文索引由触发器随删/插自动维护，无需额外重建。
     */
    public async undoClearDatabase(): Promise<boolean> {
        await this.ensureDbInitialized();
        const restorable: { src: string; backup: string }[] = [];
        for (const entry of CLEAR_BACKUP_TABLES) {
            if (await this.tableExists(entry.backup)) restorable.push(entry);
        }
        if (restorable.length === 0) return false;
        for (const { src, backup } of restorable) {
            await this.db!.execute(`DELETE FROM ${src}`);
            await this.db!.execute(`INSERT INTO ${src} SELECT * FROM ${backup}`);
            await this.db!.execute(`DROP TABLE ${backup}`);
        }
        return true;
    }

    /** 撤回窗口结束：丢弃备份，清空彻底生效（幂等，可在无备份时安全调用） */
    public async finalizeClear(): Promise<void> {
        await this.ensureDbInitialized();
        for (const { backup } of CLEAR_BACKUP_TABLES) {
            await this.db!.execute(`DROP TABLE IF EXISTS ${backup}`);
        }
    }

    private async tableExists(name: string): Promise<boolean> {
        const rows = await this.db!.select<{ name: string }[]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
            [name]
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    /**
     * 保存单个快捷键到 shortcut_binding 规范化表（按 shortcut_id upsert）
     */
    public async saveShortcutSetting(id: string, value: string, scope: string, title: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const existing: any[] = await this.db!.select(
            "SELECT id FROM shortcut_binding WHERE shortcut_id = $1",
            [id]
        );
        if (existing.length > 0) {
            await this.db!.execute(
                "UPDATE shortcut_binding SET key = $1, scope = $2, description = $3, updated_at = $4 WHERE shortcut_id = $5",
                [value, scope, title, now, id]
            );
        } else {
            await this.db!.execute(
                "INSERT INTO shortcut_binding (shortcut_id, key, scope, description, updated_at) VALUES ($1, $2, $3, $4, $5)",
                [id, value, scope, title, now]
            );
        }
    }

    /** 加载已保存的快捷键配置（返回 { id, value }[]） */
    public async loadShortcutSettings(): Promise<{ id: string; value: string }[]> {
        await this.ensureDbInitialized();
        const rows: any[] = await this.db!.select(
            "SELECT shortcut_id, key FROM shortcut_binding WHERE key IS NOT NULL AND key != ''"
        );
        return rows
            .filter(r => typeof r.shortcut_id === 'string')
            .map(r => ({ id: r.shortcut_id, value: r.key }));
    }

    public async setKeyValue(key : string,value: string): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        // UPSERT：首次设置的 key（表中尚无对应行）也能持久化，避免仅 UPDATE 导致新 key 无法写入
        await this.db!.execute(
            "INSERT INTO settings (key, value, type, updated_at) VALUES ($1, $2, 'other', $3) " +
            "ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = $3",
            [key, value, now]
        );
    }

    public async getKeyValue(key:string): Promise<string> {
        await this.ensureDbInitialized();
        const result: any[] = await this.db!.select("SELECT value FROM settings WHERE key = $1", [key]);
        return result.length > 0 ? result[0].value : '';
    }

    // ===================== 智能剪贴板：方案（smart-clip，设计文档 §4.3） =====================
    // 注：原「分词规则」clip_rules 已废弃——用户侧只维护提取器（单个提取单元）与方案（多提取器集成），
    // 拆分能力由提取器的正则/分隔符承担，表与旧数据保留但不再读写。

    /**
     * 全量方案：按更新时间倒序。
     * 表沿用 clip_templates（表重命名需迁移），title/description/members 由 ensureFeatureColumns 补齐；
     * 旧数据（只有 name）以 name 兜底 title，members 空串/脏数据视为空数组（= 自动接入全部提取器）。
     */
    public async fetchClipSchemes(): Promise<ClipScheme[]> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select(
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
    }

    /** UPSERT 单条方案（name 列同步写 title，兼容旧二进制/旧查询） */
    public async saveClipScheme(scheme: ClipScheme): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute(
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
    }

    public async deleteClipScheme(id: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute('DELETE FROM clip_templates WHERE id = $1', [id]);
    }

    // ===================== 智能剪贴板：用户习惯记录 + AI 结果冷却缓存 =====================

    /**
     * 记录一次强信号用户动作（paste / pin）。
     * 只记强信号：箭头切换等中间态是噪声，落库反而稀释偏好统计。
     * 每次插入顺带裁剪，只保留最近 500 条。
     */
    public async insertClipHabit(h: {
        contentHash: string;
        extractorId: string;
        action: 'paste' | 'pin';
        segmentText: string;
    }): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute(
            'INSERT INTO clip_habits (content_hash, extractor_id, action, segment_text, created_at) VALUES ($1, $2, $3, $4, $5)',
            [h.contentHash, h.extractorId, h.action, h.segmentText, Date.now()],
        );
        await this.db!.execute(
            'DELETE FROM clip_habits WHERE id NOT IN (SELECT id FROM clip_habits ORDER BY id DESC LIMIT 500)',
        );
    }

    /** 灵动岛历史：全部弹岛来源（复制/粘贴/AI/设置操作/第三方 API）汇聚写入，FIFO 保留最近 500 条 */
    public async insertIslandHistory(h: { kind: string; text: string }): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute(
            'INSERT INTO island_history (kind, text, created_at) VALUES ($1, $2, $3)',
            [h.kind, h.text, Date.now()],
        );
        await this.db!.execute(
            'DELETE FROM island_history WHERE id NOT IN (SELECT id FROM island_history ORDER BY id DESC LIMIT 500)',
        );
    }

    /**
     * 灵动岛历史查询（GET /api/history 的数据源）：按时间倒序（最新在前）。
     * 过滤在 SQL 侧执行（先 WHERE 后 LIMIT）：kind 精确匹配；from/to 为毫秒时间戳
     * 区间（含头不含尾，可单侧使用）；limit 为过滤后的返回上限。
     */
    public async getIslandHistory(
        limit = 500,
        filter?: { kind?: string; from?: number; to?: number },
    ): Promise<Array<{ id: number; kind: string; text: string; createdAt: number }>> {
        await this.ensureDbInitialized();
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
        const rows = await this.db!.select(
            `SELECT id, kind, text, created_at FROM island_history${clause} ORDER BY id DESC LIMIT $${params.length}`,
            params,
        ) as Array<{ id: number; kind: string; text: string; created_at: number }>;
        return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, createdAt: r.created_at }));
    }

    /** 清空灵动岛历史 */
    public async clearIslandHistory(): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute('DELETE FROM island_history');
    }

    /** 偏好摘要：最近 100 次 paste 中，各提取器产出被粘贴的次数（降序 Top5） */
    public async fetchHabitDigest(): Promise<Array<{ extractorId: string; count: number }>> {
        await this.ensureDbInitialized();
        const rows = await this.db!.select(
            "SELECT extractor_id, COUNT(*) AS count FROM clip_habits WHERE action = 'paste' " +
            'GROUP BY extractor_id ORDER BY count DESC LIMIT 5',
        ) as Array<{ extractor_id: string; count: number }>;
        return rows.map((r) => ({ extractorId: r.extractor_id, count: Number(r.count) }));
    }

    /** 读取 AI 结果缓存：窗口期内命中返回输出，过期/不存在返回 null（windowSec = 0 表示每次重新生成） */
    public async getAiCache(key: string, windowSec: number): Promise<string | null> {
        await this.ensureDbInitialized();
        if (windowSec <= 0) return null;
        const rows = await this.db!.select(
            'SELECT output, created_at FROM clip_ai_cache WHERE key = $1',
            [key],
        ) as Array<{ output: string; created_at: number }>;
        if (rows.length === 0) return null;
        if (Date.now() - Number(rows[0]!.created_at) > windowSec * 1000) return null;
        return rows[0]!.output;
    }

    /** 写入/刷新 AI 结果缓存 */
    public async setAiCache(key: string, output: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute(
            'INSERT INTO clip_ai_cache (key, output, created_at) VALUES ($1, $2, $3) ' +
            'ON CONFLICT(key) DO UPDATE SET output = $2, created_at = $3',
            [key, output, Date.now()],
        );
    }

    public async insertNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        console.log(note)
        await this.db!.execute(
            "INSERT INTO note (id,content, color, created_at, updated_at) VALUES ($1,$2, $3, $4, $5)",
            [note.id,note.content, note.color || '', now, now]
        );
        // 统计埋点（fire-and-forget）：新建便签 +1
        void statsService.record({ note_added: 1 });
    }

    public async updateNote(note: Note): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        await this.db!.execute(
            "UPDATE note SET content = $1, color = $2, updated_at = $3 WHERE id = $4",
            [note.content, note.color || '', now, note.id]
        );
    }

    public async deleteNote(noteId: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM note WHERE id = $1", [noteId]);
        // 统计埋点（fire-and-forget）：删除便签 +1
        void statsService.record({ note_deleted: 1 });
    }

    public async fetchNotes(filter: any, page?: PageQuery): Promise<Note[]> {
        await this.ensureDbInitialized();

        const content: string = filter.value.searchContent;
        const baseSql = "SELECT * FROM note WHERE content LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC, id DESC";
        const params = [`%${escapeLike(content)}%`];

        if (page) {
            const { sql, params: pageParams } = withPage(page, params);
            return await this.db!.select(baseSql + sql, pageParams) as Note[];
        }
        // 未传分页（全量查询，用于搜索"全部范围"等场景）：保留 500 条上限防止极端数据拉爆内存
        return await this.db!.select(baseSql + " LIMIT 500", params) as Note[];
    }

    public async fetchSingleNote(noteId: string): Promise<Note | undefined> {
        await this.ensureDbInitialized();
        const data = await this.db!.select("SELECT * FROM note WHERE id = $1", [noteId]) as Note[];
        return data[0];
    }


    public async insertTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const level = clampPriorityLevel(todo.priorityLevel);
        await this.db!.execute(
            "INSERT INTO todo (id,title, description, completed, priority, priority_level, category, created_at, updated_at, dueDate, remind_mode, remind_at, remind_rules) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
            [todo.id,todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules)]
        );
        // 统计埋点（fire-and-forget）：新建待办 +1，并累计任务标题+描述的字符数
        const todoChars = (todo.title?.length ?? 0) + (todo.description?.length ?? 0);
        void statsService.record({ todo_added: 1, todo_chars: todoChars });
    }

    public async updateTodo(todo: Todo): Promise<void> {
        await this.ensureDbInitialized();
        const now = Math.floor(Date.now());
        const level = clampPriorityLevel(todo.priorityLevel);
        await this.db!.execute(
            "UPDATE todo SET title = $1, description = $2, completed = $3, priority = $4, priority_level = $5, category = $6, updated_at = $7, dueDate = $8, remind_mode = $9, remind_at = $10, remind_rules = $11 WHERE id = $12",
            [todo.title, todo.description || '', todo.completed, tierOf(level), level, todo.category || '', now, todo.dueDate || '', todo.remindMode || 'smart', todo.remindAt || '', stringifyRemindRules(todo.remindRules), todo.id]
        );
    }

    public async deleteTodo(todoId: string): Promise<void> {
        await this.ensureDbInitialized();
        await this.db!.execute("DELETE FROM todo WHERE id = $1", [todoId]);
        // 统计埋点（fire-and-forget）：删除待办 +1
        void statsService.record({ todo_deleted: 1 });
    }

    public async fetchTodos(filter: any, page?: PageQuery): Promise<Todo[]> {
        await this.ensureDbInitialized();

        const content: string = filter.value.searchContent;
        const baseSql = "SELECT * FROM todo WHERE title LIKE $1 ESCAPE '\\' ORDER BY updated_at DESC, id DESC";
        const params = [`%${escapeLike(content)}%`];

        let rows: Todo[];
        if (page) {
            const { sql, params: pageParams } = withPage(page, params);
            rows = await this.db!.select(baseSql + sql, pageParams) as Todo[];
        } else {
            // 未传分页（全量查询，用于提醒调度 sync 等场景）：保留 500 条上限
            rows = await this.db!.select(baseSql + " LIMIT 500", params) as Todo[];
        }
        return rows.map(mapTodoRemindRules);
    }

    public async fetchSingleTodo(todoId: string): Promise<Todo | undefined> {
        await this.ensureDbInitialized();
        const data = await this.db!.select("SELECT * FROM todo WHERE id = $1", [todoId]) as Todo[];
        return data[0] ? mapTodoRemindRules(data[0]) : undefined;
    }


}

const clipboardService = DatabaseService.getInstance();

export default clipboardService
