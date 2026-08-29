import type { Todo } from '../entities';

/**
 * 判断待办是否已逾期：有截止时间且早于给定时刻。
 * 供 TodoList（筛选/准时率统计）与 Todoitem（卡片徽标）共用，
 * 避免两处各自实现、守卫不一致（一处有 isNaN 守卫一处靠 NaN 比较的巧合）。
 */
export function isTodoOverdue(todo: Todo, nowMs: number): boolean {
  if (!todo.dueDate) return false;
  const t = new Date(todo.dueDate).getTime();
  // 解析失败（非法日期串）视为未逾期，而非 NaN 比较的偶然 false
  return Number.isFinite(t) && t <= nowMs;
}
