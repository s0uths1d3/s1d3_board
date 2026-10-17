import { onBeforeUnmount, onMounted } from 'vue'
import { isTauri } from '~/utils/env'

/**
 * 待办模块共享轮询节奏：3s 粒度 + 窗口隐藏（托盘驻留）暂停 + 恢复可见立即补拉一次。
 * 仅在 Tauri 桌面容器内启动；宿主（TodoList / TodoCalendarPage）互斥挂载，轮询不叠加。
 * in-flight 去重 / 写库期间挂起等防护在 useTodoCore.fetchStatsAll 内部实现，此处只负责触发节奏。
 *
 * @param refetch 数据刷新回调（每次 tick / 恢复可见时调用）
 */
export function useTodoPolling(refetch: () => Promise<unknown>) {
  let pollTimer: ReturnType<typeof setInterval> | null = null

  /** 窗口从隐藏恢复可见：立即拉取一次，弥补暂停期间的空窗 */
  const onVisibilityChange = () => {
    if (!document.hidden) void refetch()
  }

  onMounted(() => {
    if (!isTauri()) return
    pollTimer = setInterval(() => {
      if (!document.hidden) void refetch()
    }, 3000)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onBeforeUnmount(() => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })
}
