<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import clipboardService from '~/src/db/dbService';
import type { PinnedClip } from '~/src/entities';
import { formatDate } from '~/utils/formatDate';
import { findNearestInDirection } from '~/utils/focusNavigation';
import { useInfiniteList } from '~/composables/useInfiniteList';

/** 常用剪贴管理页：不限量存储、不可删除，瀑布流卡片，右滑置顶，时间倒序（置顶优先）。
 *  仅前 10 条支持 Ctrl+1~0 快捷粘贴（对应卡片角标序号）。
 *  流式加载：首屏只加载第一页，滚动到底部自动加载下一页（pinned 无轮询，仅在操作后刷新已加载范围）。 */
const { items: clips, loading, hasMore, sentinel, refreshLoaded } = useInfiniteList<PinnedClip>({
  fetchPage: (offset, limit) => clipboardService.fetchPinnedClips({ offset, limit }),
  pageSize: 40,
  onError: () => { errorMsg.value = '加载常用剪贴失败'; },
});

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

/** 刷新已加载范围（初次进入/编辑/置顶等操作后调用；不会预取未加载数据） */
async function load() {
  // 先清空错误：此前失败文案从不重置，首次失败后错误提示会与正常列表同时显示
  errorMsg.value = '';
  await refreshLoaded();
  // 修正选中索引，避免列表刷新后越界
  if (selectedIndex.value >= clips.value.length) {
    selectedIndex.value = Math.max(0, clips.value.length - 1);
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
  try {
    await clipboardService.updatePinnedClip(target.id, content, editingName.value.trim(), target.type);
    editingId.value = null;
    await load();
  } catch (e) {
    console.error('保存常用剪贴失败:', e);
    showHint('保存失败，请重试');
  }
}

function cancelEdit() {
  editingId.value = null;
}

/** 置顶/取消置顶 */
async function togglePin(item: PinnedClip) {
  try {
    await clipboardService.pinPinnedClip(item.id, !item.pinned_at);
    await load();
  } catch (e) {
    console.error('置顶操作失败:', e);
    showHint('置顶操作失败，请重试');
  }
}

/** 把选中卡片滚动到可见区域 */
async function scrollSelectedIntoView() {
  await nextTick();
  const root = document.querySelector('#pinned-clip-root');
  const cards = root?.querySelectorAll('.pinned-card');
  const el = cards?.[selectedIndex.value] as HTMLElement | undefined;
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 键盘交互：方向键移动选择（常用剪贴不可删除，故不再响应 Delete/Backspace）；Ctrl 组合键（切换标签）交还给全局快捷键 */
async function onKeydown(e: KeyboardEvent) {
  // 处于编辑态时，方向键/删除交给输入框处理，不拦截
  if (editingId.value != null) return;

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
    case 'Backspace':
    default:
      // 常用剪贴不可删除：Delete/Backspace 不执行任何操作
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    await scrollSelectedIntoView();
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
      <p v-if="errorMsg" class="mb-2 text-sm text-danger">{{ errorMsg }}</p>
      <p v-if="loading && clips.length === 0" class="mb-2 text-sm text-ink-faint">加载中…</p>
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
              <!-- 序号角标 + 置顶标识（仅前 10 条支持 Ctrl+1~0 快捷粘贴，故只显示前 10 条角标） -->
              <div class="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1">
                <span v-if="idx < 10" class="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">Ctrl+{{ slotKey(idx) }}</span>
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

                <!-- 操作按钮（编辑/置顶；常用剪贴不可删除） -->
                <div class="flex items-center gap-1 border-t border-accent/50 px-3 py-2">
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="'编辑'" @click="startEdit(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="item.pinned_at ? '取消置顶' : '置顶'" @click="togglePin(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 流式加载：sentinel 进入视口时自动加载下一页；到底后显示"已全部加载" -->
      <div
          v-if="hasMore && clips.length"
          ref="sentinel"
          class="flex items-center justify-center gap-2 py-4 text-xs text-ink-faint"
      >
        <span v-if="loading">加载中…</span>
        <span v-else>继续向下滚动加载更多</span>
      </div>
      <div v-else-if="clips.length" class="py-4 text-center text-xs text-ink-faint">已全部加载</div>
    </div>
  </div>
</template>
