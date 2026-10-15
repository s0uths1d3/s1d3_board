<script setup lang="ts">
/**
 * Ctrl+P 全局搜索命令面板（GlobalSearch）
 *
 * 一次并行搜剪贴板/待办/便签三个模块（每模块取前 20 条），键盘 ↑↓ 选择、
 * 回车/点击跳转到对应模块并定位：
 * - 剪贴板：经 global-search:jump 交 index.vue 处理（它持有搜索框高亮词与列表选中管道）
 * - 待办/便签：切 Tab 后派发搜索词，由模块既有搜索管道（防抖/查库）刷新展示
 *
 * 键盘处理沿用 DeleteConfirm 的 capture 模式：面板打开期间在 capture 阶段拦截
 * 方向键/回车/Esc，抢在 ShortcutManager（bubble 阶段）之前——否则 Esc 会触发
 * 「隐藏窗口」、回车会触发「粘贴」命令；其余按键放行，输入框正常输入。
 */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from '~/composables/useI18n';
import { bus } from '~/src/core/events';
import clipboardService from '~/src/db/dbService';
import type { ClipboardData, Todo, Note } from '~/src/entities';
import { setActiveTab } from '~/composables/useTabs';
import { settings } from '~/src/setting/settingGroups';
import SearchInputBar from '~/components/common/SearchInputBar.vue';
import { useMaskBlur, maskBlurPx } from '~/composables/useMaskBlur';

const { t } = useI18n();
// 蒙版模糊度（设置项 0~1，默认 1）：> 0 时蒙层带背景模糊；0 回归纯半透明黑（规避 Chromium 合成怪癖）
const { maskBlur } = useMaskBlur();
const overlayStyle = computed(() => {
  const px = maskBlurPx(maskBlur.value);
  return px > 0 ? { backdropFilter: `blur(${px}px)`, WebkitBackdropFilter: `blur(${px}px)` } : undefined;
});

const visible = ref(false);
const query = ref('');
const inputEl = ref<InstanceType<typeof SearchInputBar> | null>(null);
const listEl = ref<HTMLElement | null>(null);
// 高级搜索开关（与剪贴板同一套词法开关语义：开=空格拆词/引号整句/通配符/|，关=整串字面）。
// 面板为临时弹层，内存态即可、不持久化，默认开启与剪贴板偏好一致
const advanced = ref(true);

/** 单条搜索结果（四模块统一的扁平展示行） */
interface SearchHit {
  module: 'clip' | 'todo' | 'note' | 'setting';
  id: number | string;
  /** 主文本：clip/note 为内容、todo 为标题、setting 为选项文案 */
  title: string;
  /** 次文本：clip 来源应用、todo 描述、setting 来源分组 */
  detail?: string;
  /** todo 专用：完成态划线展示 */
  completed?: boolean;
}

const hits = ref<SearchHit[]>([]);
/** 扁平列表中的选中索引（键盘 ↑↓ / 悬停共享） */
const selected = ref(0);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/** 请求序号：连续输入时旧查询的晚到响应不得覆盖新结果 */
let searchSeq = 0;
/** 每模块最多展示条数：控制面板高度与单次查询负载 */
const HITS_PER_MODULE = 20;

const hasQuery = computed(() => query.value.trim() !== '');

function moduleLabel(m: SearchHit['module']): string {
  return m === 'clip' ? t('global_search.module_clip')
    : m === 'todo' ? t('global_search.module_todo')
      : m === 'note' ? t('global_search.module_note')
        : t('global_search.module_setting');
}

/** 多行内容压成单行预览（换行折叠为空格；超长由 truncate 截断） */
function preview(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// ===== 设置项索引（本地内存匹配，无 DB 查询） =====

/** 索引条目：id 即 label 键（跳转后设置页按词过滤命中同一项），title/group 为当前语言文案 */
interface SettingIndexEntry { id: string; title: string; group: string }
let settingIndex: SettingIndexEntry[] = [];

/** 每次打开面板时重建：保证语言切换后索引文案与界面一致 */
function rebuildSettingIndex(): void {
  settingIndex = settings.flatMap((g) => (g.children ?? []).flatMap((c) =>
    c.items.map((it) => ({ id: it.label, title: t(it.label), group: t(c.title) }))));
}

// ===== 搜索（三模块并行查库 + 设置项本地过滤，250ms 防抖） =====

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq;
  const [clips, todos, notes] = await Promise.all([
    clipboardService.fetchClipboardData(
      { value: { favorite: 0, searchContent: q, type: 'all', advanced: advanced.value, sourceApp: '' } },
      { offset: 0, limit: HITS_PER_MODULE },
    ).catch(() => [] as ClipboardData[]),
    clipboardService.fetchTodos({ value: { searchContent: q, advanced: advanced.value } }, { offset: 0, limit: HITS_PER_MODULE }).catch(() => [] as Todo[]),
    clipboardService.fetchNotes({ value: { searchContent: q, advanced: advanced.value } }, { offset: 0, limit: HITS_PER_MODULE }).catch(() => [] as Note[]),
  ]);
  if (seq !== searchSeq) return; // 晚到响应：已有更新的查询结果在途/就位，丢弃
  // 设置项与设置页搜索同语义：按当前语言文案或 label 键包含匹配（高级词法不适用于静态清单）
  const qLower = q.toLowerCase();
  const settingHits: SearchHit[] = settingIndex
    .filter((s) => s.title.toLowerCase().includes(qLower) || s.id.toLowerCase().includes(qLower))
    .slice(0, HITS_PER_MODULE)
    .map((s) => ({ module: 'setting' as const, id: s.id, title: s.title, detail: s.group }));
  hits.value = [
    ...clips.map((c) => ({ module: 'clip' as const, id: c.id, title: c.content, detail: c.source_app ?? undefined })),
    ...todos.map((td) => ({ module: 'todo' as const, id: td.id, title: td.title, detail: td.description || undefined, completed: td.completed === 1 })),
    ...notes.map((n) => ({ module: 'note' as const, id: n.id, title: n.content })),
    ...settingHits,
  ];
  selected.value = 0;
}

watch(query, (q) => {
  if (searchTimer) clearTimeout(searchTimer);
  const trimmed = q.trim();
  if (!trimmed) {
    searchSeq++; // 作废在途请求
    hits.value = [];
    return;
  }
  searchTimer = setTimeout(() => void runSearch(trimmed), 250);
});

// ===== 开/关 =====

function open(): void {
  visible.value = true;
  rebuildSettingIndex(); // 语言切换后索引文案需跟随，打开时重建
  query.value = '';
  hits.value = [];
  selected.value = 0;
  nextTick(() => inputEl.value?.focus());
}

function close(): void {
  visible.value = false;
}

// ===== 键盘（capture 阶段，先于 ShortcutManager） =====

function scrollSelectedIntoView(): void {
  void nextTick(() => {
    const el = listEl.value?.querySelectorAll('[data-hit]')[selected.value];
    el?.scrollIntoView({ block: 'nearest' });
  });
}

function onKey(e: KeyboardEvent): void {
  // IME 组合中的按键（选字 / 候选确认）放行给输入法，不当面板快捷键处理
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopImmediatePropagation();
    const n = hits.value.length;
    if (n > 0) {
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      selected.value = (selected.value + delta + n) % n;
      scrollSelectedIntoView();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    e.stopImmediatePropagation();
    void jump(hits.value[selected.value]);
  } else if (e.key === 'Escape') {
    // 关闭入口是面板右上角 ✕（不采用 Esc 关闭）；仍需吞掉 Esc，
    // 防其落到 ShortcutManager 触发「隐藏主窗口」把整个窗口藏掉
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  // 其余按键放行：输入框需要正常输入（也不匹配任何局部快捷键的拦截语义）
}

watch(visible, (v) => {
  if (v) window.addEventListener('keydown', onKey, true);
  else window.removeEventListener('keydown', onKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  if (searchTimer) clearTimeout(searchTimer);
});

// ===== 跳转定位 =====

async function jump(hit?: SearchHit): Promise<void> {
  if (!hit) return;
  close();
  const q = query.value.trim();
  if (hit.module === 'clip') {
    // 剪贴板：index.vue 持有搜索框高亮词与选中定位管道，经总线跳转
    bus.emit('global-search:jump', { module: 'clip', query: q, clipId: Number(hit.id) });
    return;
  }
  // todo/note/setting：先切 Tab（v-if 重挂载组件），nextTick 保证目标模块已挂载并注册好监听器；
  // setting 跳转后由设置页写入搜索词进入跨分组搜索态，右侧即命中项列表
  setActiveTab(hit.module);
  await nextTick();
  bus.emit('global-search:jump', { module: hit.module, query: q });
}

onMounted(() => bus.on('global-search:toggle', open));
onBeforeUnmount(() => bus.off('global-search:toggle', open));
</script>

<template>
  <Teleport to="body">
    <!-- 蒙层压暗用原生 CSS 类 overlay-dim（rgb alpha）；背景模糊度由设置项控制
         （默认 1 ≈ 4px，调 0 回归纯半透明黑——与页面内 glass-card 嵌套时
         Chromium 可能出现"局部过亮"的合成怪癖，可关模糊规避） -->
    <div
        v-if="visible"
        class="overlay-dim fixed inset-0 z-[70] flex items-start justify-center pt-[12vh]"
        :style="overlayStyle"
        @click.self="close">
      <div class="glass-card w-[560px] max-w-[92vw] overflow-hidden rounded-2xl shadow-float">
        <!-- 输入行：通用 SearchInputBar（与剪贴板搜索框同款样式），✕ 复用为面板关闭入口 -->
        <SearchInputBar
            ref="inputEl"
            v-model="query"
            :placeholder="t('global_search.placeholder')"
            :advanced="advanced"
            :show-help="false"
            :tip-clear="t('common.close')"
            class="border-b border-line px-4 py-3"
            @update:advanced="advanced = $event"
            @clear="close"
        />
        <!-- 结果列表：空查询时整体不渲染——卡片收缩到只剩输入行，下方即蒙层透明区；
             仅有输入（无命中）时渲染并提示空结果 -->
        <div v-if="hits.length > 0 || hasQuery" ref="listEl" class="max-h-[46vh] overflow-y-auto p-2">
          <template v-if="hits.length > 0">
            <button
                v-for="(hit, i) in hits"
                :key="hit.module + '-' + hit.id"
                data-hit
                type="button"
                class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150"
                :class="i === selected ? 'bg-gold/15' : 'hover:bg-gold/5'"
                @mouseenter="selected = i"
                @click="jump(hit)">
              <span class="w-10 shrink-0 rounded-md bg-gold/10 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-4 text-gold">{{ moduleLabel(hit.module) }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm text-ink" :class="hit.completed ? 'line-through opacity-60' : ''">{{ preview(hit.title) }}</span>
                <span v-if="hit.detail" class="block truncate text-xs text-ink-faint">{{ preview(hit.detail) }}</span>
              </span>
            </button>
          </template>
          <!-- 空查询不渲染提示区（保持面板简洁）；仅有输入且无命中时提示空结果 -->
          <div v-else-if="hasQuery" class="px-3 py-8 text-center text-sm text-ink-faint">
            {{ t('global_search.empty') }}
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
