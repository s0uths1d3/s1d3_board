<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RingSegment } from '~/src/smart-clip/ringSegments';
import RingBubbleCard from './RingBubbleCard.vue';
import RingHub from './RingHub.vue';

/**
 * Ctrl+B 环形盘的环面（bubble.vue ring 模式的视觉与交互收口）。
 * 整环是一个页面：环绕气泡、轨道虚线、中心光晕与环心控制盘都是页内 DOM，
 * 选中 / 空间导航 / 翻页 / 键盘全在此自治，无跨窗口状态同步。
 * 槽位先占上下左右、再补四角；气泡统一 208×128，半径按视口收缩（小屏不越界）。
 * 窗口背景透明：环外区域点击 = 关环（该矩形本就拦截系统点击，赋予其明确语义）。
 * 事件：paste（粘贴选中项）、pin（钉住）、close（Esc / Ctrl+B / 点击环外 / 失焦联动）。
 */
const props = defineProps<{
  /** 全部片段（管理器 ring:data / ring:ai-result 投递，本组件按页切片渲染） */
  segments: RingSegment[];
  source: string;
  /** 源内容哈希（习惯记录关联键，随 paste 意图回传） */
  contentHash: string;
  aiPending: boolean;
}>();

const emit = defineEmits<{
  paste: [segment: RingSegment];
  pin: [segment: RingSegment];
  close: [];
}>();

// ===== 环几何 =====

/** 槽位偏移表（0 上 / 1 下 / 2 左 / 3 右 / 4-7 四角）；对角外推利用斜向富余空间 */
const SLOT_OFFSETS: Array<{ x: number; y: number }> = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -0.72, y: -0.72 },
  { x: 0.72, y: -0.72 },
  { x: -0.72, y: 0.72 },
  { x: 0.72, y: 0.72 },
];
const DIAGONAL_SCALE = 1.18;

const viewport = ref({ w: 920, h: 640 });
function measure(): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
}
onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure);
});

// 半径由对角槽位约束推导（最紧）：对角外推 1.18 倍后，槽位中心 + 半张卡片
// （104×64）+ 边距 8px 仍留在窗口内；295/210 为标准 920×640 窗口下的上限
const geo = computed(() => {
  const halfW = viewport.value.w / 2;
  const halfH = viewport.value.h / 2;
  return {
    halfW,
    halfH,
    rx: Math.max(40, Math.min(295, (halfW - 112) / DIAGONAL_SCALE)),
    ry: Math.max(40, Math.min(210, (halfH - 72) / DIAGONAL_SCALE)),
  };
});

/** 槽位中心（窗口内绝对坐标；wrapper 再 translate 居中） */
function slotStyle(i: number): Record<string, string> {
  const off = SLOT_OFFSETS[i] ?? { x: 0, y: -1 };
  const diag = i >= 4 ? DIAGONAL_SCALE : 1;
  return {
    left: `${geo.value.halfW + off.x * geo.value.rx * diag}px`,
    top: `${geo.value.halfH + off.y * geo.value.ry * diag}px`,
  };
}

// ===== 分页 / 选中（页内自治，单一事实来源） =====

const PAGE_SIZE = 8;
const page = ref(0);
const pages = computed(() => Math.max(1, Math.ceil(props.segments.length / PAGE_SIZE)));
const pageStart = computed(() => page.value * PAGE_SIZE);
const visible = computed(() => props.segments.slice(pageStart.value, pageStart.value + PAGE_SIZE));
const selected = ref(0);

function selectIndex(i: number): void {
  if (i < 0 || i >= props.segments.length) return;
  selected.value = i;
}

/** 顺序循环切换选中（‹ › 按钮）：跨页时页面跟随选中项切换 */
function navSelected(delta: number): void {
  const total = props.segments.length;
  if (total === 0) return;
  const next = (selected.value + delta + total) % total;
  page.value = Math.floor(next / PAGE_SIZE);
  selected.value = next;
}

/** 翻页（PgUp/PgDn / 页码点）：翻页后选中该页首项 */
function switchPage(delta: number): void {
  if (props.segments.length === 0) return;
  page.value = (page.value + delta + pages.value) % pages.value;
  selected.value = Math.min(pageStart.value, props.segments.length - 1);
}

function pasteSelected(): void {
  const seg = props.segments[selected.value];
  if (seg) emit('paste', seg);
}

// ===== 键盘导航（overlay 持有系统焦点，是环形系统的唯一键盘入口） =====

// Ctrl+B（局部快捷键的环内延伸）：环打开时主窗口收不到 keydown，在此转发保持 toggle 一致
function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    emit('close');
    return;
  }
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      navSpatial('left');
      break;
    case 'ArrowUp':
      e.preventDefault();
      navSpatial('up');
      break;
    case 'ArrowRight':
      e.preventDefault();
      navSpatial('right');
      break;
    case 'ArrowDown':
      e.preventDefault();
      navSpatial('down');
      break;
    case 'Enter':
      e.preventDefault();
      pasteSelected();
      break;
    case 'PageUp':
      e.preventDefault();
      switchPage(-1);
      break;
    case 'PageDown':
      e.preventDefault();
      switchPage(1);
      break;
    case 'Escape':
      e.preventDefault();
      emit('close');
      break;
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

type NavDir = 'up' | 'down' | 'left' | 'right';

interface NavCell { index: number; x: number; y: number }

/**
 * 方向键空间导航（←↑/→↓）：当前页槽位偏移按符号划分为 3×3 行/列带。
 * ↑↓ 同列带内取最近；←→ 同行带内取相邻，行首/行尾越界折转到**不同行带**中
 * 距离最近的上/下方气泡（同行带不算上/下方，顶/底行越界原地不动）。
 * 全程仅在当前页槽位间移动（翻页交给 PgUp/PgDn）。
 */
function navSpatial(dir: NavDir): void {
  const count = visible.value.length;
  if (count === 0) return;
  const cells: NavCell[] = visible.value.map((_, i) => ({
    index: pageStart.value + i,
    x: SLOT_OFFSETS[i]?.x ?? 0,
    y: SLOT_OFFSETS[i]?.y ?? 0,
  }));
  const cur = cells.find((c) => c.index === selected.value) ?? cells[0]!;
  const dist = (c: NavCell): number => Math.hypot(c.x - cur.x, c.y - cur.y);
  let target: NavCell | undefined;
  if (dir === 'up' || dir === 'down') {
    target = cells
      .filter((c) => c !== cur && Math.sign(c.x) === Math.sign(cur.x) && (dir === 'up' ? c.y < cur.y : c.y > cur.y))
      .sort((a, b) => Math.abs(a.y - cur.y) - Math.abs(b.y - cur.y))[0];
  } else {
    const row = cells
      .filter((c) => c !== cur && Math.sign(c.y) === Math.sign(cur.y) && (dir === 'left' ? c.x < cur.x : c.x > cur.x))
      .sort((a, b) => Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x));
    if (row.length > 0) {
      target = row[0];
    } else {
      // 距离并列时按方向偏好 x（← 取更左、→ 取更右）
      target = cells
        .filter((c) => Math.sign(c.y) !== Math.sign(cur.y) && (dir === 'left' ? c.y < cur.y : c.y > cur.y))
        .sort((a, b) => dist(a) - dist(b) || (dir === 'left' ? a.x - b.x : b.x - a.x))[0];
    }
  }
  if (target) selectIndex(target.index);
}
</script>

<template>
  <div class="relative h-screen w-screen cursor-default select-none overflow-hidden" @click="emit('close')">
    <!-- 轨道虚线椭圆（纯装饰） -->
    <svg class="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      <ellipse
          :cx="geo.halfW"
          :cy="geo.halfH"
          :rx="geo.rx"
          :ry="geo.ry"
          fill="none"
          stroke="rgb(var(--c-gold) / 0.15)"
          stroke-width="1"
          stroke-dasharray="3 7" />
    </svg>

    <!-- 中心光晕（纯装饰） -->
    <div
        class="pointer-events-none absolute h-44 w-44 rounded-full bg-gold/10 blur-2xl"
        :style="{ left: `${geo.halfW}px`, top: `${geo.halfH}px`, transform: 'translate(-50%, -50%)' }" />

    <!-- 环绕气泡：wrapper 拦截点击（不触发环外关闭） -->
    <div
        v-for="(seg, i) in visible"
        :key="pageStart + i"
        class="ring-slot absolute"
        :style="slotStyle(i)"
        @click.stop>
      <RingBubbleCard
          :segment="seg"
          :index="pageStart + i"
          :slot-index="i"
          :selected="pageStart + i === selected"
          @select="selectIndex(pageStart + i)"
          @paste="pasteSelected"
          @pin="emit('pin', seg)" />
    </div>

    <!-- 环心控制盘 -->
    <div
        class="ring-slot absolute"
        :style="{ left: `${geo.halfW}px`, top: `${geo.halfH}px` }"
        @click.stop>
      <RingHub
          :source="source"
          :selected="selected"
          :total="segments.length"
          :page="page"
          :pages="pages"
          :ai-pending="aiPending"
          @nav="navSelected"
          @page-nav="switchPage"
          @close="emit('close')" />
    </div>
  </div>
</template>

<style scoped>
/* left/top 指向槽位中心点，wrapper 反向偏移自身尺寸的一半 */
.ring-slot {
  transform: translate(-50%, -50%);
}
</style>
