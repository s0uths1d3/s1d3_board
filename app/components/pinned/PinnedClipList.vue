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
const editingTags = ref('');

/** tags JSON 列解析（容错：非法 JSON / 非数组返回空数组） */
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((s) => String(s).trim()).filter(Boolean) : [];
  } catch { return []; }
}

/** 编辑态输入的标签串（空格分隔，兼容逗号/中文逗号）→ 去重后的标签数组 */
function tagsFromInput(raw: string): string[] {
  return [...new Set(raw.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean))];
}

// 键盘选择态（双列网格行优先，逻辑网格：上下 ±列数，左右 ±1）
const selectedIndex = ref(0);
/** 列数（与模板 grid-cols-2 保持一致） */
const COLUMNS = 2;

/** 数字键标签：第 N 项对应 Ctrl+数字（第 10 项为 0） */
function slotKey(idx: number) {
  return idx + 1 === 10 ? 0 : idx + 1;
}

/** 行优先槽位 → 左右双列分配：偶数索引进左列、奇数进右列（Ctrl+1 左上、Ctrl+2 右上、
 *  Ctrl+3 在 Ctrl+1 正下方）。列容器独立纵向堆叠，避免 grid 行轨道按最高卡撑行
 *  导致矮卡下方出现大块空白 */
const pinnedColumns = computed(() => {
  const cols: { item: (typeof clips.value)[number]; idx: number }[][] = [[], []];
  clips.value.forEach((item, idx) => { cols[idx % 2]!.push({ item, idx }); });
  return cols;
});

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
  editingTags.value = parseTags(item.tags).join(' ');
}

/** 保存编辑：文本可改内容，图片内容保持不变（仅可改名称/标签/替换） */
async function saveEdit() {
  if (editingId.value == null) return;
  const target = clips.value.find((c) => c.id === editingId.value);
  if (!target) return;
  const content = target.type === 'text' ? editingContent.value : target.content;
  try {
    await clipboardService.updatePinnedClip(
        target.id, content, editingName.value.trim(), target.type,
        tagsFromInput(editingTags.value),
    );
    editingId.value = null;
    await load();
    showHint(t('clip.pinned_saved'));
  } catch (e) {
    console.error('保存常用剪贴失败:', e);
    showHint(t('clip.pinned_save_failed'), 'error');
  }
}

/** 取消编辑：有未保存改动（名称/内容/标签相对原文变化；图片只看名称/标签）时灵动岛提示丢弃 */
function cancelEdit() {
  const target = clips.value.find((c) => c.id === editingId.value);
  if (target) {
    const nameDirty = (target.name ?? '') !== editingName.value;
    const contentDirty = target.type === 'text' && target.content !== editingContent.value;
    const tagsDirty = parseTags(target.tags).join(' ') !== tagsFromInput(editingTags.value).join(' ');
    if (nameDirty || contentDirty || tagsDirty) showHint(t('clip.pinned_edit_discarded'), 'info');
  }
  editingId.value = null;
}

/** 置顶/取消置顶（item.pinned_at 为操作前的状态）：成功灵动岛反馈，失败 error 提示 */
async function togglePin(item: PinnedClip) {
  try {
    await clipboardService.pinPinnedClip(item.id, !item.pinned_at);
    await load();
    showHint(item.pinned_at ? t('clip.unpinned_now') : t('clip.pinned_now'));
  } catch (e) {
    console.error('置顶操作失败:', e);
    showHint(t('clip.pin_operation_failed'), 'error');
  }
}

// ===== 删除（单条移除，仅删常用剪贴记录，不动剪贴板主列表原条目）=====
const deleteConfirmVisible = ref(false);
const deleteConfirmMessage = ref('');
const deleteConfirmTarget = ref<PinnedClip | null>(null);

/** 请求删除：弹出内联确认框（视口居中） */
function requestDelete(item: PinnedClip) {
  deleteConfirmTarget.value = item;
  deleteConfirmMessage.value = t('clip.pinned_delete_confirm');
  deleteConfirmVisible.value = true;
}

/** 确认删除：移除并刷新，灵动岛反馈结果 */
async function confirmDelete() {
  const target = deleteConfirmTarget.value;
  deleteConfirmVisible.value = false;
  deleteConfirmTarget.value = null;
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
}

/** 查询全部卡片（DOM 顺序 = 左右列容器拼接，即列优先）与行优先 selectedIndex 的换算桥：
 *  卡片带 data-idx（原始行优先索引），几何导航/滚动定位经它换算，避免索引体系错位 */
function queryPinnedCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll('#pinned-clip-root .pinned-card')) as HTMLElement[];
}
function cardIdxOf(el: HTMLElement): number {
  return Number(el.dataset.idx ?? -1);
}

/** 把选中卡片滚动到可见区域 */
async function scrollSelectedIntoView() {
  await nextTick();
  const el = queryPinnedCards().find((c) => cardIdxOf(c) === selectedIndex.value);
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
    // 方向键：几何最近邻导航（基于卡片真实位置计算，布局无关，双列网格下按下即正下方槽位）。
    // findNearestInDirection 返回/接收的是 DOM 序索引，而 DOM 序为列优先（左右列容器拼接），
    // 须经 data-idx 换算成行优先 selectedIndex 再回写——直接赋值会导致方向切换错位/失效
    case 'ArrowUp':
    case 'ArrowDown':
    case 'ArrowLeft':
    case 'ArrowRight': {
      const cards = queryPinnedCards();
      if (cards.length > 0) {
        const dirMap = {
          ArrowUp: 'up', ArrowDown: 'down',
          ArrowLeft: 'left', ArrowRight: 'right',
        } as const;
        const curDom = cards.findIndex((el) => cardIdxOf(el) === selectedIndex.value);
        if (curDom >= 0) {
          const nextDom = findNearestInDirection(
            cards,
            curDom,
            dirMap[e.key as keyof typeof dirMap],
          );
          if (nextDom >= 0) {
            const nextEl = cards[nextDom];
            if (nextEl) selectedIndex.value = cardIdxOf(nextEl);
          }
        }
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

      <!-- 双列独立堆叠（行优先槽位）：偶数槽位入左列、奇数入右列——Ctrl+1 左上、Ctrl+2 右上、
           Ctrl+3 紧贴 Ctrl+1 正下方。用列容器 flex 纵向堆叠而非 grid 行轨道：
           grid 每行高度由该行最高卡决定，同行矮卡下方会被撑出大块空白（视觉间隔失真），
           列内独立堆叠则上下间距恒等于 gap-3，与左右一致 -->
      <div v-if="clips.length" class="grid grid-cols-2 items-start gap-3">
        <div v-for="(col, ci) in pinnedColumns" :key="ci" class="flex flex-col gap-3">
          <div
              v-for="entry in col"
              :key="entry.item.id"
              class="pinned-card"
              :data-idx="entry.idx"
              :class="selectedIndex === entry.idx ? 'is-selected' : ''"
              @click="selectedIndex = entry.idx"
          >
          <div
              class="relative overflow-hidden rounded-2xl border bg-surface-field/70 shadow-soft transition-all"
              :class="selectedIndex === entry.idx ? 'border-gold ring-2 ring-gold/60' : 'border-accent'"
          >
            <!-- 卡片主体 -->
            <div class="relative select-none">
              <!-- 序号角标 + 置顶标识（仅前 10 条支持 Ctrl+1~0 快捷粘贴，故只显示前 10 条角标） -->
              <div class="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-1">
                <span v-if="entry.idx < 10" class="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold">Ctrl+{{ slotKey(entry.idx) }}</span>
                <svg v-if="entry.item.pinned_at" class="size-3 text-gold" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                </svg>
              </div>

              <!-- 编辑态 -->
              <template v-if="editingId === entry.item.id">
                <div class="p-3 pt-10">
                  <input
                      v-model="editingName"
                      :placeholder="t('clip.name_optional')"
                      class="w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-hidden"
                  />
                  <textarea
                      v-if="entry.item.type === 'text'"
                      v-model="editingContent"
                      rows="3"
                      class="mt-2 w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-hidden"
                  ></textarea>
                  <p v-else class="mt-2 text-xs text-ink-faint">{{ t('common.image_not_editable') }}</p>
                  <!-- 标签：逗号分隔输入，保存时去空去重 -->
                  <input
                      v-model="editingTags"
                      :placeholder="t('clip.tags_hint')"
                      class="mt-2 w-full rounded-xl border border-accent bg-surface-field px-3 py-1.5 text-sm text-ink focus:border-gold focus:outline-hidden"
                  />
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button type="button" class="btn-soft border-gold text-gold" @click="saveEdit" @pointerdown.stop.prevent>{{ t('common.save') }}</button>
                    <button type="button" class="btn-soft" @click="cancelEdit" @pointerdown.stop.prevent>{{ t('common.cancel') }}</button>
                  </div>
                </div>
              </template>

              <!-- 查看态 -->
              <template v-else>
                <div class="p-3 pt-10">
                  <div v-if="entry.item.name" class="mb-1 text-xs font-bold text-ink">{{ entry.item.name }}</div>
                  <!-- 图片预览 -->
                  <img
                      v-if="entry.item.type === 'image'"
                      :src="entry.item.content"
                      :alt="t('clip.pinned_image')"
                      class="w-full rounded-lg object-contain"
                  />
                  <!-- 文本/链接预览 -->
                  <p
                      v-else
                      class="whitespace-pre-wrap break-words text-sm text-ink"
                      style="display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:5; overflow:hidden"
                  >{{ entry.item.content }}</p>
                  <!-- 标签徽章（可空）：金色弱化描边 -->
                  <div v-if="parseTags(entry.item.tags).length" class="mt-1.5 flex flex-wrap gap-1">
                    <span
                        v-for="tag in parseTags(entry.item.tags)"
                        :key="tag"
                        class="rounded-full border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] leading-none text-gold"
                    >{{ tag }}</span>
                  </div>
                </div>

                <!-- 元信息：类型 / 复制时间 / 来源应用 -->
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-accent/50 px-3 py-2 text-[10px] uppercase tracking-wide text-ink-faint">
                  <span class="flex items-center gap-1">
                    <!-- 类型图标 -->
                    <svg v-if="entry.item.type === 'image'" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    <svg v-else-if="isLink(entry.item)" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                    <svg v-else class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
                    </svg>
                    {{ t(typeLabelKey(entry.item)) }}
                  </span>
                  <span>{{ formatDateLocalized(parseInt(entry.item.created_at)) }}</span>
                  <span v-if="entry.item.source" class="max-w-[8em] truncate">{{ entry.item.source }}</span>
                </div>

                <!-- 操作按钮（编辑/置顶/删除） -->
                <div class="flex items-center gap-1 border-t border-accent/50 px-3 py-2">
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="t('common.edit')" @click="startEdit(entry.item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5" v-tip="entry.item.pinned_at ? t('clip.unpinned') : t('clip.pinned')" @click="togglePin(entry.item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5 text-danger" v-tip="t('common.delete')" @click="requestDelete(entry.item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>
                  </button>
                </div>
              </template>
            </div>
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

    <!-- 删除确认框（内联组件，与剪贴板/便签一致，视口居中） -->
    <DeleteConfirm
        :visible="deleteConfirmVisible"
        :message="deleteConfirmMessage"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
    />
  </div>
</template>
