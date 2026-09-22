import Database from '@tauri-apps/plugin-sql';
import { vi } from 'vitest';
import { createDatabaseConnection, type DatabaseConnection } from '../../connection';

/** 仓储层测试共用桩：可编程 select 返回值 + 调用记录 */

export interface RecordedCall {
    sql: string;
    params?: unknown[];
}

/**
 * 可编程桩库：记录全部 select/execute 调用；select 返回值可按 SQL 定制（默认 []）。
 * execute 返回 { rowsAffected: 1, lastInsertId: 101 }（saveClipboard 的 smart-clip 派发需要可断言的 id）。
 */
export function stubDb(mapSelect?: (sql: string, params?: unknown[]) => unknown[] | undefined) {
    const selects: RecordedCall[] = [];
    const executes: RecordedCall[] = [];
    const db = {
        select: vi.fn(async (sql: string, params?: unknown[]) => {
            selects.push({ sql, params });
            return mapSelect ? (mapSelect(sql, params) ?? []) : [];
        }),
        execute: vi.fn(async (sql: string, params?: unknown[]) => {
            executes.push({ sql, params });
            return { rowsAffected: 1, lastInsertId: 101 };
        }),
    };
    return { db, selects, executes };
}

/** 用桩库建立一次性连接（Database.load 只被本次消费；connection 内部缓存复用） */
export async function connWith(stub: unknown): Promise<DatabaseConnection> {
    vi.mocked(Database.load).mockImplementationOnce(
        async () => stub as unknown as Awaited<ReturnType<typeof Database.load>>,
    );
    return createDatabaseConnection();
}
