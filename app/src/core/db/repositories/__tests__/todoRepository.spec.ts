import { describe, expect, it, vi } from 'vitest';
import { createTodoRepository } from '../todoRepository';
import { connWith, stubDb } from './helpers';

describe('todoRepository', () => {
    it('fetchTodos：SELECT * 行键 snake_case 归一 + remind_rules JSON 解析', async () => {
        const { db } = stubDb(() => [{
            id: 't1', title: '任务', completed: 0, priority: 'high',
            remind_mode: 'custom', remind_at: '2026-01-01T08:00:00', priority_level: 200,
            remind_rules: JSON.stringify([{ id: 'a', kind: 'percent', value: '50' }, { id: 'bad' }]),
        }]);
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        const todos = await repo.fetchTodos({ value: { searchContent: '' } });

        expect(todos[0]?.remindMode).toBe('custom');
        expect(todos[0]?.remindAt).toBe('2026-01-01T08:00:00');
        expect(todos[0]?.priorityLevel).toBe(200);
        expect(todos[0]?.remindRules).toEqual([{ id: 'a', kind: 'percent', value: 50 }]);
    });

    it('fetchTodos：SQL 过滤软删行；扩展列 snake_case 归一 + tags/links/recurrence JSON 解析', async () => {
        const { db, selects } = stubDb(() => [{
            id: 't1', title: '任务', completed: 0,
            parent_id: 'p1', sort_order: 7, deleted_at: null,
            tags: JSON.stringify(['a', 'a', ' b ']),
            links: JSON.stringify([{ title: '文档', url: 'https://x' }, { title: '坏', url: '' }]),
            recurrence: JSON.stringify({ freq: 'monthly', interval: 1, monthDay: 31, from: 'due' }),
        }]);
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        const todos = await repo.fetchTodos({ value: { searchContent: '' } });

        // selects[0] 是连接就绪的 PRAGMA；取业务查询断言
        expect(selects.map(s => s.sql).find(sql => sql.includes('FROM todo'))).toContain('deleted_at IS NULL AND title LIKE');
        expect(todos[0]?.parentId).toBe('p1');
        expect(todos[0]?.sortOrder).toBe(7);
        expect(todos[0]?.deletedAt).toBeNull();
        expect(todos[0]?.tags).toEqual(['a', 'b']);
        expect(todos[0]?.links).toEqual([{ title: '文档', url: 'https://x' }]);
        expect(todos[0]?.recurrence).toEqual({ freq: 'monthly', interval: 1, monthDay: 31, from: 'due' });
    });

    it('fetchTodos：非法 tags/links/recurrence（损坏 JSON / 非法字段）容错为 undefined', async () => {
        const { db } = stubDb(() => [{
            id: 't2', title: 'y',
            tags: '{not json', links: '[{', recurrence: '{"freq":"hourly"}',
        }]);
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        const todos = await repo.fetchTodos({ value: { searchContent: '' } });

        expect(todos[0]?.tags).toBeUndefined();
        expect(todos[0]?.links).toBeUndefined();
        expect(todos[0]?.recurrence).toBeUndefined();
    });

    it('fetchTodos：旧数据无规则但有 remindAt → 折算 legacy at 规则；JSON 损坏视为无规则', async () => {
        const legacy = createTodoRepository({
            conn: await connWith(stubDb(() => [{ id: 't1', title: 'x', remind_mode: 'custom', remind_at: 'T' }]).db),
            recordStats: vi.fn(async () => {}),
        });
        const todos = await legacy.fetchTodos({ value: { searchContent: '' } });
        expect(todos[0]?.remindRules).toEqual([{ id: 'legacy', kind: 'at', value: 'T' }]);

        const broken = createTodoRepository({
            conn: await connWith(stubDb(() => [{ id: 't2', title: 'y', remind_rules: '{not json' }]).db),
            recordStats: vi.fn(async () => {}),
        });
        const todos2 = await broken.fetchTodos({ value: { searchContent: '' } });
        expect(todos2[0]?.remindRules).toEqual([]);
    });

    it('insertTodo：priorityLevel 越界收敛 0-255，legacy 三档列同步；新列空值缺省', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createTodoRepository({ conn: await connWith(db), recordStats });

        await repo.insertTodo({ id: 't1', title: '任务', completed: false, priorityLevel: 300 } as never);

        expect(executes[0]?.sql).toContain('INSERT INTO todo (id, title, description, completed, priority, priority_level,');
        expect(executes[0]?.sql).toContain('COALESCE($18,');
        // 末两参：sort_order 未显式提供（null → 走子查询自动分配）+ 子查询作用域 parent_id
        expect(executes[0]?.params).toEqual([
            't1', '任务', '', false, 'high', 255, '', expect.any(Number), expect.any(Number), '',
            'smart', '', '', '', null, '', '', null, null,
        ]);
        expect(recordStats).toHaveBeenCalledWith({ todo_added: 1, todo_chars: 2 });
    });

    it('insertTodo：扩展列写入（tags 清洗去重 / recurrence 白名单化 / links url 必填）+ sort_order 显式保留', async () => {
        const { db, executes } = stubDb();
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        await repo.insertTodo({
            id: 't2', title: '循环任务', completed: 0, priorityLevel: 300,
            parentId: 'p1',
            tags: [' 工作 ', 'home', '工作', ''],
            recurrence: { freq: 'weekly', interval: 2, weekdays: [1, 9, 3], from: 'complete' },
            links: [{ title: ' 文档 ', url: ' https://a.b ' }, { title: '坏', url: '' }],
            sortOrder: 5,
        } as never);

        const params = executes[0]?.params as unknown[];
        expect(JSON.parse(params[13] as string)).toEqual({ freq: 'weekly', interval: 2, weekdays: [1, 3], from: 'complete' });
        expect(params[14]).toBe('p1');
        expect(params[15]).toBe(JSON.stringify(['工作', 'home']));
        expect(params[16]).toBe(JSON.stringify([{ title: '文档', url: 'https://a.b' }]));
        expect(params[17]).toBe(5);
        expect(params[18]).toBe('p1');
    });

    it('fetchSingleTodo：映射后返回（过滤软删行），无数据 undefined', async () => {
        const { db, selects } = stubDb(() => [{ id: 't1', title: 'x', remind_rules: '' }]);
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });
        const todo = await repo.fetchSingleTodo('t1');
        expect(selects.map(s => s.sql).find(sql => sql.includes('FROM todo'))).toContain('AND deleted_at IS NULL');
        expect(todo?.id).toBe('t1');
        expect(todo?.remindRules).toEqual([]);

        const miss = createTodoRepository({ conn: await connWith(stubDb().db), recordStats: vi.fn(async () => {}) });
        expect(await miss.fetchSingleTodo('nope')).toBeUndefined();
    });

    it('deleteTodo：软删写 deleted_at（子任务级联、已删行不覆盖时间）+ 统计埋点', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createTodoRepository({ conn: await connWith(db), recordStats });

        await repo.deleteTodo('t1');

        expect(executes[0]?.sql).toBe('UPDATE todo SET deleted_at = $2 WHERE (id = $1 OR parent_id = $1) AND deleted_at IS NULL');
        expect(executes[0]?.params?.[0]).toBe('t1');
        expect(typeof executes[0]?.params?.[1]).toBe('string');
        expect(recordStats).toHaveBeenCalledWith({ todo_deleted: 1 });
    });

    it('purgeTodo：真 DELETE 连带子任务，不重复计删除埋点', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createTodoRepository({ conn: await connWith(db), recordStats });

        await repo.purgeTodo('t1');

        expect(executes[0]?.sql).toBe('DELETE FROM todo WHERE id = $1 OR parent_id = $1');
        expect(executes[0]?.params).toEqual(['t1']);
        expect(recordStats).not.toHaveBeenCalled();
    });

    it('restoreTodo：清 deleted_at（子任务级联）', async () => {
        const { db, executes } = stubDb();
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        await repo.restoreTodo('t1');

        expect(executes[0]?.sql).toBe('UPDATE todo SET deleted_at = NULL WHERE id = $1 OR parent_id = $1');
        expect(executes[0]?.params).toEqual(['t1']);
    });

    it('fetchDeletedTodos：回收站查询按删除时间倒序，支持分页', async () => {
        const { db, selects } = stubDb(() => [{ id: 'd1', title: '已删' }]);
        const repo = createTodoRepository({ conn: await connWith(db), recordStats: vi.fn(async () => {}) });

        const rows = await repo.fetchDeletedTodos();
        expect(selects.map(s => s.sql).find(sql => sql.includes('FROM todo'))).toBe('SELECT * FROM todo WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC');
        expect(rows[0]?.id).toBe('d1');

        await repo.fetchDeletedTodos({ offset: 0, limit: 50 });
        expect(selects.map(s => s.sql).filter(sql => sql.includes('FROM todo'))[1]).toContain('LIMIT');
    });
});
