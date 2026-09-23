import { describe, expect, it } from 'vitest';
import {
    buildStoryFacts, computeInsightIds, pickDailyInsights,
    type StorySeriesRow,
} from '../story';
import type { StatsSummary } from '../../statistics/statsService';

/** 快捷构造聚合结果 */
function stats(partial: Partial<Record<string, number>>): StatsSummary {
    return { ...partial } as StatsSummary;
}

function series(rows: [string, number][]): StorySeriesRow[] {
    return rows.map(([stat_date, value]) => ({ stat_date, value }));
}

// ---------------------------------------------------------------------------
// buildStoryFacts：叙事事实
// ---------------------------------------------------------------------------
describe('buildStoryFacts', () => {
    it('主力 Tab 取访问量最高者', () => {
        const f = buildStoryFacts(stats({ tab_clip: 5, tab_todo: 2, tab_note: 9 }), []);
        expect(f.topTab).toBe('note');
    });

    it('全部 Tab 无访问时 topTab 为 null', () => {
        expect(buildStoryFacts(stats({}), []).topTab).toBeNull();
    });

    it('峰值日取序列中值最大者，全零时为 null', () => {
        const f = buildStoryFacts(stats({}), series([['2026-09-01', 3], ['2026-09-02', 8], ['2026-09-03', 1]]));
        expect(f.topDay).toEqual({ date: '2026-09-02', value: 8 });
        expect(buildStoryFacts(stats({}), series([['2026-09-01', 0]])).topDay).toBeNull();
    });

    it('字量换算 A4 纸（每页 500 字，向上取整）', () => {
        expect(buildStoryFacts(stats({ clip_chars: 1200 }), []).a4Pages).toBe(3);
        expect(buildStoryFacts(stats({ clip_chars: 1000 }), []).a4Pages).toBe(2);
    });

    it('粘贴占比 = clip_use / (clip_use + 剪贴总量)', () => {
        const f = buildStoryFacts(stats({ clip_use: 30, clip_text: 50, clip_image: 20 }), []);
        expect(f.pasteRatio).toBeCloseTo(0.3);
    });
});

// ---------------------------------------------------------------------------
// computeInsightIds：洞察规则
// ---------------------------------------------------------------------------
describe('computeInsightIds', () => {
    it('空数据只返回兜底洞察', () => {
        const ids = computeInsightIds({ stats: stats({}), days: 0, spanDays: 10, longestStreak: 0 });
        expect(ids).toEqual(['insight_keep']);
    });

    it('深夜占比超 30% 命中 insight_night', () => {
        const ids = computeInsightIds({
            stats: stats({ active_night: 4, active_day: 6 }),
            days: 5, spanDays: 10, longestStreak: 2,
        });
        expect(ids).toContain('insight_night');
        expect(ids).not.toContain('insight_dawn');
    });

    it('待办完成率过半命中 insight_todo（未用过待办则不命中）', () => {
        const base = { days: 5, spanDays: 10, longestStreak: 2 };
        const used = computeInsightIds({ stats: stats({ todo_added: 10, todo_completed: 6 }), ...base });
        expect(used).toContain('insight_todo');
        const unused = computeInsightIds({ stats: stats({ todo_completed: 6 }), ...base });
        expect(unused).not.toContain('insight_todo');
    });

    it('连续活跃达标命中 insight_streak，兜底始终存在', () => {
        const ids = computeInsightIds({ stats: stats({}), days: 7, spanDays: 10, longestStreak: 8 });
        expect(ids).toContain('insight_streak');
        expect(ids).toContain('insight_keep');
    });
});

// ---------------------------------------------------------------------------
// pickDailyInsights：每日轮换（确定性）
// ---------------------------------------------------------------------------
describe('pickDailyInsights', () => {
    const ids = ['insight_night', 'insight_paste', 'insight_text', 'insight_ai', 'insight_keep'];

    it('同一天同输入结果稳定', () => {
        expect(pickDailyInsights(ids, '2026-09-23', 2)).toEqual(pickDailyInsights(ids, '2026-09-23', 2));
    });

    it('不同日期种子可能产生不同选择', () => {
        // 大样本下至少存在两个日期挑出不同组合（非严格断言单一差异）
        const picks = new Set(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']
            .map(d => pickDailyInsights(ids, d, 2).slice(0, 2).join('|')));
        expect(picks.size).toBeGreaterThan(1);
    });

    it('命中数不足 n 时全量返回；兜底洞察保持末位', () => {
        expect(pickDailyInsights(['insight_keep'], '2026-09-23', 2)).toEqual(['insight_keep']);
        const picked = pickDailyInsights(['insight_night', 'insight_keep'], '2026-09-23', 2);
        expect(picked[picked.length - 1]).toBe('insight_keep');
    });

    it('返回条数不超过 n', () => {
        expect(pickDailyInsights(ids, '2026-09-23', 2)).toHaveLength(2);
    });
});
