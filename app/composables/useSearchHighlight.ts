import { ref } from 'vue';
import dbService from '~/src/db/dbService';

/** 搜索是否高亮匹配：全局开关，所有搜索框（便签 / 主剪贴板 / 待办等）共用，默认开启 */
const searchHighlightEnabled = ref(true);
let loaded = false;

export function useSearchHighlight() {
  if (!loaded) {
    loaded = true;
    dbService.getKeyValue('search_highlight_enabled').then((v) => {
      if (v !== null && v !== undefined && v !== '') searchHighlightEnabled.value = v === '1';
    }).catch(() => { /* 未设置过则保持默认开启 */ });
  }
  return { searchHighlightEnabled };
}
