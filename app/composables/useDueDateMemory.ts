import { ref, computed } from 'vue'
import dbService from '~/src/db/dbService'

/**
 * 截止时间记忆与分组管理（模块级单例，跨组件共享）
 *
 * - 历史：最近使用的截止时间（最近 5 条），供「之前选择」分组
 * - 分组：内置（recent/duration/date）+ 用户自定义分组，可重命名、删除（内置=隐藏可恢复）、
 *   设置唯一默认展开分组
 * - 重命名：历史时间 / 默认项（10 分钟后等）均支持自定义别名
 * - 默认项隐藏：删除默认项即持久化隐藏
 *
 * 存储格式（settings 表）：
 * - last_due_date: JSON 数组（历史，兼容旧版裸字符串）
 * - due_date_groups: JSON 数组 [{ id, name, builtin, hidden }]
 * - due_date_expanded_group: 默认展开的分组 id（空串=无）
 * - due_date_group_items: JSON 对象 { 分组id: string[] }（自定义分组内容）
 * - due_date_renames: JSON 对象 { iso: 名称 }
 * - due_date_default_renames: JSON 对象 { key: 别名 }
 * - due_date_hidden_durations / due_date_hidden_dates: 被隐藏的默认项 key
 * - due_date_custom_durations / due_date_custom_dates: 固定到内置 duration/date 分组的时间
 */
const STORAGE_KEY = 'last_due_date'
const GROUPS_KEY = 'due_date_groups'
const EXPANDED_KEY = 'due_date_expanded_group'
const GROUP_ITEMS_KEY = 'due_date_group_items'
const RENAME_KEY = 'due_date_renames'
const DEFAULT_RENAME_KEY = 'due_date_default_renames'
const HIDDEN_DURATION_KEY = 'due_date_hidden_durations'
const HIDDEN_DATE_KEY = 'due_date_hidden_dates'
const CUSTOM_DURATION_KEY = 'due_date_custom_durations'
const CUSTOM_DATE_KEY = 'due_date_custom_dates'
const MAX_RECENT = 5

export interface DueGroup {
  id: string
  name: string
  builtin: boolean
  hidden: boolean
}

/** 内置分组定义（导出供显示层做 i18n 名称映射） */
export const BUILTIN_DUE_GROUPS: DueGroup[] = [
  { id: 'recent', name: '之前选择', builtin: true, hidden: false },
  { id: 'duration', name: '常用时长', builtin: true, hidden: false },
  { id: 'date', name: '常用日期', builtin: true, hidden: false },
]

/** 最近选择的历史记录（新的在前） */
const recentDueDates = ref<string[]>([])
/** 最近一次选择的截止时间（供"新增表单默认值"等复用） */
const lastDueDate = ref('')
/** 分组列表（内置+自定义，含 hidden 标记） */
const groups = ref<DueGroup[]>([])
/** 默认展开的分组 id（单选；空串=无） */
const expandedGroupId = ref('')
/** 自定义分组内容：{ 分组id: string[] } */
const groupItems = ref<Record<string, string[]>>({})
/** 重命名映射：ISO 时间 → 自定义名称 */
const renames = ref<Record<string, string>>({})
/** 默认项别名：默认项 key → 自定义名称 */
const defaultRenames = ref<Record<string, string>>({})
/** 被隐藏的常用时长默认项 key */
const hiddenDurations = ref<string[]>([])
/** 被隐藏的常用日期默认项 key */
const hiddenDates = ref<string[]>([])
/** 固定到「常用时长」分组的历史时间（ISO） */
const customDurations = ref<string[]>([])
/** 固定到「常用日期」分组的历史时间（ISO） */
const customDates = ref<string[]>([])
let loaded = false
let loadPromise: Promise<void> | null = null

/** 从 settings 读取并解析 JSON 数组；失败返回 [] */
async function readJsonArray(key: string): Promise<string[]> {
  try {
    const raw = await dbService.getKeyValue(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string' && v) : []
  } catch {
    return []
  }
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      // 历史记录（含旧版裸字符串兼容）
      try {
        const raw = await dbService.getKeyValue(STORAGE_KEY)
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              recentDueDates.value = parsed.filter(v => typeof v === 'string' && v)
            } else {
              recentDueDates.value = [String(parsed)]
            }
          } catch {
            recentDueDates.value = [raw]
          }
        }
      } catch { /* 忽略读取失败 */ }

      // 分组列表
      try {
        const raw = await dbService.getKeyValue(GROUPS_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) {
            groups.value = parsed.filter((g: DueGroup) => g && typeof g.id === 'string')
          }
        }
      } catch { /* 忽略读取失败 */ }
      // 确保内置分组始终存在（合并，保留持久化的 name/hidden）
      for (const b of BUILTIN_DUE_GROUPS) {
        if (!groups.value.find(g => g.id === b.id)) groups.value.push({ ...b })
      }

      // 默认展开分组
      try {
        expandedGroupId.value = await dbService.getKeyValue(EXPANDED_KEY)
      } catch { /* 忽略读取失败 */ }
      if (!expandedGroupId.value) expandedGroupId.value = 'duration'

      // 自定义分组内容
      try {
        const raw = await dbService.getKeyValue(GROUP_ITEMS_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            groupItems.value = parsed
          }
        }
      } catch { /* 忽略读取失败 */ }

      // 重命名映射（历史 ISO）
      try {
        const raw = await dbService.getKeyValue(RENAME_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) renames.value = parsed
        }
      } catch { /* 忽略读取失败 */ }

      // 默认项别名
      try {
        const raw = await dbService.getKeyValue(DEFAULT_RENAME_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) defaultRenames.value = parsed
        }
      } catch { /* 忽略读取失败 */ }

      hiddenDurations.value = await readJsonArray(HIDDEN_DURATION_KEY)
      hiddenDates.value = await readJsonArray(HIDDEN_DATE_KEY)
      customDurations.value = await readJsonArray(CUSTOM_DURATION_KEY)
      customDates.value = await readJsonArray(CUSTOM_DATE_KEY)

      lastDueDate.value = recentDueDates.value[0] ?? ''
      loaded = true
    })()
  }
  return loadPromise
}

/** 读取 ISO 时间对应的自定义名称（无则返回空串） */
function nameOf(iso: string): string {
  return renames.value[iso] ?? ''
}

/** 读取默认项（按 key）对应的别名（无则返回空串） */
function defaultNameOf(key: string): string {
  return defaultRenames.value[key] ?? ''
}

/** 默认项是否被隐藏（删除） */
function isDefaultHidden(key: string, group: 'duration' | 'date'): boolean {
  return (group === 'duration' ? hiddenDurations.value : hiddenDates.value).includes(key)
}

/** 可见分组（非隐藏） */
const visibleGroups = computed(() => groups.value.filter(g => !g.hidden))

/** 查找分组 */
function groupOf(id: string): DueGroup | undefined {
  return groups.value.find(g => g.id === id)
}

/** 是否默认展开分组 */
function isExpanded(id: string): boolean {
  return expandedGroupId.value === id
}

export function useDueDateMemory() {
  if (!loaded) void ensureLoaded()

  /** 记录某次选择的截止时间（空值不记录；去重置顶，最多保留 MAX_RECENT 条） */
  const remember = async (value: string) => {
    if (!value) return
    const v = String(value)
    recentDueDates.value = [v, ...recentDueDates.value.filter(x => x !== v)].slice(0, MAX_RECENT)
    lastDueDate.value = recentDueDates.value[0] ?? ''
    try {
      await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(recentDueDates.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 从历史记录中删除某条（同时清理关联的重命名/自定义分组项）并持久化 */
  const removeHistory = async (value: string) => {
    recentDueDates.value = recentDueDates.value.filter(x => x !== value)
    lastDueDate.value = recentDueDates.value[0] ?? ''
    const renamesCpy = { ...renames.value }
    delete renamesCpy[value]
    renames.value = renamesCpy
    customDurations.value = customDurations.value.filter(x => x !== value)
    customDates.value = customDates.value.filter(x => x !== value)
    // 从所有自定义分组移除
    const itemsCpy: Record<string, string[]> = {}
    for (const [k, list] of Object.entries(groupItems.value)) {
      itemsCpy[k] = list.filter(x => x !== value)
    }
    groupItems.value = itemsCpy
    try {
      await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(recentDueDates.value))
      await dbService.setKeyValue(RENAME_KEY, JSON.stringify(renames.value))
      await dbService.setKeyValue(CUSTOM_DURATION_KEY, JSON.stringify(customDurations.value))
      await dbService.setKeyValue(CUSTOM_DATE_KEY, JSON.stringify(customDates.value))
      await dbService.setKeyValue(GROUP_ITEMS_KEY, JSON.stringify(groupItems.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 设置 / 清除某条历史的自定义名称（名称为空则清除）并持久化 */
  const rename = async (value: string, name: string) => {
    const v = String(value)
    const trimmed = name.trim()
    const cpy = { ...renames.value }
    if (trimmed) cpy[v] = trimmed
    else delete cpy[v]
    renames.value = cpy
    try {
      await dbService.setKeyValue(RENAME_KEY, JSON.stringify(renames.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 设置 / 清除默认项别名（key 如 '10m'/'tomorrow'；名称为空则清除）并持久化 */
  const renameDefault = async (key: string, name: string) => {
    const k = String(key)
    const trimmed = name.trim()
    const cpy = { ...defaultRenames.value }
    if (trimmed) cpy[k] = trimmed
    else delete cpy[k]
    defaultRenames.value = cpy
    try {
      await dbService.setKeyValue(DEFAULT_RENAME_KEY, JSON.stringify(defaultRenames.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 删除默认项：持久化隐藏，不再显示 */
  const hideDefault = async (key: string, group: 'duration' | 'date') => {
    const k = String(key)
    const storeKey = group === 'duration' ? HIDDEN_DURATION_KEY : HIDDEN_DATE_KEY
    const list = group === 'duration' ? hiddenDurations : hiddenDates
    if (!list.value.includes(k)) {
      list.value = [...list.value, k]
      try {
        await dbService.setKeyValue(storeKey, JSON.stringify(list.value))
      } catch { /* 忽略写入失败 */ }
    }
  }

  /** 将某历史时间固定到指定分组（'duration' | 'date' | 自定义分组 id）并持久化 */
  const addToGroup = async (value: string, groupId: string) => {
    const v = String(value)
    if (groupId === 'duration') {
      if (!customDurations.value.includes(v)) {
        customDurations.value = [...customDurations.value, v]
        try { await dbService.setKeyValue(CUSTOM_DURATION_KEY, JSON.stringify(customDurations.value)) } catch { /* 忽略 */ }
      }
    } else if (groupId === 'date') {
      if (!customDates.value.includes(v)) {
        customDates.value = [...customDates.value, v]
        try { await dbService.setKeyValue(CUSTOM_DATE_KEY, JSON.stringify(customDates.value)) } catch { /* 忽略 */ }
      }
    } else {
      const list = groupItems.value[groupId] ?? []
      if (!list.includes(v)) {
        groupItems.value = { ...groupItems.value, [groupId]: [...list, v] }
        try { await dbService.setKeyValue(GROUP_ITEMS_KEY, JSON.stringify(groupItems.value)) } catch { /* 忽略 */ }
      }
    }
  }

  /** 从自定义分组中移除某时间并持久化 */
  const removeFromGroup = async (value: string, groupId: string) => {
    const v = String(value)
    if (groupId === 'duration') {
      customDurations.value = customDurations.value.filter(x => x !== v)
      try { await dbService.setKeyValue(CUSTOM_DURATION_KEY, JSON.stringify(customDurations.value)) } catch { /* 忽略 */ }
    } else if (groupId === 'date') {
      customDates.value = customDates.value.filter(x => x !== v)
      try { await dbService.setKeyValue(CUSTOM_DATE_KEY, JSON.stringify(customDates.value)) } catch { /* 忽略 */ }
    } else {
      const list = groupItems.value[groupId] ?? []
      groupItems.value = { ...groupItems.value, [groupId]: list.filter(x => x !== v) }
      try { await dbService.setKeyValue(GROUP_ITEMS_KEY, JSON.stringify(groupItems.value)) } catch { /* 忽略 */ }
    }
  }

  // ===== 分组管理 =====
  /** 新建自定义分组，返回分组 id */
  const createGroup = async (name: string): Promise<string> => {
    const trimmed = name.trim()
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    groups.value = [...groups.value, { id, name: trimmed || '新分组', builtin: false, hidden: false }]
    try {
      await dbService.setKeyValue(GROUPS_KEY, JSON.stringify(groups.value))
    } catch { /* 忽略写入失败 */ }
    return id
  }

  /** 重命名分组并持久化 */
  const renameGroup = async (id: string, name: string) => {
    const trimmed = name.trim()
    groups.value = groups.value.map(g => (g.id === id ? { ...g, name: trimmed || g.name } : g))
    try {
      await dbService.setKeyValue(GROUPS_KEY, JSON.stringify(groups.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 删除分组：内置=隐藏（可恢复）；自定义=移除并清理内容 */
  const deleteGroup = async (id: string) => {
    const g = groupOf(id)
    if (!g) return
    if (g.builtin) {
      groups.value = groups.value.map(x => (x.id === id ? { ...x, hidden: true } : x))
    } else {
      groups.value = groups.value.filter(x => x.id !== id)
      const itemsCpy = { ...groupItems.value }
      delete itemsCpy[id]
      groupItems.value = itemsCpy
    }
    // 若被删分组是默认展开分组，清除展开设置
    if (expandedGroupId.value === id) {
      expandedGroupId.value = ''
      try { await dbService.setKeyValue(EXPANDED_KEY, '') } catch { /* 忽略 */ }
    }
    try {
      await dbService.setKeyValue(GROUPS_KEY, JSON.stringify(groups.value))
      await dbService.setKeyValue(GROUP_ITEMS_KEY, JSON.stringify(groupItems.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 恢复被隐藏的内置分组 */
  const restoreGroup = async (id: string) => {
    groups.value = groups.value.map(g => (g.id === id ? { ...g, hidden: false } : g))
    try {
      await dbService.setKeyValue(GROUPS_KEY, JSON.stringify(groups.value))
    } catch { /* 忽略写入失败 */ }
  }

  /** 设置默认展开分组（单选；传空串=取消展开）并持久化 */
  const setExpandedGroup = async (id: string) => {
    expandedGroupId.value = id
    try {
      await dbService.setKeyValue(EXPANDED_KEY, id)
    } catch { /* 忽略写入失败 */ }
  }

  return { lastDueDate, recentDueDates, renames, defaultRenames, hiddenDurations, hiddenDates, customDurations, customDates, groups, visibleGroups, expandedGroupId, groupItems, nameOf, defaultNameOf, isDefaultHidden, groupOf, isExpanded, remember, removeHistory, rename, renameDefault, hideDefault, addToGroup, removeFromGroup, createGroup, renameGroup, deleteGroup, restoreGroup, setExpandedGroup, ensureLoaded }
}
