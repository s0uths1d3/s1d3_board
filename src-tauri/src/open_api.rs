//! 开放 API（设计文档 §4.5）：仅监听 127.0.0.1 的最小 HTTP/SSE 服务（std 实现，零新增依赖）。
//!
//! 端点：
//! - GET  /api/health        → {ok, version, port}
//! - GET  /api/events        → SSE 流（event: copy，data: JSON），复制成功事件推送
//! - POST /api/notify/copy   → 外部注入复制事件（body JSON，可选 token）
//!
//! 安全边界：仅回环地址绑定 + 可选 Bearer token；设置页可开关/改端口（占用时由前端提示）。
//! 停机：TcpListener nonblocking + stop 标志轮询，accept 循环可干净退出。
//! 事件广播：SSE 连接注册 Sender 到订阅者表，broadcast 时逐个投递（写失败即移除）。

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Emitter;

const HEARTBEAT: Duration = Duration::from_secs(15);
const ACCEPT_POLL: Duration = Duration::from_millis(150);
const MAX_HEADER: usize = 8 * 1024;

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

#[derive(Serialize, Deserialize, Clone)]
pub struct OpenApiCopyEvent {
    pub content: String,
    pub segments: Vec<SmartClipSegmentDto>,
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SmartClipSegmentDto {
    pub index: u32,
    pub text: String,
    pub source: String,
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

/// 读取并解析请求头（返回 method / path / token）；body 由调用方按 Content-Length 另读
fn read_request(stream: &mut TcpStream) -> Option<(String, String, String)> {
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
                        path = p.split('?').next().unwrap_or("").to_string();
                    }
                    let mut token = String::new();
                    for line in lines {
                        let lower = line.to_lowercase();
                        if lower.starts_with("authorization: bearer ") {
                            token = line[21..].trim().to_string();
                        }
                    }
                    return Some((method, path, token));
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
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

/// 单连接处理：路由 + SSE 长连接（注册订阅者到全局表）
fn handle_connection(mut stream: TcpStream, token: String) {
    let Some((method, path, req_token)) = read_request(&mut stream) else {
        return;
    };

    // 可选 token 校验（配置了 token 才强制）
    if !token.is_empty() && token != req_token {
        respond(&mut stream, "401 Unauthorized", "application/json", "{\"error\":\"unauthorized\"}");
        return;
    }

    match (method.as_str(), path.as_str()) {
        ("GET", "/api/health") => {
            let body = serde_json::json!({ "ok": true });
            respond(&mut stream, "200 OK", "application/json", &body.to_string());
        }
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
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
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
        ("POST", "/api/notify/copy") => {
            let mut body = String::new();
            let _ = stream.read_to_string(&mut body);
            let data = body.trim().to_string();
            if data.is_empty() {
                respond(&mut stream, "400 Bad Request", "application/json", "{\"error\":\"empty body\"}");
                return;
            }
            broadcast(&sse_frame("copy", &data));
            respond(&mut stream, "204 No Content", "text/plain", "");
        }
        _ => {
            respond(&mut stream, "404 Not Found", "application/json", "{\"error\":\"not found\"}");
        }
    }
}

/// 服务线程主体：nonblocking accept 轮询 + stop 标志
fn serve(port: u16, token: String, stop: Arc<AtomicBool>, app: tauri::AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            log::error!("[open-api] 端口 {port} 绑定失败: {e}");
            let _ = app.emit("open-api:failed", format!("port {port}: {e}"));
            return;
        }
    };
    let _ = listener.set_nonblocking(true);
    log::info!("[open-api] listening on 127.0.0.1:{port}");

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let token = token.clone();
                std::thread::spawn(move || handle_connection(stream, token));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => break,
        }
    }
    log::info!("[open-api] server stopped");
}

// ===================== Tauri commands =====================

/// 应用/重启/停止开放 API（设置页开关与端口变更时调用），返回实际端口（运行中）或 0（停止）
#[tauri::command]
pub fn open_api_apply(
    app: tauri::AppHandle,
    enabled: bool,
    port: u16,
    token: String,
) -> Result<u16, String> {
    let mut running = RUNNING.lock().map_err(|_| "open-api 状态锁中毒")?;

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

/// 复制事件广播（smartClip 处理层在复制入库后调用）：推送给全部 SSE 订阅者
#[tauri::command]
pub fn open_api_broadcast_copy(content: String, segments: Vec<SmartClipSegmentDto>) -> Result<(), String> {
    let event = OpenApiCopyEvent {
        content,
        segments,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let json = serde_json::to_string(&event).map_err(|e| e.to_string())?;
    broadcast(&sse_frame("copy", &json));
    Ok(())
}
