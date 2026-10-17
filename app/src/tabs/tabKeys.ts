/**
 * 顶层 Tab 键与顺序的唯一权威定义（叶子模块，不 import 任何项目代码，保证无环依赖）。
 *
 * 为什么独立成文件：useTabs（导航/持久化）与 statsService（统计白名单）都要消费
 * Tab 键集合，而 useTabs 依赖 statsService 做埋点——若 statsService 反向引用 useTabs
 * 会成环且模块初始化顺序不可控。两侧共同引用本叶子模块，新增 Tab 只需改这里
 * （TS 侧；daily_stat 数据库列仍需 Rust 迁移配套）。
 */

/** 顶层页面 Tab */
export type TabKey = 'clip' | 'todo' | 'calendar' | 'note' | 'pinned' | 'setting' | 'statistics' | 'app_usage'

/** nav 顺序基准（无配置时兜底 + 缺失 tab 追加序）：设置固定最末（工具位惯例） */
export const TAB_KEYS: readonly TabKey[] = [
  'clip', 'todo', 'calendar', 'note', 'pinned', 'statistics', 'app_usage', 'setting',
]

/** Tab 访问统计字段（与 daily_stat 各 tab_ 列同名），由 Tab 键单点派生 */
export type TabStatField = `tab_${TabKey}`

export const TAB_STAT_FIELDS: readonly TabStatField[] = TAB_KEYS.map(k => `tab_${k}` as TabStatField)

/** 全新安装（无持久化导航配置）的默认收起集：洞察/次要型功能 opt-in，nav 聚焦四核心
 *  （剪贴板/待办/日历/便签，clip/setting 强制保留不在此列）。
 *  仅在无 nav_tab_config 时生效——用户只要保存过任何导航配置（拖拽排序/显隐切换）即完全尊重其选择 */
export const DEFAULT_DISABLED_TABS: readonly TabKey[] = ['pinned', 'app_usage', 'statistics']
