//! 能力抽象 trait：
//! 依赖抽象而非具体实现——命令层与出站桥只依赖以下接口，
//! 具体实现（文件系统图片存取 / 平台前台查询 / SSE+Webhook 出站）由 lib.rs 装配注入。
//! 事件名常量见 events.rs。

/// 剪贴板图片原文件存取抽象（原图不进 SQLite：DB 存 `imgfile:` 引用，文件落盘 images/）。
/// 具体实现 image_store::FsImageStore（sha256 内容寻址去重 + 20MB 上限 + 文件名消毒防穿越）。
pub(crate) trait ImageStore {
    /// 保存原图（data URL / 裸 base64）→ `imgfile:<文件名>` 引用；解码失败/超限返回 None
    fn save(&self, data_url: &str) -> Option<String>;
    /// 读取原图 → data URL；文件缺失/非法文件名返回 None
    fn read(&self, file: &str) -> Option<String>;
    /// 删除原图文件（不存在视为已删除，幂等 true）
    fn delete(&self, file: &str) -> bool;
    /// 列举 images 目录全部图片文件（文件名 + 字节数）：磁盘占用清理策略的输入
    fn list(&self) -> Vec<ImageFileEntry>;
    /// 批量删除原图文件（逐个消毒 + 幂等删除），返回成功删除个数
    fn delete_batch(&self, files: &[String]) -> usize;
}

/// 磁盘图片清单条目（清理策略输入 / 前端展示）：文件名 + 字节数。
/// pub：随 image_store::list_from_dir 的对外（tests/ 集成测试）签名暴露。
#[derive(serde::Serialize)]
pub struct ImageFileEntry {
    pub name: String,
    pub size: u64,
}

/// 前台应用查询抽象（clip.source_app 来源标记）。
/// 具体实现 app_usage::PlatformForegroundSource（Windows UIA / macOS AX / Linux AT-SPI 保守放行）。
pub(crate) trait ForegroundSource {
    /// 当前前台进程名；取不到返回 None（宁缺勿错，调用方不标记）
    fn foreground_name(&self, app: &tauri::AppHandle) -> Option<String>;
}

/// 灵动岛出站汇聚抽象：应用内岛显示事件的双通道出站（SSE 广播 + Webhook 投递）。
/// 具体实现 island_api::OutboundIslandSink；无订阅者/未配置时零开销。
pub(crate) trait IslandSink {
    /// 派发一条岛显示事件（内部异步，不阻塞调用方）
    fn send(&self, event: &serde_json::Value);
}

// ===================== managed state 包装（State 需具体类型） =====================

/// Tauri managed state 包装：State<'_, T> 要求具体类型，trait 对象以 Arc 存于字段。
/// 命令参数中的 State 不进 invoke 载荷，前端 invoke 签名不受影响。
/// pub：命令经 lib.rs pub use 重导出后进入对外（tests/）接口，包装类型须同步公开。
pub struct ImageStoreHandle(pub(crate) std::sync::Arc<dyn ImageStore + Send + Sync>);

pub struct ForegroundSourceHandle(
    pub(crate) std::sync::Arc<dyn ForegroundSource + Send + Sync>,
);
