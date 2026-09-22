//! 通用命令域（原 commands.rs 模块化拆分）：
//! - `paste`：粘贴模拟 + 全局粘贴/剪切感知（平台钩子）
//! - `menu`：原生菜单主题（Windows uxtheme SetPreferredAppMode）
//! - `lifecycle`：应用退出
//!
//! generate_handler 按 `<模块路径>::__cmd__<命令名>` 解析包装宏，故 lib.rs 注册
//! 使用完整子模块路径（commands::paste::paste 等）；本模块仅再导出非命令
//! 入口（lib.rs setup 直接调用的函数），保持 `commands::register_global_paste_hotkey` 路径。

pub mod lifecycle;
pub mod menu;
pub mod paste;

pub use paste::register_global_paste_hotkey;
