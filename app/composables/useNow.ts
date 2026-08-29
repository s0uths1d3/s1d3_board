import { ref, onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'

/**
 * 返回一个每秒刷新的当前时间戳 ref（毫秒级）。
 * 用于需要在截止时间到达时自动更新的 UI（如待办逾期状态）。
 *
 * 实现为模块级单例：全部组件实例共享同一个 ref 与同一个每秒定时器
 * （此前每个实例各建一个 setInterval，100 张待办卡片 = 101 个定时器）。
 * 通过引用计数在无消费者时停止定时器。
 */
const now: Ref<number> = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let consumers = 0

export function useNow(): Ref<number> {
  onMounted(() => {
    consumers++
    if (!timer) {
      now.value = Date.now()
      timer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    }
  })

  onBeforeUnmount(() => {
    consumers--
    if (consumers <= 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return now
}
