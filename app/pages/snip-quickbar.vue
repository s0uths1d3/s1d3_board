<script setup lang="ts">
/**
 * 截图快速访问条（/snip-quickbar）
 *
 * 确认截图后由 snipManager 预热的隐藏小窗（固定 label `snip-quickbar`）显示，
 * 贴在选区下方（下方不够翻到上方，整体钳制在显示器内）。动作：贴图 / 上传 /
 * 打开历史（文字识别需要在截图编辑器里预览确认，故只保留在覆盖窗工具条）。
 * 动作全部 emit 给主窗口执行（抑制标记、岛、数据库都在主窗口上下文，
 * 子窗口各自独立的模块状态无法共享）。
 *
 * 生命周期：4 秒无交互自动隐藏（悬停暂停计时，移出重新计时）；Esc 立即隐藏；
 * 触发任一动作后由主窗口收起。窗口不抢焦点（show 不 setFocus），不打断用户粘贴。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useHead } from '#imports';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import { useTransparentWindow } from '~/composables/useTransparentWindow';
import { useI18n } from '~/composables/useI18n';
import { isTauri } from '~/utils/env';

useHead({
  style: [{ innerHTML: 'html, body { background: transparent !important; background-image: none !important; }' }],
});

const { t } = useI18n();

/** 本次截图是否配置了上传地址（未配置隐藏上传按钮，窗口宽度已由主窗口按此计算） */
const canUpload = ref(false);
/** 是否已有可用截图引用（数据到达前按钮禁用） */
const ready = ref(false);

const AUTO_HIDE_MS = 4000;
const HOVER_HIDE_MS = 2500;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let unlisteners: Array<() => void> = [];

function startHideTimer(ms = AUTO_HIDE_MS): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { hide(); }, ms);
}

function clearHideTimer(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

/** 请求主窗口收起（窗口常驻复用，不 close） */
function hide(): void {
  clearHideTimer();
  void emit('snip-quickbar:hide').catch(() => {});
}

/** 点击动作：交给主窗口执行（贴图 / 上传 / 历史），主窗口执行前自行收起本窗
 *  （不在此处发 hide：两条事件并发时若 hide 先到会清空上下文导致动作被丢弃） */
function act(action: 'pin' | 'upload' | 'history'): void {
  if (!ready.value) return;
  clearHideTimer();
  void emit('snip-quickbar:action', { action }).catch(() => {});
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hide();
}

onMounted(() => {
  useTransparentWindow();
  window.addEventListener('keydown', onKeydown);
  if (!isTauri()) return;
  const win = getCurrentWebviewWindow();
  // 窗口级监听（禁止全局 listen：多窗口串扰）
  win.listen<{ fileRef: string; width: number; height: number; upload: boolean }>('snip-quickbar:data', (ev) => {
    canUpload.value = Boolean(ev.payload?.upload);
    ready.value = Boolean(ev.payload?.fileRef);
    startHideTimer();
  }).then((un) => unlisteners.push(un)).catch(() => {});
  // 主窗口隐藏本窗时不清理状态（下次数据到达重置）
  startHideTimer(8000);
  // ready 握手：主窗口收到才投数据并 show（隐藏创建不闪白）
  void emit('snip-quickbar:ready', win.label).catch(() => {});
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  clearHideTimer();
  for (const u of unlisteners) u();
  unlisteners = [];
});
</script>

<template>
  <div
      class="flex h-screen w-screen cursor-default items-center justify-center gap-1 rounded-lg border border-white/15 bg-[#1e1e22]/95 px-1.5 shadow-xl"
      @mouseenter="clearHideTimer"
      @mouseleave="startHideTimer(HOVER_HIDE_MS)"
  >
    <!-- 贴图：钉在桌面（置顶小窗） -->
    <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-white/85 hover:bg-white/12 hover:text-gold disabled:opacity-40"
        v-tip="t('snip.btn_pin')"
        :disabled="!ready"
        @click="act('pin')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 17v5" /><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
      </svg>
    </button>
    <!-- 文字识别不在此处：识别结果需要在截图编辑器里预览确认后才会复制 -->
    <!-- 上传：POST 到配置地址，链接复制（未配置地址时隐藏） -->
    <button
        v-if="canUpload"
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-white/85 hover:bg-white/12 hover:text-gold disabled:opacity-40"
        v-tip="t('snip.btn_upload')"
        :disabled="!ready"
        @click="act('upload')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      </svg>
    </button>
    <!-- 打开历史：截图已入剪贴板历史，直达查看 -->
    <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-white/85 hover:bg-white/12 hover:text-gold disabled:opacity-40"
        v-tip="t('snip.quick_history')"
        :disabled="!ready"
        @click="act('history')"
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" />
      </svg>
    </button>
  </div>
</template>
