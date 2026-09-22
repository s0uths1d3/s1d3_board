//! 原生菜单主题（原 commands.rs 菜单域拆分）：Windows 下经 uxtheme.dll 序号 135
//! SetPreferredAppMode 强制原生右键菜单（如图片查看器/编辑菜单）跟随应用明暗主题。
//! 非公开 API，按序号取址；取不到时静默降级（保持系统默认主题行为）。

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
