import { ref, computed } from 'vue'
import dbService from '~/src/db/dbService'

/**
 * 待办优先级等级（自定义数值等级系统）
 *
 * 等级 = 数值(0-255，越大越优先) + 名称 + 颜色。
 * 默认三档：0 低（绿）/ 127 中（金）/ 255 高（红）。
 * 列表持久化到 settings 表；增改删见 addLevel/updateLevel/removeLevel/replaceLevels。
 */

export interface TodoPriorityLevel {
  /** 0-255 整数，越大越优先 */
  level: number
  name: string
  /** 十六进制颜色 #rrggbb（徽章/圆点着色） */
  color: string
}

export const DEFAULT_PRIORITY_LEVELS: TodoPriorityLevel[] = [
  { level: 0, name: '低', color: '#6f8a55' },
  { level: 127, name: '中', color: '#c4a77d' },
  { level: 255, name: '高', color: '#b05c5c' },
]

const STORAGE_KEY = 'todo_priority_levels'

/** 编辑器可选色板（10 色覆盖红橙黄绿青蓝紫粉棕灰） */
export const PRIORITY_COLOR_PALETTE = [
  '#b05c5c', '#d98b3f', '#d9b13f', '#6f8a55', '#4f8a7b',
  '#4f6f9a', '#7b5f9a', '#b05f8a', '#8a6f5c', '#8a8a8a',
]

const levels = ref<TodoPriorityLevel[]>(DEFAULT_PRIORITY_LEVELS.map(p => ({ ...p })))
let loaded = false
let loadPromise: Promise<void> | null = null

/** 收敛数值：整数 0-255，非法回退 127 */
export function clampLevel(level?: number): number {
  const n = Math.round(Number(level))
  if (!Number.isFinite(n)) return 127
  return Math.min(255, Math.max(0, n))
}

/** 规范化颜色为 #rrggbb；非法回退中性灰 */
function normalizeColor(color?: string): string {
  const s = (color || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '#8a8a8a'
}

/** 等级列表（按数值升序，响应式） */
const sortedLevels = computed<TodoPriorityLevel[]>(() =>
  [...levels.value].sort((a, b) => a.level - b.level),
)

async function load(): Promise<void> {
  try {
    const raw = await dbService.getKeyValue(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        const seen = new Set<number>()
        const list: TodoPriorityLevel[] = []
        for (const item of parsed as Partial<TodoPriorityLevel>[]) {
          const level = clampLevel(item?.level)
          if (seen.has(level)) continue
          seen.add(level)
          list.push({
            level,
            name: (item?.name || `等级${level}`).slice(0, 12),
            color: normalizeColor(item?.color),
          })
        }
        if (list.length > 0) {
          levels.value = list
          return
        }
      }
    }
    levels.value = DEFAULT_PRIORITY_LEVELS.map(p => ({ ...p }))
  } catch {
    /* 忽略：保持默认三档 */
  }
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = load()
  return loadPromise
}

async function persist(): Promise<void> {
  try {
    await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(levels.value))
  } catch { /* 忽略存储失败 */ }
}

export function useTodoPriorities() {
  if (!loaded) {
    loaded = true
    loadPromise = load()
  }

  /** 查等级定义；已被删除的等级回退中性样式（显示原始数值），由 TodoList 负责重映射 */
  const getLevelInfo = (level?: number): TodoPriorityLevel => {
    const l = clampLevel(level)
    return sortedLevels.value.find(p => p.level === l)
      ?? { level: l, name: String(l), color: '#8a8a8a' }
  }

  /** 新增等级：数值冲突返回 false */
  const addLevel = async (level: number, name: string, color: string): Promise<boolean> => {
    await ensureLoaded()
    const l = clampLevel(level)
    if (levels.value.some(p => p.level === l)) return false
    levels.value = [...levels.value, { level: l, name: (name || `等级${l}`).slice(0, 12), color: normalizeColor(color) }]
    await persist()
    return true
  }

  /** 修改等级（可改数值/名称/颜色；数值改到已存在档位返回 false） */
  const updateLevel = async (oldLevel: number, patch: Partial<Omit<TodoPriorityLevel, 'level'>> & { level?: number }): Promise<boolean> => {
    await ensureLoaded()
    const target = levels.value.find(p => p.level === clampLevel(oldLevel))
    if (!target) return false
    const nextLevel = patch.level !== undefined ? clampLevel(patch.level) : target.level
    if (nextLevel !== target.level && levels.value.some(p => p.level === nextLevel)) return false
    levels.value = levels.value.map(p =>
      p.level === target.level
        ? { level: nextLevel, name: (patch.name ?? p.name).slice(0, 12), color: normalizeColor(patch.color ?? p.color) }
        : p,
    )
    await persist()
    return true
  }

  /** 删除等级；引用它的待办由 TodoList 重映射到最近档位 */
  const removeLevel = async (level: number): Promise<boolean> => {
    await ensureLoaded()
    const before = levels.value.length
    levels.value = levels.value.filter(p => p.level !== clampLevel(level))
    if (levels.value.length === before) return false
    if (levels.value.length === 0) levels.value = DEFAULT_PRIORITY_LEVELS.map(p => ({ ...p }))
    await persist()
    return true
  }

  /** 整表替换（管理器"完成"时提交；自动去重、收敛、补默认名） */
  const replaceLevels = async (list: TodoPriorityLevel[]): Promise<void> => {
    await ensureLoaded()
    const seen = new Set<number>()
    const next: TodoPriorityLevel[] = []
    for (const item of list) {
      const level = clampLevel(item?.level)
      if (seen.has(level)) continue
      seen.add(level)
      next.push({ level, name: (item?.name || `等级${level}`).slice(0, 12), color: normalizeColor(item?.color) })
    }
    levels.value = next.length > 0 ? next : DEFAULT_PRIORITY_LEVELS.map(p => ({ ...p }))
    await persist()
  }

  /** 找最接近的既有档位（删除等级后的重映射目标） */
  const nearestLevel = (level: number): number => {
    const l = clampLevel(level)
    let best = levels.value[0]
    for (const p of levels.value) {
      if (Math.abs(p.level - l) < Math.abs((best?.level ?? l) - l)) best = p
    }
    return best?.level ?? 127
  }

  return { levels: sortedLevels, getLevelInfo, addLevel, updateLevel, removeLevel, replaceLevels, nearestLevel }
}
