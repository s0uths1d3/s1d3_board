import { createBooleanSetting } from './useBooleanSetting';

/**
 * 失焦自动隐藏主窗口开关：主窗口失去焦点约 150ms 后自动隐藏（弹出式语义，
 * 通过快捷键 / 托盘再唤出）。关闭后主窗口保持显示，由用户手动收起
 * （标题栏 x / 托盘）。设置页「通用」与 app.vue 失焦钩子共用同一状态源。默认开启。
 */
const autoHideSetting = createBooleanSetting('auto_hide_enabled', true);

/** 设置页绑定：失焦自动隐藏开关（共享同一状态源） */
export function useAutoHide() {
  const autoHideEnabled = autoHideSetting.useSetting();
  return { autoHideEnabled };
}

/** 持久化失焦自动隐藏状态（设置页切换时调用） */
export async function setAutoHideEnabled(v: boolean): Promise<void> {
  await autoHideSetting.persist(v);
}

/** app.vue 失焦钩子同步读取：关闭时不自动隐藏 */
export function isAutoHideEnabled(): boolean {
  return autoHideSetting.enabled.value;
}

/** 触发首次加载（幂等）并等待落定：主窗口挂载时调用 */
export function ensureAutoHideLoaded(): Promise<void> {
  return autoHideSetting.ensureLoaded();
}
