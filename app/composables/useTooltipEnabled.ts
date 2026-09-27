import { createBooleanSetting } from './useBooleanSetting';
import { getAllWindows } from '@tauri-apps/api/window';
import { isTauri } from '~/utils/env';

/** 是否开启悬停提示窗口（tooltip 独立窗口）；持久化到 settings 表 */
const setting = createBooleanSetting('tooltip_enabled', true);

export function useTooltipEnabled() {
  const tooltipEnabled = setting.useSetting();
  return { tooltipEnabled };
}

export async function setTooltipEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}

/**
 * 关闭所有 tooltip 子窗口并复位主窗口侧激活标志（__tooltipActive）。
 * 在主窗口任何「主动隐藏」路径（托盘收起 / Ctrl+I / Esc 隐藏）与失焦自动隐藏的
 * 「焦点切到外部应用」分支中调用，修复主窗口已隐藏但 tooltip 仍置顶残留的问题。
 * 用 close 而非 hide：父窗口隐藏期间独立 WebView 子窗口会被系统挂起、事件通道失效，
 * 仅 hide 保留单例会导致下次 hover 无法再弹出 tooltip（需重建鲜活窗口）。
 */
export async function closeTooltipWindows(): Promise<void> {
  if (!isTauri()) return;
  try {
    for (const w of await getAllWindows()) {
      if (w.label.startsWith('tooltip-')) await w.close().catch(() => {});
    }
  } catch { /* 枚举失败按无 tooltip 处理 */ }
  // 主窗口各模块同处一个 webview context：直接复位激活标志；
  // index.vue 的 tooltipLabel 单例残留由 openTooltipWindow 的 getByLabel 兜底置空
  (window as any).__tooltipActive = false;
}
