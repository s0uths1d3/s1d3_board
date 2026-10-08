<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from '~/composables/useI18n';
import type { RingSegment } from '~/src/smart-clip/ringSegments';

/**
 * 环形气泡卡片（RingOverlay 的单体卡片）：玻璃拟态面 + 顶栏（细字重序号 +
 * AI 徽标 + 悬停浮现的钉住按钮）+ 正文（超出裁剪）。统一 208×128 尺寸让环
 * 在任意片段组合下保持对称节奏。事件：select（点击/Ctrl+悬停）、paste（双击）、pin。
 */
const props = defineProps<{
  segment: RingSegment;
  /** 全局片段序号（0 起）：序号徽章显示 index+1 */
  index: number;
  /** 页内槽位序（0-7）：入场错峰用 */
  slotIndex: number;
  selected: boolean;
}>();

const emit = defineEmits<{
  select: [];
  paste: [];
  pin: [];
}>();

const { t } = useI18n();

const isAi = props.segment.extractorId === 'ai-analysis';
const num = String(props.index + 1).padStart(2, '0');

// 入场：挂载即播（卡片只在有片段时挂载，AI 补位/翻页重挂自然重播）；
// 双 rAF 保证首帧即动，且窗口 hidden 期间 WebView2 节流 rAF，动画不会提前跑完
const entered = ref(false);
const enterDelay = (props.slotIndex % 8) * 45;
onMounted(() => {
  requestAnimationFrame(() => requestAnimationFrame(() => { entered.value = true; }));
});

// 选中一次性脉冲（金光闪现渐隐）；old 值比对防重复触发
const pulse = ref(false);
let pulseTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => props.selected, (v, old) => {
  if (v === old) return;
  if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
  if (!v) { pulse.value = false; return; }
  pulse.value = false; // 复位后下一帧再点亮：连续切换时动画从头重播
  requestAnimationFrame(() => { pulse.value = true; });
  pulseTimer = setTimeout(() => { pulse.value = false; }, 700);
});
onBeforeUnmount(() => {
  if (pulseTimer) clearTimeout(pulseTimer);
});

function onPointerMove(e: PointerEvent): void {
  if (e.ctrlKey) emit('select');
}
</script>

<template>
  <div
      class="ring-bubble group relative h-32 w-52 cursor-pointer"
      :class="entered ? 'ring-bubble-in' : 'ring-bubble-pre'"
      :style="{ '--ring-delay': `${enterDelay}ms` }"
      role="button"
      @pointermove="onPointerMove"
      @click="emit('select')"
      @dblclick="emit('paste')">
    <div
        class="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border transition-all duration-200 ease-soft"
        :class="[
          selected
            ? 'border-gold bg-surface-field ring-2 ring-gold/60 shadow-[0_0_4px_rgb(var(--c-gold)/0.5),0_0_20px_rgb(var(--c-gold)/0.4)]'
            : 'border-line bg-surface/95 backdrop-blur-md hover:-translate-y-0.5 hover:border-accent hover:shadow-float',
          pulse ? 'ring-sel-pulse' : '',
        ]">
      <div class="flex shrink-0 items-center justify-between px-2.5 pt-1.5">
        <span
            class="text-[13px] font-thin leading-none tabular-nums"
            :class="selected ? 'text-gold' : 'text-ink-faint/80'">{{ num }}</span>
        <div class="flex items-center gap-1">
          <span
              v-if="isAi"
              class="rounded bg-gold/15 px-1 text-[9px] font-semibold leading-3 text-gold">AI</span>
          <button
              type="button"
              class="rounded p-0.5 text-ink-faint opacity-0 transition-all duration-200 hover:bg-gold/10 hover:text-gold group-hover:opacity-100"
              :title="t('bubble.pin')"
              @click.stop="emit('pin')">
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
            </svg>
          </button>
        </div>
      </div>
      <p class="min-h-0 flex-1 overflow-hidden px-2.5 pb-2 pt-1 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-ink">{{ segment.text }}</p>
    </div>
  </div>
</template>

<style scoped>
.ring-bubble-pre { opacity: 0; }
.ring-bubble-in {
  animation: ring-bubble-in 0.38s cubic-bezier(0.34, 1.4, 0.4, 1) both;
  animation-delay: var(--ring-delay, 0ms);
}
@keyframes ring-bubble-in {
  from { opacity: 0; transform: translateY(10px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* 选中脉冲：金光闪现渐隐，与静态双层辉光叠加（切换瞬间"亮一下"） */
.ring-sel-pulse::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 1rem;
  background: rgb(var(--c-gold) / 0.16);
  border: 2px solid rgb(var(--c-gold) / 0.85);
  pointer-events: none;
  animation: ring-sel-flash 0.6s ease-out forwards;
}
@keyframes ring-sel-flash {
  0% { opacity: 0; }
  22% { opacity: 1; }
  100% { opacity: 0; }
}
</style>
