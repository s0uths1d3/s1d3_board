import { ref, watch, onBeforeUnmount, type Ref } from 'vue';

/**
 * 数字滚动动画（指标卡 count-up）
 *
 * 监听 source 数值变化，用 rAF 从当前显示值补间到新值（ease-out cubic）：
 * - 首次挂载从 0 滚到目标值，范围切换时从旧值滚到新值，天然重触发；
 * - prefers-reduced-motion 环境直接赋值不动画；
 * - 组件卸载时取消未完成的动画帧。
 */
export function useCountUp(source: () => number, duration = 600): Ref<number> {
  const display = ref(0);
  let rafId = 0;

  function cancel() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  watch(source, (target) => {
    cancel();
    // 无障碍：用户偏好减少动效时直接赋值
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      display.value = target;
      return;
    }
    const from = display.value;
    const delta = target - from;
    if (delta === 0) return;
    // 极大跨度或非有限值不做补间，直接落值防长动画
    if (!Number.isFinite(delta) || Math.abs(delta) > 1e9) {
      display.value = target;
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      display.value = from + delta * eased;
      if (p < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        display.value = target;
        rafId = 0;
      }
    };
    rafId = requestAnimationFrame(tick);
  }, { immediate: true });

  onBeforeUnmount(cancel);
  return display;
}
