<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import clipboardService from '~/src/db/dbService';
import type { PinnedClip } from '~/src/Entities';
import { formatDate } from '~/src/utils/formatDate';
import { findNearestInDirection } from '~/src/utils/focusNavigation';

/** 常用剪贴管理页：最多 10 条，瀑布流卡片，左滑删除 / 右滑置顶，时间倒序（置顶优先） */
const clips = ref<PinnedClip[]>([]);
const loading = ref(false);
const errorMsg = ref('');
const hint = ref('');
let hintTimer: ReturnType<typeof setTimeout> | null = null;

// 编辑态
const editingId = ref<number | null>(null);
const editingName = ref('');
const editingContent = ref('');

// 键盘选择态（瀑布流双列，逻辑网格：上下 ±1，左右 ±2）
const selectedIndex = ref(0);
/** 列数（与模板 columns-2 保持一致） */
const COLUMNS = 2;

/** 数字键标签：第 N 项对应 Ctrl+数字（第 10 项为 0） */
function slotKey(idx: number) {
  return idx + 1 === 10 ? 0 : idx + 1;
}

/** 类型判定：链接（文本且 http(s) 开头） */
function isLink(item: PinnedClip) {
  return item.type === 'text' && /^https?:\/\//i.test(item.content.trim());
}
function typeLabel(item: PinnedClip) {
  if (item.type === 'image') return '图片';
  return isLink(item) ? '链接' : '文本';
}

function showHint(msg: string) {
  hint.value = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.value = ''; }, 2000);
}

async function load() {
  loading.value = true;
  try {
    clips.value = await clipboardService.fetchPinnedClips();
    // 修正选中索引，避免列表刷新后越界
    if (selectedIndex.value >= clips.value.length) {
      selectedIndex.value = Math.max(0, clips.value.length - 1);
    }
  } catch (e) {
    console.error('加载常用剪贴失败:', e);
    errorMsg.value = '加载常用剪贴失败';
  } finally {
    loading.value = false;
  }
}

/** 进入编辑态 */
function startEdit(item: PinnedClip) {
  editingId.value = item.id;
  editingName.value = item.name ?? '';
  editingContent.value = item.content;
}

/** 保存编辑：文本可改内容，图片内容保持不变（仅可改名称/替换） */
async function saveEdit() {
  if (editingId.value == null) return;
  const target = clips.value.find((c) => c.id === editingId.value);
  if (!target) return;
  const content = target.type === 'text' ? editingContent.value : target.content;
  await clipboardService.updatePinnedClip(target.id, content, editingName.value.trim(), target.type);
  editingId.value = null;
  await load();
}

function cancelEdit() {
  editingId.value = null;
}

/** 删除常用剪贴项 */
async function removeClip(id: number) {
  await clipboardService.deletePinnedClip(id);
  // 删除后修正选中索引
  if (selectedIndex.value >= clips.value.length - 1) {
    selectedIndex.value = Math.max(0, clips.value.length - 2);
  }
  await load();
  showHint('已删除');
}

// ===== 删除确认（与便签 note 一致：页面内联确认框，非独立窗口）=====
/** 待删除项（存在时显示内联确认框） */
const deleteConfirmTarget = ref<PinnedClip | null>(null);
const confirmOkBtn = ref<HTMLButtonElement | null>(null);
const confirmCancelBtn = ref<HTMLButtonElement | null>(null);

/** 请求删除：弹出内联确认框 */
function requestDelete(item: PinnedClip) {
  if (!item) return;
  deleteConfirmTarget.value = item;
}

/** 确认删除 */
async function confirmDelete() {
  const target = deleteConfirmTarget.value;
  if (!target) return;
  deleteConfirmTarget.value = null;
  await removeClip(target.id);
}

/** 确认框打开时默认聚焦「确定」按钮，关闭后清空 ref */
watch(deleteConfirmTarget, (target) => {
  if (target) nextTick(() => confirmOkBtn.value?.focus());
});

/** 置顶/取消置顶 */
async function togglePin(item: PinnedClip) {
  await clipboardService.pinPinnedClip(item.id, !item.pinned_at);
  await load();
}

/** 把选中卡片滚动到可见区域 */
async function scrollSelectedIntoView() {
  await nextTick();
  const root = document.querySelector('#pinned-clip-root');
  const cards = root?.querySelectorAll('.pinned-card');
  const el = cards?.[selectedIndex.value] as HTMLElement | undefined;
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 键盘交互：方向键移动选择，Delete 删除选中项；Ctrl 组合键（切换标签）交还给全局快捷键 */
async function onKeydown(e: KeyboardEvent) {
  // 处于编辑态时，方向键/删除交给输入框处理，不拦截
  if (editingId.value != null) return;

  // 删除确认框打开时：方向键/Tab 在「取消/确定」间切换焦点，Enter 触发当前按钮，Esc 取消，
  // Delete/Backspace 忽略（避免误触发重新弹框）。键盘操作作用于确认框，不作用于列表。
  if (deleteConfirmTarget.value) {
    const ok = confirmOkBtn.value;
    const cancel = confirmCancelBtn.value;
    const focusOnOk = document.activeElement === ok;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      if (focusOnOk) cancel?.focus();
      else ok?.focus();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (document.activeElement === cancel) deleteConfirmTarget.value = null;
      else void confirmDelete();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      deleteConfirmTarget.value = null;
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }

  // Ctrl/Meta 组合（如 Ctrl+←/→ 切换标签）不在此处理
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const total = clips.value.length;
  if (total === 0) return;

  let handled = true;
  switch (e.key) {
    // 方向键：几何最近邻导航（适配瀑布流列高不均，按下切到该方向上距离最近的项）
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      const root = document.querySelector('#pinned-clip-root');
      const cards = root?.querySelectorAll('.pinned-card');
      if (cards && cards.length > 0) {
        const dirMap = {
          ArrowUp: 'up', ArrowDown: 'down',
          ArrowLeft: 'left', ArrowRight: 'right',
        } as const;
        const next = findNearestInDirection(
          Array.from(cards) as HTMLElement[],
          selectedIndex.value,
          dirMap[e.key as keyof typeof dirMap],
        );
        if (next >= 0) selectedIndex.value = next;
      }
      break;
    }
    case 'Delete':
    case 'Backspace': {
      // 与主剪贴板一致：弹出独立删除确认窗口
      const item = clips.value[selectedIndex.value];
      if (item) await requestDelete(item);
      break;
    }
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key !== 'Delete' && e.key !== 'Backspace') await scrollSelectedIntoView();
  }
}

onMounted(() => {
  load();
  window.addEventListener('keydown', onKeydown, true);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div id="pinned-clip-root" class="mx-auto max-w-6xl p-4">
    <div class="rounded-2xl p-4">
      <p v-if="errorMsg" class="mb-2 text-sm text-[rgba(176,92,92,1)]">{{ errorMsg }}</p>
      <p v-if="loading" class="mb-2 text-sm text-ink-faint">加载中…</p>
      <p v-if="!loading && clips.length === 0" class="mb-2 text-sm text-ink-faint">
        暂无常用剪贴。可在剪贴板列表项右键「添加到常用剪贴」。
      </p>
      <p v-if="hint" class="mb-2 text-sm text-gold">{{ hint }}</p>

      <!-- 瀑布流卡片（columns 布局，break-inside-avoid 保证卡片不跨列） -->
      <div v-if="clips.length" class="columns-2 gap-3">
        <div
            v-for="(item, idx) in clips"
            :key="item.id"
            class="pinned-card mb-3 break-inside-avoid"
            :class="selectedIndex === idx ? 'is-selected' : ''"
            @click="selectedIndex = idx"
        >
          <div
              class="relative overflow-hidden rounded-2xl border bg-surface-field/70 shadow-soft transition-all"
              :class="selectedIndex === idx ? 'border-gold ring-2 ring-gold/60' : 'border-accent'"
          >
            <!-- 卡片主体 -->
            <div class="relative select-none">
              <!-- 序号角标 + 置顶标识 -->
              <div class="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1">
                <span class="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">Ctrl+{{ slotKey(idx) }}</span>
                <svg v-if="item.pinned_at" class="size-3 text-gold" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                </svg>
              </div>

              <!-- 编辑态 -->
              <template v-if="editingId === item.id">
                <div class="p-3 pt-10">
                  <input
                      v-model="editingName"
                      placeholder="名称（可选）"
                      class="w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-none"
                  />
                  <textarea
                      v-if="item.type === 'text'"
                      v-model="editingContent"
                      rows="3"
                      class="mt-2 w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-none"
                  ></textarea>
                  <p v-else class="mt-2 text-xs text-ink-faint">图片内容不支持编辑。</p>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button type="button" class="btn-soft border-gold text-gold" @click="saveEdit" @pointerdown.stop.prevent>保存</button>
                    <button type="button" class="btn-soft" @click="cancelEdit" @pointerdown.stop.prevent>取消</button>
                  </div>
                </div>
              </template>

              <!-- 查看态 -->
              <template v-else>
                <div class="p-3 pt-10">
                  <div v-if="item.name" class="mb-1 text-xs font-semibold text-ink">{{ item.name }}</div>
                  <!-- 图片预览 -->
                  <img
                      v-if="item.type === 'image'"
                      :src="item.content"
                      alt="常用剪贴图片"
                      class="w-full rounded-lg object-contain"
                  />
                  <!-- 文本/链接预览 -->
                  <p
                      v-else
                      class="whitespace-pre-wrap break-words text-sm text-ink"
                      style="display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:5; overflow:hidden"
                  >{{ item.content }}</p>
                </div>

                <!-- 元信息：类型 / 复制时间 / 来源应用 -->
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-accent/50 px-3 py-2 text-[10px] uppercase tracking-wide text-ink-faint">
                  <span class="flex items-center gap-1">
                    <!-- 类型图标 -->
                    <svg v-if="item.type === 'image'" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <svg v-else-if="isLink(item)" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <svg v-else class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
                    </svg>
                    {{ typeLabel(item) }}
                  </span>
                  <span>{{ formatDate(parseInt(item.created_at)) }}</span>
                  <span v-if="item.source" class="max-w-[8em] truncate">{{ item.source }}</span>
                </div>

                <!-- 操作按钮（编辑/替换图片/置顶/删除） -->
                <div class="flex items-center gap-1 border-t border-accent/50 px-3 py-2">
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="'编辑'" @click="startEdit(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="item.pinned_at ? '取消置顶' : '置顶'" @click="togglePin(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                  <span class="flex-1"></span>
                  <button type="button" class="btn-soft btn-circle p-1.5 text-[rgba(176,92,92,1)]" v-tip="'删除'" @click="requestDelete(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" /></svg>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除确认框（与便签 note 一致：页面内联确认，非独立窗口） -->
    <div
        v-if="deleteConfirmTarget"
        role="alert"
        class="glass-card fixed top-1/2 left-1/2 z-50 flex w-[400px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-2xl p-6 shadow-float"
    >
      <div class="mb-4 flex w-full items-start gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
             class="mt-1 h-6 w-6 shrink-0 text-gold">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div class="flex-1 font-bold text-ink">
          确定要删除{{ deleteConfirmTarget.type === 'image' ? '该图片' : '该项' }}吗？
        </div>
      </div>
      <div class="flex w-full justify-center gap-4">
        <button
            ref="confirmCancelBtn"
            class="btn-soft outline-none focus:ring-2 focus:ring-gold/60"
            @click="deleteConfirmTarget = null"
        >取消</button>
        <button
            ref="confirmOkBtn"
            class="btn-gold outline-none focus:ring-2 focus:ring-gold/60"
            @click="confirmDelete"
        >确定</button>
      </div>
    </div>
  </div>
</template>
