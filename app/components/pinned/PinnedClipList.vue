<script setup lang="ts">
import { ref, onMounted } from 'vue';
import clipboardService from '~/src/db/dbService';
import type { PinnedClip } from '~/src/Entities';
import { formatDate } from '~/src/utils/formatDate';

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
  await load();
  showHint('已删除');
}

/** 置顶/取消置顶 */
async function togglePin(item: PinnedClip) {
  await clipboardService.pinPinnedClip(item.id, !item.pinned_at);
  await load();
}

/** 替换图片：选择本地图片文件并转 base64 */
function replaceImage(item: PinnedClip) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      await clipboardService.updatePinnedClip(item.id, dataUrl, item.name ?? '', 'image');
      await load();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-6xl p-4">
    <div class="glass-card rounded-2xl p-4">
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
            class="mb-3 break-inside-avoid"
        >
          <div class="relative overflow-hidden rounded-2xl border border-accent bg-surface-field/70 shadow-soft">
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
                  <p v-else class="mt-2 text-xs text-ink-faint">图片内容不可直接编辑，可用「替换图片」更换。</p>
                  <div class="mt-2 flex gap-2">
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
                  <button type="button" class="btn-soft btn-circle p-1.5" title="编辑" @click="startEdit(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                  </button>
                  <button v-if="item.type === 'image'" type="button" class="btn-soft btn-circle p-1.5" title="替换图片" @click="replaceImage(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                  </button>
                  <button type="button" class="btn-soft btn-circle p-1.5" :title="item.pinned_at ? '取消置顶' : '置顶'" @click="togglePin(item)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                    </svg>
                  </button>
                  <span class="flex-1"></span>
                  <button type="button" class="btn-soft btn-circle p-1.5 text-[rgba(176,92,92,1)]" title="删除" @click="removeClip(item.id)" @pointerdown.stop.prevent>
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" /></svg>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
