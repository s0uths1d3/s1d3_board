//! AI 引擎（设计文档 §4.2）：Rust 侧代理调用 AI API，前端不直接 fetch。
//!
//! - CSP 的 connect-src 无需放宽任意域名
//! - API Key 不暴露给 WebView（前端从 settings 读出后经本机 IPC 传入）
//!
//! 提供商经 `AIProvider` trait 抽象（RPITIT 原生 async，无额外依赖）：
//! - `openai-compat`：POST {base}/chat/completions，Bearer 鉴权，choices[0].message.content
//! - `anthropic`：   POST {base}/v1/messages，x-api-key + anthropic-version 头，
//!                    system 为顶层字段，max_tokens 必填，content[].text 拼接
//!
//! 新增提供商 = 实现 AIProvider + 在 provider_for 注册，调用方零改动。

use serde::Serialize;
use std::time::{Duration, Instant};

/// 单次 AI 请求超时
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Anthropic 的 max_tokens 必填；统一上限（智能剪贴板的加工场景足够）
const MAX_TOKENS: u32 = 2048;

/// AI 调用配置（前端从 settings 读出后经 IPC 传入）
#[derive(Serialize, Clone)]
pub struct AiConfig {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize, Clone)]
pub struct AiTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 规整 base_url：去尾部斜杠；空值回落到该提供商的官方默认地址
fn normalize_base_url(base_url: &str, provider_default: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        provider_default.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 统一错误提取：非 2xx 时带上状态码与响应体前 300 字符，便于排查（key 鉴权失败等）
async fn error_from_response(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let brief: String = body.chars().take(300).collect();
    format!("AI API 返回 {status}: {brief}")
}

// ===================== 提供商抽象 =====================

trait AIProvider {
    async fn complete(&self, cfg: &AiConfig, system: &str, content: &str) -> Result<String, String>;
}

struct OpenAiCompatProvider;
struct AnthropicProvider;

impl OpenAiCompatProvider {
    fn base(cfg: &AiConfig) -> String {
        normalize_base_url(&cfg.base_url, "https://api.openai.com/v1")
    }
}

impl AIProvider for OpenAiCompatProvider {
    async fn complete(&self, cfg: &AiConfig, system: &str, content: &str) -> Result<String, String> {
        let url = format!("{}/chat/completions", Self::base(cfg));
        let body = serde_json::json!({
            "model": cfg.model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": content }
            ],
        });
        let resp = http_client()?
            .post(url)
            .header("Authorization", format!("Bearer {}", cfg.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("AI API 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("AI API 响应解析失败: {e}"))?;
        json["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "AI API 响应缺少 choices[0].message.content".to_string())
    }
}

impl AnthropicProvider {
    fn base(cfg: &AiConfig) -> String {
        normalize_base_url(&cfg.base_url, "https://api.anthropic.com")
    }
}

impl AIProvider for AnthropicProvider {
    async fn complete(&self, cfg: &AiConfig, system: &str, content: &str) -> Result<String, String> {
        let url = format!("{}/v1/messages", Self::base(cfg));
        let body = serde_json::json!({
            "model": cfg.model,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": [
                { "role": "user", "content": content }
            ],
        });
        let resp = http_client()?
            .post(url)
            .header("x-api-key", &cfg.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("AI API 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("AI API 响应解析失败: {e}"))?;
        // content 是块数组：拼接全部 type === "text" 的块
        let mut out = String::new();
        if let Some(blocks) = json["content"].as_array() {
            for block in blocks {
                if block["type"] == "text" {
                    if let Some(text) = block["text"].as_str() {
                        out.push_str(text);
                    }
                }
            }
        }
        if out.is_empty() {
            return Err("AI API 响应缺少文本块".to_string());
        }
        Ok(out)
    }
}

/// 提供商枚举：async trait 方法不可 dyn（RPITIT），用 enum 静态分派
/// （新增提供商 = 新 variant + match 分支，调用方零改动）
enum AiProvider {
    OpenAiCompat(OpenAiCompatProvider),
    Anthropic(AnthropicProvider),
}

impl AiProvider {
    async fn complete(&self, cfg: &AiConfig, system: &str, content: &str) -> Result<String, String> {
        match self {
            Self::OpenAiCompat(p) => p.complete(cfg, system, content).await,
            Self::Anthropic(p) => p.complete(cfg, system, content).await,
        }
    }
}

/// 按配置选择提供商（新提供商在此注册，调用方零改动）
fn provider_for(cfg: &AiConfig) -> AiProvider {
    match cfg.provider.as_str() {
        "anthropic" => AiProvider::Anthropic(AnthropicProvider),
        _ => AiProvider::OpenAiCompat(OpenAiCompatProvider),
    }
}

fn provider_for_err(cfg: &AiConfig) -> Result<AiProvider, String> {
    match cfg.provider.as_str() {
        "openai-compat" | "anthropic" => Ok(provider_for(cfg)),
        other => Err(format!("未知的 AI 提供商: {other}")),
    }
}

// ===================== Tauri commands =====================

/// 连接测试：发一条最小请求（"ping"），返回可达性与耗时（设置页「测试连接」按钮）
#[tauri::command]
pub async fn ai_test_connection(
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<AiTestResult, String> {
    let cfg = AiConfig { provider, base_url, api_key, model };
    let p = provider_for_err(&cfg)?;
    let started = Instant::now();
    match p.complete(&cfg, "You are a connectivity test.", "ping").await {
        Ok(_) => Ok(AiTestResult { ok: true, latency_ms: started.elapsed().as_millis() as u64, error: None }),
        Err(e) => Ok(AiTestResult { ok: false, latency_ms: started.elapsed().as_millis() as u64, error: Some(e) }),
    }
}

/// 内容加工：system 为模板指令（模板 {ai:指令} 占位符或默认指令），content 为剪贴板原文
#[tauri::command]
pub async fn ai_complete(
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    content: String,
) -> Result<String, String> {
    let cfg = AiConfig { provider, base_url, api_key, model };
    provider_for_err(&cfg)?.complete(&cfg, &system, &content).await
}
