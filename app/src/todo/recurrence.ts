import type { TodoRecurrence } from '../entities';

/**
 * 循环/重复任务的下一期截止时间推算（纯函数，无副作用）。
 *
 * 规则语义：
 * - from='due'：以当前截止时间为基准顺延（固定日程，如「每周一开会」）；
 * - from='complete'：以完成时刻为基准计算（滚动节奏，如「每次打扫后隔 3 天再打扫」）；
 *   时分仍保留原截止时间的时刻，保持「几点做」的日程节奏不变。
 * - weekly 优先取 weekdays 中晚于基准的下一个命中日（基准当天不算，完成后生成的是
 *   「下一次」）；无命中则整体 +interval 周；
 * - monthly 按月叠加，日期钳制到目标月最后一天（1/31 → 2/28 而非进位到 3 月）；
 * - yearly 按年叠加，闰日 2/29 → 平年钳制为 2/28。
 */

/** 本地 ISO 文本（'YYYY-MM-DD' / 'YYYY-MM-DDTHH:mm[:ss]'）→ 本地 Date；非法返回 undefined */
function parseLocal(text: string): Date | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text.trim());
    if (!m) return undefined;
    const d = new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
    );
    return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 本地 Date → 'YYYY-MM-DDTHH:mm'（与 dueDate 存储格式一致） */
function formatLocal(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 目标年月的最后一天（m0: 0-11） */
function daysInMonth(y: number, m0: number): number {
    return new Date(y, m0 + 1, 0).getDate();
}

function addDays(base: Date, days: number): Date {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
}

/** 加 N 个月并把日期钳制到目标月最后一天：先落 1 号再 setDate，避免 JS Date 月末自动进位 */
function addMonthsClamped(base: Date, months: number, day: number): Date {
    const d = new Date(base.getFullYear(), base.getMonth() + months, 1);
    d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
    return d;
}

/** 加 N 年：闰日 2/29 在平年钳制为 2/28 */
function addYearsClamped(base: Date, years: number): Date {
    const y = base.getFullYear() + years;
    const m = base.getMonth();
    return new Date(y, m, Math.min(base.getDate(), daysInMonth(y, m)));
}

/** weekly：从基准次日起找 weekdays 的下一个命中日（最多扫 interval 周），无命中兜底 +interval 周 */
function nextWeekly(base: Date, rule: TodoRecurrence): Date {
    const interval = Math.max(1, rule.interval);
    if (rule.weekdays && rule.weekdays.length > 0) {
        for (let i = 1; i <= 7 * interval; i++) {
            const d = addDays(base, i);
            if (rule.weekdays.includes(d.getDay())) return d;
        }
    }
    return addDays(base, 7 * interval);
}

/**
 * 计算循环任务的下一期截止时间。
 * @param due 当前一期截止时间（'YYYY-MM-DDTHH:mm'；非法时回退用完成时刻起算）
 * @param rule 循环规则（仓储层已白名单化）
 * @param completedAt 完成时刻（毫秒时间戳）
 */
export function nextDueDate(due: string, rule: TodoRecurrence, completedAt: number): string {
    const dueDate = parseLocal(due);
    const base = rule.from === 'complete' || !dueDate ? new Date(completedAt) : dueDate;
    // 时刻部分：有合法 due 保留其时分（固定日程「几点做」不变）；无 due 用基准时刻
    const keepTime = dueDate ?? base;

    let next: Date;
    switch (rule.freq) {
        case 'daily':
            next = addDays(base, Math.max(1, rule.interval));
            break;
        case 'weekly':
            next = nextWeekly(base, rule);
            break;
        case 'monthly':
            next = addMonthsClamped(base, Math.max(1, rule.interval), rule.monthDay ?? base.getDate());
            break;
        case 'yearly':
            next = addYearsClamped(base, Math.max(1, rule.interval));
            break;
    }
    next.setHours(keepTime.getHours(), keepTime.getMinutes(), 0, 0);
    return formatLocal(next);
}

/**
 * 循环规则摘要文案（卡片徽章 / 选择器按钮 / 日历 tooltip 共用）。
 * @param t i18n 翻译函数（useI18n 注入，签名与其对齐：值为 string|number）
 */
export function describeRecurrence(
    rule: TodoRecurrence,
    t: (key: string, params?: Record<string, string | number>) => string,
): string {
    const n = Math.max(1, Math.round(rule.interval) || 1);
    switch (rule.freq) {
        case 'daily':
            return t(n === 1 ? 'todo.rec_daily' : 'todo.rec_daily_n', { n });
        case 'weekly': {
            if (rule.weekdays?.length) {
                const days = rule.weekdays.map(d => t(`todo.day_${d}`)).join(t('todo.day_join'));
                return n === 1
                    ? t('todo.rec_weekly_days', { days })
                    : t('todo.rec_weekly_days_n', { n, days });
            }
            return t(n === 1 ? 'todo.rec_weekly' : 'todo.rec_weekly_n', { n });
        }
        case 'monthly': {
            const label = t(n === 1 ? 'todo.rec_monthly' : 'todo.rec_monthly_n', { n });
            return rule.monthDay ? label + t('todo.rec_on_day', { day: rule.monthDay }) : label;
        }
        case 'yearly':
            return t(n === 1 ? 'todo.rec_yearly' : 'todo.rec_yearly_n', { n });
    }
}
