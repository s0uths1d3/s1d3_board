<script setup lang="ts">
/**
 * 设置页文本输入行：modelValue / placeholder / 保存提示各不相同，
 * 从 SettingMain 中两段仅绑定值不同的 <input> 分支收敛而来（改交互基线只动这里）。
 */
defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'save'): void;
}>();
</script>

<template>
  <input
    type="text"
    :value="modelValue"
    :placeholder="placeholder"
    class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink focus:border-gold focus:outline-none"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    @blur="emit('save')"
  />
</template>
