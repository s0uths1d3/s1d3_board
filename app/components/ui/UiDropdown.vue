<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';

/**
 * 标准下拉/弹出面板（ui 组件库）
 *
 * 定位机制：面板统一 Teleport 到 body 并以 fixed 定位（坐标由触发器矩形实时计算），
 * 与调用方容器的 overflow 裁切、层叠上下文、hover transform 彻底解耦；
 * 支持 水平对齐（start/center/end）、展开方向（down/up，空间不足自动上翻）、
 * 视口边界收进（永不超出窗口边缘被裁切）。
 * 统一交互：点击触发器开/关（再次点击收起）、点击外部收起、Escape 收起、
 * 选择后自动收起（可配置）、入场动画（check-pop）。
 */
const props = withDefaults(defineProps<{
  /** 面板水平对齐：start 左对齐触发器 / center 居中于触发器 / end 右对齐触发器 */
  align?: 'start' | 'center' | 'end';
  /** 展开方向：down 优先下方 / up 优先上方；空间不足时均自动翻转到另一侧 */
  direction?: 'down' | 'up';
  /** 面板宽度撑满触发器宽度 */
  matchTriggerWidth?: boolean;
  /** 附加到面板的类（宽度、圆角、内边距等，如 'glass-card menu w-32 rounded-2xl p-2'） */
  panelClass?: string;
  /** 点击面板内容后自动收起（菜单语义）；面板内带 data-dd-keep-open 的元素点击不收起 */
  closeOnSelect?: boolean;
  /** 禁用：触发器不响应 */
  disabled?: boolean;
  /** 无障碍标签 */
  ariaLabel?: string;
}>(), {
  align: 'start',
  direction: 'down',
  matchTriggerWidth: false,
  panelClass: '',
  closeOnSelect: true,
  disabled: false,
  ariaLabel: '',
});

const emit = defineEmits<{
  (e: 'select', e2: MouseEvent): void;
  (e: 'open'): void;
  (e: 'close'): void;
}>();

/** 开关状态：父级可 v-model:open 受控，也可完全内部管理 */
const open = defineModel<boolean>('open', { default: false });

const rootEl = ref<HTMLDivElement | null>(null);
const triggerEl = ref<HTMLDivElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
/** 面板 fixed 定位样式（由触发器矩形计算，含视口收进） */
const panelStyle = ref<Record<string, string>>({});

const MARGIN = 8;

function toggle() {
  if (props.disabled) return;
  open.value = !open.value;
}

function close() {
  if (!open.value) return;
  open.value = false;
}

/**
 * 面板定位：以触发器矩形为锚，按对齐/方向计算；越界时水平收进视口、
 * 垂直翻转到空间更充裕的一侧。失败时静默保持原位置，不阻塞面板显示。
 */
function positionPanel() {
  const trigger = triggerEl.value;
  const panel = panelEl.value;
  if (!trigger || !panel) return;
  try {
    const rect = trigger.getBoundingClientRect();
    const pw = panel.offsetWidth || 0;
    const ph = panel.offsetHeight || 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    if (props.align === 'end') left = rect.right - pw;
    if (props.align === 'center') left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(MARGIN, Math.min(left, vw - pw - MARGIN));

    const spaceBelow = vh - rect.bottom - MARGIN;
    const spaceAbove = rect.top - MARGIN;
    let up = props.direction === 'up';
    if (!up && spaceBelow < ph && spaceAbove > spaceBelow) up = true;
    let top = up ? rect.top - ph - 4 : rect.bottom + 4;
    top = Math.max(MARGIN, Math.min(top, vh - ph - MARGIN));

    panelStyle.value = {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      ...(props.matchTriggerWidth ? { width: `${Math.round(rect.width)}px` } : {}),
      '--pop-origin': up ? 'bottom' : 'top',
      '--pop-shift': up ? '-6px' : '6px',
    };
  } catch { /* 定位失败保持原位置 */ }
}

/** 点击面板内容：通知 select；菜单语义下自动收起（data-dd-keep-open 除外） */
function onPanelClick(e: MouseEvent) {
  emit('select', e);
  if (!props.closeOnSelect) return;
  const keep = (e.target as HTMLElement | null)?.closest?.('[data-dd-keep-open]');
  if (keep) return;
  close();
}

function onDocPointerDown(e: PointerEvent) {
  const t = e.target as Node | null;
  if (!t) return;
  // 触发器点击由 toggle 处理（再点收起），这里只管外部点击收起
  if (rootEl.value?.contains(t)) return;
  if (panelEl.value?.contains(t)) return;
  close();
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

/** 视口变化（滚动/缩放）时跟随重定位，保持面板锚在触发器旁 */
function onViewportChange() {
  if (open.value) positionPanel();
}

watch(open, (v) => {
  if (props.disabled && v) {
    open.value = false;
    return;
  }
  if (v) {
    emit('open');
    nextTick(() => positionPanel());
    window.addEventListener('resize', onViewportChange);
    document.addEventListener('scroll', onViewportChange, true);
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeydown);
  } else {
    emit('close');
    window.removeEventListener('resize', onViewportChange);
    document.removeEventListener('scroll', onViewportChange, true);
    document.removeEventListener('pointerdown', onDocPointerDown);
    document.removeEventListener('keydown', onDocKeydown);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange);
  document.removeEventListener('scroll', onViewportChange, true);
  document.removeEventListener('pointerdown', onDocPointerDown);
  document.removeEventListener('keydown', onDocKeydown);
});
</script>

<template>
  <div ref="rootEl" class="relative">
    <!-- 触发器：统一接管点击开/关（再次点击收起），键盘可达 -->
    <div
        ref="triggerEl"
        class="cursor-pointer outline-none"
        role="button"
        :aria-haspopup="true"
        :aria-expanded="open"
        :aria-label="ariaLabel || undefined"
        :class="disabled ? 'pointer-events-none opacity-60' : ''"
        @click="toggle"
        @keydown.enter.prevent="toggle"
        @keydown.space.prevent="toggle"
    >
      <slot name="trigger" :open="open" :toggle="toggle" />
    </div>

    <!-- 面板：Teleport 到 body + fixed 定位，规避 overflow 裁切/层叠上下文/hover transform -->
    <Teleport to="body">
      <div v-if="open" class="fixed z-[9999]" :style="panelStyle">
        <Transition name="check-pop" appear>
          <div
              ref="panelEl"
              :class="panelClass"
              class="outline-none"
              @click="onPanelClick"
          >
            <slot :close="close" :open="open" />
          </div>
        </Transition>
      </div>
    </Teleport>
  </div>
</template>
