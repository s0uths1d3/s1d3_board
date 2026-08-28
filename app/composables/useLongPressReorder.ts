import { onBeforeUnmount } from 'vue'

/**
 * 长按拖拽排序 composable（Pointer Events + 文档级监听）
 *
 * 交互：左键按住项超过 holdMs（默认 500ms）进入拖拽模式：
 * - 拖拽项缩放 + 阴影 + 半透明，其余项以 CSS transition 平滑让位；
 * - 指针移动到目标项上实时重排（onReorder，仅内存）；
 * - 松开指针结束拖拽，若发生过移动则 onDrop 持久化。
 *
 * 可靠性要点：pointerup / pointercancel 挂在 document 上——
 * TransitionGroup 重排会移动 DOM 节点导致指针捕获丢失、目标元素变化，
 * 依赖元素自身事件会误取消拖拽或吞掉内层按钮的点击；
 * 不使用 setPointerCapture，否则 click 会重定向到捕获元素（外层容器），
 * 内层按钮的 @click 失效。
 */
interface ReorderOptions {
  /** 长按触发时长（ms），默认 700 */
  holdMs?: number
  /** 容器选择器：在该容器内查找排序项 */
  container: string
  /** 排序项选择器（相对容器） */
  items: string
  /** 拖动轴：'x' 横向（导航栏）/ 'y' 纵向（设置分类列表） */
  axis: 'x' | 'y'
  /** 拖动中：把 fromKey 移动到 toKey 位置（仅更新顺序，不在此持久化） */
  onReorder: (fromKey: string, toKey: string) => void
  /** 松开指针：拖动结束，用于持久化顺序 */
  onDrop?: () => void
  /** 拖拽状态变化：draggingKey 非空表示正在拖动该项（用于样式反馈） */
  onStateChange?: (draggingKey: string | null) => void
}

export function useLongPressReorder(options: ReorderOptions) {
  const holdMs = options.holdMs ?? 500
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let draggingKey: string | null = null
  let dragged = false
  /**
   * 拖拽开始时采集的槽位中点快照（按拖拽开始时的 DOM 顺序索引）。
   * 槽位几何在拖拽全程不变（各键在固定槽位间移动），判定只用快照，
   * 不受让位动画中实时矩形变化的影响。
   */
  let slotCenters: number[] = []

  function containerEl(): HTMLElement | null {
    return document.querySelector(options.container)
  }

  function itemEls(): HTMLElement[] {
    return Array.from(containerEl()?.querySelectorAll(options.items) ?? []) as HTMLElement[]
  }

  /**
   * 指针移动：滞回判定 + 自由跨槽移动。
   * 右移需越过右邻槽位中心，左移需越过左邻槽位中心——两个阈值相距一个槽位，
   * 中间是死区，指针在边界附近抖动不会导致两图标来回换位；
   * while 循环支持一次移动跨多个槽位（快速划过即落到最终位置）。
   */
  function handleMove(e: PointerEvent) {
    if (!draggingKey) return
    const els = itemEls()
    // 快照缺失时兜底：用当前矩形补采（槽位几何仍视为不变）
    if (slotCenters.length === 0) {
      slotCenters = els.map(el => {
        const r = el.getBoundingClientRect()
        return options.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
      })
    }
    const from = els.findIndex(el => el.dataset.reorderKey === draggingKey)
    if (from < 0) return
    const p = options.axis === 'x' ? e.clientX : e.clientY
    let to = from
    while (to + 1 < slotCenters.length && p >= slotCenters[to + 1]!) to++
    while (to - 1 >= 0 && p <= slotCenters[to - 1]!) to--
    if (to === from) return
    const targetKey = els[to]?.dataset.reorderKey
    if (!targetKey) return
    dragged = true
    options.onReorder(draggingKey, targetKey)
  }

  /** 松开指针：结束拖拽，回调持久化。挂在 document 上，任何位置松开都会触发 */
  function handleUp() {
    // 无论处于长按等待还是拖拽中，先解除文档级监听（同函数引用，重复移除安全）
    document.removeEventListener('pointerup', handleUp)
    document.removeEventListener('pointercancel', handleUp)
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
    if (!draggingKey) return
    draggingKey = null
    slotCenters = []
    document.removeEventListener('pointermove', handleMove)
    document.body.style.userSelect = ''
    options.onStateChange?.(null)
    if (dragged) options.onDrop?.()
  }

  /** 按下：启动长按计时（不捕获指针：捕获会把 click 重定向到捕获元素，
   *  导致绑定在内层按钮上的点击失效；结束/取消由文档级监听兜底） */
  function pressStart(key: string, e: PointerEvent) {
    if (pressTimer || draggingKey) return
    // 阻止 data-tauri-drag-region 启动窗口拖拽：nav 图标需响应 pointerdown 才能长按排序
    e.preventDefault()
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
    pressTimer = setTimeout(() => {
      pressTimer = null
      draggingKey = key
      dragged = false
      // 长按触发瞬间采集槽位中点快照：此刻所有项都在静止位置，几何最准确
      slotCenters = itemEls().map(el => {
        const r = el.getBoundingClientRect()
        return options.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
      })
      document.body.style.userSelect = 'none'
      options.onStateChange?.(key)
      document.addEventListener('pointermove', handleMove)
    }, holdMs)
  }

  /** 松开/取消：结束（handleUp 统一处理） */
  function pressCancel() {
    handleUp()
  }

  /** 是否刚发生拖拽（click 处理器中调用以抑制切换），返回后重置标志 */
  function consumeDragged(): boolean {
    const v = dragged
    dragged = false
    return v
  }

  onBeforeUnmount(() => {
    pressCancel()
    document.removeEventListener('pointermove', handleMove)
    document.removeEventListener('pointerup', handleUp)
    document.removeEventListener('pointercancel', handleUp)
    document.body.style.userSelect = ''
  })

  return { pressStart, pressCancel, consumeDragged }
}
