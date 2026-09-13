import type { ClipRule } from '../entities';
import type { Segment } from './types';

/**
 * 规则引擎（设计文档 §4.1）：按规则把 clip 文本拆分为片段。
 *
 * 纯函数、无 IO、永不抛错：任何异常（非法正则等）都降级为「原文单段」，
 * 保证解析管道永不丢内容；规则类型扩展在此文件内新增 split 函数即可。
 */

/** 降级兜底：解析不出多段时返回原文单段 */
function single(content: string): Segment[] {
    return [{ index: 0, text: content, source: 'rule' }];
}

/**
 * 正则提取：
 * - 有捕获组 → 每次匹配的捕获组 1..n 各成一段（如 URL 提取 host/path）
 * - 无捕获组 → 每次匹配的整体各成一段（如按行提取所有邮箱）
 * - 零宽匹配 lastIndex 前进防死循环
 */
function extractByRegex(content: string, pattern: string): string[] {
    const re = new RegExp(pattern, 'gm');
    const out: string[] = [];
    let captureGroups = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        if (captureGroups === -1) captureGroups = Math.max(0, m.length - 1);
        if (captureGroups > 0) {
            for (let g = 1; g <= captureGroups; g++) {
                if (m[g] !== undefined && m[g] !== '') out.push(m[g]);
            }
        } else if (m[0] !== '') {
            out.push(m[0]);
        }
        if (m.index === re.lastIndex) re.lastIndex++;
    }
    return out;
}

/** 按单条规则解析：trim 各段并去空；结果为空时降级为原文单段 */
export function parseByRule(content: string, rule: ClipRule): Segment[] {
    try {
        const raw = rule.type === 'regex'
            ? extractByRegex(content, rule.pattern)
            : content.split(rule.pattern);
        const cleaned = raw.map((s) => s.trim()).filter((s) => s.length > 0);
        if (cleaned.length === 0) return single(content);
        return cleaned.map((text, index) => ({ index, text, source: 'rule' as const }));
    } catch (e) {
        // 非法正则 / 分隔符等配置错误：不中断管道，降级为原文单段
        console.error(`[smart-clip] 规则「${rule.name}」解析失败，降级为原文单段:`, e);
        return single(content);
    }
}
