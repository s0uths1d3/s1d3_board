use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app
                .get_webview_window("main")
                .expect("no main window")
                .set_focus();
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:s1de_board.db",
                    vec![
                        Migration {
                            version: 1,
                            description: "Create clipboard table, FTS, indexes and triggers",
                            kind: MigrationKind::Up,
                            sql: r#"
                                CREATE TABLE IF NOT EXISTS clipboard (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    content TEXT NOT NULL UNIQUE,
                                    create_time TEXT,
                                    source TEXT,
                                    is_favorite INTEGER DEFAULT 0 CHECK (is_favorite IN (0, 1)),
                                    category TEXT,
                                    count INTEGER DEFAULT 1,
                                    last_use TEXT
                                );

                                CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
                                    content,
                                    content='clipboard',
                                    content_rowid='id'
                                );

                                CREATE INDEX IF NOT EXISTS idx_timestamp ON clipboard (create_time DESC);
                                CREATE INDEX IF NOT EXISTS idx_source ON clipboard (source);
                                CREATE INDEX IF NOT EXISTS idx_favorite ON clipboard (is_favorite);

                                CREATE TRIGGER IF NOT EXISTS clipboard_after_insert
                                AFTER INSERT ON clipboard
                                BEGIN
                                    INSERT INTO clipboard_fts (rowid, content) VALUES (new.id, new.content);
                                END;

                                CREATE TRIGGER IF NOT EXISTS clipboard_after_update
                                AFTER UPDATE ON clipboard
                                BEGIN
                                    UPDATE clipboard_fts SET content = new.content WHERE rowid = old.id;
                                END;

                                CREATE TRIGGER IF NOT EXISTS clipboard_after_delete
                                AFTER DELETE ON clipboard
                                BEGIN
                                    DELETE FROM clipboard_fts WHERE rowid = old.id;
                                END;
                            "#
                        }
                    ]
                )
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![close_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn close_app(window: tauri::Window) {
    window.close().unwrap();
}
