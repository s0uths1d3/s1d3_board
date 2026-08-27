import { ref, onMounted, onBeforeUnmount } from 'vue'

/**
 * 返回一个每秒刷新的当前时间戳 ref（毫秒级）。
 * 用于需要在截止时间到达时自动更新的 UI（如待办逾期状态）。
 */
export function useNow(interval = 1000) {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, interval)
  })

  onBeforeUnmount(() => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return now
}
