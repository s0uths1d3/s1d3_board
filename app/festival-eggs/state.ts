import { computed, ref } from 'vue';
import { currentFestival, festivalNow, type FestivalId } from './core';
import { useFestivalEggSwitch } from './switch';

/**
 * 响应式节日单例：裸节日 ref + 对齐零点的自续定时器。
 * 全部挂载点经 useFestivalEgg() 消费（叠加总开关门控），跨零点自动切换无需页面刷新。
 *
 * 激活模型：首个消费者触发幂等 install（加载开关缓存 + 启动 ticker）——
 * 岛窗口不引导 AppModule（registry 只在主窗口 boot），故不走路由/模块系统，
 * 用"自激活 composable"让主窗口与岛窗口共用同一套消费 API。
 */

/** 裸节日（未叠开关）：跨零点由 ticker 重算；岛窗口弹岛时另有 refresh 即时重算 */
const rawFestival = ref<FestivalId | null>(currentFestival(festivalNow()));

let installed = false;
let midnightTimer: ReturnType<typeof setTimeout> | null = null;

function refreshRaw(): void {
  rawFestival.value = currentFestival(festivalNow());
}

/** 对齐下一本地零点（+2s 容差）重算并自续；--time 注入时时间冻结在 12:00，重算恒定、定时器无害 */
function scheduleMidnightTick(): void {
  if (midnightTimer) clearTimeout(midnightTimer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  midnightTimer = setTimeout(() => {
    refreshRaw();
    scheduleMidnightTick();
  }, next.getTime() - now.getTime());
}

/** 幂等安装：首个消费者触发（读开关缓存 + 启动零点 ticker）；vitest 环境不启定时器 */
export function ensureFestivalEggInstalled(): void {
  if (installed) return;
  installed = true;
  void useFestivalEggSwitch().ensureLoaded();
  if (!import.meta.env.VITEST) scheduleMidnightTick();
}

/** 岛窗口弹岛前即时重算（弹岛间隔可跨天，ticker 对常驻岛窗口不够即时） */
export function refreshFestivalRaw(): void {
  refreshRaw();
}

/** 叠加总开关后的最终节日（全模块挂载点唯一消费口径：关闭恒为 null → 挂载点输出空） */
export function useFestivalEgg() {
  ensureFestivalEggInstalled();
  const sw = useFestivalEggSwitch();
  const festival = computed(() => (sw.enabled.value ? rawFestival.value : null));
  return { festival };
}

// HMR 安全：热更新丢弃旧定时器与安装标记，新模块实例重新 install
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (midnightTimer) clearTimeout(midnightTimer);
    midnightTimer = null;
    installed = false;
  });
}
