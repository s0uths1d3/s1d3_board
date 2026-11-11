//! Windows 原生 OCR（Windows.Media.Ocr）：截图区域文字识别。
//!
//! - 纯 Windows WinRT 实现，离线可用、无需模型下载；语言包由系统安装的
//!   识别语言决定（中文系统默认含 zh-Hans，英文含 en-US）。
//! - 引擎能力检测（可用语言列表 / 最大图像边长）全部命令化，前端据此
//!   隐藏或降级 OCR 动作——非 Windows 平台返回空列表与明确错误。
//! - 识别在 spawn_blocking 线程执行（WinRT 异步 API `.get()` 阻塞等待），
//!   不占用 Tauri 异步运行时工作线程。

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipOcrResult {
    /// 识别文本（按行拼接，行间 \n；无文字为空串）
    pub text: String,
    /// 实际使用的识别语言标签（如 zh-Hans-CN）；未知为空串
    pub language: String,
}

/// OCR 文本框（按行合并；坐标为裁剪图原始像素，左闭右开）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnipOcrBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub text: String,
}

/// 裁剪 RGBA（x/y 越界钳制；w/h <= 0 表示取到图像边界）
fn crop_rgba(
    img: &image::RgbaImage,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Option<(u32, u32, Vec<u8>)> {
    let (iw, ih) = (img.width() as i32, img.height() as i32);
    let sx = x.clamp(0, iw);
    let sy = y.clamp(0, ih);
    let sw = if w <= 0 { iw - sx } else { w.min(iw - sx) };
    let sh = if h <= 0 { ih - sy } else { h.min(ih - sy) };
    if sw <= 0 || sh <= 0 {
        return None;
    }
    let c = image::imageops::crop_imm(img, sx as u32, sy as u32, sw as u32, sh as u32).to_image();
    let (cw, ch) = (c.width(), c.height());
    Some((cw, ch, c.into_raw()))
}

/// 对截图引用中的指定区域做 OCR。区域为空（w/h <= 0）时识别整图。
/// 返回 `Err` 的文字可直接展示给用户（平台不支持 / 未安装识别语言 / 引擎失败）。
#[tauri::command]
pub async fn snip_ocr_region(
    app: AppHandle,
    file_ref: String,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    lang: Option<String>,
) -> Result<SnipOcrResult, String> {
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)
        .ok_or_else(|| "读取截图失败".to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("解码截图失败: {e}"))?
        .to_rgba8();
    let (cw, ch, rgba) = crop_rgba(
        &img,
        x.unwrap_or(0),
        y.unwrap_or(0),
        w.unwrap_or(0),
        h.unwrap_or(0),
    )
    .ok_or_else(|| "识别区域为空".to_string())?;
    let lang = lang.filter(|s| !s.trim().is_empty());

    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || ocr_rgba_windows(cw, ch, &rgba, lang.as_deref()))
            .await
            .map_err(|e| format!("OCR 任务异常: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (cw, ch, rgba, lang);
        Err("当前平台暂不支持系统原生 OCR".to_string())
    }
}

/// 对截图引用中的指定区域做 OCR，返回按行合并的文本框（自动打码用）。
#[tauri::command]
pub async fn snip_ocr_boxes(
    app: AppHandle,
    file_ref: String,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    lang: Option<String>,
) -> Result<Vec<SnipOcrBox>, String> {
    let bytes = crate::clipboard::image_store::read_png_bytes(&app, &file_ref)
        .ok_or_else(|| "读取截图失败".to_string())?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("解码截图失败: {e}"))?
        .to_rgba8();
    let (cw, ch, rgba) = crop_rgba(
        &img,
        x.unwrap_or(0),
        y.unwrap_or(0),
        w.unwrap_or(0),
        h.unwrap_or(0),
    )
    .ok_or_else(|| "识别区域为空".to_string())?;
    let lang = lang.filter(|s| !s.trim().is_empty());

    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            ocr_rgba_windows_lines(cw, ch, &rgba, lang.as_deref()).map(|(_, _, boxes, _)| boxes)
        })
        .await
        .map_err(|e| format!("OCR 任务异常: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (cw, ch, rgba, lang);
        Err("当前平台暂不支持系统原生 OCR".to_string())
    }
}

/// 系统可用 OCR 语言标签列表（能力检测；空数组 = 不可用/非 Windows）
#[tauri::command]
pub fn snip_ocr_languages() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Media::Ocr::OcrEngine;
        let mut out = Vec::new();
        if let Ok(list) = OcrEngine::AvailableRecognizerLanguages() {
            if let Ok(n) = list.Size() {
                for i in 0..n {
                    if let Ok(l) = list.GetAt(i) {
                        if let Ok(tag) = l.LanguageTag() {
                            out.push(tag.to_string());
                        }
                    }
                }
            }
        }
        out
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// RGBA → WinRT SoftwareBitmap → OcrEngine 识别（纯文本结果）。
#[cfg(target_os = "windows")]
fn ocr_rgba_windows(
    w: u32,
    h: u32,
    rgba: &[u8],
    lang: Option<&str>,
) -> Result<SnipOcrResult, String> {
    let (text, language, _, _) = ocr_rgba_windows_lines(w, h, rgba, lang)?;
    Ok(SnipOcrResult { text, language })
}

/// 识别主流程：返回（按行拼接文本、使用语言、行文本框、缩放回原图系数）。
/// 文本框已换算回**原始裁剪图**像素，前端可直接按 scale 映射回页面坐标。
#[cfg(target_os = "windows")]
fn ocr_rgba_windows_lines(
    w: u32,
    h: u32,
    rgba: &[u8],
    lang: Option<&str>,
) -> Result<(String, String, Vec<SnipOcrBox>, f32), String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapDecoder, BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    let err = |e: windows::core::Error| format!("OCR 失败: {}", e.message());
    let engine = match lang {
        Some(tag) => {
            let language = Language::CreateLanguage(&HSTRING::from(tag)).map_err(err)?;
            OcrEngine::TryCreateFromLanguage(&language).map_err(err)?
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| "系统未安装可用的 OCR 识别语言".to_string())?,
    };
    // 超过引擎最大边长时等比缩小（OcrEngine 对超大图直接失败）
    let max_dim = OcrEngine::MaxImageDimension().map_err(err)?.max(64);
    let (w2, h2, rgba2) = if w > max_dim || h > max_dim {
        let scale = max_dim as f64 / w.max(h) as f64;
        let nw = ((w as f64 * scale).floor() as u32).max(1);
        let nh = ((h as f64 * scale).floor() as u32).max(1);
        let img = image::RgbaImage::from_raw(w, h, rgba.to_vec()).ok_or("图像缓冲无效")?;
        let small = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle);
        (nw, nh, small.into_raw())
    } else {
        (w, h, rgba.to_vec())
    };
    let png = crate::clipboard::image_store::encode_rgba_png(w2, h2, &rgba2)
        .ok_or("PNG 编码失败")?;

    let stream = InMemoryRandomAccessStream::new().map_err(err)?;
    let writer = DataWriter::CreateDataWriter(&stream).map_err(err)?;
    writer.WriteBytes(&png).map_err(err)?;
    writer.StoreAsync().map_err(err)?.get().map_err(err)?;
    writer.FlushAsync().map_err(err)?.get().map_err(err)?;
    let _ = writer.DetachStream();
    stream.Seek(0).map_err(err)?;

    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(err)?
        .get()
        .map_err(err)?;
    let bitmap = decoder.GetSoftwareBitmapAsync().map_err(err)?.get().map_err(err)?;
    // OcrEngine 只接受 Bgra8（premultiplied）；解码原生格式可能是 Rgba8 等
    let bitmap = SoftwareBitmap::Convert(&bitmap, BitmapPixelFormat::Bgra8).map_err(err)?;

    let result = engine.RecognizeAsync(&bitmap).map_err(err)?.get().map_err(err)?;
    let lines = result.Lines().map_err(err)?;
    let n = lines.Size().map_err(err)?;
    // 引擎内坐标 → 原始裁剪图坐标（超大图被等比缩小过）
    let back = w as f32 / w2 as f32;
    let mut text = String::new();
    let mut boxes = Vec::new();
    for i in 0..n {
        let line = lines.GetAt(i).map_err(err)?;
        let t = line.Text().map_err(err)?;
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&t.to_string());
        // 行框 = 该行所有词框的并集（打码按行覆盖，视觉最整齐）
        if let Ok(words) = line.Words() {
            let wn = words.Size().unwrap_or(0);
            let (mut x1, mut y1, mut x2, mut y2) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for j in 0..wn {
                if let Ok(word) = words.GetAt(j) {
                    if let Ok(r) = word.BoundingRect() {
                        x1 = x1.min(r.X);
                        y1 = y1.min(r.Y);
                        x2 = x2.max(r.X + r.Width);
                        y2 = y2.max(r.Y + r.Height);
                    }
                }
            }
            if x2 > x1 && y2 > y1 {
                boxes.push(SnipOcrBox {
                    x: x1 * back,
                    y: y1 * back,
                    w: (x2 - x1) * back,
                    h: (y2 - y1) * back,
                    text: t.to_string(),
                });
            }
        }
    }
    let used = engine
        .RecognizerLanguage()
        .and_then(|l| l.LanguageTag())
        .map(|t| t.to_string())
        .unwrap_or_default();
    Ok((text, used, boxes, back))
}
