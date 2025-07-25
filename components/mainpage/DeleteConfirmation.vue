<template>
  <div
      v-if="show"
      role="alert"
      class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
         bg-base-200 p-4 rounded-xl shadow-lg z-50 max-w-[90vw] w-[400px]
         flex flex-col items-center"
  >
    <div class="flex items-start gap-2 w-full mb-2">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
           class="stroke-info h-6 w-6 shrink-0 mt-1">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <div class="flex-1 font-bold text-base">
        确定要删除吗？
      </div>
    </div>
    <div class="w-full text-sm text-left break-words whitespace-pre-wrap
              max-h-[160px] overflow-y-auto pr-1 border rounded bg-base-100 p-2">
      {{ deleteTarget?.content }}
    </div>
    <div class="flex justify-center gap-4 w-full mt-4">
      <button class="btn btn-sm" @click="cancel">取消</button>
      <button class="btn btn-sm btn-primary" @click="confirm">确定</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type {ClipboardData} from "~/src/ClipboardData";

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
