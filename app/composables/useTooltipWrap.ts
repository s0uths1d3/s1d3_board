import { createBooleanSetting } from './useBooleanSetting';

/**
 * 剪贴板预览（tooltip）换行开关：控制 tooltip 文本是否自动折行。
 * 默认关闭——每行保持原始单行，超宽内容由预览容器横向滚动查看；
 * 开启后长行自动折行（宽度上限不变，均为 460px）。
 * 主窗口 hover 构造事件载荷时读取，随 tooltip:show 传给子窗口（子窗口零 DB 依赖）。
 */
const setting = createBooleanSetting('tooltip_wrap', false);

/** 设置页绑定：tooltip 换行开关（共享同一状态源） */
export function useTooltipWrap() {
  const tooltipWrapEnabled = setting.useSetting();
  return { tooltipWrapEnabled };
}

/** 持久化开关状态（设置页切换时调用） */
export async function setTooltipWrapEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}

/** 主窗口构造 tooltip 载荷时同步读取当前开关（默认不换行） */
export function isTooltipWrapEnabled(): boolean {
  return setting.enabled.value;
}
