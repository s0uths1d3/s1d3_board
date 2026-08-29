import { createBooleanSetting } from './useBooleanSetting';

/** 是否开启搜索命中高亮（列表/卡片通用）；持久化到 settings 表 */
const setting = createBooleanSetting('search_highlight_enabled', true);

export function useSearchHighlight() {
  const searchHighlightEnabled = setting.useSetting();
  return { searchHighlightEnabled };
}

export async function setSearchHighlightEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}
