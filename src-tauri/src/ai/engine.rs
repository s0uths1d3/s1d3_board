//! AI 引擎（设计文档 §4.2）：Rust 侧代理调用 AI API，前端不直接 fetch。
//!
//! - CSP 的 connect-src 无需放宽任意域名
//! - API Key 不暴露给 WebView（前端从 settings 读出后经本机 IPC 传入）
//!
//! 提供商经 `AIProvider` trait 抽象（RPITIT 原生 async，无额外依赖）：
//! - `openai-compat`：POST {base}/chat/completions，Bearer 鉴权，choices[0].message.content
//! - `anthropic`：   POST {base}/v1/messages，x-api-key + anthropic-version 头，
//!                    system 为顶层字段，max_tokens 必填，content[].text 拼接
//! - `custom`：      用户在设置页自建 JSON 模板（KV ai_custom_config），
//!                    自定义接口路径 / 请求头 / 请求体与响应提取路径；
//!                    path 支持 {{baseUrl}} {{model}} {{apiKey}}，
//!                    请求体/请求头支持 {{baseUrl}} {{model}} {{apiKey}} {{system}} {{content}}；
//!                    响应为 SSE（text/event-stream）时按帧提取并 emit `ai:chunk`
//!                    （payload {text: 累计全文}），invoke 最终仍返回拼接全文。
//!
//! 新增提供商 = 实现 AIProvider + 在 provider_for 注册，调用方零改动。

use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::Emitter;

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
    /// provider = custom 时的 JSON 模板串（其余提供商为 None）
    #[serde(default)]
    pub custom_config: Option<String>,
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

/// 读取响应体并解析 JSON（2xx 路径）：解析失败时附响应体前 200 字符。
/// 典型场景：中转站/代理返回 200 + HTML 错误页或限流页，resp.json() 只报
/// "error decoding response body"，不带片段无法定位服务端实际返回了什么
async fn json_with_preview(resp: reqwest::Response) -> Result<serde_json::Value, String> {
    let text = resp
        .text()
        .await
        .map_err(|e| format!("AI API 响应读取失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| {
        let preview: String = text.chars().take(200).collect();
        format!("AI API 响应解析失败: {e}；响应片段: {preview}")
    })
}

// ===================== 提供商抽象 =====================

trait AIProvider {
    async fn complete(
        &self,
        cfg: &AiConfig,
        system: &str,
        content: &str,
        app: &tauri::AppHandle,
    ) -> Result<String, String>;
}

struct OpenAiCompatProvider;
struct AnthropicProvider;
struct CustomProvider;

impl OpenAiCompatProvider {
    fn base(cfg: &AiConfig) -> String {
        normalize_base_url(&cfg.base_url, "https://api.openai.com/v1")
    }
}

impl AIProvider for OpenAiCompatProvider {
    async fn complete(
        &self,
        cfg: &AiConfig,
        system: &str,
        content: &str,
        _app: &tauri::AppHandle,
    ) -> Result<String, String> {
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
        let json: serde_json::Value = json_with_preview(resp).await?;
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
    async fn complete(
        &self,
        cfg: &AiConfig,
        system: &str,
        content: &str,
        _app: &tauri::AppHandle,
    ) -> Result<String, String> {
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
        let json: serde_json::Value = json_with_preview(resp).await?;
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

// ===================== 自定义提供商（JSON 模板） =====================

/// 自定义模式配置（设置页 JSON 编辑器的内容，KV ai_custom_config）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomAiConfig {
    /// 接口路径：拼在 Base URL 之后；以 http(s):// 开头时整体作为最终 URL（可覆盖 Base URL）
    #[serde(default)]
    path: String,
    /// 请求头模板（键值均须为字符串，值支持占位符）；Content-Type 由 .json() 自动带出，可在此覆盖
    #[serde(default)]
    headers: serde_json::Value,
    /// 请求体模板（占位符替换后的值保持原始类型，不做字符串转义）
    body: serde_json::Value,
    /// 非流式（JSON）响应的文本提取路径，如 choices[0].message.content
    #[serde(default = "default_response_path")]
    response_path: String,
    /// 流式（SSE）每帧的增量文本提取路径
    #[serde(default = "default_stream_response_path")]
    stream_response_path: String,
}

fn default_response_path() -> String {
    "choices[0].message.content".to_string()
}

fn default_stream_response_path() -> String {
    "choices[0].delta.content".to_string()
}

/// 占位符替换：字符串值整串恰为一个占位符时替换为原始值（content/system 等长文本免转义），
/// 否则做字面替换（如 "Bearer {{apiKey}}"）。占位符：{{model}} {{apiKey}} {{system}} {{content}}
fn substitute(value: &mut serde_json::Value, vars: &[(&str, &str)]) {
    match value {
        serde_json::Value::String(s) => {
            for (name, val) in vars {
                let ph = format!("{{{{{}}}}}", name);
                if s.as_str() == ph {
                    *s = (*val).to_string();
                    return;
                }
            }
            for (name, val) in vars {
                let ph = format!("{{{{{}}}}}", name);
                if s.contains(&ph) {
                    *s = s.replace(&ph, val);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr {
                substitute(v, vars);
            }
        }
        serde_json::Value::Object(map) => {
            for v in map.values_mut() {
                substitute(v, vars);
            }
        }
        _ => {}
    }
}

/// 响应提取路径分词：choices[0].message.content 与 choices.0.message.content 等价
fn tokenize_path(path: &str) -> Vec<String> {
    path.split(['.', '[', ']'])
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

/// 按 a.b.0.c / a[0].b 混合路径取值；数字 token 先按数组下标、再按对象键尝试
fn resolve_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = root;
    for token in tokenize_path(path) {
        cur = match token.parse::<usize>() {
            Ok(idx) => cur.get(idx).or_else(|| cur.get(token))?,
            Err(_) => cur.get(&token)?,
        };
    }
    Some(cur)
}

impl CustomProvider {
    /// 解析并结构校验自定义配置
    fn parse(cfg: &AiConfig) -> Result<CustomAiConfig, String> {
        let raw = cfg
            .custom_config
            .as_deref()
            .ok_or_else(|| "自定义模式缺少 JSON 配置（设置页填写后保存）".to_string())?;
        let custom: CustomAiConfig = serde_json::from_str(raw)
            .map_err(|e| format!("自定义 AI 配置 JSON 无效: {e}"))?;
        if !custom.body.is_object() {
            return Err("自定义 AI 配置的 body 必须是 JSON 对象".to_string());
        }
        if let Some(map) = custom.headers.as_object() {
            for (k, v) in map {
                if !v.is_string() {
                    return Err(format!("自定义 AI 配置 headers.{k} 必须是字符串"));
                }
            }
        } else if !custom.headers.is_null() {
            return Err("自定义 AI 配置的 headers 必须是 JSON 对象".to_string());
        }
        Ok(custom)
    }
}

impl AIProvider for CustomProvider {
    async fn complete(
        &self,
        cfg: &AiConfig,
        system: &str,
        content: &str,
        app: &tauri::AppHandle,
    ) -> Result<String, String> {
        let custom = CustomProvider::parse(cfg)?;
        let base = normalize_base_url(&cfg.base_url, "");

        // path 占位符替换：支持 {{baseUrl}} {{model}} {{apiKey}}
        // （不开放 {{system}}/{{content}}，避免长文本注入 URL）
        let mut path_val = serde_json::Value::String(custom.path.clone());
        substitute(
            &mut path_val,
            &[
                ("baseUrl", base.as_str()),
                ("model", cfg.model.as_str()),
                ("apiKey", cfg.api_key.as_str()),
            ],
        );
        let path = path_val.as_str().unwrap_or_default().trim().to_string();

        // URL：path 为绝对地址时直接用，否则拼在 Base URL 后
        let url = if path.starts_with("http://") || path.starts_with("https://") {
            path
        } else if base.is_empty() {
            return Err(
                "自定义模式需要在 Base URL 填写接口地址（或在 path 中写完整 URL）".to_string(),
            );
        } else {
            format!("{base}{path}")
        };

        // 请求体/请求头占位符替换（整值替换不转义，长文本安全）
        let vars: Vec<(&str, &str)> = vec![
            ("baseUrl", base.as_str()),
            ("model", cfg.model.as_str()),
            ("apiKey", cfg.api_key.as_str()),
            ("system", system),
            ("content", content),
        ];
        let mut body = custom.body.clone();
        substitute(&mut body, &vars);

        let mut req = http_client()?.post(&url).json(&body);
        if let Some(map) = custom.headers.as_object() {
            for (k, v) in map {
                let mut hv = v.clone();
                substitute(&mut hv, &vars);
                req = req.header(k, hv.as_str().unwrap_or_default());
            }
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("AI API 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(error_from_response(resp).await);
        }

        // 按响应 Content-Type 分流：SSE 流式 → 逐帧提取累积；否则 JSON 整体提取
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        if content_type.contains("text/event-stream") {
            complete_stream(resp, &custom, app).await
        } else {
            let json: serde_json::Value = json_with_preview(resp).await?;
            resolve_path(&json, &custom.response_path)
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("AI API 响应在 {} 处没有文本", custom.response_path))
        }
    }
}

/// SSE 流式消费：解析 data: 帧，按 streamResponsePath 提取增量并累积；
/// 每收到增量 emit `ai:chunk`（payload {text: 累计全文}），invoke 最终返回拼接全文
async fn complete_stream(
    resp: reqwest::Response,
    custom: &CustomAiConfig,
    app: &tauri::AppHandle,
) -> Result<String, String> {
    use futures_util::StreamExt;

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut out = String::new();
    let mut done = false;

    while !done {
        let Some(chunk) = stream.next().await else { break };
        let bytes = chunk.map_err(|e| format!("AI API 流读取失败: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        // 跨网络分包的行缓冲：只处理完整行，剩余留待下一包
        while let Some(pos) = buf.find('\n') {
            let line: String = buf[..pos].trim_end_matches('\r').to_string();
            buf.replace_range(..=pos, "");
            let trimmed = line.trim();
            if trimmed == "data: [DONE]" {
                done = true;
                break;
            }
            let Some(data) = trimmed.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            if let Some(text) = resolve_path(&frame, &custom.stream_response_path).and_then(|v| v.as_str())
            {
                if !text.is_empty() {
                    out.push_str(text);
                    let _ = app.emit(crate::core::events::AI_CHUNK, serde_json::json!({ "text": out }));
                }
            }
        }
    }

    if out.is_empty() {
        return Err(format!(
            "流式响应未提取到文本（检查 streamResponsePath: {}）",
            custom.stream_response_path
        ));
    }
    Ok(out)
}

/// 提供商枚举：async trait 方法不可 dyn（RPITIT），用 enum 静态分派
/// （新增提供商 = 新 variant + match 分支，调用方零改动）
enum AiProvider {
    OpenAiCompat(OpenAiCompatProvider),
    Anthropic(AnthropicProvider),
    Custom(CustomProvider),
}

impl AiProvider {
    async fn complete(
        &self,
        cfg: &AiConfig,
        system: &str,
        content: &str,
        app: &tauri::AppHandle,
    ) -> Result<String, String> {
        match self {
            Self::OpenAiCompat(p) => p.complete(cfg, system, content, app).await,
            Self::Anthropic(p) => p.complete(cfg, system, content, app).await,
            Self::Custom(p) => p.complete(cfg, system, content, app).await,
        }
    }
}

/// 按配置选择提供商（新提供商在此注册，调用方零改动）
fn provider_for(cfg: &AiConfig) -> AiProvider {
    match cfg.provider.as_str() {
        "anthropic" => AiProvider::Anthropic(AnthropicProvider),
        "custom" => AiProvider::Custom(CustomProvider),
        _ => AiProvider::OpenAiCompat(OpenAiCompatProvider),
    }
}

fn provider_for_err(cfg: &AiConfig) -> Result<AiProvider, String> {
    match cfg.provider.as_str() {
        "openai-compat" | "anthropic" => Ok(provider_for(cfg)),
        "custom" => {
            if cfg.custom_config.is_some() {
                Ok(provider_for(cfg))
            } else {
                Err("自定义模式缺少 JSON 配置（设置页填写后保存）".to_string())
            }
        }
        other => Err(format!("未知的 AI 提供商: {other}")),
    }
}

// ===================== Tauri commands =====================

/// 连接测试：发一条最小请求（"ping"），返回可达性与耗时（设置页「测试连接」按钮）
#[tauri::command]
pub async fn ai_test_connection(
    app: tauri::AppHandle,
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    custom_config: Option<String>,
) -> Result<AiTestResult, String> {
    let cfg = AiConfig { provider, base_url, api_key, model, custom_config };
    let p = provider_for_err(&cfg)?;
    let started = Instant::now();
    match p
        .complete(&cfg, "You are a connectivity test.", "ping", &app)
        .await
    {
        Ok(_) => Ok(AiTestResult { ok: true, latency_ms: started.elapsed().as_millis() as u64, error: None }),
        Err(e) => Ok(AiTestResult { ok: false, latency_ms: started.elapsed().as_millis() as u64, error: Some(e) }),
    }
}

/// 内容加工：system 为模板指令（模板 {ai:指令} 占位符或默认指令），content 为剪贴板原文
#[tauri::command]
pub async fn ai_complete(
    app: tauri::AppHandle,
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
    system: String,
    content: String,
    custom_config: Option<String>,
) -> Result<String, String> {
    let cfg = AiConfig { provider, base_url, api_key, model, custom_config };
    provider_for_err(&cfg)?
        .complete(&cfg, &system, &content, &app)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_url_trims_trailing_slash() {
        assert_eq!(
            normalize_base_url("https://api.example.com/v1/", "https://default"),
            "https://api.example.com/v1"
        );
        // 多个尾斜杠全部去除
        assert_eq!(
            normalize_base_url("https://api.example.com/v1///", "https://default"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn normalize_base_url_keeps_clean_url() {
        assert_eq!(
            normalize_base_url("https://api.openai.com/v1", "https://default"),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn normalize_base_url_trims_whitespace() {
        assert_eq!(
            normalize_base_url("  https://api.example.com  ", "https://default"),
            "https://api.example.com"
        );
    }

    #[test]
    fn normalize_base_url_empty_falls_back_to_default() {
        assert_eq!(normalize_base_url("", "https://fallback"), "https://fallback");
        assert_eq!(normalize_base_url("   ", "https://fallback"), "https://fallback");
        assert_eq!(normalize_base_url("/", "https://fallback"), "https://fallback");
    }
}
