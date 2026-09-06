//! 桌面应用使用时长统计（前台切换事件监听为主 + 30s 分段结算为辅）
//!
//! 数据流：前台切换系统事件（WinEventHook / NSWorkspace 通知 / X11 _NET_ACTIVE_WINDOW）
//!   → 分段结算：维护「当前应用 + 起始时间」，切换或 30s tick 时把上一段按空闲分界
//!     （键鼠无输入 >5 分钟的部分）拆成 总时长/活跃时长，累计进内存 totals
//!   → 前端每 30s `pull_app_usage()` 拉走增量并清空 → statsService UPSERT 进 app_usage 表
//!
//! 图标：首次见到某应用时提取其图标转为 PNG data URL（Windows SHGetFileInfo → HICON →
//! GetDIBits → PNG；macOS NSImage → TIFF → NSBitmapImageRep → PNG；Linux 查 desktop
//! 入口与 hicolor 主题图标），随 pull 返回并由前端持久化到 app_icons 表。
//!
//! 隐私边界：只记应用名与图标，不记窗口标题；默认关闭（enabled=false 时不累计且清空内存），
//! 由前端设置页经 set_app_usage_enabled 开启。
//!
//! 平台差异：三平台只有「监听启动 / 前台采样 / 空闲秒数」三个函数不同（platform 模块）；
//! Windows 用 SetWinEventHook + 消息循环；macOS 用 NSWorkspace 激活通知；
//! Linux X11 用根窗口 _NET_ACTIVE_WINDOW 的 PropertyNotify（Wayland 无统一协议，暂不支持）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use base64::Engine;

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
    /// 应用图标缓存：应用 → PNG data URL（None = 已尝试提取但失败，避免反复重试）
    icons: Mutex<HashMap<String, Option<String>>>,
}

impl AppUsageState {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            totals: Mutex::new(HashMap::new()),
            current: Mutex::new(None),
            icons: Mutex::new(HashMap::new()),
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

#[derive(serde::Serialize)]
pub struct AppIconEntry {
    pub app: String,
    pub icon: String,
}

#[derive(serde::Serialize)]
pub struct PullResult {
    pub entries: Vec<AppUsageEntry>,
    /// 本次会话内成功提取的应用图标（前端持久化到 app_icons 表）
    pub icons: Vec<AppIconEntry>,
}

/// 前台采样：应用名 + 可选图标（PNG data URL）
pub struct Sample {
    pub name: String,
    pub icon: Option<String>,
}

impl AppUsageState {
    fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            // 关闭即丢弃内存增量、分段与图标缓存，避免重新开启时把旧数据灌入当天
            if let Ok(mut t) = self.totals.lock() {
                t.clear();
            }
            if let Ok(mut c) = self.current.lock() {
                *c = None;
            }
            if let Ok(mut i) = self.icons.lock() {
                i.clear();
            }
        }
    }

    fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// 图标缓存：Some(data_url) 记录成功结果；None 记录"提取失败"防止反复重试。
    /// 已有记录（无论成败）时不覆盖。
    fn remember_icon(&self, app: &str, icon: Option<String>) {
        let mut icons = self.icons.lock().expect("app_usage icons 锁中毒");
        icons.entry(app.to_string()).or_insert(icon);
    }

    /// 图标是否已有缓存记录（含"提取失败"标记）
    fn icon_recorded(&self, app: &str) -> bool {
        self.icons
            .lock()
            .map(|i| i.contains_key(app))
            .unwrap_or(false)
    }

    /// 前台切换事件：结算上一段，开启新分段（同名重复事件去重），并缓存图标
    fn on_switch(&self, sample: Sample) {
        if !self.is_enabled() {
            return;
        }
        self.remember_icon(&sample.name, sample.icon);
        let now = Instant::now();
        let mut cur = self.current.lock().expect("app_usage current 锁中毒");
        if let Some((name, start)) = cur.as_ref() {
            if *name == sample.name {
                return;
            }
            Self::accumulate(&self.totals, name, *start, now);
        }
        *cur = Some((sample.name, now));
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
        if let Some(sample) = platform::foreground_sample(app) {
            self.remember_icon(&sample.name, sample.icon);
            *self.current.lock().expect("app_usage current 锁中毒") = Some((sample.name, now));
        }
    }

    /// 前端拉取：先结算在途分段，再清空并返回增量 + 图标
    fn pull(&self) -> PullResult {
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
        let icons_map = self.icons.lock().expect("app_usage icons 锁中毒");
        let icons: Vec<AppIconEntry> = entries
            .iter()
            .filter_map(|e| {
                icons_map
                    .get(&e.app)
                    .and_then(|icon| icon.as_ref())
                    .map(|icon| AppIconEntry { app: e.app.clone(), icon: icon.clone() })
            })
            .collect();
        PullResult { entries, icons }
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
        if let Some(sample) = platform::foreground_sample(&app) {
            state().remember_icon(&sample.name, sample.icon);
            let now = Instant::now();
            *state().current.lock().expect("app_usage current 锁中毒") = Some((sample.name, now));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pull_app_usage() -> Result<PullResult, String> {
    Ok(state().pull())
}

// ===================== 平台实现（按编译目标选择） =====================
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod unsupported;

// 统一的平台接口别名（各平台文件暴露相同的三个函数）
#[cfg(target_os = "windows")]
use windows as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
use unsupported as platform;

// ===================== 图标工具（跨平台共用） =====================

/// 字节 → PNG data URL（macOS/Linux 图标链路使用；Windows 在 windows.rs 内联编码）
#[allow(dead_code)]
pub fn encode_data_url(bytes: Vec<u8>) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
