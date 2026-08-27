import { ref } from 'vue'
import dbService from '~/src/db/dbService'

/**
 * 记忆用户上次选择的截止时间（ISO 字符串，如 2026-08-27T17:30），
 * 持久化到 settings 表，供"一键套用上次选择"和作为新增表单默认值使用。
 */
const STORAGE_KEY = 'last_due_date'
const lastDueDate = ref('')
let loaded = false
let loadPromise: Promise<void> | null = null

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await dbService.getKeyValue(STORAGE_KEY)
        if (raw) lastDueDate.value = raw
      } catch {
        /* 忽略读取失败 */
      }
      loaded = true
    })()
  }
  return loadPromise
}

export function useDueDateMemory() {
  if (!loaded) void ensureLoaded()

  /** 记录某次选择的截止时间（空值不记录） */
  const remember = async (value: string) => {
    if (!value) return
    lastDueDate.value = value
    try {
      await dbService.setKeyValue(STORAGE_KEY, value)
    } catch {
      /* 忽略写入失败 */
    }
  }

  return { lastDueDate, remember, ensureLoaded }
}
