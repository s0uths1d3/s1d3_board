mod ai;
mod app_usage;
mod commands;
mod migrations;
mod open_api;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:s1d3_board.db", migrations::migrations())
                .build(),
        )
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 桌面应用使用时长：启动前台切换监听与 30s 分段结算（累计仅在设置开启后生效）
            app_usage::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::paste,
            commands::set_menu_theme,
            commands::quit_app,
            app_usage::set_app_usage_enabled,
            app_usage::pull_app_usage,
            ai::ai_test_connection,
            ai::ai_complete,
            open_api::open_api_apply,
            open_api::open_api_broadcast_copy,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
