CREATE TABLE IF NOT EXISTS clipboard
(
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    content     TEXT NOT NULL UNIQUE,
    create_time TEXT default datetime('now'),
    source      TEXT,
    is_favorite INTEGER DEFAULT 0 CHECK (is_favorite IN (0, 1)),
    category    TEXT,
    count       INTEGER DEFAULT 1,
    last_use    TEXT default datetime('now')
);
INSERT INTO clipboard (content, create_time, source, is_favorite, category, last_use)
VALUES
    ('这是一个测试剪贴板内容。', '2023-10-01 12:34:56', '电脑', 0, '文本', '2023-10-01 12:34:56'),
    ('SELECT * FROM users;', '2023-10-01 13:34:56', '数据库', 1, 'SQL', '2023-10-02 10:00:00'),
    ('https://www.example.com/', '2023-10-01 14:34:56', '浏览器', 0, '链接', '2023-10-01 14:34:56');


create table if not exists todo
(
    id          text primary key,
    title       text not null,
    description text,
    completed   int  not null check ( completed in (0, 1) ),
    priority    text check ( priority in ('low', 'medium', 'high')),
    category    text,
    createdAt   text,
    updatedAt   text,
    dueDate     text
);

INSERT INTO todo (id, title, description, completed, priority, category, createdAt, updatedAt, dueDate)
VALUES
    ('1', '完成项目报告', '撰写并提交项目报告', 0, 'high', '工作', '2023-10-01 09:00:00', '2023-10-01 09:00:00', '2023-10-15'),
    ('2', '购买生活用品', '购买牛奶、面包和水果', 0, 'medium', '生活', '2023-10-01 10:00:00', '2023-10-01 10:00:00', '2023-10-05'),
    ('3', '准备周末聚会', '购买食材并邀请朋友', 0, 'low', '社交', '2023-10-01 11:00:00', '2023-10-01 11:00:00', '2023-10-07');


create table if not exists note
(
    id        text primary key,
    content   text not null,
    color     text,
    createAt  text,
    updatedAt text
);

INSERT INTO note (id, content, color, createAt, updatedAt)
VALUES
    ('1', '今天天气很好，打算去公园散步。', 'yellow', '2023-10-01 08:00:00', '2023-10-01 08:00:00'),
    ('2', '会议要点：需要尽快完成项目A，并与团队成员同步进度。', 'blue', '2023-10-01 09:15:00', '2023-10-01 09:15:00'),
    ('3', '食谱：烤鸡配蔬菜。', 'green', '2023-10-01 11:30:00', '2023-10-01 11:30:00');

CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5
(
    content,
    content='clipboard',
    content_rowid='id'
);

CREATE TABLE IF NOT EXISTS settings
(
    id            INTEGER PRIMARY KEY,
    key           TEXT NOT NULL UNIQUE,
    value         TEXT,
    type          TEXT NOT NULL CHECK (type IN ('general', 'other', 'ai_setting')),
    description   TEXT,
    scope         TEXT,
    last_modified TEXT
);

INSERT INTO settings (key, value, type, description, scope, last_modified)
VALUES ('max_clip_save_count', '500', 'general', '剪贴板最大保存数量', 'global', DATETIME('now'));
INSERT INTO settings (key, value, type, description, scope, last_modified)
VALUES ('max_todo_save_count', '500', 'general', 'todo最大保存数量', 'global', DATETIME('now'));
INSERT INTO settings (key, value, type, description, scope, last_modified)
VALUES ('max_note_save_count', '500', 'general', 'note最大保存数量', 'global', DATETIME('now'));
INSERT INTO settings (key, value, type, description, scope, last_modified)
VALUES ('color_scheme', 'dark', 'general', '配色', 'global', DATETIME('now'));

INSERT INTO settings (key, value, type, description, scope, last_modified)
VALUES ('api_key', NULL, 'ai_setting', 'api设置', 'global', DATETIME('now'));

create table if not exists setting_shortcut
(
    id        integer primary key autoincrement,
    key       text title not null ,
    scope  text not null check ( scope in ('global','local')),
    description text ,
    createdAt text not null ,
    updatedAt text not null
);

insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('CommandOrControl_I', 'global','显示与隐藏窗口', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('Escape', 'local','隐藏窗口', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('ArrowUp', 'local','选择上一项', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('ArrowDown', 'local','选择下一项', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('CommandOrControl+F', 'local','搜索', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('delete', 'local','搜索', DATETIME('now'),DATETIME('now'));
insert into setting_shortcut (key, scope, description, createdAt, updatedAt)
values ('I', 'local','收藏选择选项', DATETIME('now'),DATETIME('now'));

CREATE INDEX IF NOT EXISTS idx_timestamp ON clipboard (create_time DESC);
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