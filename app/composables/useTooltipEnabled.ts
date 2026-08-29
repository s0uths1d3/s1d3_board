import { createBooleanSetting } from './useBooleanSetting';

/** 是否开启悬停提示窗口（tooltip 独立窗口）；持久化到 settings 表 */
const setting = createBooleanSetting('tooltip_enabled', true);

export function useTooltipEnabled() {
  const tooltipEnabled = setting.useSetting();
  return { tooltipEnabled };
}

export async function setTooltipEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}
