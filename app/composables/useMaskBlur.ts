import { ref } from 'vue';
import { isTauri } from '~/utils/env';
import dbService from '~/src/db/dbService';

/**
 * 蒙版模糊度设置（模态浮层蒙层的背景模糊强度，全局搜索面板等消费）：
 * 0~1，默认 1（≈4px 轻模糊，与原 backdrop-blur-sm 一致）；0 = 关闭模糊。
 * 存取模式与 useIslandTiming 一致：模块级 ref + KV 持久化 + 钳制。
 * 注意：值 > 0 时蒙层带 backdrop-filter，与页面内 glass-card 嵌套时 Chromium
 * 可能出现局部过亮的合成怪癖——遇到时可将模糊度调 0 规避（蒙层为纯半透明黑）。
 */

export const MASK_BLUR_DEFAULT = 1;
const MASK_BLUR_KEY = 'mask_blur';

const maskBlur = ref(MASK_BLUR_DEFAULT);

/** 钳制到 0~1 并保留一位小数（非法输入回落默认值） */
function sanitize(v: number): number {
  if (!Number.isFinite(v)) return MASK_BLUR_DEFAULT;
  return Math.min(1, Math.max(0, Math.round(v * 10) / 10));
}

let loadPromise: Promise<void> | null = null;

/** 触发首次加载（幂等）并等待落定：resolve 后 ref 即真实持久化值 */
export function ensureMaskBlurLoaded(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = dbService.getKeyValue(MASK_BLUR_KEY).catch(() => null).then((v) => {
      if (v && v.trim()) maskBlur.value = sanitize(Number(v));
    });
  }
  return loadPromise;
}

/** 设置蒙版模糊度（0~1，自动钳制）并持久化（设置页调用） */
export async function setMaskBlur(v: number): Promise<void> {
  maskBlur.value = sanitize(v);
  try { await dbService.setKeyValue(MASK_BLUR_KEY, String(maskBlur.value)); } catch { /* 写入失败不影响本次会话 */ }
}

export function useMaskBlur() {
  ensureMaskBlurLoaded();
  return { maskBlur };
}

/** 蒙层模糊半径（px）：强度 × 4px，0 = 无模糊（蒙层保持纯半透明黑） */
export function maskBlurPx(v: number): number {
  return Math.round(v * 4);
}
