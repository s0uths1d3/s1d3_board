<script setup lang="ts">
/**
 * 设置页单个快捷键行：启用开关 + 录制按钮 + 重置按钮 + 错误提示。
 * 「全局/局部快捷键列表」与「折叠数字粘贴组」共用同一模板，从 SettingMain 收敛而来。
 */
defineProps<{
  item: {
    id: string;
    label: string;
    display: string;
    isModified: boolean;
    enabled: boolean;
  };
  /** 是否处于录制中 */
  recording: boolean;
  /** 该项的冲突等错误信息 */
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'toggle'): void;
  (e: 'record'): void;
  (e: 'reset'): void;
}>();
</script>

<template>
  <li class="flex flex-col gap-1 border-b border-accent/50 p-4 last:border-b-0">
    <div class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <!-- 独立启用/禁用开关 -->
        <UiToggleSwitch
            size="sm"
            :model-value="item.enabled"
            tip-on="点击禁用" tip-off="点击启用"
            :label="item.label"
            @change="emit('toggle')"
        />
        <div class="text-ink" :class="{ 'opacity-50': !item.enabled }">{{ item.label }}</div>
      </div>
      <div class="flex items-center gap-2">
        <button
            type="button"
            class="w-56 rounded-xl border border-accent bg-surface-field px-3 py-2 text-center font-mono text-sm font-semibold text-ink transition-all duration-300 ease-soft hover:border-gold focus:outline-none"
            :class="recording ? 'border-gold ring-1 ring-gold/60 animate-pulse' : ''"
            @click="emit('record')"
        >
          {{ recording ? '按下新快捷键… (Esc 取消)' : item.display }}
        </button>
        <button
            v-if="item.isModified"
            type="button"
            class="btn-soft p-2"
            v-tip="'重置为默认'"
            @click="emit('reset')"
        >
          <svg class="size-[1.2em]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
    </div>
    <div v-if="error" class="text-xs text-danger">
      {{ error }}
    </div>
  </li>
</template>
