<script setup lang="ts">
/**
 * 日历页（独立顶级 Tab）：全窗待办日历（月/周视图 + 农历行 + 拖拽改期）。
 * 数据与变更动作经 useTodoCore 与待办列表共享同一份全量集合与同一套
 * 业务规则（完成联动/循环下一期/提醒重排），本页零业务逻辑；
 * 轮询节奏经 useTodoPolling 共享（与 TodoList 同粒度，两 Tab 互斥运行不叠加）。
 */
import { onMounted } from 'vue'
import TodoCalendar from './TodoCalendar.vue'
import { useTodoPolling } from '~/composables/useTodoPolling'
import { useTodoCore } from '~/composables/useTodoCore'

const { statsTodos, toggleTodo, updateTodo, fetchStatsAll } = useTodoCore()

/** 日历拖拽改期：保留原时刻仅改日期（TodoCalendar 已处理），复用共享更新通路 */
async function changeDueFromCalendar(id: string, dueDate: string) {
  await updateTodo(id, { dueDate })
}

// 共享轮询（3s 粒度 + 隐藏暂停 + 恢复补拉；仅 Tauri 内启动）
useTodoPolling(fetchStatsAll)

// 首次进入：先拉一次全量集合再渲染（后续由轮询保持新鲜）
onMounted(async () => {
  await fetchStatsAll()
})
</script>

<template>
  <!-- 高度链终点：h-full 让日历卡片拿到主窗口剩余高度，内部弹性分配，整页无需滚动 -->
  <div class="flex h-full min-h-0 flex-col">
    <TodoCalendar :todos="statsTodos" @change-due="changeDueFromCalendar" @toggle="toggleTodo" />
  </div>
</template>
