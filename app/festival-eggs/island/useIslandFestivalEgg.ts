import { computed } from 'vue';
import type { IslandKind } from '~/composables/useCopyIsland';
import { useI18n } from '~/composables/useI18n';
import type { FestivalId } from '../core';
import { refreshFestivalRaw, useFestivalEgg } from '../state';
import { reloadFestivalEggSwitch } from '../switch';

/** 岛弹岛载荷（bubble.vue applyIsland 的入参形状）：beforeShow 可整体替换返回 */
export interface IslandEggPayload {
  kind: IslandKind;
  text?: string;
  image?: string;
  thumb?: string;
  title?: string;
  durationMs?: number;
  sticky?: boolean;
}

/**
 * 弹岛行为注册表（ISLAND_QUIRKS）：节日 → 弹岛前的载荷改写钩子。
 * 新增节日的弹岛特殊行为在此登记一行即可，bubble.vue 与本 hook 零改动。
 *
 * 钩子约束：
 * - 纯函数式改写载荷（返回新对象），不得触达 bubble.vue 内部状态；
 * - 需要跨弹岛记忆的（如"只播一次"）用模块级变量自带生命周期（HMR 随模块重置）；
 * - 台词文案一律走本模块 lang 的 [festival] 表键，不写死中文。
 */
type IslandQuirk = (payload: IslandEggPayload, t: (path: string) => string) => IslandEggPayload;

/** 中秋凌晨台词是否已播（窗口生命周期一次：反复弹反而打断正常复制/粘贴反馈） */
let midautumnQuoteShown = false;

/** 中秋限定（农历八月十五）：凌晨（0-5 点）首次弹岛改播台词「但愿人长久」——深夜仍在
 * 复制粘贴的人，替东坡问候一句。替换为 info 载荷复用既有显示链路（零新 UI）；
 * 白天与后续弹岛原样返回不受影响（真实时钟判断，非 --time 冻结时间） */
const midautumnQuirk: IslandQuirk = (payload, t) => {
  if (new Date().getHours() >= 5 || midautumnQuoteShown) return payload;
  midautumnQuoteShown = true;
  return { ...payload, kind: 'info', text: t('festival.midautumn_quote') };
};

/** 春节凌晨贺词是否已播（窗口生命周期一次，同中秋模式） */
let chunjieGreetingShown = false;

/** 春节限定（农历正月初一）：凌晨（0-5 点）首次弹岛改播贺词「新年快乐」——跨年仍在
 * 键盘前的人，替系统道一声恭喜。白天与后续弹岛原样返回（真实时钟判断，非 --time 冻结时间） */
const chunjieQuirk: IslandQuirk = (payload, t) => {
  if (new Date().getHours() >= 5 || chunjieGreetingShown) return payload;
  chunjieGreetingShown = true;
  return { ...payload, kind: 'info', text: t('festival.chunjie_greeting') };
};

/** 除夕凌晨贺词是否已播（窗口生命周期一次，同中秋/春节模式） */
let chuxiGreetingShown = false;

/** 除夕限定（岁末最后一夜）：凌晨（0-5 点）首次弹岛改播贺词「岁岁平安」——年三十凌晨
 *  仍在赶工的人，先讨一句平安彩头（跨零点后由春节贺词接棒「新年快乐」） */
const chuxiQuirk: IslandQuirk = (payload, t) => {
  if (new Date().getHours() >= 5 || chuxiGreetingShown) return payload;
  chuxiGreetingShown = true;
  return { ...payload, kind: 'info', text: t('festival.chuxi_greeting') };
};

const ISLAND_QUIRKS: Partial<Record<FestivalId, IslandQuirk>> = {
  midautumn: midautumnQuirk,
  chuxi: chuxiQuirk,
  chunjie: chunjieQuirk,
};

/**
 * 岛窗口的节日彩蛋消费接口（bubble.vue 唯一挂载点 API）。
 * 岛窗口是独立 webview（不引导 AppModule），总开关缓存与节日值靠
 * beforeShow 内 reload/refresh 双刷新与主窗口保持同步（岛仅弹岛期间可见）。
 */
export function useIslandFestivalEgg() {
  const { t } = useI18n();
  const { festival } = useFestivalEgg();

  /** 徽章悬停提示：当前节日名（与全站 v-tip 同一气泡语言；无节日时空内容不弹） */
  const tip = computed(() => (festival.value ? t(`festival.tip_${festival.value}`) : ''));

  /** 弹岛前调用：刷新开关缓存（跨窗口）→ 即时重算节日（跨天）→ 执行登记的节日行为。
   *  总开关关闭时 festival 恒 null，行为钩子整体跳过 */
  async function beforeShow(payload: IslandEggPayload): Promise<IslandEggPayload> {
    await reloadFestivalEggSwitch();
    refreshFestivalRaw();
    const quirk = festival.value ? ISLAND_QUIRKS[festival.value] : undefined;
    return quirk ? quirk(payload, t) : payload;
  }

  return { festival, tip, beforeShow };
}
