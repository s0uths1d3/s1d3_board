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
}

/**
 * 组装 AI 配置。
 * 注：原「AI 加工默认指令」（KV ai_default_prompt）已移除——AI 加工统一由
 * **AI 提取器**承载（方案引用它），指令写在提取器里，不再有全局兜底指令。
 */
export async function loadAiConfig(): Promise<AiClientConfig> {
    const [provider, baseUrl, apiKey, model] = await Promise.all([
        dbService.getKeyValue('ai_provider'),
        dbService.getKeyValue('ai_base_url'),
        dbService.getKeyValue('api_key'),
        dbService.getKeyValue('ai_model'),
    ]);
    return {
        provider: provider || 'openai-compat',
        baseUrl: baseUrl || '',
        apiKey: apiKey || '',
        model: model || 'gpt-4o-mini',
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
