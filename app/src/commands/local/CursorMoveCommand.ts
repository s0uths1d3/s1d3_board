import type { Command } from '../Command';
import { moveSelection } from './clipboardStore';
import { moveTodoSelection } from './todoStore';
import { activeTab } from '~/composables/useTabs';

/**
 * 上下方向键选择命令（统一按方向参数构造）
 *
 * 主剪贴板（'clip'）统一走 clipboardStore.moveSelection（与 index.vue 页面内导航共用一份实现）；
 * 待办（'todo'）状态来自 todoStore：moveTodoSelection(-1 / +1)。
 * 常用剪贴页有独立的键盘交互，避免两个列表的方向键互相干扰。
 */

/** 焦点是否在文本输入框/文本域（编辑态）：此时方向键用于移动光标，不切换列表选中项。
 *  待办搜索框（.todo-search-input）除外——方向键仍用于切换列表选中项。
 *  ShortcutManager 的全局编辑态守卫已先行拦截（同样豁免该搜索框），此处为二次防御。 */
function isEditingExceptTodoSearch(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  return !el.classList.contains('todo-search-input');
}

export class CursorMoveCommand implements Command {
    /** -1 = 上移/上一项，1 = 下移/下一项 */
    constructor(private readonly direction: -1 | 1) {}

    async execute(): Promise<void> {
        if (activeTab.value === 'todo') {
            if (isEditingExceptTodoSearch()) return;
            moveTodoSelection(this.direction);
            return;
        }
        if (activeTab.value !== 'clip') return;
        moveSelection(this.direction);
    }
}
