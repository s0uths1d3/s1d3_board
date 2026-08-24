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

export interface Todo {
    id: string;
    title: string;
    description?: string;
    completed: 0 | 1;
    priority: 'low' | 'medium' | 'high';
    category?: string;
    created_at?: string;
    updated_at: string;
    dueDate?: string;
}

export interface Note {
    id: string;
    content: string;
    color?: string;
    created_at?: string;
    updated_at: string;
}
