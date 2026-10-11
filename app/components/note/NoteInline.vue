<template>
  <!-- 行内 token 渲染：bold/italic/strike/code 包裹元素 + 搜索高亮底色；无 v-html、无 XSS 面 -->
  <template v-for="(tk, i) in tokens" :key="i">
    <mark v-if="tk.hl" class="rounded-sm bg-gold/35 text-inherit" :class="markClass">{{ tk.text }}</mark>
    <b v-else-if="tk.type === 'bold'">{{ tk.text }}</b>
    <i v-else-if="tk.type === 'italic'">{{ tk.text }}</i>
    <del v-else-if="tk.type === 'strike'" class="opacity-70">{{ tk.text }}</del>
    <code v-else-if="tk.type === 'code'" class="rounded bg-black/10 px-1 py-px font-mono text-[0.9em]">{{ tk.text }}</code>
    <template v-else>{{ tk.text }}</template>
  </template>
</template>

<script setup lang="ts">
import type { InlineToken } from '~/src/note/markdown'

defineProps<{
  /** 行内 token 序列（renderNote 产出，可选已注入搜索高亮） */
  tokens: InlineToken[]
  /** 高亮 mark 的额外类（由调用方按便签配色微调，可选） */
  markClass?: string
}>()
</script>
