//! 截图（snip）域：整屏捕获 / 区域裁剪 / 写系统剪贴板 / 窗口探测 / 导出文件。
//!
//! 设计要点（详见 .docs/screenshot-spec.md）：
//! - GDI BitBlt 捕获：进程由 Tauri/tao 声明为 Per-Monitor-V2 DPI aware，GDI 坐标即
//!   物理像素，无需 HiDPI API；windows-sys 现有 features 全覆盖，零新增依赖。
//! - 先截屏后建覆盖窗（前端时序保证）：自绘遮罩不会入镜。
//! - 原图统一走 image_store 内容寻址落盘（imgfile: 引用），data URL 不跨 IPC。
//! - 非 Windows 平台命令返回 None / Err，由前端弹岛降级（平台矩阵见 spec §5）。

pub mod capture;
