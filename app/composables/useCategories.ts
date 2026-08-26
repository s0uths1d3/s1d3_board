import { ref } from 'vue'
import dbService from '~/src/db/dbService'

/** 内置默认分类（新用户首次使用时的初始列表） */
export const DEFAULT_CATEGORIES = ['工作', '学习', '生活', '娱乐', '其他'] as const

const STORAGE_KEY = 'todo_categories'

/** 模块级单例：跨组件共享分类列表，避免各自维护一份硬编码 */
const categories = ref<string[]>([...DEFAULT_CATEGORIES])
let loaded = false
let loadPromise: Promise<void> | null = null

const isDefault = (name: string) => (DEFAULT_CATEGORIES as readonly string[]).includes(name)

/** 等待首次加载完成，避免在 loadCustom 尚未完成时调用 add/remove 导致竞态覆盖 */
function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = loadCustom()
  return loadPromise
}

/** 从数据库读取分类列表；首次使用（无持久化记录）时回退默认分类。
 *  用户删除分类后的状态（含删光的空列表）会持久化，重启时尊重该状态，
 *  不因空列表而强制恢复默认。 */
async function loadCustom() {
  try {
    const raw = await dbService.getKeyValue(STORAGE_KEY)
    if (raw !== '' && raw !== undefined && raw !== null) {
      // 存在持久化记录（可能为空数组 []，表示用户已删光全部分类）
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        categories.value = parsed.filter(
            (c): c is string => typeof c === 'string' && c.trim().length > 0,
        )
        return
      }
    }
    categories.value = [...DEFAULT_CATEGORIES]
  } catch {
    /* 忽略：保持默认分类 */
  }
}

/** 持久化完整分类列表（含用户增删后的状态） */
async function persist() {
  try {
    await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(categories.value))
  } catch {
    /* 忽略存储失败 */
  }
}

export function useCategories() {
  if (!loaded) {
    loaded = true
    loadPromise = loadCustom()
  }

  /** 新增分类（去重、忽略空白），返回是否成功 */
  const addCategory = async (name: string): Promise<boolean> => {
    await ensureLoaded()
    const trimmed = name.trim()
    if (!trimmed || categories.value.includes(trimmed)) return false
    categories.value = [...categories.value, trimmed]
    await persist()
    return true
  }

  /** 删除分类（内置分类同样可删），返回是否成功 */
  const removeCategory = async (name: string): Promise<boolean> => {
    await ensureLoaded()
    if (!categories.value.includes(name)) return false
    categories.value = categories.value.filter((c) => c !== name)
    await persist()
    return true
  }

  /** 是否为内置默认分类（仅用于 UI 区分） */
  const isCustom = (name: string) => !isDefault(name)

  return { categories, addCategory, removeCategory, isCustom }
}
