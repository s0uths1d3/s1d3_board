//! 灵动岛 Webhook 出站推送（文档：`.docs/island-api.md` §7）：
//! 应用内灵动岛显示事件（经 island_api::attach_event_bridge 桥接）实时 POST 到用户配置的外部 URL，
//! 把 S1d3 Board 事件接入 n8n / 自建服务 / 飞书钉钉机器人等无法维持 SSE 长连接的接收端。
//!
//! 数据流：island:show（前端岛事件统一汇聚点）→ bridge → dispatch(event) → 对每个启用目标
//! spawn 异步交付任务（POST + HMAC 签名 + 指数退避重试），不阻塞 bridge/SSE 链路。
//!
//! 可靠性语义（按文档约定）：
//! - 单次投递超时 5s；失败指数退避重试 1s/4s/16s（初次 + 3 次重试，最多 4 次尝试）
//! - 连续 5 轮交付全败 → 熔断该目标 5 分钟（内存态，重启清零；期间静默跳过）
//! - URL 白名单：https 任意主机；http 仅回环（127.0.0.1 / localhost / [::1]）
//! - 签名：secret 非空时附 `X-S1d3-Signature: HMAC-SHA256(body, secret)`（hex 小写），
//!   接收端以原始 body 验签防伪造
//!
//! 配置来源：前端设置页持久化（settings 表 island_webhook_config），变更/启动时经
//! island_webhook_apply 下发到本模块内存态；本模块不做持久化，与 island_api_apply 模式一致。

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 单条投递超时
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);
/// 重试退避间隔（初次失败后依序重试）
const RETRY_DELAYS: [u64; 3] = [1, 4, 16];
/// 连续全败轮数达到该值 → 熔断
const FAIL_STREAK_BREAKER: u32 = 5;
/// 熔断时长
const BREAKER_COOLDOWN: Duration = Duration::from_secs(300);

// ===================== 配置模型 =====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTarget {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub secret: String,
    /// 订阅的事件类型；含 "all" 或精确匹配。当前仅 "island.show"，字段为多事件预留
    #[serde(default = "default_events")]
    pub events: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct WebhookConfig {
    pub enabled: bool,
    #[serde(default)]
    pub targets: Vec<WebhookTarget>,
}

fn default_events() -> Vec<String> {
    vec!["island.show".to_string()]
}
fn default_true() -> bool {
    true
}

// ===================== 运行时状态（内存态） =====================

#[derive(Default)]
struct TargetState {
    /// 连续交付全败轮数（成功即清零）
    fail_streak: u32,
    /// 熔断截止时刻（epoch ms；0 = 未熔断）
    muted_until: u64,
}

/// 当前生效配置 + 各目标熔断状态
struct WebhookState {
    enabled: bool,
    targets: Vec<WebhookTarget>,
    states: HashMap<String, TargetState>,
}

static STATE: OnceLock<Mutex<WebhookState>> = OnceLock::new();

fn state() -> &'static Mutex<WebhookState> {
    STATE.get_or_init(|| {
        Mutex::new(WebhookState { enabled: false, targets: Vec::new(), states: HashMap::new() })
    })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// HTTP 客户端（全局复用连接池；超时统一 5s）
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(DELIVERY_TIMEOUT)
            .build()
            .expect("failed to build webhook http client")
    })
}

// ===================== URL 校验 =====================

/// https 任意主机；http 仅回环（127.0.0.1 / localhost / [::1]）；其余拒绝
pub fn validate_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("URL 无法解析: {e}"))?;
    match parsed.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
            if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1") {
                Ok(())
            } else {
                Err("http 仅允许本机回环地址（127.0.0.1 / localhost / [::1]），远程接收端请使用 https".to_string())
            }
        }
        _ => Err("仅支持 http(s) 协议".to_string()),
    }
}

// ===================== 签名 =====================

/// HMAC-SHA256(body, secret) → hex 小写；secret 为空返回 None（不带签名头）
fn sign(body: &str, secret: &str) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(body.as_bytes());
    Some(mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect())
}

// ===================== 分发 =====================

/// 出站事件入口：bridge（实际弹岛）与测试命令共同调用。
/// 快速返回：快照目标列表后逐个 spawn 异步交付，绝不阻塞调用方（岛/SSE 链路）。
pub fn dispatch(event: &serde_json::Value) {
    let snapshot: Vec<WebhookTarget> = {
        let Ok(st) = state().lock() else { return };
        if !st.enabled {
            return;
        }
        let now = now_ms();
        st.targets
            .iter()
            .filter(|t| t.enabled && t.events.iter().any(|e| e == "all" || e == "island.show"))
            .filter(|t| {
                // 熔断中的目标静默跳过（顺带在锁内读取，减少二次加锁）
                st.states.get(&t.id).map(|s| now >= s.muted_until).unwrap_or(true)
            })
            .cloned()
            .collect()
    };
    for target in snapshot {
        let event = event.clone();
        tauri::async_runtime::spawn(async move {
            deliver_with_retry(target, &event).await;
        });
    }
}

/// 单目标交付：初次 + 指数退避重试（1s/4s/16s）；更新熔断计数
async fn deliver_with_retry(target: WebhookTarget, event: &serde_json::Value) {
    let body = event.to_string();
    let mut last_err = String::new();
    for attempt in 0..=RETRY_DELAYS.len() {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(RETRY_DELAYS[attempt - 1])).await;
        }
        match attempt_deliver(&target, &body).await {
            Ok(()) => {
                mark_result(&target.id, true);
                return;
            }
            Err(e) => last_err = e,
        }
    }
    log::warn!("[island-webhook] 目标 {} 投递失败（含全部重试）: {last_err}", target.id);
    mark_result(&target.id, false);
}

/// 单次 POST；2xx 视为成功
async fn attempt_deliver(target: &WebhookTarget, body: &str) -> Result<(), String> {
    let mut req = client()
        .post(&target.url)
        .header("Content-Type", "application/json")
        .header("X-S1d3-Event", "island.show")
        .header("User-Agent", concat!("S1d3Board-Webhook/", env!("CARGO_PKG_VERSION")));
    if let Some(sig) = sign(body, &target.secret) {
        req = req.header("X-S1d3-Signature", sig);
    }
    let resp = req.body(body.to_owned()).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("HTTP {status}"))
    }
}

/// 熔断计数：成功清零；全败累加，达到阈值进入 5 分钟冷却
fn mark_result(id: &str, ok: bool) {
    if let Ok(mut st) = state().lock() {
        let s = st.states.entry(id.to_string()).or_default();
        if ok {
            s.fail_streak = 0;
            s.muted_until = 0;
        } else {
            s.fail_streak += 1;
            if s.fail_streak >= FAIL_STREAK_BREAKER {
                s.muted_until = now_ms() + BREAKER_COOLDOWN.as_millis() as u64;
                s.fail_streak = 0;
                log::warn!("[island-webhook] 目标 {id} 连续失败触发熔断 {} 分钟", BREAKER_COOLDOWN.as_secs() / 60);
            }
        }
    }
}

// ===================== Tauri commands =====================

/// 应用 Webhook 配置（设置页变更/启动恢复时调用）：URL 校验 + 替换内存态
#[tauri::command]
pub fn island_webhook_apply(config: String) -> Result<(), String> {
    let cfg: WebhookConfig =
        serde_json::from_str(&config).map_err(|e| format!("Webhook 配置解析失败: {e}"))?;
    for t in &cfg.targets {
        validate_url(&t.url).map_err(|e| format!("目标 {}：{e}", t.id))?;
    }
    if let Ok(mut st) = state().lock() {
        st.enabled = cfg.enabled;
        st.targets = cfg.targets;
        // 保留仍存在目标的熔断状态，移除的随手清理
        let ids: Vec<String> = st.targets.iter().map(|t| t.id.clone()).collect();
        st.states.retain(|id, _| ids.contains(id));
    }
    Ok(())
}

/// 测试全部启用目标：单次投递（3s 超时、不重试、不走熔断），返回每条结果供设置页展示
#[tauri::command]
pub async fn island_webhook_test() -> Result<Vec<TestResult>, String> {
    let snapshot: Vec<WebhookTarget> = {
        let Ok(st) = state().lock() else { return Ok(Vec::new()) };
        if !st.enabled {
            return Err("Webhook 出站推送未启用".to_string());
        }
        st.targets.iter().filter(|t| t.enabled).cloned().collect()
    };
    if snapshot.is_empty() {
        return Err("没有启用的 Webhook 目标".to_string());
    }
    let event = serde_json::json!({
        "text": "这是一条来自 S1d3 Board 的 Webhook 测试消息",
        "kind": "info",
        "title": "Webhook",
        "duration": 0,
        "ts": now_ms(),
    });
    let body = event.to_string();
    let mut results = Vec::new();
    for t in &snapshot {
        let test_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = test_client
            .post(&t.url)
            .header("Content-Type", "application/json")
            .header("X-S1d3-Event", "island.show");
        if let Some(sig) = sign(&body, &t.secret) {
            req = req.header("X-S1d3-Signature", sig);
        }
        let (ok, error) = match req.body(body.clone()).send().await {
            Ok(resp) if resp.status().is_success() => (true, String::new()),
            Ok(resp) => (false, format!("HTTP {}", resp.status())),
            Err(e) => (false, e.to_string()),
        };
        results.push(TestResult { id: t.id.clone(), ok, error });
    }
    Ok(results)
}

#[derive(Serialize)]
pub struct TestResult {
    pub id: String,
    pub ok: bool,
    pub error: String,
}
