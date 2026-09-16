//! 通用命令（前端 invoke 入口）：粘贴模拟 / 原生菜单主题 / 退出应用
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

/// 注入抑制标志：模拟粘贴（paste 命令 / 全局 Ctrl+V 钩子转发）期间置 true——
/// 注入的合成按键同样会触发全局快捷键钩子，不抑制会再次转发导致死循环与重复弹岛
static PASTE_INJECTING: AtomicBool = AtomicBool::new(false);

/// 模拟 Ctrl/Cmd+V 粘贴（delay_ms 用于 pasteUtil"隐藏窗口→等焦点回目标应用"的时序）。
/// 注入全程挂 PASTE_INJECTING 抑制标志，全局钩子据此跳过我们自己的合成按键。
fn inject_paste_blocking(delay_ms: u64) -> Result<(), String> {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    std::thread::sleep(Duration::from_millis(delay_ms));
    PASTE_INJECTING.store(true, Ordering::SeqCst);
    let result = (|| -> Result<(), String> {
        let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("初始化输入模拟失败: {e}"))?;

        #[cfg(target_os = "macos")]
        let modifier = Key::Meta;
        #[cfg(not(target_os = "macos"))]
        let modifier = Key::Control;

        enigo.key(modifier, Press).map_err(|e| format!("按下修饰键失败: {e}"))?;
        enigo.key(Key::Unicode('v'), Click).map_err(|e| format!("发送 V 键失败: {e}"))?;
        enigo.key(modifier, Release).map_err(|e| format!("释放修饰键失败: {e}"))?;
        Ok(())
    })();
    // 延迟清标志：Linux/macOS 的拦截型快捷键回调对注入键的处理存在异步延迟，
    // 立即清会被自身合成键再次触发（循环/重复弹岛）。Windows 以 INJECTED 标志过滤为准，
    // 此窗口仅作兜底（100ms 内的连续手动粘贴只是少弹一次提示，粘贴本身不受影响）
    std::thread::sleep(Duration::from_millis(100));
    PASTE_INJECTING.store(false, Ordering::SeqCst);
    result
}


#[tauri::command]
pub async fn paste() -> Result<(), String> {
    // 前端粘贴流程（写剪贴板 → 隐藏窗口 → 等焦点回目标应用 → 模拟粘贴）：保留 300ms 时序
    tauri::async_runtime::spawn_blocking(|| inject_paste_blocking(300))
        .await
        .map_err(|e| format!("粘贴任务执行失败: {e}"))?
}

/// 全局粘贴感知（跨平台）：用户在任意应用按粘贴键（Ctrl+V / Cmd+V）时广播
/// island:paste-detected → 前端灵动岛弹"已粘贴"（跟随灵动岛总开关，含历史记录）。
/// - Windows：WH_KEYBOARD_LL 低级键盘钩子——只观察不拦截，粘贴由系统原生完成；
/// - macOS：CGEventTap ListenOnly——同样只观察不拦截；需系统「辅助功能」权限
///   （未授权时 tap 创建失败，功能不启用并输出提示）；物理键按 HID 事件源过滤；
/// - Linux：X11 无观察型全局钩子，退化为插件 on_shortcut（拦截）+ enigo 注入转发，
///   注入键会被 grab 再次捕获，靠 PASTE_INJECTING 覆盖窗口防循环。
pub fn register_global_paste_hotkey(app: &tauri::AppHandle) {
    let _ = PASTE_HOOK_APP.set(app.clone());
    #[cfg(target_os = "windows")]
    std::thread::spawn(|| unsafe { paste_hook_thread() });
    #[cfg(target_os = "macos")]
    std::thread::spawn(|| unsafe { paste_event_tap_thread() });
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        const PASTE_HOTKEY: &str = "Control+V";
        let result = app.global_shortcut().on_shortcut(PASTE_HOTKEY, |app, _shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if PASTE_INJECTING.load(Ordering::SeqCst) {
                return;
            }
            let _ = app.emit("island:paste-detected", ());
            std::thread::spawn(|| { let _ = inject_paste_blocking(10); });
        });
        if let Err(e) = result {
            eprintln!("[global-paste-hotkey] {PASTE_HOTKEY} 注册失败，粘贴感知不启用: {e}");
        }
    }
}

static PASTE_HOOK_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// WH_KEYBOARD_LL 钩子线程：安装钩子后跑消息泵（低级钩子回调依赖安装线程 pump 消息）
#[cfg(target_os = "windows")]
unsafe fn paste_hook_thread() {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetMessageW, SetWindowsHookExW, MSG, WH_KEYBOARD_LL,
    };

    let hmod = GetModuleHandleW(std::ptr::null());
    let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(paste_ll_keyboard_proc), hmod, 0);
    if hook.is_null() {
        eprintln!("[global-paste-hotkey] WH_KEYBOARD_LL 安装失败，粘贴感知不启用");
        return;
    }
    // 消息泵：GetMessageW 返回 0（WM_QUIT）/ -1（错误）时退出
    let mut msg: MSG = std::mem::zeroed();
    while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
}

/// 低级键盘钩子回调：检测物理 Ctrl+V（首按）→ 广播粘贴事件；一律 CallNextHookEx 放行
#[cfg(target_os = "windows")]
unsafe extern "system" fn paste_ll_keyboard_proc(ncode: i32, wparam: usize, lparam: isize) -> isize {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, WM_KEYDOWN, WM_SYSKEYDOWN,
    };

    if ncode >= 0 && (wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize) {
        let info = &*(lparam as *const KBDLLHOOKSTRUCT);
        // V 键 + Ctrl 按住 = 粘贴动作（长按 V 的自动重复会多次触发，对应系统连续粘贴，符合语义）；
        // INJECTED（应用/其他软件合成的键）不触发；PASTE_INJECTING 兜底防时序窗口误报
        let injected = info.flags & LLKHF_INJECTED != 0;
        if info.vkCode == 0x56
            && !injected
            && GetAsyncKeyState(0x11) as u16 & 0x8000 != 0
            && !PASTE_INJECTING.load(Ordering::SeqCst)
        {
            if let Some(app) = PASTE_HOOK_APP.get() {
                let _ = app.emit("island:paste-detected", ());
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), ncode, wparam, lparam)
}

// ===== macOS：CGEventTap（ListenOnly，观察不拦截）=====
#[cfg(target_os = "macos")]
mod paste_tap {
    use super::{PASTE_HOOK_APP, PASTE_INJECTING};
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use tauri::Emitter;

    type CGEventRef = *mut c_void;
    type CGEventTapCallBack = unsafe extern "C" fn(*mut c_void, u32, CGEventRef, *mut c_void) -> CGEventRef;

    const K_SESSION_EVENT_TAP: u32 = 1; // kCGSessionEventTap
    const K_HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
    const K_LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly：只观察，不能修改/吞事件
    const K_EVENT_KEY_DOWN: u32 = 10; // kCGEventKeyDown
    const K_EVENT_MASK: u64 = 1 << 10; // CGEventMaskBit(kCGEventKeyDown)
    const K_FLAG_COMMAND: u64 = 1 << 20; // kCGEventFlagMaskCommand
    const K_FIELD_KEYCODE: u32 = 9; // kCGKeyboardEventKeycode
    const K_FIELD_SOURCE_STATE: u32 = 41; // kCGEventSourceStateID
    const K_SOURCE_HID: i64 = 1; // kCGEventSourceStateHIDSystemState：物理硬件键盘
    const K_VK_ANSI_V: i64 = 9; // kVK_ANSI_V

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            eventsOfInterest: u64,
            callback: CGEventTapCallBack,
            userInfo: *mut c_void,
        ) -> *mut c_void;
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(allocator: *mut c_void, port: *mut c_void, order: isize) -> *mut c_void;
        fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        fn CFRunLoopGetCurrent() -> *mut c_void;
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: *const c_void;
    }

    /// ListenOnly 回调：物理 Cmd+V 按下时广播粘贴事件；listen-only 语义下原样返回 event（放行）
    unsafe extern "C" fn paste_tap_cb(
        _proxy: *mut c_void,
        etype: u32,
        event: CGEventRef,
        _user_info: *mut c_void,
    ) -> CGEventRef {
        if etype == K_EVENT_KEY_DOWN {
            let is_physical = CGEventGetIntegerValueField(event, K_FIELD_SOURCE_STATE) == K_SOURCE_HID;
            let is_cmd_v = CGEventGetFlags(event) & K_FLAG_COMMAND != 0
                && CGEventGetIntegerValueField(event, K_FIELD_KEYCODE) == K_VK_ANSI_V;
            if is_physical && is_cmd_v && !PASTE_INJECTING.load(Ordering::SeqCst) {
                if let Some(app) = PASTE_HOOK_APP.get() {
                    let _ = app.emit("island:paste-detected", ());
                }
            }
        }
        event
    }

    /// 事件 tap 线程：创建 tap → 挂到当前 run loop → 跑循环（回调依赖 run loop 派发）
    pub(super) unsafe fn paste_event_tap_thread() {
        let tap = CGEventTapCreate(
            K_SESSION_EVENT_TAP,
            K_HEAD_INSERT,
            K_LISTEN_ONLY,
            K_EVENT_MASK,
            paste_tap_cb,
            std::ptr::null_mut(),
        );
        if tap.is_null() {
            // 常见于未授予「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能
            eprintln!("[global-paste-hotkey] CGEventTapCreate 失败（检查辅助功能权限），粘贴感知不启用");
            return;
        }
        let source = CFMachPortCreateRunLoopSource(std::ptr::null_mut(), tap, 0);
        if source.is_null() {
            eprintln!("[global-paste-hotkey] CFMachPortCreateRunLoopSource 失败，粘贴感知不启用");
            return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CFRunLoopRun();
    }
}

#[cfg(target_os = "macos")]
use paste_tap::paste_event_tap_thread;

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}


#[tauri::command]
pub fn set_menu_theme(theme: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        const DEFAULT_MODE: i32 = 0;
        const ALLOW_DARK: i32 = 1;
        const FORCE_DARK: i32 = 2;
        const FORCE_LIGHT: i32 = 3;

        let mode: i32 = match theme.as_str() {
            "dark" => FORCE_DARK,
            "light" => FORCE_LIGHT,
            "system" => ALLOW_DARK,
            _ => DEFAULT_MODE,
        };

        apply_preferred_app_mode(mode);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = theme;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn apply_preferred_app_mode(mode: i32) {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    type SetPreferredAppModeFn = unsafe extern "system" fn(i32) -> i32;
    static SET_PREFERRED_APP_MODE: OnceLock<Option<SetPreferredAppModeFn>> = OnceLock::new();

    let f = *SET_PREFERRED_APP_MODE.get_or_init(|| unsafe {
        let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
        let mut handle = GetModuleHandleW(name.as_ptr());
        if handle.is_null() {
            handle = windows_sys::Win32::System::LibraryLoader::LoadLibraryW(name.as_ptr());
        }
        if handle.is_null() {
            return None;
        }
        let addr = GetProcAddress(handle, 135 as *const u8);
        addr.map(|a| std::mem::transmute::<unsafe extern "system" fn() -> isize, SetPreferredAppModeFn>(a))
    });

    if let Some(f) = f {
        unsafe { f(mode) };
    }
}
