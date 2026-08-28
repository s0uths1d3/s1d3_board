<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';

/**
 * 标准下拉/弹出面板（ui 组件库）
 *
 * 统一交互：点击触发器开/关（再次点击收起）、点击外部收起、Escape 收起、
 * 选择后自动收起（可配置），并统一入场动画（check-pop）。
 * 替代此前 CSS :focus-within 下拉与各组件手写的 JS 状态下拉——
 * 新代码禁止再手写同类结构，统一使用本组件。
 */
const props = withDefaults(defineProps<{
  /** 面板水平对齐：start 左对齐 / center 居中于触发器 / end 右对齐 */
  align?: 'start' | 'center' | 'end';
  /** 展开方向：down 触发器下方 / up 上方 / auto 优先下方、空间不足翻上方（teleport 模式生效） */
  direction?: 'down' | 'up' | 'auto';
  /** 面板 Teleport 到 body 并用 fixed 定位：调用方容器有 overflow 裁切/层叠上下文时使用 */
  teleport?: boolean;
  /** teleport 模式：面板宽度撑满触发器宽度 */
  matchTriggerWidth?: boolean;
  /** 附加到面板的类（宽度、圆角、内边距等，如 'menu w-32 rounded-2xl p-2'） */
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
  teleport: false,
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
/** teleport 模式的面板 fixed 定位样式 */
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

/** 内联模式面板定位类（外层仅定位不参与动画，避免 transform 冲突） */
const inlinePosClass = computed(() => [
  props.align === 'end' ? 'right-0' : props.align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0',
  props.direction === 'up' ? 'bottom-full mb-2' : 'top-full mt-2',
]);

/**
 * teleport 模式定位：以触发器矩形为锚，按对齐/方向计算，越界翻转并收进视口。
 * 失败时静默保持原样式，不阻塞面板显示。
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

    let up = props.direction === 'up';
    if (props.direction === 'auto') {
      const spaceBelow = vh - rect.bottom - MARGIN;
      const spaceAbove = rect.top - MARGIN;
      up = spaceBelow < ph && spaceAbove > spaceBelow;
    }
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
  if (props.teleport && panelEl.value?.contains(t)) return;
  close();
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

function onViewportChange() {
  if (props.teleport) positionPanel();
}

watch(open, (v) => {
  if (props.disabled && v) {
    open.value = false;
    return;
  }
  if (v) {
    emit('open');
    nextTick(() => {
      if (props.teleport) positionPanel();
    });
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

    <!-- teleport 模式：fixed 定位，规避调用方 overflow 裁切与层叠上下文限制 -->
    <Teleport to="body">
      <div v-if="teleport && open" class="fixed z-[9999]" :style="panelStyle">
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

    <!-- 内联模式：绝对定位于触发器附近 -->
    <div v-if="!teleport && open" class="absolute z-50" :class="inlinePosClass">
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
  </div>
</template>
