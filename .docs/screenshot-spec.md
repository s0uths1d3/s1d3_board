# 截图功能实现规格书（screenshot spec）

> **本文档是唯一实现依据**：执行时禁止自创任何命名/事件/键名/文案——全部以 §1 标识符总表为准；禁止更改既有架构决策——所有「照抄样板」给出了精确 `file:line`，先读样板再动手。
> 设计定稿于 2026-10-24（`dev` 分支），状态：**P0/P1/P2 全部实现（P0/P1 于 2026-10-24；P2 长截图 / AI 识图 / OCR 于 2026-11-11，仅 Windows 验证）**。功能概览见 [features/screenshot.md](./features/screenshot.md)。
> 实现偏差记录：截图入库走 `clipboardListener.saveSnipToHistory` 直存（抑制窗口存活于该模块仓储闭包内，spec 原文的 dbService 门面路线不满足单实例语义）；统计埋点由 saveClipboard 内部记录 + confirmSnip 显式 `clip_screenshot` 计数，未按 P0 原文重复记 `clip_image`。

---

## 目录

- [§0 执行须知](#0-执行须知)
- [§1 标识符总表（唯一命名来源）](#1-标识符总表唯一命名来源)
- [§2 P0 核心闭环实现规格](#2-p0-核心闭环实现规格)
- [§3 P1 增强实现规格](#3-p1-增强实现规格)
- [§4 P2 占位（本轮不实现）](#4-p2-占位本轮不实现)
- [§5 平台支持矩阵](#5-平台支持矩阵)
- [附录 A 新建/修改文件总表](#附录-a-新建修改文件总表)
- [附录 B 双语文案总表（直接可抄）](#附录-b-双语文案总表直接可抄)
- [附录 C 分批验收清单](#附录-c-分批验收清单)

---

## 0. 执行须知

### 0.1 执行顺序

严格按批次执行：**P0-T1 → T12 依序**（Rust 命令先行，前端命令/窗口/页面随后，岛与设置收尾），P1 同理。每完成一个任务先过该任务「验收」，再进入下一个。每完成一批执行附录 C 的整批验收。

### 0.2 禁止事项（每条都是既有架构约定）

1. **禁止 `v-html`**：全代码库无此用法（markdown 渲染都是 token 驱动），截图 UI 一律模板 + canvas。
2. **禁止进入系统 fullscreen**：能力未授权（`src-tauri/capabilities/default.json:16-67` 无 `allow-set-fullscreen`）且无必要——覆盖窗用「显示器逻辑边界铺满 + alwaysOnTop」实现（照 ring 模式）。
3. **禁止把原图 data URL 经 `emit`/`emitTo` 跨窗口传递**：多 MB base64 过 IPC 是本代码库已消灭的延迟模式（见 `src-tauri/src/clipboard/thumb.rs:129-146` 注释）。跨窗只传 `imgfile:` 引用，接收方按需 `read_clipboard_image_file` 读盘。
4. **写系统剪贴板前必须先调双抑制**：`suppressIslandCopy()`（`app/composables/useCopyIsland.ts:229-232`）+ `dbService.suppressUseCountBump()`（`app/src/db/dbService.ts:79-81`）。不抑制会导致「已复制」误报岛与使用计数双计。
5. **禁止新增 DB 条目类型**：截图条目一律 `type='image'` + `source_app='s1d3-board'` 区分。不改 `pinned_clip` schema，不改 `entities.ts` 的类型联合。
6. **禁止动 ClipboardData/保存链路的既有语义**：`saveClipboard` 的 `source_app`/`qr_text` 仅新插入时写入（`app/src/core/db/repositories/clipboardRepository.ts:124-126`），截图直接调用即可，勿改仓储。
7. **隐私模式语义**：`isPrivacyPaused()` 为真时截图仍可用（用户主动操作），但**不落库、不弹岛、不计数**（与 `showIsland` 总入口拦截一致，`useCopyIsland.ts:531`）。
8. **不隐藏主窗口再截图**：允许用户截面板自身；覆盖窗不得入镜由「先截屏后建窗」的时序保证（P0-T7）。
9. **Rust 命令错误处理双模式**：前端有兜底链路的返回 `Option<T>`；用户可见错误返回 `Result<T, String>` 且 `map_err(|e| format!("中文提示: {e}"))`（惯例见 `src-tauri/src/commands/backup.rs:42-48`）。
10. **重活 async**：编码/落盘/读盘类命令必须 `async fn` 离开主线程（惯例见 `thumb.rs:148-154` 注释）。

### 0.3 每批通用验证

- Rust 改动后：`cd src-tauri && cargo check`（零 error 零 warning 新增）。
- 前端改动后：`npx vitest run`（346+ 用例全过）与 `npx vue-tsc --noEmit`（零输出）。
- 手测：`npm run tauri:dev`（端口 12321）。

---

## 1. 标识符总表（唯一命名来源）

### 1.1 快捷键

| 项 | 值 |
|---|---|
| 命令 id | `screenshot` |
| 默认键 | `Control+Alt+A` |
| scope | `global` |
| i18n title key | `shortcut.screenshot` |

### 1.2 窗口与事件

| 项 | 值 | 说明 |
|---|---|---|
| 覆盖窗 label | `snip-overlay-<ts>` | ts=Date.now()，每次会话新建 |
| 贴图窗 label | `snip-pin-<contentHash8>` | contentHash8=裁剪结果引用去前缀后前 8 字符（P1） |
| 覆盖窗路由 | `/snip` | 新建 `app/pages/snip.vue` |
| 贴图窗路由 | `/snip-pin/<hash>` | 新建动态页（P1） |
| ready 握手（页面→管理器） | `snip:ready`，payload=label 字符串 | 照 `bubble:ring:ready`（`BubbleToggleCommand.ts:115-123`） |
| 数据下发（管理器→页面，emitTo 定向） | `snip:data`，payload 见 P0-T7 | |
| 确认（页面→管理器，全局 emit） | `snip:confirm`，payload `{ x, y, w, h }`（**物理像素整数**，选区在截屏图上的坐标） | |
| 取消（页面→管理器） | `snip:cancel` | |
| 贴图请求（页面→管理器） | `snip:pin`（P1，payload 同 confirm） | |
| 延时倒计时通知 | 复用 `notifyIsland({ kind:'info', ... })` | |

### 1.3 KV 设置键（settings 表，全部经 `dbService.getKeyValue/setKeyValue`）

| 键 | 类型/默认 | 说明 |
|---|---|---|
| `snip_enabled` | '1'/'0'，默认 '1' | 截图功能总开关（关闭后快捷键弹岛提示） |
| `snip_auto_copy` | '1'/'0'，默认 '1' | 确认后自动写系统剪贴板 |
| `snip_auto_history` | '1'/'0'，默认 '1' | 确认后自动入剪贴板历史 |
| `snip_format` | 'png'/'jpeg'，默认 'png' | 保存到文件的格式 |
| `snip_jpeg_quality` | 数字字符串，默认 '90'，范围 60~100 | jpeg 质量 |
| `snip_mask_opacity` | 数字字符串，默认 '40'，范围 10~80 | 选区外遮罩不透明度（百分比） |
| `snip_capture_cursor` | '1'/'0'，默认 '0' | 截屏是否包含鼠标光标（P1 实现绘制，P0 仅存设置） |
| `snip_save_dir` | 字符串，默认 ''（空=每次询问） | 保存到文件的默认目录 |
| `snip_delay_sec` | 数字字符串，默认 '0'，范围 0~5 | 延时截图秒数（P1 实现，P0 仅存设置） |

### 1.4 Rust invoke 命令（新模块 `src-tauri/src/snip/`）

| 命令名 | 签名（简化） | 返回 |
|---|---|---|
| `snip_capture_screen` | `async fn(app) -> Option<SnipCapture { file_ref, x, y, width, height }>` | 光标所在显示器整屏截图落盘；x/y/w/h 为**物理像素** |
| `snip_crop_region` | `async fn(app, file_ref, x: i32, y: i32, w: i32, h: i32) -> Option<SnipCrop { file_ref, thumb, qr_text, width, height }>` | 物理像素坐标裁剪 |
| `snip_write_clipboard_dib` | `async fn(app, file_ref) -> Result<(), String>` | 读盘→构造 CF_DIB→SetClipboardData |
| `snip_windows_at_point` | `fn(x: i32, y: i32) -> Option<SnipWindowRect { x, y, w, h }>` | 光标处根窗口矩形（物理像素） |
| `snip_export_file` | `async fn(app, file_ref, dest_path) -> Result<(), String>` | 把 imgfile 引用指向的 PNG 复制到任意路径（保存到文件用） |

### 1.5 岛与统计

| 项 | 值 |
|---|---|
| 岛 kind | `screenshot`（新增到 `IslandKind`，`app/composables/useCopyIsland.ts:106`） |
| 岛标签 i18n | `island.screenshot`（「已截图」/「Screenshot captured」） |
| 岛历史类型 i18n | `island_history.type_screenshot` |
| 统计字段（P1） | `clip_screenshot`（`StatField` + `DEFAULT_RANGE_FIELDS` + `daily_stat` 列） |
| 来源应用标记 | 常量字符串 `'s1d3-board'`（写入 `source_app`） |

### 1.6 前端模块命名

| 项 | 值 |
|---|---|
| 设置 composable | `app/src/snip/snipSettings.ts`（导出 `useSnipEnabled` 等，见 P0-T12） |
| 覆盖窗管理器 | `app/src/snip/snipManager.ts`（导出 `openSnip`/`closeSnip`/`isSnipOpen`） |
| 选区几何纯函数 | `app/src/snip/selection.ts`（`clampRect`/`hitTestHandle`/`rectFromDrag`，vitest 覆盖） |
| 全局命令 | `app/src/commands/global/ScreenshotCommand.ts` |

---

## 2. P0 核心闭环实现规格

> P0 交付：`Ctrl+Alt+A` → 光标所在屏冻结截屏覆盖窗 → 拖拽框选（十字线/尺寸提示/放大镜取色/窗口吸附）→ Enter 或工具条确认 → 裁剪 → 写系统剪贴板 + 入剪贴板历史 + 岛「已截图」→ 保存到文件可选。

### P0-T1 Rust 模块骨架与整屏捕获 `snip_capture_screen`

**文件**：新建 `src-tauri/src/snip/mod.rs`、`src-tauri/src/snip/capture.rs`；修改 `src-tauri/src/lib.rs`（模块声明 + 命令注册）。

**mod.rs**（职责注释 + 再导出，照 `src-tauri/src/commands/mod.rs` 风格）：

```rust
pub mod capture;
```

**capture.rs 骨架**（所有 Win32 API 已在启用 feature 内，**Cargo.toml 零改动**；GDI 系列在 `Win32_Graphics_Gdi`，`GetCursorPos`/`POINT`/`RECT` 在 `Win32_Foundation`，均已启用——见 `src-tauri/Cargo.toml:66-82`）：

```rust
//! 截图捕获：GDI BitBlt 整屏/区域捕获。进程由 Tauri/tao 声明为 Per-Monitor-V2 DPI aware，
//! GDI 坐标即物理像素，无需 HiDPI API。先截屏后建覆盖窗（防自绘遮罩入镜）。

use serde::Serialize;
use tauri::AppHandle;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipCapture {
    pub file_ref: String,   // imgfile: 引用（整屏 PNG 已落盘）
    pub x: i32, pub y: i32, // 光标所在显示器左上角（物理像素，屏幕全局坐标）
    pub width: i32, pub height: i32,
}

/// 光标所在显示器整屏截图（P0 单屏语义：光标在哪屏截哪屏）。
#[tauri::command]
pub async fn snip_capture_screen(app: AppHandle) -> Option<SnipCapture> {
    #[cfg(target_os = "windows")]
    {
        let rect = cursor_monitor_rect()?;          // 见下
        let (w, h, rgba) = blit_capture(&rect)?;    // 见下
        let dir = crate::clipboard::image_store::images_dir(&app)?;
        let file_ref = crate::clipboard::image_store::save_rgba_to_dir(&dir, w, h, &rgba)?;
        Some(SnipCapture { file_ref, x: rect.left, y: rect.top, width: w as i32, height: h as i32 })
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = app; None } // 非 Windows P0 不支持，前端走岛提示降级
}

#[cfg(target_os = "windows")]
fn cursor_monitor_rect() -> Option<windows_sys::Win32::Foundation::RECT> {
    use windows_sys::Win32::Foundation::{GetCursorPos, POINT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITOR_DEFAULTTONEAREST, MONITORINFO,
    };
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 { return None; }
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) == 0 { return None; }
        Some(mi.rcMonitor) // 物理像素
    }
}

#[cfg(target_os = "windows")]
fn blit_capture(rect: &windows_sys::Win32::Foundation::RECT) -> Option<(u32, u32, Vec<u8>)> {
    use windows_sys::Win32::Foundation::{RECT, ReleaseDC};
    use windows_sys::Win32::Graphics::Gdi::*;
    unsafe {
        let hdc_screen = GetDC(std::ptr::null_mut());
        if hdc_screen.is_null() { return None; }
        let w = (rect.right - rect.left).max(1);
        let h = (rect.bottom - rect.top).max(1);
        let hdc_mem = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, w, h);
        let old = SelectObject(hdc_mem, hbmp as _);
        // CAPTUREBLT：包含分层窗口；个别驱动会闪一下光标，主流截图工具均如此取舍
        let ok = BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT);
        let mut result = None;
        if ok != 0 {
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = w;
            bi.bmiHeader.biHeight = -h; // 负高 = top-down，免行序翻转
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 32;
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let got = GetDIBits(hdc_mem, hbmp, 0, h as u32, buf.as_mut_ptr().cast(), &mut bi, DIB_RGB_COLORS);
            if got == h {
                for px in buf.chunks_exact_mut(4) { px.swap(0, 2); } // BGRA→RGBA
                result = Some((w as u32, h as u32, buf));
            }
        }
        SelectObject(hdc_mem, old);
        DeleteObject(hbmp as _);
        DeleteDC(hdc_mem);
        ReleaseDC(std::ptr::null_mut(), hdc_screen);
        result
    }
}
```

**前置小改动**：`src-tauri/src/clipboard/image_store.rs` 的 `images_dir`（:29-35）当前可能为私有——改为 `pub(crate)`；`lib.rs` 顶部模块声明区加 `mod snip;`。

**lib.rs 注册**：`generate_handler![...]` 列表（`src-tauri/src/lib.rs:99-132`）末尾追加 `snip::capture::snip_capture_screen,`（完整路径惯例）。

**验收**：`cargo check` 通过；临时用 tauri devtools 控制台 `invoke('snip_capture_screen')` 返回 `{ fileRef: 'imgfile:xxx.png', x, y, width, height }`，且 `%APPDATA%/S1d3Board/images/` 出现整屏 PNG。

### P0-T2 裁剪 `snip_crop_region`

**文件**：`src-tauri/src/snip/capture.rs` 追加；`image_store.rs` 与 `thumb.rs` 各一处可见性调整。

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipCrop {
    pub file_ref: String,
    pub thumb: Option<String>,   // 384px PNG data URL（岛显示用）
    pub qr_text: Option<String>,
    pub width: i32, pub height: i32,
}

#[tauri::command]
pub async fn snip_crop_region(app: AppHandle, file_ref: String, x: i32, y: i32, w: i32, h: i32) -> Option<SnipCrop> {
    let dir = crate::clipboard::image_store::images_dir(&app)?;
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)?; // 新增，见下
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    if x < 0 || y < 0 || w <= 0 || h <= 0 { return None; }
    let cropped = image::imageops::crop_imm(&img, x as u32, y as u32, w as u32, h as u32).to_image();
    let (cw, ch) = (cropped.width(), cropped.height());
    let rgba = cropped.into_raw();
    let out_ref = crate::clipboard::image_store::save_rgba_to_dir(&dir, cw, ch, &rgba)?;
    let thumb = crate::clipboard::thumb::thumb_png(cw, ch, &rgba, 384); // 可见性调整，见下
    let qr_text = crate::clipboard::thumb::scan_qr_rgba(cw, ch, &rgba);
    Some(SnipCrop { file_ref: out_ref, thumb, qr_text, width: cw as i32, height: ch as i32 })
}
```

**image_store.rs 新增**（放在 `read_image_ref` :163 附近）：

```rust
/// imgfile: 引用 → 原图 PNG 原始字节（snip 裁剪/导出用；非法/缺失返回 None）。
pub(crate) fn read_png_bytes(app: &AppHandle, file_ref: &str) -> Option<Vec<u8>> {
    let name = file_ref.strip_prefix("imgfile:")?;
    if !valid_image_path(Path::new(name)) { return None; }
    images_dir(app).and_then(|dir| std::fs::read(dir.join(name)).ok())
}
```

**可见性调整**：`thumb.rs` 的 `thumb_png`（约 :310 区域，`parse_dib` 使用的 resize 辅助）与 `scan_qr_rgba`（:180）改为 `pub(crate)`。

**lib.rs 注册** `snip::capture::snip_crop_region`。

**验收**：`cargo check`；devtools 里对 T1 返回的 fileRef 裁 `(100,100,300,200)`，返回新 fileRef 且图片缓存目录出现对应小图。

### P0-T3 写系统剪贴板 `snip_write_clipboard_dib`

**文件**：`src-tauri/src/snip/capture.rs` 追加。DIB 构造是 `parse_dib`（`thumb.rs:243-310`）的**逆变换**：32bpp BI_RGB、正高（bottom-up）、BGRA。

```rust
#[tauri::command]
pub async fn snip_write_clipboard_dib(app: AppHandle, file_ref: String) -> Result<(), String> {
    write_dib_impl(&app, &file_ref).ok_or_else(|| "写入剪贴板失败".into())
}

#[cfg(target_os = "windows")]
fn write_dib_impl(app: &AppHandle, file_ref: &str) -> Option<()> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    let bytes = crate::clipboard::image_store::read_png_bytes(app, file_ref)?;
    let img = image::load_from_memory(&bytes).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let dib = build_dib_bgra_bottomup(w, h, &img.into_raw());
    unsafe {
        // 与 with_clipboard_dib（thumb.rs:85-127）同款避让：插件 200ms 轮询可能持锁
        let mut opened = false;
        for _ in 0..8 {
            if OpenClipboard(std::ptr::null_mut()) != 0 { opened = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened { return None; }
        let result = (|| {
            if EmptyClipboard() == 0 { return None; }
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, dib.len())?;
            if hglobal.is_null() { return None; }
            let ptr = GlobalLock(hglobal) as *mut u8;
            if ptr.is_null() { return None; }
            std::ptr::copy_nonoverlapping(dib.as_ptr(), ptr, dib.len());
            GlobalUnlock(hglobal);
            // SetClipboardData 成功后句柄归系统所有，禁止 GlobalFree
            if SetClipboardData(8 /*CF_DIB*/, hglobal as _).is_null() { None } else { Some(()) }
        })();
        CloseClipboard();
        result
    }
}

#[cfg(target_os = "windows")]
fn build_dib_bgra_bottomup(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(40 + (w * h * 4) as usize);
    out.extend_from_slice(&40u32.to_le_bytes());                    // biSize
    out.extend_from_slice(&(w as i32).to_le_bytes());               // biWidth
    out.extend_from_slice(&(h as i32).to_le_bytes());               // biHeight > 0 = bottom-up
    out.extend_from_slice(&1u16.to_le_bytes());                     // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes());                    // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes());                     // BI_RGB
    out.extend_from_slice(&((w * h * 4) as u32).to_le_bytes());     // biSizeImage
    out.extend_from_slice(&[0u8; 16]);                              // biXPels..biClrImportant
    for row in (0..h).rev() { // bottom-up：最后一行在最前
        for col in 0..w {
            let i = ((row * w + col) * 4) as usize;
            out.extend_from_slice(&[rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]]); // BGRA
        }
    }
    out
}
```

**lib.rs 注册** `snip::capture::snip_write_clipboard_dib`。

**Rust 集成测试**（新建 `src-tauri/tests/snip_capture.rs`，整体 `#![cfg(target_os = "windows")]` 门控，照 `tests/clipboard_thumb.rs` 惯例）：`build_dib_bgra_bottomup(w,h,rgba)` → `crate::...thumb::parse_dib(&dib)` roundtrip 还原 `(w,h,rgba)`（alpha 非 0 时逐字节相等）。为此需在 `lib.rs` 顶层 `pub use` 这两个纯函数（惯例见 `lib.rs:22-29`）。

**验收**：`cargo test` roundtrip 过；devtools `invoke('snip_write_clipboard_dib', { fileRef })` 后在画图/任意编辑器 Ctrl+V 出图。

### P0-T4 窗口探测 `snip_windows_at_point`

**文件**：`src-tauri/src/snip/capture.rs` 追加。全部 API 在已启用 feature 内（`WindowFromPoint`/`GetWindowRect`/`GetAncestor`/`IsWindowVisible` ∈ `Win32_UI_WindowsAndMessaging`，`POINT` ∈ `Win32_Foundation`）。

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipWindowRect { pub x: i32, pub y: i32, pub w: i32, pub h: i32 }

/// 光标处根窗口矩形（物理像素，屏幕全局坐标）。用于覆盖窗「窗口吸附」高亮。
#[tauri::command]
pub fn snip_windows_at_point(x: i32, y: i32) -> Option<SnipWindowRect> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::{POINT, RECT};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetWindowRect, IsWindowVisible, WindowFromPoint, GA_ROOT,
        };
        unsafe {
            let hwnd = WindowFromPoint(POINT { x, y });
            if hwnd.is_null() { return None; }
            let root = GetAncestor(hwnd, GA_ROOT);
            if root.is_null() || IsWindowVisible(root) == 0 { return None; }
            let mut r: RECT = std::mem::zeroed();
            if GetWindowRect(root, &mut r) == 0 { return None; }
            Some(SnipWindowRect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top })
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (x, y); None }
}
```

**lib.rs 注册**。注意：非 async（纯 API 查询，微秒级）。

**验收**：`cargo check`；devtools 在已知窗口位置查询返回合理矩形。

### P0-T5 导出文件 `snip_export_file`

**文件**：`src-tauri/src/snip/capture.rs` 追加 + lib.rs 注册。

```rust
/// 把 imgfile 引用指向的 PNG 复制到用户选择的绝对路径（保存到文件）。
/// dest_path 必须来自前端 dialog 插件的保存对话框（路径已由用户选定）。
#[tauri::command]
pub async fn snip_export_file(app: AppHandle, file_ref: String, dest_path: String) -> Result<(), String> {
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)
        .ok_or_else(|| "读取截图失败".to_string())?;
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("保存文件失败: {e}"))
}
```

**验收**：`cargo check`。至此 Rust 侧 5 个命令全部完成，附录 C 批次一验收。

### P0-T6 全局快捷键命令注册

**文件**：新建 `app/src/commands/global/ScreenshotCommand.ts`；修改 `app/src/commands/shortcuts/InitShortcuts.ts`；修改两张 toml 的 `[shortcut]` 段（zh-cn.toml:1385 附近）。

**ScreenshotCommand.ts**（样板 `app/src/commands/global/ToggleWindowCommand.ts`，全文 63 行，读后照抄结构）：

```ts
import type { Command } from '../Command';
import { openSnip } from '../../snip/snipManager';
import { notifyIsland } from '~/composables/useCopyIsland';
import { isSnipEnabled } from '../../snip/snipSettings';
import { useI18n } from '~/composables/useI18n';

/** Ctrl+Alt+A：全局唤起截图（在任何应用中生效）。 */
export class ScreenshotCommand implements Command {
  async execute(event?: { state: string }): Promise<void> {
    if (event?.state !== 'Pressed') return;
    const { t } = useI18n();
    if (!(await isSnipEnabled())) {
      notifyIsland({ kind: 'info', text: t('snip.disabled_notice') });
      return;
    }
    await openSnip();
  }
}
```

**InitShortcuts.ts**（结构对照 :28-48 实例化区、:50-60 单条目样板）：

- 实例化区加 `const screenshotCommand = new ScreenshotCommand();`（顶部 import）。
- `DEFAULT_SHORTCUTS` 数组**末尾**（`slot_paste_*` 展开之后）追加：

```ts
{
    id: 'screenshot',
    key: 'Control+Alt+A',
    defaultKey: 'Control+Alt+A',
    scope: 'global',
    command: screenshotCommand,
    title: 'shortcut.screenshot',
    enabled: true
},
```

**i18n**（两份 toml 的 `[shortcut]` 段内各加一行，文案见附录 B）。

**验收**：设置 → 快捷键出现「截图」行且可录制/禁用；`npx vitest run` 过。

### P0-T7 覆盖窗管理器 `snipManager.ts`

**文件**：新建 `app/src/snip/snipManager.ts`。**整体照抄 `app/src/commands/local/BubbleToggleCommand.ts` 的 openRing 三件套**（纪元 :37-59 / safeUnlisten :61-66 / waitOverlayReady :104-124 / ringCenter :80-102 / 建窗参数 :214-231 / 事件通道 :240-248 / 显示取焦 :270-272），差异如下：

```ts
/**
 * 截图会话管理器（主窗口上下文）。
 * 时序（严格顺序，禁止调换）：
 *   1. snip_capture_screen 截屏落盘（此时不存在的覆盖窗不会入镜）
 *   2. 按 T1 返回的物理 rect 匹配 availableMonitors 求出 scale，换算逻辑边界
 *   3. 建 snip-overlay-<ts> 覆盖窗（隐藏创建）→ 等 snip:ready → emitTo snip:data（只传引用）
 *   4. overlay.show() + setFocus()
 *   5. 监听 snip:confirm / snip:cancel / snip:pin（纪元校验防串）
 */
const READY_TIMEOUT_MS = 8000;

interface SnipSession { ts: number; overlay: WebviewWindow; unlisteners: UnlistenFn[]; }
let snip: SnipSession | null = null;

export function isSnipOpen(): boolean { return !!snip; }

export async function openSnip(): Promise<void> {
  if (snip) return; // 会话进行中：忽略重复触发
  const ts = Date.now();
  (window as any).__childOpeningUntil = Date.now() + 600; // 照 BubbleToggleCommand.ts:194
  // 1. 先截屏
  const cap = await invoke<{ fileRef: string; x: number; y: number; width: number; height: number } | null>(
    'snip_capture_screen',
  ).catch(() => null);
  if (!cap?.fileRef) { notifyIsland({ kind: 'error', text: useI18n().t('snip.capture_failed') }); return; }
  // 2. 匹配显示器求 scale（物理 rect 与 availableMonitors 的 position+size 相等比对）
  const monitors = await availableMonitors().catch(() => []);
  const m = monitors.find(mm =>
    mm.position.x === cap.x && mm.position.y === cap.y &&
    mm.size.width === cap.width && mm.size.height === cap.height);
  const scale = m?.scaleFactor || 1;
  // 3. 建窗：逻辑尺寸 = 物理 / scale（照 ringCenter 换算注释 BubbleToggleCommand.ts:89-97）
  const label = `snip-overlay-${ts}`;
  const readyP = waitSnipReady(label); // 照 waitOverlayReady 改事件名 snip:ready
  const overlay = new WebviewWindow(label, {
    url: '/snip',
    title: 'Snip',
    width: cap.width / scale, height: cap.height / scale,
    x: cap.x / scale, y: cap.y / scale,
    resizable: false, decorations: false, transparent: true,
    skipTaskbar: true, alwaysOnTop: true, focus: false, focusable: true,
    shadow: false, visible: false,
  });
  snip = { ts, overlay, unlisteners: [] };
  overlay.once('tauri://error', () => { if (epochAlive(ts)) void closeSnip(); });
  await on('snip:cancel', () => void closeSnip());            // 照 BubbleToggleCommand.ts:241-248 的 on 封装
  await on('snip:confirm', (p) => void confirmSnip(p, ts));   // p = { x,y,w,h } 物理像素
  // 4. 就绪后投数据 → 显示
  const ready = await readyP;
  if (!epochAlive(ts)) return;
  if (!ready) { await closeSnip(); return; }
  await emitTo(label, 'snip:data', { fileRef: cap.fileRef, scale }).catch(() => {});
  await overlay.show().catch(() => {});
  await overlay.setFocus().catch(() => {});
}

export async function closeSnip(): Promise<void> {
  /* 照 closeRing（BubbleToggleCommand.ts:69-77）：置 null → 解绑 → overlay.close() */
}
```

**确认处理 `confirmSnip`（融合核心，顺序禁止调换）**：

```ts
async function confirmSnip(p: { x: number; y: number; w: number; h: number }, ts: number): Promise<void> {
  await closeSnip();                                    // ① 先关覆盖窗（焦点归还目标应用）
  const crop = await invoke<{ fileRef: string; thumb: string | null; qrText: string | null } | null>(
    'snip_crop_region', { fileRef: currentFileRef, x: p.x, y: p.y, w: p.w, h: p.h },
  ).catch(() => null);
  if (!crop?.fileRef) { notifyIsland({ kind: 'error', text: t('snip.crop_failed') }); return; }
  const privacy = isPrivacyPaused();
  // ② 写系统剪贴板（开关 + 双抑制先行——禁止事项 #4）
  if (await isSnipAutoCopy() && !privacy) {
    suppressIslandCopy();
    dbService.suppressUseCountBump();
    await invoke('snip_write_clipboard_dib', { fileRef: crop.fileRef }).catch(() => {});
  }
  // ③ 入剪贴板历史（type='image' + source_app='s1d3-board'，照快速通道
  //    clipboardListener.ts:161-172 的「先岛后库」顺序）
  if (await isSnipAutoHistory() && !privacy) {
    bus.emit('island:copy', { content: crop.fileRef, type: 'image', thumb: crop.thumb, qrText: crop.qrText });
    await repo.saveClipboard(crop.fileRef, 'image', 's1d3-board', crop.qrText ?? '', crop.fileRef);
    bus.emit('clipboard:changed');
  }
  // ④ 岛「已截图」（kind=screenshot，缩略图直显；imageRef 供出站桥按需展开）
  if (!privacy) void showIslandDirect({ kind: 'screenshot', thumb: crop.thumb, qrText: crop.qrText, imageRef: crop.fileRef });
  // ⑤ 记统计（P0 复用 clip_image；P1 换 clip_screenshot，见 P1-T5）
  if (!privacy) void statsService.record({ clip_image: 1 }).catch(() => {});
}
```

> `showIslandDirect` 说明：不新造函数——直接调 `useCopyIsland` 内部的 `showIsland` 不可从外部导入（未导出），**做法**：在 `useCopyIsland.ts` 增加 `export function notifySnipIsland(payload: { thumb?: string; qrText?: string; imageRef: string }): void` 调 `showIsland({ kind: 'screenshot', thumb: payload.thumb, qrText: payload.qrText, imageRef: payload.imageRef })`。注意 `island:copy` 事件（若 auto_history 开）与该岛同帧到达时靠既有 `lastShownCopy` 900ms 同内容去重；为避免「已复制+已截图」双弹，③里的 `bus.emit('island:copy', …)` **省略**（P0 简化：截图岛由 ④ 单独负责，入库照常）——即 ③ 只做 saveClipboard + clipboard:changed。

**保存到文件（工具条「保存」走 `snip:confirm` 载荷扩展）**：`snip:confirm` payload 增加可选字段 `action: 'copy' | 'save'`（默认 'copy'）。`action==='save'` 时跳过 ②③④，改为：`dialog.save({ filters: [{ name: 'PNG', extensions: ['png'] }] })`（`@tauri-apps/plugin-dialog`，能力 `dialog:default` 已具备）→ `invoke('snip_export_file', { fileRef: crop.fileRef, filePath })` → 岛 `snip.saved`。jpeg 格式：若 `snip_format==='jpeg'`，`snip_export_file` 增加可选参数 `format`/`quality`，Rust 侧用 `image` crate 重编码（`image::codecs::jpeg::JpegEncoder::new_with_quality`）。

**验收**：手测 Ctrl+Alt+A → 覆盖窗铺满光标所在屏、不闪白；Esc 关闭；无 JS 报错。

### P0-T8 选区几何纯函数 `selection.ts` + 单测

**文件**：新建 `app/src/snip/selection.ts`、`app/src/snip/__tests__/selection.spec.ts`。

```ts
export interface Rect { x: number; y: number; w: number; h: number }
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 拖拽两点 → 规范矩形（负宽高翻正），钳制在 [0, bound] 内 */
export function rectFromDrag(x1: number, y1: number, x2: number, y2: number, boundW: number, boundH: number): Rect;
/** 命中 8 向手柄（HANDLE_SIZE=8px，含 2px 容差），未命中返回 null */
export function hitTestHandle(rect: Rect, px: number, py: number): Handle | null;
/** 拖动手柄后的新矩形（跨轴翻转处理），钳制在边界内 */
export function resizeByHandle(rect: Rect, handle: Handle, px: number, py: number, boundW: number, boundH: number): Rect;
/** 最小选区尺寸 8×8，低于则返回 null（视为误触取消选中） */
export function isValidSelection(rect: Rect): boolean;
```

**验收**：vitest 覆盖翻正/钳制/翻转/命中共 ≥10 例，全过。

### P0-T9 覆盖窗页面 `app/pages/snip.vue`

**文件**：新建 `app/pages/snip.vue`（结构照 `app/pages/bubble.vue` ring 模式 + `app/components/ring/RingOverlay.vue` 交互自治）。要点逐条：

1. **透明窗处理**：`useHead` 内联 `<style>html,body{background:transparent}</style>`（照 `app/pages/note-pin/[id].vue:52-54`，比 onMounted 早）+ onMounted 调 `useTransparentWindow()`。
2. **窗口级监听**（禁止全局 listen，多窗串扰——见 `bubble.vue:493-499` 注释）：
   ```ts
   unlisteners.push(await getCurrentWebviewWindow().listen<{ fileRef: string; scale: number }>('snip:data', (ev) => { /* 启动 */ }));
   await emit('snip:ready', getCurrentWindow().label); // ready 握手
   ```
3. **背景冻结画面**：`invoke('read_clipboard_image_file', { file: fileRef.slice('imgfile:'.length) })`（照 `app/src/core/db/imageRef.ts:67-78` 用法）拿 data URL → 全屏 `<img>`（`object-fit: fill`，宽高=窗口=显示器，比例天然一致）。加载期间显示纯遮罩层。
4. **遮罩**：选区外 4 块矩形 div（上/下/左/右），`background: rgba(0,0,0, opacity)`，opacity=`snip_mask_opacity/100`（onMounted 读 KV）。
5. **选区交互状态机**：`idle`（未选，光标十字线 `cursor: crosshair`，pointerdown 进入 `drawing`）→ `drawing`（pointermove 更新 `rectFromDrag`，显示尺寸角标 `W × H` px）→ pointerup 进入 `selected`；`selected` 下命中手柄 → `resizing`（`resizeByHandle`），选区内 pointerdown → `moving`（位移矩形）。全程 `setPointerCapture`（照 `app/pages/viewer.vue:150-171` 拖拽模式）。
6. **十字线**：`idle`/`drawing` 时画横竖两条 1px 金色线（跟随光标）。
7. **放大镜取色**：`drawing`/`idle` 与 `selected` 边缘均显示（跟随光标右侧 16px）：canvas 96×96，`drawImage(img, sx-6, sy-6, 12, 12, 0, 0, 96, 96)` 且 `imageSmoothingEnabled=false`（像素块放大），下方色值条显示 `#RRGGBB` + `R,G,B`（`ctx.getImageData` 从同源 canvas 取像素；img 为 data URL 无跨域污染）。**点击（idle 态无选区时单击）复制色值**：`suppressIslandCopy()` → `writeText(hex)` → `notifyIsland({ kind:'success', text: hex })`。
8. **窗口吸附**：`idle` 态 pointermove 节流 120ms 调 `snip_windows_at_point`（传物理像素 = 逻辑×scale），返回矩形换算回逻辑后画蓝色虚线高亮框；**单击**（idle 态、无拖拽位移）直接把该矩形设为选区进入 `selected`。
9. **确认工具条**：`selected` 态在选区下方 8px（放不下改上方）显示按钮组：`复制(Enter)` / `保存` / `取消(Esc)`（贴图按钮 P1 加）。按钮 i18n 用附录 B 的 `snip.*`。
10. **键盘**（页面 window keydown 自治，照 `RingOverlay.vue:119-162`）：`Escape` → `emit('snip:cancel')` + 自身无需关窗（管理器负责）；`Enter` → `emit('snip:confirm', { ...physicalRect, action: 'copy' })`；方向键选区微移 1px（Shift=10px）。
11. **右键**：contextmenu → preventDefault + `emit('snip:cancel')`。
12. **物理像素换算**：emit 前 `x: Math.round(sel.x * scale)` 等四值（scale 来自 snip:data）。
13. **dev 污染物**：抄 `bubble.vue:711-720` 的全局样式隐藏 Nuxt DevTools。

**验收**：手测全部交互（框选/手柄/移动/吸附/放大镜/取色/Esc/Enter/右键）；多显示器 + 150% DPI 下截图与选区位置一致（画图粘贴验证）。

### P0-T10 岛 kind `screenshot` 四处同步

| # | 文件:行 | 改动 |
|---|---|---|
| 1 | `app/composables/useCopyIsland.ts:106` | `IslandKind` 联合加 `'screenshot'` |
| 2 | `app/pages/bubble.vue:107-110` | `ISLAND_LABEL_KEYS` 加 `screenshot: 'screenshot'`（标签键 `island.screenshot`）；模板 icon 区（:561-596 区域）为 screenshot 复用 paste 的剪切板 svg（剪刀/复制图标组）加一分支即可 |
| 3 | `app/pages/island-history.vue:46-56` | `kindMeta` 加 `screenshot: { dot: 'bg-blue', labelKey: 'island_history.type_screenshot' }`；`KIND_ORDER` 数组 `'paste'` 后插 `'screenshot'`；若该文件存在 `IMAGE_KINDS`（图片落历史判定集合）加 `'screenshot'`（历史里截图显示为缩略图） |
| 4 | `app/composables/useCopyIsland.ts:596` | 岛 API kinds 白名单数组加 `'screenshot'` |

**i18n**：`island.screenshot` / `island_history.type_screenshot` 双语（附录 B）。

**注意**：岛历史图片落库走 `emitIslandShow` 的既有逻辑（`useCopyIsland.ts:471-487`，thumb 降 56px webp）——`notifySnipIsland` 传了 `thumb` 即自动生效，无需改动。

**验收**：截图后岛弹「已截图」+ 缩略图；岛历史窗口出现该条且可筛选「截图」类型。

### P0-T11 capabilities 白名单

**文件**：`src-tauri/capabilities/default.json:5-14` 的 `windows` 数组追加两行（P1 贴图窗一并预留）：

```json
"snip-overlay-*",
"snip-pin-*"
```

**验收**：`npm run tauri:dev` 启动无 capability 报错；覆盖窗能 invoke（无权限即 invoke 失败）。

### P0-T12 设置项与 i18n 落地

**文件**：新建 `app/src/snip/snipSettings.ts`；修改 `app/src/setting/settingGroups.ts`、`app/components/setting/SettingMain.vue`、两张 toml。

**snipSettings.ts**（布尔样板 `app/composables/useBooleanSetting.ts:11-49`；数值三件套样板 `app/composables/useCopyIsland.ts:49-104`）：

```ts
// 导出：useSnipEnabled/setSnipEnabled（KV snip_enabled，默认 true）
//       useSnipAutoCopy / useSnipAutoHistory（同上模式）
//       ensureSnipSettingsLoaded / getSnipMaskOpacity / setSnipMaskOpacity（数值钳制 10~80）
//       getSnipFormat/setSnipFormat、getSnipSaveDir/setSnipSaveDir（P0 其余键只存不消费，P1 用）
```

**settingGroups.ts**：`clipboard` 分组的 `children`（:45 起）追加子组：

```ts
{
  title: 'setting.subgroups.clipboard_snip',
  items: [
    { label: 'setting.general.snip_enabled', value: '', type: 'checkbox' },
    { label: 'setting.general.snip_auto_copy', value: '', type: 'checkbox' },
    { label: 'setting.general.snip_auto_history', value: '', type: 'checkbox' },
    { label: 'setting.general.snip_format', value: '', type: 'select' },
    { label: 'setting.general.snip_mask_opacity', value: '', type: 'input' },
    { label: 'setting.general.snip_save_dir', value: '', type: 'input' },
  ],
},
```

**SettingMain.vue**：通用分支按 label key 绑定控件（既有 checkbox/input/select 的绑定写法照 `island_hint` / `island_delay` / `language` 三类现成控件），handler 调 snipSettings 导出函数；变更用 `showHint` 弹岛反馈（:155-157 模式）。`snip_save_dir` 旁给「浏览」action 调 `dialog.open({ directory: true })`。

**i18n**：附录 B 的 `setting.subgroups.clipboard_snip`、全部 `setting.general.snip_*`（含 `_tip`）双语。

**验收**：设置页出现「截图」子组；全部开关生效（关 snip_enabled 后快捷键弹「截图功能已关闭」岛）；`npx vitest run` + `vue-tsc` 过。附录 C 批次二整体验收。

---

## 3. P1 增强实现规格

### P1-T1 标注工具栏（snip.vue 内嵌）

**架构**：双层 canvas 叠在背景 `<img>` 上——`bgCanvas`（把 img 画入，导出合成用）+ `annoCanvas`（标注实时渲染）。标注 = 对象数组 `annotations: Annotation[]`，每项 `{ id, tool, color, size, points?|rect?|text?, }`；撤销/重做 = 数组快照栈（`undoStack`/`redoStack`，上限 50）。

**工具枚举与渲染**（i18n `snip.tool_*`，附录 B）：

| tool | 交互 | 渲染 |
|---|---|---|
| `rect` | 拖拽矩形 | 2px 描边 |
| `ellipse` | 拖拽外接矩形 | ellipse 描边 |
| `arrow` | 拖拽起终点 | 线宽 size、箭头长 size*3 的 V 头 |
| `pen` | pointermove 采点（去重距离≥2px） | points 折线，lineJoin round |
| `text` | 单击定焦点、输入框浮层、Enter/Ctrl+Enter 结束 | canvas `fillText`，字号 size*4 |
| `mosaic` | 拖拽矩形 | 从 bgCanvas 取该区域像素按 12px 块取均值填充（像素化） |

**工具条**：确认工具条左侧展开二级条（选中工具高亮；颜色=主题色板金/红/蓝/绿/黑/白 + 自定义 `<input type="color">`；粗细 3 档 S/M/L=size 2/4/8）。快捷键：`Ctrl+Z` 撤销 / `Ctrl+Y` 重做 / 数字 1~6 切工具（仅 `selected` 态且无文本输入焦点时）。

**输出**：确认时若有标注——合成：`bgCanvas.drawImage(img)` → 逐项重放标注到 bgCanvas → `bgCanvas.toDataURL('image/png')` → `invoke('save_clipboard_image', { dataUrl })` 得 fileRef（替代 `snip_crop_region` 的产物；该命令已存在，`image_store.rs:269`）→ 走 P0 confirmSnip 的 ②③④。无标注时维持 `snip_crop_region` 快路径。**注意**：canvas 坐标为逻辑像素，img 按窗口尺寸绘制，合成前 `bgCanvas.width = img.naturalWidth * (sel.w/windowW)` 换算（简化：直接以 img.naturalWidth×naturalHeight 建画布，选区与标注坐标统一乘 `naturalWidth/windowW` 比例）。

**验收**：每种工具标注→确认→粘贴出带标注图；撤销重做正确；无标注路径行为与 P0 完全一致。

### P1-T2 贴图（截区钉在桌面）

**新页面** `app/pages/snip-pin/[hash].vue`：动态路由参数=裁剪 fileRef 的 hash 段。**整页照抄 `app/pages/note-pin/[id].vue` 骨架**（置顶卡片/`data-tauri-drag-region` 拖动/Esc 关窗/透明样式），内容区换成 `<img>`（onMounted 由管理器 emitTo 定向投 `snip-pin:data` { fileRef }，窗口级 listen 收——照 bubble.vue pin 模式 :493-503）。增强：滚轮缩放 0.25~4 倍（`wheel` 事件改 width/height + 居中锚点）、`Ctrl+滚轮` 调不透明度 30~100%、双击关闭、右键菜单（复制/关闭）。

**管理器** `snipManager.ts` 加 `pinSnip(p)`（`snip:pin` 事件触发，payload 同 confirm）：裁剪得 fileRef → 建 `snip-pin-<hash8>` 窗（**照抄 `app/composables/useDesktopPin.ts:83-122` 全套**：alwaysOnTop/focus:false/visible:false/backgroundColor:[0,0,0,0]/shadow:false + ready 握手 `snip-pin:ready` + `__childOpeningUntil`）→ 窗口尺寸=裁剪尺寸/scale（钳制屏幕 80%）→ emitTo 投 fileRef → show（不 setFocus，贴图不抢焦点）。

**豁免落地**（贴图窗常驻语义）：
- `app/app.vue:112-124` 主窗口关闭连带遍历的豁免名单：加 `label.startsWith('snip-pin-')` 分支（照 note-pin 判断）。
- `app/composables/useAutoHide.ts:129-144` 失焦连带关闭的 skip list：加同前缀 continue（照 `note-pin-` :141）。

**验收**：截图→工具条「贴图」→ 置顶小窗；可拖动/缩放/透明度；主窗口隐藏与关闭均不牵连；重启后贴图消失（P1 语义：会话级，不持久化——文档注明）。

### P1-T3 延时截图

`snip_delay_sec > 0` 时：ScreenshotCommand 先 `notifyIsland({ kind:'info', text: t('snip.delay_notice', {n}) })` → setTimeout n 秒后 openSnip（期间岛可更新倒计时，简化为一次提示即可）。设置页 `snip_delay_sec` input（0~5 钳制）。

### P1-T4 窗口吸附 DWM 精确边框（可选增强）

`Cargo.toml` windows-sys features 加 `"Win32_Graphics_Dwm"`；`snip_windows_at_point` 内 `DwmGetWindowAttribute(root, DWMWA_EXTENDED_FRAME_BOUNDS, &mut rect, size)` 优先于 GetWindowRect（失败回退）。验收：UWP/Chrome 等带阴影窗口吸附框贴合可视边框。

### P1-T5 统计字段 `clip_screenshot`

1. **Rust 迁移**：`src-tauri/src/db/migrations.rs` 迁移链（当前 v22）追加 v23：`ALTER TABLE daily_stat ADD COLUMN clip_screenshot INTEGER NOT NULL DEFAULT 0`（照 tab_app_usage 先例）。
2. **前端兜底**：`app/src/core/db/migrator.ts:181-219` wanted 列表加 `{ table: 'daily_stat', column: 'clip_screenshot', ddl: 'ALTER TABLE daily_stat ADD COLUMN clip_screenshot INTEGER NOT NULL DEFAULT 0' }`。
3. **StatField**：`app/src/statistics/statsService.ts:30-37` 联合加 `'clip_screenshot'`；`:60-67` `DEFAULT_RANGE_FIELDS` 加 `'clip_screenshot'`。
4. **埋点切换**：P0-T7 ⑤ 的 `record({ clip_image: 1 })` 改 `record({ clip_screenshot: 1 })`。
5. **统计页展示**：`app/components/statistics/StatsPage.vue` 核心指标卡区加「截图」卡（照 `clip_image` 卡结构）；i18n `stats.metric_screenshot` 双语。
6. **提醒**：`chartMath.ts` 的 `OPS_FIELDS`、`userTags.ts`/`story.ts` 的 `sumTabs` 是硬编码清单（代码审查报告 §2.1.3 已记录的债），本任务**不修**该债，仅在 `statsService.ts` 埋点层生效。

### P1-T6 捕获鼠标光标

`snip_capture_screen` 加参数 `include_cursor: bool`（前端传 `snip_capture_cursor` 设置值）：BitBlt 后若 true，`GetCursorPos` + `GetIconInfo` + `DrawIconEx` 到 hdc_mem（API 均在已启用 feature：`Win32_UI_WindowsAndMessaging`）。绘制在 SelectObject 之后 BitBlb 之前。**注意**：光标绘制在 memDC 上、坐标换算 `pt - rect.left/top`。

---

## 4. P2 进阶实现记录（2026-11-11，Windows 验证）

已实现并接入工具条（详细行为见 [features/screenshot.md](./features/screenshot.md)）：

1. **长截图**：覆盖窗隐藏 UI + 鼠标穿透；`snip_capture_region` 每 350ms 抓帧（内容寻址引用天然去重）→ 静止约 2s / 20s 上限结束 → `snip_stitch_vertical`（行灰度签名重叠检测 + 纵向拼接）→ 主窗口监听 `snip:long-done` 统一写剪贴板 / 入历史 / 岛。
2. **AI 识图**：`ai_vision_complete` 支持 OpenAI 兼容（`image_url`）与 Anthropic 原生（`source.type=base64`）多模态；选区（含标注烘焙）→ 描述文本复制；未配置 Key / 自定义提供商隐藏入口。
3. **OCR 与自动打码**：`snip_ocr_region` / `snip_ocr_boxes`（Windows.Media.Ocr）；自动打码按行框批量生成马赛克标注（可撤销）。
4. **上传分享**：`snip_upload_image` 仅允许 https（或本机回环 http），POST PNG 原字节并取返回链接。
5. **出站联动**：岛事件 `island:show` 天然携带截图事件（imageRef 供 Rust 桥展开，`src-tauri/src/island/api.rs:292-331`），无需开发。
6. **快速访问条**：确认后浮现在选区旁的小工具条（贴图 / 上传 / 历史），预热常驻窗 `snip-quickbar`，位置由纯函数 `app/src/snip/quickbar.ts` 计算（下方优先/上方回退/屏内钳制），4 秒无交互自动收起，动作回主窗口执行。OCR 入口只在截图编辑器（识别结果需预览确认后才会复制，避免「不知结果对错已被写入剪贴板」）。

---

## 5. 平台支持矩阵

| 能力 | Windows | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| P0 全部 | ✅ GDI BitBlt（零新增依赖） | ❌（命令返回 None → 岛提示不支持，P1 接 objc2 `CGWindowListCreateImage` + 屏幕录制权限检测引导） | ❌（P1 接 x11rb 已有依赖） | ❌ 永久（检测 `WAYLAND_DISPLAY` 环境变量 → 设置置灰 + 提示，照 app_usage 降级模式 `src-tauri/src/app_usage/mod.rs`） |
| 平台探测 | — | `CGPreflightScreenCaptureAccess` | 连接 X11 试探 | env 检测 |

**P0 必须**：非 Windows 上 `snip_capture_screen` 返回 None 时，前端 `notifyIsland({ kind:'info', text: t('snip.unsupported') })`。

---

## 附录 A 新建/修改文件总表

**新建（13）**

- [ ] `src-tauri/src/snip/mod.rs`（P0-T1）
- [ ] `src-tauri/src/snip/capture.rs`（P0-T1/T2/T3/T4/T5、P1-T4/T6）
- [ ] `src-tauri/tests/snip_capture.rs`（P0-T3 roundtrip 测试）
- [ ] `app/src/commands/global/ScreenshotCommand.ts`（P0-T6）
- [ ] `app/src/snip/snipManager.ts`（P0-T7、P1-T2）
- [ ] `app/src/snip/snipSettings.ts`（P0-T12）
- [ ] `app/src/snip/selection.ts`（P0-T8）
- [ ] `app/src/snip/__tests__/selection.spec.ts`（P0-T8）
- [ ] `app/pages/snip.vue`（P0-T9、P1-T1）
- [ ] `app/pages/snip-pin/[hash].vue`（P1-T2）

**修改（10）**

- [ ] `src-tauri/src/lib.rs`：mod snip + generate_handler 追加 5 命令 + pub use 测试纯函数（P0-T1~T5、T3）
- [ ] `src-tauri/src/clipboard/image_store.rs`：`images_dir` 改 pub(crate)、新增 `read_png_bytes`（P0-T1/T2）
- [ ] `src-tauri/src/clipboard/thumb.rs`：`thumb_png`/`scan_qr_rgba` 改 pub(crate)（P0-T2）
- [ ] `src-tauri/src/db/migrations.rs`：v23 迁移（P1-T5）
- [ ] `src-tauri/capabilities/default.json`：windows 白名单 +2（P0-T11）
- [ ] `app/src/commands/shortcuts/InitShortcuts.ts`：实例化 + DEFAULT_SHORTCUTS（P0-T6）
- [ ] `app/composables/useCopyIsland.ts`：IslandKind + kinds 白名单 + `notifySnipIsland`（P0-T7/T10）
- [ ] `app/pages/bubble.vue`：ISLAND_LABEL_KEYS + icon 分支（P0-T10）
- [ ] `app/pages/island-history.vue`：kindMeta/KIND_ORDER/IMAGE_KINDS（P0-T10）
- [ ] `app/src/setting/settingGroups.ts` + `app/components/setting/SettingMain.vue`：截图子组（P0-T12）
- [ ] `app/src/core/db/migrator.ts` + `app/src/statistics/statsService.ts` + `app/components/statistics/StatsPage.vue`（P1-T5）
- [ ] `app/app.vue` + `app/composables/useAutoHide.ts`：snip-pin 豁免（P1-T2）
- [ ] `app/assets/lang/zh-cn.toml` + `en-us.toml`：附录 B 全部 key（P0-T6/T10/T12 分批加）

## 附录 B 双语文案总表（直接可抄）

`[shortcut]` 段：

| key | zh-CN | en-US |
|---|---|---|
| `screenshot` | `截图` | `Screenshot` |

`[island]` 段：

| key | zh-CN | en-US |
|---|---|---|
| `screenshot` | `已截图` | `Screenshot captured` |

`[island_history]` 段：

| key | zh-CN | en-US |
|---|---|---|
| `type_screenshot` | `截图` | `Screenshot` |

`[snip]` 段（新增顶层段）：

| key | zh-CN | en-US |
|---|---|---|
| `capture_failed` | `截屏失败，请重试` | `Screen capture failed. Please retry` |
| `crop_failed` | `截图处理失败，请重试` | `Failed to process the screenshot. Please retry` |
| `save_failed` | `保存文件失败` | `Failed to save file` |
| `saved` | `已保存到 {path}` | `Saved to {path}` |
| `disabled_notice` | `截图功能已关闭，可在设置中开启` | `Screenshot is disabled. Enable it in Settings` |
| `unsupported` | `当前平台暂不支持截图` | `Screenshot is not supported on this platform yet` |
| `delay_notice` | `{n} 秒后截图…` | `Screenshot in {n}s…` |
| `color_copied` | `已复制色值 {hex}` | `Color {hex} copied` |
| `btn_copy` | `复制` | `Copy` |
| `btn_save` | `保存` | `Save` |
| `btn_pin` | `贴图` | `Pin` |
| `btn_cancel` | `取消` | `Cancel` |
| `tool_rect` | `矩形` | `Rectangle` |
| `tool_ellipse` | `椭圆` | `Ellipse` |
| `tool_arrow` | `箭头` | `Arrow` |
| `tool_pen` | `画笔` | `Pen` |
| `tool_text` | `文字` | `Text` |
| `tool_mosaic` | `马赛克` | `Mosaic` |
| `pin_close_hint` | `双击关闭贴图` | `Double-click to close` |

`[setting.subgroups]` / `[setting.general]` 段：

| key | zh-CN | en-US |
|---|---|---|
| `subgroups.clipboard_snip` | `截图` | `Screenshot` |
| `general.snip_enabled` | `启用截图` | `Enable screenshot` |
| `general.snip_enabled_tip` | `全局快捷键唤起截图，截图自动进入剪贴板历史` | `Summon via global shortcut; screenshots enter clipboard history automatically` |
| `general.snip_auto_copy` | `截图后自动复制` | `Auto-copy after capture` |
| `general.snip_auto_copy_tip` | `确认后写入系统剪贴板，任意应用可直接粘贴` | `Write to system clipboard on confirm; paste anywhere` |
| `general.snip_auto_history` | `截图自动入历史` | `Auto-save to history` |
| `general.snip_auto_history_tip` | `截图作为图片条目进入剪贴板历史，可搜索与收藏` | `Screenshots enter clipboard history as image items` |
| `general.snip_format` | `保存格式` | `Save format` |
| `general.snip_format_tip` | `保存到文件时使用的图片格式` | `Image format used when saving to file` |
| `general.snip_mask_opacity` | `遮罩不透明度` | `Mask opacity` |
| `general.snip_mask_opacity_tip` | `框选时选区外的暗化程度（百分比）` | `Darkening outside the selection while snipping (percent)` |
| `general.snip_save_dir` | `默认保存目录` | `Default save folder` |
| `general.snip_save_dir_tip` | `留空则每次保存时询问` | `Ask every time when left empty` |

`[stats]` 段（P1-T5）：

| key | zh-CN | en-US |
|---|---|---|
| `metric_screenshot` | `截图次数` | `Screenshots` |

## 附录 C 分批验收清单

**批次一（Rust，P0-T1~T5）**
- [ ] `cargo check` / `cargo test` 零新增告警失败
- [ ] 5 个 invoke 命令 devtools 逐一可用
- [ ] roundtrip 测试（build_dib→parse_dib）过

**批次二（P0 闭环，P0-T6~T12）**
- [ ] Ctrl+Alt+A 在任意应用唤起；覆盖窗铺满光标屏；Esc/右键取消
- [ ] 框选→Enter：系统剪贴板可粘贴、剪贴板历史首条为该图（来源显示 s1d3-board）、岛弹「已截图」带缩略图
- [ ] 快速连续两次同一区域截图：历史条目不重复出现两条（sha256 相同则 upsert 计数，符合预期）；岛无双弹
- [ ] 工具条「保存」出文件；jpeg 格式生效
- [ ] 放大镜取色点击→色值入剪贴板文本历史+岛提示
- [ ] 窗口吸附单击选整窗；150% DPI 与双屏位置准确
- [ ] 设置「截图」子组全部项生效；关闭总开关后快捷键弹提示岛
- [ ] 隐私模式开启：截图可用但不入库不弹岛
- [ ] `npx vitest run` + `npx vue-tsc --noEmit` 全过

**批次三（P1，T1~T6 按序）**
- [ ] 六种标注+撤销重做；带标注合成输出正确
- [ ] 贴图窗拖/缩/透明度/双击关；主窗隐藏关闭不牵连
- [ ] 延时截图倒计时后自动进入框选
- [ ] `daily_stat.clip_screenshot` 迁移后统计页「截图」卡有数
- [ ] 开启捕获光标后截图含光标

---

*本文档由代码审查流程生成于 2026-10-24；所有「照抄样板」的 `file:line` 均经人工核对（dev 分支）。实现完成后请更新 [features/screenshot.md](./features/screenshot.md) 的「规划中」标注与功能总览表。*
