//! macOS 平台实现：NSWorkspace 激活通知（前台切换事件）+
//! CoreGraphics 空闲查询（手动 extern 绑定）+ NSImage 图标转 PNG。

#[cfg(target_os = "macos")]
use super::{state, Sample};
use block2::RcBlock;
use objc2_app_kit::{
NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace,
NSWorkspaceDidActivateApplicationNotification,
};
use objc2_foundation::NSNotification;
use std::ptr::NonNull;
/// 注册激活通知观察者：NSWorkspace 通知由系统在应用激活时投递，无切换时零开销。
/// 观察者与 block 刻意泄漏（应用生命周期内常驻，无需释放）。
pub fn start() {
unsafe {
    let workspace = NSWorkspace::sharedWorkspace();
    let center = workspace.notificationCenter();
    // NSWorkspace 为线程安全接口，回调里直接重取前台应用（thread-safe）
    let block = RcBlock::new(|_notification: NonNull<NSNotification>| {
        if let Some(sample) = foreground_sample() {
            state().on_switch(sample);
        }
    });
    let observer = center.addObserverForName_object_queue_usingBlock(
        Some(NSWorkspaceDidActivateApplicationNotification),
        None,
        None,
        &block,
    );
    std::mem::forget(observer);
    std::mem::forget(block);
}
}
/// 前台应用采样：localizedName + icon（NSImage → TIFF → NSBitmapImageRep → PNG data URL）
fn sample_frontmost() -> Option<Sample> {
unsafe {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let name = app.localizedName().map(|n| n.to_string())?;
    let icon = app.icon().and_then(|image| {
        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::initWithData(
            objc2_app_kit::NSBitmapImageRep::alloc(),
            &tiff,
        )?;
        let png = rep.representationUsingType_properties(
            NSBitmapImageFileType::PNG,
            &objc2_foundation::NSDictionary::new(),
        )?;
        Some(super::encode_data_url(png.to_vec()))
    });
    Some(Sample { name, icon })
}
}
pub fn foreground_sample(_app: &tauri::AppHandle) -> Option<Sample> {
sample_frontmost()
}
pub fn idle_secs() -> u64 {
// CoreGraphics 手动绑定：kCGEventSourceStateHIDSystemState = 1，kCGAnyInputEventType = u64::MAX
unsafe { CGEventSourceSecondsSinceLastEventType(1, u64::MAX) as u64 }
}
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
fn CGEventSourceSecondsSinceLastEventType(state_id: u32, mask: u64) -> f64;
}

