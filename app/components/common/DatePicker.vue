<script setup lang="ts">
/**
 * 统一日期选择器（DatePicker）
 *
 * 替换原生 <input type="date"> / <input type="datetime-local">，视觉与全局暖色主题一致。
 * - mode="date"：仅日期，值为 YYYY-MM-DD
 * - mode="datetime"：日期 + 时分，值为 YYYY-MM-DDTHH:mm
 * - 弹出式月历：周一起始、前后月切换、今日描边、选中高亮、min/max 禁用
 *
 * 层级处理（关键）：面板通过 <Teleport to="body"> 挂到 body 并使用 fixed 定位，
 * 避免被调用方容器的 backdrop-filter 层叠上下文 / overflow 裁剪 / 原生控件遮挡；
 * 打开时根据触发按钮 getBoundingClientRect 计算位置，并对视口做左右/上下自适应。
 */
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  /** YYYY-MM-DD 起止限制（datetime 值自动取日期部分） */
  min?: string;
  max?: string;
  /** 日期模式 / 日期时间模式 */
  mode?: 'date' | 'datetime';
  /** 尺寸：sm 紧凑，md 与表单 select/button 等高 */
  size?: 'sm' | 'md';
  /**
   * 面板开关（v-model:open）。传入则由外部完全控制面板，组件不再自管 open 状态。
   * 不传则维持原有"点击触发按钮 toggle 面板"行为。
   */
  open?: boolean;
  /** 隐藏触发按钮：仅用作"面板"容器（典型场景：由父组件编程打开面板） */
  hideTrigger?: boolean;
  /**
   * datetime 模式下，时分选择变化是否实时 emit（默认 true）。
   * 由外部编程控制面板（v-model:open）时建议 false，避免选小时/分钟时面板被父组件立即关闭。
   */
  liveEmit?: boolean;
}>(), {
  placeholder: '选择日期',
  mode: 'date',
  min: '',
  max: '',
  size: 'sm',
  open: undefined,
  hideTrigger: false,
  liveEmit: true,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'update:open', value: boolean): void;
}>();

// ===== 工具 =====
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 解析 modelValue：拆出日期 + 时间（HH:mm 或空） */
function parseValue(v: string): { date: string; time: string } | null {
  if (!v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  if (!m) return null;
  return { date: m[1]!, time: m[2] ?? '' };
}

const parsed = computed(() => parseValue(props.modelValue));
/** 当前选中日期（YYYY-MM-DD） */
const selectedDate = computed(() => parsed.value?.date ?? '');
/** 当前选中时间（HH:mm） */
const selectedTime = computed(() => parsed.value?.time ?? '');

// ===== 弹出状态 =====
const internalOpen = ref(false);
const isOpenControlled = computed(() => props.open !== undefined);
const open = computed({
  get: () => (isOpenControlled.value ? props.open! : internalOpen.value),
  set: (v: boolean) => {
    if (isOpenControlled.value) emit('update:open', v);
    else internalOpen.value = v;
  },
});
/** 外部受控时，同步到 internalOpen 以兼容原有面板定位/外部点击等逻辑 */
watch(
  () => props.open,
  (v) => {
    if (isOpenControlled.value) internalOpen.value = v ?? false;
  },
  { immediate: true },
);
const rootEl = ref<HTMLDivElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

// ===== 月历视图（初始定位到选中月份，否则今天所在月）=====
function initialView(): { year: number; month: number } {
  const d = selectedDate.value ? new Date(`${selectedDate.value}T00:00:00`) : new Date();
  if (isNaN(d.getTime())) return { year: new Date().getFullYear(), month: new Date().getMonth() };
  return { year: d.getFullYear(), month: d.getMonth() };
}

const view = ref<{ year: number; month: number }>(initialView());

/** 打开面板时把视图定位到选中月份；无选中则定位到今天所在月 */
function syncView() {
  const d = selectedDate.value ? new Date(`${selectedDate.value}T00:00:00`) : new Date();
  if (isNaN(d.getTime())) return;
  view.value = { year: d.getFullYear(), month: d.getMonth() };
}

const viewTitle = computed(() => `${view.value.year} 年 ${view.value.month + 1} 月`);

/** 上/下月提示文案：用 Date 进制滚动计算，避免一月/十二月显示 "0 月"/"13 月" 且年份不联动 */
const prevMonthLabel = computed(() => {
  const d = new Date(view.value.year, view.value.month - 1, 1);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
});
const nextMonthLabel = computed(() => {
  const d = new Date(view.value.year, view.value.month + 1, 1);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
});

/** 月份切换方向（供滑动动画使用：1=向后，-1=向前） */
const slideDir = ref<1 | -1>(1);

function shiftMonth(delta: number) {
  slideDir.value = delta as 1 | -1;
  const d = new Date(view.value.year, view.value.month + delta, 1);
  view.value = { year: d.getFullYear(), month: d.getMonth() };
}

/** 42 格月历网格（周一起始，含前后月补位日） */
const cells = computed<Date[]>(() => {
  const { year, month } = view.value;
  const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 周一 = 0
  const first = new Date(year, month, 1 - startWeekday);
  const list: Date[] = [];
  for (let i = 0; i < 42; i++) {
    list.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i));
  }
  return list;
});

const weekHeaders = ['一', '二', '三', '四', '五', '六', '日'];

/** 今日日期（computed）：跨天运行后"今日"描边仍指向正确日期 */
const todayStr = computed(() => fmtDate(new Date()));

function isInView(d: Date): boolean {
  return d.getFullYear() === view.value.year && d.getMonth() === view.value.month;
}

function isDisabled(d: Date): boolean {
  const s = fmtDate(d);
  if (props.min && s < props.min.slice(0, 10)) return true;
  if (props.max && s > props.max.slice(0, 10)) return true;
  return false;
}

function isSelected(d: Date): boolean {
  return fmtDate(d) === selectedDate.value;
}

function isToday(d: Date): boolean {
  return fmtDate(d) === todayStr.value;
}

// ===== 时间（datetime 模式）=====
const hour = ref(0);
const minute = ref(0);

/** 时间默认值：保留已有时间，否则当前时间 */
function initTime() {
  if (selectedTime.value) {
    const parts = selectedTime.value.split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    hour.value = !isNaN(h) && h >= 0 && h < 24 ? h : new Date().getHours();
    minute.value = !isNaN(m) && m >= 0 && m < 60 ? m : new Date().getMinutes();
  } else {
    hour.value = new Date().getHours();
    minute.value = new Date().getMinutes();
  }
}

const hourOptions = Array.from({ length: 24 }, (_, i) => pad(i));
const minuteOptions = Array.from({ length: 60 }, (_, i) => pad(i));

const hourListEl = ref<HTMLUListElement | null>(null);
const minuteListEl = ref<HTMLUListElement | null>(null);

/** 当下拉展开时，把当前选中的时间项滚动到可视区域中央，避免从 00 开始显示 */
function scrollToActive(listEl: HTMLUListElement | null, value: number) {
  if (!listEl) return;
  nextTick(() => {
    const activeBtn = listEl.querySelector(`button[data-value="${value}"]`) as HTMLElement | null;
    if (activeBtn) {
      activeBtn.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  });
}

function emitValue() {
  if (!selectedDate.value) return;
  if (props.mode === 'datetime') {
    emit('update:modelValue', `${selectedDate.value}T${pad(hour.value)}:${pad(minute.value)}`);
  } else {
    emit('update:modelValue', selectedDate.value);
  }
}

watch([hour, minute], () => {
  // liveEmit=false 时不实时 emit（配合外部 v-model:open 使用），只在 selectDate / "确定"时提交
  if (props.mode === 'datetime' && selectedDate.value && props.liveEmit) emitValue();
});

function selectDate(d: Date) {
  if (isDisabled(d)) return;
  if (props.mode === 'datetime' && !selectedDate.value) initTime();
  emit('update:modelValue', props.mode === 'datetime'
    ? `${fmtDate(d)}T${pad(hour.value)}:${pad(minute.value)}`
    : fmtDate(d));
  close();
}

function clearValue() {
  emit('update:modelValue', '');
}

// ===== 面板定位（Teleport 到 body + fixed，视口自适应）=====
const PANEL_WIDTH = 288;
const PANEL_HEIGHT = 352;

function positionPanel() {
  if (!rootEl.value) return;
  const rect = rootEl.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 面板已渲染时用真实尺寸（datetime 模式比估算值高得多），否则退回估算值
  const panelH = panelRef.value?.offsetHeight || PANEL_HEIGHT;
  const panelW = panelRef.value?.offsetWidth || PANEL_WIDTH;

  // 左右：默认对齐按钮左缘，超右边界则收进视口
  let left = rect.left;
  if (left + panelW > vw - 8) left = Math.max(8, vw - panelW - 8);
  if (left < 8) left = 8;

  // 上下：优先向下展开；放不下且上方足够时向上弹；两者都放不下则钳制在视口内
  let top = rect.bottom + 8;
  let up = false;
  if (top + panelH > vh - 8) {
    const aboveTop = rect.top - panelH - 8;
    if (aboveTop >= 8) {
      top = aboveTop;
      up = true;
    } else {
      top = Math.max(8, Math.min(top, vh - panelH - 8));
    }
  }
  const rightAligned = left !== rect.left;

  panelStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${Math.max(rect.width, PANEL_WIDTH)}px`,
    // 弹出动画的原点：从按钮方向展开（向下弹出 top 原点，向上弹出 bottom 原点）
    '--picker-origin': `${up ? 'bottom' : 'top'} ${rightAligned ? 'right' : 'left'}`,
  };
}

// ===== 打开 / 关闭 / 外部点击 =====
function toggle() {
  if (open.value) {
    close();
  } else {
    syncView();
    initTime();
    open.value = true;
  }
}

function close() {
  open.value = false;
}

function onDocClick(e: MouseEvent) {
  const t = e.target as Node;
  // 点击触发按钮或面板内部不关闭
  if (rootEl.value?.contains(t) || panelRef.value?.contains(t)) return;
  close();
}

function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

watch(open, (v) => {
  if (v) {
    // 外部 v-model:open 编程打开时不走 toggle()，这里统一初始化视图/时间
    syncView();
    initTime();
    // 触发元素在滚动容器可视区外时先滚入（nearest：已可见则不滚动），面板才能贴着它弹出
    rootEl.value?.scrollIntoView({ block: 'nearest' });
    positionPanel();
    // 面板渲染完成后用真实尺寸二次定位（首拍用估算值）
    nextTick(() => positionPanel());
    // capture 捕获所有祖先滚动，保证面板跟随按钮位置
    window.addEventListener('resize', positionPanel);
    document.addEventListener('scroll', positionPanel, true);
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onEsc);
  } else {
    window.removeEventListener('resize', positionPanel);
    document.removeEventListener('scroll', positionPanel, true);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', positionPanel);
  document.removeEventListener('scroll', positionPanel, true);
  document.removeEventListener('click', onDocClick);
  document.removeEventListener('keydown', onEsc);
});

// ===== 显示文本 =====
const hasValue = computed(() => !!selectedDate.value);

const display = computed(() => {
  if (!hasValue.value) return props.placeholder;
  return props.mode === 'datetime' && selectedTime.value
    ? `${selectedDate.value} ${selectedTime.value}`
    : selectedDate.value;
});

/** 是否可清除（有值时显示 ✕） */
const clearable = computed(() => hasValue.value);
</script>

<template>
  <div ref="rootEl" :class="hideTrigger ? '' : 'relative inline-block'">
    <!-- 触发按钮（外观与输入框一致）。hideTrigger 时不渲染，仅作"面板"容器使用。 -->
    <button
      v-if="!hideTrigger"
      type="button"
      class="flex w-full items-center justify-between gap-2 rounded-lg border border-accent bg-surface-field transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
      :class="[
        open ? 'border-gold' : '',
        size === 'md' ? 'px-3 py-2 text-sm' : 'px-3 py-1.5 text-sm',
      ]"
      @click="toggle"
    >
      <span class="truncate" :class="hasValue ? 'text-ink' : 'text-ink-faint'">{{ display }}</span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg
          v-if="clearable"
          class="h-3.5 w-3.5 text-ink-faint transition-colors hover:text-ink"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          @click.stop="clearValue"
        >
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
        <svg class="h-4 w-4 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
        </svg>
      </span>
    </button>

    <!-- 面板挂载到 body，脱离调用方层叠上下文，避免被容器/原生控件遮挡 -->
    <Teleport to="body">
      <Transition name="picker-pop">
        <div
          v-if="open"
          ref="panelRef"
          class="picker-panel dd-keep-open-panel fixed z-[9999] rounded-2xl border border-accent bg-surface p-3 shadow-float"
          data-dd-keep-open
          :style="panelStyle"
          @click.stop
        >
          <!-- 年月导航 -->
          <div class="mb-2 flex items-center justify-between">
            <button
              type="button" class="btn-soft flex h-7 w-7 items-center justify-center p-0"
              v-tip="prevMonthLabel"
              @click="shiftMonth(-1)"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span class="text-sm font-semibold text-ink tabular-nums">{{ viewTitle }}</span>
            <button
              type="button" class="btn-soft flex h-7 w-7 items-center justify-center p-0"
              v-tip="nextMonthLabel"
              @click="shiftMonth(1)"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </div>

          <!-- 月历主体：切换月份时整体水平滑动（随方向） -->
          <Transition :name="slideDir > 0 ? 'picker-slide-next' : 'picker-slide-prev'" mode="out-in">
            <div :key="`${view.year}-${view.month}`">
              <!-- 星期表头（周一起始） -->
              <div class="mb-1 grid grid-cols-7 text-center text-xs text-ink-faint">
                <span v-for="w in weekHeaders" :key="w" class="py-1">{{ w }}</span>
              </div>

              <!-- 日网格 -->
              <div class="grid grid-cols-7 gap-0.5">
                <button
                  v-for="(d, i) in cells"
                  :key="i"
                  type="button"
                  class="picker-day flex h-9 w-full items-center justify-center rounded-full text-sm tabular-nums"
                  :class="[
                    isInView(d) ? 'text-ink' : 'text-ink-faint/40',
                    isDisabled(d) ? 'cursor-not-allowed opacity-30' : 'hover:bg-secondary',
                    isToday(d) && !isSelected(d) ? 'border border-gold text-gold' : '',
                    isSelected(d) ? 'bg-gold font-semibold text-white shadow-soft' : '',
                  ]"
                  :disabled="isDisabled(d)"
                  @click="selectDate(d)"
                >
                  {{ d.getDate() }}
                </button>
              </div>
            </div>
          </Transition>

          <!-- 日期时间模式：时分选择（自定义下拉，避免原生 select 项数限制） -->
          <div v-if="mode === 'datetime'" class="mt-3 flex items-center justify-center gap-2 border-t border-accent/60 pt-3">
            <span class="text-xs text-ink-faint">时间</span>

            <!-- 小时选择（0-23）：面板靠近视口底部，向上展开避免被屏幕裁切 -->
            <UiDropdown align="end" direction="up" :close-on-select="false" aria-label="小时" panel-class="glass-card menu w-16 rounded-xl p-1 dd-keep-open-panel" @open="scrollToActive(hourListEl, hour)">
              <template #trigger>
                <label class="flex cursor-pointer items-center gap-1 rounded-lg border border-accent bg-surface-field px-2 py-1 text-sm text-ink tabular-nums focus:border-gold focus:outline-none">
                  <span>{{ pad(hour) }}</span>
                  <svg class="h-3 w-3 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </label>
              </template>
              <ul ref="hourListEl" class="menu max-h-60 w-16 overflow-y-auto p-1">
                <li v-for="h in hourOptions" :key="h">
                  <button
                    type="button"
                    class="w-full rounded-md px-2 py-1 text-center text-sm text-ink hover:bg-secondary"
                    :class="Number(h) === hour ? 'bg-gold/20 font-semibold' : ''"
                    :data-value="h"
                    @click="hour = Number(h)"
                  >
                    {{ h }}
                  </button>
                </li>
              </ul>
            </UiDropdown>

            <span class="text-ink-faint">:</span>

            <!-- 分钟选择（0-59） -->
            <UiDropdown align="end" direction="up" :close-on-select="false" aria-label="分钟" panel-class="glass-card menu w-16 rounded-xl p-1 dd-keep-open-panel" @open="scrollToActive(minuteListEl, minute)">
              <template #trigger>
                <label class="flex cursor-pointer items-center gap-1 rounded-lg border border-accent bg-surface-field px-2 py-1 text-sm text-ink tabular-nums focus:border-gold focus:outline-none">
                  <span>{{ pad(minute) }}</span>
                  <svg class="h-3 w-3 text-ink-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </label>
              </template>
              <ul ref="minuteListEl" class="menu max-h-60 w-16 overflow-y-auto p-1">
                <li v-for="m in minuteOptions" :key="m">
                  <button
                    type="button"
                    class="w-full rounded-md px-2 py-1 text-center text-sm text-ink hover:bg-secondary"
                    :class="Number(m) === minute ? 'bg-gold/20 font-semibold' : ''"
                    :data-value="m"
                    @click="minute = Number(m)"
                  >
                    {{ m }}
                  </button>
                </li>
              </ul>
            </UiDropdown>

            <button
              type="button" class="btn-soft ml-1 px-3 py-1 text-xs"
              @click="emitValue(); close()"
            >
              确定
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* ===== 面板弹出 / 关闭：从触发按钮方向缩放淡入 ===== */
.picker-pop-enter-active {
  transition: opacity 0.24s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  transform-origin: var(--picker-origin, top left);
}
.picker-pop-enter-from {
  opacity: 0;
  transform: scale(0.95) translateY(-8px);
}
.picker-pop-leave-active {
  transition: opacity 0.14s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.14s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: var(--picker-origin, top left);
}
.picker-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(-4px);
}

/* ===== 月份切换：内容水平滑动（方向随切换按钮）===== */
.picker-slide-next-enter-active,
.picker-slide-next-leave-active,
.picker-slide-prev-enter-active,
.picker-slide-prev-leave-active {
  transition: opacity 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}
.picker-slide-next-enter-from,
.picker-slide-prev-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
.picker-slide-next-leave-to,
.picker-slide-prev-enter-from {
  opacity: 0;
  transform: translateX(-16px);
}

/* ===== 日期按钮：平滑变色 + 按下缩放反馈 ===== */
.picker-day {
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
    color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.2s cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 0.2s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.16s cubic-bezier(0.4, 0, 0.2, 1);
}
.picker-day:active:not(:disabled) {
  transform: scale(0.86);
}

/* ===== 面板轻微玻璃感 ===== */
.picker-panel {
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
</style>
