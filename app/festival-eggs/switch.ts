import { createBooleanSetting } from '~/composables/useBooleanSetting';

/**
 * 节日彩蛋总开关：settings 表 KV `festival_egg_enabled`（默认开）。
 * 关闭后所有节日效果消失（岛换装/徽章/面板装饰/台词/主窗口点缀）；
 * s1d3 内容彩蛋不属于节日体系，不受本开关影响。
 *
 * 跨窗口同步模型：岛窗口（独立 webview）的模块级 ref 不会随主窗口设置页更新，
 * 由岛侧弹岛前调用 reloadFestivalEggSwitch() 重读持久化值（弹岛间隔即刷新时机，
 * 岛仅弹岛期间可见，显示中翻转开关无感知必要）。
 */
const setting = createBooleanSetting('festival_egg_enabled', true);

/** 内部消费（state.ts / island hook）：拿 setting 本体（enabled/ensureLoaded/reload） */
export function useFestivalEggSwitch() {
  return setting;
}

/** 设置页绑定：响应式布尔值（首次调用触发异步加载） */
export function useFestivalEggEnabled() {
  return { festivalEggEnabled: setting.useSetting() };
}

/** 设置页写入：更新 ref 并持久化（主窗口内所有 computed 即时响应） */
export async function setFestivalEggEnabled(v: boolean): Promise<void> {
  await setting.persist(v);
}

/** 岛窗口弹岛前刷新缓存：绕过 once 守卫重读持久化值 */
export function reloadFestivalEggSwitch(): Promise<void> {
  return setting.reload();
}
