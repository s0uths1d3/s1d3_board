import { reactive, ref, watch } from 'vue';
import dbService from '~/src/db/dbService';
import { createBooleanSetting } from '~/composables/useBooleanSetting';

/**
 * 截图（snip）设置项：布尔走 createBooleanSetting 单例工厂，数值/文本走
 * island_timing 同款「默认值常量 + 钳制 + 单例 ref + ensureLoaded + setter」三件套
 * （样板 useCopyIsland.ts:49-104）。键名与 .docs/screenshot-spec.md §1.3 严格一致。
 */

// ===== 标注参数（实时持久化：各工具线宽 / 颜色 / 马赛克程度 / 文字背景 / 方框圆角） =====
// 单 KV JSON blob（snip_anno_params）：参数变更频繁（滑条拖动），合并为一条记录 +
// 300ms 防抖写库；覆盖窗页面与主窗口各自加载一次，变更即写、重启恢复。

export const snipAnno = reactive({
  /** 各工具线宽（key = 工具名；rect/ellipse 上限 20，其余 80） */
  sizes: {} as Record<string, number>,
  color: '#f0b429',
  /** 遮挡块大小（逻辑 px，4~60；马赛克=像素块尺寸，模糊=强度，同一滑条双语义） */
  mosaicBlock: 12,
  /** 遮挡样式：mosaic = 像素块马赛克；blur = 平滑模糊（PixPin 双选项） */
  mosaicStyle: 'mosaic' as 'mosaic' | 'blur',
  textBg: false,
  rectRadius: 0,
  /** 参考辅助线开关（用户实测反馈：需跨会话记住，关掉后下次截图不再显示） */
  guides: true,
});

const SNIP_ANNO_KEY = 'snip_anno_params';
let annoReady = false;
let annoSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 加载标注参数（幂等；覆盖窗 onMounted 调用，resolve 后 snipAnno 即为持久化值） */
export function ensureSnipAnnoLoaded(): Promise<void> {
  return dbService.getKeyValue(SNIP_ANNO_KEY).then((raw) => {
    if (raw) {
      try {
        const p = JSON.parse(raw) as Partial<typeof snipAnno>;
        if (p.sizes && typeof p.sizes === 'object') Object.assign(snipAnno.sizes, p.sizes);
        if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) snipAnno.color = p.color;
        if (typeof p.mosaicBlock === 'number') snipAnno.mosaicBlock = Math.min(60, Math.max(4, Math.round(p.mosaicBlock)));
        if (p.mosaicStyle === 'blur' || p.mosaicStyle === 'mosaic') snipAnno.mosaicStyle = p.mosaicStyle;
        if (typeof p.textBg === 'boolean') snipAnno.textBg = p.textBg;
        if (typeof p.rectRadius === 'number') snipAnno.rectRadius = Math.min(40, Math.max(0, Math.round(p.rectRadius)));
        if (typeof p.guides === 'boolean') snipAnno.guides = p.guides;
      } catch { /* 损坏数据忽略，保持默认 */ }
    }
    annoReady = true;
  }).catch(() => { annoReady = true; });
}

function persistAnno(): void {
  if (!annoReady) return; // 加载期间/加载失败的写回跳过（避免空值覆盖）
  if (annoSaveTimer) clearTimeout(annoSaveTimer);
  annoSaveTimer = setTimeout(() => {
    annoSaveTimer = null;
    void dbService.setKeyValue(SNIP_ANNO_KEY, JSON.stringify({
      sizes: snipAnno.sizes,
      color: snipAnno.color,
      mosaicBlock: snipAnno.mosaicBlock,
      mosaicStyle: snipAnno.mosaicStyle,
      textBg: snipAnno.textBg,
      rectRadius: snipAnno.rectRadius,
      guides: snipAnno.guides,
    })).catch(() => { /* 写入失败静默：内存态仍可用，下次变更重写 */ });
  }, 300);
}
watch(snipAnno, persistAnno, { deep: true });

// ===== 布尔项（总开关 / 自动复制 / 自动入历史） =====

const snipEnabled = createBooleanSetting('snip_enabled', true);
const snipAutoCopy = createBooleanSetting('snip_auto_copy', true);
const snipAutoHistory = createBooleanSetting('snip_auto_history', true);

export function useSnipEnabled() {
  return snipEnabled.useSetting();
}
export async function setSnipEnabled(v: boolean): Promise<void> {
  await snipEnabled.persist(v);
}
export async function isSnipEnabled(): Promise<boolean> {
  await snipEnabled.ensureLoaded();
  return snipEnabled.enabled.value;
}

export function useSnipAutoCopy() {
  return snipAutoCopy.useSetting();
}
export async function setSnipAutoCopy(v: boolean): Promise<void> {
  await snipAutoCopy.persist(v);
}
export async function isSnipAutoCopy(): Promise<boolean> {
  await snipAutoCopy.ensureLoaded();
  return snipAutoCopy.enabled.value;
}

export function useSnipAutoHistory() {
  return snipAutoHistory.useSetting();
}
export async function setSnipAutoHistory(v: boolean): Promise<void> {
  await snipAutoHistory.persist(v);
}
export async function isSnipAutoHistory(): Promise<boolean> {
  await snipAutoHistory.ensureLoaded();
  return snipAutoHistory.enabled.value;
}

// ===== 数值 / 文本项（遮罩暗度 / 保存格式 / jpeg 质量 / 保存目录 / 延时 / 光标） =====

export const SNIP_MASK_OPACITY_DEFAULT = 40;
export const SNIP_MASK_OPACITY_MIN = 10;
export const SNIP_MASK_OPACITY_MAX = 80;
export const SNIP_DELAY_DEFAULT = 0;
export const SNIP_DELAY_MIN = 0;
export const SNIP_DELAY_MAX = 5;
export const SNIP_JPEG_QUALITY_DEFAULT = 90;
export const SNIP_JPEG_QUALITY_MIN = 60;
export const SNIP_JPEG_QUALITY_MAX = 100;

const SNIP_MASK_OPACITY_KEY = 'snip_mask_opacity';
const SNIP_FORMAT_KEY = 'snip_format';
const SNIP_JPEG_QUALITY_KEY = 'snip_jpeg_quality';
const SNIP_SAVE_DIR_KEY = 'snip_save_dir';
const SNIP_DELAY_KEY = 'snip_delay_sec';
const SNIP_CAPTURE_CURSOR_KEY = 'snip_capture_cursor';
const SNIP_CAPTURE_SCOPE_KEY = 'snip_capture_scope';
const SNIP_LAST_REGION_KEY = 'snip_last_region';
const SNIP_UPLOAD_URL_KEY = 'snip_upload_url';
const SNIP_OCR_LANG_KEY = 'snip_ocr_lang';

const maskOpacity = ref(SNIP_MASK_OPACITY_DEFAULT);
const format = ref<'png' | 'jpeg'>('png');
const jpegQuality = ref(SNIP_JPEG_QUALITY_DEFAULT);
const saveDir = ref('');
const delaySec = ref(SNIP_DELAY_DEFAULT);
const captureCursor = createBooleanSetting(SNIP_CAPTURE_CURSOR_KEY, false);
/** 捕获范围：all = 虚拟桌面（跨屏框选，默认）；cursor = 光标所在显示器 */
const captureScope = ref<'all' | 'cursor'>('all');
/** 上传分享目标地址（空 = 未配置，隐藏分享动作） */
const uploadUrl = ref('');
/** OCR 识别语言标签（空 = 跟随系统用户语言） */
const ocrLang = ref('');

function sanitizeMaskOpacity(v: number): number {
  if (!Number.isFinite(v)) return SNIP_MASK_OPACITY_DEFAULT;
  return Math.min(SNIP_MASK_OPACITY_MAX, Math.max(SNIP_MASK_OPACITY_MIN, Math.round(v)));
}
function sanitizeDelay(v: number): number {
  if (!Number.isFinite(v)) return SNIP_DELAY_DEFAULT;
  return Math.min(SNIP_DELAY_MAX, Math.max(SNIP_DELAY_MIN, Math.round(v)));
}
function sanitizeJpegQuality(v: number): number {
  if (!Number.isFinite(v)) return SNIP_JPEG_QUALITY_DEFAULT;
  return Math.min(SNIP_JPEG_QUALITY_MAX, Math.max(SNIP_JPEG_QUALITY_MIN, Math.round(v)));
}

let settingsLoadPromise: Promise<void> | null = null;

/** 触发首次加载（幂等）并等待落定：resolve 后各 ref 即为真实持久化值 */
export function ensureSnipSettingsLoaded(): Promise<void> {
  if (!settingsLoadPromise) {
    settingsLoadPromise = Promise.all([
      dbService.getKeyValue(SNIP_MASK_OPACITY_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_FORMAT_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_JPEG_QUALITY_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_SAVE_DIR_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_DELAY_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_CAPTURE_SCOPE_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_UPLOAD_URL_KEY).catch(() => null),
      dbService.getKeyValue(SNIP_OCR_LANG_KEY).catch(() => null),
    ]).then(([mo, f, q, dir, delay, scope, upload, ocr]) => {
      if (mo && mo.trim()) maskOpacity.value = sanitizeMaskOpacity(Number(mo));
      if (f === 'png' || f === 'jpeg') format.value = f;
      if (q && q.trim()) jpegQuality.value = sanitizeJpegQuality(Number(q));
      if (dir) saveDir.value = dir;
      if (delay && delay.trim()) delaySec.value = sanitizeDelay(Number(delay));
      if (scope === 'all' || scope === 'cursor') captureScope.value = scope;
      if (upload) uploadUrl.value = upload.trim();
      if (ocr) ocrLang.value = ocr.trim();
    });
  }
  return settingsLoadPromise;
}

/** 遮罩不透明度（百分比 10~80）：覆盖窗读取渲染选区外暗化 */
export function useSnipMaskOpacity() {
  ensureSnipSettingsLoaded();
  return maskOpacity;
}
export async function setSnipMaskOpacity(v: number): Promise<void> {
  maskOpacity.value = sanitizeMaskOpacity(v);
  try { await dbService.setKeyValue(SNIP_MASK_OPACITY_KEY, String(maskOpacity.value)); } catch { /* 写入失败不影响本次会话 */ }
}

/** 保存格式：png / jpeg */
export function useSnipFormat() {
  ensureSnipSettingsLoaded();
  return format;
}
export async function setSnipFormat(v: 'png' | 'jpeg'): Promise<void> {
  format.value = v;
  try { await dbService.setKeyValue(SNIP_FORMAT_KEY, v); } catch { /* 写入失败不影响本次会话 */ }
}

/** JPEG 质量（60~100，仅 format=jpeg 时消费） */
export function useSnipJpegQuality() {
  ensureSnipSettingsLoaded();
  return jpegQuality;
}
export async function setSnipJpegQuality(v: number): Promise<void> {
  jpegQuality.value = sanitizeJpegQuality(v);
  try { await dbService.setKeyValue(SNIP_JPEG_QUALITY_KEY, String(jpegQuality.value)); } catch { /* 写入失败不影响本次会话 */ }
}

/** 默认保存目录（空 = 每次保存时询问） */
export function useSnipSaveDir() {
  ensureSnipSettingsLoaded();
  return saveDir;
}
export async function setSnipSaveDir(v: string): Promise<void> {
  saveDir.value = v;
  try { await dbService.setKeyValue(SNIP_SAVE_DIR_KEY, v); } catch { /* 写入失败不影响本次会话 */ }
}

/** 延时截图秒数（0~5） */
export function useSnipDelaySec() {
  ensureSnipSettingsLoaded();
  return delaySec;
}
export async function setSnipDelaySec(v: number): Promise<void> {
  delaySec.value = sanitizeDelay(v);
  try { await dbService.setKeyValue(SNIP_DELAY_KEY, String(delaySec.value)); } catch { /* 写入失败不影响本次会话 */ }
}

/** 截屏是否包含鼠标光标 */
export function useSnipCaptureCursor() {
  return captureCursor.useSetting();
}
export async function setSnipCaptureCursor(v: boolean): Promise<void> {
  await captureCursor.persist(v);
}
export async function isSnipCaptureCursor(): Promise<boolean> {
  await captureCursor.ensureLoaded();
  return captureCursor.enabled.value;
}

// ===== 捕获范围 / 上次选区 / 上传地址 / OCR 语言 =====

/** 捕获范围（all = 虚拟桌面跨屏；cursor = 光标所在显示器） */
export async function getSnipCaptureScope(): Promise<'all' | 'cursor'> {
  await ensureSnipSettingsLoaded();
  return captureScope.value;
}
export function useSnipCaptureScope() {
  ensureSnipSettingsLoaded();
  return captureScope;
}
export async function setSnipCaptureScope(v: 'all' | 'cursor'): Promise<void> {
  captureScope.value = v;
  try { await dbService.setKeyValue(SNIP_CAPTURE_SCOPE_KEY, v); } catch { /* 忽略 */ }
}

/** 物理像素选区（屏幕全局坐标） */
export interface SnipRegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 记下上次确认的选区（多入口「上次区域」快捷键复用） */
export async function getSnipLastRegion(): Promise<SnipRegionRect | null> {
  try {
    const raw = await dbService.getKeyValue(SNIP_LAST_REGION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SnipRegionRect>;
    if (
      typeof p.x === 'number' && typeof p.y === 'number' &&
      typeof p.w === 'number' && typeof p.h === 'number' &&
      p.w > 0 && p.h > 0
    ) {
      return { x: p.x, y: p.y, w: p.w, h: p.h };
    }
  } catch { /* 损坏数据忽略 */ }
  return null;
}
export async function setSnipLastRegion(r: SnipRegionRect | null): Promise<void> {
  try {
    await dbService.setKeyValue(SNIP_LAST_REGION_KEY, r ? JSON.stringify(r) : '');
  } catch { /* 忽略 */ }
}

/** 上传分享地址（空 = 未配置，前端隐藏分享动作） */
export function useSnipUploadUrl() {
  ensureSnipSettingsLoaded();
  return uploadUrl;
}
export async function setSnipUploadUrl(v: string): Promise<void> {
  uploadUrl.value = v.trim();
  try { await dbService.setKeyValue(SNIP_UPLOAD_URL_KEY, uploadUrl.value); } catch { /* 忽略 */ }
}

/** OCR 语言标签（空 = 跟随系统用户语言） */
export function useSnipOcrLang() {
  ensureSnipSettingsLoaded();
  return ocrLang;
}
export async function setSnipOcrLang(v: string): Promise<void> {
  ocrLang.value = v.trim();
  try { await dbService.setKeyValue(SNIP_OCR_LANG_KEY, ocrLang.value); } catch { /* 忽略 */ }
}
