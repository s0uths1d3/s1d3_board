import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 自然语言录入（todoNlp）单测：
 * AI 客户端 mock 掉（不依赖真实网络/凭据），验证配置校验、响应容错与字段白名单化。
 */
const mocks = vi.hoisted(() => ({
    aiComplete: vi.fn(),
    loadAiConfig: vi.fn(),
}));

vi.mock('../../smart-clip/aiClient', () => ({
    aiComplete: mocks.aiComplete,
    loadAiConfig: mocks.loadAiConfig,
}));

import {
    parseTodoFromText,
    NLP_ERR_NOT_CONFIGURED,
    NLP_ERR_BAD_RESPONSE,
} from '../todoNlp';

const CONFIGURED = { provider: 'openai-compat', baseUrl: 'https://api.test', apiKey: 'sk-x', model: 'gpt-x' };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAiConfig.mockResolvedValue(CONFIGURED);
    mocks.aiComplete.mockResolvedValue('');
});

describe('parseTodoFromText 自然语言解析', () => {
    it('未配置 AI（缺 apiKey/baseUrl）抛 NLP_ERR_NOT_CONFIGURED', async () => {
        mocks.loadAiConfig.mockResolvedValue({ ...CONFIGURED, apiKey: '' });
        await expect(parseTodoFromText('明天下午三点开会')).rejects.toThrow(NLP_ERR_NOT_CONFIGURED);
        expect(mocks.aiComplete).not.toHaveBeenCalled();
    });

    it('正常解析：JSON 围栏剥离 + 字段白名单化回填', async () => {
        mocks.aiComplete.mockResolvedValue(
            '```json\n{"title":"写周报","description":"汇总本周进展","dueDate":"2026-10-12T15:00","priorityLevel":300,"category":"工作","tags":["周报","周报",""]}\n```',
        );
        const r = await parseTodoFromText('下周一写周报', { categories: ['工作', '学习'] });
        expect(r).toEqual({
            title: '写周报',
            description: '汇总本周进展',
            dueDate: '2026-10-12T15:00',
            priorityLevel: 255,
            category: '工作',
            tags: ['周报'],
        });
    });

    it('dueDate 容错：日期-only 补 09:00，非法丢弃为空串', async () => {
        mocks.aiComplete.mockResolvedValue(
            JSON.stringify({ title: '买菜', dueDate: '2026-10-11', priorityLevel: 'abc', tags: [] }),
        );
        const r = await parseTodoFromText('明天买菜');
        expect(r.dueDate).toBe('2026-10-11T09:00');
        expect(r.priorityLevel).toBe(127);
    });

    it('未命中分类丢弃（保持表单默认），标签去重上限 8', async () => {
        mocks.aiComplete.mockResolvedValue(
            JSON.stringify({ title: '整理', category: '不存在的分类', tags: ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }),
        );
        const r = await parseTodoFromText('整理房间', { categories: ['工作'] });
        expect(r.category).toBe('');
        expect(r.tags).toHaveLength(8);
    });

    it('响应无标题（whitelist 拒绝）抛 NLP_ERR_BAD_RESPONSE', async () => {
        mocks.aiComplete.mockResolvedValue('{"description":"没有标题"}');
        await expect(parseTodoFromText('随便说点什么')).rejects.toThrow(NLP_ERR_BAD_RESPONSE);
    });

    it('响应含噪声（前后文本）时截取大括号内容解析', async () => {
        mocks.aiComplete.mockResolvedValue('好的，解析结果如下：{"title":"跑步"} 以上。');
        const r = await parseTodoFromText('去跑步');
        expect(r.title).toBe('跑步');
    });

    it('底层错误透传（网络/鉴权等）', async () => {
        mocks.aiComplete.mockRejectedValue(new Error('HTTP 401'));
        await expect(parseTodoFromText('测试')).rejects.toThrow('HTTP 401');
    });

    it('空输入直接抛 NLP_ERR_BAD_RESPONSE（不发请求）', async () => {
        await expect(parseTodoFromText('   ')).rejects.toThrow(NLP_ERR_BAD_RESPONSE);
        expect(mocks.aiComplete).not.toHaveBeenCalled();
    });
});
