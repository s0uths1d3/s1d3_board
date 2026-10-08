/**
 * 环盘片段纯逻辑（Ctrl+B 环形面板的数据整形层）：片段归一化、空白归一化去重、
 * AI 产出合并、分页计算。全部无 IO 纯函数，供 BubbleToggleCommand 的两阶段
 * 管线（本地拆分 → AI 分析并入）复用。
 */

/** 环盘片段：一段可粘贴文本 + 产出它的提取器 id（'ai-analysis' = AI 关键词/总结） */
export interface RingSegment {
    text: string;
    extractorId: string;
}

/** 单页槽位数（环形布局一圈的上限） */
export const RING_PAGE_SIZE = 8;

/** 片段总数上限（3 页），防止极端数据把环拉出屏幕 */
export const RING_MAX_SEGMENTS = 24;

/**
 * 空白归一化判等键：Windows 剪贴板文本常带不可见的空白差异（\r、行尾空格、
 * 连续空格），精确判等会让"内容相同"的片段成排出现在环上。
 */
export function blankNormalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

/** 由现有片段集合构建去重键集合（AI 并入时与基础片段判重用） */
export function buildSeen(segments: RingSegment[]): Set<string> {
    const seen = new Set<string>();
    for (const s of segments) {
        const key = blankNormalize(s.text);
        if (key) seen.add(key);
    }
    return seen;
}

/** 归一化：trim、丢弃空片段、空白归一化判重，封顶 cap，顺序保持输入序 */
export function normalizeSegments(
    raw: Array<{ text: string; extractorId?: string }>,
    cap: number = RING_MAX_SEGMENTS,
): RingSegment[] {
    const seen = new Set<string>();
    const out: RingSegment[] = [];
    for (const item of raw) {
        const text = (item.text ?? '').trim();
        if (!text) continue;
        const key = blankNormalize(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ text, extractorId: item.extractorId ?? '' });
        if (out.length >= cap) break;
    }
    return out;
}

/**
 * AI 产出（关键词 + 总结）并入基础片段：仅返回去重后的**新增**部分（总结排最后），
 * 总长度封顶 cap，调用方直接追加到基础列表尾部。
 */
export function mergeAiSegments(
    base: RingSegment[],
    outcome: { keywords: string[]; summary: string },
    cap: number = RING_MAX_SEGMENTS,
): RingSegment[] {
    const seen = buildSeen(base);
    const added: RingSegment[] = [];
    const candidates = [...outcome.keywords, ...(outcome.summary ? [outcome.summary] : [])];
    for (const text of candidates) {
        if (base.length + added.length >= cap) break;
        const trimmed = text.trim();
        if (!trimmed) continue;
        const key = blankNormalize(trimmed);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        added.push({ text: trimmed, extractorId: 'ai-analysis' });
    }
    return added;
}

/** 总页数（至少 1 页） */
export function ringPageCount(total: number): number {
    return Math.max(1, Math.ceil(total / RING_PAGE_SIZE));
}

/** 某页的片段区间 [start, end)（页码 0 起，越界钳制到合法页） */
export function ringPageRange(total: number, page: number): [number, number] {
    const pages = ringPageCount(total);
    const p = Math.min(Math.max(0, page), pages - 1);
    const start = p * RING_PAGE_SIZE;
    return [start, Math.min(total, start + RING_PAGE_SIZE)];
}
