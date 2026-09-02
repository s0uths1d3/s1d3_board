import { defineNuxtPlugin } from '#app';
import { initI18n } from '~/composables/useI18n';

/**
 * i18n 初始化：在应用挂载前完成语言探测与持久化读取，
 * 保证首帧文案即为正确语言（首次按系统语言，之后按用户设置）。
 * 主窗口与子窗口（tooltip/viewer）都会执行，各自得到正确语言；
 * 切换语言的跨窗口同步由 useI18n 的事件监听完成。
 */
export default defineNuxtPlugin(async () => {
  await initI18n();
});
