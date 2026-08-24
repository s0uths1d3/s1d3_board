<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';

interface MenuItem {
  label: string;
  danger?: boolean;
  action: () => void;
}

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  items: MenuItem[];
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const menuRef = ref<HTMLElement | null>(null);
const menuStyle = ref<{ left: string; top: string }>({ left: '0px', top: '0px' });

function close() {
  emit('close');
}

/** 点击菜单外部关闭（捕获阶段，避免菜单内点击也被误判） */
function onDocMouseDown(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    close();
  }
}
/** Esc 关闭 */
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      window.addEventListener('mousedown', onDocMouseDown, true);
      window.addEventListener('keydown', onDocKeyDown, true);
      // 渲染后校正位置：不超出视口
      requestAnimationFrame(() => {
        if (!menuRef.value) return;
        const rect = menuRef.value.getBoundingClientRect();
        const pad = 8;
        const left = Math.min(props.x, window.innerWidth - rect.width - pad);
        const top = Math.min(props.y, window.innerHeight - rect.height - pad);
        menuStyle.value = {
          left: `${Math.max(pad, left)}px`,
          top: `${Math.max(pad, top)}px`,
        };
      });
    } else {
      window.removeEventListener('mousedown', onDocMouseDown, true);
      window.removeEventListener('keydown', onDocKeyDown, true);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDocMouseDown, true);
  window.removeEventListener('keydown', onDocKeyDown, true);
});
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="fixed z-[100] min-w-40 rounded-2xl border border-accent bg-surface-field/95 p-1.5 shadow-float backdrop-blur"
      :style="menuStyle"
      @contextmenu.prevent
    >
      <button
        v-for="(item, i) in items"
        :key="i"
        type="button"
        class="flex w-full items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm transition-colors duration-200 ease-soft"
        :class="item.danger ? 'text-[rgba(176,92,92,1)] hover:bg-[rgba(176,92,92,0.12)]' : 'text-ink hover:bg-secondary'"
        @click="item.action(); close()"
      >
        {{ item.label }}
      </button>
    </div>
  </teleport>
</template>
