import { useI18n } from './useI18n'
import { DEFAULT_CATEGORIES } from './useCategories'
import { DEFAULT_PRIORITY_LEVELS } from './useTodoPriorities'
import { BUILTIN_DUE_GROUPS } from './useDueDateMemory'

/**
 * 内置数据（默认分类 / 默认优先级档位 / 内置截止时间分组）的显示名翻译。
 *
 * 这些名称作为用户数据持久化在数据库中（用户可增删改），故存储层保持原样，
 * 仅在显示层映射：存储名与出厂默认一致时按当前语言显示，用户自定义过的名称原样返回。
 */

/** 默认分类 → i18n key（顺序对应 DEFAULT_CATEGORIES） */
const CATEGORY_KEYS = [
  'todo.categoryWork',
  'todo.categoryStudy',
  'todo.categoryLife',
  'todo.categoryFun',
  'todo.categoryOther',
] as const

/** 内置截止时间分组 id → i18n key */
const DUE_GROUP_KEYS: Record<string, string> = {
  recent: 'todo.dueGroupRecent',
  duration: 'todo.dueGroupDuration',
  date: 'todo.dueGroupDate',
}

export function useDisplayNames() {
  const { t } = useI18n()

  /** 分类显示名：默认分类按语言显示，自定义分类原样 */
  const categoryName = (name: string): string => {
    const i = (DEFAULT_CATEGORIES as readonly string[]).indexOf(name)
    return i >= 0 ? t(CATEGORY_KEYS[i]!) : name
  }

  /** 优先级档位显示名：与出厂默认（数值+名称）一致时按语言显示；
   *  自动生成的占位名「等级{n}」同样翻译，其余（用户自定义）原样 */
  const priorityName = (p: { level: number; name: string }): string => {
    const i = DEFAULT_PRIORITY_LEVELS.findIndex(d => d.level === p.level && d.name === p.name)
    if (i >= 0) return t(['todo.priorityLow', 'todo.priorityMid', 'todo.priorityHigh'][i]!)
    const m = /^等级(\d+)$/.exec(p.name)
    return m ? t('todo.levelName', { n: m[1]! }) : p.name
  }

  /** 截止时间分组显示名：内置分组且名称未被用户重命名时按语言显示 */
  const dueGroupName = (g: { id: string; name: string; builtin?: boolean }): string => {
    const def = BUILTIN_DUE_GROUPS.find(x => x.id === g.id)
    if (!def || !g.builtin || def.name !== g.name) return g.name
    return DUE_GROUP_KEYS[g.id] ? t(DUE_GROUP_KEYS[g.id]!) : g.name
  }

  return { categoryName, priorityName, dueGroupName }
}
