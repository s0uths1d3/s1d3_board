import type { ExtractRule } from '../entities';
import type { Segment } from './types';
import { parseByRule } from './ruleEngine';
import { splitLocal } from './autoSplit';
import { BUILTIN_PRECISE_RULES, BUILTIN_TOKENIZE_RULE, isExtractRuleValid } from './extractors';
import { RING_MAX_SEGMENTS } from './ringSegments';

/**
 * 单层切分管线（设计文档 .docs/ctrl-b-refactor-design.md §14.1）：
 *
 * ```
 * 结构层切分（JSON/链接/日志/路径/多行/分隔符）
 *   → 技术/代码保护（代码相关不再拆词）
 *   → 内置精确切分器（链接、邮箱）
 *   → 用户自定义规则（按顺序，首个产出 ≥2 段即生效）
 *   → 内置分词兜底
 *   → 简单词串 / 短文本拆词 / 关键词 / 超长分块 / 原文单段
 * ```
 *
 * 全程本地、无 IO、无网络：规则类型只有 regex / separator，不存在隐式 AI 调用；
 * AI 只出现在散文内容的事后分析（analysis.ts），且只接收同一份 content。
 */

/** 单条规则执行：产出 0..n 段；空产出/异常返回 null（不阻断后续规则） */
export function runExtractRule(rule: ExtractRule, content: string): Segment[] | null {
    try {
        const seen = new Set<string>();
        const segments: Segment[] = [];
        for (const seg of parseByRule(content, { type: rule.type, pattern: rule.expression }, false)) {
            const text = seg.text.trim();
            // 空白归一化判等：\r、行尾空格等不可见差异不算新片段
            const key = text.replace(/\s+/g, ' ');
            if (!text || seen.has(key)) continue;
            seen.add(key);
            segments.push({ index: segments.length, text, source: 'rule', extractorId: rule.id });
            if (segments.length >= RING_MAX_SEGMENTS) break;
        }
        return segments.length >= 2 ? segments : null;
    } catch (e) {
        console.warn(`[smart-clip] 提取规则「${rule.name || rule.id}」执行失败，跳过:`, e);
        return null;
    }
}

/** 按管线顺序切分本次内容；任何异常由 splitLocal 兜底为原文单段 */
export function splitByPipeline(raw: string, rules: ExtractRule[] = []): Segment[] {
    const custom = rules.filter((r) => r.enabled === 1 && isExtractRuleValid(r));
    return splitLocal(raw, [
        ...BUILTIN_PRECISE_RULES.map((rule) => (content: string) => runExtractRule(rule, content)),
        ...custom.map((rule) => (content: string) => runExtractRule(rule, content)),
        (content: string) => runExtractRule(BUILTIN_TOKENIZE_RULE, content),
    ]);
}
