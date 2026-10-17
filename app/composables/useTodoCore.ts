import { ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import type { Todo } from '~/src/entities'
import clipboardService from '~/src/db/dbService'
import { nextDueDate } from '~/src/todo/recurrence'
import reminderService from '~/src/todo/reminderService'
import statsService from '~/src/statistics/statsService'
import { CLIP_SOURCE_LINK_TITLE } from '~/src/commands/local/dispatchClip'
import { notifyIsland } from '~/composables/useCopyIsland'
import { useI18n } from '~/composables/useI18n'

/**
 * 待办核心变更链路（模块级单例）：任务全量集合 + 完成/更新/改期等变更动作。
 * 消费方：TodoList（待办 Tab）与 TodoCalendarPage（独立日历 Tab）共用同一份
 * statsTodos 与同一套变更函数——业务规则（父子完成联动、循环下一期、剪贴板回写、
 * 提醒重排、统计埋点）只存在一份，两处宿主零重复。
 *
 * 已加载列表桥（registerTodoListBridge）：流式分页列表是 TodoList 的组件局部状态，
 * 经桥注入实体同步/新增前置两个钩子；日历页等无列表宿主不注册，动作为空操作。
 *
 * 激活模型：与 useTabs 同款模块级单例——statsTodos 跨 Tab 存活，切换 Tab 不丢数据；
 * 轮询由各宿主挂载期间自驱（互斥运行不叠加），写库计数全局共享保证竞态防护不漏。
 */

/** 全量待办集合（轮询全量查询结果）：日历数据源 + 提醒调度 + 统计口径 */
const statsTodos = ref<Todo[]>([])
/** 写库进行中计数：>0 时轮询跳过，防止拿旧数据覆盖乐观更新（竞态根源） */
let pendingWrites = 0
/** 全量拉取 in-flight 去重：上一轮未完成时跳过，避免 DB 慢时请求堆积 */
let fetching = false

/** 已加载列表桥：syncTodo = 实体变更同步到已加载列表；prependTodo = 新任务插到列表头部 */
let listBridge: { syncTodo?: (todo: Todo) => void; prependTodo?: (todo: Todo) => void } = {}

/** 注册已加载列表桥（TodoList 挂载时调用；重复注册以最后一次为准） */
export function registerTodoListBridge(bridge: typeof listBridge): void {
  listBridge = bridge
}

export function useTodoCore() {
  const { t } = useI18n()

  const isFetching = () => fetching

  /** 乐观更新同步到统计全量集合（statsTodos 可能比已加载列表大，需单独同步） */
  function applyToStats(todo: Todo) {
    const t2 = statsTodos.value.find(x => x.id === todo.id)
    if (t2) Object.assign(t2, todo)
  }

  /** 实体变更同步：已加载列表（桥）+ 统计全量集合（同一引用时 Object.assign 幂等） */
  function syncTodoRef(todo: Todo) {
    listBridge.syncTodo?.(todo)
    applyToStats(todo)
  }

  /** 写库包装：失败日志/回调 + 进行中计数（轮询据此挂起，防旧数据覆盖乐观更新） */
  async function withDbWrite(fn: () => Promise<void>, onFail?: (error: unknown) => void): Promise<boolean> {
    pendingWrites++
    try {
      await fn()
      return true
    } catch (error) {
      console.error('[todo] 数据库写入失败:', error)
      onFail?.(error)
      return false
    } finally {
      pendingWrites--
    }
  }

  /** 查找任务：全量集合即数据超集（含已加载列表全部任务），单一来源查找 */
  const findTodo = (id: string) => statsTodos.value.find(t => t.id === id)

  /** 全量拉取：确保调度服务启动（幂等）+ 全量查询 + reminder 同步；guard 语义与轮询契约见 fetching/pendingWrites */
  async function fetchStatsAll(opts?: { force?: boolean }): Promise<boolean> {
    if (fetching) return false
    if (!opts?.force && pendingWrites > 0) return false
    fetching = true
    try {
      await reminderService.start()
      const all = await clipboardService.fetchTodos({ value: { searchContent: '' } })
      statsTodos.value = all
      void reminderService.sync(all)
      return true
    } catch (error) {
      console.error('[todo] 全量待办拉取失败:', error)
      return false
    } finally {
      fetching = false
    }
  }

  /**
   * 循环任务完成：生成下一期（继承全部业务字段，刷新 id/完成态/时间戳；
   * sortOrder 继承原值使下一期出现在原位置附近，提醒规则继承相对规则自然顺延）。
   */
  async function spawnRecurrenceNext(todo: Todo): Promise<void> {
    if (!todo.recurrence) return
    const nowMs = Date.now()
    const next: Todo = {
      ...todo,
      id: uuidv4(),
      completed: 0,
      dueDate: nextDueDate(todo.dueDate || '', todo.recurrence, nowMs),
      remindRules: [...(todo.remindRules ?? [])],
      tags: [...(todo.tags ?? [])],
      links: [...(todo.links ?? [])],
      created_at: String(nowMs),
      updated_at: String(nowMs),
    }
    const ok = await withDbWrite(() => clipboardService.insertTodo(next))
    if (!ok) return
    listBridge.prependTodo?.(next)
    statsTodos.value.unshift(next)
  }

  /** 单条任务完成态落库（乐观更新 + 失败回滚 + 引用同步）；父子联动时对每条任务复用 */
  async function setCompletedState(todo: Todo, completed: 0 | 1): Promise<boolean> {
    const prevCompleted = todo.completed
    const prevUpdatedAt = todo.updated_at
    todo.completed = completed
    todo.updated_at = String(Date.now())
    const ok = await withDbWrite(() => clipboardService.updateTodo(todo), () => {
      notifyIsland({ kind: 'error', text: t('todo.update_failed') })
    })
    if (!ok) {
      // 写库失败：回滚乐观更新，保证 UI 与数据库一致
      todo.completed = prevCompleted
      todo.updated_at = prevUpdatedAt
      return false
    }
    syncTodoRef(todo)
    return true
  }

  /** 完成态切换入口：灵动岛反馈 + 循环下一期 + 提醒重排 + 统计埋点 + 来源剪贴板回写 + 父子联动 */
  const toggleTodo = async (id: string) => {
    const todo = findTodo(id)
    if (!todo) return
    const completing = todo.completed === 0
    const target: 0 | 1 = completing ? 1 : 0
    const ok = await setCompletedState(todo, target)
    if (!ok) return
    // 灵动岛反馈：完成（success）/ 取消完成（info）
    notifyIsland({ kind: completing ? 'success' : 'info', text: t(completing ? 'todo.island_completed' : 'todo.island_uncompleted', { title: todo.title.slice(0, 100) }) })
    // 循环任务完成：生成下一期（仅顶级任务参与循环；下一期继承规则与业务字段）
    if (completing && todo.recurrence && !todo.parentId) {
      await spawnRecurrenceNext(todo)
    }
    // 完成状态变化影响提醒计划，同步给调度服务（完成 → 撤销其全部提醒）；联动落库后统一同步一次
    void reminderService.sync(statsTodos.value)
    // 统计埋点（fire-and-forget）：仅"切换为完成"时 +1（级联不重复计）
    if (completing) {
      void statsService.record({ todo_completed: 1 })
      // 来源剪贴板回写（跨模块联动）：经"转为待办"创建的任务完成时，
      // 反哺其来源剪贴板条目的使用计数（links 里以 title=clipboard 标记来源）
      for (const link of todo.links ?? []) {
        if (link.title === CLIP_SOURCE_LINK_TITLE && link.url) {
          void clipboardService.increaseUseCountByContent(link.url)
        }
      }
    }

    // ===== 父子完成状态联动 =====
    // 主任务勾/取消 → 全部子任务同步（用全量集合而非已加载列表：未加载进列表的子任务也要联动）
    if (!todo.parentId) {
      for (const child of statsTodos.value.filter(t => t.parentId === id && t.completed !== target)) {
        await setCompletedState(child, target)
      }
      return
    }
    // 子任务勾/取消 → 主任务联动：子任务全部完成时主任务自动完成；任一子任务取消时已完成的主任务回退
    const parent = findTodo(todo.parentId)
    if (!parent) return
    const siblings = statsTodos.value.filter(t => t.parentId === todo.parentId)
    const allDone = siblings.every(t => t.completed === 1)
    if (allDone && parent.completed === 0) {
      const parentOk = await setCompletedState(parent, 1)
      if (!parentOk) return
      // 主任务补齐联动与手动完成同语义：灵动岛反馈 + 循环下一期 + 统计 + 剪贴板回写
      notifyIsland({ kind: 'success', text: t('todo.island_completed', { title: parent.title.slice(0, 100) }) })
      if (parent.recurrence) await spawnRecurrenceNext(parent)
      void statsService.record({ todo_completed: 1 })
      for (const link of parent.links ?? []) {
        if (link.title === CLIP_SOURCE_LINK_TITLE && link.url) {
          void clipboardService.increaseUseCountByContent(link.url)
        }
      }
    } else if (!allDone && parent.completed === 1) {
      const parentOk = await setCompletedState(parent, 0)
      if (!parentOk) return
      notifyIsland({ kind: 'info', text: t('todo.island_uncompleted', { title: parent.title.slice(0, 100) }) })
    }
  }

  /** 字段更新通路：乐观更新 + 落库 + 引用同步 + 提醒重排（截止时间/提醒/完成态都可能变化） */
  const updateTodo = async (id: string, updates: Partial<Todo>) => {
    const todo = findTodo(id)
    if (todo) {
      Object.assign(todo, updates, { updated_at: String(Date.now()) })
      const ok = await withDbWrite(() => clipboardService.updateTodo(todo))
      if (!ok) return
      syncTodoRef(todo)
      void reminderService.sync(statsTodos.value)
    }
  }

  return {
    statsTodos,
    isFetching,
    fetchStatsAll,
    applyToStats,
    syncTodoRef,
    withDbWrite,
    findTodo,
    toggleTodo,
    updateTodo,
  }
}
