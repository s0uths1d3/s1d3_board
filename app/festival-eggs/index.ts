/**
 * 节日彩蛋模块公共 API（目录外只允许 import 这里）。
 *
 * 职责边界：业务组件（bubble.vue / index.vue / StatsPage.vue）只经本出口拿
 * "通用挂载点消费接口"，不含任何具体节日知识；新增/修改节日全部在本目录内完成
 * （步骤见 core.ts 头注释）。
 */
export { currentFestival, festivalNow, type FestivalId } from './core';
export { ensureFestivalEggInstalled, useFestivalEgg } from './state';
export {
  reloadFestivalEggSwitch,
  setFestivalEggEnabled,
  useFestivalEggEnabled,
} from './switch';
export { useFestivalEggClass } from './points';
export { useIslandFestivalEgg, type IslandEggPayload } from './island/useIslandFestivalEgg';
export { default as FestivalIslandDecor } from './island/FestivalIslandDecor.vue';
export { default as FestivalQuoteBanner } from './points/FestivalQuoteBanner.vue';
