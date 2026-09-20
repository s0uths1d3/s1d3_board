//! 灵动岛 API（文档：`.docs/island-api.md`）：仅监听 127.0.0.1 的最小 HTTP/SSE 服务（std 实现，零新增依赖）。
//!
//! 端点（API v1.2.0）：
//! - GET  /api/health       → {ok, data:{version, port}}
//! - POST /api/island/show  → 第三方应用推送灵动岛显示请求（body JSON，可选 Bearer token）
//! - GET  /api/history      → 查询灵动岛历史（?limit=&kind=&from=&to=，DB 归属前端主窗口，
//!                           Rust 挂起等待 ≤3s，经 island_history_request/result 往返）
//! - GET  /api/events       → SSE 流（event: island.show）——全量岛显示事件（应用自身 + 第三方）
//!
//! 安全边界：仅回环地址绑定 + 可选 Bearer token + CORS 允许任意来源（网页可订阅事件流/调用，
//! token 为唯一防线）；设置页可开关/改端口。
//! 数据流：POST 校验通过 → emit("island-api:show") 交前端灵动岛管理器；前端实际弹岛时
//! emit("island:show") → attach_event_bridge 桥接 → SSE 广播。SSE 单点广播 = 实际显示事件，
//! 应用自身与第三方事件天然去重（延迟合并/总开关拦截的事件不上 SSE）。
//! history 查询：HTTP 线程挂起（HISTORY_PENDING 通道），emit island_history_request（含 requestId
//! + query），主窗口前端查 tauri-plugin-sql 后 emit island_history_result，HTTP 线程唤醒并回包；
//! 3s 未回即超时 504。应用未开主窗口/前端未挂监听时回 503。
//! 停机：TcpListener nonblocking + stop 标志轮询，accept 循环可干净退出。
//! 事件广播：SSE 连接注册 Sender 到订阅者表，broadcast 时逐个投递（写失败即移除）。

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Listener};

/// API 版本（语义化版本；随 `.docs/island-api.md` 更新日志同步）
pub const API_VERSION: &str = "1.2.0";

const HEARTBEAT: Duration = Duration::from_secs(15);
const ACCEPT_POLL: Duration = Duration::from_millis(150);
const MAX_HEADER: usize = 8 * 1024;
/// 文本内容长度上限（超出返回 422 text_too_long）
const MAX_TEXT: usize = 2000;

/// 请求体上限：text ≤2000 字符（UTF-8 最多 3 字节/字符）+ JSON 结构，64KB 宽裕封顶
const MAX_BODY: usize = 64 * 1024;
/// 自定义标题长度上限（胶囊空间有限，服务端截断到 24 字符）
const MAX_TITLE_CHARS: usize = 24;
/// 合法的 kind 取值（与前端 IslandKind 子集一致，默认 info）
const KINDS: [&str; 5] = ["info", "success", "error", "copy", "paste"];

/// SSE 订阅者表：每连接一个 channel sender（事件文本直接投递）
static SUBSCRIBERS: std::sync::LazyLock<Mutex<Vec<Sender<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// 运行中的服务句柄（stop 标志 + 工作线程）
struct RunningServer {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

static RUNNING: std::sync::LazyLock<Mutex<Option<RunningServer>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// GET /api/history 挂起请求表：requestId → 结果回传通道（前端查库后经 island_history_result 命中）
static HISTORY_PENDING: std::sync::LazyLock<Mutex<std::collections::HashMap<String, std::sync::mpsc::Sender<String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
static HISTORY_SEQ: AtomicU64 = AtomicU64::new(0);

/// POST /api/island/show 请求体（priority 为 v1 预留字段：接收但不处理，向前兼容）
#[derive(Deserialize)]
struct IslandShowRequest {
    text: String,
    kind: Option<String>,
    title: Option<String>,
    duration: Option<u64>,
    #[allow(dead_code)]
    priority: Option<String>,
}

/// 广播给前端与 SSE 订阅者的显示事件（duration=0 表示使用应用内默认停留时长）
#[derive(Serialize, Clone)]
struct IslandShowEvent {
    text: String,
    kind: String,
    title: Option<String>,
    duration: u64,
    ts: u64,
}

/// 统一错误响应体：{"ok":false,"error":{"code","message"}}
fn error_body(code: &str, message: &str) -> String {
    serde_json::json!({ "ok": false, "error": { "code": code, "message": message } }).to_string()
}

/// 广播文本到全部 SSE 订阅者（写失败者移除）
fn broadcast(data: &str) {
    let mut subs = match SUBSCRIBERS.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    subs.retain(|tx| tx.send(data.to_string()).is_ok());
}

fn sse_frame(event: &str, data: &str) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// SSE 连接读循环：channel → 响应流；空闲发心跳保活
struct SseReader {
    rx: Receiver<String>,
    buf: Vec<u8>,
}

impl Read for SseReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.buf.is_empty() {
            // 阻塞等下一条数据（心跳由独立线程向同一 channel 投递，见 SSE 分支）；
            // 不做错误类型匹配：std mpsc 在新版本 Rust 由 mpmc 重实现，错误类型路径会漂移
            match self.rx.recv() {
                Ok(data) => self.buf.extend_from_slice(data.as_bytes()),
                Err(_) => return Ok(0), // 服务关闭：结束连接
            }
        }
        let n = std::cmp::min(buf.len(), self.buf.len());
        buf[..n].copy_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        Ok(n)
    }
}

/// 读取并解析请求头（返回 method / path / token / content-length / header 之后的剩余字节）。
/// 必须返回 leftover：单次 read 常把同一段 TCP 里的 header+body 一起读入缓冲，丢弃会导致
/// 调用方按 Content-Length 再读时永远等不到数据（挂死）。
fn read_request(stream: &mut TcpStream) -> Option<(String, String, String, usize, Vec<u8>)> {
    let mut buf = vec![0u8; MAX_HEADER];
    let mut read_total = 0usize;
    loop {
        match stream.read(&mut buf[read_total..]) {
            Ok(0) => return None,
            Ok(n) => {
                read_total += n;
                let head = String::from_utf8_lossy(&buf[..read_total]).to_string();
                if let Some(end) = head.find("\r\n\r\n") {
                    let head_part = &head[..end];
                    let mut lines = head_part.lines();
                    let request_line = lines.next()?.to_string();
                    let mut method = String::new();
                    let mut path = String::new();
                    if let Some((m, p)) = request_line.split_once(' ') {
                        method = m.to_string();
                        // 请求行三段式：METHOD SP PATH SP HTTP/x.x——PATH 去协议段；query 保留
                        //（/api/history 需要，其余端点忽略）
                        let raw_path = p.split(' ').next().unwrap_or("");
                        path = raw_path.to_string();
                    }
                    let mut token = String::new();
                    let mut content_length = 0usize;
                    for line in lines {
                        let lower = line.to_lowercase();
                        if lower.starts_with("content-length:") {
                            content_length = line["content-length:".len()..].trim().parse().unwrap_or(0);
                        } else if lower.starts_with("authorization: bearer ") {
                            token = line["authorization: bearer ".len()..].trim().to_string();
                        }
                    }
                    return Some((method, path, token, content_length, buf[end + 4..read_total].to_vec()));
                }
                if read_total >= MAX_HEADER {
                    return None;
                }
            }
            Err(_) => return None,
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// POST /api/island/show：校验 → emit 前端（SSE 广播由 event bridge 在实际显示时发出）
/// body 按 Content-Length 精确读取——read_to_string 会等到对端关闭写端（EOF），而
/// curl/fetch/浏览器发完 body 后保持连接等响应，必然挂死（v1.0~v1.1 实际不可用的真因）
fn handle_island_show(
    stream: &mut TcpStream,
    app: &tauri::AppHandle,
    content_length: usize,
    leftover: Vec<u8>,
) {
    if content_length > MAX_BODY {
        respond(stream, "400 Bad Request", "application/json",
                &error_body("invalid_json", "request body too large"));
        return;
    }
    // 先用 header 读取时顺带收到的剩余字节，不足部分再从 socket 精确补读
    let mut body_bytes = leftover;
    body_bytes.truncate(content_length);
    if body_bytes.len() < content_length {
        let mut rest = vec![0u8; content_length - body_bytes.len()];
        if stream.read_exact(&mut rest).is_err() {
            respond(stream, "400 Bad Request", "application/json",
                    &error_body("invalid_json", "request body truncated"));
            return;
        }
        body_bytes.extend_from_slice(&rest);
    }
    let body = String::from_utf8_lossy(&body_bytes).to_string();
    let req: IslandShowRequest = match serde_json::from_str(body.trim()) {
        Ok(r) => r,
        Err(e) => {
            respond(stream, "400 Bad Request", "application/json",
                    &error_body("invalid_json", &format!("request body is not valid JSON: {e}")));
            return;
        }
    };
    if req.text.is_empty() {
        respond(stream, "400 Bad Request", "application/json",
                &error_body("empty_text", "field 'text' is required and must not be empty"));
        return;
    }
    if req.text.chars().count() > MAX_TEXT {
        respond(stream, "422 Unprocessable Entity", "application/json",
                &error_body("text_too_long", &format!("field 'text' exceeds {MAX_TEXT} characters")));
        return;
    }
    let kind = match req.kind.as_deref() {
        None | Some("") => "info".to_string(),
        Some(k) if KINDS.contains(&k) => k.to_string(),
        Some(_) => {
            respond(stream, "422 Unprocessable Entity", "application/json",
                    &error_body("invalid_kind", &format!("field 'kind' must be one of: {}", KINDS.join(", "))));
            return;
        }
    };
    // title：trim 后非空才生效，超长截断到 24 字符（宽容策略，见文档「参数说明」）
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(MAX_TITLE_CHARS).collect::<String>());

    let event = IslandShowEvent {
        text: req.text,
        kind,
        title,
        duration: req.duration.unwrap_or(0),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    // 交前端灵动岛管理器弹岛；SSE 广播由 event bridge 在实际显示时单点发出（此处不直接广播，
    // 保证应用自身与第三方事件同源、延迟合并/总开关拦截的事件不产生幽灵广播）
    let _ = app.emit("island-api:show", &event);
    respond(stream, "204 No Content", "application/json", "");
}

/// 应用内岛事件 → SSE 出站桥：前端每次**实际弹岛**都会 emit("island:show")（应用自身复制/粘贴/
/// 提醒/操作反馈与第三方 API 事件统一汇聚点），转成 island.show SSE 广播。
/// 与 API 开关无关常驻（无订阅者时 broadcast 零开销）；API 停止时订阅表已清，同样无副作用。
pub fn attach_event_bridge(app: &tauri::AppHandle) {
    app.listen("island:show", move |ev| {
        let Ok(p) = serde_json::from_str::<serde_json::Value>(ev.payload()) else {
            return;
        };
        // 前端字段 durationMs → SSE 字段 duration；ts 为桥接时刻的服务端时间戳
        let event = serde_json::json!({
            "text": p.get("text").cloned().unwrap_or(serde_json::Value::Null),
            "kind": p.get("kind").cloned().unwrap_or(serde_json::json!("info")),
            "title": p.get("title").cloned().unwrap_or(serde_json::Value::Null),
            "duration": p.get("durationMs").and_then(|v| v.as_u64()).unwrap_or(0),
            "ts": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        });
        // 出站双通道：SSE 广播 + Webhook 投递（后者内部 spawn，不阻塞）
        crate::island_webhook::dispatch(&event);
        broadcast(&sse_frame("island.show", &event.to_string()));
    });
}

/// GET /api/history?limit=&kind=&from=&to=：查询灵动岛历史。
/// DB 归属前端（tauri-plugin-sql 连接在主窗口 webview），Rust 不直连数据库——
/// 挂起 HTTP 线程，emit island_history_request（requestId + 原始 query）交主窗口查询，
/// 前端经 island_history_result 命令回传完整 JSON 信封，此处原样回包。
/// query 参数语义（limit/kind/from/to）由前端解析执行；from/to 为本地毫秒时间戳。
fn handle_history(stream: &mut TcpStream, app: &tauri::AppHandle, path: &str) {
    let query = path.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
    let request_id = format!(
        "hq_{}_{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
        HISTORY_SEQ.fetch_add(1, Ordering::Relaxed),
    );
    let (tx, rx): (_, Receiver<String>) = channel();
    if let Ok(mut map) = HISTORY_PENDING.lock() {
        map.insert(request_id.clone(), tx);
    }
    let _ = app.emit(
        "island-history:query",
        serde_json::json!({ "requestId": request_id, "query": query }),
    );
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(payload) => respond(stream, "200 OK", "application/json", &payload),
        Err(_) => {
            // 超时清理挂起表；前端迟到结果由 island_history_result 侧查无此 id 自然丢弃
            if let Ok(mut map) = HISTORY_PENDING.lock() {
                map.remove(&request_id);
            }
            respond(stream, "503 Service Unavailable", "application/json",
                    &error_body("history_unavailable", "history provider did not respond in time (main window unavailable?)"));
        }
    }
}

/// 前端回传查询结果（lib.rs 注册的 command）：requestId 命中挂起表则唤醒 HTTP 线程
pub fn resolve_history(request_id: String, payload: String) -> bool {
    let tx = match HISTORY_PENDING.lock() {
        Ok(mut map) => map.remove(&request_id),
        Err(_) => None,
    };
    match tx {
        Some(tx) => tx.send(payload).is_ok(),
        None => false, // 超时已清理：迟到结果静默丢弃
    }
}

/// 单连接处理：路由 + SSE 长连接（注册订阅者到全局表）
fn handle_connection(mut stream: TcpStream, token: String, app: tauri::AppHandle) {
    let Some((method, path, req_token, content_length, leftover)) = read_request(&mut stream) else {
        return;
    };

    // CORS 预检：浏览器 preflight 不携带 Authorization，必须在 token 校验之前响应
    if method == "OPTIONS" {
        let head = "HTTP/1.1 204 No Content\r\n\
                    Access-Control-Allow-Origin: *\r\n\
                    Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                    Access-Control-Allow-Headers: Content-Type, Authorization\r\n\
                    Access-Control-Max-Age: 600\r\n\r\n";
        let _ = stream.write_all(head.as_bytes());
        return;
    }

    // 可选 token 校验（配置了 token 才强制）
    if !token.is_empty() && token != req_token {
        respond(&mut stream, "401 Unauthorized", "application/json",
                &error_body("unauthorized", "missing or invalid bearer token"));
        return;
    }

    // 路由匹配用去 query 的路径（/api/history 在 handler 内自行取 query）
    let path_only = path.split('?').next().unwrap_or("").to_string();
    match (method.as_str(), path_only.as_str()) {
        ("GET", "/api/health") => {
            let body = serde_json::json!({ "ok": true, "data": { "version": API_VERSION, "port": CURRENT_PORT.load(Ordering::Relaxed) } });
            respond(&mut stream, "200 OK", "application/json", &body.to_string());
        }
        ("GET", "/api/history") => handle_history(&mut stream, &app, &path),
        ("GET", "/api/events") => {
            let (tx, rx) = channel::<String>();
            if let Ok(mut list) = SUBSCRIBERS.lock() {
                list.push(tx.clone());
            }
            // 心跳线程：空闲时向同一 channel 投递 ping，保活并探测断连（send 失败线程自退）
            let hb = tx.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(HEARTBEAT);
                if hb.send(": ping\n\n".to_string()).is_err() {
                    break;
                }
            });
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            let _ = stream.flush();
            let mut reader = SseReader { rx, buf: Vec::new() };
            // 流式转发：EOF（服务关闭）/ 写失败（客户端断开）即退出；断开的订阅者由 broadcast retain 清理
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stream.write_all(&buf[..n]).is_err() || stream.flush().is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        ("POST", "/api/island/show") => handle_island_show(&mut stream, &app, content_length, leftover),
        ("GET", "/api/island/show") | ("POST", "/api/health") | ("POST", "/api/events") | ("POST", "/api/history") => {
            respond(&mut stream, "405 Method Not Allowed", "application/json",
                    &error_body("method_not_allowed", "HTTP method not allowed for this endpoint"));
        }
        _ => {
            respond(&mut stream, "404 Not Found", "application/json",
                    &error_body("not_found", "unknown endpoint, see .docs/island-api.md"));
        }
    }
}

/// 当前监听端口（serve 启动时写入，停止时清零；health 回显用）
static CURRENT_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// 服务线程主体：nonblocking accept 轮询 + stop 标志
fn serve(port: u16, token: String, stop: Arc<AtomicBool>, app: tauri::AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            log::error!("[island-api] 端口 {port} 绑定失败: {e}");
            let _ = app.emit("island-api:failed", format!("port {port}: {e}"));
            return;
        }
    };
    let _ = listener.set_nonblocking(true);
    CURRENT_PORT.store(port, Ordering::Relaxed);
    log::info!("[island-api] listening on 127.0.0.1:{port}");

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let token = token.clone();
                let app = app.clone();
                std::thread::spawn(move || handle_connection(stream, token, app));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => break,
        }
    }
    CURRENT_PORT.store(0, Ordering::Relaxed);
    log::info!("[island-api] server stopped");
}

// ===================== Tauri commands =====================

/// 前端回传查询结果（island_history_result 命令）：requestId 命中挂起表则唤醒 HTTP 线程；
/// 未命中（已超时清理/无效 id）返回 false，前端无需处理
#[tauri::command]
pub fn island_history_result(request_id: String, payload: String) -> bool {
    resolve_history(request_id, payload)
}

/// 应用/重启/停止灵动岛 API（设置页开关与端口变更时调用），返回实际端口（运行中）或 0（停止）
#[tauri::command]
pub fn island_api_apply(
    app: tauri::AppHandle,
    enabled: bool,
    port: u16,
    token: String,
) -> Result<u16, String> {
    let mut running = RUNNING.lock().map_err(|_| "island-api 状态锁中毒")?;

    // 配置变化一律先停旧实例（stop 标志 + join）
    if let Some(old) = running.take() {
        old.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = old.thread {
            let _ = handle.join();
        }
    }
    if !enabled {
        if let Ok(mut list) = SUBSCRIBERS.lock() {
            list.clear();
        }
        return Ok(0);
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let app2 = app.clone();
    if let Ok(mut list) = SUBSCRIBERS.lock() {
        list.clear(); // 重启时清空旧订阅者
    }
    let handle = std::thread::spawn(move || serve(port, token, stop2, app2));
    *running = Some(RunningServer { stop, thread: Some(handle) });
    Ok(port)
}
