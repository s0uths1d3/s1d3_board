<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '~/utils/env';
import { useI18n } from '~/composables/useI18n';

/**
 * 智能剪贴板气泡窗口：三种模式（route.query.mode 区分）。
 *
 * - pin（?mode=pin）：单片段常驻钉住卡片，点击复制，不模拟粘贴、不自我隐藏。
 * - ring（?mode=ring&index=N）：环形布局中的一只独立气泡窗口。文本由管理器
 *   ready 握手后 emitTo('bubble:ring:data') 投递；选中高亮来自 ring:state 广播；
 *   Ctrl+悬停 / 左键点击 → ring:select-req；双击 → ring:paste-req（由管理器统一
 *   隐藏全部环形窗口并模拟粘贴）；Esc → ring:close。
 * - ring-hub（?mode=ring-hub）：环心控制盘。‹ › 切换选中、« » 翻页、✕ 整体关闭，
 *   仅发指令（ring:nav / ring:page-nav / ring:close），状态由 ring:state 广播回显。
 *
 * 窗口的创建/定位/分页显隐/层级（选中置顶）全部由 BubbleToggleCommand 管理。
 */

const route = useRoute();
const { t } = useI18n();
const mode = String(route.query.mode ?? 'list');
const isPinMode = mode === 'pin';
const isRingBubble = mode === 'ring';
const isRingHub = mode === 'ring-hub';
const ringIndex = Number(route.query.index ?? -1);

// ===== 钉住模式 =====
const pinnedText = ref('');
const pinCopied = ref(false);
let pinCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 环形气泡 =====
const ringText = ref('');
const ringSelected = ref(false);

// ===== 环心控制盘 =====
const hubSelected = ref(0);
const hubPage = ref(0);
const hubTotal = ref(0);

let unlisteners: (() => void)[] = [];

/** 钉住：把当前片段复制为独立常驻小气泡窗（ring 模式与 pin 模式均可触发） */
async function pinCurrent(): Promise<void> {
  const text = isRingBubble ? ringText.value : pinnedText.value;
  if (!isTauri() || !text) return;
  // 习惯记录：钉住也是一次强偏好信号（ring 模式下上报给管理器落库）
  if (isRingBubble) void emit('ring:habit', { index: ringIndex, action: 'pin' });
  const label = `clipboard-bubble-pin-${Date.now()}`;
  (window as any).__childOpeningUntil = Date.now() + 600;
  const unReady = await listen('bubble:pin:ready', (ev) => {
    if ((ev.payload as string | undefined) !== label) return;
    void emitTo(label, 'bubble:pin:data', { text });
    unReady();
  });
  setTimeout(() => unReady(), 5000);
  const win = new WebviewWindow(label, {
    url: '/bubble?mode=pin',
    title: 'Pinned',
    width: 300,
    height: 96,
    resizable: false,
    decorations: false,
    transparent: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 钉住卡片不抢目标应用焦点
    visible: false,
  });
  win.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 300;
  });
  win.once('tauri://error', () => {
    unReady();
  });
}

/** 钉住卡片：点击 = 复制到剪贴板（带已复制反馈，不模拟粘贴、不自我隐藏） */
async function copyPinned(): Promise<void> {
  if (!pinnedText.value) return;
  try {
    if (isTauri()) await writeTextSafe(pinnedText.value);
    else await navigator.clipboard.writeText(pinnedText.value);
  } catch { /* 忽略写失败 */ }
  pinCopied.value = true;
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  pinCopiedTimer = setTimeout(() => { pinCopied.value = false; }, 1500);
}

async function writeTextSafe(text: string): Promise<void> {
  const mod = await import('tauri-plugin-clipboard-api');
  await mod.writeText(text);
}

function closePin(): void {
  void getCurrentWindow().close();
}

// ===== 环形气泡交互 =====
/** Ctrl+悬停 / 左键点击：请求选中（已选中则不重复发） */
function ringSelect(): void {
  if (!ringSelected.value) void emit('ring:select-req', { index: ringIndex });
}
function ringPointerMove(e: PointerEvent): void {
  if (e.ctrlKey) ringSelect();
}
/** 双击：请求粘贴（管理器统一隐藏全部窗口并模拟粘贴） */
function ringPaste(): void {
  void emit('ring:paste-req', { index: ringIndex });
}
function ringClose(): void {
  void emit('ring:close');
}

// ===== 控制盘指令 =====
function hubNav(delta: number): void {
  void emit('ring:nav', { delta });
}
function hubPageNav(delta: number): void {
  void emit('ring:page-nav', { delta });
}
function hubClose(): void {
  void emit('ring:close');
}

onMounted(async () => {
  if (!isTauri()) return;
  if (isPinMode) {
    unlisteners.push(await listen<{ text: string }>('bubble:pin:data', (ev) => {
      pinnedText.value = ev.payload.text;
      void getCurrentWindow().show();
    }));
    // ready 握手：通知创建者本窗口 label（创建者随后 emitTo 定向投递文本）
    await emit('bubble:pin:ready', getCurrentWindow().label);
    return;
  }
  if (isRingBubble) {
    unlisteners.push(await listen<{ text: string }>('bubble:ring:data', (ev) => {
      ringText.value = ev.payload.text;
    }));
    unlisteners.push(await listen<{ selected: number }>('ring:state', (ev) => {
      ringSelected.value = ev.payload.selected === ringIndex;
    }));
    // ready 握手：通知管理器投递本文本
    await emit('bubble:ring:ready', getCurrentWindow().label);
    return;
  }
  if (isRingHub) {
    unlisteners.push(await listen<{ selected: number; page: number; total: number }>('ring:state', (ev) => {
      hubSelected.value = ev.payload.selected;
      hubPage.value = ev.payload.page;
      hubTotal.value = ev.payload.total;
    }));
    // ready 握手：通知管理器推送初始状态
    await emit('bubble:ring:hub-ready', getCurrentWindow().label);
    // Esc 关闭整个环（控制盘获得焦点时可用）
    window.addEventListener('keydown', onHubKeydown);
    return;
  }
});

/** 控制盘 Esc：关闭整个环（气泡 + 控制盘） */
function onHubKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    hubClose();
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onHubKeydown);
  for (const u of unlisteners) u();
  unlisteners = [];
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
});
</script>

<template>
  <!-- 钉住模式：单片段常驻卡片（灵动岛形态） -->
  <div v-if="isPinMode" class="h-screen overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
    <div class="flex items-center justify-between px-3 pt-2">
      <span class="text-[10px] uppercase tracking-wide text-ink-faint">{{ t('bubble.pinned_title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" @click="closePin">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <button type="button"
            class="block w-full px-3 pb-2 pt-1 text-left"
            @click="copyPinned">
      <p class="line-clamp-2 text-xs leading-relaxed text-ink">{{ pinnedText }}</p>
      <p class="mt-1 text-[10px]" :class="pinCopied ? 'text-gold' : 'text-ink-faint'">
        {{ pinCopied ? t('bubble.copied') : t('bubble.click_to_copy') }}
      </p>
    </button>
  </div>

  <!-- 环形气泡：独立窗口，选中高亮，Ctrl+悬停/点击选中，双击粘贴 -->
  <div v-else-if="isRingBubble"
       class="group relative h-screen cursor-pointer overflow-hidden rounded-2xl border p-3 pr-6 shadow-soft transition-all duration-200 ease-soft"
       :class="ringSelected ? 'border-gold bg-surface-field ring-1 ring-gold/60' : 'border-line bg-surface-field/90 hover:border-accent'"
       @pointermove="ringPointerMove"
       @click="ringSelect"
       @dblclick="ringPaste">
    <p class="line-clamp-3 text-[11px] leading-relaxed text-ink">{{ ringText }}</p>
    <button type="button"
            class="absolute right-1 top-1 hidden rounded-md bg-surface px-1 text-[10px] text-ink-faint shadow-sm transition-colors hover:text-gold group-hover:block"
            :title="t('bubble.pin')"
            @click.stop="pinCurrent">📌</button>
    <span v-if="ringSelected"
          class="absolute bottom-1 right-2 text-[9px] tabular-nums text-gold">{{ ringIndex + 1 }}</span>
  </div>

  <!-- 环心控制盘：箭头导航 + 翻页 + 关闭 -->
  <div v-else-if="isRingHub" class="flex h-screen flex-col justify-center gap-2 rounded-2xl border border-accent bg-surface/95 px-4 py-3 shadow-soft backdrop-blur">
    <div class="flex items-center justify-between gap-2">
      <span class="text-[10px] uppercase tracking-wide text-ink-faint">{{ t('bubble.title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" :title="t('common.close')"
              @click="hubClose">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="flex items-center justify-between gap-2">
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.prev')"
              @click="hubNav(-1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <span class="min-w-[4rem] text-center text-xs tabular-nums text-ink">
        {{ hubTotal ? Math.min(hubSelected + 1, hubTotal) : 0 }} / {{ hubTotal }}
      </span>
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.next')"
              @click="hubNav(1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>

    <div class="flex items-center justify-between gap-2 text-[10px] text-ink-faint">
      <button type="button" class="transition-colors hover:text-gold disabled:opacity-30" :title="t('bubble.prev_page')"
              :disabled="hubTotal === 0" @click="hubPageNav(-1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></svg>
      </button>
      <span class="tabular-nums">
        {{ hubPage + 1 }} / {{ Math.max(1, Math.ceil(hubTotal / 8)) }}
      </span>
      <button type="button" class="transition-colors hover:text-gold disabled:opacity-30" :title="t('bubble.next_page')"
              :disabled="hubTotal === 0" @click="hubPageNav(1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 17 5-5-5-5" /><path d="m14 17 5-5-5-5" /></svg>
      </button>
    </div>
  </div>
</template>
