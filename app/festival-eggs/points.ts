import { computed, type ComputedRef } from 'vue';
import type { FestivalId } from './core';
import { useFestivalEgg } from './state';

/**
 * 主窗口点缀注册表：业务组件只声明"点缀位 id"，节日知识（哪个节日挂什么类/说什么话）
 * 全部在本表登记——新增节日的点缀在对应表加一行即可，业务组件零改动。
 * 约束：主窗口不整窗换装（用户要求保持配色），点缀只做局部形状/配色级装饰。
 */

/** 点缀位 → 节日 → 附加类名（样式见 styles/festival.css；未登记的节日该位输出空串） */
const POINT_CLASSES: Record<string, Partial<Record<FestivalId, string>>> = {
  // 收藏徽标（index.vue 列表行）：七夕喜鹊蓝 / 春节鎏金
  'fav-badge': { qixi: 'fav-badge-qixi', chunjie: 'fav-badge-chunjie' },
};

/** 统计页引言横幅：节日 → 引言文案键（本模块 lang 的 [festival] 表） */
const QUOTE_BANNERS: Partial<Record<FestivalId, { quoteKey: string }>> = {
  qixi: { quoteKey: 'festival.qixi_quote' },
  chuxi: { quoteKey: 'festival.chuxi_quote' },
  chunjie: { quoteKey: 'festival.chunjie_quote' },
  yuanxiao: { quoteKey: 'festival.yuanxiao_quote' },
  duanwu: { quoteKey: 'festival.duanwu_quote' },
};

/**
 * 点缀位消费接口：传入点缀位 id，返回当前应挂的节日类名（响应式，跨零点自动切换）。
 * 无节日/总开关关闭/该位未登记该节日 → 空串，业务元素保持原样。
 */
export function useFestivalEggClass(point: string): ComputedRef<string> {
  const { festival } = useFestivalEgg();
  return computed(() => {
    const fest = festival.value;
    return (fest ? POINT_CLASSES[point]?.[fest] : undefined) ?? '';
  });
}

/** 统计页引言横幅（FestivalQuoteBanner 内部消费）：null = 不显示 */
export function useFestivalQuoteBanner(): ComputedRef<{ quoteKey: string } | null> {
  const { festival } = useFestivalEgg();
  return computed(() => {
    const fest = festival.value;
    return (fest ? QUOTE_BANNERS[fest] : undefined) ?? null;
  });
}
