import { vTip } from '~/src/utils/vTip';

/** 注册全局 v-tip 指令：统一 hover 提示气泡（替代原生 title） */
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.directive('tip', vTip);
});
