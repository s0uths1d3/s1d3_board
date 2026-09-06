//! 通用命令（前端 invoke 入口）：粘贴模拟 / 原生菜单主题 / 退出应用
use std::time::Duration;

fn paste_blocking() -> Result<(), String> {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    std::thread::sleep(Duration::from_millis(300));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("初始化输入模拟失败: {e}"))?;

    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Press).map_err(|e| format!("按下修饰键失败: {e}"))?;
    enigo.key(Key::Unicode('v'), Click).map_err(|e| format!("发送 V 键失败: {e}"))?;
    enigo.key(modifier, Release).map_err(|e| format!("释放修饰键失败: {e}"))?;
    Ok(())
}


#[tauri::command]
pub async fn paste() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(paste_blocking)
        .await
        .map_err(|e| format!("粘贴任务执行失败: {e}"))?
}

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
