import { ref } from 'vue';
import dbService from '~/src/db/dbService';

/** 是否开启悬停提示窗口（tooltip）。单例 ref，设置页与主窗口共享，关闭后悬停不再弹出提示 */
const tooltipEnabled = ref(true);
let loaded = false;

export function useTooltipEnabled() {
  if (!loaded) {
    loaded = true;
    dbService.getKeyValue('tooltip_enabled').then((v) => {
      if (v !== null && v !== undefined && v !== '') tooltipEnabled.value = v === '1';
    }).catch(() => { /* 未设置过则保持默认开启 */ });
  }
  return { tooltipEnabled };
}
