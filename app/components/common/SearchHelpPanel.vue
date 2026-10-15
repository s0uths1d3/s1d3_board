<script setup lang="ts">
/**
 * 高级搜索语法说明（? 按钮 + 弹出面板）——独立共享组件，剪贴板 / 全局搜索等
 * 任何带高级搜索输入框的场景直接复用（同一套词法、同一份说明，保证交互一致）。
 * 按钮参与父级按钮行布局（ml-1 由使用方控制），面板 absolute 定位到最近的定位祖先
 * （搜索区容器需 relative）；点击按钮/面板以外区域自动收起。
 * 文案键沿用剪贴板分区（clip.search_help_*）——词法本就与剪贴板同源，不重复造键。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from '~/composables/useI18n';

const { t } = useI18n();

const show = ref(false);
const panelRef = ref<HTMLElement | null>(null);
const btnRef = ref<HTMLElement | null>(null);

const rows = computed(() => [
  { sym: t('clip.search_help_sym_space'), desc: t('clip.search_help_space') },
  { sym: t('clip.search_help_sym_quote'), desc: t('clip.search_help_quote') },
  { sym: '*', desc: t('clip.search_help_star') },
  { sym: '?', desc: t('clip.search_help_question') },
  { sym: '|', desc: t('clip.search_help_pipe') },
]);

function onOutside(e: PointerEvent) {
  const target = e.target as Node;
  if (panelRef.value?.contains(target)) return;
  if (btnRef.value?.contains(target)) return; // 点在 ? 按钮上交给其自身 toggle
  show.value = false;
}
onMounted(() => document.addEventListener('pointerdown', onOutside, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));
</script>

<template>
  <button
      type="button"
      ref="btnRef"
      class="btn-soft btn-circle p-0 ml-1 text-sm font-bold leading-none"
      :class="show ? 'text-gold bg-gold/15 border-gold/60' : 'text-ink-faint'"
      v-tip="t('clip.search_help_btn')"
      @click="show = !show"
  ><span class="flex h-4 w-4 items-center justify-center">?</span></button>
  <div
      v-if="show"
      ref="panelRef"
      class="glass-card absolute right-1 top-full z-40 mt-1 w-80 rounded-2xl p-4 text-xs shadow-float"
  >
    <div class="mb-2 flex items-center justify-between">
      <span class="text-sm font-semibold text-gold">{{ t('clip.search_help_title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-ink" @click="show = false">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
    <ul class="space-y-1.5">
      <li v-for="row in rows" :key="row.sym" class="flex items-start gap-2">
        <code class="w-12 shrink-0 rounded-lg bg-gold/10 px-1.5 py-0.5 text-center font-mono text-[11px] leading-5 text-gold">{{ row.sym }}</code>
        <span class="leading-5 text-ink-soft">{{ row.desc }}</span>
      </li>
    </ul>
    <p class="mt-3 border-t border-gold/20 pt-2 text-[11px] leading-relaxed text-ink-faint">{{ t('clip.search_help_off') }}</p>
  </div>
</template>
