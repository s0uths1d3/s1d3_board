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

// ===================== 平台实现 =====================

#[cfg(target_os = "windows")]
mod platform {
    use super::{state, AppUsageState, Sample};
    use base64::Engine;
    use std::io::Cursor;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, GetDC, GetDIBits, GetObjectW, ReleaseDC, DeleteDC, DeleteObject,
        BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, DispatchMessageW, GetIconInfo, GetMessageW, GetForegroundWindow,
        GetWindowThreadProcessId, TranslateMessage, EVENT_SYSTEM_FOREGROUND, HICON, ICONINFO,
        MSG, WINEVENT_OUTOFCONTEXT,
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
        if let Some(sample) = sample_of_hwnd(hwnd) {
            state_ref().on_switch(sample);
        }
    }

    /// hwnd → 采样（进程名 + 图标）。无法获取进程名归入 "system" 桶，不丢时长。
    fn sample_of_hwnd(hwnd: HWND) -> Option<Sample> {
        unsafe {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                return Some(Sample { name: "system".to_string(), icon: None });
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return Some(Sample { name: "system".to_string(), icon: None });
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 || len == 0 {
                return Some(Sample { name: "system".to_string(), icon: None });
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
            let name = name.strip_suffix(".exe").unwrap_or(name).to_lowercase();
            let name = if name.is_empty() { "system".to_string() } else { name };
            // 图标：仅在该应用尚无缓存记录（含失败标记）时提取（回调线程阻塞几毫秒，单应用一次）
            let icon = if state_ref().icon_recorded(&name) {
                None
            } else {
                icon_data_url_of_path(&path)
            };
            Some(Sample { name, icon })
        }
    }

    /// exe 路径 → 图标 PNG data URL（SHGetFileInfo 取大图标 → GetDIBits 转 RGBA → PNG）
    fn icon_data_url_of_path(path: &str) -> Option<String> {
        unsafe {
            let mut path16: Vec<u16> = path.encode_utf16().collect();
            path16.push(0);
            let mut sfi: SHFILEINFOW = std::mem::zeroed();
            let ok = SHGetFileInfoW(
                path16.as_ptr(),
                0,
                &mut sfi,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );
            if ok == 0 || sfi.hIcon.is_null() {
                return None;
            }
            let png = hicon_to_png(sfi.hIcon);
            DestroyIcon(sfi.hIcon);
            png.map(|bytes| {
                format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
            })
        }
    }

    /// HICON → 32 位 BGRA 位图 → RGBA PNG
    fn hicon_to_png(hicon: HICON) -> Option<Vec<u8>> {
        unsafe {
            let mut info: ICONINFO = std::mem::zeroed();
            if GetIconInfo(hicon, &mut info) == 0 {
                return None;
            }
            let result = (|| {
                let mut bm: BITMAP = std::mem::zeroed();
                if GetObjectW(
                    info.hbmColor as _,
                    std::mem::size_of::<BITMAP>() as i32,
                    &mut bm as *mut _ as *mut _,
                ) == 0 {
                    return None;
                }
                let (w, h) = (bm.bmWidth, bm.bmHeight);
                if w <= 0 || h <= 0 {
                    return None;
                }
                let hdc = GetDC(std::ptr::null_mut());
                let mem = CreateCompatibleDC(hdc);
                let mut bi: BITMAPINFO = std::mem::zeroed();
                bi.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 负值 = 自上而下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: 0, // BI_RGB
                    biSizeImage: 0,
                    biXPelsPerMeter: 0,
                    biYPelsPerMeter: 0,
                    biClrUsed: 0,
                    biClrImportant: 0,
                };
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let lines = GetDIBits(
                    mem,
                    info.hbmColor,
                    0,
                    h as u32,
                    buf.as_mut_ptr() as _,
                    &mut bi,
                    DIB_RGB_COLORS,
                );
                ReleaseDC(std::ptr::null_mut(), hdc);
                DeleteDC(mem);
                if lines == 0 {
                    return None;
                }
                // BGRA → RGBA
                for px in buf.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
                // 带 alpha 通道的现代图标：保持原透明度。
                // 若把 alpha=0 的透明像素（RGB 通常存纯黑）置为不透明，会出现黑边。
                let has_alpha = buf.chunks_exact(4).any(|px| px[3] != 0);
                if !has_alpha {
                    // 旧格式图标：透明度来自 AND 掩码（hbmMask 高度 = 2h，下半为 AND 掩码，
                    // 掩码位 = 1 表示透明）。读取掩码还原透明度。
                    let stride = (((w as usize) + 31) / 32) * 4;
                    let mut mask = vec![0u8; stride * (h as usize) * 2];
                    let mut mi: BITMAPINFO = std::mem::zeroed();
                    mi.bmiHeader = BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -(h * 2),
                        biPlanes: 1,
                        biBitCount: 1,
                        biCompression: 0, // BI_RGB
                        biSizeImage: 0,
                        biXPelsPerMeter: 0,
                        biYPelsPerMeter: 0,
                        biClrUsed: 0,
                        biClrImportant: 0,
                    };
                    let mask_dc = GetDC(std::ptr::null_mut());
                    let got = GetDIBits(
                        mask_dc,
                        info.hbmMask,
                        0,
                        (h * 2) as u32,
                        mask.as_mut_ptr() as _,
                        &mut mi,
                        DIB_RGB_COLORS,
                    );
                    ReleaseDC(std::ptr::null_mut(), mask_dc);
                    let mut applied = false;
                    if got == h * 2 {
                        let and = &mask[stride * (h as usize)..];
                        for y in 0..h as usize {
                            for x in 0..w as usize {
                                let bit = (and[y * stride + x / 8] >> (7 - (x % 8))) & 1;
                                if bit == 1 {
                                    buf[(y * w as usize + x) * 4 + 3] = 0; // 掩码置位 = 透明
                                    applied = true;
                                }
                            }
                        }
                    }
                    // 无掩码信息可用的极端情况：整图按不透明兜底
                    if !applied {
                        for px in buf.chunks_exact_mut(4) {
                            px[3] = 255;
                        }
                    }
                }
                let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)?;
                let mut out = Cursor::new(Vec::new());
                img.write_to(&mut out, image::ImageFormat::Png).ok()?;
                Some(out.into_inner())
            })();

            if !info.hbmColor.is_null() {
                DeleteObject(info.hbmColor);
            }
            if !info.hbmMask.is_null() {
                DeleteObject(info.hbmMask);
            }
            result
        }
    }

    pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            sample_of_hwnd(hwnd)
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
    use super::{state, Sample};
    use block2::RcBlock;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace,
        NSWorkspaceDidActivateApplicationNotification,
    };
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    /// 注册激活通知观察者：NSWorkspace 通知由系统在应用激活时投递，无切换时零开销。
    /// 观察者与 block 刻意泄漏（应用生命周期内常驻，无需释放）。
    pub fn start() {
        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let center = workspace.notificationCenter();
            // NSWorkspace 为线程安全接口，回调里直接重取前台应用（thread-safe）
            let block = RcBlock::new(|_notification: NonNull<NSNotification>| {
                if let Some(sample) = foreground_sample() {
                    state().on_switch(sample);
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

    /// 前台应用采样：localizedName + icon（NSImage → TIFF → NSBitmapImageRep → PNG data URL）
    fn foreground_sample() -> Option<Sample> {
        unsafe {
            let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
            let name = app.localizedName().map(|n| n.to_string())?;
            let icon = app.icon().and_then(|image| {
                let tiff = image.TIFFRepresentation()?;
                let rep = NSBitmapImageRep::initWithData(
                    objc2_app_kit::NSBitmapImageRep::alloc(),
                    &tiff,
                )?;
                let png = rep.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &objc2_foundation::NSDictionary::new(),
                )?;
                Some(super::encode_data_url(png.to_vec()))
            });
            Some(Sample { name, icon })
        }
    }

    pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
        foreground_sample()
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
    use super::{state, Sample};
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
        let icon = super::linux_icon::icon_data_url_of_app(&name);
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
}

// 非 Windows/macOS/Linux 平台（理论不可达）：空实现保证编译
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn start() {}
    pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
        None
    }
    pub fn idle_secs() -> u64 {
        0
    }
}

// ===================== 图标工具（跨平台共用） =====================

/// 字节 → PNG data URL（macOS/Linux 图标链路使用；Windows 在 icon_data_url_of_path 内联编码）
#[allow(dead_code)]
pub fn encode_data_url(bytes: Vec<u8>) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Linux 桌面入口/hicolor 主题图标查找（尽力而为）
#[cfg(target_os = "linux")]
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
