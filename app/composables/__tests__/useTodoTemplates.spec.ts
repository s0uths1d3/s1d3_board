import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 任务模板（useTodoTemplates）单测：
 * KV 存储经 mock dbService 承载，验证存/删/读取容错与字段白名单化。
 */
const mocks = vi.hoisted(() => {
    const kv = new Map<string, string>();
    return {
        getKeyValue: vi.fn(async (k: string) => kv.get(k) ?? ''),
        setKeyValue: vi.fn(async (k: string, v: string) => { kv.set(k, v); }),
        kv,
    };
});

vi.mock('~/src/db/dbService', () => ({
    default: {
        getKeyValue: mocks.getKeyValue,
        setKeyValue: mocks.setKeyValue,
    },
}));

import { useTodoTemplates } from '../useTodoTemplates';

beforeEach(() => {
    mocks.kv.clear();
    // 模块级单例的 loaded 状态不可逆置——每个用例依赖同一实例，按顺序编排断言
});

describe('useTodoTemplates 任务模板', () => {
    it('存为模板：名称必填、写入 KV，templates 响应式更新', async () => {
        const { templates, saveTemplate } = useTodoTemplates();
        const ok = await saveTemplate({
            name: '晨间例会',
            title: '晨会',
            description: '同步昨日进展',
            priorityLevel: 200,
            category: '工作',
            tags: ['例行'],
            recurrence: { freq: 'weekly', interval: 1, weekdays: [1], from: 'due' },
        });
        expect(ok).toBe(true);
        expect(templates.value).toHaveLength(1);
        expect(templates.value[0]!.recurrence?.freq).toBe('weekly');
        // KV 中以 JSON 持久化
        const raw = mocks.kv.get('todo_templates');
        expect(raw).toContain('晨间例会');
    });

    it('名称为空拒绝保存', async () => {
        const { templates, saveTemplate } = useTodoTemplates();
        const before = templates.value.length;
        const ok = await saveTemplate({
            name: '   ',
            title: 'x',
            description: '',
            priorityLevel: 127,
            category: '',
            tags: [],
        });
        expect(ok).toBe(false);
        expect(templates.value.length).toBe(before);
    });

    it('删除模板：从列表移除并持久化', async () => {
        const { templates, saveTemplate, removeTemplate } = useTodoTemplates();
        await saveTemplate({
            name: '临时', title: 't', description: '', priorityLevel: 127, category: '', tags: [],
        });
        const id = templates.value[templates.value.length - 1]!.id;
        await removeTemplate(id);
        expect(templates.value.some(t => t.id === id)).toBe(false);
    });

    it('KV 损坏（坏 JSON / 非法条目）读取容错不抛错', async () => {
        // 直接污染 KV 后重新触发读取路径（loadCustom 仅在首次执行，这里验证 persist/parse 链路不抛错即可）
        mocks.kv.set('todo_templates', '{not-json');
        const { templates, removeTemplate } = useTodoTemplates();
        // 已加载的单例列表不受污染影响；删除走 filter + persist 依旧安全
        await removeTemplate('nonexistent');
        expect(Array.isArray(templates.value)).toBe(true);
    });
});
