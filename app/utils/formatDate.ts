import { messages, type AppLocale } from '~/i18n/messages';

/**
 * 相对时间格式化（i18n）：把毫秒时间戳格式化为本地化的"刚刚 / X秒前 / …"或月-日/年-月-日。
 *
 * @param value - 毫秒时间戳（number）或可被 Date 解析的日期字符串；
 *                内部统一归一化，调用方无需再自行 parseInt
 * @param locale - 目标语言；默认 'zh-cn'（保持原有中文行为，向后兼容）
 * @returns 格式化后的时间字符串；无效输入返回对应语言的"无效日期"
 */
const formatDate = (value: number | string, locale: AppLocale = 'zh-cn'): string => {
    const now = new Date();
    const tm = (messages[locale] as Record<string, unknown>).time as {
        justNow: string; secAgo: string; minAgo: string; hourAgo: string; dayAgo: string;
        md: string; ymd: string; invalid: string;
    };

    if (value === undefined || value === null || value === '') {
        return tm.invalid;
    }

    const formatTimeDifference = (milliseconds: number): string => {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (seconds < 10) return tm.justNow;
        if (seconds < 60) return tm.secAgo.replace('{n}', String(seconds));
        if (minutes < 60) return tm.minAgo.replace('{n}', String(minutes));
        if (hours < 24) return tm.hourAgo.replace('{n}', String(hours));
        if (days < 7) return tm.dayAgo.replace('{n}', String(days));

        const date = new Date(now.getTime() - milliseconds);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const currentYear = now.getFullYear();

        if (year === currentYear) {
            return tm.md.replace('{m}', String(month)).replace('{d}', String(day));
        }
        return tm.ymd
            .replace('{y}', String(year))
            .replace('{m}', String(month))
            .replace('{d}', String(day));
    };

    try {
        const ms = typeof value === 'number' ? value : Number(value);
        const currentDate = new Date(Number.isFinite(ms) && ms > 0 ? ms : value);

        if (isNaN(currentDate.getTime())) {
            return tm.invalid;
        }

        return formatTimeDifference(now.getTime() - currentDate.getTime());
    } catch (error) {
        console.error('日期格式化错误:', error);
        return tm.invalid;
    }
};

export { formatDate };