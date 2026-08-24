use std::thread::sleep;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 应用只允许运行一个实例。二次启动时唤醒已有实例的主窗口：
            // 主窗口可能处于隐藏（后台驻留）或最小化状态，需 show + unminimize + set_focus
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
                .add_migrations(
                    "sqlite:s1d3_board.db",
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
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    source      TEXT,
    is_favorite INTEGER DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    category    TEXT,
    count       INTEGER DEFAULT 1,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
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
                        },
                        Migration {
                            version: 2,
                            description: "Drop orphan shortcut_setting table, add normalized shortcut_binding table",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 删除 v1 中定义但从未使用的孤儿表（列定义非法且职责被 settings 表取代）
DROP TABLE IF EXISTS shortcut_setting;

-- 规范化快捷键绑定表，与通用 settings KV 解耦，便于未来扩展（多套方案/分组/用户维度）
CREATE TABLE IF NOT EXISTS shortcut_binding
(
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcut_id   TEXT NOT NULL UNIQUE,
    key           TEXT NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('global', 'local')),
    description   TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shortcut_scope ON shortcut_binding (scope);
                            "#
                        },
                        Migration {
                            version: 3,
                            description: "Add type column to clipboard, restrict FTS to text only",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 新增 type 列，区分文本(text)与图片(image)
ALTER TABLE clipboard ADD COLUMN type TEXT DEFAULT 'text'
    CHECK (type IN ('text', 'image'));

-- 图片不进全文索引：删除并重建触发器，仅当 type='text' 时同步 FTS
DROP TRIGGER IF EXISTS clipboard_after_insert;
DROP TRIGGER IF EXISTS clipboard_after_update;
DROP TRIGGER IF EXISTS clipboard_after_delete;

CREATE TRIGGER IF NOT EXISTS clipboard_after_insert
    AFTER INSERT
    ON clipboard
BEGIN
    INSERT INTO clipboard_fts (rowid, content)
    SELECT new.id, new.content WHERE new.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS clipboard_after_update
    AFTER UPDATE
    ON clipboard
BEGIN
    DELETE FROM clipboard_fts WHERE rowid = old.id;
    INSERT INTO clipboard_fts (rowid, content)
    SELECT new.id, new.content WHERE new.type = 'text';
END;

CREATE TRIGGER IF NOT EXISTS clipboard_after_delete
    AFTER DELETE
    ON clipboard
BEGIN
    DELETE FROM clipboard_fts WHERE rowid = old.id;
END;

-- 重建 FTS：清除历史数据中的图片 base64（如有），仅保留文本
INSERT INTO clipboard_fts (clipboard_fts) VALUES ('rebuild');
                            "#
                        },
                        Migration {
                            version: 4,
                            description: "Create pinned_clip table for quick clipboard (frequently used) items",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 常用剪贴（快捷功能）表：可排序、可编辑；文本可改内容，图片仅支持替换
CREATE TABLE IF NOT EXISTS pinned_clip
(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'image')),
    name        TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pinned_sort ON pinned_clip (sort_order);
                            "#
                        },
                        Migration {
                            version: 5,
                            description: "Add source and pinned_at columns to pinned_clip",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 来源应用（从剪贴板添加时带入；手动新增可为空）
ALTER TABLE pinned_clip ADD COLUMN source TEXT;
-- 置顶时间（置顶后按此排序置顶优先；为空表示未置顶）
ALTER TABLE pinned_clip ADD COLUMN pinned_at TEXT;
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

#[tauri::command]
fn paste(_window: tauri::Window) {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    sleep(Duration::from_millis(300));
    let mut enigo = Enigo::new(&Settings::default()).unwrap();

    // 跨平台粘贴：macOS 使用 Command(meta)+V，其余使用 Ctrl+V
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Press).unwrap();
    enigo.key(Key::Unicode('v'), Click).unwrap();
    enigo.key(modifier, Release).unwrap();
}
