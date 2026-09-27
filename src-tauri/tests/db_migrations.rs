//! 数据库迁移链集成测试（`cargo test --test db_migrations` 运行）。
//! 被测对象：`db::migrations::migrations()` 迁移链定义——无 sqlx 直接依赖
//! （迁移由 tauri-plugin-sql 在 Database.load 时执行），无法真跑 SQLite 迁移链，
//! 故做结构不变式与关键 DDL 的文本断言，防止误改迁移链。

use app_lib::migrations::{migrations, MigrationKind};

#[test]
fn versions_strictly_increasing_from_one() {
    let ms = migrations();
    assert_eq!(ms.len(), 17, "迁移数变化时本断言应同步更新");
    for (i, m) in ms.iter().enumerate() {
        assert_eq!(m.version, (i + 1) as i64, "版本号必须从 1 连续递增");
        assert!(matches!(m.kind, MigrationKind::Up));
    }
}

#[test]
fn descriptions_unique_and_sql_nonempty() {
    let ms = migrations();
    let mut descs: Vec<&str> = ms.iter().map(|m| m.description).collect();
    descs.sort_unstable();
    let before = descs.len();
    descs.dedup();
    assert_eq!(descs.len(), before, "description 不得重复（迁移链唯一标识语义）");
    for m in &ms {
        assert!(!m.sql.trim().is_empty(), "v{} 迁移 SQL 为空", m.version);
    }
}

#[test]
fn v1_creates_core_tables() {
    let v1 = &migrations()[0];
    assert!(v1.sql.contains("CREATE TABLE IF NOT EXISTS clipboard"));
    assert!(v1.sql.contains("USING fts5"));
    assert!(v1.sql.contains("create table if not exists todo"));
    assert!(v1.sql.contains("create table if not exists note"));
    assert!(v1.sql.contains("CREATE TABLE IF NOT EXISTS settings"));
}

#[test]
fn chain_covers_expected_schema() {
    // 关键域表/列在迁移链中必须存在（按表名出现判定，不分版本）
    let all: String = migrations().iter().map(|m| m.sql).collect::<Vec<_>>().join("\n");
    for token in [
        "pinned_clip", "daily_stat", "app_usage", "app_icons",
        "clip_rules", "clip_templates", "shortcut_binding",
        "is_favorite", "updated_at",
    ] {
        assert!(all.contains(token), "迁移链缺少 {token}");
    }
}
