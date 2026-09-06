//! 桌面应用使用时长统计（前台切换事件监听为主 + 30s 分段结算为辅）
//!
//! 数据流：前台切换系统事件（WinEventHook / NSWorkspace 通知 / X11 _NET_ACTIVE_WINDOW）
//!   → 分段结算：维护「当前应用 + 起始时间」，切换或 30s tick 时把上一段按空闲分界
//!     （键鼠无输入 >5 分钟的部分）拆成 总时长/活跃时长，累计进内存 totals
//!   → 前端每 30s `pull_app_usage()` 拉走增量并清空 → statsService UPSERT 进 app_usage 表
//!
//! 隐私边界：只记应用名（Windows/Linux 进程名、macOS 应用名），不记窗口标题；
//! 默认关闭（enabled=false 时不累计且清空内存），由前端设置页经 set_app_usage_enabled 开启。
//!
//! 平台差异：三平台只有「监听启动 / 前台应用名 / 空闲秒数」三个函数不同（platform 模块）；
//! Windows 用 SetWinEventHook + 消息循环；macOS 用 NSWorkspace 激活通知（主线程）；
//! Linux X11 用根窗口 _NET_ACTIVE_WINDOW 的 PropertyNotify（Wayland 无统一协议，暂不支持）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 键鼠无输入超过该秒数，分段内其后部分计入"挂机"（不计活跃）
const IDLE_THRESHOLD_SECS: u64 = 300;
/// 分段结算周期（秒）：无前台切换时按该周期切分累计，保证增量粒度与前端拉取对齐
const SEGMENT_TICK_SECS: u64 = 30;

static STATE: OnceLock<AppUsageState> = OnceLock::new();

pub struct AppUsageState {
    enabled: AtomicBool,
    /// 会话内未拉取的增量：应用 → (总秒数, 活跃秒数)
    totals: Mutex<HashMap<String, (u64, u64)>>,
    /// 当前前台应用与分段起点（None = 尚未采样/已关闭）
    current: Mutex<Option<(String, Instant)>>,
}

impl AppUsageState {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            totals: Mutex::new(HashMap::new()),
            current: Mutex::new(None),
        }
    }
}

fn state() -> &'static AppUsageState {
    STATE.get_or_init(AppUsageState::new)
}

#[derive(serde::Serialize)]
pub struct AppUsageEntry {
    pub app: String,
    pub total: u64,
    pub active: u64,
}

impl AppUsageState {
    fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            // 关闭即丢弃内存增量与分段，避免重新开启时把旧数据灌入当天
            if let Ok(mut t) = self.totals.lock() {
                t.clear();
            }
            if let Ok(mut c) = self.current.lock() {
                *c = None;
            }
        }
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// 前台切换事件：结算上一段，开启新分段（同名重复事件去重）
    fn on_switch(&self, app: String) {
        if !self.is_enabled() {
            return;
        }
        let now = Instant::now();
        let mut cur = self.current.lock().expect("app_usage current 锁中毒");
        if let Some((name, start)) = cur.as_ref() {
            if *name == app {
                return;
            }
            Self::accumulate(&self.totals, name, *start, now);
        }
        *cur = Some((app, now));
    }

    /// 30s 辅助 tick：切分当前分段（重新计时），保证增量粒度；缺失当前应用时补采样
    fn segment_tick(&self, app: &tauri::AppHandle) {
        if !self.is_enabled() {
            return;
        }
        let now = Instant::now();
        let mut cur = self.current.lock().expect("app_usage current 锁中毒");
        if let Some((name, start)) = cur.as_ref() {
            Self::accumulate(&self.totals, name, *start, now);
            *cur = Some((name.clone(), now));
            return;
        }
        drop(cur);
        // 尚无分段（刚开启/异常丢失）：采样当前前台应用并开段
        if let Some(name) = platform::foreground_now(app) {
            *self.current.lock().expect("app_usage current 锁中毒") = Some((name, now));
        }
    }

    /// 前端拉取：先结算在途分段，再清空并返回增量
    fn pull(&self) -> Vec<AppUsageEntry> {
        let now = Instant::now();
        {
            let mut cur = self.current.lock().expect("app_usage current 锁中毒");
            if let Some((name, start)) = cur.as_ref() {
                Self::accumulate(&self.totals, name, *start, now);
                *cur = Some((name.clone(), now));
            }
        }
        let mut totals = self.totals.lock().expect("app_usage totals 锁中毒");
        let entries: Vec<AppUsageEntry> = totals
            .drain()
            .map(|(app, (total, active))| AppUsageEntry { app, total, active })
            .collect();
        entries
    }

    /// 结算一段前台使用：总量 = 段长；活跃 = 段长 - 段尾空闲部分。
    /// 段尾空闲指键鼠无输入超过 IDLE_THRESHOLD_SECS 的部分（阈值内仍算活跃）。
    fn accumulate(
        totals: &Mutex<HashMap<String, (u64, u64)>>,
        app: &str,
        start: Instant,
        now: Instant,
    ) {
        let total = now.duration_since(start).as_secs();
        if total == 0 {
            return;
        }
        let idle_beyond_threshold = platform::idle_secs().saturating_sub(IDLE_THRESHOLD_SECS);
        let active = total.saturating_sub(idle_beyond_threshold.min(total));
        let mut t = totals.lock().expect("app_usage totals 锁中毒");
        let entry = t.entry(app.to_string()).or_insert((0, 0));
        entry.0 += total;
        entry.1 += active;
    }
}

/// 由 Tauri setup（主线程）调用：启动平台监听 + 30s 分段结算定时器
pub fn start(app: tauri::AppHandle) {
    state(); // 初始化共享状态
    platform::start();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(SEGMENT_TICK_SECS));
        state().segment_tick(&app);
    });
}

#[tauri::command]
pub fn set_app_usage_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    state().set_enabled(enabled);
    // 开启时立即采样当前前台应用开段，避免等到下一次切换/30s 才开始计时
    if enabled {
        if let Some(name) = platform::foreground_now(&app) {
            let now = Instant::now();
            *state().current.lock().expect("app_usage current 锁中毒") = Some((name, now));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pull_app_usage() -> Result<Vec<AppUsageEntry>, String> {
    Ok(state().pull())
}

// ===================== 平台实现 =====================

#[cfg(target_os = "windows")]
mod platform {
    use super::{state, AppUsageState};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, GetForegroundWindow, GetWindowThreadProcessId,
        TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
    };

    /// 常驻状态引用（WinEventProc 回调无上下文参数，经全局取用；仿 set_menu_theme 的 OnceLock 先例）
    static STATE_REF: OnceLock<&'static AppUsageState> = OnceLock::new();

    fn state_ref() -> &'static AppUsageState {
        *STATE_REF.get_or_init(state)
    }

    pub fn start() {
        std::thread::spawn(|| unsafe {
            // 前台切换钩子：WINEVENT_OUTOFCONTEXT 要求调用线程有消息循环
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(winevent_proc),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.is_null() {
                log::error!("[app_usage] SetWinEventHook 注册失败，前台监听不可用");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    }

    unsafe extern "system" fn winevent_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        hwnd: HWND,
        id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        // OBJID_WINDOW = 0：仅响应顶层窗口的前台切换
        if event != EVENT_SYSTEM_FOREGROUND || id_object != 0 || hwnd.is_null() {
            return;
        }
        if let Some(name) = process_name_of_hwnd(hwnd) {
            state_ref().on_switch(name);
        }
    }

    /// hwnd → 进程名（取文件名去 .exe 小写；无法获取归入 "system" 桶，不丢时长）
    fn process_name_of_hwnd(hwnd: HWND) -> Option<String> {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return Some("system".to_string());
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return Some("system".to_string());
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                buf.as_mut_ptr(),
                &mut len,
            );
            CloseHandle(handle);
            if ok == 0 || len == 0 {
                return Some("system".to_string());
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
            let name = name.strip_suffix(".exe").unwrap_or(name).to_lowercase();
            Some(if name.is_empty() { "system".to_string() } else { name })
        }
    }

    pub fn foreground_now(_app: &tauri::AppHandle) -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            process_name_of_hwnd(hwnd)
        }
    }

    pub fn idle_secs() -> u64 {
        unsafe {
            let mut li = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut li) == 0 {
                return 0;
            }
            // dwTime 为系统启动毫秒计数，回绕安全（wrapping）
            (GetTickCount().wrapping_sub(li.dwTime)) as u64 / 1000
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::state;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidActivateApplicationNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;
    use block2::RcBlock;

    /// 注册激活通知观察者：NSWorkspace 通知由系统在应用激活时投递，无切换时零开销。
    /// 观察者与 block 刻意泄漏（应用生命周期内常驻，无需释放）。
    pub fn start() {
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            // NSWorkspace 为线程安全接口，回调里直接重取前台应用（thread-safe）
            let block = RcBlock::new(|_notification: NonNull<NSNotification>| {
                if let Some(name) = foreground_name() {
                    state().on_switch(name);
                }
            });
            let observer = center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceDidActivateApplicationNotification),
                None,
                None,
                &block,
            );
            std::mem::forget(observer);
            std::mem::forget(block);
        }
    }

    /// 前台应用名（取 localizedName，如 "Safari"）
    fn foreground_name() -> Option<String> {
        unsafe {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            app.localizedName().map(|n| n.to_string())
        }
    }

    pub fn foreground_now(_app: &tauri::AppHandle) -> Option<String> {
        foreground_name()
    }

    pub fn idle_secs() -> u64 {
        // CoreGraphics 手动绑定：kCGEventSourceStateHIDSystemState = 1，kCGAnyInputEventType = u64::MAX
        unsafe { CGEventSourceSecondsSinceLastEventType(1, u64::MAX) as u64 }
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: u32, mask: u64) -> f64;
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::state;
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
                    if let Some(name) = active_window_name(&conn, root, net_active_atom, net_wm_pid_atom) {
                        state().on_switch(name);
                    }
                }
                _ => {}
            }
        }
    }

    /// 当前活跃窗口 → _NET_WM_PID → /proc/{pid}/comm 进程名；查询失败归入 "system" 桶
    fn active_window_name<C: Connection>(
        conn: &C,
        root: u32,
        net_active_atom: u32,
        net_wm_pid_atom: u32,
    ) -> Option<String> {
        let reply = conn
            .get_property(false, root, net_active_atom, AtomEnum::WINDOW, 0, 1)
            .ok()?
            .reply()
            .ok()?;
        if reply.value_len != 1 || reply.value.len() < 4 {
            return None;
        }
        let win = u32::from_ne_bytes([reply.value[0], reply.value[1], reply.value[2], reply.value[3]]);
        if win == 0 {
            return None;
        }
        let pid_reply = conn
            .get_property(false, win, net_wm_pid_atom, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()?;
        if pid_reply.value_len == 0 || pid_reply.value.len() < 4 {
            return Some("system".to_string());
        }
        let pid = u32::from_ne_bytes([
            pid_reply.value[0],
            pid_reply.value[1],
            pid_reply.value[2],
            pid_reply.value[3],
        ]);
        Some(std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_else(|_| "system".to_string()))
    }

    pub fn foreground_now(_app: &tauri::AppHandle) -> Option<String> {
        let (conn, screen_num) = x11rb::connect(None).ok()?;
        let root = conn.setup().roots.get(screen_num)?.root;
        let net_active_atom = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW").ok()?.reply().ok()?.atom;
        let net_wm_pid_atom = conn.intern_atom(false, b"_NET_WM_PID").ok()?.reply().ok()?.atom;
        active_window_name(&conn, root, net_active_atom, net_wm_pid_atom)
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
}

// 非 Windows/macOS/Linux 平台（理论不可达）：空实现保证编译
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn start() {}
    pub fn foreground_now(_app: &tauri::AppHandle) -> Option<String> {
        None
    }
    pub fn idle_secs() -> u64 {
        0
    }
}
