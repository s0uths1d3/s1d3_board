import { ref, computed } from 'vue'
import statsService, { type StatField } from '~/src/statistics/statsService'
import dbService from '~/src/db/dbService'
import { DEFAULT_DISABLED_TABS, TAB_KEYS, type TabKey } from '~/src/tabs/tabKeys'

// Tab 键/顺序/默认收起集的权威定义在 ~/src/tabs/tabKeys（叶子模块，避免与 statsService 成环），此处仅转发既有导入路径
export type { TabKey } from '~/src/tabs/tabKeys'

const activeTabRef = ref<TabKey>('clip')

/** 当前激活 Tab */
export const activeTab = activeTabRef

export function setActiveTab(key: TabKey) {
  // 同值守卫：反复点击当前 Tab 不应计入统计（注释语义与行为一致，避免 tab_x 虚高）
  if (activeTabRef.value === key) return
  activeTabRef.value = key
  // 持久化上次激活 Tab：启动时恢复到用户离开时的模块（fire-and-forget，不阻塞切换）
  void dbService.setKeyValue(LAST_TAB_KEY, key).catch(() => {})
  // 统计埋点（fire-and-forget，§5.6）：仅在真正切换时 +1
  void statsService.record({ [`tab_${key}`]: 1 } as Partial<Record<StatField, number>>)
}

/** 标题栏导航项（展示名由 i18n 承担：t('titlebar.' + key)，不落数据） */
export interface TabItem {
  key: TabKey
}

/** 由 TAB_KEYS 单点派生；设置固定最末（叶子模块已按此排序） */
export const tabItems: TabItem[] = TAB_KEYS.map(key => ({ key }))

// ===== 导航栏自定义配置（顺序 + 启用状态，持久化到 settings 表） =====
const NAV_CONFIG_KEY = 'nav_tab_config'
/** 上次激活 Tab 的持久化键：启动时恢复到用户离开时的模块，而非固定剪贴板 */
const LAST_TAB_KEY = 'nav_last_tab'

/** 顺序归一：「设置」固定 nav 最右/导航栏设置列表最下（工具位惯例，不参与排序）。
 *  所有产生顺序的路径（读取配置/拖拽/上移下移/持久化合并）统一在此收敛，单规则单出口 */
function withSettingLast(order: TabKey[]): TabKey[] {
  return [...order.filter(k => k !== 'setting'), 'setting']
}

/** 用户自定义的 tab 顺序（key 数组；新版本新增 tab 兜底追加到末尾） */
const tabOrder = ref<TabKey[]>([])
/** 用户禁用的 tab（clip / setting 强制保留，不可禁用） */
const disabledTabs = ref<TabKey[]>([])

async function loadNavConfig(): Promise<void> {
  try {
    const raw = await dbService.getKeyValue(NAV_CONFIG_KEY)
    // 函数作用域：下方"恢复上次激活 Tab"分支在 if (raw) 之外也要使用
    const validKeys = new Set(tabItems.map(t => t.key))
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed.order)) {
        tabOrder.value = withSettingLast(parsed.order.filter((k: unknown) => typeof k === 'string' && validKeys.has(k as TabKey)))
      }
      if (Array.isArray(parsed.disabled)) {
        // 剪贴板 / 设置强制保留，脏数据过滤
        disabledTabs.value = parsed.disabled.filter(
          (k: unknown) => typeof k === 'string' && validKeys.has(k as TabKey) && k !== 'clip' && k !== 'setting'
        )
      }
    } else {
      // 全新安装：默认只亮四核心，次要功能（常用剪贴板/应用时长/统计）在设置页 opt-in
      disabledTabs.value = [...DEFAULT_DISABLED_TABS]
    }
    // 恢复上次激活的 Tab：重启后回到用户离开时的模块，而非固定剪贴板。
    // 放在 disabled 解析之后，恢复目标若已被禁用则保持默认剪贴板。
    try {
      const last = await dbService.getKeyValue(LAST_TAB_KEY)
      if (
        typeof last === 'string' &&
        validKeys.has(last as TabKey) &&
        !disabledTabs.value.includes(last as TabKey)
      ) {
        activeTabRef.value = last as TabKey
      }
    } catch { /* 读取失败保持默认剪贴板 */ }
  } catch {
    // 读取失败与全新安装同口径：应用默认收起集（fail-closed），
    // 避免异常时意外亮出全部次要功能（用户改动会被下次成功保存覆盖）
    disabledTabs.value = [...DEFAULT_DISABLED_TABS]
  }
}

// 模块加载即异步读取配置（fire-and-forget）：读取完成后响应式刷新 TitleBar / 设置页
void loadNavConfig()

async function saveNavConfig(): Promise<void> {
  const all = tabItems.map(t => t.key)
  // 合并兜底：保证 order 覆盖全部 tab（新增 tab 追加到末尾）；设置归一固定最末
  const merged = withSettingLast([...tabOrder.value.filter(k => all.includes(k)), ...all.filter(k => !tabOrder.value.includes(k))])
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

/** 设置页分组行数据：tab + 启用态 + 锁定态（展示名由 i18n 承担） */
export interface NavRow {
  key: TabKey
  enabled: boolean
  locked: boolean
}

/** 导航配置行（设置页使用）：全部 tab（含禁用项），按用户顺序排列 */
export const navRows = computed<NavRow[]>(() =>
  orderedTabs().map(t => ({
    key: t.key,
    enabled: !disabledTabs.value.includes(t.key),
    locked: isTabLocked(t.key),
  })),
)

/** 导航可见 tabs：按用户顺序，过滤禁用项（响应式，TitleBar 直接渲染） */
export const navTabs = computed<TabItem[]>(() =>
  orderedTabs().filter(t => !disabledTabs.value.includes(t.key)),
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
  // 当前激活 tab 被禁用时切回剪贴板，避免停在已隐藏的页面（同步持久化恢复点）
  if (!enabled && activeTabRef.value === key) {
    activeTabRef.value = 'clip'
    void dbService.setKeyValue(LAST_TAB_KEY, 'clip').catch(() => {})
  }
  void saveNavConfig()
}

/** 切换 tab 启用状态（设置页开关使用） */
export function toggleTabEnabled(key: TabKey) {
  const row = navRows.value.find(r => r.key === key)
  if (row) setTabEnabled(key, !row.enabled)
}

/** 确保内存中有顺序数据：全新安装（无持久化配置）时 tabOrder 为空，
 *  不初始化会导致拖拽/上移/下移在空数组上 indexOf === -1 直接失效 */
function ensureOrder(): TabKey[] {
  if (tabOrder.value.length === 0) {
    tabOrder.value = tabItems.map(t => t.key)
  }
  return tabOrder.value
}

/** 调整 tab 顺序：dir=-1 上移，dir=1 下移（设置固定最末，不可移动；邻位交换被归一化自然抵消） */
export function moveTab(key: TabKey, dir: -1 | 1) {
  if (key === 'setting') return
  const order = [...ensureOrder()]
  const i = order.indexOf(key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= order.length) return
  const a = order[i]!
  const b = order[j]!
  order[i] = b
  order[j] = a
  tabOrder.value = withSettingLast(order)
  void saveNavConfig()
}

/** 拖拽排序：把 fromKey 移动到 toKey 位置（仅更新内存，配合 persistNavConfig 持久化）；
 *  设置不可被拖动（自身归位），落到设置上 = 移到它左侧（归一化后紧邻其前） */
export function reorderTab(fromKey: TabKey, toKey: TabKey) {
  if (fromKey === 'setting') return
  const order = [...ensureOrder()]
  const from = order.indexOf(fromKey)
  const to = order.indexOf(toKey)
  if (from < 0 || to < 0 || from === to) return
  order.splice(from, 1)
  order.splice(to, 0, fromKey)
  tabOrder.value = withSettingLast(order)
}

/** 持久化导航顺序/显隐配置（拖拽排序结束时调用） */
export function persistNavConfig(): Promise<void> {
  return saveNavConfig()
}
