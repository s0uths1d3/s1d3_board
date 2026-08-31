use std::time::Duration;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

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
                        },
                        Migration {
                            version: 6,
                            description: "Create daily_stat table for permanent usage statistics",
                            kind: MigrationKind::Up,
                            sql: r#"
CREATE TABLE IF NOT EXISTS daily_stat
(
    stat_date       TEXT PRIMARY KEY,             -- 统计日期 YYYY-MM-DD（本地时区），一行一天
    clip_text       INTEGER NOT NULL DEFAULT 0,  -- 新增文本剪贴数
    clip_image      INTEGER NOT NULL DEFAULT 0,  -- 新增图片剪贴数
    clip_use        INTEGER NOT NULL DEFAULT 0,  -- 粘贴使用次数（Enter / Ctrl+数字）
    clip_chars      INTEGER NOT NULL DEFAULT 0,  -- 复制字符总量（文本剪贴时累加 content.length）
    todo_added      INTEGER NOT NULL DEFAULT 0,  -- 待办新增数
    todo_completed  INTEGER NOT NULL DEFAULT 0,  -- 待办完成数
    todo_deleted    INTEGER NOT NULL DEFAULT 0,  -- 待办删除数
    todo_chars      INTEGER NOT NULL DEFAULT 0,  -- 待办内容量（新建时累加标题+描述字符数）
    note_added      INTEGER NOT NULL DEFAULT 0,  -- 便签新增数
    note_deleted    INTEGER NOT NULL DEFAULT 0,  -- 便签删除数
    favorite_toggle INTEGER NOT NULL DEFAULT 0,  -- 收藏切换次数
    usage_seconds   INTEGER NOT NULL DEFAULT 0,  -- 当日窗口可见+聚焦时长（秒）
    shortcut_count  INTEGER NOT NULL DEFAULT 0,  -- 快捷键使用次数
    tab_clip        INTEGER NOT NULL DEFAULT 0,  -- 剪贴板 Tab 访问次数
    tab_todo        INTEGER NOT NULL DEFAULT 0,  -- 待办 Tab 访问次数
    tab_note        INTEGER NOT NULL DEFAULT 0,  -- 便签 Tab 访问次数
    tab_pinned      INTEGER NOT NULL DEFAULT 0,  -- 常用剪贴板 Tab 访问次数
    tab_setting     INTEGER NOT NULL DEFAULT 0,  -- 设置 Tab 访问次数
    tab_statistics  INTEGER NOT NULL DEFAULT 0,  -- 统计 Tab 访问次数
    active_dawn     INTEGER NOT NULL DEFAULT 0,  -- 清晨 05:00-08:59 操作次数
    active_day      INTEGER NOT NULL DEFAULT 0,  -- 白天 09:00-17:59 操作次数
    active_evening  INTEGER NOT NULL DEFAULT 0,  -- 晚间 18:00-22:59 操作次数
    active_night    INTEGER NOT NULL DEFAULT 0   -- 深夜 23:00-04:59 操作次数
);
                            "#
                        },
                        Migration {
                            version: 7,
                            description: "Add todo_chars column to daily_stat for todo content volume statistics",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 待办内容量：新建待办时累计标题+描述字符数（与 clip_chars 类似的"内容量"口径）
ALTER TABLE daily_stat ADD COLUMN todo_chars INTEGER NOT NULL DEFAULT 0;
                            "#
                        },
                        Migration {
                            version: 8,
                            description: "Add todo remind_mode/remind_at columns for smart due-time reminders",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 待办提醒：remind_mode = smart(智能默认)/off(不提醒)/custom(自定义)；NULL 视为 smart
-- remind_at = 自定义提醒时刻（本地 ISO YYYY-MM-DDTHH:mm，与 dueDate 同格式）
ALTER TABLE todo ADD COLUMN remind_mode TEXT;
ALTER TABLE todo ADD COLUMN remind_at TEXT;
-- 提醒触发次数统计
ALTER TABLE daily_stat ADD COLUMN todo_reminded INTEGER NOT NULL DEFAULT 0;
                            "#
                        },
                        Migration {
                            version: 9,
                            description: "Add todo priority_level (0-255) and migrate legacy priority tiers",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 数值化优先级：0-255，越大越优先；旧三档文本映射为 0/127/255
ALTER TABLE todo ADD COLUMN priority_level INTEGER;
UPDATE todo SET priority_level = CASE priority WHEN 'low' THEN 0 WHEN 'medium' THEN 127 WHEN 'high' THEN 255 ELSE 127 END;
                            "#
                        },
                        Migration {
                            version: 10,
                            description: "Add todo remind_rules JSON column for multiple custom reminder alarms",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 自定义提醒闹钟列表（JSON）：[{id,kind:'percent'|'offset'|'at',value}]
ALTER TABLE todo ADD COLUMN remind_rules TEXT;
                            "#
                        },
                        Migration {
                            version: 11,
                            description: "Drop write-only FTS index and triggers (search uses LIKE; FTS only added write overhead)",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 全文索引自创建以来从未被任何查询使用（前端搜索走 LIKE），
-- 每次剪贴板写入却要维护 1-3 次索引写，属于纯开销；删除触发器与索引表。
DROP TRIGGER IF EXISTS clipboard_after_insert;
DROP TRIGGER IF EXISTS clipboard_after_update;
DROP TRIGGER IF EXISTS clipboard_after_delete;
DROP TABLE IF EXISTS clipboard_fts;
                            "#
                        },
                        Migration {
                            version: 12,
                            description: "Add updated_at index for main clipboard list ordering",
                            kind: MigrationKind::Up,
                            sql: r#"
-- 主列表与裁剪查询均按 updated_at 排序（ORDER BY updated_at DESC/ASC），
-- 原 idx_timestamp 建在 created_at 上用不上，补齐对应索引。
CREATE INDEX IF NOT EXISTS idx_clip_updated ON clipboard (updated_at DESC);
                            "#
                        },
                        Migration {
                            version: 13,
                            description: "Drop unused pinned_clip sort_order index (sorting uses pinned_at/created_at)",
                            kind: MigrationKind::Up,
                            sql: r#"
-- sort_order 恒为 0，实际排序用 pinned_at/created_at，该索引无任何查询可用。
DROP INDEX IF EXISTS idx_pinned_sort;
                            "#
                        },
                        Migration {
                            version: 14,
                            description: "Fix color_scheme seed default to 'system' and correct its description",
                            kind: MigrationKind::Up,
                            sql: r#"
-- v1 误将 color_scheme 播种为 'light'（description 是复制的"最大保存数量"），
-- 与代码中"跟随系统（system）"的文档化默认值冲突，导致跟随系统永不生效；一次性纠正。
UPDATE settings SET value = 'system', description = '配色模式' WHERE key = 'color_scheme' AND value = 'light';
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
        .invoke_handler(tauri::generate_handler![paste, set_menu_theme, quit_app])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 在阻塞线程中模拟 Ctrl/Cmd+V；任何失败都以 Result 返回前端，而非 panic 整个进程。
fn paste_blocking() -> Result<(), String> {
    use enigo::{
        Direction::{Click, Press, Release},
        Enigo, Key, Keyboard, Settings,
    };

    // 等待前端完成"写系统剪贴板 → 隐藏窗口 → 焦点落回目标应用"后，再发送粘贴键
    std::thread::sleep(Duration::from_millis(300));
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| format!("初始化输入模拟失败: {e}"))?;

    // 跨平台粘贴：macOS 使用 Command(meta)+V，其余使用 Ctrl+V
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;

    enigo.key(modifier, Press).map_err(|e| format!("按下修饰键失败: {e}"))?;
    enigo.key(Key::Unicode('v'), Click).map_err(|e| format!("发送 V 键失败: {e}"))?;
    enigo.key(modifier, Release).map_err(|e| format!("释放修饰键失败: {e}"))?;
    Ok(())
}

/// async 命令在 Tauri 的异步线程池执行（而非主线程），配合 spawn_blocking
/// 保证 300ms 等待不阻塞 UI 事件循环；失败信息可被前端 invoke 的 catch 捕获。
#[tauri::command]
async fn paste() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(paste_blocking)
        .await
        .map_err(|e| format!("粘贴任务执行失败: {e}"))?
}

/// 真正退出程序（托盘「退出」菜单项调用）：直接结束整个进程。
/// 不能用窗口 close/destroy——标题栏 x 的 close 请求已被前端拦截为「隐藏到托盘」，
/// 且 destroy 主窗口在存在子窗口（图片查看器等）时不会结束进程；exit(0) 全部终结。
/// 统计落库由前端在调用本命令前完成（process exit 不触发 beforeunload）。
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Windows 原生菜单（托盘右键菜单等）的主题由进程级 PreferredAppMode 决定，
/// 默认跟随系统"应用模式"（系统深色 → 菜单暗色），window.setTheme 对其无效。
/// 应用配色切换时前端调用此命令强制菜单深浅色，使托盘菜单跟随应用配色。
/// 实现使用 uxtheme.dll 未公开导出 SetPreferredAppMode（ordinal 135，Win10 1809+ 稳定）；
/// 非 Windows 平台为 no-op（原生菜单本就跟随系统）。
#[tauri::command]
fn set_menu_theme(theme: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // PreferredAppMode 枚举值（undocumented，与微软官方内部定义一致）
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

/// Windows: 动态加载 uxtheme.dll 的 SetPreferredAppMode（ordinal 135）并调用。
/// 函数指针用 OnceLock 缓存（库句柄由进程持有不卸载，指针长期有效）；解析失败静默忽略。
#[cfg(target_os = "windows")]
fn apply_preferred_app_mode(mode: i32) {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    type SetPreferredAppModeFn = unsafe extern "system" fn(i32) -> i32;
    static SET_PREFERRED_APP_MODE: OnceLock<Option<SetPreferredAppModeFn>> = OnceLock::new();

    let f = *SET_PREFERRED_APP_MODE.get_or_init(|| unsafe {
        // uxtheme 可能尚未被进程加载，先 GetModuleHandleW 再回退 LoadLibraryW（Win32_Foundation）
        let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
        let mut handle = GetModuleHandleW(name.as_ptr());
        if handle.is_null() {
            handle = windows_sys::Win32::System::LibraryLoader::LoadLibraryW(name.as_ptr());
        }
        if handle.is_null() {
            return None;
        }
        // 序号 135：MAKEINTRESOURCEA(135) 等价于把序号转为伪指针
        let addr = GetProcAddress(handle, 135 as *const u8);
        addr.map(|a| std::mem::transmute::<unsafe extern "system" fn() -> isize, SetPreferredAppModeFn>(a))
    });

    if let Some(f) = f {
        unsafe { f(mode) };
    }
}
