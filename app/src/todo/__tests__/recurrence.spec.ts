import { describe, expect, it } from 'vitest';
import { nextDueDate } from '../recurrence';
import type { TodoRecurrence } from '../../entities';

/** 2026-03-02/09/16/23/30 均为周一（本地时区构造，与实现同口径比较） */
describe('nextDueDate（循环任务下一期推算）', () => {
    const ts = (dateText: string) => new Date(dateText).getTime();

    it('daily：from=due 按截止顺延，保留原时刻', () => {
        expect(nextDueDate('2026-03-15T09:30', { freq: 'daily', interval: 1, from: 'due' }, ts('2026-03-15T18:00')))
            .toBe('2026-03-16T09:30');
    });

    it('daily：from=complete 按完成时刻起算，时刻仍保留 due 的时分（日程节奏不变）', () => {
        expect(nextDueDate('2026-03-15T09:30', { freq: 'daily', interval: 3, from: 'complete' }, ts('2026-03-17T14:00')))
            .toBe('2026-03-20T09:30');
    });

    it('weekly weekdays：取晚于基准的下一个命中日', () => {
        // 周一截止 → 下一个命中周三
        expect(nextDueDate('2026-03-16T10:00', { freq: 'weekly', interval: 1, weekdays: [1, 3], from: 'due' }, ts('2026-03-16T11:00')))
            .toBe('2026-03-18T10:00');
        // 周三截止 → 下一个命中下周一
        expect(nextDueDate('2026-03-18T10:00', { freq: 'weekly', interval: 1, weekdays: [1, 3], from: 'due' }, ts('2026-03-18T11:00')))
            .toBe('2026-03-23T10:00');
    });

    it('weekly：无 weekdays 等价 +interval 周', () => {
        expect(nextDueDate('2026-03-16T10:00', { freq: 'weekly', interval: 2, from: 'due' }, ts('2026-03-16T11:00')))
            .toBe('2026-03-30T10:00');
    });

    it('monthly monthDay：跨大小时钳制到目标月最后一天（1/31 → 2/28）', () => {
        expect(nextDueDate('2026-01-31T09:00', { freq: 'monthly', interval: 1, monthDay: 31, from: 'due' }, ts('2026-01-31T10:00')))
            .toBe('2026-02-28T09:00');
        // 钳制不沉淀：下个月仍按规则日推算（2/28 起算 3/31 而非 3/28）
        expect(nextDueDate('2026-02-28T09:00', { freq: 'monthly', interval: 1, monthDay: 31, from: 'due' }, ts('2026-02-28T10:00')))
            .toBe('2026-03-31T09:00');
    });

    it('monthly：无 monthDay 时按基准日叠加', () => {
        expect(nextDueDate('2026-03-15T08:00', { freq: 'monthly', interval: 1, from: 'due' }, ts('2026-03-15T09:00')))
            .toBe('2026-04-15T08:00');
    });

    it('yearly：闰日 2/29 → 平年钳制 2/28', () => {
        expect(nextDueDate('2028-02-29T08:00', { freq: 'yearly', interval: 1, from: 'due' }, ts('2028-02-29T09:00')))
            .toBe('2029-02-28T08:00');
    });

    it('from=complete + monthly：基准为完成时刻', () => {
        // 完成于 3/5 → 下一期 4/5
        expect(nextDueDate('2026-03-05T08:00', { freq: 'monthly', interval: 1, from: 'complete' }, ts('2026-03-05T22:00')))
            .toBe('2026-04-05T08:00');
    });

    it('due 非法时回退按完成时刻起算', () => {
        expect(nextDueDate('not-a-date', { freq: 'daily', interval: 1, from: 'due' }, ts('2026-03-15T09:30')))
            .toBe('2026-03-16T09:30');
    });
});
