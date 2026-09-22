//! 事件名常量集中：
//! Tauri emit/listen 的事件名字符串散落在多个模块，集中常量防拼写漂移。
//! 仅提取字符串常量，事件名与载荷字段不变。
//! （前端同窗口事件总线 bus 的 clipboard:changed / island:copy 等不经过 Rust，不在此列。）

/// 全局粘贴感知（Rust 钩子 → 前端灵动岛"已粘贴"）
pub const ISLAND_PASTE_DETECTED: &str = "island:paste-detected";
/// 全局剪切感知（Rust 钩子 → 前端灵动岛"已剪切"）
pub const ISLAND_CUT_DETECTED: &str = "island:cut-detected";
/// 灵动岛显示事件（出站桥监听：应用内岛事件 → SSE/Webhook 汇聚点）
pub const ISLAND_SHOW: &str = "island:show";
/// 第三方 API 显示请求（island_api HTTP → 前端弹岛）
pub const ISLAND_API_SHOW: &str = "island-api:show";
/// API 服务启动失败通知（端口占用等）
pub const ISLAND_API_FAILED: &str = "island-api:failed";
/// 灵动岛历史查询（HTTP 线程 → 主窗口查库，前端经 island_history_result 回传）
pub const ISLAND_HISTORY_QUERY: &str = "island-history:query";
/// AI 流式响应分片（ai 命令 → 前端渲染）
pub const AI_CHUNK: &str = "ai:chunk";
