<script setup lang="ts">
/**
 * 颜色选取器（ui 组件库）
 *
 * 预设色板 + 十六进制输入，风格与全局暖色主题一致
 * （accent 描边、surface-field 底、金色选中环）。
 * 供便签配色管理、优先级等级编辑等场景使用——新增取色场景必须复用本组件。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 当前颜色（#rrggbb，v-model） */
  modelValue: string
  /** 预设色板（不传则仅提供十六进制输入） */
  presets?: string[]
  /** 是否提供十六进制输入（自定义任意颜色） */
  allowCustom?: boolean
}>(), {
  presets: () => [],
  allowCustom: true,
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const HEX_RE = /^#[0-9a-fA-F]{6}$/

const safeValue = computed(() => (HEX_RE.test(props.modelValue) ? props.modelValue.toLowerCase() : ''))

function update(hex: string) {
  const s = hex.trim()
  if (HEX_RE.test(s)) emit('update:modelValue', s.toLowerCase())
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

    <!-- 自定义：十六进制输入（当前颜色以色点实时预览） -->
    <div v-if="allowCustom" class="flex items-center gap-2">
      <span
          class="h-6 w-6 shrink-0 rounded-md border border-white/60 shadow-sm"
          :style="{ backgroundColor: safeValue || '#dcc88a' }"
      />
      <input
          type="text"
          maxlength="7"
          spellcheck="false"
          placeholder="#c4a77d"
          :value="safeValue"
          class="min-w-0 flex-1 rounded-md border border-accent bg-surface-field px-2 py-1 text-xs tabular-nums text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
          @change="update(($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>
