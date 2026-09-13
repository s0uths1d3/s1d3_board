<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRoute } from 'vue-router';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '~/utils/env';
import { useI18n } from '~/composables/useI18n';
import { pasteContentToActiveApp } from '~/src/commands/local/pasteUtil';
import type { SmartClipEntry } from '~/src/smart-clip/types';

/**
 * 智能剪贴板气泡窗口（设计文档 §4.4）。
 *
 * 两种模式（route.query.mode 区分）：
 * - 列表模式（默认）：主气泡。ready 握手（bubble:ready）→ 接收 bubble:show 数据 →
 *   show + setFocus；↑↓ 选择 / Enter 粘贴 / Esc 关闭；片段可"钉住"为独立小气泡。
 * - 钉住模式（?mode=pin）：单片段常驻卡片（灵动岛形态）。
 *   创建者定向 emitTo('bubble:pin:data') 投递文本；点击片段 = 复制到剪贴板（不模拟粘贴，
 *   常驻卡片不应自我隐藏）。
 */

const route = useRoute();
const { t } = useI18n();
const isPinMode = route.query.mode === 'pin';

interface FlatItem {
    entryId: number;
    segIndex: number;
    text: string;
}

const items = ref<FlatItem[]>([]);
const selected = ref(0);
const pinnedText = ref('');
const pinCopied = ref(false);
let pinCopiedTimer: ReturnType<typeof setTimeout> | null = null;

const empty = computed(() => !isPinMode && items.value.length === 0);

/** 扁平化 entries（每 entry 的每 segment 一行），显示并聚焦 */
function ingestEntries(list: SmartClipEntry[]): void {
    const flat: FlatItem[] = [];
    for (const e of list) {
        for (const s of e.segments) {
            flat.push({ entryId: e.id, segIndex: s.index, text: s.text });
        }
    }
    items.value = flat;
    selected.value = 0;
    void getCurrentWindow().show();
    void getCurrentWindow().setFocus().catch(() => {});
}

async function pasteSelected(): Promise<void> {
    const item = items.value[selected.value];
    if (!item) return;
    // pasteContentToActiveApp 内部：写剪贴板 → hide 本气泡（焦点回目标应用）→ 模拟粘贴。
    // 不主动 close：hide 保留实例，下一次 Ctrl+B 会 close 后重建（数据保证最新）。
    await pasteContentToActiveApp(item.text, 'text');
}

function move(delta: number): void {
    if (items.value.length === 0) return;
    selected.value = (selected.value + delta + items.value.length) % items.value.length;
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        void getCurrentWindow().close();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        void pasteSelected();
    }
}

/** 钉住：为该片段创建独立常驻小气泡窗（clipboard-bubble-pin-*），定向投递文本 */
async function pinItem(item: FlatItem): Promise<void> {
    if (!isTauri()) return;
    const label = `clipboard-bubble-pin-${Date.now()}`;
    (window as any).__childOpeningUntil = Date.now() + 600;
    const unReady = await listen('bubble:pin:ready', (ev) => {
        if ((ev.payload as string | undefined) !== label) return;
        void emitTo(label, 'bubble:pin:data', { text: item.text });
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

/** 钉住卡片：点击片段 = 复制到剪贴板（带已复制反馈，不模拟粘贴、不自我隐藏） */
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

let unlisteners: (() => void)[] = [];

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
    // 列表模式：先注册数据监听，再发 ready（与创建者的握手顺序配合，避免竞态）
    unlisteners.push(await listen<{ entries: SmartClipEntry[] }>('bubble:show', (ev) => {
        ingestEntries(ev.payload.entries ?? []);
    }));
    await emit('bubble:ready', getCurrentWindow().label);
    window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
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

  <!-- 列表模式：主气泡（解析片段选择 + 快捷粘贴） -->
  <div v-else class="flex h-screen flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
    <div class="flex items-center justify-between border-b border-accent px-3 py-2">
      <span class="text-xs font-semibold text-ink">{{ t('bubble.title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" @click="getCurrentWindow().close()">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div v-if="empty" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div class="text-sm text-ink">{{ t('bubble.empty_title') }}</div>
      <div class="text-xs text-ink-faint">{{ t('bubble.empty_hint') }}</div>
    </div>

    <ul v-else class="flex-1 overflow-y-auto p-2">
      <li v-for="(item, i) in items" :key="`${item.entryId}-${item.segIndex}`">
        <div class="group relative mb-1 rounded-xl border p-2 transition-colors"
             :class="i === selected ? 'border-gold bg-gold/10 ring-1 ring-gold/50' : 'border-line bg-surface-field/40 hover:border-accent'"
             @mouseenter="selected = i">
          <p class="line-clamp-3 text-xs leading-relaxed text-ink">{{ item.text }}</p>
          <button type="button"
                  class="absolute right-1.5 top-1.5 hidden rounded-md bg-surface px-1.5 py-0.5 text-[10px] text-ink-faint shadow-sm transition-colors hover:text-gold group-hover:block"
                  :title="t('bubble.pin')"
                  @click.stop="pinItem(item)">
            📌
          </button>
        </div>
      </li>
    </ul>

    <div v-if="!empty" class="border-t border-accent px-3 py-1.5 text-[10px] text-ink-faint">
      {{ t('bubble.paste_hint') }}
    </div>
  </div>
</template>
