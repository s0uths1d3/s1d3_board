import { invoke } from '@tauri-apps/api/core';
import dbService from '../db/dbService';

/**
 * AI 前端调用客户端（设计文档 §4.2）：
 * 从 settings 组装 AI 配置并 invoke Rust ai_complete / ai_test_connection。
 * API Key 不在前端缓存（每次从 KV 读），Rust 侧完成真实 HTTP 请求。
 */

export interface AiClientConfig {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    defaultPrompt: string;
}

/** 默认 AI 加工指令：无模板 / {ai:} 占位符留空时的兜底指令（输出契约由 template.ts 统一附加） */
export const DEFAULT_AI_PROMPT =
    '将内容整理为结构化片段，逐行输出，每行一个片段，不要额外解释。';

export async function loadAiConfig(): Promise<AiClientConfig> {
    const [provider, baseUrl, apiKey, model, defaultPrompt] = await Promise.all([
        dbService.getKeyValue('ai_provider'),
        dbService.getKeyValue('ai_base_url'),
        dbService.getKeyValue('api_key'),
        dbService.getKeyValue('ai_model'),
        dbService.getKeyValue('ai_default_prompt'),
    ]);
    return {
        provider: provider || 'openai-compat',
        baseUrl: baseUrl || '',
        apiKey: apiKey || '',
        model: model || 'gpt-4o-mini',
        defaultPrompt: defaultPrompt || '',
    };
}

/** AI 内容加工：失败由调用方降级处理（本函数透传 Rust 侧错误消息） */
export async function aiComplete(cfg: AiClientConfig, system: string, content: string): Promise<string> {
    return await invoke<string>('ai_complete', {
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        system,
        content,
    });
}
