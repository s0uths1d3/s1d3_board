<template>
  <!-- 首次使用引导层：主窗口内全屏遮罩 + 分步轮播卡片（fixed 相对 viewport，Escape/跳过随时退出） -->
  <div v-if="visible" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-6">
    <div class="glass-card w-full max-w-md rounded-2xl p-6 shadow-float">
      <!-- 顶部：步骤进度 + 跳过入口（任何一步都可整体退出，不强迫走完） -->
      <div class="mb-4 flex items-center justify-between">
        <span class="text-xs text-ink-faint">{{ t('onboarding.step_indicator', { current: step + 1, total: STEPS.length }) }}</span>
        <button type="button" class="text-xs text-ink-faint transition-colors hover:text-ink" @click="finish">
          {{ t('onboarding.skip') }}
        </button>
      </div>
      <!-- 步骤内容：key 切换驱动过渡动画 -->
      <Transition name="onb-fade" mode="out-in">
        <div :key="step">
          <h2 class="mb-2 text-lg font-semibold text-ink">{{ t(current.title) }}</h2>
          <p class="text-sm leading-relaxed text-ink-soft">{{ t(current.body) }}</p>
        </div>
      </Transition>
      <!-- 底部：圆点指示 + 翻页控制（第一步无上一步，最后一步变完成） -->
      <div class="mt-6 flex items-center justify-between">
        <div class="flex gap-1.5">
          <span v-for="(s, i) in STEPS" :key="i" class="h-1.5 w-1.5 rounded-full transition-colors"
                :class="i === step ? 'bg-gold' : 'bg-surface-field'" />
        </div>
        <div class="flex gap-2">
          <button v-if="step > 0" type="button" class="btn-soft" @click="step--">
            {{ t('onboarding.prev') }}
          </button>
          <button type="button" class="btn-soft text-gold" @click="step < STEPS.length - 1 ? step++ : finish()">
            {{ step < STEPS.length - 1 ? t('onboarding.next') : t('onboarding.done') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 首次使用引导层（分步轮播，7 步）：欢迎与唤出 → 剪贴板/常用剪贴板 → 待办便签 →
 * 统计与应用时长 → 灵动岛 → 智能剪贴板 → 个性化与回看入口。
 * - 门控：KV first_run_done !== '1' 时主窗口挂载后自动弹出（读失败不弹，避免阻塞主界面）；
 * - 完成/跳过均落 KV '1'（幂等，回看后再完成只是重复写入）；
 * - 回看：设置页「回看使用引导」入口派发 bus 'onboarding:replay' → 重置到第一步重新弹出。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { isTauri } from '~/utils/env';
import dbService from '~/src/db/dbService';
import { bus } from '~/src/core/events';
import { useI18n } from '~/composables/useI18n';

const { t } = useI18n();

/** 轮播步骤清单（i18n key 引用；文案见 assets/lang/*.toml [onboarding]） */
const STEPS = [
  { title: 'onboarding.step1_title', body: 'onboarding.step1_body' },
  { title: 'onboarding.step2_title', body: 'onboarding.step2_body' },
  { title: 'onboarding.step3_title', body: 'onboarding.step3_body' },
  { title: 'onboarding.step4_title', body: 'onboarding.step4_body' },
  { title: 'onboarding.step5_title', body: 'onboarding.step5_body' },
  { title: 'onboarding.step6_title', body: 'onboarding.step6_body' },
  { title: 'onboarding.step7_title', body: 'onboarding.step7_body' },
] as const;

const FIRST_RUN_KEY = 'first_run_done';

const visible = ref(false);
const step = ref(0);
const current = computed(() => STEPS[step.value] ?? STEPS[0]);
let unsubReplay: (() => void) | null = null;

onMounted(async () => {
  // 回看入口（设置页）：重置到第一步并弹出；先注册保证早于 KV 异步读取也能响应
  unsubReplay = bus.on('onboarding:replay', () => {
    step.value = 0;
    visible.value = true;
  });
  if (!isTauri()) return;
  try {
    if ((await dbService.getKeyValue(FIRST_RUN_KEY)) !== '1') {
      visible.value = true;
    }
  } catch { /* KV 读取失败：不弹引导，下次启动再试 */ }
});

onBeforeUnmount(() => {
  unsubReplay?.();
  unsubReplay = null;
});

/** 完成/跳过：收起并标记已完成（失败容忍——下次启动会再弹一次，无害） */
function finish() {
  visible.value = false;
  if (isTauri()) {
    dbService.setKeyValue(FIRST_RUN_KEY, '1').catch(() => { /* 落库失败容忍 */ });
  }
}
</script>

<style scoped>
.onb-fade-enter-active,
.onb-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.onb-fade-enter-from {
  opacity: 0;
  transform: translateX(12px);
}
.onb-fade-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}
</style>
