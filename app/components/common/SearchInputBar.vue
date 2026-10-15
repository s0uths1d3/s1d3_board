<script setup lang="ts">
/**
 * 通用搜索输入行（剪贴板列表 / 全局搜索面板共用，样式单一来源）：
 * 放大镜 + 输入框（list-search-input 联动搜索高亮）+ [前置按钮 slot] + 高级搜索开关（可选）
 * + 语法说明（?）+ 清空/关闭（✕）+ [尾部按钮 slot]。
 * 容器样式由使用方通过 attrs 提供（剪贴板 = glass-card 圆角行；面板内 = 底边框行），
 * ✕ 默认语义为清空（emit clear），全局搜索面板将其用作关闭入口（tipClear 自定义提示）。
 */
import { ref } from 'vue';
import { useI18n } from '~/composables/useI18n';
import SearchHelpPanel from './SearchHelpPanel.vue';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  /** 传入即显示高级搜索开关（受控）；不传则隐藏（无词法切换的场景） */
  advanced?: boolean;
  /** 是否显示 ? 语法说明入口（全局搜索面板不展示，剪贴板默认展示） */
  showHelp?: boolean;
  /** ✕ 按钮提示文案（清空 / 关闭，随使用方语义） */
  tipClear: string;
}>(), { showHelp: true });

const emit = defineEmits<{
  'update:modelValue': [value: string];
  'update:advanced': [value: boolean];
  /** ✕ 点击：清空搜索词（剪贴板）或关闭面板（全局搜索） */
  clear: [];
}>();

const inputEl = ref<HTMLInputElement | null>(null);

defineExpose({ focus: () => inputEl.value?.focus() });
</script>

<template>
  <div class="relative flex w-full items-center gap-2">
    <svg
        class="h-5 w-5 shrink-0 text-ink-faint"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
    >
      <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"
      />
    </svg>
    <input
        ref="inputEl"
        :value="modelValue"
        type="text"
        :placeholder="placeholder"
        class="list-search-input w-full bg-transparent text-ink placeholder:text-ink-faint focus:outline-hidden"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <!-- 前置按钮位：剪贴板的收藏 / 图片筛选等列表专属开关 -->
    <slot name="prepend" />
    <button
        v-if="advanced !== undefined"
        type="button"
        class="btn-soft btn-circle p-0 ml-1"
        :class="advanced ? 'text-gold bg-gold/15 border-gold/60' : 'text-ink-faint'"
        v-tip="t(advanced ? 'clip.advanced_off' : 'clip.advanced_on')"
        @click="emit('update:advanced', !advanced)"
    >
      <!-- 高级搜索：空格拆词 AND + 引号整句 + * ? 通配符 + | OR；关闭后整串按字面匹配 -->
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        <path d="M19 15l.9 2.4L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.6L19 15z" />
      </svg>
    </button>
    <!-- 高级搜索语法说明入口：共享 SearchHelpPanel（? 按钮 + 面板自治；showHelp=false 时隐藏） -->
    <SearchHelpPanel v-if="showHelp" />
    <button
        type="button"
        class="btn-soft btn-circle p-0 ml-1"
        v-tip="tipClear"
        @click="emit('clear')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
    <!-- 尾部按钮位：剪贴板的应用筛选漏斗等 -->
    <slot />
  </div>
</template>
