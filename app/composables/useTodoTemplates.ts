import { ref } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import dbService from '~/src/db/dbService'
import type { TodoRecurrence } from '~/src/entities'

/**
 * 任务模板（待办 §9）：高频重复创建的任务配置快照，存 KV（todo_templates）跨会话保留。
 * 模块级单例（对齐 useCategories 模式）：跨组件共享同一份列表。
 */

/** 模板内容：可存档字段为新增表单的全部业务字段（不含提醒——提醒多与具体任务时间相关） */
export interface TodoTemplate {
    id: string
    name: string
    title: string
    description: string
    priorityLevel: number
    category: string
    tags: string[]
    recurrence?: TodoRecurrence
}

const STORAGE_KEY = 'todo_templates'

const templates = ref<TodoTemplate[]>([])
let loaded = false

/** 读取容错：损坏 JSON / 非法条目丢弃，返回合法模板数组 */
function parseTemplates(raw: string): TodoTemplate[] {
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const out: TodoTemplate[] = []
        for (const t of parsed) {
            if (!t || typeof t !== 'object') continue
            const o = t as Partial<TodoTemplate>
            if (typeof o.id !== 'string' || typeof o.name !== 'string' || typeof o.title !== 'string') continue
            if (!o.name.trim() || !o.title.trim()) continue
            const tags = Array.isArray(o.tags)
                ? o.tags.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim())
                : []
            out.push({
                id: o.id,
                name: o.name.trim(),
                title: o.title,
                description: typeof o.description === 'string' ? o.description : '',
                priorityLevel: Number.isFinite(Number(o.priorityLevel)) ? Math.min(255, Math.max(0, Math.round(Number(o.priorityLevel)))) : 127,
                category: typeof o.category === 'string' ? o.category : '',
                tags: [...new Set(tags)],
                recurrence: o.recurrence && typeof o.recurrence === 'object' ? o.recurrence : undefined,
            })
        }
        return out
    } catch {
        return []
    }
}

async function loadCustom() {
    try {
        const raw = await dbService.getKeyValue(STORAGE_KEY)
        if (raw) templates.value = parseTemplates(raw)
    } catch {
        /* 忽略：保持空列表 */
    }
}

async function persist() {
    try {
        await dbService.setKeyValue(STORAGE_KEY, JSON.stringify(templates.value))
    } catch {
        /* 忽略存储失败 */
    }
}

export function useTodoTemplates() {
    if (!loaded) {
        loaded = true
        void loadCustom()
    }

    /** 存为模板（重名允许——以 id 区分），返回是否成功（名称必填） */
    const saveTemplate = async (draft: Omit<TodoTemplate, 'id'>): Promise<boolean> => {
        if (!draft.name.trim() || !draft.title.trim()) return false
        templates.value = [...templates.value, { ...draft, tags: [...draft.tags], id: uuidv4() }]
        await persist()
        return true
    }

    /** 删除模板 */
    const removeTemplate = async (id: string): Promise<void> => {
        templates.value = templates.value.filter(t => t.id !== id)
        await persist()
    }

    const getTemplate = (id: string): TodoTemplate | undefined => templates.value.find(t => t.id === id)

    return { templates, saveTemplate, removeTemplate, getTemplate }
}
