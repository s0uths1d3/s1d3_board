//! 装配根（对齐前端 modules/index.ts 组合根）：
//! 域模块（core / clipboard / island / ai / app_usage / commands / db）在此注册插件、
//! 注入 traits 抽象实现、登记命令清单；各域自身不感知装配细节。

mod ai;
mod app_usage;
mod clipboard;
mod commands;
mod core;
mod db;
mod island;

use std::sync::Arc;
use tauri::Manager;

use app_usage::PlatformForegroundSource;
use clipboard::image_store::FsImageStore;
use core::traits::{ForegroundSourceHandle, ImageStoreHandle};

// 对外（tests/ 集成测试）公共 API：QR 扫描纯函数与 data URL 解码命令
pub use clipboard::thumb;

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
                .add_migrations("sqlite:s1d3_board.db", db::migrations::migrations())
                .build(),
        )
        .setup(|app| {
            // 依赖注入装配（State 不进 invoke 载荷的语义见 traits.rs）
            app.manage(ImageStoreHandle(Arc::new(FsImageStore::new(app.handle().clone()))));
            app.manage(ForegroundSourceHandle(Arc::new(PlatformForegroundSource)));
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
            island::api::attach_event_bridge(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::paste::paste,
            commands::menu::set_menu_theme,
            commands::lifecycle::quit_app,
            app_usage::set_app_usage_enabled,
            app_usage::pull_app_usage,
            app_usage::foreground_app_name,
            clipboard::thumb::clipboard_image_thumb,
            clipboard::thumb::clipboard_qr_from_data_url,
            clipboard::image_store::save_clipboard_image,
            clipboard::image_store::read_clipboard_image_file,
            clipboard::image_store::delete_clipboard_image_file,
            ai::engine::ai_test_connection,
            ai::engine::ai_complete,
            island::api::island_api_apply,
            island::api::island_history_result,
            island::webhook::island_webhook_apply,
            island::webhook::island_webhook_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
