import { ref, nextTick } from 'vue';
import type { Todo } from '~/src/Entities';

/**
 * 待办列表共享状态（与剪贴板 clipboardStore 同模式）
 *
 * TodoList.vue（渲染/列表）与本地命令（方向键选择、Ctrl+Enter 编辑、Enter 保存）
 * 统一读写这里的状态，保证「列表内容 / 选中项 / 编辑触发」始终一致。
 */

/** 当前展示的待办列表（已过滤+排序） */
export const todoList = ref<Todo[]>([]);

/** 当前选中的待办索引 */
export const selectedTodoIndex = ref(0);

/** 编辑触发信号：Ctrl+Enter 递增，TodoItem 监听后对选中项进入编辑态 */
export const editSignal = ref(0);

/** 当前选中项 */
export function getSelectedTodo(): Todo | undefined {
  return todoList.value[selectedTodoIndex.value];
}

/** 当前选中索引 */
export function getSelectedTodoIndex(): number {
  return selectedTodoIndex.value;
}

/** 点击列表行选中指定索引并滚动到可见位置 */
export function selectTodo(index: number) {
  if (index >= 0 && index < todoList.value.length) {
    selectedTodoIndex.value = index;
    scrollToSelectedTodo();
  }
}

/** 方向键上下移动选中项（-1 上移，+1 下移） */
export function moveTodoSelection(direction: -1 | 1) {
  const newIndex = selectedTodoIndex.value + direction;
  if (newIndex >= 0 && newIndex < todoList.value.length) {
    selectedTodoIndex.value = newIndex;
    scrollToSelectedTodo();
  }
}

/** 将当前选中行滚动到视口内（配合方向键移动） */
async function scrollToSelectedTodo() {
  await nextTick();
  const container = document.querySelector('#todoListContainer');
  const items = container?.querySelectorAll('.todo-item');
  const current = items?.[selectedTodoIndex.value];
  current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
