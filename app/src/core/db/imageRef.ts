import { invoke } from "@tauri-apps/api/core";

/**
 * 图片文件引用（imgfile:）读写边界（core/db）：
 * 原图字节不进 SQLite，DB 只存 imgfile:<文件名> 引用（Rust 侧内容寻址落盘）；
 * 读取边界统一换回 data URL，删除边界联动删文件。自 dbService 原样平移。
 */

/**
 * imgfile: 文件引用前缀：原图字节不再存 SQLite（base64 是库体积膨胀主因），
 * 落盘到 %APPDATA%/S1d3Board/images/<sha256前16hex>.png（Rust 侧内容寻址，同图天然去重），
 * DB 只存 imgfile:<文件名> 引用；读取边界统一换回 data URL，下游消费无感知。
 */
export const IMAGE_FILE_PREFIX = 'imgfile:';

// ===================== 解析结果 LRU 缓存（读取提速核心） =====================
// 列表每次刷新（150ms 去抖）都会重新走 resolveImageRows：若无缓存，每个图片条目
// 都是一次 invoke（IPC 往返）+ Rust 磁盘读 + 全图 base64，几十张图就是几十次往返，
// 表现为「每次读图都很慢」。文件名是内容 sha256（内容寻址）：同文件名字节恒定，
// 缓存永久有效（删除文件后同内容再复制会重新落盘同名文件，data URL 不变），
// 因此不做 TTL 失效，只按字节预算做 LRU 淘汰防内存无界。

/** 缓存字节预算（data URL 字符串长度近似字节数）：约容下百张截图原图 */
const RESOLVE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 解析缓存：key = imgfile:<文件名>，value = data URL（Map 插入序即访问序，队首最旧） */
const resolveCache = new Map<string, string>();
let resolveCacheBytes = 0;

/** 缓存读取（命中时触碰移到队尾，保持 LRU 语义） */
function resolveCacheGet(key: string): string | undefined {
    const hit = resolveCache.get(key);
    if (hit === undefined) return undefined;
    resolveCache.delete(key);
    resolveCache.set(key, hit);
    return hit;
}

/** 缓存写入（重复写先扣旧值字节），超预算从队首逐出最旧条目 */
function resolveCachePut(key: string, dataUrl: string): void {
    const prev = resolveCache.get(key);
    if (prev !== undefined) resolveCacheBytes -= prev.length;
    resolveCache.delete(key);
    resolveCache.set(key, dataUrl);
    resolveCacheBytes += dataUrl.length;
    if (resolveCacheBytes > RESOLVE_CACHE_MAX_BYTES) {
        for (const [k, v] of resolveCache) {
            if (resolveCacheBytes <= RESOLVE_CACHE_MAX_BYTES) break;
            resolveCache.delete(k);
            resolveCacheBytes -= v.length;
        }
    }
}

/** 预热解析缓存（复制图片快速通道：clipboard_capture_image 已把原图落盘并随命令
 *  返回原图 data URL，此处直接入缓存——随后的列表刷新 resolveImageRows 命中缓存，
 *  新图不再触发读盘 + 多 MB IPC 回传） */
export function prewarmImageCache(fileRef: string, dataUrl: string): void {
    if (fileRef.startsWith(IMAGE_FILE_PREFIX) && dataUrl.startsWith('data:')) {
        resolveCachePut(fileRef, dataUrl);
    }
}

/**
 * imgfile: 文件引用 → 原图 data URL（读回 %APPDATA%/images 下的 PNG）。
 * 缓存命中零 IPC 零磁盘；未命中走单条读命令。非引用（文本/旧 base64 条目）原样返回；
 * 文件缺失/读取失败也原样返回（下游渲染裂图可感知，不静默吞掉引用串冒充图片）。
 */
export async function resolveImageContent(content: string): Promise<string> {
    if (!content.startsWith(IMAGE_FILE_PREFIX)) return content;
    const cached = resolveCacheGet(content);
    if (cached !== undefined) return cached;
    try {
        const dataUrl = await invoke<string | null>('read_clipboard_image_file', { file: content.slice(IMAGE_FILE_PREFIX.length) });
        if (dataUrl) resolveCachePut(content, dataUrl);
        return dataUrl ?? content;
    } catch {
        return content;
    }
}

/**
 * 行集合的图片引用统一解析（就地替换 content）：读取边界换回原图 data URL，
 * 列表/tooltip/查看器/粘贴等下游消费与旧 base64 时代完全一致。
 * 提速两板斧：缓存命中直接回填（零 IPC）；未命中的一次批量 invoke
 * （单次往返拉整页，取代逐图往返），Rust 侧 async 执行不阻塞事件循环。
 */
export async function resolveImageRows<T extends { type?: string; content: string }>(rows: T[]): Promise<T[]> {
    // 收集未命中的 imgfile 行（同引用多行归并到同一次读取）
    const pending = new Map<string, T[]>();
    for (const row of rows) {
        if (row.type !== 'image' || !row.content.startsWith(IMAGE_FILE_PREFIX)) continue;
        const cached = resolveCacheGet(row.content);
        if (cached !== undefined) {
            row.content = cached;
            continue;
        }
        const group = pending.get(row.content);
        if (group) group.push(row);
        else pending.set(row.content, [row]);
    }
    if (pending.size > 0) {
        const keys = [...pending.keys()];
        try {
            const urls = await invoke<(string | null)[]>(
                'read_clipboard_image_files',
                { files: keys.map(k => k.slice(IMAGE_FILE_PREFIX.length)) },
            );
            keys.forEach((key, i) => {
                const url = urls[i];
                if (!url) return; // 文件缺失：content 保持 imgfile: 引用（裂图可感知，与旧语义一致）
                resolveCachePut(key, url);
                for (const row of pending.get(key) ?? []) row.content = url;
            });
        } catch {
            // 批量失败：保留 imgfile 引用不动，下次刷新重试
        }
    }
    return rows;
}

/** 删除图片条目对应的原图文件（fire-and-forget）：引用形如 imgfile:<名> 时调 Rust 删除，
 *  旧 base64 条目/文本条目原样跳过；失败静默（残留孤儿文件无害，不影响 DB 一致性）。
 *  不清解析缓存：文件名即内容 hash，同引用重新落盘字节不变，缓存仍正确。 */
export function deleteImageFileByRef(content: string | null | undefined): void {
    if (!content || !content.startsWith(IMAGE_FILE_PREFIX)) return;
    void invoke('delete_clipboard_image_file', { file: content.slice(IMAGE_FILE_PREFIX.length) }).catch(() => {});
}
