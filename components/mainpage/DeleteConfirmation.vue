<template>
  <div
      v-if="show"
      role="alert"
      class="glass-card fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-2xl p-6"
  >
    <div class="mb-2 flex w-full items-start gap-2">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
           class="mt-1 h-6 w-6 shrink-0 text-gold">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <div class="flex-1 font-bold text-ink">
        确定要删除吗？
      </div>
    </div>
    <div class="w-full break-words whitespace-pre-wrap rounded-xl border border-accent bg-surface-field p-2 text-left text-sm text-ink-soft">
      {{ deleteTarget?.content }}
    </div>
    <div class="mt-4 flex w-full justify-center gap-4">
      <button class="btn-soft" @click="cancel">取消</button>
      <button class="btn-gold" @click="confirm">确定</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {ClipboardData} from "~/src/Entities";

const props = defineProps<{
  show: boolean,
  deleteTarget: ClipboardData | null | undefined,
}>();

const emit = defineEmits<{
  (e: 'confirm'): void,
  (e: 'cancel'): void,
}>();

function confirm() {
  emit('confirm');
}

function cancel() {
  emit('cancel');
}
</script>
