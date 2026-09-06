//! 其余平台：空实现（应用时长统计不可用，采样恒为 None）。

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn start() {}
pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<super::Sample> {
None
}
pub fn idle_secs() -> u64 {
0
}

