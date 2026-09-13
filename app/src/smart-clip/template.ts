import { invoke } from '@tauri-apps/api/core';
import type { ClipExtractor, ClipScheme } from '../entities';
import type { Segment } from './types';
import { aiComplete, loadAiConfig, DEFAULT_AI_PROMPT } from './aiClient';
import { parseByRule } from './ruleEngine';

/**
 * 方案渲染（设计文档 §4.3，概念重构后）：
 *
 * - **提取器**是单个内容的提取单元（正则 / 分隔符 / AI 指令），一次产出 0..n 条片段；
 * - **方案**是多个提取器的集成体：按 members 顺序跑每个提取器，合并产出片段；
 *   再按可选 body 排版（{content} 原文 / {segN} 第 N 段 / {date} {time}），
 *   body 留空则直接输出合并后的片段。
 *
 * AI 加工只发生在「AI 提取器」上（{ai:指令} 内联占位符已移除，避免与提取器概念重叠）。
 */

/**
 * 输出契约：附加到每条 AI 指令之后，统一约束输出格式与语言。
 * 背景：模型常无视指令自行追加字段（如网盘文本里的分享平台/分享来源）、解释或
 * Markdown 代码块；且输出语言会跟随内容而非指令。双语书写——指令可能是中英任意一种。
 */
const OUTPUT_CONTRACT = [
    '',
    '---',
    '输出规则（必须严格遵守 / Strict output rules):',
    '1. 只输出指令要求的结果，逐行输出，每行一个片段 / Output only what the instruction asks, one item per line.',
    '2. 不输出指令未要求的任何字段或内容，不加解释、前后缀或 Markdown 代码块 / No fields beyond the instruction; no explanations or code fences.',
    '3. 输出语言与指令语言一致 / Respond in the same language as the instruction.',
].join('\n');

function withOutputContract(instruction: string): string {
    return instruction.trim() + OUTPUT_CONTRACT;
}

/**
 * 清洗 AI 输出再按行拆段：去掉 Markdown 代码围栏行、行首项目符号（- * • ·）与
 * 序号前缀（1. / 1、 / 1)），避免它们混进片段文本（模型不理会"无格式"约束时的兜底）。
 */
function sanitizeAiLines(out: string): string[] {
    return out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^`{3,}/.test(line))
        .map((line) => line.replace(/^[-*•·]\s+/, '').replace(/^\d+[.、)）]\s*/, ''))
        .filter((line) => line.length > 0);
}

/** 执行单个提取器：本地规则（正则/分隔符）或 AI 指令，产出 0..n 条片段 */
export async function runExtractor(extractor: ClipExtractor, content: string): Promise<Segment[]> {
    if (extractor.method === 'ai') {
        const cfg = await loadAiConfig();
        const instruction = extractor.expression.trim() || DEFAULT_AI_PROMPT;
        const out = await aiComplete(cfg, withOutputContract(instruction), content);
        return sanitizeAiLines(out).map((text, index) => ({ index, text, source: 'ai' as const }));
    }
    // 正则 / 分隔符：复用规则引擎（永不抛错，空结果返回原文单段）
    return parseByRule(content, {
        id: extractor.id,
        name: extractor.name,
        type: extractor.method,
        pattern: extractor.expression,
        priority: 0,
        enabled: 1,
    }).map((s, index) => ({ ...s, index }));
}

/** 执行方案：按 members 顺序跑成员提取器并合并片段（成员缺失/被删则跳过） */
export async function runScheme(
    scheme: ClipScheme,
    extractors: ClipExtractor[],
    content: string,
): Promise<Segment[]> {
    const byId = new Map(extractors.map((x) => [x.id, x]));
    const out: Segment[] = [];
    for (const id of scheme.members ?? []) {
        const ex = byId.get(id);
        if (!ex) continue;
        const segs = await runExtractor(ex, content);
        out.push(...segs);
    }
    return out.map((s, index) => ({ ...s, index }));
}

/** 按方案 body 排版合并片段；body 为空则原样返回片段 */
export function renderSchemeBody(
    scheme: ClipScheme,
    content: string,
    segments: Segment[],
): Segment[] {
    const body = (scheme.body ?? '').trim();
    if (!body) return segments;

    let text = body.replaceAll('{content}', content);
    text = text.replace(/\{seg(\d+)\}/g, (_, n: string) => segments[Number(n)]?.text ?? '');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    text = text
        .replaceAll('{date}', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
        .replaceAll('{time}', `${pad(now.getHours())}:${pad(now.getMinutes())}`);

    const lines = text.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    if (lines.length === 0) return segments;
    return lines.map((t, index) => ({ index, text: t, source: 'template' as const }));
}

/** AI 直接加工（无方案时）：输出按行拆为片段（source: 'ai'） */
export async function renderAiDirect(content: string): Promise<Segment[]> {
    const cfg = await loadAiConfig();
    const instruction = cfg.defaultPrompt && cfg.defaultPrompt.trim().length > 0
        ? cfg.defaultPrompt
        : DEFAULT_AI_PROMPT;
    const out = await aiComplete(cfg, withOutputContract(instruction), content);
    const lines = sanitizeAiLines(out);
    if (lines.length === 0) throw new Error('AI 返回为空');
    return lines.map((text, index) => ({ index, text, source: 'ai' as const }));
}

/** 连接测试（设置页按钮）：透传 Rust 侧 {ok, latency_ms, error} */
export async function testConnection(cfg: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
}): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
    return await invoke('ai_test_connection', {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
    });
}
