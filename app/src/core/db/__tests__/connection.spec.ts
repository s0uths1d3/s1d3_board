import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import Database from '@tauri-apps/plugin-sql';
import { createDatabaseConnection } from '../connection';

/** plugin-sql Database 实例桩类型 */
type DbStub = { select: Mock; execute: Mock };

/**
 * 注入一个全新的 Database.load 返回桩（setup 已全局 mock plugin-sql，
 * 这里用 mockImplementationOnce 覆盖单次返回，便于按测试打桩 select/execute）。
 */
function stubDb(selectImpl?: (sql: string, params?: unknown[]) => Promise<unknown>): DbStub {
    const db: DbStub = {
        select: vi.fn(selectImpl ?? (async () => [])),
        execute: vi.fn(async () => ({ rowsAffected: 0 })),
    };
    vi.mocked(Database.load).mockImplementationOnce(
        async () => db as unknown as Awaited<ReturnType<typeof Database.load>>,
    );
    return db;
}

describe('createDatabaseConnection', () => {
    beforeEach(() => {
        vi.mocked(Database.load).mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('ready() 懒加载且复用单一连接', async () => {
        stubDb();
        const conn = createDatabaseConnection();
        expect(conn.peek()).toBeUndefined(); // 未 ready 前不触发加载
        const c1 = await conn.ready();
        const c2 = await conn.ready();
        expect(Database.load).toHaveBeenCalledTimes(1);
        expect(c2).toBe(c1);
        expect(conn.peek()).toBe(c1);
    });

    it('连接建立即设置 WAL 与 busy_timeout', async () => {
        const db = stubDb();
        const conn = createDatabaseConnection();
        await conn.ready();
        const sqls = db.select.mock.calls.map((c: unknown[]) => c[0]);
        expect(sqls).toContain('PRAGMA journal_mode=WAL');
        expect(sqls).toContain('PRAGMA busy_timeout=5000');
    });

    it('quick_check 异常时输出恢复指引（fire-and-forget）', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const db = stubDb(async (sql: string) => {
            if (sql.includes('quick_check')) return [{ quick_check: 'malformed' }];
            return [];
        });
        const conn = createDatabaseConnection();
        await conn.ready();
        await vi.waitFor(() => expect(spy).toHaveBeenCalled());
        expect(String(spy.mock.calls[0]?.[0])).toContain('数据库完整性检查失败');
        expect(db.select).toHaveBeenCalledWith('PRAGMA quick_check');
    });

    it('executeWithRetry：锁错误指数退避重试后成功（80/160ms）', async () => {
        const db = stubDb();
        const conn = createDatabaseConnection();
        await conn.ready();
        db.execute
            .mockRejectedValueOnce(new Error('database is locked'))
            .mockRejectedValueOnce(new Error('database is locked'))
            .mockResolvedValueOnce({ rowsAffected: 1, lastInsertId: 7 });

        vi.useFakeTimers();
        const promise = conn.executeWithRetry('INSERT INTO t VALUES ($1)', ['x']);
        await vi.advanceTimersByTimeAsync(0);   // 首次尝试（锁）→ 等 80ms
        await vi.advanceTimersByTimeAsync(80);  // 第 2 次（锁）→ 等 160ms
        await vi.advanceTimersByTimeAsync(160); // 第 3 次成功
        expect(await promise).toEqual({ rowsAffected: 1, lastInsertId: 7 });
        expect(db.execute).toHaveBeenCalledTimes(3);
    });

    it('executeWithRetry：非锁错误立即抛出，不重试', async () => {
        const db = stubDb();
        const conn = createDatabaseConnection();
        await conn.ready();
        db.execute.mockRejectedValue(new Error('no such table: x'));
        await expect(conn.executeWithRetry('SELECT 1', [])).rejects.toThrow('no such table');
        expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('executeWithRetry：3 次重试仍锁则抛出（共 4 次调用）', async () => {
        const db = stubDb();
        const conn = createDatabaseConnection();
        await conn.ready();
        db.execute.mockRejectedValue(new Error('database is locked'));
        vi.useFakeTimers();
        const outcome = conn.executeWithRetry('UPDATE t SET a = 1', []).then(
            () => 'resolved',
            (e: Error) => `rejected: ${e.message}`,
        );
        await vi.advanceTimersByTimeAsync(80 + 160 + 320 + 1000);
        expect(await outcome).toBe('rejected: database is locked');
        expect(db.execute).toHaveBeenCalledTimes(4);
    });
});
