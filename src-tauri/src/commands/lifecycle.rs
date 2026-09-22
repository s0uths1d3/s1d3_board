//! 应用生命周期命令（原 commands.rs 生命周期域拆分）：托盘菜单"退出"入口。

#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
