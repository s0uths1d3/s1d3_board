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
      <!-- 步骤内容：key 切换驱动过渡动画；winv 交互步在文案下方渲染接管选项区 -->
      <Transition name="onb-fade" mode="out-in">
        <div :key="step">
          <h2 class="mb-2 text-lg font-semibold text-ink">{{ t(current.title) }}</h2>
          <p class="text-sm leading-relaxed text-ink-soft">{{ t(current.body) }}</p>
          <!-- 全局唤起键设置步（非 macOS）：推荐 Alt+V（Win+V 被系统占用无法接管，见 takeoverWake） -->
          <div v-if="current.interactive === 'wake'" class="mt-4 space-y-2">
            <div class="flex gap-2">
              <button
                  type="button"
                  class="btn-gold flex h-9 flex-1 items-center justify-center text-sm disabled:opacity-60"
                  :disabled="wakeState === 'busy'"
                  @click="takeoverWake"
              >
                {{ t('onboarding.wake_use') }}
              </button>
              <button
                  type="button"
                  class="btn-soft h-9 flex-1 text-sm"
                  :disabled="wakeState === 'busy'"
                  @click="step++"
              >
                {{ t('onboarding.wake_keep') }}
              </button>
            </div>
            <p
                v-if="wakeState === 'ok' || wakeState === 'failed'"
                class="text-xs"
                :class="wakeState === 'ok' ? 'text-gold' : 'text-danger'"
            >
              {{ t(wakeState === 'ok' ? 'onboarding.wake_success' : 'onboarding.wake_failed') }}
            </p>
          </div>
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
 * 首次使用引导层（分步轮播，基础 7 步；非 macOS 额外含唤起键设置步共 8 步）：欢迎与唤出 →
 * [唤起键设置] → 剪贴板/常用剪贴板 → 待办便签 → 统计与应用时长 → 灵动岛 → 智能剪贴板 → 个性化与回看入口。
 * - 门控：KV first_run_done !== '1' 时主窗口挂载后自动弹出（读失败不弹，避免阻塞主界面）；
 * - 完成/跳过均落 KV '1'（幂等，回看后再完成只是重复写入）；
 * - 唤起键设置步（非 macOS）：注册全局 Alt+V 为唤出键（updateShortcutKey 注册，失败自动回滚
 *   Ctrl+I）；macOS 无对应空闲组合且 Cmd+V 不可全局拦截，不显示；
 * - 回看：设置页「回看使用引导」入口派发 bus 'onboarding:replay' → 重置到第一步重新弹出。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { isTauri } from '~/utils/env';
import dbService from '~/src/db/dbService';
import { bus } from '~/src/core/events';
import { useI18n } from '~/composables/useI18n';
import { getOsTypeFromNavigator } from '~/utils/systemOS';
import { initShortcuts, updateShortcutKey } from '~/src/commands/shortcuts/InitShortcuts';

const { t } = useI18n();

/** 轮播步骤清单（i18n key 引用；文案见 assets/lang/*.toml [onboarding]）；
 *  interactive: 'winv' 为 Windows 专属交互步（接管系统 Win+V） */
const BASE_STEPS = [
  { title: 'onboarding.step1_title', body: 'onboarding.step1_body' },
  { title: 'onboarding.step2_title', body: 'onboarding.step2_body' },
  { title: 'onboarding.step3_title', body: 'onboarding.step3_body' },
  { title: 'onboarding.step4_title', body: 'onboarding.step4_body' },
  { title: 'onboarding.step5_title', body: 'onboarding.step5_body' },
  { title: 'onboarding.step6_title', body: 'onboarding.step6_body' },
  { title: 'onboarding.step7_title', body: 'onboarding.step7_body' },
] as const;

type OnboardingStep = { title: string; body: string; interactive?: 'wake' };

/** 排除 macOS：无系统剪贴板历史可对照，且 Cmd+V 全局注册会毁掉系统粘贴；
 *  Windows/Linux 显示唤起键设置步（推荐 Alt+V，Win+V 被系统占用见 takeoverWake 注释） */
const IS_MAC = getOsTypeFromNavigator() === 'Darwin';
const STEPS: readonly OnboardingStep[] = IS_MAC
    ? BASE_STEPS
    : [
        BASE_STEPS[0],
        { title: 'onboarding.wake_title', body: 'onboarding.wake_body', interactive: 'wake' },
        ...BASE_STEPS.slice(1),
      ];

const FIRST_RUN_KEY = 'first_run_done';

const visible = ref(false);
const step = ref(0);
/** 唤起键设置步状态：busy 防重复点击；ok/failed 展示结果文案 */
const wakeState = ref<'idle' | 'busy' | 'ok' | 'failed'>('idle');

/** 注册全局唤起键 Alt+V（updateShortcutKey 内含冲突检测/失败回滚/落库）。
 *  注：不提供 Win+V 选项——Windows 11 系统已通过 RegisterHotKey 占用 Win+V（实测
 *  ERROR_HOTKEY_ALREADY_REGISTERED），Tauri global-shortcut 的 RegisterHotKey 路径
 *  无法接管；Ditto/AHK 能覆盖是因走低级键盘钩子，为此引入全局输入钩子不值得 */
async function takeoverWake() {
  if (wakeState.value === 'busy') return;
  wakeState.value = 'busy';
  try {
    await initShortcuts();
    const err = await updateShortcutKey('toggle_window', 'Alt+V');
    wakeState.value = err ? 'failed' : 'ok';
    if (!err) step.value++;
  } catch {
    wakeState.value = 'failed';
  }
}
const current = computed<OnboardingStep>(() => STEPS[step.value] ?? STEPS[0] ?? { title: '', body: '' });
let unsubReplay: (() => void) | null = null;

onMounted(async () => {
  // 回看入口（设置页）：重置到第一步并弹出；先注册保证早于 KV 异步读取也能响应
  unsubReplay = bus.on('onboarding:replay', () => {
    step.value = 0;
    wakeState.value = 'idle';
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
