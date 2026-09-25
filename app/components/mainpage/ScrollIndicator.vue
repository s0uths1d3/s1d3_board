<script setup lang="ts">
/**
 * 主窗口自绘滚动条滑块。
 *
 * 为什么自绘：原生 ::-webkit-scrollbar-thumb 的位置钉死在滚动容器右边缘，既不能用
 * transform 偏移、宽度也不参与过渡，"滚动条从窗口右边缘滑入"做不出来。这里把原生滑块
 * 设为透明（见 main.css #app-main.is-main-window::-webkit-scrollbar-thumb），只借它继续
 * 承担 8px 槽位与滚轮/拖拽命中区（行为不变），可视滑块由本组件自己画。
 *
 * 动画全部逐帧在脚本里算，不交给 CSS 过渡（与导航下划线同一思路）：滑块的形态就是
 * "上下两端"两个数值，用 CSS 过渡插值相对量（高度）时，同一次变化里两端会互相抵消；
 * 而且中途改目标会重启缓动，看起来像"停一下再走"。这里每帧按
 *     渲染上端 = 基准上端 + 上端偏移      渲染下端 = 基准下端 + 下端偏移
 * 计算：基准来自实时测量，偏移负责"变化"，一律缓动到 0；新目标只是把偏移重设成
 * "当前渲染值 − 新基准"，所以动画天然连续无跳变。缓动 ease-out-quint（起步快、收尾慢），
 * 时长按位移换算，观感速度恒定。
 *
 * 两条路径分开，避免滚动时卡顿：
 *   - 滚动（用户翻页/拖动，需要严格跟手）：只读 scrollTop，位置写进 transform（合成器
 *     友好），直接在 scroll 事件里同步完成，不排队不读布局、不起任何动画。
 *   - 内容变化/出现/退出（由 ResizeObserver、MutationObserver 驱动）：才读 scrollHeight
 *     与 clientHeight 并播放补间。读这两个值会强制同步布局，不能放进每帧的滚动路径。
 *
 * 时序：切 Tab 后要等新内容挂载才能实测出它是否需要滚动条，而 out-in 过渡下这个时刻
 * 在旧 Tab 退场之后——所以为每个 Tab 记住上次实测结果，切换瞬间就按记忆值起动画，
 * 与页面淡出/淡入同一时刻开始。"旧内容还没退场"直接按 DOM 判定（Tab 内容根节点的
 * data-tab-key，见 index.vue），不留盲区：内容一变（例如删掉一项而不再需要滚动条）
 * 就能立刻判定并立刻退出。
 */
import { activeTab } from '~/composables/useTabs';

/** 滑块最小高度：内容极长时也要留出可辨识的把手 */
const MIN_THUMB_HEIGHT = 24;
/** 位移换算速度（px/s）与时长上下限：时长随位移走，观感速度恒定 */
const THUMB_PX_PER_SEC = 700;
const THUMB_MIN_MS = 120;
const THUMB_MAX_MS = 450;
/** 纯淡入/淡出（无位移）时的时长，与 .page-pad 内容宽度过渡保持一致 */
const VIS_MS = 300;
/** 隐藏位：向右平移这么多即完全移出窗口（由 wrapper 的 overflow-hidden 裁掉） */
const THUMB_HIDDEN_X = 8;

const thumbEl = ref<HTMLElement | null>(null);

let scrollEl: HTMLElement | null = null;
/** 是否已需要滚动条（决定内容区右侧内边距，并区分"出现/退出"两种状态切换） */
let scrollable = false;
/** 缓存的"当前挂载的 Tab"：滚动路径据此判断这次滚动是否属于当前 Tab（查询不进每帧路径） */
let mountedKey: string | null = null;

/** 缓存的内容几何：只在 refreshGeometry 里重读，滚动路径绝不碰（会强制布局） */
let trackHeight = 0;
let contentHeight = 0;
/** 目标长度（px，已夹最小高度） */
let thumbLength = 0;

/** 实时基准：滑块上下两端在轨道内的位置（px） */
let baseStart = 0;
let baseEnd = 0;
/** 端点偏移：让"变化"以动画呈现，最终缓动到 0 */
let offStart = 0;
let offEnd = 0;
/** 当前渲染的端点（新目标时以它为起点，保证动画连续） */
let curStart = 0;
let curEnd = 0;
/** 可见度进度：0 完全隐藏（右移出窗），1 完全显示 */
let vis = 0;
/** 上次写入 DOM 的长度，避免每帧重复写布局属性 */
let writtenLength = -1;

interface Tween {
  fromStart: number;
  fromEnd: number;
  fromVis: number;
  toVis: number;
  startAt: number;
  duration: number;
}
let tween: Tween | null = null;
let tweenRaf = 0;
let refreshRaf = 0;

/** 起步快、收尾慢 */
const easeOutQuint = (p: number) => 1 - (1 - p) ** 5;

let resizeObserver: ResizeObserver | null = null;
let mutationObserver: MutationObserver | null = null;
/** 当前已登记尺寸观察的内容根节点（内容重建后需重新认领） */
let observedContent: Element | null = null;

/** 把当前状态写进 DOM。长度是布局属性，只在真变化时写；位置一律走 transform */
function applyStyles() {
  const thumb = thumbEl.value;
  if (!thumb) return;
  const start = baseStart + offStart;
  const end = baseEnd + offEnd;
  curStart = start;
  curEnd = end;
  const length = Math.max(0, end - start);
  if (length !== writtenLength) {
    thumb.style.height = `${length.toFixed(1)}px`;
    writtenLength = length;
  }
  thumb.style.opacity = `${vis.toFixed(3)}`;
  thumb.style.transform = `translateY(${start.toFixed(1)}px) translateX(${((1 - vis) * THUMB_HIDDEN_X).toFixed(2)}px)`;
}

function tick(now: number) {
  tweenRaf = 0;
  if (!tween) return;
  const p = tween.duration > 0 ? Math.min(1, (now - tween.startAt) / tween.duration) : 1;
  const e = easeOutQuint(p);
  offStart = tween.fromStart * (1 - e);
  offEnd = tween.fromEnd * (1 - e);
  vis = tween.fromVis + (tween.toVis - tween.fromVis) * e;
  if (p >= 1) {
    offStart = 0;
    offEnd = 0;
    vis = tween.toVis;
    tween = null;
  }
  applyStyles();
  if (tween) tweenRaf = requestAnimationFrame(tick);
}

/** 起一次补间：端点偏移与可见度都从"当前实际值"出发，所以中途改目标也是连续的 */
function startTween(targetVis: number) {
  const span = Math.max(Math.abs(offStart), Math.abs(offEnd));
  const moveMs = span > 0
    ? Math.min(THUMB_MAX_MS, Math.max(THUMB_MIN_MS, Math.round(span / THUMB_PX_PER_SEC * 1000)))
    : 0;
  const visMs = Math.abs(targetVis - vis) > 0.001 ? VIS_MS : 0;
  tween = {
    fromStart: offStart,
    fromEnd: offEnd,
    fromVis: vis,
    toVis: targetVis,
    startAt: performance.now(),
    duration: Math.max(moveMs, visMs),
  };
  if (!tweenRaf) tweenRaf = requestAnimationFrame(tick);
}

/** 当前挂载的 Tab 内容属于哪个 Tab；元素上没有标记时返回 null（无从判定） */
function mountedTabKey(): string | null {
  return scrollEl?.querySelector<HTMLElement>('[data-tab-key]')?.dataset.tabKey ?? null;
}

/** 由缓存的几何与当前 scrollTop 推出两端基准（只读 scrollTop） */
function updateBase() {
  const scrollTop = scrollEl?.scrollTop ?? 0;
  const maxScroll = contentHeight - trackHeight;
  baseEnd = maxScroll > 0
    ? Math.round(scrollTop / maxScroll * (trackHeight - thumbLength)) + thumbLength
    : trackHeight;
  baseStart = baseEnd - thumbLength;
}

/**
 * 内容变化路径（ResizeObserver / MutationObserver / 挂载）：重读几何并决定要不要播补间。
 * 读 scrollHeight/clientHeight 会强制同步布局，所以只在这里读，绝不放进滚动路径。
 */
function refreshGeometry() {
  refreshRaf = 0;
  const el = scrollEl;
  if (!el) return;
  const mounted = mountedTabKey();
  // 挂载的还是上一个 Tab 的内容（切换过渡的退场阶段）：高度不代表新 Tab，整段作废
  if (mounted !== null && mounted !== activeTab.value) return;
  mountedKey = mounted;

  const nextTrack = el.clientHeight;
  const nextContent = el.scrollHeight;
  const canScroll = nextContent - nextTrack > 1;
  const nextLength = canScroll
    ? Math.min(nextTrack, Math.max(MIN_THUMB_HEIGHT, Math.round(nextTrack * nextTrack / nextContent)))
    : thumbLength;
  trackHeight = nextTrack;
  contentHeight = nextContent;
  thumbLength = nextLength;

  const wasScrollable = scrollable;
  scrollable = canScroll;
  if (canScroll) {
    updateBase();
    if (vis <= 0.01) {
      // 从隐藏状态出现：起始铺满整条轨道（这正是没有可滚内容时的形态），再收缩到实际比例。
      // 此刻滑块完全不可见，所以把起始端点放到哪里都不存在"跳变"
      offStart = -baseStart;
      offEnd = trackHeight - baseEnd;
      startTween(1);
    } else if (Math.abs(baseStart - curStart) > 0.5 || Math.abs(baseEnd - curEnd) > 0.5) {
      // 基准动了：两端都从"当前渲染值"缓动到新基准，而不是直接跳到新基准。
      // 切 Tab 时两页滚动位置不同（例如上个页面停在中部、新页面回到顶部）也走这里，
      // 所以滑块是平滑滑过去，而不是先瞬移回顶部再播动画
      offStart = curStart - baseStart;
      offEnd = curEnd - baseEnd;
      startTween(1);
    }
  } else if (wasScrollable) {
    // 不再需要滚动条：端点停住，淡出并向右滑走
    startTween(0);
  }
  el.classList.toggle('has-scrollbar', scrollable);
  applyStyles();
}

function scheduleRefresh() {
  if (!refreshRaf) refreshRaf = requestAnimationFrame(refreshGeometry);
}

/** 滚动路径：严格跟手，不排队、不起动画、不读会强制布局的值 */
function onScroll() {
  if (!scrollable) return;
  // 挂载内容与当前 Tab 不一致（切换过渡的退场阶段）：index.vue 会在旧内容还在时就把
  // 滚动位置回填成目标 Tab 的值，那一次滚动不代表新 Tab 的位置，跟着走会瞬移
  if (mountedKey !== null && mountedKey !== activeTab.value) return;
  updateBase();
  applyStyles();
}

/**
 * 认领内容根节点做尺寸观察。内容高度变化（Tab 内容、列表分页加载）只能靠观察内容节点捕获：
 * 滚动容器自身尺寸不变时，对容器自身的 ResizeObserver 不会触发。
 */
function observeContent() {
  const content = scrollEl?.firstElementChild ?? null;
  if (content === observedContent) return;
  if (observedContent) resizeObserver?.unobserve(observedContent);
  observedContent = content;
  if (content) resizeObserver?.observe(content);
}

// 切换瞬间（渲染尚未发生、DOM 里还是旧 Tab）：按记忆值提前起动画；
// 之后的实测由下面两个观察者驱动，并被 refreshGeometry 里的 data-tab-key 判定挡住"旧内容"那几帧
const tabScrollable = new Map<string, boolean>();
watch(activeTab, (tab) => {
  const remembered = tabScrollable.get(tab);
  if (remembered === undefined || remembered === scrollable) return;
  // 提前进入"出现"形态：先按当前基准铺满，真实基准到位后由 refreshGeometry 收缩过去
  scrollable = remembered;
  if (remembered) {
    // 只有当前完全不可见时才把起始形态设成"铺满轨道"；半透明中改起始端点会看出来跳
    if (vis <= 0.01) {
      offStart = -baseStart;
      offEnd = trackHeight - baseEnd;
    }
    startTween(1);
  } else {
    startTween(0);
  }
  scrollEl?.classList.toggle('has-scrollbar', remembered);
});

onMounted(() => {
  scrollEl = document.getElementById('app-main');
  if (!scrollEl) return;
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  // 容器自身尺寸变化（窗口缩放）走这里；内容节点尺寸变化也复用同一实例
  resizeObserver = new ResizeObserver(() => {
    observeContent();
    scheduleRefresh();
  });
  resizeObserver.observe(scrollEl);
  // subtree：页面内部任何变动（Tab 内容整体替换、删项、列表刷新）都要尽快重新判定，
  // 否则"删到不再需要滚动条"要等下一次别的事件才反应
  mutationObserver = new MutationObserver(() => {
    observeContent();
    scheduleRefresh();
  });
  mutationObserver.observe(scrollEl, { childList: true, subtree: true });
  observeContent();
  refreshGeometry();
});

onBeforeUnmount(() => {
  if (tweenRaf) cancelAnimationFrame(tweenRaf);
  if (refreshRaf) cancelAnimationFrame(refreshRaf);
  scrollEl?.removeEventListener('scroll', onScroll);
  scrollEl?.classList.remove('has-scrollbar');
  resizeObserver?.disconnect();
  resizeObserver = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
});
</script>

<template>
  <div ref="thumbEl" class="sb-thumb" aria-hidden="true"></div>
</template>
