<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import clipboardService from '~/src/db/dbService';
import type { PinnedClip } from '~/src/entities';
import { useFormatDate } from '~/composables/useFormatDate';
import { findNearestInDirection } from '~/utils/focusNavigation';
import { useInfiniteList } from '~/composables/useInfiniteList';
import { useI18n } from '~/composables/useI18n';
import { notifyIsland, type IslandKind } from '~/composables/useCopyIsland';
import DeleteConfirm from '~/components/common/DeleteConfirm.vue';

const { t } = useI18n();
const formatDateLocalized = useFormatDate();

/** 常用剪贴管理页：不限量存储、可单条删除（确认框防误删），瀑布流卡片，右滑置顶，时间倒序（置顶优先）。
 *  仅前 10 条支持 Ctrl+1~0 快捷粘贴（对应卡片角标序号）。
 *  流式加载：首屏只加载第一页，滚动到底部自动加载下一页（pinned 无轮询，仅在操作后刷新已加载范围）。 */
const { items: clips, loading, hasMore, sentinel, refreshLoaded } = useInfiniteList<PinnedClip>({
  fetchPage: (offset, limit) => clipboardService.fetchPinnedClips({ offset, limit }),
  pageSize: 40,
  onError: () => { errorMsg.value = t('clip.pinned_load_failed'); },
});

const errorMsg = ref('');

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
function typeLabelKey(item: PinnedClip) {
  if (item.type === 'image') return 'common.image';
  return isLink(item) ? 'common.link' : 'common.text';
}

/** 操作反馈 → 灵动岛（屏幕顶部全局胶囊，替代窗口内 toast） */
function showHint(msg: string, kind: IslandKind = 'success') {
  notifyIsland({ kind, text: msg });
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
    showHint(t('clip.pinned_saved'));
  } catch (e) {
    console.error('保存常用剪贴失败:', e);
    showHint(t('clip.pinned_save_failed'), 'error');
  }
}

/** 取消编辑：有未保存改动（名称或内容相对原文变化；图片只看名称）时灵动岛提示丢弃 */
function cancelEdit() {
  const target = clips.value.find((c) => c.id === editingId.value);
  if (target) {
    const nameDirty = (target.name ?? '') !== editingName.value;
    const contentDirty = target.type === 'text' && target.content !== editingContent.value;
    if (nameDirty || contentDirty) showHint(t('clip.pinned_edit_discarded'), 'info');
  }
  editingId.value = null;
}

/** 置顶/取消置顶 */
async function togglePin(item: PinnedClip) {
  try {
    await clipboardService.pinPinnedClip(item.id, !item.pinned_at);
    await load();
  } catch (e) {
    console.error('置顶操作失败:', e);
    showHint(t('clip.pin_operation_failed'), 'error');
  }
}

// ===== 删除（单条移除，仅删常用剪贴记录，不动剪贴板主列表原条目）=====
const deleteConfirmVisible = ref(false);
const deleteConfirmMessage = ref('');
const deleteConfirmAnchor = ref<DOMRect | null>(null);
const deleteConfirmTarget = ref<PinnedClip | null>(null);

/** 请求删除：弹出内联确认框（anchor 就近定位；键盘触发无 anchor 时居中） */
function requestDelete(item: PinnedClip, e?: MouseEvent) {
  deleteConfirmTarget.value = item;
  deleteConfirmMessage.value = t('clip.pinned_delete_confirm');
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null;
  deleteConfirmAnchor.value = btn?.getBoundingClientRect() ?? null;
  deleteConfirmVisible.value = true;
}

/** 确认删除：移除并刷新，灵动岛反馈结果 */
async function confirmDelete() {
  const target = deleteConfirmTarget.value;
  deleteConfirmVisible.value = false;
  deleteConfirmTarget.value = null;
  deleteConfirmAnchor.value = null;
  if (!target) return;
  try {
    await clipboardService.deletePinnedClip(target.id);
    await load();
    showHint(t('clip.pinned_deleted'));
  } catch (e) {
    console.error('删除常用剪贴失败:', e);
    showHint(t('clip.pinned_delete_failed'), 'error');
  }
}

/** 取消删除：仅关闭确认框 */
function cancelDelete() {
  deleteConfirmVisible.value = false;
  deleteConfirmTarget.value = null;
  deleteConfirmAnchor.value = null;
}

/** 把选中卡片滚动到可见区域 */
async function scrollSelectedIntoView() {
  await nextTick();
  const root = document.querySelector('#pinned-clip-root');
  const cards = root?.querySelectorAll('.pinned-card');
  const el = cards?.[selectedIndex.value] as HTMLElement | undefined;
  el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 键盘交互：方向键移动选择；Delete/Backspace 删除选中项（弹确认框）；Ctrl 组合键（切换标签）交还给全局快捷键 */
async function onKeydown(e: KeyboardEvent) {
  // 处于编辑态时，方向键/删除交给输入框处理，不拦截
  if (editingId.value != null) return;
  // 删除确认框打开时：键盘操作由 DeleteConfirm 组件统一处理，这里不响应（避免误删/重复弹框）
  if (deleteConfirmVisible.value) return;

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
      const target = clips.value[selectedIndex.value];
      if (target) requestDelete(target);
      break;
    }
    default:
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
  <!-- 边距与宽度由外壳统一提供（main px-4 + max-w-6xl），各模块保持一致 -->
  <div id="pinned-clip-root">
    <div class="rounded-2xl p-4">
      <p v-if="errorMsg" class="mb-2 text-sm text-danger">{{ errorMsg }}</p>
      <p v-if="loading && clips.length === 0" class="mb-2 text-sm text-ink-faint">{{ t('common.loading') }}</p>
      <p v-if="!loading && clips.length === 0" class="mb-2 text-sm text-ink-faint">
        {{ t('clip.pinned_empty') }}
      </p>

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
                      :placeholder="t('clip.name_optional')"
                      class="w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-none"
                  />
                  <textarea
                      v-if="item.type === 'text'"
                      v-model="editingContent"
                      rows="3"
                      class="mt-2 w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-none"
                  ></textarea>
                  <p v-else class="mt-2 text-xs text-ink-faint">{{ t('common.image_not_editable') }}</p>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button type="button" class="btn-soft border-gold text-gold" @click="saveEdit" @pointerdown.stop.prevent>{{ t('common.save') }}</button>
                    <button type="button" class="btn-soft" @click="cancelEdit" @pointerdown.stop.prevent>{{ t('common.cancel') }}</button>
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
                      :alt="t('clip.pinned_image')"
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
                    {{ t(typeLabelKey(item)) }}
                  </span>
                  <span>{{ formatDateLocalized(parseInt(item.created_at)) }}</span>
                  <span v-if="item.source" class="max-w-[8em] truncate">{{ item.source }}</span>
                </div>

                <!-- 操作按钮（编辑/置顶/删除） -->
                <div class="flex items-center gap-1 border-t border-accent/50 px-3 py-2">
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="t('common.edit')" @click="startEdit(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="item.pinned_at ? t('clip.unpinned') : t('clip.pinned')" @click="togglePin(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5 text-danger" v-tip="t('common.delete')" @click="requestDelete(item, $event)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
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
        <span v-if="loading">{{ t('clip.loading_more') }}</span>
        <span v-else>{{ t('clip.scroll_more') }}</span>
      </div>
      <div v-else-if="clips.length" class="py-4 text-center text-xs text-ink-faint">{{ t('clip.no_more') }}</div>
    </div>

    <!-- 删除确认框（内联组件，与剪贴板/便签一致；键盘触发无 anchor 时居中） -->
    <DeleteConfirm
        :visible="deleteConfirmVisible"
        :message="deleteConfirmMessage"
        :anchor="deleteConfirmAnchor"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
    />
  </div>
</template>
