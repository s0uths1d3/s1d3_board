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

    it('insertTodo：priorityLevel 越界收敛 0-255，legacy 三档列同步', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createTodoRepository({ conn: await connWith(db), recordStats });

        await repo.insertTodo({ id: 't1', title: '任务', completed: false, priorityLevel: 300 } as never);

        expect(executes[0]?.sql).toContain('INSERT INTO todo (id,title, description, completed, priority, priority_level,');
        expect(executes[0]?.params).toEqual(['t1', '任务', '', false, 'high', 255, '', expect.any(Number), expect.any(Number), '', 'smart', '', '']);
        expect(recordStats).toHaveBeenCalledWith({ todo_added: 1, todo_chars: 2 });
    });

    it('fetchSingleTodo：映射后返回，无数据 undefined', async () => {
        const hit = createTodoRepository({
            conn: await connWith(stubDb(() => [{ id: 't1', title: 'x', remind_rules: '' }]).db),
            recordStats: vi.fn(async () => {}),
        });
        const todo = await hit.fetchSingleTodo('t1');
        expect(todo?.id).toBe('t1');
        expect(todo?.remindRules).toEqual([]);

        const miss = createTodoRepository({ conn: await connWith(stubDb().db), recordStats: vi.fn(async () => {}) });
        expect(await miss.fetchSingleTodo('nope')).toBeUndefined();
    });

    it('deleteTodo：DELETE + 统计埋点', async () => {
        const { db, executes } = stubDb();
        const recordStats = vi.fn(async () => {});
        const repo = createTodoRepository({ conn: await connWith(db), recordStats });

        await repo.deleteTodo('t1');

        expect(executes[0]?.sql).toBe('DELETE FROM todo WHERE id = $1');
        expect(recordStats).toHaveBeenCalledWith({ todo_deleted: 1 });
    });
});
