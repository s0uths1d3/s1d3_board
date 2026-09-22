import { invoke } from "@tauri-apps/api/core";

/**
 * 图片文件引用（imgfile:）读写边界（core/db）：
 * 原图字节不进 SQLite，DB 只存 imgfile:<文件名> 引用（Rust 侧内容寻址落盘）；
 * 读取边界统一换回 data URL，删除边界联动删文件。自 dbService 原样平移。
 */

/**
 * 图片条目 content 的文件引用前缀：原图字节不再存 SQLite（base64 是库体积膨胀主因），
 * 落盘到 %APPDATA%/S1d3Board/images/<sha256前16hex>.png（Rust 侧内容寻址，同图天然去重），
 * DB 只存 imgfile:<文件名> 引用；读取边界统一换回 data URL，下游消费无感知。
 */
export const IMAGE_FILE_PREFIX = 'imgfile:';

/**
 * imgfile: 文件引用 → 原图 data URL（读回 %APPDATA%/images 下的 PNG）。
 * 非引用（文本/旧 base64 条目）原样返回；文件缺失/读取失败也原样返回
 * （下游渲染裂图可感知，不静默吞掉引用串冒充图片）。
 */
export async function resolveImageContent(content: string): Promise<string> {
    if (!content.startsWith(IMAGE_FILE_PREFIX)) return content;
    try {
        const dataUrl = await invoke<string | null>('read_clipboard_image_file', { file: content.slice(IMAGE_FILE_PREFIX.length) });
        return dataUrl ?? content;
    } catch {
        return content;
    }
}

/** 行集合的图片引用统一解析（就地替换 content）：读取边界换回原图 data URL，
 * 列表/tooltip/查看器/粘贴等下游消费与旧 base64 时代完全一致 */
export async function resolveImageRows<T extends { type?: string; content: string }>(rows: T[]): Promise<T[]> {
    await Promise.all(rows.map(async (row) => {
        if (row.type === 'image') row.content = await resolveImageContent(row.content);
    }));
    return rows;
}

/** 删除图片条目对应的原图文件（fire-and-forget）：引用形如 imgfile:<名> 时调 Rust 删除，
 *  旧 base64 条目/文本条目原样跳过；失败静默（残留孤儿文件无害，不影响 DB 一致性） */
export function deleteImageFileByRef(content: string | null | undefined): void {
    if (!content || !content.startsWith(IMAGE_FILE_PREFIX)) return;
    void invoke('delete_clipboard_image_file', { file: content.slice(IMAGE_FILE_PREFIX.length) }).catch(() => {});
}
