/**
 * 农历工具（待办日历视图用）：公历 → 农历日期 / 节气 / 传统与公历节日。
 * - 农历换算：经典压缩位表（2020-2049，每年一整数编码闰月与大小月），
 *   基准日 2020-01-25（庚子年正月初一）；表范围外返回 null（日历格子退化为不显示农历行）；
 * - 节气：通用公式（以 1900 年小寒为锚的插值，北京时区精度 ±1 分钟内），
 *   非 UTC+8 环境可能偏移一天——日历展示场景可接受；
 * - 与 festival-eggs 模块的节日映射表互不依赖：那边是彩蛋判定（查表制），
 *   本文件是日期换算（算法制），测试锚点取公认日期交叉验证。
 */

/** 每年农历数据（2020-2049）：低 4 位 = 闰月月份（0 无闰）；bit16 = 闰月大小（1 为 30 天）；
 *  bit15..bit4 = 正月到腊月大小月（1 为 30 天大月） */
const LUNAR_INFO: readonly number[] = [
  // 2020-2029
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  // 2030-2039
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  // 2040-2049
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
];

const BASE_YEAR = 2020;
/** 基准日：2020-01-25 正月初一（用 UTC 日数差避免时区/夏令时噪声） */
const BASE_UTC = Date.UTC(2020, 0, 25);
const DAY_MS = 86400000;

const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function infoOf(year: number): number {
  // 调用方（solarToLunar）保证 year 在表范围内；越界防御性回退 0（无闰、全小月）
  return LUNAR_INFO[year - BASE_YEAR] ?? 0;
}
function leapMonthOf(year: number): number {
  return infoOf(year) & 0xf;
}
function leapDaysOf(year: number): number {
  return leapMonthOf(year) ? (infoOf(year) & 0x10000 ? 30 : 29) : 0;
}
/** 某农历月天数（month 1-12，不含闰月） */
function monthDaysOf(year: number, month: number): number {
  return infoOf(year) & (0x10000 >> month) ? 30 : 29;
}
/** 农历某年总天数（含闰月） */
function lunarYearDays(year: number): number {
  let days = 348;
  for (let m = 1; m <= 12; m++) if (infoOf(year) & (0x10000 >> m)) days++;
  return days + leapDaysOf(year);
}

export interface LunarDate {
  /** 农历年（公历年序号口径） */
  year: number;
  /** 农历月 1-12 */
  month: number;
  /** 农历日 1-30 */
  day: number;
  /** 是否闰月 */
  isLeapMonth: boolean;
}

/** 公历 → 农历；超出 2020-01-25 至 2049 年末表范围返回 null */
export function solarToLunar(date: Date): LunarDate | null {
  const offset = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - BASE_UTC) / DAY_MS);
  let year = BASE_YEAR;
  let remaining = offset;
  while (remaining >= 0) {
    const days = lunarYearDays(year);
    if (remaining < days) break;
    remaining -= days;
    year++;
    if (year >= BASE_YEAR + LUNAR_INFO.length) return null;
  }
  if (remaining < 0) return null;

  const leap = leapMonthOf(year);
  let month = 1;
  let isLeapMonth = false;
  let day = 1;
  for (;;) {
    // 闰月插在 leap 与 leap+1 之间：month === leap+1 且未消费闰月时先处理闰月
    const inLeapSlot = leap > 0 && month === leap + 1 && !isLeapMonth;
    const days = inLeapSlot ? leapDaysOf(year) : monthDaysOf(year, month);
    if (remaining < days) {
      day = remaining + 1;
      isLeapMonth = inLeapSlot;
      // 闰月日期返回闰月月号（如闰六月 month=6 + isLeapMonth），而非循环变量指向的下一个月
      if (inLeapSlot) month = leap;
      break;
    }
    remaining -= days;
    if (inLeapSlot) isLeapMonth = true;
    else month++;
  }
  return { year, month, day, isLeapMonth };
}

/** 农历日名：初一~初十 / 十一~十九 / 二十 / 廿一~廿九 / 三十 */
function lunarDayName(day: number): string {
  if (day === 10) return '初十';
  if (day === 20) return '二十';
  if (day === 30) return '三十';
  if (day < 10) return `初${DIGITS[day - 1]}`;
  if (day < 20) return `十${DIGITS[day - 11]}`;
  return `廿${DIGITS[day - 21]}`;
}

// ===== 节气：通用公式（锚 1900-01-06 02:05 + 每年相位 + 每节气分钟修正） =====
const TERM_INFO: readonly number[] = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
  263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
];
const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨',
  '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑',
  '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
] as const;

/** 当天节气名（无则空串）；每月固定两个节气（小寒起算） */
export function solarTermOf(date: Date): string {
  const idx = date.getMonth() * 2;
  const termDate = (n: number) => new Date(Date.UTC(1900, 0, 6, 2, 5) + 31556925974.7 * (date.getFullYear() - 1900) + (TERM_INFO[n] ?? 0) * 60000);
  for (const n of [idx, idx + 1]) {
    const d = termDate(n);
    if (d.getFullYear() === date.getFullYear() && d.getMonth() === date.getMonth() && d.getDate() === date.getDate()) {
      return TERM_NAMES[n] ?? '';
    }
  }
  return '';
}

/** 农历传统节日表（[月, 日] → 名，闰月不算） */
const LUNAR_FESTIVALS = new Map<string, string>([
  ['1-1', '春节'],
  ['1-15', '元宵节'],
  ['5-5', '端午节'],
  ['7-7', '七夕'],
  ['8-15', '中秋节'],
  ['9-9', '重阳节'],
  ['12-8', '腊八'],
]);
/** 公历节日表（[月, 日] → 名） */
const SOLAR_FESTIVALS = new Map<string, string>([
  ['1-1', '元旦'],
  ['5-1', '劳动节'],
  ['6-1', '儿童节'],
  ['10-1', '国庆节'],
]);

export interface LunarDayInfo {
  /** 农历显示文本：初一日显示月名（如「正月」「闰六月」），其余为日名（如「初五」） */
  lunarText: string;
  /** 节日名（农历传统节日 + 除夕 + 公历节日），无则空串 */
  festival: string;
  /** 当天节气名，无则空串 */
  term: string;
}

/** 日期格综合信息（农历行 + 节日 + 节气）；表范围外返回 null */
export function lunarDayInfo(date: Date): LunarDayInfo | null {
  const lunar = solarToLunar(date);
  if (!lunar) return null;

  let festival = '';
  if (!lunar.isLeapMonth) {
    festival = LUNAR_FESTIVALS.get(`${lunar.month}-${lunar.day}`) ?? '';
    // 除夕：农历日期不固定（腊月廿九/三十），次日是正月初一即除夕
    if (!festival) {
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
      const nextLunar = solarToLunar(next);
      if (nextLunar && !nextLunar.isLeapMonth && nextLunar.month === 1 && nextLunar.day === 1) festival = '除夕';
    }
  }
  if (!festival) festival = SOLAR_FESTIVALS.get(`${date.getMonth() + 1}-${date.getDate()}`) ?? '';

  return {
    lunarText: lunar.day === 1 ? `${lunar.isLeapMonth ? '闰' : ''}${MONTH_NAMES[lunar.month - 1]}月` : lunarDayName(lunar.day),
    festival,
    term: solarTermOf(date),
  };
}
