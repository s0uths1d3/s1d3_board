<script setup lang="ts">
/**
 * 颜色选取器（ui 组件库）
 *
 * 预设色板 + 自定义色环（HSV：外环选色相、内盘选饱和度/亮度）+ 十六进制输入，
 * 风格与全局暖色主题一致（accent 描边、surface-field 底、金色选中环）。
 * 供便签配色管理、优先级等级编辑等场景使用——新增取色场景必须复用本组件。
 * 色环为纯前端实现（Pointer Events + conic-gradient），不调系统原生取色窗。
 */
import { computed, reactive, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 当前颜色（#rrggbb，v-model） */
  modelValue: string
  /** 预设色板（不传则仅提供色环 + 十六进制输入） */
  presets?: string[]
  /** 是否提供自定义取色（色环 + 十六进制输入） */
  allowCustom?: boolean
}>(), {
  presets: () => [],
  allowCustom: true,
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const HEX_RE = /^#[0-9a-fA-F]{6}$/
/** 色环打开时 hex 非法的兜底色（与历史占位一致） */
const FALLBACK_HEX = '#dcc88a'

const safeValue = computed(() => (HEX_RE.test(props.modelValue) ? props.modelValue.toLowerCase() : ''))

function update(hex: string) {
  const s = hex.trim()
  if (HEX_RE.test(s)) emit('update:modelValue', s.toLowerCase())
}

// ===================== HSV 转换（色环状态 ↔ hex） =====================

/** hex → HSV（h 0-360，s/v 0-1）；非法 hex 返回 null */
function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  if (!HEX_RE.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

/** HSV → #rrggbb（标准六扇区公式） */
function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// ===================== 色环状态与交互 =====================

const wheelOpen = ref(false);
const hsv = reactive({ h: 35, s: 0.35, v: 0.8 });

// 外部改动（预设点击 / hex 输入）同步到色环指针；拖动 emit 回流的同值不产生可见抖动
watch(() => props.modelValue, (v) => {
  if (wheelOpen.value) return;
  const p = hexToHsv(v);
  if (p) Object.assign(hsv, p);
});

function toggleWheel() {
  wheelOpen.value = !wheelOpen.value;
  if (wheelOpen.value) {
    const p = hexToHsv(props.modelValue) ?? hexToHsv(FALLBACK_HEX)!;
    Object.assign(hsv, p);
  }
}

function emitHsv() {
  update(hsvToHex(hsv.h, hsv.s, hsv.v));
}

/** 环容器几何：外径 128、环宽 14 → 色相指针落在环中线（半径 57） */
const RING_R = 57;
const huePointerStyle = computed(() => {
  const rad = (hsv.h * Math.PI) / 180;
  const x = 64 + RING_R * Math.sin(rad);
  const y = 64 - RING_R * Math.cos(rad);
  return {
    left: `${x}px`,
    top: `${y}px`,
    backgroundColor: `hsl(${hsv.h} 100% 50%)`,
  };
});

const svStyle = computed(() => ({
  background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
}));

const svPointerStyle = computed(() => ({
  left: `${hsv.s * 100}%`,
  top: `${(1 - hsv.v) * 100}%`,
  backgroundColor: hsvToHex(hsv.h, hsv.s, hsv.v),
}));

const wheelRef = ref<HTMLElement | null>(null);
const svRef = ref<HTMLElement | null>(null);

/** 拖动进行中的取值函数（pointerdown 设置，pointerup 清空；capture 保证 move 不丢） */
let dragging: ((e: PointerEvent) => void) | null = null;

function onDown(e: PointerEvent, fn: (e: PointerEvent) => void) {
  dragging = fn;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  fn(e);
}

function onMove(e: PointerEvent) {
  if (!dragging) return;
  e.preventDefault();
  dragging(e);
}

function onUp() {
  dragging = null;
}

/** 环上取色相：指针相对中心的角度（顶部 0° 顺时针，与 conic-gradient from 0deg 对齐） */
function pointHue(e: PointerEvent) {
  const el = wheelRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width / 2);
  const dy = e.clientY - (rect.top + rect.height / 2);
  hsv.h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  emitHsv();
}

/** 内盘取 SV：包围盒归一坐标（背景渐变同一映射，圆形裁剪只影响可视） */
function pointSv(e: PointerEvent) {
  const el = svRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  hsv.s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  hsv.v = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
  emitHsv();
}

</script>

<template>
  <div class="space-y-2">
    <!-- 预设色板 -->
    <div v-if="presets.length > 0" class="grid grid-cols-5 gap-1.5">
      <button
          v-for="c in presets"
          :key="c"
          type="button"
          class="h-6 w-full rounded-md border transition-transform hover:scale-105"
          :class="safeValue === c.toLowerCase() ? 'border-ink ring-1 ring-ink/40' : 'border-white/50'"
          :style="{ backgroundColor: c }"
          @click="update(c)"
      />
    </div>

    <!-- 自定义色环（HSV：外环色相 + 内盘饱和度/亮度），暖色主题同款描边 -->
    <div v-if="allowCustom && wheelOpen" class="rounded-xl border border-accent/50 bg-surface-field/60 p-2">
      <div
          ref="wheelRef"
          class="relative mx-auto h-32 w-32 cursor-crosshair rounded-full select-none"
          style="touch-action: none; background: conic-gradient(from 0deg, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%))"
          @pointerdown="onDown($event, pointHue)"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointercancel="onUp"
      >
        <!-- 内盘：当前色相的饱和度（右）× 亮度（上）渐变 -->
        <div
            ref="svRef"
            class="absolute left-1/2 top-1/2 h-[88px] w-[88px] -translate-x-1/2 -translate-y-1/2 cursor-crosshair overflow-hidden rounded-full border border-white/60 shadow-xs"
            style="touch-action: none"
            @pointerdown="onDown($event, pointSv)"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
        >
          <div class="absolute inset-0" :style="svStyle"></div>
          <!-- SV 指针：内盘当前色点 -->
          <div
              class="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
              :style="svPointerStyle"
          ></div>
        </div>
        <!-- 色相指针：环中线白边小圆 -->
        <div
            class="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            :style="huePointerStyle"
        ></div>
      </div>
    </div>

    <!-- 自定义：色点点击展开/收起色环 + 十六进制输入，两入口实时同步 -->
    <div v-if="allowCustom" class="flex items-center gap-2">
      <button
          type="button"
          class="relative h-6 w-6 shrink-0 cursor-pointer rounded-md border border-white/60 shadow-xs transition-transform hover:scale-110"
          :class="wheelOpen ? 'ring-2 ring-gold' : ''"
          :style="{ backgroundColor: safeValue || FALLBACK_HEX }"
          :title="safeValue || FALLBACK_HEX"
          @click="toggleWheel"
      ></button>
      <input
          type="text"
          maxlength="7"
          spellcheck="false"
          placeholder="#c4a77d"
          :value="safeValue"
          class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2 py-1 text-xs tabular-nums text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
          @change="update(($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>
