import { ref } from 'vue'

/** 顶层页面 Tab */
export type TabKey = 'clip' | 'todo' | 'note' | 'setting'

/**
 * 顶层页面切换共享状态
 *
 * TitleBar（窗口之上导航）与 pages/index.vue（页面内容区）共用，
 * 点击标题栏上的「剪贴板 / 待办 / 便签 / 设置」即切换内容区。
 */
export const activeTab = ref<TabKey>('clip')

export function setActiveTab(key: TabKey) {
  activeTab.value = key
}

/** 标题栏导航项配置 */
export const tabItems: { key: TabKey; name: string }[] = [
  { key: 'clip', name: '剪贴板' },
  { key: 'todo', name: '待办' },
  { key: 'note', name: '便签' },
  { key: 'setting', name: '设置' },
]
