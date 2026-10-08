//! 桌面应用使用时长统计（前台切换事件监听为主 + 30s 分段结算为辅）
//!
//! 数据流：前台切换系统事件（WinEventHook / NSWorkspace 通知 / X11 _NET_ACTIVE_WINDOW）
//!   → 分段结算：维护「当前应用 + 起始时间」，切换或 30s tick 时把上一段按空闲分界
//!     （键鼠无输入 >5 分钟的部分）拆成 总时长/活跃时长，累计进内存 totals，并同步原子
//!     落盘到 app_data/pending_app_usage.json（崩溃/退出后下次启动读回，增量不丢失）
//!   → 前端每 30s `pull_app_usage()` 拉走增量并清空（落盘文件随之删除）→ statsService UPSERT 进 app_usage 表
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
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use base64::Engine;
use tauri::Manager;

use crate::core::traits::ForegroundSource;

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
    /// app_data 目录（增量落盘缓冲目录；start 时设置，未设置则跳过落盘）
    dir: OnceLock<PathBuf>,
}

impl AppUsageState {
    fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            totals: Mutex::new(HashMap::new()),
            current: Mutex::new(None),
            icons: Mutex::new(HashMap::new()),
            dir: OnceLock::new(),
        }
    }
}

fn state() -> &'static AppUsageState {
    STATE.get_or_init(AppUsageState::new)
}

#[derive(serde::Serialize, serde::Deserialize)]
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
            // totals 已清空 → 同步删除落盘缓冲文件（关闭统计即放弃未拉取增量）
            self.persist_totals();
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
        {
            let mut cur = self.current.lock().expect("app_usage current 锁中毒");
            if let Some((name, start)) = cur.as_ref() {
                if *name == sample.name {
                    return;
                }
                Self::accumulate(&self.totals, name, *start, now);
            }
            *cur = Some((sample.name, now));
        }
        self.persist_totals();
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
            drop(cur);
            self.persist_totals();
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
        drop(totals);
        // 增量已移交前端，落盘缓冲随之清空（保持「文件存在 ⇔ 有未拉取增量」的单一不变式）
        self.persist_totals();
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

    /// 增量落盘缓冲文件路径（app_data/pending_app_usage.json）；dir 未设置返回 None
    fn pending_path(&self) -> Option<PathBuf> {
        self.dir.get().map(|d| d.join("pending_app_usage.json"))
    }

    /// 将当前 totals 快照原子落盘（临时文件 + rename，崩溃不会留下半截文件）。
    /// totals 为空时删除缓冲文件，保证文件内容始终等于当前未拉取增量。
    fn persist_totals(&self) {
        let Some(path) = self.pending_path() else { return };
        let snapshot: Vec<AppUsageEntry> = match self.totals.lock() {
            Ok(t) => t
                .iter()
                .map(|(app, (total, active))| AppUsageEntry {
                    app: app.clone(),
                    total: *total,
                    active: *active,
                })
                .collect(),
            Err(_) => return,
        };
        if snapshot.is_empty() {
            let _ = fs::remove_file(&path);
            return;
        }
        match serde_json::to_vec(&snapshot) {
            Ok(json) => {
                let tmp = path.with_extension("json.tmp");
                if fs::write(&tmp, &json).and_then(|_| fs::rename(&tmp, &path)).is_err() {
                    log::warn!("[app_usage] 增量落盘失败，下次结算重试");
                }
            }
            Err(e) => log::warn!("[app_usage] 增量序列化失败: {e}"),
        }
    }

    /// 启动恢复：读回上次会话落盘的未拉取增量并入 totals 后删除文件。
    /// 前端按 (日期, 应用) UPSERT，读回数据随下一次 pull 正常入库，不产生重复。
    fn load_pending(&self) {
        let Some(path) = self.pending_path() else { return };
        let Ok(json) = fs::read(&path) else { return };
        let recovered = match serde_json::from_slice::<Vec<AppUsageEntry>>(&json) {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!("[app_usage] 落盘缓冲损坏，忽略: {e}");
                let _ = fs::remove_file(&path);
                return;
            }
        };
        if let Ok(mut t) = self.totals.lock() {
            for e in recovered {
                if e.total == 0 && e.active == 0 {
                    continue;
                }
                let slot = t.entry(e.app).or_insert((0, 0));
                slot.0 += e.total;
                slot.1 += e.active;
            }
        }
        let _ = fs::remove_file(&path);
        log::info!("[app_usage] 已恢复上次未拉取的应用时长增量");
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

/// 由 Tauri setup（主线程）调用：恢复上次未拉取增量 + 启动平台监听 + 30s 分段结算定时器
pub fn start(app: tauri::AppHandle) {
    let st = state(); // 初始化共享状态
    // 增量落盘缓冲：定位 app_data 目录并读回上次会话未拉取的增量（崩溃/退出不丢数据）
    match app.path().app_data_dir() {
        Ok(dir) => {
            let _ = st.dir.set(dir);
            st.load_pending();
        }
        Err(e) => log::warn!("[app_usage] 无法定位 app_data 目录，增量落盘缓冲不可用: {e}"),
    }
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

/// 应用时长采集在当前平台是否可用：仅 Linux 需探测（Wayland 无统一前台窗口协议，
/// X11 探测 connect 成功与否）；Windows/macOS 恒可用。前端据此展示不支持提示条。
#[tauri::command]
pub fn app_usage_supported() -> bool {
    #[cfg(target_os = "linux")]
    let supported = platform::is_supported();
    #[cfg(not(target_os = "linux"))]
    let supported = true;
    supported
}

/// 当前前台应用名（仅名称、不取图标，轻量查询）：供剪贴板来源标记（clip.source_app）使用。
/// 采样失败返回 None（调用方不标记，宁缺勿错）。
/// 依赖抽象：委托注入的 ForegroundSource（State 不进 invoke 载荷，前端签名不变）。
#[tauri::command]
pub fn foreground_app_name(
    source: tauri::State<'_, crate::core::traits::ForegroundSourceHandle>,
    app: tauri::AppHandle,
) -> Option<String> {
    source.0.foreground_name(&app)
}

/// 按应用名提取运行中应用的真实图标（PNG data URL）：供剪贴板来源图标（clip.source_app
/// 无 app_icons 缓存时实时补取）等按名查询场景。与前台采样同一图标链路。
/// 应用未在运行 / 平台不支持 / 提取失败返回 None（前端回退展示）。
#[tauri::command]
pub fn app_icon_by_name(name: String) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    platform::icon_of_app(trimmed)
}

// ===================== trait 实现（lib.rs 装配注入） =====================

/// traits::ForegroundSource 的平台实现：委托当前编译目标的 platform 模块前台采样。
pub(crate) struct PlatformForegroundSource;

impl ForegroundSource for PlatformForegroundSource {
    fn foreground_name(&self, app: &tauri::AppHandle) -> Option<String> {
        platform::foreground_name(app)
    }
}

// ===================== 平台实现（按编译目标选择） =====================
#[cfg(target_os = "windows")]
pub mod windows;
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
