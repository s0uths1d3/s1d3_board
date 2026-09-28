import { ref, nextTick } from 'vue';
import type { ClipboardData } from '~/src/entities';
import clipboardService from '~/src/db/dbService';
import { bus } from '~/src/core/events';

/**
 * 剪贴板列表共享状态
 *
 * index.vue（页面渲染）与本地命令（方向键选择、Enter 粘贴、删除、收藏）
 * 统一读写这里的状态，保证“列表内容 / 选中项 / 过滤条件”始终一致，
 * 避免此前 data/filter 分散在不同模块导致的选择与粘贴错位。
 *
 * 流式加载：首屏只加载第一页（pageSize 条），滚动到底部（index.vue 的 sentinel
 * 进入视口）时 loadMoreClips() 加载下一页；轮询/切回 Tab 时 fetchData() 只刷新
 * 已加载范围，不会预取未加载数据。
 */

/** 流式分页页大小（含图片 base64，单页不宜过大） */
export const PAGE_SIZE = 50;

/** 当前展示的剪贴板条目（已按 filter 过滤 + 已加载部分） */
export const data = ref<ClipboardData[]>([]);

/** 当前列表长度（方向键下移的边界） */
export const dataLength = ref(0);

/** 当前选中的行索引 */
export const selectedRowIndex = ref(0);

/** 是否还有未加载的下一页 */
export const hasMore = ref(true);

/** 加载下一页进行中（sentinel 显示"加载中…"） */
export const loadingMore = ref(false);

// ===== 批量选择（Ctrl/Shift+点击多选，配合列表上方工具栏批量删除/收藏/复制） =====

/** 批量选中的条目 id 集合（普通点击 / Esc / 列表重置时清空） */
export const batchSelectedIds = ref<Set<number>>(new Set());

/** Shift 范围选择的锚点行索引（-1 = 无锚点，下次以当前键盘选中行为锚） */
let batchAnchorIndex = -1;

/** Ctrl/Cmd+点击：切换某条目的批量选中态（index 同步为键盘导航选中行） */
export function toggleBatchSelect(id: number, index: number) {
  const next = new Set(batchSelectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  batchSelectedIds.value = next;
  batchAnchorIndex = next.size > 0 ? index : -1;
  selectedRowIndex.value = index;
}

/** Shift+点击：从锚点行到当前行范围全选（无锚点时以当前键盘选中行为锚） */
export function selectBatchRange(index: number) {
  if (batchAnchorIndex < 0) batchAnchorIndex = selectedRowIndex.value;
  const lo = Math.min(batchAnchorIndex, index);
  const hi = Math.max(batchAnchorIndex, index);
  const next = new Set(batchSelectedIds.value);
  for (let i = lo; i <= hi; i++) {
    const it = data.value[i];
    if (it) next.add(it.id);
  }
  batchSelectedIds.value = next;
  selectedRowIndex.value = index;
}

/** 清空批量选择（普通点击 / Esc / 批量操作完成 / 列表重置） */
export function clearBatchSelection() {
  batchSelectedIds.value = new Set();
  batchAnchorIndex = -1;
}

/** 过滤条件：是否仅收藏 + 搜索关键字 + 类型筛选（all 全部 / image 仅图片）+ 高级搜索开关 */
export const filter = ref({
  favorite: 0,
  searchContent: '',
  type: 'all' as 'all' | 'image',
  // 高级搜索：true = 空格拆词 AND + 引号整句；false = 整串按字面单词元匹配
  advanced: true,
});

/** 高级搜索开关持久化键（settings KV）：'1' 开 / '0' 关 */
const ADVANCED_SEARCH_KEY = 'advanced_search';

/** 用户已显式切换过开关：挂载恢复的晚到响应不得覆盖用户操作（防点击开启后被恢复结果关闭） */
let advancedTouched = false;

/** 恢复高级搜索开关（剪贴板页挂载时调用；读取失败保持默认开启） */
export async function restoreAdvancedSearch(): Promise<void> {
  try {
    const raw = await clipboardService.getKeyValue(ADVANCED_SEARCH_KEY);
    if (advancedTouched) return; // 恢复请求发起后用户已手动切换：本次结果作废
    filter.value.advanced = raw !== '0';
  } catch { /* DB 未就绪等异常：保持默认值 */ }
}

/** 设置高级搜索开关并持久化（状态即时生效驱动重查；持久化失败仅记日志） */
export async function setAdvancedSearch(v: boolean): Promise<void> {
  advancedTouched = true;
  filter.value.advanced = v;
  try {
    await clipboardService.setKeyValue(ADVANCED_SEARCH_KEY, v ? '1' : '0');
  } catch (e) {
    console.error('保存高级搜索开关失败:', e);
  }
}

/**
 * 上一次拉取结果的指纹（id:updated_at:count:is_favorite 拼接）。
 * 用于判断数据库内容是否变化，未变化时跳过 data.value 重赋值，
 * 避免每秒轮询触发全列表无谓重渲染（尤其图片 base64 大字段）导致明显卡顿。
 */
let lastSignature: string | null = null;
/** 加载进行中互斥标记（fetchData / loadMoreClips / resetClips 不并发） */
let inFlight = false;

/**
 * 刷新已加载范围：拉取最新前 max(已加载数, 页大小) 条替换。
 * 用于每秒轮询、切回剪贴板 Tab、删除/收藏等操作后的同步；
 * 不预取未加载数据，已加载条数保持不变（数据库变少时随之收缩）。
 */
export async function fetchData() {
  if (inFlight) return;
  inFlight = true;
  try {
    const limit = Math.max(data.value.length, PAGE_SIZE);
    const result = await clipboardService.fetchClipboardData(filter, { offset: 0, limit });
    // 计算签名：仅当任意条目的 updated_at/count/收藏态或集合本身变化时，才触发响应式更新
    const signature = result
      .map((r) => `${r.id}:${r.updated_at}:${r.count}:${r.is_favorite}`)
      .join('|');
    if (signature === lastSignature) return; // 数据未变：跳过，零重渲染
    lastSignature = signature;

    data.value = result;
    dataLength.value = data.value.length;
    hasMore.value = result.length >= limit;

    // 修正选中索引：列表变短时上移，空列表归零
    if (selectedRowIndex.value >= data.value.length) {
      selectedRowIndex.value = data.value.length - 1;
    }
    if (selectedRowIndex.value < 0) {
      selectedRowIndex.value = 0;
    }
  } catch (err) {
    console.error(err);
    // 通知页面层提示（index.vue 弹错误 hint）：DB 故障时不再只表现为「列表静默没反应」
    bus.emit('clip:load-failed');
  } finally {
    inFlight = false;
  }
}

/** 加载下一页（滚动到底部触发）：从当前已加载条数处继续拉取 */
export async function loadMoreClips() {
  if (inFlight || !hasMore.value) return;
  inFlight = true;
  loadingMore.value = true;
  try {
    const offset = data.value.length;
    const fetched = await clipboardService.fetchClipboardData(filter, { offset, limit: PAGE_SIZE });
    // 顶部插入新数据时 offset 会重叠，按 id 去重合并
    const seen = new Set(data.value.map((d) => d.id));
    const fresh = fetched.filter((d) => !seen.has(d.id));
    data.value = [...data.value, ...fresh];
    dataLength.value = data.value.length;
    hasMore.value = fetched.length >= PAGE_SIZE;
  } catch (err) {
    console.error('加载更多剪贴板失败:', err);
  } finally {
    inFlight = false;
    loadingMore.value = false;
  }
}

/** 重置：清空已加载并重新加载第一页（搜索词/收藏/类型筛选变化时） */
export async function resetClips() {
  // 等待当前加载完成后再重置（轮询/加载更多进行中时等待，用户操作优先级高）
  while (inFlight) {
    await new Promise((r) => setTimeout(r, 50));
  }
  inFlight = true;
  try {
    // 不先清空 data：旧列表保留展示到新结果替换为止，避免改筛选/搜索词的瞬间闪一屏空白；
    // lastSignature 已置 null，fetchData 拿到结果必定替换；拉取失败时旧列表保留而非消失
    lastSignature = null;
    selectedRowIndex.value = 0;
    // 搜索词/筛选变化后旧 id 集合失效，批量选择一并清空
    batchSelectedIds.value = new Set();
    batchAnchorIndex = -1;
    hasMore.value = true;
  } finally {
    inFlight = false;
  }
  await fetchData();
}

/** 当前选中行的索引 */
export function getSelectedRowIndex(): number {
  return selectedRowIndex.value;
}

/** 当前选中条目的 id（空列表时返回 undefined） */
export function getSelectedRowId(): number | undefined {
  return data.value[selectedRowIndex.value]?.id;
}

/** 当前选中的完整条目（删除/收藏等操作使用，避免依赖易过期的外部引用） */
export function getSelectedItem(): ClipboardData | undefined {
  return data.value[selectedRowIndex.value];
}

/** 当前选中条目的内容（PasteCommand 粘贴时使用），含类型以便区分文本/图片 */
export function getSelectedContent(): { content: string; type: 'text' | 'image' } | undefined {
  const item = data.value[selectedRowIndex.value];
  if (!item) return undefined;
  return { content: item.content, type: item.type ?? 'text' };
}

/** 点击列表行时选中指定索引并滚动到可见位置 */
export function selectRow(index: number) {
  if (index >= 0 && index < dataLength.value) {
    selectedRowIndex.value = index;
    scrollToSelectedRow();
  }
}

/** 方向键上下移动选中项（-1 上移，+1 下移），统一在列表本地处理，避免丢失焦点导致只能移动一格 */
export function moveSelection(direction: -1 | 1) {
  const newIndex = selectedRowIndex.value + direction;
  if (newIndex >= 0 && newIndex < dataLength.value) {
    selectedRowIndex.value = newIndex;
    scrollToSelectedRow();
  }
}

/** 将当前选中行滚动到视口内（配合方向键移动） */
async function scrollToSelectedRow() {
  await nextTick();
  const listElement = document.querySelector('#listElement');
  const listItems = listElement?.querySelectorAll('.list-row');
  const currentItem = listItems?.[selectedRowIndex.value];
  currentItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
