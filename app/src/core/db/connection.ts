import Database from '@tauri-apps/plugin-sql';

/**
 * 数据库连接层（core/db）：
 * 全应用**唯一**的 SQLite 连接持有者——dbService 门面与仓储层都通过本抽象取连接，
 * 不再各自 Database.load（tauri-plugin-sql 每次调用会新建连接，绕过 WAL/busy_timeout 设置）。
 *
 * 行为自 dbService.initDatabase / execWithRetry 原样平移：
 * - WAL 日志模式：持久写入 DB 文件头（一次设置，所有连接/窗口生效），读写不再互斥；
 * - busy_timeout（连接级非持久）：本连接写操作遇短时锁竞争由 SQLite 内部等待重试；
 * - quick_check 完整性自检：损坏（malformed, 267）无法由代码修复，启动时显式暴露并给恢复指引；
 * - executeWithRetry：对 "database is locked"(517) 指数退避重试（80/160/320ms），
 *   仅锁错误重试，损坏/语法等错误立即抛出不掩盖。
 */

/** SQL 连接最小接口（结构兼容 @tauri-apps/plugin-sql 的 Database） */
export interface SqlDatabase {
    select<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
    execute(sql: string, params?: unknown[]): Promise<QueryResult>;
}

/** execute 返回值（与 plugin-sql QueryResult 对齐） */
export interface QueryResult {
    rowsAffected: number;
    lastInsertId?: number | bigint;
}

/** 数据库连接句柄抽象（ModuleContext.db 的类型；模块只依赖此接口） */
export interface DatabaseConnection {
    /** 已就绪的连接；未就绪返回 undefined（不触发加载，供探针场景使用） */
    peek(): SqlDatabase | undefined;
    /** 取就绪连接（懒初始化；并发调用复用同一连接与同一次加载） */
    ready(): Promise<SqlDatabase>;
    /** 带锁重试的写入：仅 "database is locked" 指数退避重试，其余错误立即抛出 */
    executeWithRetry<T = QueryResult>(sql: string, params: unknown[], retries?: number): Promise<T>;
}

/** 数据库文件名（与既有部署一致，不可变更——改名为新库） */
export const DB_NAME = 'sqlite:s1d3_board.db';

export function createDatabaseConnection(dbName: string = DB_NAME): DatabaseConnection {
    let db: SqlDatabase | undefined;
    let loading: Promise<SqlDatabase> | undefined;

    async function load(): Promise<SqlDatabase> {
        const conn = (await Database.load(dbName)) as unknown as SqlDatabase;
        // WAL 日志模式：持久写入 DB 文件头（一次设置，所有连接/窗口生效）。
        // 读写不再互斥，显著缩短写锁等待——修复收藏/粘贴等高频写操作报
        // "database is locked"(517) 与并发冲突。
        await conn.select('PRAGMA journal_mode=WAL').catch(() => {});
        // 写锁等待（busy_timeout，连接级非持久）：本连接的写操作遇短时锁竞争时由 SQLite
        // 内部等待重试而非立即报错；池内其他按需新建的连接不继承，由 executeWithRetry 兜底
        await conn.select('PRAGMA busy_timeout=5000').catch(() => {});
        // 完整性自检（quick_check，轻量）：文件损坏（malformed, 267）无法由代码凭空修复，
        // 启动时显式暴露，日志给出恢复指引，避免后续随机报错难以定位。
        void conn.select<{ quick_check: string }[]>('PRAGMA quick_check')
            .then((rows) => {
                const result = rows[0]?.quick_check ?? 'ok';
                if (result !== 'ok') {
                    console.error(`[db] 数据库完整性检查失败: ${result}。文件已损坏，请关闭应用后备份 %APPDATA%/S1d3Board/s1d3_board.db，并用 sqlite3 ".recover" 或 DB Browser for SQLite 导出重建。`);
                }
            })
            .catch(() => {});
        return conn;
    }

    return {
        peek() {
            return db;
        },
        ready() {
            if (db) return Promise.resolve(db);
            // 加载失败后清空 loading：下次 ready() 重新尝试（与原 ensureDbInitialized 每次调用重试一致）
            loading ??= load()
                .then((conn) => { db = conn; return conn; })
                .catch((e) => { loading = undefined; throw e; });
            return loading;
        },
        async executeWithRetry<T>(sql: string, params: unknown[], retries = 3): Promise<T> {
            const conn = await this.ready();
            for (let attempt = 0; ; attempt++) {
                try {
                    return (await conn.execute(sql, params)) as T;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (attempt >= retries || !msg.includes('database is locked')) throw e;
                    await new Promise((r) => setTimeout(r, 80 * 2 ** attempt));
                }
            }
        },
    };
}
