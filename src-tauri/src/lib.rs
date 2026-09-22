mod ai;
mod app_usage;
pub mod clipboard_thumb;
mod commands;
mod island_api;
mod island_webhook;
mod image_store;
mod migrations;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            // 主窗口冷启动居中：按所在显示器实际尺寸/DPR 居中（跨分辨率自适应）；
            // 仅建窗时执行一次，后续 Ctrl+I 唤出位置由前端 applyPopupPosition（弹出位置模式）接管
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 桌面应用使用时长：启动前台切换监听与 30s 分段结算（累计仅在设置开启后生效）
            app_usage::start(app.handle().clone());
            // 全局粘贴感知：系统级 Ctrl+V → 灵动岛"已粘贴" + 转发粘贴按键（失败仅降级）
            commands::register_global_paste_hotkey(app.handle());
            // 灵动岛 API 出站桥：应用内岛事件统一转 SSE 广播（常驻，与 API 开关无关，无订阅时零开销）
            island_api::attach_event_bridge(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::paste,
            commands::set_menu_theme,
            commands::quit_app,
            app_usage::set_app_usage_enabled,
            app_usage::pull_app_usage,
            app_usage::foreground_app_name,
            clipboard_thumb::clipboard_image_thumb,
            clipboard_thumb::clipboard_qr_from_data_url,
            image_store::save_clipboard_image,
            image_store::read_clipboard_image_file,
            image_store::delete_clipboard_image_file,
            ai::ai_test_connection,
            ai::ai_complete,
            island_api::island_api_apply,
            island_api::island_history_result,
            island_webhook::island_webhook_apply,
            island_webhook::island_webhook_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
