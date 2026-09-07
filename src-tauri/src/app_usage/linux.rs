//! Linux (X11) 平台实现：根窗口 _NET_ACTIVE_WINDOW 的 PropertyNotify 监听
//! （零 CPU 阻塞等待）+ XScreenSaver 空闲查询 + 桌面入口/hicolor 图标查找。
//! Wayland 无统一前台窗口协议，暂不支持（connect 失败时按不支持处理）。

#[cfg(target_os = "linux")]
use super::{state, encode_data_url, Sample};
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ChangeWindowAttributesAux, ConnectionExt, EventMask};
/// X11 前台切换监听：根窗口 _NET_ACTIVE_WINDOW 的 PropertyNotify 事件
/// （wait_for_event 阻塞等待，无切换时零 CPU）。Wayland（无 DISPLAY）线程直接退出。
pub fn start() {
std::thread::spawn(|| loop {
    match listen() {
        Ok(()) => return, // 连接正常关闭（罕见）
        Err(e) => {
            log::warn!("[app_usage] X11 监听断开，30s 后重连: {e}");
            std::thread::sleep(Duration::from_secs(30));
        }
    }
});
}
fn listen() -> Result<(), Box<dyn std::error::Error>> {
let (conn, screen_num) = x11rb::connect(None)?;
let root = conn.setup().roots.get(screen_num).map(|r| r.root).ok_or("无屏幕")?;
let net_active_atom = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW")?.reply()?.atom;
let net_wm_pid_atom = conn.intern_atom(false, b"_NET_WM_PID")?.reply()?.atom;
conn.change_window_attributes(
    root,
    &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE_MASK),
)?
.check()?;
conn.flush()?;
loop {
    match conn.wait_for_event()? {
        x11rb::protocol::Event::PropertyNotify(ev)
            if ev.window == root && ev.atom == net_active_atom =>
        {
            if let Some(sample) =
                active_window_sample(&conn, root, net_active_atom, net_wm_pid_atom)
            {
                state().on_switch(sample);
            }
        }
        _ => {}
    }
}
}
/// 当前活跃窗口 → _NET_WM_PID → /proc/{pid}/comm 进程名 + 桌面入口图标；失败归入 "system" 桶
fn active_window_sample<C: Connection>(
conn: &C,
root: u32,
net_active_atom: u32,
net_wm_pid_atom: u32,
) -> Option<Sample> {
let reply = conn
    .get_property(false, root, net_active_atom, AtomEnum::WINDOW, 0, 1)
    .ok()?
    .reply()
    .ok()?;
if reply.value_len != 1 || reply.value.len() < 4 {
    return None;
}
let win = u32::from_ne_bytes([
    reply.value[0],
    reply.value[1],
    reply.value[2],
    reply.value[3],
]);
if win == 0 {
    return None;
}
let pid_reply = conn
    .get_property(false, win, net_wm_pid_atom, AtomEnum::CARDINAL, 0, 1)
    .ok()?
    .reply()
    .ok()?;
if pid_reply.value_len == 0 || pid_reply.value.len() < 4 {
    return Some(Sample { name: "system".to_string(), icon: None });
}
let pid = u32::from_ne_bytes([
    pid_reply.value[0],
    pid_reply.value[1],
    pid_reply.value[2],
    pid_reply.value[3],
]);
let name = std::fs::read_to_string(format!("/proc/{pid}/comm"))
    .map(|s| s.trim().to_lowercase())
    .unwrap_or_else(|_| "system".to_string());
let name = if name.is_empty() { "system".to_string() } else { name };
let icon = linux_icon::icon_data_url_of_app(&name);
Some(Sample { name, icon })
}
pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
let (conn, screen_num) = x11rb::connect(None).ok()?;
let root = conn.setup().roots.get(screen_num)?.root;
let net_active_atom = conn
    .intern_atom(false, b"_NET_ACTIVE_WINDOW")
    .ok()?
    .reply()
    .ok()?
    .atom;
let net_wm_pid_atom = conn
    .intern_atom(false, b"_NET_WM_PID")
    .ok()?
    .reply()
    .ok()?
    .atom;
active_window_sample(&conn, root, net_active_atom, net_wm_pid_atom)
}
pub fn idle_secs() -> u64 {
// XScreenSaver 扩展：ms_since_user_input 为距上次输入的毫秒数；
// 扩展不可用（Wayland 等）时按 0 处理（全算活跃）
let Ok((conn, screen_num)) = x11rb::connect(None) else {
    return 0;
};
let Some(root) = conn.setup().roots.get(screen_num).map(|r| r.root) else {
    return 0;
};
match x11rb::protocol::screensaver::query_info(&conn, root) {
    Ok(cookie) => match cookie.reply() {
        Ok(reply) => (reply.ms_since_user_input as u64) / 1000,
        Err(_) => 0,
    },
    Err(_) => 0,
}
}

mod linux_icon {
use base64::Engine;
use std::io::Cursor;
use std::path::PathBuf;

const APP_DIRS: &[&str] = &["/usr/share/applications", "/usr/local/share/applications"];

/// 按应用名查桌面入口图标并转为 PNG data URL（尽力而为，找不到返回 None）：
/// 1) {app}.desktop；2) 扫描 .desktop 的 StartupWMClass/Exec 含应用名 → Icon=
/// 3) Icon 为绝对路径直接解码，否则在 hicolor 主题的 apps 目录按优先尺寸找 PNG
pub fn icon_data_url_of_app(app: &str) -> Option<String> {
    let icon_name = find_desktop_icon_name(app)?;
    let path = resolve_icon_path(&icon_name)?;
    let bytes = std::fs::read(path).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(encode_data_url_common(out.into_inner()))
}

/// 复用外层的 encode_data_url（避免重复实现）
fn encode_data_url_common(bytes: Vec<u8>) -> String {
    super::encode_data_url(bytes)
}

fn find_desktop_icon_name(app: &str) -> Option<String> {
    // 快路径：{app}.desktop
    for dir in APP_DIRS {
        let p = PathBuf::from(dir).join(format!("{app}.desktop"));
        if p.is_file() {
            if let Some(icon) = read_icon_field(&p) {
                return Some(icon);
            }
        }
    }
    // 慢路径：扫描 .desktop 的 StartupWMClass / Exec
    for dir in APP_DIRS {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "desktop").unwrap_or(false) {
                if let Some(icon) = read_icon_field_if_matches(&path, app) {
                    return Some(icon);
                }
            }
        }
    }
    None
}

/// 读取 .desktop 的 Icon= 行
fn read_icon_field(path: &PathBuf) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        if let Some(icon) = line.strip_prefix("Icon=") {
            return Some(icon.trim().to_string());
        }
    }
    None
}

/// StartupWMClass 或 Exec 含应用名时读取 Icon= 行
fn read_icon_field_if_matches(path: &PathBuf, app: &str) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut icon = None;
    let mut matched = false;
    for line in content.lines() {
        if let Some(wm) = line.strip_prefix("StartupWMClass=") {
            if wm.trim().eq_ignore_ascii_case(app) {
                matched = true;
            }
        } else if let Some(exec) = line.strip_prefix("Exec=") {
            if exec.to_lowercase().contains(app) {
                matched = true;
            }
        } else if let Some(i) = line.strip_prefix("Icon=") {
            icon = Some(i.trim().to_string());
        }
    }
    matched.then_some(icon).flatten()
}

/// Icon= 值 → 实际图标文件（绝对路径直接用；名称在 hicolor 主题 apps 目录按尺寸查找 PNG）
fn resolve_icon_path(icon: &str) -> Option<PathBuf> {
    let p = PathBuf::from(icon);
    if p.is_absolute() {
        return p.is_file().then_some(p);
    }
    const SIZES: &[&str] = &["48x48", "64x64", "128x128", "256x256", "32x32", "16x16"];
    for size in SIZES {
        let p = PathBuf::from(format!("/usr/share/icons/hicolor/{size}/apps/{icon}.png"));
        if p.is_file() {
            return Some(p);
        }
    }
    let p = PathBuf::from(format!("/usr/share/pixmaps/{icon}.png"));
    p.is_file().then_some(p)
}
}

