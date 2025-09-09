use std::thread::sleep;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app
                .get_webview_window("main")
                .expect("no main window")
                .set_focus();
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
CREATE TABLE IF NOT EXISTS clipboard
(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    source      TEXT,
    is_favorite INTEGER DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    category    TEXT,
    count       INTEGER DEFAULT 1,
    updated_at    DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5
(
    content,
    content='clipboard',
    content_rowid='id'
);

create table if not exists todo
(
    id          text primary key,
    title       text not null,
    description text,
    completed   int  not null check ( completed in (0, 1) ),
    priority    text check ( priority in ('low', 'medium', 'high')),
    category    text,
    created_at   text DEFAULT CURRENT_TIMESTAMP,
    updated_at   text,
    dueDate     text
);

create table if not exists note
(
    id        text primary key,
    content   text not null,
    color     text,
    created_at  text DEFAULT CURRENT_TIMESTAMP,
    updated_at text DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings
(
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    value         TEXT,
    type          TEXT NOT NULL CHECK (type IN ('shortcut', 'general', 'other', 'ai_setting')),
    description   TEXT,
    scope         TEXT,
    create_at  text DEFAULT CURRENT_TIMESTAMP,
    updated_at text DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO settings (key, value, type, description, scope, updated_at)
VALUES ('max_save_count', '500', 'general', '最大保存数量', 'global', DATETIME('now'));
INSERT INTO settings (key, value, type, description, scope, updated_at)
VALUES ('color_scheme', 'light', 'general', '最大保存数量', 'global', DATETIME('now'));

INSERT INTO settings (key, value, type, description, scope, updated_at)
VALUES ('api_key', NULL, 'ai_setting', 'api设置', 'global', DATETIME('now'));

-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_CommandOrControl_I', 'CommandOrControl+I', 'shortcut', '显示与隐藏窗口', 'global', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_Escape', 'Escape', 'shortcut', '隐藏窗口', 'global', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_ArrowUp', 'ArrowUp', 'shortcut', '选择上一项', 'local', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_ArrowDown', 'ArrowDown', 'shortcut', '选择下一项', 'local', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_CommandOrControl+F', 'CommandOrControl+F', 'shortcut', '搜索', 'local', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_delete', 'delete', 'shortcut', '删除选择项', 'local', DATETIME('now'));
-- INSERT INTO settings (key, value, type, description, scope, last_modified)
-- VALUES ('shortcut_I', 'I', 'shortcut', '收藏选择选', 'local', DATETIME('now'));

create table if not exists shortcut_setting
(
    id        integer primary key autoincrement,
    key       text title,
    shortcuts text
);

CREATE INDEX IF NOT EXISTS idx_timestamp ON clipboard (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source ON clipboard (source);
CREATE INDEX IF NOT EXISTS idx_favorite ON clipboard (is_favorite);

CREATE TRIGGER IF NOT EXISTS clipboard_after_insert
    AFTER INSERT
    ON clipboard
BEGIN
    INSERT INTO clipboard_fts (rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS clipboard_after_update
    AFTER UPDATE
    ON clipboard
BEGIN
    UPDATE clipboard_fts SET content = new.content WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS clipboard_after_delete
    AFTER DELETE
    ON clipboard
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
        .invoke_handler(tauri::generate_handler![close_app,paste])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn close_app(window: tauri::Window) {
    window.close().unwrap();
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn paste(window: tauri::Window) {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    sleep(Duration::from_millis(300));
    let mut enigo = Enigo::new(&Settings::default()).unwrap();

    enigo.key(Key::Control, Press).unwrap();
    enigo.key(Key::Unicode('v'), Click).unwrap();
    enigo.key(Key::Control, Release).unwrap();
}
