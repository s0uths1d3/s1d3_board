import { describe, expect, it } from 'vitest';
import { lunarDayInfo, solarToLunar, solarTermOf } from '../lunar';

/**
 * 农历工具锚点测试：春节/中秋/元宵/端午/七夕采用公认权威日期（与
 * festival-eggs 映射表同一批日期交叉验证），用于校验压缩位表与换算算法。
 */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe('solarToLunar 权威锚点', () => {
  // 春节（正月初一）2020-2030，含闰月年 2020/2023/2025/2028
  const chunjie: Array<[number, number, number]> = [
    [2020, 1, 25], [2021, 2, 12], [2022, 2, 1], [2023, 1, 22], [2024, 2, 10],
    [2025, 1, 29], [2026, 2, 17], [2027, 2, 6], [2028, 1, 26], [2029, 2, 13], [2030, 2, 3],
  ];
  it.each(chunjie)('%i-%i-%i 是正月初一（春节）', (y, m, day) => {
    expect(solarToLunar(d(y, m, day))).toEqual({ year: y, month: 1, day: 1, isLeapMonth: false });
  });

  // 中秋（八月十五）2020-2030
  const midautumn: Array<[number, number, number]> = [
    [2020, 10, 1], [2021, 9, 21], [2022, 9, 10], [2023, 9, 29], [2024, 9, 17],
    [2025, 10, 6], [2026, 9, 25], [2027, 9, 15], [2028, 10, 3], [2029, 9, 22], [2030, 9, 12],
  ];
  it.each(midautumn)('%i-%i-%i 是八月十五（中秋）', (y, m, day) => {
    const lunar = solarToLunar(d(y, m, day));
    expect(lunar).toMatchObject({ month: 8, day: 15, isLeapMonth: false });
  });

  // 端午（五月初五）：2028 闰五月年验证取第一个五月
  it.each([
    [2026, 6, 19], [2027, 6, 9], [2028, 5, 28], [2029, 6, 16], [2030, 6, 5],
  ])('%i-%i-%i 是五月初五（端午）', (y, m, day) => {
    expect(solarToLunar(d(y, m, day))).toMatchObject({ month: 5, day: 5, isLeapMonth: false });
  });

  // 元宵（正月十五）
  it.each([
    [2026, 3, 3], [2027, 2, 20], [2028, 2, 9], [2029, 2, 27], [2030, 2, 17],
  ])('%i-%i-%i 是正月十五（元宵）', (y, m, day) => {
    expect(solarToLunar(d(y, m, day))).toMatchObject({ month: 1, day: 15, isLeapMonth: false });
  });

  it('闰月标记：2025 闰六月内日期 isLeapMonth 为 true', () => {
    // 2025 闰六月初一之前必有连续六月：取 2025-07-25（闰六月初一附近窗口）扫描确认存在闰月日
    let hasLeap = false;
    for (let day = 1; day <= 31; day++) {
      const lunar = solarToLunar(d(2025, 7, day));
      if (lunar?.isLeapMonth && lunar.month === 6) hasLeap = true;
    }
    expect(hasLeap).toBe(true);
  });
});

describe('lunarDayInfo 节日与显示', () => {
  it('2026-02-16 是除夕（次日为正月初一）', () => {
    expect(lunarDayInfo(d(2026, 2, 16))?.festival).toBe('除夕');
  });
  it('2026-02-17 显示春节', () => {
    const info = lunarDayInfo(d(2026, 2, 17));
    expect(info?.festival).toBe('春节');
    expect(info?.lunarText).toBe('正月');
  });
  it('2026-09-25 显示中秋节', () => {
    expect(lunarDayInfo(d(2026, 9, 25))?.festival).toBe('中秋节');
  });
  it('公历节日：元旦/国庆', () => {
    expect(lunarDayInfo(d(2026, 1, 1))?.festival).toBe('元旦');
    expect(lunarDayInfo(d(2026, 10, 1))?.festival).toBe('国庆节');
  });
  it('初一显示月名、非初一显示日名', () => {
    expect(lunarDayInfo(d(2026, 2, 17))?.lunarText).toBe('正月');
    expect(lunarDayInfo(d(2026, 2, 21))?.lunarText).toBe('初五');
  });
  it('表范围外返回 null（表覆盖至农历 2049 年末，约公历 2050 年 2 月）', () => {
    expect(solarToLunar(d(2020, 1, 24))).toBeNull();
    expect(solarToLunar(d(2050, 3, 1))).toBeNull();
    expect(lunarDayInfo(d(2050, 3, 1))).toBeNull();
  });
  it('2026 全年逐日换算合法（月 1-12、日 1-30）', () => {
    for (let day = 1; day <= 365; day++) {
      const lunar = solarToLunar(new Date(2026, 0, day));
      expect(lunar).not.toBeNull();
      expect(lunar!.month).toBeGreaterThanOrEqual(1);
      expect(lunar!.month).toBeLessThanOrEqual(12);
      expect(lunar!.day).toBeGreaterThanOrEqual(1);
      expect(lunar!.day).toBeLessThanOrEqual(30);
    }
  });
});

describe('solarTermOf 节气', () => {
  it('2026 年 4 月上旬恰有一天清明', () => {
    const hits = [3, 4, 5, 6, 7].filter(day => solarTermOf(d(2026, 4, day)) === '清明');
    expect(hits).toHaveLength(1);
  });
  it('2026 年 12 月下旬恰有一天冬至', () => {
    const hits = [21, 22, 23].filter(day => solarTermOf(d(2026, 12, day)) === '冬至');
    expect(hits).toHaveLength(1);
  });
  it('非节气日返回空串', () => {
    expect(solarTermOf(d(2026, 4, 10))).toBe('');
  });
});
