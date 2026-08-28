import { ref, computed } from 'vue'
import statsService, { type StatField } from '~/src/statistics/statsService'
import dbService from '~/src/db/dbService'

/** 顶层页面 Tab */
export type TabKey = 'clip' | 'todo' | 'note' | 'pinned' | 'setting' | 'statistics'

const activeTabRef = ref<TabKey>('clip')

/** 当前激活 Tab */
export const activeTab = activeTabRef

export function setActiveTab(key: TabKey) {
  activeTabRef.value = key
  // 统计埋点（fire-and-forget，§5.6）：仅在真正切换时 +1
  void statsService.record({ [`tab_${key}`]: 1 } as Partial<Record<StatField, number>>)
}

/** 标题栏导航项配置（「统计」带显示门槛，见 statsUnlocked） */
export interface TabItem {
  key: TabKey
  name: string
  gate?: 'stats-unlocked'
}

export const tabItems: TabItem[] = [
  { key: 'clip', name: '剪贴板' },
  { key: 'todo', name: '待办' },
  { key: 'note', name: '便签' },
  { key: 'pinned', name: '常用剪贴板' },
  { key: 'setting', name: '设置' },
  // 统计 Tab 带显示门槛（§7.9）：活跃 ≥ 7 天 且 粘贴 ≥ 1000 次才可见
  { key: 'statistics', name: '统计', gate: 'stats-unlocked' },
]

/** 统计是否已解锁（由 statsService.isStatsUnlocked() 在启动时判定后置位，永久保持） */
export const statsUnlocked = ref(false)

// ===== 导航栏自定义配置（顺序 + 启用状态，持久化到 settings 表） =====
const NAV_CONFIG_KEY = 'nav_tab_config'

/** 用户自定义的 tab 顺序（key 数组；新版本新增 tab 兜底追加到末尾） */
const tabOrder = ref<TabKey[]>([])
/** 用户禁用的 tab（clip / setting 强制保留，不可禁用） */
const disabledTabs = ref<TabKey[]>([])

async function loadNavConfig(): Promise<void> {
  try {
    const raw = await dbService.getKeyValue(NAV_CONFIG_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const validKeys = new Set(tabItems.map(t => t.key))
      if (Array.isArray(parsed.order)) {
        tabOrder.value = parsed.order.filter((k: unknown) => typeof k === 'string' && validKeys.has(k as TabKey))
      }
      if (Array.isArray(parsed.disabled)) {
        // 剪贴板 / 设置强制保留，脏数据过滤
        disabledTabs.value = parsed.disabled.filter(
          (k: unknown) => typeof k === 'string' && validKeys.has(k as TabKey) && k !== 'clip' && k !== 'setting'
        )
      }
    }
  } catch { /* 忽略读取失败，使用默认配置 */ }
}

// 模块加载即异步读取配置（fire-and-forget）：读取完成后响应式刷新 TitleBar / 设置页
void loadNavConfig()

async function saveNavConfig(): Promise<void> {
  const all = tabItems.map(t => t.key)
  // 合并兜底：保证 order 覆盖全部 tab（新增 tab 追加到末尾）
  const merged = [...tabOrder.value.filter(k => all.includes(k)), ...all.filter(k => !tabOrder.value.includes(k))]
  tabOrder.value = merged
  try {
    await dbService.setKeyValue(NAV_CONFIG_KEY, JSON.stringify({ order: merged, disabled: disabledTabs.value }))
  } catch { /* 忽略写入失败 */ }
}

/** 内置项：剪贴板 / 设置 强制保留，防止用户无法访问功能入口 */
export function isTabLocked(key: TabKey): boolean {
  return key === 'clip' || key === 'setting'
}

/** 全部 tab 按用户顺序排列（新 tab 兜底追加末尾） */
function orderedTabs(): TabItem[] {
  const byKey = new Map(tabItems.map(t => [t.key, t]))
  const list: TabItem[] = []
  for (const k of tabOrder.value) {
    const t = byKey.get(k)
    if (t) {
      list.push(t)
      byKey.delete(k)
    }
  }
  for (const t of tabItems) {
    if (byKey.has(t.key)) list.push(t)
  }
  return list
}

/** 设置页分组行数据：tab + 启用态 + 锁定态 + 门槛标记 */
export interface NavRow {
  key: TabKey
  name: string
  enabled: boolean
  locked: boolean
  gate: boolean
}

/** 导航配置行（设置页使用）：全部 tab（含禁用项），按用户顺序排列 */
export const navRows = computed<NavRow[]>(() =>
  orderedTabs().map(t => ({
    key: t.key,
    name: t.name,
    enabled: !disabledTabs.value.includes(t.key),
    locked: isTabLocked(t.key),
    gate: t.gate === 'stats-unlocked',
  })),
)

/** 导航可见 tabs：按用户顺序，过滤禁用项与未达门槛的统计 Tab（响应式，TitleBar 直接渲染） */
export const navTabs = computed<TabItem[]>(() =>
  orderedTabs().filter(t => {
    if (t.gate === 'stats-unlocked' && !statsUnlocked.value) return false
    return !disabledTabs.value.includes(t.key)
  }),
)

export function getVisibleTabItems(): TabItem[] {
  return navTabs.value
}

// ===== 导航配置操作 =====

/** 设置 tab 启用状态：剪贴板/设置强制保留；禁用当前激活 tab 时自动切回剪贴板 */
export function setTabEnabled(key: TabKey, enabled: boolean) {
  if (isTabLocked(key) && !enabled) return
  const set = new Set(disabledTabs.value)
  if (enabled) set.delete(key)
  else set.add(key)
  disabledTabs.value = [...set]
  // 当前激活 tab 被禁用时切回剪贴板，避免停在已隐藏的页面
  if (!enabled && activeTabRef.value === key) activeTabRef.value = 'clip'
  void saveNavConfig()
}

/** 切换 tab 启用状态（设置页开关使用） */
export function toggleTabEnabled(key: TabKey) {
  const row = navRows.value.find(r => r.key === key)
  if (row) setTabEnabled(key, !row.enabled)
}

/** 调整 tab 顺序：dir=-1 上移，dir=1 下移 */
export function moveTab(key: TabKey, dir: -1 | 1) {
  const order = [...tabOrder.value]
  const i = order.indexOf(key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return
  const a = order[i]!
  const b = order[j]!
  order[i] = b
  order[j] = a
  tabOrder.value = order
  void saveNavConfig()
}

/** 拖拽排序：把 fromKey 移动到 toKey 位置（仅更新内存，配合 persistNavConfig 持久化） */
export function reorderTab(fromKey: TabKey, toKey: TabKey) {
  const order = [...tabOrder.value]
  const from = order.indexOf(fromKey)
  const to = order.indexOf(toKey)
  if (from < 0 || to < 0 || from === to) return
  order.splice(from, 1)
  order.splice(to, 0, fromKey)
  tabOrder.value = order
}

/** 持久化导航顺序/显隐配置（拖拽排序结束时调用） */
export function persistNavConfig(): Promise<void> {
  return saveNavConfig()
}
