import { ref, watch, onBeforeUnmount } from 'vue';

/**
 * 流式加载列表（滚动到底部才加载下一页）
 *
 * 统一各 Tab（剪贴板 / 常用剪贴 / 便签 / 待办）的分页加载行为：
 * - 首屏只加载第一页（pageSize 条），列表底部出现 sentinel（占位元素）；
 * - sentinel 进入视口（rootMargin 提前 200px）时自动加载下一页，直到全部加载完；
 * - 搜索/筛选变化时调用 reload() 重置为第一页；
 * - 轮询/数据操作后调用 refreshLoaded() 刷新"已加载范围"（不会预取未加载数据）。
 *
 * 加载下一页用 offset = 已加载条数；顶部插入新数据导致的 offset 重叠按 id 去重合并。
 */
export function useInfiniteList<T>(options: {
    /** 分页查询：offset 起始偏移，limit 页大小 */
    fetchPage: (offset: number, limit: number) => Promise<T[]>;
    /** 每页条数，默认 50 */
    pageSize?: number;
    /** 去重/比较键，默认 item.id */
    keyOf?: (item: T) => string | number;
    /** 分页查询失败时的回调（默认仅 console.error） */
    onError?: (err: unknown) => void;
    /** 刷新已加载范围时的签名函数（如 item => `${id}:${updated_at}`）：
     *  签名一致则跳过整表替换，避免轮询触发无谓重渲染 */
    signatureOf?: (item: T) => string;
}) {
    const pageSize = options.pageSize ?? 50;
    const keyOf = options.keyOf ?? ((item: T) => (item as { id: string | number }).id);

    /** 已加载的全部条目（按数据库顺序） */
    const items = ref<T[]>([]);
    /** 解包为 T[]（ref 泛型存在 UnwrapRef 类型差异，内部操作统一用它） */
    const list = () => items.value as T[];
    /** 任意加载进行中（首屏/加载更多/刷新），用于 UI 显示加载态 */
    const loading = ref(false);
    /** 是否还有下一页（不足一页 = 已到底） */
    const hasMore = ref(true);
    /** 底部占位元素：进入视口触发加载下一页 */
    const sentinel = ref<HTMLElement | null>(null);

    /** 任意加载进行中标记：loadMore/reload/refreshLoaded 互斥，防止并发错乱 */
    let busy = false;
    let observer: IntersectionObserver | null = null;
    let disposed = false;
    /** 上次刷新已加载范围的结果签名（signatureOf 提供时生效） */
    let lastRefreshSig = '';

    /** 建立/重建 sentinel 观察（加载后 sentinel 随 DOM 移动，需重新观察） */
    function setupObserver() {
        observer?.disconnect();
        observer = null;
        const el = sentinel.value;
        if (!el) return;
        observer = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting) {
                void loadMore();
            }
        }, { rootMargin: '200px 0px' });
        observer.observe(el);
    }

    /** 加载下一页（滚动到底触发；同时被 reload 复用） */
    async function loadMore() {
        if (busy || !hasMore.value) return;
        busy = true;
        loading.value = true;
        try {
            const offset = list().length;
            const fetched = await options.fetchPage(offset, pageSize);
            if (disposed) return;
            // 顶部插入新数据时 offset 会重叠，按 id 去重合并
            const seen = new Set(list().map(keyOf));
            const fresh = fetched.filter((it) => !seen.has(keyOf(it)));
            items.value = [...list(), ...fresh];
            hasMore.value = fetched.length >= pageSize;
        } catch (e) {
            console.error('[useInfiniteList] 加载更多失败:', e);
            options.onError?.(e);
        } finally {
            busy = false;
            loading.value = false;
            // 加载完成后 sentinel 位置可能变化，重新观察
            requestAnimationFrame(() => {
                if (!disposed) setupObserver();
            });
        }
    }

    /** 重置：清空已加载并重新加载第一页（搜索/筛选/类型变化时）。
     *  返回是否真正执行（加载进行中互斥跳过时返回 false，调用方可重试） */
    async function reload(): Promise<boolean> {
        if (busy) return false;
        items.value = [];
        hasMore.value = true;
        await loadMore();
        return true;
    }

    /** 刷新已加载范围：拉取最新前 N 条替换（轮询/操作后同步，不预取未加载数据） */
    async function refreshLoaded() {
        if (busy) return;
        if (items.value.length === 0) {
            await loadMore();
            return;
        }
        busy = true;
        loading.value = true;
        try {
            const limit = Math.max(items.value.length, pageSize);
            const fetched = await options.fetchPage(0, limit);
            if (disposed) return;
            const nextHasMore = fetched.length >= limit;
            // 提供签名函数时：签名一致则跳过整表替换（轮询去重，避免无谓重渲染）
            if (options.signatureOf) {
                const sig = fetched.map(options.signatureOf).join('|');
                if (sig === lastRefreshSig) {
                    if (hasMore.value !== nextHasMore) hasMore.value = nextHasMore;
                    return;
                }
                lastRefreshSig = sig;
            }
            items.value = fetched;
            hasMore.value = nextHasMore;
        } catch (e) {
            console.error('[useInfiniteList] 刷新已加载范围失败:', e);
            options.onError?.(e);
        } finally {
            busy = false;
            loading.value = false;
            requestAnimationFrame(() => {
                if (!disposed) setupObserver();
            });
        }
    }

    /** sentinel DOM 挂载/卸载后自动重建观察 */
    watch(sentinel, () => setupObserver());

    /** 整体替换列表（如"搜索全部范围"的查询结果）：此时已到底，不再流式加载 */
    function replace(all: T[]) {
        items.value = all;
        hasMore.value = false;
    }

    /** 头部插入一条（如新建便签，立即出现在列表顶部） */
    function prepend(item: T) {
        items.value = [item, ...list()];
    }

    /** 按条件移除一条（如删除便签，避免整表刷新） */
    function remove(predicate: (item: T) => boolean) {
        items.value = list().filter((it) => !predicate(it));
    }

    onBeforeUnmount(() => {
        disposed = true;
        observer?.disconnect();
        observer = null;
    });

    return {
        items,
        loading,
        hasMore,
        sentinel,
        loadMore,
        reload,
        refreshLoaded,
        replace,
        prepend,
        remove,
    };
}
