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
  'todo.category_work',
  'todo.category_study',
  'todo.category_life',
  'todo.category_fun',
  'todo.category_other',
] as const

/** 默认分类的英文别名（历史版本在英文界面下落库的出厂名），同样按当前语言显示 */
const CATEGORY_EN_ALIASES: Record<string, (typeof CATEGORY_KEYS)[number]> = {
  Work: 'todo.category_work',
  Study: 'todo.category_study',
  Life: 'todo.category_life',
  Fun: 'todo.category_fun',
  Other: 'todo.category_other',
}

/** 默认优先级档位 → i18n key（顺序对应 DEFAULT_PRIORITY_LEVELS） */
const PRIORITY_KEYS = ['todo.priority_low', 'todo.priority_mid', 'todo.priority_high'] as const

/** 默认优先级档位的英文别名（历史版本在英文界面下落库的出厂名），需 level 与名称同时匹配 */
const PRIORITY_EN_ALIASES = ['Low', 'Medium', 'High'] as const

/** 内置截止时间分组 id → i18n key */
const DUE_GROUP_KEYS: Record<string, string> = {
  recent: 'todo.due_group_recent',
  duration: 'todo.due_group_duration',
  date: 'todo.due_group_date',
}

export function useDisplayNames() {
  const { t } = useI18n()

  /** 分类显示名：默认分类（含历史英文种子名）按语言显示，自定义分类原样 */
  const categoryName = (name: string): string => {
    const i = (DEFAULT_CATEGORIES as readonly string[]).indexOf(name)
    if (i >= 0) return t(CATEGORY_KEYS[i]!)
    const alias = CATEGORY_EN_ALIASES[name]
    return alias ? t(alias) : name
  }

  /** 优先级档位显示名：与出厂默认（数值+名称）一致时按语言显示；
   *  历史英文种子名（level 与名称成对匹配）同样翻译；
   *  自动生成的占位名「等级{n}」同样翻译，其余（用户自定义）原样 */
  const priorityName = (p: { level: number; name: string }): string => {
    const i = DEFAULT_PRIORITY_LEVELS.findIndex(d => d.level === p.level && d.name === p.name)
    if (i >= 0) return t(PRIORITY_KEYS[i]!)
    const j = (PRIORITY_EN_ALIASES as readonly string[]).indexOf(p.name)
    if (j >= 0 && DEFAULT_PRIORITY_LEVELS[j]!.level === p.level) return t(PRIORITY_KEYS[j]!)
    const m = /^等级(\d+)$/.exec(p.name)
    return m ? t('todo.level_name', { n: m[1]! }) : p.name
  }

  /** 截止时间分组显示名：内置分组且名称未被用户重命名时按语言显示 */
  const dueGroupName = (g: { id: string; name: string; builtin?: boolean }): string => {
    const def = BUILTIN_DUE_GROUPS.find(x => x.id === g.id)
    if (!def || !g.builtin || def.name !== g.name) return g.name
    return DUE_GROUP_KEYS[g.id] ? t(DUE_GROUP_KEYS[g.id]!) : g.name
  }

  return { categoryName, priorityName, dueGroupName }
}
