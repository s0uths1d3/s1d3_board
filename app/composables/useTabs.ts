import { ref } from 'vue'
import statsService, { type StatField } from '~/src/statistics/statsService'

/** 顶层页面 Tab */
export type TabKey = 'clip' | 'todo' | 'note' | 'pinned' | 'setting' | 'statistics'

/**
 * 顶层页面切换共享状态
 *
 * TitleBar（窗口之上导航）与 pages/index.vue（页面内容区）共用，
 * 点击标题栏上的「剪贴板 / 待办 / 便签 / 设置 / 统计」即切换内容区。
 */
export const activeTab = ref<TabKey>('clip')

export function setActiveTab(key: TabKey) {
  const prev = activeTab.value
  activeTab.value = key
  // 统计埋点（fire-and-forget，§5.6）：仅在真正切换时 +1
  if (prev !== key) {
    void statsService.record({ [`tab_${key}`]: 1 } as Partial<Record<StatField, number>>)
  }
}

/** 标题栏导航项配置（「统计」带显示门槛，见 statsUnlocked） */
export interface TabItem {
  key: TabKey
  name: string
  /** 显示门槛类型：满足 statsUnlocked 才显示 */
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

/** 当前可见的 tab 列表（过滤未满足门槛的项），供标题栏与 SwitchTabCommand 使用 */
export function getVisibleTabItems(): TabItem[] {
  return tabItems.filter(t => !t.gate || statsUnlocked.value)
}
