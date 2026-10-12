/**
 * 全局「元素拖拽进行中」计数：任一拖拽源（待办卡片重排/变子任务、日历改期、
 * 便签重排/拖出钉桌、剪贴板条目拖出）开始时 +1，结束时 -1。
 * 非响应式——仅供快捷键系统同步查询：拖拽期间按 Esc 的语义是「取消本次拖拽」
 * （组件自带 Esc 取消 / 浏览器取消 HTML5 DnD 的默认行为），hide_window 必须让位，
 * 否则拖拽取消的同时主窗口被隐藏，拖拽源失去可见反馈。
 */

let dragDepth = 0;

/** 标记一次元素拖拽开始（dragstart / 拖拽激活时调用） */
export function beginElementDrag(): void {
  dragDepth++;
}

/** 标记一次元素拖拽结束（dragend / 取消 / 组件卸载时调用，必须与 begin 配对） */
export function endElementDrag(): void {
  dragDepth = Math.max(0, dragDepth - 1);
}

/** 是否有元素拖拽进行中 */
export function isElementDragging(): boolean {
  return dragDepth > 0;
}
