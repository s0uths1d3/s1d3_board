import { invoke } from '@tauri-apps/api/core';
import type { ClipExtractor, ClipScheme } from '../entities';
import type { Segment } from './types';
import { aiComplete, loadAiConfig } from './aiClient';
import { parseByRule } from './ruleEngine';
import { hashText } from '~/utils/hash';
import dbService from '../db/dbService';

/**
 * 方案渲染（设计文档 §4.3，概念重构后）：
 *
 * - **提取器**是单个内容的提取单元（正则 / 分隔符 / AI 指令），一次产出 0..n 条片段；
 * - **方案**是全部提取器的集成体：按提取器列表顺序依次执行，合并产出片段；
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
        // 未填指令的 AI 提取器直接跳过（不再有全局默认指令兜底），避免无意义调用
        const instruction = extractor.expression.trim();
        if (!instruction) return [];
        const cfg = await loadAiConfig();

        // 冷却缓存：同一内容 + 同一提取器在时间窗口内不重复调 AI（防连按 Ctrl+B 重复生成）
        const cacheKey = `${hashText(content)}:${extractor.id}`;
        const windowSec = Number(await dbService.getKeyValue('ai_result_window') || '300') || 0;
        const cached = await dbService.getAiCache(cacheKey, windowSec);
        if (cached !== null) {
            return sanitizeAiLines(cached).map((text, index) => ({ index, text, source: 'ai' as const, extractorId: extractor.id }));
        }

        // 偏好摘要：把用户近期粘贴习惯注入 prompt，逐步提升产出与用户选择的匹配度
        const digest = await dbService.fetchHabitDigest();
        const habitHint = digest.length > 0
            ? '\n用户近期偏好参考（提升选择准确度 / User preference hints):' +
              digest.map((d) => `\n- 提取器「${d.extractorId}」的产出被用户粘贴 ${d.count} 次 / its output was pasted ${d.count} times`).join('')
            : '';
        const out = await aiComplete(cfg, withOutputContract(instruction) + habitHint, content);
        void dbService.setAiCache(cacheKey, out).catch(() => {});
        return sanitizeAiLines(out).map((text, index) => ({ index, text, source: 'ai' as const, extractorId: extractor.id }));
    }
    // 正则 / 分隔符：复用规则引擎；无匹配返回 0 段（原文兜底由管道层统一处理）
    return parseByRule(content, {
        type: extractor.method,
        pattern: extractor.expression,
    }, false).map((s, index) => ({ ...s, index, extractorId: extractor.id }));
}

/**
 * 执行方案：按 members 顺序跑成员提取器并合并片段；
 * **成员为空 = 自动接入全部提取器**（声明式默认，新增提取器即参与），
 * 非空 = 指定子集（缺失/已删的成员跳过）。
 *
 * 合并时按文本去重：多个提取器（如网址提取与智能分词）常从同一段原文
 * 提取出相同内容，不去重会出现成排重复气泡。
 */
export async function runScheme(
    scheme: ClipScheme,
    extractors: ClipExtractor[],
    content: string,
): Promise<Segment[]> {
    const byId = new Map(extractors.map((x) => [x.id, x]));
    const members = scheme.members && scheme.members.length > 0
        ? scheme.members.map((id) => byId.get(id)).filter((x): x is ClipExtractor => !!x)
        : extractors;
    const out: Segment[] = [];
    // 判等键做空白归一化：\r、行尾空格等不可见差异不算新片段
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const seen = new Set<string>();
    for (const ex of members) {
        for (const seg of await runExtractor(ex, content)) {
            if (!seg.text.trim() || seen.has(norm(seg.text))) continue;
            seen.add(norm(seg.text));
            out.push(seg);
        }
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

/** 连接测试（设置页按钮）：透传 Rust 侧 {ok, latency_ms, error} */
export async function testConnection(cfg: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    customConfig?: string;
}): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
    return await invoke('ai_test_connection', {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        customConfig: cfg.customConfig,
    });
}
