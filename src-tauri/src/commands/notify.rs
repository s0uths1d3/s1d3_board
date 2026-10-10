//! 系统通知（Windows toast）：
//! - `register_toast_identity`：向注册表注册应用 AUMID
//!   （HKCU\Software\Classes\AppUserModelId\<identifier> 写入 DisplayName / IconUri），
//!   让 toast 通知显示本应用名称与图标。图标 PNG 编译期嵌入（include_bytes），
//!   运行时落盘 app_data 后以 file:/// URI 注册。幂等，每次启动覆盖写。
//! - `send_system_notification`：显式以 identifier 作为 AppId 发送通知。
//!   不走 tauri-plugin-notification 的 JS 通道——该插件在开发/未安装模式
//!   （exe 位于 target\debug|release）下刻意不设置 AppId，notify-rust 的
//!   Windows 后端回退借用 PowerShell 的 AUMID，导致通知来源显示
//!   「Windows PowerShell」而非本应用（用户可见 bug）。
//!
//! 非 Windows 平台：前端保留原插件通道（sendNotification），本模块仅 Windows 生效。

use tauri::Manager;

/// 与 tauri.conf.json identifier 一致（AUMID 键名，发送端/注册端必须同源）
const APP_ID: &str = "S1d3Board";
/// toast 来源显示名（与 UI 内 app.name 文案一致）
const DISPLAY_NAME: &str = "S1d3 Board";
/// 编译期嵌入的应用图标（PNG，官方 toast IconUri 支持格式）
const TOAST_ICON_PNG: &[u8] = include_bytes!("../../icons/icon.png");

/// AUMID 注册（仅 Windows）：失败仅打印日志不阻断启动——
/// 最坏情况为 toast 来源显示不正确，不影响通知本身送达。
pub fn register_toast_identity(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：GUI 进程（windows_subsystem = "windows"）派生控制台
        // 程序（reg.exe）时，Windows 会为其分配**可见的新控制台窗口**——启动时
        // 闪现 cmd 黑框的根源；此标志阻止分配（对 GUI 子进程无效果，无害）
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[notify] 获取 app_data 目录失败，跳过 AUMID 注册: {e}");
                return;
            }
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[notify] 创建 app_data 目录失败，跳过 AUMID 注册: {e}");
            return;
        }
        let icon = dir.join("toast-icon.png");
        if let Err(e) = std::fs::write(&icon, TOAST_ICON_PNG) {
            eprintln!("[notify] 写入 toast 图标失败: {e}");
            return;
        }
        // IconUri 需要 URI 形式：反斜杠转正斜杠、空格转 %20（中文等非 ASCII 字符
        // Windows toast 解析器可接受原样路径片段，无需百分号全编码）
        let uri = format!(
            "file:///{}",
            icon.display().to_string().replace('\\', "/").replace(' ', "%20")
        );
        let key = format!(r"Software\Classes\AppUserModelId\{APP_ID}");
        for (name, value) in [("DisplayName", DISPLAY_NAME), ("IconUri", uri.as_str())] {
            if let Err(e) = std::process::Command::new("reg")
                .args(["add", &format!(r"HKCU\{key}"), "/v", name, "/t", "REG_SZ", "/d", value, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
            {
                eprintln!("[notify] 注册 AUMID {name} 失败: {e}");
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

/// 发送系统通知（Windows toast，显式 AppId = 应用 AUMID，来源显示本应用名与图标）。
/// 非 Windows 平台返回 Ok（前端在这些平台走 tauri-plugin-notification 原通道）。
#[tauri::command]
pub fn send_system_notification(title: String, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        notify_rust::Notification::new()
            .app_id(APP_ID)
            .summary(&title)
            .body(&body)
            .show()
            .map_err(|e| format!("发送系统通知失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body);
        Ok(())
    }
}
