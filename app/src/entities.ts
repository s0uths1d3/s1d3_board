export interface ClipboardData {
    id: number;
    content: string;
    created_at: string;
    source: string;
    is_favorite: number;
    category: string;
    /**
     * 条目类型：'text' 纯文本 / 'image' 图片（content 存 imgfile: 引用或 base64）/
     * 'html' 富文本（content 纯文本、html_content 原始 HTML）/ 'files' 文件列表（content 存 JSON 路径数组）
     */
    type: 'text' | 'image' | 'html' | 'files';
    count: number;
    updated_at: string;
    /** 来源应用：复制瞬间的前台进程名（小写、去 .exe）；存量数据/查询失败为空，UI 空值不显示 */
    source_app?: string | null;
    /** 二维码识别结果：图片条目解码出的文本（链接等）；存量未扫描为 NULL，已扫无码为 ''（防重复扫描） */
    qr_text?: string | null;
    /** 富文本正文（HTML）：仅 type='html' 条目有值 */
    html_content?: string | null;
    /** 字段级加密标记：1 = content 存 S1ENC1 加密载荷（AES-256-GCM，密钥在 OS 凭据库），仅文本条目可标记 */
    encrypted?: number;
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
    /** 条目标签（DB 存 JSON 字符串数组，应用层解析；空数组/未设置可空） */
    tags?: string | null;
    created_at: string;
    updated_at: string;
}

/** 自定义提醒规则：按百分比（剩余时长比例）/ 按时间（提前分钟数）/ 指定时刻 */
export type ReminderRule =
    | { id: string; kind: 'percent'; value: number }
    | { id: string; kind: 'offset'; value: number }
    | { id: string; kind: 'at'; value: string };

/** 循环规则：freq 频率 + interval 间隔 + 可选 weekdays/monthDay 细化 + from 下一期起算基准 */
export interface TodoRecurrence {
    /** 频率：每天 / 每周 / 每月 / 每年 */
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    /** 间隔 ≥1：每 N 天/周/月/年 */
    interval: number;
    /** freq=weekly 时生效：命中的星期（0=周日…6=周六），取晚于当前时刻的下一个 */
    weekdays?: number[];
    /** freq=monthly 时生效：每月几号（1-31，大月自动钳制到月末） */
    monthDay?: number;
    /** 下一期起算基准：due = 按截止时间顺延（固定日程）/ complete = 按完成时刻计算（滚动节奏） */
    from: 'due' | 'complete';
}

/** 链接/附件条目（v1 仅链接；图片/文件附件不做） */
export interface TodoLink { title: string; url: string }

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
    /** 循环/重复规则（DB 存 JSON 文本列 recurrence；NULL = 不循环；仅顶级任务参与） */
    recurrence?: TodoRecurrence;
    /** 子任务父任务 id（DB 列 parent_id；NULL = 顶级任务；单层嵌套：子任务下不再挂子任务） */
    parentId?: string;
    /** 标签列表（DB 存 JSON 字符串数组 tags，读取时解析；'' = 无标签） */
    tags?: string[];
    /** 兄弟作用域手动排序号（DB 列 sort_order，越大越靠后；未设置 0 时按创建时间兜底） */
    sortOrder?: number;
    /** 软删时间戳（毫秒文本，DB 列 deleted_at；NULL = 未删除，仅回收站视图展示） */
    deletedAt?: string | null;
    /** 链接/附件列表（DB 存 JSON 数组 links；'' = 无） */
    links?: TodoLink[];
}

export interface Note {
    id: string;
    content: string;
    color?: string;
    created_at?: string;
    updated_at: string;
    /** 置顶标记：1 = 置顶（置顶区优先展示，不受排序影响） */
    pinned?: number;
    /** 标签（DB 行为 JSON 字符串数组文本，仓储层解析为 string[]；'' / NULL = 无标签） */
    tags?: string[];
    /** 软删时间戳（毫秒文本）；NULL/undefined = 未删除 */
    deleted_at?: string;
    /** 提醒时刻（ISO 文本）；NULL/undefined = 无提醒 */
    remind_at?: string;
    /** 手动排序序号（拖动重排持久化；应用层 updated/created/color 排序忽略此列） */
    sort_order?: number;
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
