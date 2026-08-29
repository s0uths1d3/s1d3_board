import { ref } from 'vue'
import dbService from '~/src/db/dbService'

/**
 * 便签配色（自定义名称 + 颜色）
 *
 * 用户可自由增删改配色项（名称 + 十六进制颜色），持久化到 settings 表。
 * 便签卡片背景由颜色值动态生成（低透明底 + 同色描边）。
 * 旧版颜色以名称存储（'yellow' 等），读取时经 LEGACY_NAME_MAP 透明解析为 hex。
 */

export interface NoteColor {
  name: string
  /** #rrggbb */
  color: string
}

/** 默认配色（与历史内置六色一致，首次使用时初始化） */
export const DEFAULT_NOTE_COLORS: NoteColor[] = [
  { name: '黄', color: '#dcc88a' },
  { name: '粉', color: '#d6a8b0' },
  { name: '蓝', color: '#9fbfd6' },
  { name: '绿', color: '#b3d0a0' },
  { name: '紫', color: '#bfb0d6' },
  { name: '橙', color: '#d9b58a' },
]

/** 取色器预设色板：默认六色 + 全局暖色扩展（去重） */
export const NOTE_COLOR_PRESETS: string[] = Array.from(new Set([
  ...DEFAULT_NOTE_COLORS.map(c => c.color),
  '#b05c5c', '#d98b3f', '#d9b13f', '#6f8a55', '#4f8a7b',
  '#4f6f9a', '#7b5f9a', '#b05f8a', '#8a6f5c', '#8a8a8a',
]))

/** 旧版颜色名 → hex（老便签 note.color 存的是名称，读取时透明解析） */
export const LEGACY_NAME_MAP: Record<string, string> = {
  yellow: '#dcc88a',
  pink: '#d6a8b0',
  blue: '#9fbfd6',
  green: '#b3d0a0',
  purple: '#bfb0d6',
  orange: '#d9b58a',
}

const STORAGE_KEY = 'note_colors'

const colors = ref<NoteColor[]>(DEFAULT_NOTE_COLORS.map(c => ({ ...c })))
let loaded = false
let loadPromise: Promise<void> | null = null

/** 解析便签存储的颜色值为 hex：兼容旧名称与非法值 */
export function resolveNoteColor(color?: string): string {
  const s = (color || '').trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  return LEGACY_NAME_MAP[s] ?? DEFAULT_NOTE_COLORS[0]!.color
}

function normalize(hex?: string): string {
  const s = (hex || '').trim()
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : '#dcc88a'
}

async function load(): Promise<void> {
  try {
    const raw = await dbService.getKeyValue(STORAGE_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        colors.value = (parsed as Partial<NoteColor>[])
          .map(c => ({ name: (c?.name || '配色').slice(0, 8), color: normalize(c?.color) }))
        return
      }
    }
    colors.value = DEFAULT_NOTE_COLORS.map(c => ({ ...c }))
  } catch {
    /* 忽略：保持默认配色 */
  }
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = load()
  return loadPromise
}

async function persist(): Promise<void> {
  try {
    await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(colors.value))
  } catch { /* 忽略存储失败 */ }
}

export function useNoteColors() {
  if (!loaded) {
    loaded = true
    loadPromise = load()
  }

  /** 新增配色：重名返回 false */
  const addColor = async (name: string, color: string): Promise<boolean> => {
    await ensureLoaded()
    const n = (name || '配色').slice(0, 8)
    if (colors.value.some(c => c.name === n)) return false
    colors.value = [...colors.value, { name: n, color: normalize(color) }]
    await persist()
    return true
  }

  /** 修改配色（按名称定位；重命名到已存在名称返回 false） */
  const updateColor = async (oldName: string, patch: Partial<Omit<NoteColor, 'name'>> & { name?: string }): Promise<boolean> => {
    await ensureLoaded()
    const target = colors.value.find(c => c.name === oldName)
    if (!target) return false
    const nextName = (patch.name ?? target.name).slice(0, 8)
    if (nextName !== target.name && colors.value.some(c => c.name === nextName)) return false
    colors.value = colors.value.map(c =>
      c.name === target.name ? { name: nextName, color: normalize(patch.color ?? c.color) } : c,
    )
    await persist()
    return true
  }

  /** 删除配色（至少保留一个） */
  const removeColor = async (name: string): Promise<boolean> => {
    await ensureLoaded()
    if (colors.value.length <= 1) return false
    const before = colors.value.length
    colors.value = colors.value.filter(c => c.name !== name)
    if (colors.value.length === before) return false
    await persist()
    return true
  }

  /** 整表替换（管理器"完成"提交；自动补默认名/规范化颜色） */
  const replaceColors = async (list: NoteColor[]): Promise<void> => {
    await ensureLoaded()
    const seen = new Set<string>()
    const next: NoteColor[] = []
    for (const item of list) {
      const name = (item?.name || '配色').slice(0, 8)
      if (seen.has(name)) continue
      seen.add(name)
      next.push({ name, color: normalize(item?.color) })
    }
    colors.value = next.length > 0 ? next : DEFAULT_NOTE_COLORS.map(c => ({ ...c }))
    await persist()
  }

  return { colors, addColor, updateColor, removeColor, replaceColors }
}
