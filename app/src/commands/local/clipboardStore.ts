import { ref, nextTick } from 'vue';
import type { ClipboardData } from '~/src/Entities';
import clipboardService from '~/src/db/dbService';

/**
 * 剪贴板列表共享状态
 *
 * index.vue（页面渲染）与本地命令（方向键选择、Enter 粘贴、删除、收藏）
 * 统一读写这里的状态，保证“列表内容 / 选中项 / 过滤条件”始终一致，
 * 避免此前 data/filter 分散在不同模块导致的选择与粘贴错位。
 */

/** 当前展示的剪贴板条目（已按 filter 过滤） */
export const data = ref<ClipboardData[]>([]);

/** 当前列表长度（方向键下移的边界） */
export const dataLength = ref(0);

/** 当前选中的行索引 */
export const selectedRowIndex = ref(0);

/** 过滤条件：是否仅收藏 + 搜索关键字 + 类型筛选（all 全部 / image 仅图片） */
export const filter = ref({
  favorite: 0,
  searchContent: '',
  type: 'all' as 'all' | 'image',
});

/**
 * 拉取剪贴板数据并刷新列表。
 * 成功后自动修正 selectedRowIndex 越界，保证高亮始终落在有效行上。
 */
export async function fetchData() {
  try {
    const result = await clipboardService.fetchClipboardData(filter);
    data.value = result;
    dataLength.value = data.value.length;

    // 修正选中索引：列表变短时上移，空列表归零
    if (selectedRowIndex.value >= data.value.length) {
      selectedRowIndex.value = data.value.length - 1;
    }
    if (selectedRowIndex.value < 0) {
      selectedRowIndex.value = 0;
    }
  } catch (err) {
    console.error(err);
  }
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

/** 将当前选中行滚动到视口内（配合方向键移动） */
async function scrollToSelectedRow() {
  await nextTick();
  const listElement = document.querySelector('#listElement');
  const listItems = listElement?.querySelectorAll('.list-row');
  const currentItem = listItems?.[selectedRowIndex.value];
  currentItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
