/**
 * 统一的日期/时间处理工具（单一事实来源）。
 *
 * 此前本地时区 YYYY-MM-DD 格式化在 statsService / StatsPage / mockData 等多处逐字重复，
 * 任何时区或补零规则修改都要改三处；解析逻辑散布在 15+ 处且时区语义不统一
 * （date-only 字符串按 UTC 解析、datetime-local 按本地时区解析）。
 * 新的日期处理逻辑一律加在这里，不要在调用方手写。
 */

/** 本地时区 YYYY-MM-DD（统计日期口径：一天一行 daily_stat 的主键格式） */
export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地时区 YYYY-MM-DDTHH:mm（与 datetime-local 输入框、todo.dueDate 同格式） */
export function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 解析本地日期时间字符串为毫秒时间戳；非法返回 NaN（由调用方守卫）。
 * 统一按"本地时区"语义解析：
 * - YYYY-MM-DDTHH:mm（datetime-local）→ 本地时区（与浏览器默认一致）；
 * - YYYY-MM-DD（date-only）→ 显式按本地时区的当日 00:00 解析，
 *   规避规范中 date-only 按 UTC 解析导致的东八区 8 小时偏移。
 */
export function parseLocalDateTime(s?: string | null): number {
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00`).getTime();
  }
  return new Date(s).getTime();
}
