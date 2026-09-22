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
    /** 来源应用：复制瞬间的前台进程名（小写、去 .exe）；存量数据/查询失败为空，UI 空值不显示 */
    source_app?: string | null;
    /** 二维码识别结果：图片条目解码出的文本（链接等）；存量未扫描为 NULL，已扫无码为 ''（防重复扫描） */
    qr_text?: string | null;
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

/** 智能剪贴板：clip 分词/复制规则（separator 分隔符拆分 / regex 正则提取） */
/**
 * 拆分规则的**内部原语**（不再是可管理的用户实体）：
 * 用户侧只维护「提取器」（单个提取单元）与「方案」（多提取器集成），
 * 规则引擎据此按分隔符/正则拆分文本，见 smart-clip/ruleEngine.ts。
 */
export interface SplitRule {
    type: 'separator' | 'regex';
    pattern: string;
}

/**
 * 智能剪贴板：**方案**——多个提取器的集成体。
 *
 * - title / description：方案自身的标题与描述；
 * - members：成员提取器 id 有序列表，**空数组 = 自动接入全部提取器**（声明式默认，
 *   新增提取器即参与），非空 = 指定子集（可由 AI 生成专属方案时挑选）；
 * - body：可选输出排版（{content} {segN} {date} {time}），留空则直接输出合并片段；
 * - 存储表仍沿用 clip_templates。
 */
export interface ClipScheme {
    id: string;
    title: string;
    description: string;
    members: string[];
    body: string;
    enabled: 0 | 1;
    created_at?: string;
    updated_at?: string;
}

/**
 * 智能剪贴板：**提取器**——单个内容的提取单元（原「预设」）。
 *
 * - method：提取方式 regex 正则 / separator 分隔符 / ai AI 指令；
 * - expression：对应方式的表达式（正则、分隔符，或 AI 指令文本）；
 * - sample：示例文本（仅说明用，不参与解析）。
 */
export interface ClipExtractor {
    id: string;
    name: string;
    desc: string;
    method: 'regex' | 'separator' | 'ai';
    expression: string;
    sample: string;
    /** 是否内置：仅用于角标与「恢复内置」补齐，不限制编辑/删除 */
    builtin: 0 | 1;
}
