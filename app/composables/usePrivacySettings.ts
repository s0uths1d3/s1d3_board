import { createBooleanSetting } from './useBooleanSetting';
import { bus } from '~/src/core/events';

/**
 * 隐私模式（暂停记录）：开启后剪贴板监听管道对文本 / 图片更新一律不处理
 * （不落库、不弹岛、不进智能切分）——应用对剪贴板「失明」，用于输入敏感内容场景。
 * 托盘菜单与设置页共用同一状态源。默认关闭。
 */
const privacySetting = createBooleanSetting('privacy_pause', false);

/**
 * 敏感内容防护：开启后命中敏感形态（银行卡号 / 验证码 / 密码）的文本不落库
 * （检测规则见 src/privacy/sensitive.ts）。默认开启。
 */
const sensitiveSetting = createBooleanSetting('sensitive_filter', true);

/** 设置页绑定：隐私模式开关（共享同一状态源） */
export function usePrivacyPause() {
  const privacyPaused = privacySetting.useSetting();
  return { privacyPaused };
}

/** 持久化隐私模式状态（设置页 / 托盘切换时调用）；派发开关变化事件供托盘重建勾选态 */
export async function setPrivacyPaused(v: boolean): Promise<void> {
  await privacySetting.persist(v);
  bus.emit('privacy-pause-changed');
}

/** 监听管道同步读取：隐私模式开启时不处理任何剪贴板更新 */
export function isPrivacyPaused(): boolean {
  return privacySetting.enabled.value;
}

/** 触发首次加载（幂等）并等待落定：监听启动 / 托盘菜单构建前调用 */
export function ensurePrivacyLoaded(): Promise<void> {
  return privacySetting.ensureLoaded();
}

/** 设置页绑定：敏感内容防护开关（共享同一状态源） */
export function useSensitiveFilter() {
  const sensitiveFilterEnabled = sensitiveSetting.useSetting();
  return { sensitiveFilterEnabled };
}

/** 持久化敏感防护状态（设置页切换时调用） */
export async function setSensitiveFilterEnabled(v: boolean): Promise<void> {
  await sensitiveSetting.persist(v);
}

/** 监听管道同步读取：敏感防护开启时对文本做敏感形态检测 */
export function isSensitiveFilterEnabled(): boolean {
  return sensitiveSetting.enabled.value;
}

/** 触发首次加载（幂等）并等待落定 */
export function ensureSensitiveFilterLoaded(): Promise<void> {
  return sensitiveSetting.ensureLoaded();
}
