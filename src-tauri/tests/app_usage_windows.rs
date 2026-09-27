//! Windows 平台应用图标提取集成测试（`cargo test --test app_usage_windows` 运行）。
//! 被测对象：`app_usage::windows` 的 `icon_of_app`——枚举系统进程 → exe 全路径 →
//! SHGetFileInfo → HICON → PNG data URL 的真机全链路。
//! 仅 Windows 可编译：文件级 `#![cfg(windows)]` 守卫，非 Windows 目标下为空文件。

#![cfg(windows)]

use app_lib::windows::icon_of_app;

/// 真机链路自检：explorer 常驻运行，icon_of_app 应能走通
/// 进程枚举 → 路径查询 → SHGetFileInfo → PNG data URL 全链路
#[test]
fn icon_of_running_process_returns_data_url() {
    let icon = icon_of_app("explorer").expect("explorer 应能提取到图标");
    assert!(icon.starts_with("data:image/png;base64,"), "应为 PNG data URL");
    assert!(icon.len() > 100, "data URL 不应为空");
    // 带旧式 .exe 后缀的名字（历史 source_app 数据）也应匹配成功
    let icon2 = icon_of_app("explorer.exe").expect("带 .exe 后缀的名字也应能提取");
    assert!(icon2.starts_with("data:image/png;base64,"));
}
