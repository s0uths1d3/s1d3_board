export interface ClipboardData {
    id: number;
    content: string;
    created_at: string;
    source: string;
    is_favorite: number;
    category: string;
    count: number;
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
