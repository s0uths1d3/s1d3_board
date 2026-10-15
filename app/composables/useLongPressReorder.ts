import { onBeforeUnmount } from 'vue'
import { beginElementDrag, endElementDrag } from '~/src/core/dragState'

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
  /** 长按触发时长（ms），默认 500 */
  holdMs?: number
  /** 容器选择器：在该容器内查找排序项 */
  container: string
  /** 排序项选择器（相对容器） */
  items: string
  /** 拖动轴：'x' 横向（导航栏）/ 'y' 纵向（设置分类列表）/ 'xy' 自由 2D（双列瀑布流，
   *  实时按指针最近卡片判定，要求 DOM 序 ≠ 数组序的场景配合 orderOf 使用） */
  axis: 'x' | 'y' | 'xy'
  /** 拖动中：把 fromKey 移动到 toKey 位置（仅更新顺序，不在此持久化） */
  onReorder: (fromKey: string, toKey: string) => void
  /** 松开指针：拖动结束，用于持久化顺序 */
  onDrop?: () => void
  /** 拖拽状态变化：draggingKey 非空表示正在拖动该项（用于样式反馈） */
  onStateChange?: (draggingKey: string | null) => void
  /** 当前数组序的 key 列表（onReorder 所操作顺序的同构视图）：Esc 取消回放还原用。
   *  DOM 序 = 视觉序 = 数组序的平铺列表可省略（回退按 DOM 序采集）；瀑布流等
   *  列优先 DOM 序场景必须提供，否则取消还原顺序错乱 */
  orderOf?: () => string[]
}

/** 'xy' 滞回死区占拖拽卡对角线的比例：换位须比占用槽位中心近此距离才放行 */
const XY_HYST_RATIO = 0.12
/** 'xy' 重锚门槛：距上次重排需静置该时长（让位动画 0.26s 结束、几何静止）才重采快照（ms） */
const XY_REANCHOR_MS = 300
/** 'xy' 重采限流：两次重采快照的最小间隔（ms），悬停时不每帧重采 */
const XY_ANCHOR_THROTTLE_MS = 120

export function useLongPressReorder(options: ReorderOptions) {
  const holdMs = options.holdMs ?? 500
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let draggingKey: string | null = null
  let dragged = false
  /**
   * 拖拽开始时采集的槽位中点快照（按拖拽开始时的 DOM 顺序索引）。
   * 槽位几何在拖拽全程不变（各键在固定槽位间移动），判定只用快照，
   * 不受让位动画中实时矩形变化的影响。'xy' 自由模式不用快照（实时判定）。
   */
  let slotCenters: number[] = []
  /** 拖拽开始时的 key 顺序快照（orderOf 优先，DOM 序兜底）：Esc 取消时回放还原顺序 */
  let initialKeys: string[] = []
  /** 'xy' 快照三件套（拖拽开始时同刻采集，判定全用快照）：
   *  - keys/centers：数组序（orderOf ?: DOM 序）的 key 列表与槽位中心几何
   *  - diag：拖拽卡对角线（阈值基准，拖拽中尺寸不变）
   *  判定不用实时 rect——重排触发的 FLIP 让位动画进行中 rect 是过渡位置，
   *  卡片滑行扫过其他槽位会再触发重排，形成判定↔几何的振荡回路（鬼畜根源）。
   *  瀑布流高度不一，重排（尤其跨列）会让两列几何漂移，快照必须随后重采，
   *  否则多次移动后漂移累积、卡片不跟鼠标。重采时机是关键：
   *  只在落位动画结束后（距上次重排 ≥XY_REANCHOR_MS）重采——此刻卡片恰好
   *  落在指针处，重采不会引发反向换位；动画进行中绝不重采（rect 是过渡值）。
   *  快照因此至多「落后一次重排」，漂移不累积，判定↔几何无振荡回路。 */
  let xyKeys: string[] = []
  let xyCenters: Array<{ x: number; y: number }> = []
  let xyDiag = 160
  /** 'xy' 模式：拖拽卡当前占用的槽位 key（随重排推进）。滞回判定的「自身」基准 */
  let occupiedKey: string | null = null
  /** 上次重排 / 上次重采快照的时间戳：重采须距上次重排 ≥XY_REANCHOR_MS（动画已结束），
   *  且限流 ≥XY_ANCHOR_THROTTLE_MS 防止悬停时每帧重采 */
  let lastReorderAt = 0
  let lastAnchorAt = 0
  let xyRafId = 0
  let pendingXY: { x: number; y: number } | null = null

  /** 采集 'xy' 快照：仅在判定几何静止时调用（pressStart 触发瞬间、拖拽中静止重锚） */
  function snapshotXy(): void {
    const els = itemEls()
    const byKey = new Map(els.map(el => [el.dataset.reorderKey ?? '', el]))
    xyKeys = currentOrder()
    xyCenters = xyKeys.map(k => {
      const el = byKey.get(k)
      if (!el) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })
    const self = byKey.get(draggingKey ?? '')
    if (self) {
      const r = self.getBoundingClientRect()
      xyDiag = Math.hypot(r.width, r.height)
    }
  }

  /** 指针到快照第 idx 槽位中心的距离平方（越界返回 Infinity） */
  function distSqTo(x: number, y: number, idx: number): number {
    const c = xyCenters[idx]
    if (!c) return Infinity
    const dx = x - c.x
    const dy = y - c.y
    return dx * dx + dy * dy
  }

  /** 最近槽位检索：快照序中距指针最近的槽位下标与距离平方 */
  function nearestSlot(x: number, y: number): { idx: number; distSq: number } {
    let idx = -1
    let distSq = Infinity
    for (let i = 0; i < xyCenters.length; i++) {
      const d = distSqTo(x, y, i)
      if (d < distSq) { distSq = d; idx = i }
    }
    return { idx, distSq }
  }

  /** 当前数组序 key 列表：orderOf 优先，缺省用 DOM 序（平铺列表时二者同构） */
  function currentOrder(): string[] {
    if (options.orderOf) return options.orderOf()
    return itemEls().map(el => el.dataset.reorderKey ?? '')
  }

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

  /**
   * 'xy' 自由模式指针移动：rAF 节流，判定用快照（xyKeys/xyCenters），最近快照槽位
   * 即落点——动画进行中的过渡 rect 永不进入判定，无「判定→重排→几何再变」振荡。
   *
   * 重锚（重采快照）：距上次重排 ≥XY_REANCHOR_MS（落位动画已结束、几何静止）且距
   * 上次重采 ≥XY_ANCHOR_THROTTLE_MS 时执行。插入语义下每次换位后卡片恰好落在指针
   * 处，重锚后指针仍最近占用槽位，不会反向换位；快照至多落后一次重排，多次移动
   * 漂移不累积（否则长拖后卡片不跟鼠标）。
   *
   * 滞回死区：换位须比「当前占用槽位」中心近 XY_HYST_RATIO×对角线才放行
   * （单轴模式有天然一个槽位宽的死区，'xy' 需显式补上）。距离超过拖拽卡对角线
   * 1.5 倍不判定，防止指针漂出列表远端时顺序乱跳。
   */
  function handleMoveXY(e: PointerEvent) {
    pendingXY = { x: e.clientX, y: e.clientY }
    if (xyRafId) return
    xyRafId = requestAnimationFrame(() => {
      xyRafId = 0
      if (!draggingKey || !pendingXY || xyCenters.length === 0) return
      const px = pendingXY.x
      const py = pendingXY.y
      const now = performance.now()
      if (now - lastReorderAt >= XY_REANCHOR_MS && now - lastAnchorAt >= XY_ANCHOR_THROTTLE_MS) {
        lastAnchorAt = now
        snapshotXy()
      }
      const hyst = xyDiag * XY_HYST_RATIO
      const near = nearestSlot(px, py)
      const targetKey = xyKeys[near.idx]
      if (!targetKey || targetKey === draggingKey || near.distSq > (xyDiag * 1.5) ** 2) return
      if (targetKey === occupiedKey) return
      // 滞回死区：换位须比「当前占用槽位」中心近 hyst 才放行
      const occIdx = xyKeys.indexOf(occupiedKey ?? '')
      if (occIdx >= 0 && Math.sqrt(near.distSq) > Math.sqrt(distSqTo(px, py, occIdx)) - hyst) return
      dragged = true
      occupiedKey = targetKey
      lastReorderAt = now
      options.onReorder(draggingKey, targetKey)
    })
  }

  /** 统一收尾：解除文档级监听与节流帧（handleUp / handleKeydown / 卸载共用） */
  function detachDragListeners() {
    document.removeEventListener('pointermove', options.axis === 'xy' ? handleMoveXY : handleMove)
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('pointerup', handleUp)
    document.removeEventListener('pointercancel', handleUp)
    if (xyRafId) { cancelAnimationFrame(xyRafId); xyRafId = 0 }
    pendingXY = null
  }

  /** 松开指针：结束拖拽，回调持久化。挂在 document 上，任何位置松开都会触发 */
  function handleUp() {
    // 无论处于长按等待还是拖拽中，先解除文档级监听（同函数引用，重复移除安全）
    detachDragListeners()
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
    }
    if (!draggingKey) return
    draggingKey = null
    occupiedKey = null
    // 归还全局拖拽计数：拖动中按 Esc 让位取消拖拽，不触发 hide_window（与 begin 配对）
    endElementDrag()
    slotCenters = []
    initialKeys = []
    xyKeys = []
    xyCenters = []
    document.body.style.userSelect = ''
    options.onStateChange?.(null)
    if (dragged) options.onDrop?.()
  }

  /** 拖拽中按 Esc：取消本次移动——回放 onReorder 还原到拖拽开始前的顺序（仅内存，
   *  不触发 onDrop 故不持久化）。dragged 保持原值：发生移动过则随后的 click 仍被
   *  consumeDragged 抑制（取消手势的残留），未移动过则松手视为普通点击。
   *  在 document 阶段 stopPropagation 拦断冒泡：取消清理会先归零全局拖拽计数，
   *  若事件继续到 window，快捷键系统会因计数已归零而把同一次 Esc 判定为隐藏主窗口。 */
  function handleKeydown(e: KeyboardEvent) {
    if (!draggingKey || e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    // 逐槽归位回放：对每个位置 i，把初始 key 移回其原槽位（onReorder 语义：from 移到 to 的位置）
    if (initialKeys.length > 0) {
      const cur = currentOrder()
      for (let i = 0; i < initialKeys.length && i < cur.length; i++) {
        const want = initialKeys[i]!
        if (cur[i] === want) continue
        const to = cur.indexOf(cur[i]!)
        const from = cur.indexOf(want)
        if (from < 0 || to < 0) break
        options.onReorder(want, cur[i]!)
        cur.splice(from, 1)
        cur.splice(to, 0, want)
      }
    }
    draggingKey = null
    occupiedKey = null
    lastAnchorAt = 0
    slotCenters = []
    initialKeys = []
    xyKeys = []
    xyCenters = []
    detachDragListeners()
    document.body.style.userSelect = ''
    options.onStateChange?.(null)
    // 归还全局拖拽计数（与 begin 配对；pointerup 监听保留到 detach——
    // 取消时一并解除，松手由浏览器原生 click 收尾）
    endElementDrag()
  }

  /** 按下：启动长按计时（不捕获指针：捕获会把 click 重定向到捕获元素，
   *  导致绑定在内层按钮上的点击失效；结束/取消由文档级监听兜底） */
  function pressStart(key: string, e: PointerEvent) {
    if (pressTimer || draggingKey) return
    // 仅左键启动：右键/中键（含 contextmenu）不进入长按拖拽
    if (e.button !== 0) return
    // 阻止 data-tauri-drag-region 启动窗口拖拽：nav 图标需响应 pointerdown 才能长按排序
    e.preventDefault()
    const moveHandler = options.axis === 'xy' ? handleMoveXY : handleMove
    document.addEventListener('pointerup', handleUp)
    document.addEventListener('pointercancel', handleUp)
    pressTimer = setTimeout(() => {
      pressTimer = null
      draggingKey = key
      dragged = false
      occupiedKey = key
      lastReorderAt = performance.now()
      lastAnchorAt = lastReorderAt
      // 全局拖拽计数 +1：拖动中按 Esc 取消本次拖拽，不触发 hide_window
      beginElementDrag()
      // 长按触发瞬间采集：key 顺序快照（Esc 取消还原用）+ 单轴槽位中点快照（此刻
      // 所有项都在静止位置，几何最准确；'xy' 模式用快照三件套，判定只用它）
      initialKeys = currentOrder()
      if (options.axis === 'xy') {
        snapshotXy()
      } else {
        slotCenters = itemEls().map(el => {
          const r = el.getBoundingClientRect()
          return options.axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
        })
      }
      document.body.style.userSelect = 'none'
      options.onStateChange?.(key)
      document.addEventListener('pointermove', moveHandler)
      document.addEventListener('keydown', handleKeydown)
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
    detachDragListeners()
    document.body.style.userSelect = ''
  })

  return { pressStart, pressCancel, consumeDragged }
}
