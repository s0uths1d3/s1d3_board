import { invoke } from '@tauri-apps/api/core';
import type { ClipTemplate } from '../entities';
import type { Segment } from './types';
import { aiComplete, loadAiConfig } from './aiClient';

/**
 * 模板渲染（设计文档 §4.3）：
 * body 占位符：{content} 原文 / {segN} 第 N 段 / {date} {time} 当前日期时间 /
 * {ai:指令} 将原文按指令送 AI 加工（异步，逐个顺序执行）。
 *
 * 渲染结果按行拆为 Segment[]（source: 'template'）；渲染为空时回退传入的原片段，
 * 保证处理管道永不丢内容。
 */

const AI_PLACEHOLDER = /\{ai:([^}]*)\}/g;

/** 异步顺序替换 {ai:指令} 占位符（同模板多个 AI 占位符按出现顺序执行） */
async function renderAiPlaceholders(body: string, content: string): Promise<string> {
    const matches = [...body.matchAll(AI_PLACEHOLDER)];
    if (matches.length === 0) return body;
    const cfg = await loadAiConfig();
    let out = body;
    for (const m of matches) {
        const instruction = m[1].trim() || '整理以下内容。';
        const result = await aiComplete(cfg, instruction, content);
        out = out.replace(m[0], result);
    }
    return out;
}

export async function renderTemplate(
    template: ClipTemplate,
    content: string,
    segments: Segment[],
): Promise<Segment[]> {
    let body = template.body;

    // 同步占位符：{content} / {segN} / {date} / {time}
    body = body.replaceAll('{content}', content);
    body = body.replace(/\{seg(\d+)\}/g, (_, n: string) => segments[Number(n)]?.text ?? '');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    body = body
        .replaceAll('{date}', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
        .replaceAll('{time}', `${pad(now.getHours())}:${pad(now.getMinutes())}`);

    // AI 占位符（异步）
    try {
        body = await renderAiPlaceholders(body, content);
    } catch (e) {
        console.error('[smart-clip] 模板 AI 占位符渲染失败，降级为已替换部分:', e);
    }

    // 按行拆分为片段（与 AI 输出按行拆分的消费方式一致）
    const lines = body.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    if (lines.length === 0) return segments;
    return lines.map((text, index) => ({ index, text, source: 'template' as const }));
}

/** AI 直接加工（无模板时）：输出按行拆为片段（source: 'ai'） */
export async function renderAiDirect(content: string): Promise<Segment[]> {
    const cfg = await loadAiConfig();
    const out = await aiComplete(cfg, '将内容整理为结构化片段，逐行输出，不要额外解释。', content);
    const lines = out.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
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
