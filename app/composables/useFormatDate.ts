import { formatDate as baseFormatDate } from '~/utils/formatDate';
import { useI18n } from '~/composables/useI18n';

/**
 * 带 locale 的 formatDate 包装：跟随 useI18n 当前语言
 *  切语言触发 reloadNuxtApp 后 setup 重新执行，formatDateLocalized 重新绑定到新 locale
 */
export function useFormatDate() {
    const { locale } = useI18n();
    return (value: number | string) => baseFormatDate(value, locale.value);
}

export { formatDate } from '~/utils/formatDate';
