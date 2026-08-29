export interface ClipboardData {
    id: number;
    content: string;
    created_at: string;
    source: string;
    is_favorite: number;
    category: string;
    /** 条目类型：'text' 文本 / 'image' 图片（content 存 base64） */
    type: 'text' | 'image';
    count: number;
    updated_at: string;
}

export interface PinnedClip {
    id: number;
    content: string;
    /** 类型：'text' 文本 / 'image' 图片（content 存 base64） */
    type: 'text' | 'image';
    /** 可选显示名称 */
    name?: string;
    /** 排序号（历史字段，新排序基于时间/置顶） */
    sort_order: number;
    /** 来源应用（从剪贴板添加时带入，可为空） */
    source?: string;
    /** 置顶时间戳（置顶后非空，排序置顶优先） */
    pinned_at?: string;
    created_at: string;
    updated_at: string;
}

/** 自定义提醒规则：按百分比（剩余时长比例）/ 按时间（提前分钟数）/ 指定时刻 */
export type ReminderRule =
    | { id: string; kind: 'percent'; value: number }
    | { id: string; kind: 'offset'; value: number }
    | { id: string; kind: 'at'; value: string };

export interface Todo {
    id: string;
    title: string;
    description?: string;
    completed: 0 | 1;
    /** 优先级数值 0-255，越大越优先（等级定义与颜色见 useTodoPriorities） */
    priorityLevel?: number;
    /** 旧版三档文本优先级（legacy 列，仅兼容保留；读写以 priorityLevel 为准） */
    priority?: 'low' | 'medium' | 'high';
    category?: string;
    created_at?: string;
    updated_at: string;
    dueDate?: string;
    /** 提醒模式：smart = 智能策略（默认/缺省）、off = 不提醒、custom = 按 remindRules 自定义 */
    remindMode?: 'smart' | 'off' | 'custom';
    /** 自定义提醒规则列表（remindMode === 'custom' 时生效；DB 中为 JSON 文本列） */
    remindRules?: ReminderRule[];
    /** DB 原始 JSON 文本列（remind_rules）：dbService 读取时解析折算为 remindRules，无需强转桥接 */
    remind_rules?: string;
    /** 旧版单一自定义提醒时刻（legacy 列；读取时自动折算为一条 at 规则） */
    remindAt?: string;
}

export interface Note {
    id: string;
    content: string;
    color?: string;
    created_at?: string;
    updated_at: string;
}
