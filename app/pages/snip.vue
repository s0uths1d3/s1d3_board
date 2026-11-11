<script setup lang="ts">
/**
 * 截图覆盖窗（/snip，窗口由 snipManager 创建：铺满光标所在显示器、透明置顶）。
 *
 * 页面自治交互（照 RingOverlay 模式：overlay 持有系统焦点，键盘页内处理）：
 * 冻结画面背景 + 选区外暗化遮罩 + 十字线 + 尺寸角标 + 8 向手柄 + 放大镜取色 +
 * 窗口吸附 + 标注工具栏（矩形/椭圆/箭头/画笔/文字/马赛克，撤销重做）。
 * 确认/取消经 snip:confirm / snip:cancel 事件交回管理器；有标注时先在本页把
 * 标注烘焙进裁剪图（save_clipboard_image 落盘）再交 annotatedRef（P1-T1）。
 *
 * 交互状态机：loading → idle（十字线+吸附+取色）→ drawing（拖拽建区）→
 * selected（手柄/移动/标注/工具条）。拖拽全程 setPointerCapture。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useHead } from '#imports';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from 'tauri-plugin-clipboard-api';
import { useI18n } from '~/composables/useI18n';
import { useTransparentWindow } from '~/composables/useTransparentWindow';
import { notifyIsland, suppressIslandCopy } from '~/composables/useCopyIsland';
import UiColorPicker from '~/components/ui/UiColorPicker.vue';
import { open } from '@tauri-apps/plugin-dialog';
import { join, pictureDir } from '@tauri-apps/api/path';
import {
  ensureSnipAnnoLoaded, snipAnno,
  ensureSnipSettingsLoaded, setSnipFormat, setSnipJpegQuality, setSnipSaveDir, setSnipLastRegion,
  useSnipFormat, useSnipJpegQuality, useSnipMaskOpacity, useSnipOcrLang, useSnipSaveDir, useSnipUploadUrl,
} from '~/src/snip/snipSettings';
import { aiVision, loadAiConfig } from '~/src/smart-clip/aiClient';
import { resolveImageContent } from '~/src/core/db/imageRef';
import {
  boundsOf as annoBoundsOf,
  cloneAnno,
  defaultMeasureText,
  hitBoundsOf,
  nextStepLabel,
  renumberSteps,
  resizeAnnoByHandle,
  stepRadius,
  type AnnoTool,
  type Annotation,
  type MeasureText,
} from '~/src/snip/annotations';
import {
  hitTestHandle,
  isValidSelection,
  moveRect,
  rectFromDrag,
  resizeByHandle,
  type Handle,
  type Rect,
} from '~/src/snip/selection';

useHead({
  style: [{ innerHTML: 'html, body { background: transparent !important; background-image: none !important; }' }],
});
const { t } = useI18n();

// ===== 会话数据（snipManager emitTo snip:data 下发） =====
const bgDataUrl = ref('');
const scale = ref(1);
/** 覆盖窗左上角的屏幕物理坐标（窗口探测结果换算回页面坐标的偏移基准） */
const monitorOrigin = reactive({ x: 0, y: 0 });

type Mode = 'loading' | 'idle' | 'drawing' | 'selected' | 'resizing' | 'moving';
const mode = ref<Mode>('loading');

const viewW = ref(0);
const viewH = ref(0);
/** 遮罩暗度（百分比，snip_mask_opacity） */
const maskOpacity = ref(40);

// ===== 选区状态 =====
const selection = ref<Rect | null>(null);
const dragStart = reactive({ x: 0, y: 0 });
const moveStart = reactive({ x: 0, y: 0, rect: null as Rect | null });
const cursor = reactive({ x: -1, y: -1 });
const hoveredWindow = ref<Rect | null>(null);
/** 参考辅助线（选区内三分线 + 中心线）：G 键或工具条切换；状态实时持久化
 *  （snip_anno_params.guides，关掉后下次截图不再显示——用户实测反馈） */
const showGuides = computed({
  get: () => snipAnno.guides,
  set: (v: boolean) => { snipAnno.guides = v; },
});

// ===== 响应式 UI 缩放：按显示器物理高度分级（1080p=1×，2K≈1.33，4K=2，封顶 2）。
//  工具条 / 手柄 / 辅助线 / 放大镜 / 十字线统一乘该系数——固定 CSS 像素在
//  高分屏上是"迷你 UI"（用户实测反馈：按钮小、辅助线细到不可见）=====
const monitorPhysicalH = ref(1080);
const uiScale = computed(() =>
  Math.min(2, Math.max(1, Math.round((monitorPhysicalH.value / 1080) * 4) / 4)),
);
const handleSize = computed(() => Math.max(8, Math.round(9 * uiScale.value)));
const selBorder = computed(() => Math.max(2, Math.round(1.5 * uiScale.value)));
const guideW = computed(() => Math.max(1, Math.round(uiScale.value)));

/** 放大镜取色（跟随光标；img 像素采样，同源 data URL 无 canvas 污染） */
const magnifier = reactive({ visible: false, hex: '', rgb: '' });

let unlisteners: Array<() => void> = [];
/** 原生对话框打开计数（>0 时失焦不触发兜底取消，见 onFocusChanged 护盾注释） */
let nativeDialogOpen = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 标注系统（P1-T1）：对象数组 + 快照栈，页面逻辑坐标，烘焙时乘 scale =====
/** 工具 = 标注工具 + 移动/选择工具 */
type Tool = AnnoTool | 'move';
const SNIP_PALETTE = ['#f0b429', '#ef4444', '#3b82f6', '#22c55e', '#111111', '#ffffff'];
const SNIP_SIZE_MIN = 1;
const SNIP_SIZE_MAX = 80;
const SNIP_RADIUS_MAX = 40;
/** 马赛克块大小（逻辑 px，2~60，PixPin 同款「块大小」参数；默认 6 = 细粒度，
 *  挡住文字的同时保留整体版面观感。实时持久化：snip_anno_params KV） */
/** 遮挡块大小（逻辑 px 4~60；马赛克=像素块尺寸，模糊=强度，同一滑条双语义） */
const mosaicBlock = computed({
  get: () => snipAnno.mosaicBlock,
  set: (v: number) => { snipAnno.mosaicBlock = Math.min(60, Math.max(4, Math.round(v))); },
});
/** 遮挡样式：mosaic = 像素块马赛克；blur = 平滑模糊（实时持久化，PixPin 双选项） */
const mosaicStyle = computed({
  get: () => snipAnno.mosaicStyle,
  set: (v: 'mosaic' | 'blur') => { snipAnno.mosaicStyle = v; },
});
const annoTool = ref<Tool | null>(null);
const annoColor = computed({
  get: () => snipAnno.color,
  set: (v: string) => { snipAnno.color = v; },
});
/** 线宽/笔刷大小按工具独立记忆：每个标注工具保留自己的值（默认 5，范围 1~80）。
 *  方框/椭圆描边过粗视觉不可用，单独钳制到 20；马赛克笔刷上限 100 */
const DEFAULT_ANNO_SIZE = 5;
const TOOL_SIZE_MAX: Partial<Record<AnnoTool, number>> = { rect: 20, ellipse: 20 };
const currentSizeMax = computed(() => {
  const t = annoTool.value;
  return (t && t !== 'move' ? TOOL_SIZE_MAX[t] : undefined) ?? SNIP_SIZE_MAX;
});
const currentSize = computed({
  get: () => {
    const t = annoTool.value;
    const v = (t && snipAnno.sizes[t]) ?? DEFAULT_ANNO_SIZE;
    return Math.min(currentSizeMax.value, v);
  },
  set: (v: number) => {
    const t = annoTool.value;
    if (t) snipAnno.sizes[t] = v;
  },
});
/** 方框圆角（0~40 逻辑 px，渲染时再钳到 min(w,h)/2） */
const rectRadius = computed({
  get: () => snipAnno.rectRadius,
  set: (v: number) => { snipAnno.rectRadius = Math.min(SNIP_RADIUS_MAX, Math.max(0, Math.round(v))); },
});
/** 颜色选取面板开关（复用 UiColorPicker：预设板 + 色环 + 十六进制输入） */
const colorOpen = ref(false);
/** 文字背景衬块开关（默认关；提交时随标注记录，只影响新文字） */
const textBg = computed({
  get: () => snipAnno.textBg,
  set: (v: boolean) => { snipAnno.textBg = v; },
});
let annoSeq = 0;
const annotations = ref<Annotation[]>([]);
const undoStack = ref<Annotation[][]>([]);
const redoStack = ref<Annotation[][]>([]);
/** 进行中的标注（拖拽中） */
const activeAnno = ref<Annotation | null>(null);
let annoDragging = false;
/** 移动工具拖拽状态（目标标注 id + 上一步光标）；moved 用于延迟入撤销栈
 *  （单纯点选不应产生撤销记录） */
const moveState = reactive({ active: false, id: 0, lastX: 0, lastY: 0, moved: false });
/** 长截图中止标记（Esc 或会话取消时置位，抓帧循环尽快退出） */
let longAbort = false;
/** 对象级编辑：当前选中标注 id（move 工具下可缩放/删除/复制） */
const annoSelectedId = ref(0);
/** 标注缩放手柄拖拽状态 */
const annoResize = reactive({ active: false, handle: 'se' as Handle, id: 0 });
/** 文字工具：浮动输入框位置与内容 */
const textDraft = reactive({ visible: false, x: 0, y: 0, value: '', bg: false });
const textInputEl = ref<HTMLTextAreaElement | null>(null);

function snapshotForUndo(): void {
  undoStack.value.push(annotations.value.map((a) => ({ ...a, points: a.points ? [...a.points] : undefined })));
  if (undoStack.value.length > 50) undoStack.value.shift();
  redoStack.value = [];
}
function undoAnno(): void {
  const prev = undoStack.value.pop();
  if (!prev) return;
  redoStack.value.push(annotations.value.map((a) => ({ ...a, points: a.points ? [...a.points] : undefined })));
  annotations.value = prev;
  redrawAnnos();
}
function redoAnno(): void {
  const next = redoStack.value.pop();
  if (!next) return;
  undoStack.value.push(annotations.value.map((a) => ({ ...a, points: a.points ? [...a.points] : undefined })));
  annotations.value = next;
  redrawAnnos();
}

/** 删除选中标注（恢复快照可撤销；序号随之重排保持连续） */
function deleteSelectedAnno(): void {
  const id = annoSelectedId.value;
  if (!id) return;
  const idx = annotations.value.findIndex((a) => a.id === id);
  if (idx < 0) { annoSelectedId.value = 0; return; }
  snapshotForUndo();
  const next = annotations.value.slice();
  next.splice(idx, 1);
  annotations.value = renumberSteps(next);
  annoSelectedId.value = 0;
  redrawAnnos();
}

/** 复制选中标注（偏移 16px；副本成为新的选中项；序号重排） */
function duplicateSelectedAnno(): void {
  const a = selectedAnno();
  if (!a) return;
  snapshotForUndo();
  const copy = cloneAnno(a, ++annoSeq, 16, 16);
  annotations.value = renumberSteps([...annotations.value, copy]);
  annoSelectedId.value = copy.id;
  redrawAnnos();
}

/** 近白色判定（序号数字反色：浅色圆底用深色数字） */
function isNearWhite(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 200;
}

// ===== 生命周期 =====
onMounted(async () => {
  useTransparentWindow();
  await ensureSnipSettingsLoaded();
  await ensureSnipAnnoLoaded();
  maskOpacity.value = useSnipMaskOpacity().value;

  const win = getCurrentWebviewWindow();
  // 窗口级监听（禁止全局 listen：多窗口串扰，见 bubble.vue ring 模式注释）
  unlisteners.push(await win.listen<{
    dataUrl: string; scale: number; originX: number; originY: number; width: number; height: number;
    preselect?: { x: number; y: number; w: number; h: number } | null;
  }>('snip:data', (ev) => {
    void startSession(ev.payload);
  }));
  // OCR 能力检测：系统未安装识别语言时隐藏动作（非 Windows 恒空）
  void invoke<string[]>('snip_ocr_languages')
    .then((langs) => { ocrLangs.value = Array.isArray(langs) ? langs : []; })
    .catch(() => { ocrLangs.value = []; });
  // AI 识图能力：已配置 Key 且提供商支持图片输入才显示按钮
  void loadAiConfig()
    .then((cfg) => { aiReady.value = Boolean(cfg.apiKey) && cfg.provider !== 'custom'; })
    .catch(() => { aiReady.value = false; });
  // 全分辨率引用转发（管理器 full-ready 后 emitTo）：保存自闭环的裁剪源 +
  // 全分辨率标注烘焙 / 放大镜采样源（4K 屏不再用预览放大）
  unlisteners.push(await win.listen<{ fileRef: string }>('snip:full-ref', (ev) => {
    fullFileRef.value = ev.payload.fileRef;
    void loadFullSource(ev.payload.fileRef);
  }));
  // 原生对话框护盾：目录/文件选择等系统对话框打开期间覆盖窗必然失焦——
  // 不护盾会被「失焦兜底取消」误杀（点浏览界面直接消失，用户实测）。
  // 计数制：页面自身 browse +1，管理器保存对话框经 snip:dialog-guard 事件 ±1
  unlisteners.push(await listen<number>('snip:dialog-guard', (ev) => {
    nativeDialogOpen += Number(ev.payload) || 0;
  }));
  unlisteners.push(await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    // 覆盖窗失焦 = 被系统/其他应用抢焦点：兜底取消（正常路径是 Esc/右键 snip:cancel）；
    // 原生对话框打开期间的失焦不算（对话框关闭后焦点自然回流）
    if (!focused && mode.value !== 'loading' && nativeDialogOpen === 0) void emit('snip:cancel');
  }));
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('dblclick', onDblClick);
  // 页面级异常入 HUD（覆盖窗 devtools 打不开，错误原文需要屏上可见）
  window.addEventListener('error', (e) => trace(`页面错误：${e.message}`));
  window.addEventListener('unhandledrejection', (e) => trace(`未处理拒绝：${String(e.reason)}`));
  await emit('snip:ready', getCurrentWindow().label);
});

onBeforeUnmount(() => {
  for (const u of unlisteners) u();
  unlisteners = [];
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('contextmenu', onContextMenu);
  window.removeEventListener('dblclick', onDblClick);
  if (probeTimer) clearTimeout(probeTimer);
});

/** 会话启动：遮罩与交互**即时**可用（mode 先行），冻结画面按引用异步读盘跟上
 *  （本地盘读 + base64 百毫秒级，读盘失败自动重试一次，仍失败弹岛并取消——
 *  无底图的框选等于盲选）。常驻窗复用：每次会话完整重置上一轮状态。
 *  视口尺寸用载荷值而非 window.innerWidth——隐藏窗刚 setSize 时 viewport 存在
 *  尚未同步的竞态（可能仍是预热的 1×1） */
async function startSession(p: {
  dataUrl: string; scale: number; originX: number; originY: number; width: number; height: number;
  preselect?: { x: number; y: number; w: number; h: number } | null;
}): Promise<void> {
  scale.value = p.scale;
  monitorOrigin.x = p.originX;
  monitorOrigin.y = p.originY;
  selection.value = null;
  annotations.value = [];
  undoStack.value = [];
  redoStack.value = [];
  activeAnno.value = null;
  annoDragging = false;
  annoTool.value = null;
  annoSelectedId.value = 0;
  annoResize.active = false;
  textDraft.visible = false;
  hoveredWindow.value = null;
  magnifier.visible = false;
  colorOpen.value = false;
  savePanelOpen.value = false;
  fullFileRef.value = null;
  fullSourceImg = null;
  fullSourceCanvas.value = null;
  bakeSourceImg = null;
  saveTrace.value = [];
  toolbarManual.value = null; // 新会话：工具条恢复自动定位
  viewW.value = p.width;
  viewH.value = p.height;
  monitorPhysicalH.value = Math.round(p.height * p.scale);
  // 冻结画面 = 管理器随事件直达的预览图（≤2K 原图 / 4K 缩小，热路径快编产物）：
  // 无读盘、无二次 IPC，mask 与底图同帧就位。全分辨率原图仅确认裁剪时由 Rust 用
  if (!p.dataUrl.startsWith('data:')) {
    snipNotify({ kind: 'error', text: t('snip.capture_failed') });
    void emit('snip:cancel');
    return;
  }
  bgDataUrl.value = p.dataUrl;
  // 多入口预选（全屏 / 窗口 / 上次区域）：直接进入 selected 态，用户可微调或确认
  if (p.preselect && p.preselect.w >= 2 && p.preselect.h >= 2) {
    selection.value = { ...p.preselect };
    mode.value = 'selected';
  } else {
    mode.value = 'idle';
  }
  redrawAnnos(); // 清空上一轮标注层（画布尺寸随视口重置）
}

/** 底图加载完成：建立物理分辨率源画布（马赛克采样 / 确认烘焙共用） */
function onBgLoad(): void {
  const img = bgImgRef.value;
  if (!img || !img.naturalWidth) return;
  (bgSourceCanvas ??= document.createElement('canvas')).width = img.naturalWidth;
  bgSourceCanvas.height = img.naturalHeight;
  bgSourceCanvas.getContext('2d')?.drawImage(img, 0, 0);
}

// ===== 指针交互 =====
// 拖拽优先语义（Snipaste 标准）：idle 按下不立即选窗——移动超过阈值进入框选，
// 原地抬起才算「选中悬停窗口」。否则悬停高亮覆盖屏幕大部分区域（最大化窗口 /
// 桌面）时，任何按下都被整窗选中劫持，自定义区域永远画不出来（用户实测反馈）。
const DRAG_THRESHOLD = 4;
const press = reactive({ active: false, x: 0, y: 0, moved: false });

function onPointerDown(e: PointerEvent) {
  if (mode.value !== 'idle' && mode.value !== 'selected') return;
  // 画布区域按下：收起取色/保存面板、提交未落定的文字草稿（工具条自身 pointerdown.stop，不经过此处）
  colorOpen.value = false;
  savePanelOpen.value = false;
  if (textDraft.visible) void commitTextDraft();
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  cursor.x = e.clientX;
  cursor.y = e.clientY;
  if (mode.value === 'idle') {
    // 只记录按下：拖拽 / 单击选窗 / 取色 在 move 超阈值与抬起时分流
    press.active = true;
    press.x = e.clientX;
    press.y = e.clientY;
    press.moved = false;
    return;
  }
  // selected：手柄优先，其次标注工具，再次选区内拖动移动，选区外重开框选
  const rect = selection.value;
  if (!rect) return;
  const handle = hitTestHandle(rect, e.clientX, e.clientY, handleSize.value);
  if (handle) {
    mode.value = 'resizing';
    (el as any).__snipHandle = handle;
    return;
  }
  const inSel = inRect(rect, e.clientX, e.clientY);
  if (annoTool.value && inSel) {
    if (annoTool.value === 'text') {
      openTextDraft(e.clientX, e.clientY);
      return;
    }
    // 移动工具：先判选中对象的手柄（缩放），再拾取最上层标注（点选/平移）
    if (annoTool.value === 'move') {
      const sel = selectedAnno();
      if (sel) {
        const b = annoBounds(sel);
        const h = b ? hitTestHandle(b, e.clientX, e.clientY, handleSize.value) : null;
        if (h) {
          snapshotForUndo();
          annoResize.active = true;
          annoResize.handle = h;
          annoResize.id = sel.id;
          return;
        }
      }
      const target = topmostAnnoAt(e.clientX, e.clientY);
      if (!target) {
        // 点空白：取消选中（不产生标注变更）
        if (annoSelectedId.value) {
          annoSelectedId.value = 0;
          redrawAnnos();
        }
        return;
      }
      annoSelectedId.value = target.id;
      moveState.active = true;
      moveState.id = target.id;
      moveState.lastX = e.clientX;
      moveState.lastY = e.clientY;
      moveState.moved = false;
      redrawAnnos();
      return;
    }
    // 序号工具：单击落点（不进拖拽状态机），编号按现有最大值 +1
    if (annoTool.value === 'step') {
      snapshotForUndo();
      annotations.value.push({
        id: ++annoSeq,
        tool: 'step',
        color: annoColor.value,
        size: currentSize.value,
        x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY,
        label: nextStepLabel(annotations.value),
      });
      redrawAnnos();
      return;
    }
    snapshotForUndo();
    annoDragging = true;
    const freehand = annoTool.value === 'pen' || annoTool.value === 'highlighter';
    activeAnno.value = {
      id: ++annoSeq,
      tool: annoTool.value,
      color: annoColor.value,
      size: currentSize.value,
      x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY,
      points: freehand ? [{ x: e.clientX, y: e.clientY }] : undefined,
      block: annoTool.value === 'mosaic' ? mosaicBlock.value : undefined,
      style: annoTool.value === 'mosaic' ? mosaicStyle.value : undefined,
      radius: annoTool.value === 'rect' ? rectRadius.value : undefined,
    };
    return;
  }
  if (inSel) {
    mode.value = 'moving';
    moveStart.x = e.clientX;
    moveStart.y = e.clientY;
    moveStart.rect = { ...rect };
  } else {
    dragStart.x = e.clientX;
    dragStart.y = e.clientY;
    mode.value = 'drawing';
    selection.value = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  }
}

function onPointerMove(e: PointerEvent) {
  cursor.x = e.clientX;
  cursor.y = e.clientY;
  // 按下后位移超阈值 → 从按下点进入框选（拖拽优先于整窗选中）
  if (press.active && !press.moved) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD) {
      press.moved = true;
    }
  }
  if (mode.value === 'idle') {
    if (press.active && press.moved) {
      mode.value = 'drawing';
      dragStart.x = press.x;
      dragStart.y = press.y;
      hoveredWindow.value = null;
      selection.value = rectFromDrag(press.x, press.y, e.clientX, e.clientY, viewW.value, viewH.value);
      updateMagnifier();
      return;
    }
    scheduleWindowProbe(e.clientX, e.clientY);
    updateMagnifier();
    return;
  }
  if (mode.value === 'drawing') {
    updateMagnifier();
    selection.value = rectFromDrag(dragStart.x, dragStart.y, e.clientX, e.clientY, viewW.value, viewH.value);
    return;
  }
  // 标注对象缩放手柄拖拽：按手柄映射几何（跨轴翻转由纯函数处理）
  if (annoResize.active) {
    const idx = annotations.value.findIndex((a) => a.id === annoResize.id);
    if (idx < 0) { annoResize.active = false; return; }
    annotations.value[idx] = resizeAnnoByHandle(
      annotations.value[idx]!, annoResize.handle, e.clientX, e.clientY, measureTextReal,
    );
    redrawAnnos();
    return;
  }
  // 移动工具：目标标注实时平移（选区钳制），首次真实位移才入撤销栈
  if (moveState.active) {
    const target = annotations.value.find((a) => a.id === moveState.id);
    if (!target) { moveState.active = false; return; }
    if (!moveState.moved) {
      snapshotForUndo();
      moveState.moved = true;
    }
    translateAnnoClamped(target, e.clientX - moveState.lastX, e.clientY - moveState.lastY, selection.value!);
    moveState.lastX = e.clientX;
    moveState.lastY = e.clientY;
    redrawAnnos();
    return;
  }
  // 标注拖拽：更新进行中对象并重绘标注层
  if (annoDragging && activeAnno.value) {
    const a = activeAnno.value;
    const sel = selection.value!;
    let cx = Math.min(Math.max(e.clientX, sel.x), sel.x + sel.w);
    let cy = Math.min(Math.max(e.clientY, sel.y), sel.y + sel.h);
    if (a.tool === 'pen' || a.tool === 'highlighter') a.points!.push({ x: cx, y: cy });
    else if (a.tool === 'rect' || a.tool === 'ellipse') {
      // Shift：方框→正方形、椭圆→正圆（取较长边，方向跟随拖拽象限）
      if (e.shiftKey) {
        const sx = cx >= a.x1 ? 1 : -1;
        const sy = cy >= a.y1 ? 1 : -1;
        const side = Math.max(Math.abs(cx - a.x1), Math.abs(cy - a.y1));
        cx = a.x1 + sx * side;
        cy = a.y1 + sy * side;
      }
      a.x2 = Math.min(Math.max(cx, sel.x), sel.x + sel.w);
      a.y2 = Math.min(Math.max(cy, sel.y), sel.y + sel.h);
    } else { a.x2 = cx; a.y2 = cy; }
    redrawAnnos();
    return;
  }
  const rect = selection.value;
  if (!rect) return;
  if (mode.value === 'resizing') {
    const handle = (e.currentTarget as any).__snipHandle as Handle;
    selection.value = resizeByHandle(rect, handle, e.clientX, e.clientY, viewW.value, viewH.value);
  } else if (mode.value === 'moving' && moveStart.rect) {
    const dx = e.clientX - moveStart.x;
    const dy = e.clientY - moveStart.y;
    selection.value = moveRect(moveStart.rect, dx, dy, viewW.value, viewH.value);
  }
}

async function onPointerUp(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  const wasPress = press.active;
  const pressMoved = press.moved;
  press.active = false;
  if (moveState.active) { moveState.active = false; return; }
  if (annoResize.active) { annoResize.active = false; return; }
  if (annoDragging && activeAnno.value) {
    annoDragging = false;
    const a = activeAnno.value;
    // 过小（单点矩形/两点箭头）丢弃并回退快照；笔迹类至少 2 点
    const tiny = a.tool === 'pen' || a.tool === 'highlighter'
      ? (a.points?.length ?? 0) < 2
      : Math.abs(a.x2 - a.x1) < 3 && Math.abs(a.y2 - a.y1) < 3;
    if (tiny) {
      undoStack.value.pop();
      activeAnno.value = null;
      redrawAnnos();
    } else {
      annotations.value.push(a);
      activeAnno.value = null;
      redrawAnnos();
    }
    return;
  }
  if (mode.value === 'drawing') {
    if (selection.value && isValidSelection(selection.value)) {
      mode.value = 'selected';
    } else {
      // 误触（小于最小选区）：回到 idle，选区清空
      selection.value = null;
      mode.value = 'idle';
    }
  } else if (mode.value === 'resizing' || mode.value === 'moving') {
    const ok = selection.value ? isValidSelection(selection.value) : false;
    mode.value = ok ? 'selected' : 'idle';
    if (!ok) selection.value = null;
  } else if (wasPress && mode.value === 'idle' && !pressMoved) {
    // 原地单击（无位移）分流：悬停窗口 → 选中整窗；无窗口 → 复制色值
    if (hoveredWindow.value) {
      selection.value = { ...hoveredWindow.value };
      hoveredWindow.value = null;
      mode.value = 'selected';
    } else if (magnifier.hex) {
      suppressIslandCopy();
      try {
        await writeText(magnifier.hex);
        snipNotify({ kind: 'success', text: t('snip.color_copied', { hex: magnifier.hex }) });
      } catch { /* 写剪贴板失败：静默 */ }
    }
  }
}

// ===== 文字标注（浮动输入框；Enter 提交，Esc 取消；双击已有文字再次编辑） =====
function openTextDraft(x: number, y: number): void {
  // 已有草稿未提交：先提交，避免快照栈污染与内容丢失
  if (textDraft.visible) void commitTextDraft();
  snapshotForUndo();
  showTextDraft(x, y, '', textBg.value);
}
/** 展示草稿输入框（新建与双击再编辑共用；快照由调用方负责） */
function showTextDraft(x: number, y: number, text: string, bg: boolean): void {
  textDraft.visible = true;
  textDraft.x = x;
  textDraft.y = y;
  textDraft.value = text;
  textDraft.bg = bg;
  void nextTick(() => textInputEl.value?.focus());
}
/** 双击已有文字标注 → 移除并回到草稿（提交即原位更新；Esc 撤销栈还原原文） */
function editTextAnno(a: Annotation): void {
  snapshotForUndo();
  annotations.value = annotations.value.filter((it) => it.id !== a.id);
  redrawAnnos();
  showTextDraft(a.x1, a.y1, a.text ?? '', a.bg ?? false);
}
async function commitTextDraft(): Promise<void> {
  // 守卫：textarea 的 Enter 与 window 级 keydown 都会触发（冒泡），双重提交会让
  // 同一段文字画两次——首次调用即置 false，后续调用直接返回
  if (!textDraft.visible) return;
  textDraft.visible = false;
  const v = textDraft.value.trim();
  if (!v) { undoStack.value.pop(); return; }
  annotations.value.push({
    id: ++annoSeq,
    tool: 'text',
    color: annoColor.value,
    size: currentSize.value,
    x1: textDraft.x, y1: textDraft.y, x2: textDraft.x, y2: textDraft.y,
    text: textDraft.value,
    bg: textDraft.bg,
  });
  redrawAnnos();
  await nextTick();
  getCurrentWebviewWindow().setFocus().catch(() => {});
}

// ===== 放大镜（96px 窗 = 光标周 12 物理px 的像素块放大 + 取色） =====
const magCanvas = ref<HTMLCanvasElement | null>(null);
const bgImgRef = ref<HTMLImageElement | null>(null);

function updateMagnifier(): void {
  const preview = bgImgRef.value;
  const canvas = magCanvas.value;
  if (!preview || !preview.naturalWidth || !canvas) {
    magnifier.visible = false;
    return;
  }
  magnifier.visible = true;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  // 优先全分辨率原图：4K 屏预览长边仅 2560，用预览采样等于放大模糊块；
  // full-ref 到达后改用原图（12 物理像素 → 96px 放大，取色精确到物理像素）
  const src: CanvasImageSource = fullSourceImg ?? preview;
  const srcW = fullSourceImg ? fullSourceImg.naturalWidth : preview.naturalWidth;
  const srcH = fullSourceImg ? fullSourceImg.naturalHeight : preview.naturalHeight;
  if (srcW < 12 || srcH < 12) { magnifier.visible = false; return; }
  // 源区域钳制在图内（光标贴边时区域随之收进），保证画布中心恒为光标像素
  const sx = Math.min(Math.max(0, Math.floor(cursor.x * scale.value) - 6), srcW - 12);
  const sy = Math.min(Math.max(0, Math.floor(cursor.y * scale.value) - 6), srcH - 12);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 96, 96);
  ctx.drawImage(src, sx, sy, 12, 12, 0, 0, 96, 96);
  const data = ctx.getImageData(48, 48, 1, 1).data;
  const [r = 0, g = 0, b = 0] = data;
  const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  magnifier.hex = hex.toUpperCase();
  magnifier.rgb = `${r}, ${g}, ${b}`;
}

// ===== 窗口吸附（物理像素探测 → 逻辑坐标高亮，120ms 节流） =====
function scheduleWindowProbe(cx: number, cy: number): void {
  if (probeTimer) return;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    void invoke<{ x: number; y: number; w: number; h: number } | null>('snip_windows_at_point', {
      // 全局物理坐标 = 页面逻辑坐标 × scale + 覆盖窗（虚拟桌面）原点。
      // 漏加原点会让副屏/负坐标屏的窗口探测落到主屏，吸附框错位
      x: Math.round(cx * scale.value + monitorOrigin.x),
      y: Math.round(cy * scale.value + monitorOrigin.y),
    }).then((r) => {
      if (!r || r.w <= 0 || r.h <= 0) { hoveredWindow.value = null; return; }
      // 全局物理坐标 → 页面内逻辑坐标：减显示器原点后除 scale
      hoveredWindow.value = {
        x: (r.x - monitorOrigin.x) / scale.value,
        y: (r.y - monitorOrigin.y) / scale.value,
        w: r.w / scale.value,
        h: r.h / scale.value,
      };
    }).catch(() => { hoveredWindow.value = null; });
  }, 120);
}

function inRect(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

// ===== 键盘（页内自治，overlay 持焦时主窗口 local 快捷键收不到） =====
function onKeydown(e: KeyboardEvent) {
  // 长截图进行中：仅接受 Esc 中止（其余按键属于目标应用）
  if (longMode.value) {
    if (e.key === 'Escape') longAbort = true;
    return;
  }
  // OCR 结果确认框：Esc 取消、Ctrl/Cmd+Enter 确认复制；其余按键交给文本框
  if (ocrResult.visible) {
    if (e.key === 'Escape') {
      e.preventDefault();
      ocrResult.visible = false;
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void confirmOcrCopy();
      return;
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    // Esc 阶梯（逐层退出，不一键全关）：保存面板 → 草稿 → 取色面板 → 工具模式 → 选中态 → 关闭截图
    if (savePanelOpen.value) { savePanelOpen.value = false; return; }
    if (textDraft.visible) { textDraft.visible = false; undoStack.value.pop(); return; }
    if (colorOpen.value) { colorOpen.value = false; return; }
    if (annoTool.value) { annoTool.value = null; return; }
    if (selection.value) {
      // 取消选中：标注一并清空（重新框选从干净状态开始），撤销栈随之重置。
      // 拖拽中按 Esc：同步复位按压/标注拖拽状态，避免指针后续事件落入异常分支
      selection.value = null;
      annotations.value = [];
      undoStack.value = [];
      redoStack.value = [];
      press.active = false;
      press.moved = false;
      annoDragging = false;
      annoResize.active = false;
      annoSelectedId.value = 0;
      activeAnno.value = null;
      redrawAnnos();
      mode.value = 'idle';
      return;
    }
    void emit('snip:cancel');
    return;
  }
  if (textDraft.visible) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void commitTextDraft();
    }
    return; // 输入中的按键不进下面分支
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redoAnno(); else undoAnno();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redoAnno();
    return;
  }
  // Ctrl+S：快捷保存（跳过保存面板，按当前目录/格式/质量直接落盘）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (mode.value === 'selected' && selection.value) void doSave();
    return;
  }
  if (e.key === 'Enter' && mode.value === 'selected' && !annoTool.value) {
    e.preventDefault();
    confirmSelection('copy');
    return;
  }
  // 对象级编辑：Delete/Backspace 删除选中标注；Ctrl+D 原地复制
  if (mode.value === 'selected' && annoSelectedId.value && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    deleteSelectedAnno();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && mode.value === 'selected' && annoSelectedId.value) {
    e.preventDefault();
    duplicateSelectedAnno();
    return;
  }
  // 数字 1~9 切换标注工具，0 = 移动（selected 态；与工具条 tooltip 编号一致）
  if (mode.value === 'selected' && /^[0-9]$/.test(e.key)) {
    e.preventDefault();
    const tools: Tool[] = ['rect', 'ellipse', 'arrow', 'line', 'pen', 'highlighter', 'text', 'mosaic', 'step', 'move'];
    toggleTool(tools[e.key === '0' ? 9 : Number(e.key) - 1]!);
    return;
  }
  // G：切换参考辅助线（三分线 + 中心线）
  if (mode.value === 'selected' && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    showGuides.value = !showGuides.value;
    return;
  }
  // 方向键微移选区（1px，Shift=10px）
  if (mode.value === 'selected' && selection.value && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    selection.value = moveRect(selection.value, dx, dy, viewW.value, viewH.value);
  }
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault();
  void emit('snip:cancel');
}

// ===== 标注渲染（annoCanvas：物理分辨率，ctx 按逻辑坐标绘制） =====
const annoCanvas = ref<HTMLCanvasElement | null>(null);
let bgSourceCanvas: HTMLCanvasElement | null = null;
/** 全分辨率原图（full-ref 读盘解码）：放大镜采样与标注烘焙优先使用，4K 无损 */
let fullSourceImg: HTMLImageElement | null = null;
const fullSourceCanvas = ref<HTMLCanvasElement | null>(null);
/** 烘焙期间的马赛克采样源（临时指向全分辨率原图；null = 预览图） */
let bakeSourceImg: HTMLImageElement | null = null;

/** 读入全分辨率原图（后台，不阻塞交互）：解码成功才替换引用，失败保留预览源 */
async function loadFullSource(fileRef: string): Promise<void> {
  const data = await resolveImageContent(fileRef).catch(() => '');
  if (!data || !data.startsWith('data:')) return;
  const img = new Image();
  img.onload = () => {
    if (!img.naturalWidth) return;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')?.drawImage(img, 0, 0);
    fullSourceImg = img;
    fullSourceCanvas.value = c;
  };
  img.src = data;
}

function annoCtx(): CanvasRenderingContext2D | null {
  const c = annoCanvas.value;
  if (!c) return null;
  if (c.width !== Math.round(viewW.value * scale.value) || c.height !== Math.round(viewH.value * scale.value)) {
    c.width = Math.round(viewW.value * scale.value);
    c.height = Math.round(viewH.value * scale.value);
  }
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(scale.value, 0, 0, scale.value, 0, 0);
  ctx.clearRect(0, 0, viewW.value, viewH.value);
  return ctx;
}

function strokeAnno(ctx: CanvasRenderingContext2D, a: Annotation): void {
  ctx.save();
  // 标注恒裁剪进选区
  const sel = selection.value;
  if (sel) { ctx.beginPath(); ctx.rect(sel.x, sel.y, sel.w, sel.h); ctx.clip(); }
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);
  switch (a.tool) {
    case 'rect': {
      // 圆角（0~40，渲染钳到 min(w,h)/2）；roundRect 不可用时退化为直角
      const r = Math.min(a.radius ?? 0, w / 2, h / 2);
      ctx.beginPath();
      if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
      ctx.stroke();
      break;
    }
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      break;
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      // V 形箭头头（长 = 3×线宽）
      const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = Math.max(a.size * 3, 8);
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - head * Math.cos(ang - Math.PI / 7), a.y2 - head * Math.sin(ang - Math.PI / 7));
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - head * Math.cos(ang + Math.PI / 7), a.y2 - head * Math.sin(ang + Math.PI / 7));
      ctx.stroke();
      break;
    }
    case 'pen':
      if (a.points && a.points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(a.points[0]!.x, a.points[0]!.y);
        for (const p of a.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      break;
    case 'highlighter':
      // 荧光笔：半透明粗笔触（覆盖底图而不遮挡），方头线帽更像记号笔
      if (a.points && a.points.length > 1) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = Math.max(8, a.size * 3);
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(a.points[0]!.x, a.points[0]!.y);
        for (const p of a.points.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
      }
      break;
    case 'step': {
      // 序号：实心圆 + 反白数字（近白圆底用深色数字保证可读）
      const r = stepRadius(a.size);
      ctx.beginPath();
      ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();
      ctx.fillStyle = isNearWhite(a.color) ? '#111111' : '#ffffff';
      ctx.font = `bold ${Math.max(10, Math.round(r * 1.15))}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(a.label ?? 1), a.x1, a.y1 + r * 0.04);
      break;
    }
    case 'text': {
      const fontSize = a.size * 4;
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const lines = (a.text ?? '').split('\n');
      if (a.bg) {
        // 白底衬块（可选，默认关）：白底上近白文字自动加深保证可读
        let w = 0;
        for (const line of lines) w = Math.max(w, ctx.measureText(line).width);
        const padX = fontSize * 0.25;
        const padY = fontSize * 0.15;
        const bw = w + padX * 2;
        const bh = lines.length * fontSize * 1.3 + padY * 2;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(a.x1 - padX, a.y1 - padY, bw, bh, fontSize * 0.18);
        else ctx.rect(a.x1 - padX, a.y1 - padY, bw, bh);
        ctx.fill();
        ctx.fillStyle = isNearWhite(a.color) ? '#111111' : a.color;
      } else {
        ctx.fillStyle = a.color;
      }
      lines.forEach((line, i) => {
        ctx.fillText(line, a.x1, a.y1 + i * fontSize * 1.3);
      });
      break;
    }
    case 'mosaic': {
      // ===== 马赛克（全新实现）：框内全局像素化 =====
      // 设计原则：零中间画布、零缓存、零 DPI 换算——采样直接取冻结画面 <img> 的
      // 原始像素，坐标唯一一次换算是「页面逻辑坐标 → img 原始像素」的比例映射
      // （img 以 inset-0 铺满视口，clientWidth/Height 即真实渲染尺寸）。
      // 每次渲染即时重采样（两次 drawImage，开销可忽略）：无缓存即无陈旧内容，
      // 移动工具挪动后对新位置下的冻结画面打码（Snipaste/PixPin 同款语义）。
      // 导出烘焙复用本分支（同一 ctx 变换链），所见即所得。
      const img = bakeSourceImg ?? bgImgRef.value;
      if (img && img.naturalWidth > 0 && w >= 2 && h >= 2) {
        const dw = img.clientWidth || viewW.value;
        const dh = img.clientHeight || viewH.value;
        const cols = Math.max(1, Math.round(w / (a.block ?? 12)));
        const rows = Math.max(1, Math.round(h / (a.block ?? 12)));
        mosaicScratch ??= document.createElement('canvas');
        if (mosaicScratch.width !== cols || mosaicScratch.height !== rows) {
          mosaicScratch.width = cols;
          mosaicScratch.height = rows; // 设尺寸即清空，复用零分配
        }
        const sctx = mosaicScratch.getContext('2d');
        if (sctx) {
          sctx.imageSmoothingEnabled = true;
          sctx.drawImage(
            img,
            (x / dw) * img.naturalWidth, (y / dh) * img.naturalHeight,
            (w / dw) * img.naturalWidth, (h / dh) * img.naturalHeight,
            0, 0, cols, rows,
          );
          // 放大回选区：马赛克关闭平滑（硬边像素块）；模糊开启平滑 + 高质量
          // 双线性过滤（柔和磨砂观感）——注意方向：blur 才开平滑
          ctx.imageSmoothingEnabled = a.style === 'blur';
          if (a.style === 'blur') ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(mosaicScratch, 0, 0, cols, rows, x, y, w, h);
          ctx.imageSmoothingEnabled = true;
        }
      }
      // 拖拽中：红色边框标示正在框选的范围（仅编辑态；导出烘焙不含活动标注）
      if (a === activeAnno.value) {
        ctx.save();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = Math.max(2, Math.round(uiScale.value * 1.5));
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }
      break;
    }
  }
  ctx.restore();
}

/** 马赛克降采样离屏画布（模块级复用，设尺寸即清空） */
let mosaicScratch: HTMLCanvasElement | null = null;

/** 马赛克区域（规范化对角矩形；未成形返回 null。移动工具命中判定用） */
function mosaicRegion(a: Annotation): Rect | null {
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);
  if (w <= 0 || h <= 0) return null;
  return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w, h };
}

/** 全量重绘标注层（对象变更 / 撤销重做 / 拖拽中调用）。
 *  无有效选区时不渲染（标注恒裁剪进选区，空选区渲染等于悬浮全屏） */
function redrawAnnos(): void {
  const ctx = annoCtx();
  if (!ctx) return;
  const sel = selection.value;
  if (!sel || !isValidSelection(sel)) return;
  for (const a of annotations.value) strokeAnno(ctx, a);
  if (activeAnno.value) strokeAnno(ctx, activeAnno.value);
  // 移动工具下选中的标注：虚线框标示可缩放/删除/复制
  if (annoTool.value === 'move') strokeAnnoSelection(ctx);
}

/** 选中标注的虚线包围框（手柄由 DOM 渲染） */
function strokeAnnoSelection(ctx: CanvasRenderingContext2D): void {
  const a = selectedAnno();
  if (!a) return;
  const b = annoBounds(a);
  if (!b) return;
  ctx.save();
  ctx.strokeStyle = '#f0b429';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  const pad = 2;
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

/** 选中标注的 8 向手柄渲染点 */
const annoHandlePoints = computed<Array<{ handle: Handle; x: number; y: number }>>(() => {
  if (mode.value !== 'selected' || annoTool.value !== 'move') return [];
  const a = selectedAnno();
  if (!a) return [];
  const b = annoBounds(a);
  if (!b) return [];
  const { x, y, w, h } = b;
  return [
    { handle: 'nw', x, y }, { handle: 'n', x: x + w / 2, y }, { handle: 'ne', x: x + w, y },
    { handle: 'e', x: x + w, y: y + h / 2 }, { handle: 'se', x: x + w, y: y + h },
    { handle: 's', x: x + w / 2, y: y + h }, { handle: 'sw', x, y: y + h },
    { handle: 'w', x, y: y + h / 2 },
  ];
});

// 选区变化（拖拽建区/手柄缩放/移动/清空）同步重绘：裁剪矩形在绘制时烘焙，
// 不重绘会残留旧边界的裁剪结果（手柄放大后标注仍被旧范围截断）
watch(selection, () => {
  if (toolbarManual.value) toolbarManual.value = null; // 选区变化：工具条恢复自动定位
  redrawAnnos();
});

/** 画布测量上下文（模块级复用）：文字标注宽高与渲染共用同一字体口径 */
let measureCtx: CanvasRenderingContext2D | null = null;
const measureTextReal: MeasureText = (text, fontSize) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return defaultMeasureText(text, fontSize);
  measureCtx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  let w = 0;
  for (const line of text.split('\n')) w = Math.max(w, measureCtx.measureText(line).width);
  return { w, h: Math.max(1, text.split('\n').length) * fontSize * 1.3 };
};

/** 当前选中标注（move 工具下可缩放/删除/复制） */
function selectedAnno(): Annotation | null {
  return annotations.value.find((a) => a.id === annoSelectedId.value) ?? null;
}

/** 标注的紧致包围盒（缩放手柄定位与选区钳制用；逻辑坐标） */
function annoBounds(a: Annotation): Rect | null {
  if (a.tool === 'text') return textAnnoBounds(a);
  return annoBoundsOf(a, measureTextReal);
}

/** 标注的命中包围盒（点选拾取用：外扩线宽/笔刷半径） */
function annoHitBounds(a: Annotation): Rect | null {
  if (a.tool === 'text') return textAnnoBounds(a);
  return hitBoundsOf(a, measureTextReal);
}

/** 最上层包含指定点的标注（移动工具拾取；从数组尾部向前） */
function topmostAnnoAt(px: number, py: number): Annotation | null {
  for (let i = annotations.value.length - 1; i >= 0; i--) {
    const a = annotations.value[i]!;
    const b = annoHitBounds(a);
    if (b && inRect(b, px, py)) return a;
  }
  return null;
}

/** 原位平移标注（选区钳制：越界方向归零，标注大于选区时居中） */
function translateAnnoClamped(a: Annotation, dx: number, dy: number, sel: Rect): void {
  const b = annoBounds(a);
  if (!b) return;
  const clampAxis = (d: number, lo: number, hi: number): number =>
    lo > hi ? (lo + hi) / 2 : Math.min(Math.max(d, lo), hi);
  const ndx = clampAxis(dx, sel.x - b.x, sel.x + sel.w - b.x - b.w);
  const ndy = clampAxis(dy, sel.y - b.y, sel.y + sel.h - b.y - b.h);
  a.x1 += ndx; a.x2 += ndx; a.y1 += ndy; a.y2 += ndy;
  a.points?.forEach((p) => { p.x += ndx; p.y += ndy; });
}

/** 文字标注的渲染命中区（measureText 实测宽 + 行高；双击再编辑用） */
function textAnnoBounds(a: Annotation): Rect | null {
  const text = a.text ?? '';
  if (!text) return null;
  const fontSize = a.size * 4;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  let w = 0;
  for (const line of text.split('\n')) w = Math.max(w, ctx.measureText(line).width);
  const pad = a.bg ? fontSize * 0.25 : 0;
  const h = text.split('\n').length * fontSize * 1.3 + (a.bg ? fontSize * 0.3 : 4);
  return { x: a.x1 - pad - 2, y: a.y1 - 2, w: w + pad * 2 + 4, h: h + 4 };
}

/** 双击：命中已有文字标注 → 原位回到草稿编辑（刚开的空草稿先丢弃） */
function onDblClick(e: MouseEvent): void {
  if (mode.value !== 'selected') return;
  for (let i = annotations.value.length - 1; i >= 0; i--) {
    const a = annotations.value[i]!;
    if (a.tool !== 'text') continue;
    const b = textAnnoBounds(a);
    if (b && inRect(b, e.clientX, e.clientY)) {
      if (textDraft.visible && !textDraft.value.trim()) {
        // 双击瞬间刚开的新空草稿：丢弃其快照再进入编辑
        textDraft.visible = false;
        undoStack.value.pop();
      } else if (textDraft.visible) {
        void commitTextDraft();
      }
      editTextAnno(a);
      return;
    }
  }
}

// ===== 确认（有标注先烘焙合成图） =====
function confirmSelection(action: 'copy' | 'save' | 'pin'): void {
  const rect = selection.value;
  if (!rect || !isValidSelection(rect)) return;
  const payload = {
    x: Math.round(rect.x * scale.value),
    y: Math.round(rect.y * scale.value),
    w: Math.round(rect.w * scale.value),
    h: Math.round(rect.h * scale.value),
    action,
  };
  if (annotations.value.length === 0) {
    void emit('snip:confirm', payload);
    return;
  }
  // 烘焙：输出画布为全分辨率物理尺寸（payload.w×h）。底图源优先全分辨率原图
  // （full-ref 已解码时 kx=ky=1，4K 产物逐像素无损）；未到达时回退预览图并按
  // natural/全分辨率 比例映射源坐标（否则会从预览图右下象限采样，区域错位）。
  // 标注逻辑坐标 × scale 不变。
  const source = sourceForBake();
  if (!source) { void emit('snip:confirm', payload); return; }
  const out = document.createElement('canvas');
  out.width = payload.w;
  out.height = payload.h;
  const ctx = out.getContext('2d');
  if (!ctx) { void emit('snip:confirm', payload); return; }
  const kx = source.w / (viewW.value * scale.value);
  const ky = source.h / (viewH.value * scale.value);
  ctx.drawImage(
    source.src,
    payload.x * kx, payload.y * ky, payload.w * kx, payload.h * ky,
    0, 0, payload.w, payload.h,
  );
  ctx.setTransform(scale.value, 0, 0, scale.value, -rect.x * scale.value, -rect.y * scale.value);
  bakeSourceImg = fullSourceImg; // 马赛克采样同步切到全分辨率源
  try {
    for (const a of annotations.value) strokeAnno(ctx, a);
  } finally {
    bakeSourceImg = null;
  }
  const dataUrl = out.toDataURL('image/png');
  void invoke<string | null>('save_clipboard_image', { dataUrl }).then((refStr) => {
    if (!refStr) { void emit('snip:confirm', payload); return; }
    void emit('snip:confirm', { ...payload, annotatedRef: refStr });
  });
}

// ===== 渲染辅助 =====
/** 遮罩四块：选区外区域。idle 悬停窗口时聚焦高亮窗（窗外变暗，范围一眼可辨）；
 *  无选区无悬停 = 整屏一块 */
const maskRects = computed<Array<Rect>>(() => {
  const W = viewW.value;
  const H = viewH.value;
  // idle 悬停窗口：窗外变暗（配合蓝色虚线框，Snipaste 同款聚焦效果）
  if (mode.value === 'idle' && hoveredWindow.value) {
    const s = hoveredWindow.value;
    return [
      { x: 0, y: 0, w: W, h: Math.max(0, s.y) },
      { x: 0, y: s.y + s.h, w: W, h: Math.max(0, H - (s.y + s.h)) },
      { x: 0, y: s.y, w: Math.max(0, s.x), h: s.h },
      { x: s.x + s.w, y: s.y, w: Math.max(0, W - (s.x + s.w)), h: s.h },
    ];
  }
  const s = selection.value;
  if (!s || !isValidSelection(s)) return [{ x: 0, y: 0, w: W, h: H }];
  return [
    { x: 0, y: 0, w: W, h: Math.max(0, s.y) },
    { x: 0, y: s.y + s.h, w: W, h: Math.max(0, H - (s.y + s.h)) },
    { x: 0, y: s.y, w: Math.max(0, s.x), h: s.h },
    { x: s.x + s.w, y: s.y, w: Math.max(0, W - (s.x + s.w)), h: s.h },
  ];
});

/** 手柄渲染点（8 个，角+边中点） */
const handlePoints = computed<Array<{ handle: Handle; x: number; y: number }>>(() => {
  const s = selection.value;
  if (!s || mode.value !== 'selected') return [];
  const { x, y, w, h } = s;
  return [
    { handle: 'nw', x, y }, { handle: 'n', x: x + w / 2, y }, { handle: 'ne', x: x + w, y },
    { handle: 'e', x: x + w, y: y + h / 2 }, { handle: 'se', x: x + w, y: y + h },
    { handle: 's', x: x + w / 2, y: y + h }, { handle: 'sw', x, y: y + h },
    { handle: 'w', x, y: y + h / 2 },
  ];
});

const showMagnifier = computed(() => mode.value === 'idle' && magnifier.visible);
/** 根节点光标：框选/悬停十字线，移动工具为移动光标，其余默认 */
const rootCursorClass = computed(() => {
  if (mode.value === 'idle' || mode.value === 'drawing') return 'cursor-crosshair';
  if (mode.value === 'selected' && annoTool.value === 'move') return 'cursor-move';
  return 'cursor-default';
});

// ===== 选区外快捷键提示卡（选中态光标移到遮罩区域时跟随显示） =====
const cursorOutsideSel = computed(() => {
  if (mode.value !== 'selected' || textDraft.visible || colorOpen.value || savePanelOpen.value) return false;
  const s = selection.value;
  return !!s && isValidSelection(s) && !inRect(s, cursor.x, cursor.y);
});
const hintLines = computed(() => [
  { k: 'Enter', label: t('snip.btn_copy') },
  // Shift 约束仅对矩形/椭圆有意义，其他工具不显示该行（审查发现的噪音）
  ...(annoTool.value === 'rect' || annoTool.value === 'ellipse'
    ? [{ k: 'Shift', label: t('snip.hint_square') }]
    : []),
  { k: '1~9', label: t('snip.hint_tools') },
  { k: 'Ctrl+Z', label: t('snip.tip_undo') },
  { k: 'G', label: t('snip.toggle_guides') },
  { k: 'Esc', label: t('snip.btn_cancel') },
]);
const sizeLabel = computed(() => {
  const s = selection.value;
  if (!s) return '';
  return `${Math.round(s.w * scale.value)} × ${Math.round(s.h * scale.value)}`;
});

const TOOL_ICONS: Array<{ tool: Tool; key: string }> = [
  { tool: 'rect', key: 'tool_rect' },
  { tool: 'ellipse', key: 'tool_ellipse' },
  { tool: 'arrow', key: 'tool_arrow' },
  { tool: 'line', key: 'tool_line' },
  { tool: 'pen', key: 'tool_pen' },
  { tool: 'highlighter', key: 'tool_highlighter' },
  { tool: 'text', key: 'tool_text' },
  { tool: 'mosaic', key: 'tool_mosaic' },
  { tool: 'step', key: 'tool_step' },
  { tool: 'move', key: 'tool_move' },
];

function toggleTool(tool: Tool): void {
  annoTool.value = annoTool.value === tool ? null : tool;
  if (annoTool.value === 'text') textDraft.visible = false;
  // 仅移动工具保留对象选中（其它工具下无手柄可操作，选中框会误导）
  if (annoTool.value !== 'move') annoSelectedId.value = 0;
  annoResize.active = false;
  moveState.active = false;
  redrawAnnos();
}

/** 线宽输入钳制（数值编辑：1~20，非法回落 4） */
function clampAnnoSize(): void {
  const n = Number(currentSize.value);
  currentSize.value = Number.isFinite(n)
    ? Math.min(currentSizeMax.value, Math.max(SNIP_SIZE_MIN, Math.round(n)))
    : DEFAULT_ANNO_SIZE;
}

/** 工具条 + 参数调整栏（两块独立浮动面板）定位。规则：
 *  工具条：水平居中于选区；垂直按「选区下方 → 选区上方 → 选区内部底端」三档
 *  （全屏选区上下都无空间时移入选区内——用户实测反馈"全屏看不到工具栏"）。
 *  参数栏：贴工具条正下方；下方放不下翻到工具条上方；再不行钳制屏内。
 *  两栏都保持原始布局尺寸 + transform scale 放大视觉；钳制用渲染后实测尺寸 */
const toolbarEl = ref<HTMLElement | null>(null);
const toolbarBox = reactive({ w: 280, h: 76 });
const paramsEl = ref<HTMLElement | null>(null);
const paramsBox = reactive({ w: 300, h: 44 });

function measureToolbar(): void {
  const el = toolbarEl.value;
  if (!el) return;
  toolbarBox.w = el.offsetWidth || toolbarBox.w;
  toolbarBox.h = el.offsetHeight || toolbarBox.h;
  const p = paramsEl.value;
  if (p) {
    paramsBox.w = p.offsetWidth || paramsBox.w;
    paramsBox.h = p.offsetHeight || paramsBox.h;
  }
}

/** 工具条手动拖放位置（拖把手自由移动；null = 跟随选区自动定位）。
 *  选区变化 / 新会话时重置回自动定位；钳制在屏内（实测尺寸 × 缩放） */
const toolbarManual = ref<{ left: number; top: number } | null>(null);
const toolbarDragging = ref(false);
let toolbarDragStart: { px: number; py: number; left: number; top: number } | null = null;

function startToolbarDrag(e: PointerEvent): void {
  const tp = toolbarPos.value;
  if (!tp) return;
  const k = uiScale.value;
  // 统一换算为 top 坐标（bottom 锚定档转 top），手动态一律以 top 锚定
  const top = tp.top != null ? tp.top : viewH.value - (tp.bottom ?? 0) - toolbarBox.h * k;
  toolbarDragStart = { px: e.clientX, py: e.clientY, left: tp.left, top };
  toolbarManual.value = { left: tp.left, top };
  toolbarDragging.value = true;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', onToolbarDragMove);
  el.addEventListener('pointerup', onToolbarDragEnd);
  el.addEventListener('pointercancel', onToolbarDragEnd);
}
function onToolbarDragMove(e: PointerEvent): void {
  if (!toolbarDragStart) return;
  toolbarManual.value = {
    left: toolbarDragStart.left + (e.clientX - toolbarDragStart.px),
    top: toolbarDragStart.top + (e.clientY - toolbarDragStart.py),
  };
}
function onToolbarDragEnd(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  el.removeEventListener('pointermove', onToolbarDragMove);
  el.removeEventListener('pointerup', onToolbarDragEnd);
  el.removeEventListener('pointercancel', onToolbarDragEnd);
  try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
  toolbarDragStart = null;
  toolbarDragging.value = false;
}

/** 工具条几何档位（数值坐标，供工具条与参数栏共用推导）；手动拖放优先于自动定位 */
const toolbarPos = computed<{
  left: number; top: number | null; bottom: number | null; origin: 'top left' | 'bottom left'; inside: boolean;
} | null>(() => {
  const s = selection.value;
  if (!s) return null;
  const k = uiScale.value;
  const boxW = toolbarBox.w * k;
  const boxH = toolbarBox.h * k;
  // 手动档：用户拖放位置，钳制屏内（top 锚定）
  if (toolbarManual.value) {
    const left = Math.min(Math.max(8, toolbarManual.value.left), Math.max(8, viewW.value - boxW - 8));
    const top = Math.min(Math.max(8, toolbarManual.value.top), Math.max(8, viewH.value - boxH - 8));
    return { left, top, bottom: null, origin: 'top left', inside: false };
  }
  const left = Math.min(Math.max(8, s.x + s.w / 2 - boxW / 2), Math.max(8, viewW.value - boxW - 8));
  if (s.y + s.h + boxH + 8 <= viewH.value) {
    return { left, top: s.y + s.h + 8, bottom: null, origin: 'top left', inside: false };
  }
  if (s.y - boxH - 8 >= 0) {
    return { left, top: null, bottom: viewH.value - s.y + 8, origin: 'bottom left', inside: false };
  }
  // 全屏选区：无外部空间 → 移入选区内部底端（选区本身必在屏内，钳制安全）
  const top = Math.max(s.y + 8, s.y + s.h - boxH - 12);
  return { left, top, bottom: null, origin: 'top left', inside: true };
});

const toolbarStyle = computed(() => {
  const tp = toolbarPos.value;
  if (!tp) return {};
  const k = uiScale.value;
  return {
    left: `${tp.left}px`,
    top: tp.top != null ? `${tp.top}px` : undefined,
    bottom: tp.bottom != null ? `${tp.bottom}px` : undefined,
    transform: `scale(${k})`,
    transformOrigin: tp.origin,
  };
});

/** 参数栏位置：优先贴工具条正下方；溢出屏底翻到工具条上方；再不行钳制屏内 */
const paramsStyle = computed(() => {
  const tp = toolbarPos.value;
  if (!tp) return {};
  const k = uiScale.value;
  const tH = toolbarBox.h * k;
  const tW = toolbarBox.w * k;
  const pH = paramsBox.h * k;
  const pW = paramsBox.w * k;
  const left = Math.min(Math.max(8, tp.left + tW / 2 - pW / 2), Math.max(8, viewW.value - pW - 8));
  // 工具条顶边（bottom 锚定档换算回 top）
  const tTop = tp.top != null ? tp.top : viewH.value - (tp.bottom ?? 0) - tH;
  const below = tTop + tH + 4;
  let top: number;
  if (below + pH <= viewH.value - 8) {
    top = below;
  } else {
    const above = tTop - pH - 4;
    top = above >= 8 ? above : Math.max(8, Math.min(below, viewH.value - pH - 8));
  }
  return { left: `${left}px`, top: `${top}px`, transform: `scale(${k})`, transformOrigin: 'top left' };
});

/** 取色面板向上弹：参数栏下方空间放不下面板（随缩放封顶 1.25 计算高度）时翻转 */
const pickerUp = computed(() => {
  const tp = toolbarPos.value;
  if (!tp) return false;
  const k = uiScale.value;
  const tH = toolbarBox.h * k;
  const tTop = tp.top != null ? tp.top : viewH.value - (tp.bottom ?? 0) - tH;
  const pBottom = tTop + tH + 4 + paramsBox.h * k;
  return pBottom + 400 * Math.min(k, 1.25) > viewH.value;
});

// ===== 保存面板：保存前选目录 / 格式 / 质量（全部持久化，记住上次选择） =====
const savePanelOpen = ref(false);
const saveEl = ref<HTMLElement | null>(null);
const saveBox = reactive({ w: 280, h: 170 });
/** 保存参数（模块级单例 ref，写经 setter 落库——跨会话记住上次选择） */
const saveDir = useSnipSaveDir();
const saveFmt = useSnipFormat();
const saveQuality = useSnipJpegQuality();

/** 浏览：目录选择对话框（选中即持久化为默认保存目录） */
async function browseSaveDir(): Promise<void> {
  // 护盾 +1/-1：原生目录选择对话框期间覆盖窗失焦不触发兜底取消（用户实测消失）
  nativeDialogOpen++;
  try {
    const dir = await open({ directory: true, defaultPath: saveDir.value || undefined }).catch(() => null);
    if (dir && typeof dir === 'string') await setSnipSaveDir(dir);
  } finally {
    nativeDialogOpen--;
  }
}

/** 面板确认：保存改由页面内自闭环执行（doSave）——裁剪/写盘/弹岛全部直连
 *  Rust 与灵动岛，不经主窗口事件链（原 snip:confirm 跨窗口链路存在运行时
 *  静默断点：无文件无提示，用户实测；重写后零事件跳板） */
function commitSavePanel(): void {
  void setSnipJpegQuality(saveQuality.value);
  savePanelOpen.value = false;
  void doSave();
}

/** 全分辨率引用（管理器 full-ready 后转发；保存裁剪的源）。未到时轮询等待 */
const fullFileRef = ref<string | null>(null);
/** 系统可用 OCR 语言（空 = 未安装/非 Windows，隐藏 OCR 动作） */
const ocrLangs = ref<string[]>([]);
const ocrCapable = computed(() => ocrLangs.value.length > 0);
const ocrRunning = ref(false);
/** OCR 结果确认框：识别结果先预览（可编辑），用户确认后才写剪贴板 */
const ocrResult = reactive({ visible: false, text: '' });
const ocrTextEl = ref<HTMLTextAreaElement | null>(null);

/** 覆盖窗内提示条：截图会话期间主窗口弹岛（alwaysOnTop）会压住本层 UI，
 *  因此操作反馈在窗内就地显示；同一份内容同时由主窗口静默写入灵动岛历史
 *  （失败原因可在「灵动岛历史」回查） */
const snipToast = reactive({ visible: false, kind: 'info' as 'success' | 'error' | 'info', text: '' });
let snipToastTimer: ReturnType<typeof setTimeout> | null = null;
function snipNotify(payload: { kind: 'success' | 'error' | 'info'; text?: string }): void {
  notifyIsland(payload);
  snipToast.kind = payload.kind;
  snipToast.text = payload.text ?? '';
  snipToast.visible = true;
  if (snipToastTimer) clearTimeout(snipToastTimer);
  snipToastTimer = setTimeout(() => { snipToast.visible = false; }, payload.kind === 'error' ? 8000 : 3000);
}

/** 写文本到系统剪贴板并回读校验（写入调用成功 ≠ 真落地：剪贴板可能正被占用）。
 *  Windows 换行会被规范成 CRLF，比较前统一。失败重试几次，抖动多来自插件监听轮询抢锁。 */
async function writeClipboardTextVerified(text: string): Promise<boolean> {
  const norm = (s: string): string => s.replace(/\r\n/g, '\n');
  for (let i = 0; i < 4; i += 1) {
    const ok = await writeText(text).then(() => true, () => false);
    if (ok) {
      const back = await readText().catch(() => null);
      if (back !== null && norm(back).trimEnd() === norm(text)) return true;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

/** 确认识别结果 → 页面直接写剪贴板并校验 → 通知主窗口收起截图 + 弹岛确认。
 *  写由覆盖窗自闭环完成（与取色复制同链路）：主窗口代写在运行时会静默不落地。 */
async function confirmOcrCopy(): Promise<void> {
  const text = ocrResult.text.trim();
  if (!text) return;
  ocrResult.visible = false;
  const ok = await writeClipboardTextVerified(text);
  if (!ok) {
    // 写失败：保留对话框供重试，就地给出原因
    ocrResult.visible = true;
    await nextTick();
    ocrTextEl.value?.focus();
    snipNotify({ kind: 'error', text: t('snip.clipboard_failed') });
    return;
  }
  await emit('snip:ocr-copied', { text }).catch(() => {});
}

/** OCR：识别选区文字 → 弹出结果确认框（确认后才复制）。
 *  有标注时先烘焙（识别「所见即所得」），否则直接用全分辨率原图区域。 */
async function runOcr(): Promise<void> {
  const { t } = useI18n();
  const rect = selection.value;
  if (!rect || !isValidSelection(rect) || ocrRunning.value) return;
  ocrRunning.value = true;
  try {
    const base = {
      x: Math.round(rect.x * scale.value),
      y: Math.round(rect.y * scale.value),
      w: Math.round(rect.w * scale.value),
      h: Math.round(rect.h * scale.value),
    };
    let srcRef = fullFileRef.value;
    let crop = { x: base.x, y: base.y, w: base.w, h: base.h };
    if (annotations.value.length > 0) {
      const baked = bakeAnnotated(base, rect);
      const refStr = baked
        ? await invoke<string | null>('save_clipboard_image', { dataUrl: baked }).catch(() => null)
        : null;
      if (refStr) {
        srcRef = refStr;
        crop = { x: 0, y: 0, w: base.w, h: base.h };
      }
    }
    if (!srcRef) {
      const deadline = Date.now() + 3000;
      while (!fullFileRef.value && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      srcRef = fullFileRef.value;
    }
    if (!srcRef) {
      snipNotify({ kind: 'error', text: `${t('snip.ocr_failed')}：${t('snip.ocr_no_source')}` });
      return;
    }
    const res = await invoke<{ text: string; language: string }>('snip_ocr_region', {
      fileRef: srcRef,
      x: crop.x, y: crop.y, w: crop.w, h: crop.h,
      lang: useSnipOcrLang().value || null,
    });
    const text = (res?.text ?? '').trim();
    if (!text) {
      snipNotify({ kind: 'info', text: t('snip.ocr_empty') });
      return;
    }
    // 不直接写剪贴板：先展示识别结果供核对/修改，确认后才复制
    ocrResult.text = text;
    ocrResult.visible = true;
    await nextTick();
    ocrTextEl.value?.focus();
    ocrTextEl.value?.select();
  } catch (e) {
    snipNotify({ kind: 'error', text: `${t('snip.ocr_failed')}：${String(e)}` });
  } finally {
    ocrRunning.value = false;
  }
}

// ===== 长截图（P2）：隐藏覆盖 UI 并穿透鼠标 → 定时抓取选区 → 竖向拼接 =====
/** 长截图进行中（根节点据此隐藏全部 UI，仅留 HUD） */
const longMode = ref(false);
/** 已抓取的有效帧数（相同画面按内容寻址引用去重） */
const longFrames = ref(0);
const longSeconds = ref(0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 长截图：用户滚动目标窗口，静止约 2 秒自动结束；拼接结果入剪贴板 + 历史 */
async function runLongCapture(): Promise<void> {
  const { t } = useI18n();
  const rect = selection.value;
  if (!rect || !isValidSelection(rect) || longMode.value) return;
  longAbort = false;
  longMode.value = true;
  longFrames.value = 0;
  longSeconds.value = 0;
  const win = getCurrentWindow();
  const base = {
    x: Math.round(monitorOrigin.x + rect.x * scale.value),
    y: Math.round(monitorOrigin.y + rect.y * scale.value),
    w: Math.max(1, Math.round(rect.w * scale.value)),
    h: Math.max(1, Math.round(rect.h * scale.value)),
  };
  const refs: string[] = [];
  let idle = 0;
  let running = true;
  // 让 Vue 先渲染出「穿透态」（本帧不含冻结画面/遮罩），再开始抓屏
  await nextTick();
  await win.setIgnoreCursorEvents(true).catch(() => {});
  snipNotify({ kind: 'info', text: t('snip.long_hint') });
  await sleep(180);
  const started = Date.now();
  try {
    while (running && !longAbort && Date.now() - started < 20_000) {
      const shot = await invoke<{ fileRef?: string | null } | null>('snip_capture_region', {
        x: base.x, y: base.y, w: base.w, h: base.h, includeCursor: false,
      }).catch(() => null);
      const ref = shot?.fileRef ?? null;
      if (ref) {
        if (refs[refs.length - 1] !== ref) {
          refs.push(ref);
          longFrames.value = refs.length;
          idle = 0;
        } else {
          idle++;
          // 至少拼过一帧 + 连续静止 ≈2.1s → 认为滚动结束
          if (refs.length >= 2 && idle >= 6) running = false;
        }
      }
      longSeconds.value = Math.round((Date.now() - started) / 1000);
      if (running) await sleep(350);
    }
  } finally {
    await win.setIgnoreCursorEvents(false).catch(() => {});
    longMode.value = false;
  }
  // Esc 中止：直接结束会话，不做拼接
  if (longAbort) {
    longAbort = false;
    void emit('snip:cancel');
    return;
  }
  if (refs.length < 2) {
    snipNotify({ kind: 'info', text: t('snip.long_empty') });
    return;
  }
  const stitched = await invoke<{ fileRef?: string | null } | null>('snip_stitch_vertical', {
    fileRefs: refs,
  }).catch(() => null);
  const outRef = stitched?.fileRef ?? null;
  if (!outRef) {
    snipNotify({ kind: 'error', text: t('snip.long_failed') });
    return;
  }
  // 写剪贴板 + 入历史由主窗口执行（覆盖窗无数据库连接），随后关闭本次框选
  void emit('snip:long-done', { fileRef: outRef, frames: refs.length });
  void emit('snip:cancel');
}

// ===== OCR 自动打码（P2）：识别选区文字行 → 批量生成马赛克标注 =====
const autoMaskRunning = ref(false);

async function runAutoMask(): Promise<void> {
  const { t } = useI18n();
  const rect = selection.value;
  if (!rect || !isValidSelection(rect) || autoMaskRunning.value) return;
  autoMaskRunning.value = true;
  try {
    const base = {
      x: Math.round(rect.x * scale.value),
      y: Math.round(rect.y * scale.value),
      w: Math.round(rect.w * scale.value),
      h: Math.round(rect.h * scale.value),
    };
    const deadline = Date.now() + 3000;
    while (!fullFileRef.value && Date.now() < deadline) await sleep(50);
    if (!fullFileRef.value) throw new Error('截图尚未就绪');
    const boxes = await invoke<Array<{ x: number; y: number; w: number; h: number }>>('snip_ocr_boxes', {
      fileRef: fullFileRef.value,
      ...base,
      lang: useSnipOcrLang().value || null,
    });
    if (!boxes.length) {
      snipNotify({ kind: 'info', text: t('snip.ocr_empty') });
      return;
    }
    snapshotForUndo();
    const pad = Math.max(1, Math.round(2 * uiScale.value));
    const made: Annotation[] = boxes.map((b) => {
      // 裁剪图像素 → 覆盖窗页面逻辑坐标
      const lx = rect.x + b.x / scale.value;
      const ly = rect.y + b.y / scale.value;
      const lw = b.w / scale.value;
      const lh = b.h / scale.value;
      return {
        id: ++annoSeq,
        tool: 'mosaic' as const,
        color: annoColor.value,
        size: currentSize.value,
        x1: lx - pad,
        y1: ly - pad,
        x2: lx + lw + pad,
        y2: ly + lh + pad,
        block: mosaicBlock.value,
        style: mosaicStyle.value,
      };
    });
    annotations.value = renumberSteps([...annotations.value, ...made]);
    redrawAnnos();
    snipNotify({ kind: 'success', text: t('snip.auto_mask_done', { n: made.length }) });
  } catch (e) {
    snipNotify({ kind: 'error', text: `${t('snip.auto_mask_failed')}：${String(e)}` });
  } finally {
    autoMaskRunning.value = false;
  }
}

// ===== AI 识图（P2）：当前选区（含标注）→ 多模态模型 → 结果复制 =====
const aiRunning = ref(false);
/** 已配置可识图的 AI（OpenAI 兼容 / Anthropic 且填了 Key）才显示按钮 */
const aiReady = ref(false);

async function runAiVision(): Promise<void> {
  const { t } = useI18n();
  const rect = selection.value;
  if (!rect || !isValidSelection(rect) || aiRunning.value) return;
  aiRunning.value = true;
  try {
    const base = {
      x: Math.round(rect.x * scale.value),
      y: Math.round(rect.y * scale.value),
      w: Math.round(rect.w * scale.value),
      h: Math.round(rect.h * scale.value),
    };
    // 所见即所得：标注烘焙进图后交给模型
    const dataUrl = bakeAnnotated(base, rect);
    if (!dataUrl) throw new Error('裁图失败');
    const cfg = await loadAiConfig();
    const text = (await aiVision(cfg, t('snip.ai_vision_prompt'), dataUrl)).trim();
    if (!text) {
      snipNotify({ kind: 'info', text: t('snip.ai_empty') });
      return;
    }
    suppressIslandCopy();
    await writeText(text);
    snipNotify({ kind: 'success', text: t('snip.ai_copied', { n: text.length }) });
  } catch (e) {
    snipNotify({ kind: 'error', text: `${t('snip.ai_failed')}：${String(e)}` });
  } finally {
    aiRunning.value = false;
  }
}

// ===== 上传分享（P1）：当前选区（含标注）→ 配置的上传地址 → 结果复制 =====
const uploadRunning = ref(false);
/** 上传地址（空 = 未配置，隐藏上传按钮） */
const uploadTarget = computed(() => useSnipUploadUrl().value.trim());

/** 当前选区的图片引用（有标注时烘焙，否则全分辨率裁剪；等待 full-ref 最多 3s） */
async function currentCropFileRef(): Promise<string | null> {
  const rect = selection.value;
  if (!rect) return null;
  const base = {
    x: Math.round(rect.x * scale.value),
    y: Math.round(rect.y * scale.value),
    w: Math.round(rect.w * scale.value),
    h: Math.round(rect.h * scale.value),
  };
  if (annotations.value.length > 0) {
    const baked = bakeAnnotated(base, rect);
    const ref = baked
      ? await invoke<string | null>('save_clipboard_image', { dataUrl: baked }).catch(() => null)
      : null;
    if (ref) return ref;
  }
  const deadline = Date.now() + 3000;
  while (!fullFileRef.value && Date.now() < deadline) await sleep(50);
  if (!fullFileRef.value) return null;
  const crop = await invoke<{ fileRef?: string } | null>('snip_crop_region', {
    fileRef: fullFileRef.value, ...base,
  }).catch(() => null);
  return crop?.fileRef ?? null;
}

async function runUpload(): Promise<void> {
  const { t } = useI18n();
  if (uploadRunning.value) return;
  const target = uploadTarget.value;
  if (!target || !selection.value) return;
  uploadRunning.value = true;
  try {
    const ref = await currentCropFileRef();
    if (!ref) throw new Error('裁图失败');
    const result = await invoke<string>('snip_upload_image', { fileRef: ref, url: target });
    suppressIslandCopy();
    await writeText(result);
    snipNotify({ kind: 'success', text: t('snip.upload_copied') });
  } catch (e) {
    snipNotify({ kind: 'error', text: `${t('snip.upload_failed')}：${String(e)}` });
  } finally {
    uploadRunning.value = false;
  }
}

/** 保存诊断 HUD：覆盖窗右键被拦截（=取消截图）、devtools 打不开，控制台错误
 *  用户看不到（「看不到是什么原因导致的」）——保存流程每一步与错误细节直接
 *  显示在覆盖窗左下角；失败时界面保留，读屏即可定位 */
const saveTrace = ref<string[]>([]);
function trace(msg: string): void {
  saveTrace.value = [...saveTrace.value.slice(-8), `${new Date().toLocaleTimeString()} ${msg}`];
}

/** 页面内保存闭环：裁剪（全分辨率/标注合成）→ 目录/格式/质量 → 写盘 →
 *  灵动岛反馈 → 成功收起；失败保留界面 + HUD 显示原因 */
async function doSave(): Promise<void> {
  const { t } = useI18n();
  saveTrace.value = [];
  trace('保存开始');
  const fail = (why: string) => {
    trace(`失败：${why}`);
    snipNotify({ kind: 'error', text: t('snip.save_failed') });
  };
  try {
    const rect = selection.value;
    if (!rect || !isValidSelection(rect)) { trace('失败：选区无效'); return; }
    savePanelOpen.value = false;

    // 1) 裁剪源：有标注 → 烘焙合成图；无标注 → 全分辨率引用（等转发，超时 3s）
    let srcRef: string | null = null;
    let cropPayload: SnipConfirmShape;
    const base = {
      x: Math.round(rect.x * scale.value),
      y: Math.round(rect.y * scale.value),
      w: Math.round(rect.w * scale.value),
      h: Math.round(rect.h * scale.value),
    };
    if (annotations.value.length > 0) {
      trace(`标注 ${annotations.value.length} 条，烘焙中`);
      const baked = bakeAnnotated(base, rect);
      if (baked) {
        const refStr = await invoke<string | null>('save_clipboard_image', { dataUrl: baked })
          .catch((e: unknown) => { trace(`烘焙落盘异常：${String(e)}`); return null; });
        if (refStr) { srcRef = refStr; cropPayload = { ...base, x: 0, y: 0 }; trace('烘焙完成'); }
      } else {
        trace('烘焙失败（canvas 异常），改用原图');
      }
    }
    if (!srcRef) {
      const deadline = Date.now() + 3000;
      while (!fullFileRef.value && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!fullFileRef.value) { fail('全分辨率引用未到达（full-ready 转发缺失）'); return; }
      srcRef = fullFileRef.value;
      cropPayload = base;
      trace(`裁剪源：${srcRef.slice(0, 24)}`);
    }

    // 2) 裁剪
    const crop = await invoke<{ fileRef: string } | null>('snip_crop_region', {
      fileRef: srcRef,
      x: cropPayload!.x, y: cropPayload!.y, w: cropPayload!.w, h: cropPayload!.h,
    }).catch((e: unknown) => { trace(`裁剪命令异常：${String(e)}`); return null; });
    if (!crop?.fileRef) { fail('裁剪返回空'); return; }
    trace('裁剪完成');

    // 3) 参数与目录（面板刚写入的内存值即最新；缺省回退系统图片文件夹）
    const fmt = saveFmt.value === 'jpeg' ? 'jpeg' : 'png';
    const quality = Math.min(100, Math.max(60, Math.round(saveQuality.value || 90)));
    const name = `s1d3_board_${saveStamp()}.${fmt}`;
    const pictures = await pictureDir().catch(() => '');
    const dir = saveDir.value.trim() || pictures;
    if (!dir) { fail('无可用目录（配置为空且图片文件夹不可用）'); return; }
    trace(`目录：${dir}`);

    // 4) 写盘（配置目录失败回退图片文件夹重试一次），错误原文入 HUD
    const write = async (d: string): Promise<string | null> => {
      const p = await join(d, name).catch(() => null);
      if (!p) { trace(`join 失败：${d}`); return null; }
      const ok = await invoke('snip_export_file', { fileRef: crop.fileRef, destPath: p, format: fmt, quality })
        .then(() => true, (e: unknown) => { trace(`写盘错误：${String(e)}`); return false; });
      return ok ? p : null;
    };
    let finalPath = await write(dir);
    if (!finalPath && pictures && pictures !== dir) {
      trace('配置目录失败，回退图片文件夹');
      finalPath = await write(pictures);
    }
    if (!finalPath) { fail('写盘失败（见上方错误原文）'); return; }
    trace(`已保存：${finalPath}`);
    snipNotify({ kind: 'success', text: t('snip.saved', { path: finalPath }) });
    // 记住本次选区（多入口「上次区域」快捷键复用）
    void setSnipLastRegion({ x: base.x, y: base.y, w: base.w, h: base.h });

    // 5) 成功收起（延迟 600ms 让 HUD 最后一帧可见）
    setTimeout(() => { void emit('snip:cancel'); }, 600);
  } catch (e) {
    trace(`异常：${String(e)}`);
    console.error('[snip] save failed:', e);
    fail(String(e));
  }
}

/** 保存载荷形状（doSave 内部用） */
interface SnipConfirmShape { x: number; y: number; w: number; h: number }

/** 标注烘焙的底图源：优先全分辨率原图（4K 无损），否则预览图/画布 */
function sourceForBake(): { src: CanvasImageSource; w: number; h: number } | null {
  if (fullSourceImg && fullSourceImg.naturalWidth) {
    return { src: fullSourceImg, w: fullSourceImg.naturalWidth, h: fullSourceImg.naturalHeight };
  }
  if (bgSourceCanvas && bgSourceCanvas.width) {
    return { src: bgSourceCanvas, w: bgSourceCanvas.width, h: bgSourceCanvas.height };
  }
  const img = bgImgRef.value;
  if (img?.naturalWidth) return { src: img, w: img.naturalWidth, h: img.naturalHeight };
  return null;
}

/** 标注烘焙：选区 + 标注 → 全分辨率 PNG data URL（全分辨率源逐像素无损） */
function bakeAnnotated(base: SnipConfirmShape, rect: Rect): string | null {
  try {
    const out = document.createElement('canvas');
    out.width = base.w;
    out.height = base.h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const source = sourceForBake();
    if (!source) return null;
    const kx = source.w / (viewW.value * scale.value);
    const ky = source.h / (viewH.value * scale.value);
    ctx.drawImage(source.src, base.x * kx, base.y * ky, base.w * kx, base.h * ky, 0, 0, base.w, base.h);
    ctx.setTransform(scale.value, 0, 0, scale.value, -rect.x * scale.value, -rect.y * scale.value);
    bakeSourceImg = fullSourceImg;
    try {
      for (const a of annotations.value) strokeAnno(ctx, a);
    } finally {
      bakeSourceImg = null;
    }
    return out.toDataURL('image/png');
  } catch { return null; }
}

/** 保存文件名时间戳：s1d3_board_20261025_153000 */
function saveStamp(): string {
  const d = new Date();
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const saveStyle = computed(() => {
  const tp = toolbarPos.value;
  if (!tp) return {};
  const k = uiScale.value;
  const tH = toolbarBox.h * k;
  const tTop = tp.top != null ? tp.top : viewH.value - (tp.bottom ?? 0) - tH;
  // 叠在参数栏下（参数栏可见时），否则贴工具条
  const paramsOn = !!annoTool.value && annoTool.value !== 'move';
  const stackTop = tTop + tH + (paramsOn ? paramsBox.h * k + 4 : 0) + 4;
  const sH = saveBox.h * k;
  const sW = saveBox.w * k;
  const left = Math.min(Math.max(8, tp.left), Math.max(8, viewW.value - sW - 8));
  let top: number;
  if (stackTop + sH <= viewH.value - 8) {
    top = stackTop;
  } else {
    const above = tTop - sH - 4;
    top = above >= 8 ? above : Math.max(8, Math.min(stackTop, viewH.value - sH - 8));
  }
  return { left: `${left}px`, top: `${top}px`, transform: `scale(${k})`, transformOrigin: 'top left' };
});

watch(savePanelOpen, (v) => {
  if (!v) return;
  void nextTick(() => {
    const el = saveEl.value;
    if (el) {
      saveBox.w = el.offsetWidth || saveBox.w;
      saveBox.h = el.offsetHeight || saveBox.h;
    }
  });
}, { flush: 'post' });

// 模式/工具变化后重测两栏（渲染完成再量，避免首帧 0 宽）
watch([mode, annoTool], () => {
  if (mode.value !== 'selected') return;
  void nextTick(measureToolbar);
}, { flush: 'post' });
</script>

<template>
  <div
      class="fixed inset-0 select-none overflow-hidden"
      :class="[rootCursorClass, longMode ? 'snip-long-mode' : '']"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
  >
    <!-- 长截图 HUD（唯一在穿透态保留的图层；窗口此时鼠标穿透，仅作提示） -->
    <div
        v-if="longMode"
        class="snip-long-hud pointer-events-none absolute bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-xs text-white shadow-lg backdrop-blur"
    >
      <svg class="h-3.5 w-3.5 animate-spin text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
      <span>{{ t('snip.long_hud', { n: longFrames, s: longSeconds }) }}</span>
    </div>
    <!-- 冻结画面（imgfile 引用按需读盘为 data URL） -->
    <img
        v-if="bgDataUrl"
        ref="bgImgRef"
        :src="bgDataUrl"
        class="pointer-events-none absolute inset-0 h-full w-full"
        draggable="false"
        alt=""
        @load="onBgLoad"
    />
    <!-- 加载兜底底色 -->
    <div v-if="!bgDataUrl" class="absolute inset-0 bg-black/60" />

    <!-- 标注层（物理分辨率画布，ctx 内按逻辑坐标绘制；选区存在时置于遮罩上方） -->
    <canvas
        ref="annoCanvas"
        class="pointer-events-none absolute inset-0"
        :style="{ width: `${viewW}px`, height: `${viewH}px` }"
    />

    <!-- 选区外暗化遮罩（4 块；idle 为整屏一块）——置于标注层上方，标注恒裁剪进选区 -->
    <div
        v-for="(r, i) in maskRects"
        :key="i"
        class="pointer-events-none absolute bg-black"
        :style="{ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, opacity: maskOpacity / 100 }"
    />

    <!-- 窗口吸附高亮（idle 态蓝色虚线框；粗细随缩放） -->
    <div
        v-if="mode === 'idle' && hoveredWindow"
        class="pointer-events-none absolute border-2 border-dashed border-blue-400"
        :style="{
          left: `${hoveredWindow.x}px`, top: `${hoveredWindow.y}px`, width: `${hoveredWindow.w}px`, height: `${hoveredWindow.h}px`,
          borderWidth: `${Math.max(2, guideW + 1)}px`,
        }"
    />

    <!-- 选区边框（加粗 + 深色对比描边，亮暗背景均可见）+ 尺寸角标 + 参考辅助线 -->
    <div
        v-if="selection && isValidSelection(selection)"
        class="pointer-events-none absolute border-gold"
        :style="{
          left: `${selection.x}px`, top: `${selection.y}px`, width: `${selection.w}px`, height: `${selection.h}px`,
          borderWidth: `${selBorder}px`, borderStyle: 'solid',
          boxShadow: `0 0 0 1px rgba(0,0,0,.45), 0 0 ${8 * uiScale}px rgba(0,0,0,.35)`,
        }"
    >
      <span
          class="absolute rounded bg-black/75 whitespace-nowrap text-white"
          :style="{ top: `${-(20 * uiScale + 4)}px`, left: 0, fontSize: `${Math.round(11 * uiScale)}px`, padding: `${Math.round(2 * uiScale)}px ${Math.round(6 * uiScale)}px` }"
      >
        {{ sizeLabel }}
      </span>
      <!-- 参考辅助线：三分线（虚线）+ 中心线（实线加粗），G 键或工具条切换 -->
      <template v-if="showGuides && mode === 'selected'">
        <div
            v-for="f in [1, 2]"
            :key="`v${f}`"
            class="absolute top-0 h-full border-l border-dashed border-white/60"
            :style="{ left: `${(selection.w * f) / 3}px`, borderWidth: `${guideW}px` }"
        />
        <div
            v-for="f in [1, 2]"
            :key="`h${f}`"
            class="absolute left-0 w-full border-t border-dashed border-white/60"
            :style="{ top: `${(selection.h * f) / 3}px`, borderWidth: `${guideW}px` }"
        />
        <div class="absolute top-0 h-full bg-white/75" :style="{ left: `${selection.w / 2}px`, width: `${guideW}px` }" />
        <div class="absolute left-0 w-full bg-white/75" :style="{ top: `${selection.h / 2}px`, height: `${guideW}px` }" />
      </template>
    </div>
    <!-- 8 向手柄（selected 态；尺寸随 UI 缩放） -->
    <div
        v-for="pt in handlePoints"
        :key="pt.handle"
        class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-sm border border-gold bg-white"
        :style="{
          left: `${pt.x}px`, top: `${pt.y}px`,
          width: `${handleSize}px`, height: `${handleSize}px`,
          boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
        }"
    />

    <!-- 选中标注的缩放手柄（move 工具 + 有选中项；命中在根节点 pointerdown 判定） -->
    <div
        v-for="pt in annoHandlePoints"
        :key="`anno-${pt.handle}`"
        class="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-gold bg-white"
        :style="{
          left: `${pt.x}px`, top: `${pt.y}px`,
          width: `${handleSize}px`, height: `${handleSize}px`,
          boxShadow: '0 0 0 1px rgba(0,0,0,.4)',
        }"
    />

    <!-- 十字线（idle/drawing；粗细随缩放） -->
    <template v-if="mode === 'idle' || mode === 'drawing'">
      <div class="pointer-events-none absolute left-0 w-full bg-gold/70" :style="{ top: `${cursor.y}px`, height: `${guideW}px` }" />
      <div class="pointer-events-none absolute top-0 h-full bg-gold/70" :style="{ left: `${cursor.x}px`, width: `${guideW}px` }" />
    </template>

    <!-- 放大镜取色（跟随光标右侧；96px 像素块 + 色值条，整体随缩放） -->
    <div
        v-if="showMagnifier"
        class="pointer-events-none absolute z-10 overflow-hidden rounded-lg border border-accent/60 bg-surface shadow-lg"
        :style="{
          left: `${Math.min(cursor.x + 16, viewW - 128 * uiScale)}px`,
          top: `${Math.min(cursor.y + 16, viewH - 148 * uiScale)}px`,
          transform: `scale(${uiScale})`,
          transformOrigin: 'top left',
        }"
    >
      <canvas ref="magCanvas" width="96" height="96" class="block h-24 w-24" style="image-rendering: pixelated;" />
      <div class="flex items-center gap-1.5 px-1.5 py-1">
        <span class="h-3.5 w-3.5 shrink-0 rounded-sm border border-white/50" :style="{ background: magnifier.hex }" />
        <span class="text-[11px] leading-4 text-ink">{{ magnifier.hex }}</span>
        <span class="text-[11px] leading-4 text-ink-soft">{{ magnifier.rgb }}</span>
      </div>
    </div>

    <!-- 选区外快捷键提示卡（选中态光标移入遮罩区域时跟随光标；整体随缩放） -->
    <div
        v-if="cursorOutsideSel"
        class="pointer-events-none absolute z-10 space-y-1 rounded-lg border border-white/25 bg-black/70 px-2.5 py-2 shadow-lg backdrop-blur-sm"
        :style="{
          left: `${Math.min(cursor.x + 18, viewW - 190 * uiScale)}px`,
          top: `${Math.min(cursor.y + 18, viewH - 170 * uiScale)}px`,
          transform: `scale(${uiScale})`,
          transformOrigin: 'top left',
        }"
    >
      <div v-for="h in hintLines" :key="h.k" class="flex items-center gap-2 text-[12px] leading-4">
        <span class="min-w-14 rounded bg-white/15 px-1 text-center text-[11px] text-gold">{{ h.k }}</span>
        <span class="text-white/85">{{ h.label }}</span>
      </div>
    </div>

    <!-- 文字草稿输入（重新设计）：完全透明、无背景卡、无边框——文字以标注颜色 +
         最终字号/行高直接浮在截图上，所见即所得。金色光标 + 轻投影保证任意底色
         可见；wrap=off 不自动折行（最终 canvas 仅按 \n 分行），field-sizing 自动
         宽度贴合内容。Enter 提交，Shift+Enter 换行，Esc 取消（阶梯第一层）。
         pointerdown.stop：输入区点击/拖动不得触发根节点的选区交互 -->
    <textarea
        v-if="textDraft.visible"
        ref="textInputEl"
        v-model="textDraft.value"
        wrap="off"
        class="snip-text-draft absolute z-20 resize-none overflow-hidden border-none bg-transparent p-0 outline-hidden"
        :style="{
          left: `${textDraft.x}px`,
          top: `${textDraft.y}px`,
          color: annoColor,
          fontSize: `${currentSize * 4}px`,
          lineHeight: 1.3,
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          caretColor: '#f0b429',
          textShadow: '0 1px 2px rgba(0,0,0,.55)',
        }"
        @pointerdown.stop
        @keydown.enter.exact.prevent="commitTextDraft"
    />

    <!-- 确认工具条（selected 态：动作行 + 标注工具行；整体随 UI 缩放，定位用实测尺寸钳制）。
         pointerdown.stop：工具条多半悬在选区外——不拦截会冒泡进根节点的
         「选区外重开框选」分支，点任何按钮都会把选区重置掉（用户实测反馈） -->
    <div
        v-if="mode === 'selected'"
        ref="toolbarEl"
        class="absolute z-10 flex w-max flex-col gap-1.5 rounded-xl border border-white/25 bg-black/40 p-1.5 shadow-lg backdrop-blur-sm"
        :style="toolbarStyle"
        @pointerdown.stop
    >
      <div class="flex items-center gap-1 whitespace-nowrap">
        <!-- 拖动把手：按住自由移动工具栏（参数栏跟随）；选区变化后恢复自动定位 -->
        <div
            v-tip="t('snip.tip_drag_bar')"
            class="flex h-7 w-4 shrink-0 touch-none items-center justify-center rounded-lg text-white/40 transition-colors hover:bg-white/10 hover:text-white/70"
            :class="toolbarDragging ? 'cursor-grabbing text-white/80' : 'cursor-grab'"
            @pointerdown.stop="startToolbarDrag"
        >
          <svg class="h-4 w-3" viewBox="0 0 12 16" fill="currentColor"><circle cx="3" cy="2.5" r="1.4" /><circle cx="9" cy="2.5" r="1.4" /><circle cx="3" cy="8" r="1.4" /><circle cx="9" cy="8" r="1.4" /><circle cx="3" cy="13.5" r="1.4" /><circle cx="9" cy="13.5" r="1.4" /></svg>
        </div>
        <button type="button" v-tip="`${t('snip.btn_copy')}（Enter）`" class="flex h-7 w-7 items-center justify-center rounded-lg bg-gold/30 text-gold transition-colors hover:bg-gold/40" @click.stop="confirmSelection('copy')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        </button>
        <button type="button" v-tip="t('snip.btn_save')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15" :class="savePanelOpen ? 'bg-gold/30' : ''" @click.stop="savePanelOpen = !savePanelOpen">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>
        </button>
        <button type="button" v-tip="t('snip.btn_pin')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15" @click.stop="confirmSelection('pin')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
        </button>
        <!-- OCR 取字：系统未安装识别语言时隐藏（能力检测在挂载时完成） -->
        <button
            v-if="ocrCapable"
            type="button"
            v-tip="t('snip.btn_ocr')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-40"
            :disabled="ocrRunning"
            @click.stop="runOcr"
        >
          <svg v-if="!ocrRunning" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M8 12h8" /></svg>
          <svg v-else class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </button>
        <!-- OCR 自动打码：识别文字行并批量盖马赛克（P2，系统 OCR 可用时显示） -->
        <button
            v-if="ocrCapable"
            type="button"
            v-tip="t('snip.btn_auto_mask')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-40"
            :disabled="autoMaskRunning"
            @click.stop="runAutoMask"
        >
          <svg v-if="!autoMaskRunning" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.4 4.5" /><path d="M6.6 6.6A17.6 17.6 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 4.4-.9" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          <svg v-else class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </button>
        <!-- 长截图：隐藏 UI 并穿透鼠标后逐帧抓取选区，静止自动结束（P2） -->
        <button
            type="button"
            v-tip="t('snip.btn_long')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-40"
            :disabled="longMode"
            @click.stop="runLongCapture"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="9" rx="1.5" /><rect x="7" y="13" width="10" height="9" rx="1.5" /><path d="M12 9.5v5" /></svg>
        </button>
        <!-- AI 识图：未配置可用 AI 时隐藏（P2） -->
        <button
            v-if="aiReady"
            type="button"
            v-tip="t('snip.btn_ai')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-40"
            :disabled="aiRunning"
            @click.stop="runAiVision"
        >
          <svg v-if="!aiRunning" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /><circle cx="12" cy="12" r="3.2" /></svg>
          <svg v-else class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </button>
        <!-- 上传分享：设置页填了上传地址才显示（P1） -->
        <button
            v-if="uploadTarget"
            type="button"
            v-tip="t('snip.btn_upload')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15 disabled:opacity-40"
            :disabled="uploadRunning"
            @click.stop="runUpload"
        >
          <svg v-if="!uploadRunning" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
          <svg v-else class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>
        </button>
        <button type="button" v-tip="`${t('snip.btn_cancel')}（Esc）`" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15" @click.stop="emit('snip:cancel')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        <span class="mx-0.5 h-4 w-px bg-white/30" />
        <!-- 参考辅助线切换（G 键同效）：三分线 + 中心线 -->
        <button
            type="button"
            v-tip="t('snip.toggle_guides')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15"
            :class="showGuides ? 'bg-gold/30 text-gold' : 'text-white/70'"
            @click.stop="showGuides = !showGuides"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
        </button>
        <button type="button" v-tip="t('snip.tip_undo')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 hover:bg-white/15 disabled:opacity-30" :disabled="!undoStack.length" @click.stop="undoAnno">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
        </button>
        <button type="button" v-tip="t('snip.tip_redo')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 hover:bg-white/15 disabled:opacity-30" :disabled="!redoStack.length" @click.stop="redoAnno">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
        </button>
      </div>
      <div class="flex items-center gap-1 whitespace-nowrap border-t border-white/25 px-1 pt-1.5">
        <!-- 工具（1~9 快捷切换，0 = 移动；再点一次收起回移动/吸附模式） -->
        <button
            v-for="(ti, tiIdx) in TOOL_ICONS"
            :key="ti.tool"
            type="button"
            v-tip="`${t(`snip.${ti.key}`)}（${ti.tool === 'move' ? 0 : tiIdx + 1}）`"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15"
            :class="annoTool === ti.tool ? 'bg-gold/30 text-gold' : ''"
            @click.stop="toggleTool(ti.tool)"
        >
          <!-- 简笔工具图标 -->
          <svg v-if="ti.tool === 'move'" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l3-3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /></svg>
          <svg v-else-if="ti.tool === 'rect'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
          <svg v-else-if="ti.tool === 'ellipse'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="12" rx="8" ry="6" /></svg>
          <svg v-else-if="ti.tool === 'arrow'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19 19 5M19 5v8M19 5h-8" /></svg>
          <svg v-else-if="ti.tool === 'pen'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
          <svg v-else-if="ti.tool === 'line'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20 20 4" /></svg>
          <svg v-else-if="ti.tool === 'text'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7V5h16v2M12 5v14m-3 0h6" /></svg>
          <svg v-else-if="ti.tool === 'highlighter'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5 20.5 10 11 19.5H4.5V13Z" /><path d="M6 21h14" stroke-width="3" opacity=".55" /></svg>
          <svg v-else-if="ti.tool === 'step'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9" /><path d="M10 9.5 12 8v8" stroke-linecap="round" /></svg>
          <svg v-else class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="5" height="5" /><rect x="10" y="4" width="5" height="5" opacity=".6" /><rect x="16" y="4" width="4" height="5" /><rect x="4" y="10" width="5" height="5" opacity=".6" /><rect x="10" y="10" width="5" height="5" /><rect x="16" y="10" width="4" height="5" opacity=".6" /><rect x="4" y="16" width="5" height="4" /><rect x="10" y="16" width="5" height="4" opacity=".6" /><rect x="16" y="16" width="4" height="4" /></svg>
        </button>
      </div>
    </div>

    <!-- 参数调整栏（独立浮动面板，与工具条分离）：仅工具激活时显示，内容随工具
         contextual——线宽/字号、圆角、马赛克样式+块大小、颜色、文字背景。
         贴工具条正下方，空间不足翻上方；全屏选区时与工具条一同落在选区内 -->
    <div
        v-if="mode === 'selected' && annoTool && annoTool !== 'move'"
        ref="paramsEl"
        class="absolute z-10 flex w-max items-center gap-1 whitespace-nowrap rounded-xl border border-white/25 bg-black/40 p-1.5 shadow-lg backdrop-blur-sm"
        :style="paramsStyle"
        @pointerdown.stop
    >
      <!-- 线宽/字号：数值直接编辑 + 滑条双向联动（上限随工具：方框/椭圆 20，其余 80） -->
      <template v-if="annoTool !== 'mosaic'">
        <input
            type="number"
            :min="SNIP_SIZE_MIN"
            :max="currentSizeMax"
            v-model.number="currentSize"
            v-tip="t('snip.tip_size')"
            class="h-7 w-12 rounded-lg border border-white/25 bg-black/30 px-1 text-center text-xs text-white outline-hidden focus:border-gold"
            @change="clampAnnoSize"
        />
        <input
            type="range"
            :min="SNIP_SIZE_MIN"
            :max="currentSizeMax"
            v-model.number="currentSize"
            v-tip="t('snip.tip_size')"
            class="h-7 w-16 cursor-pointer accent-gold"
        />
      </template>
      <!-- 方框圆角：0~40 逻辑 px，渲染再钳到 min(w,h)/2 -->
      <template v-if="annoTool === 'rect'">
        <span class="mx-0.5 h-4 w-px bg-white/30" />
        <input
            type="range"
            :min="0"
            :max="SNIP_RADIUS_MAX"
            v-model.number="rectRadius"
            v-tip="t('snip.tip_radius')"
            class="h-7 w-16 cursor-pointer accent-gold"
        />
        <span class="w-7 text-center text-xs text-white/80">{{ rectRadius }}</span>
      </template>
      <!-- 遮挡工具（马赛克/模糊）：样式切换 + 强度（块大小双语义） -->
      <template v-if="annoTool === 'mosaic'">
        <button
            type="button"
            v-tip="t('snip.tip_style')"
            class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/15"
            :class="mosaicStyle === 'blur' ? 'bg-gold/30 text-gold' : 'text-white/90'"
            @click.stop="mosaicStyle = mosaicStyle === 'mosaic' ? 'blur' : 'mosaic'"
        >
          <svg v-if="mosaicStyle === 'mosaic'" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="5" height="5" /><rect x="10" y="4" width="5" height="5" opacity=".6" /><rect x="16" y="4" width="4" height="5" /><rect x="4" y="10" width="5" height="5" opacity=".6" /><rect x="10" y="10" width="5" height="5" /><rect x="16" y="10" width="4" height="5" opacity=".6" /><rect x="4" y="16" width="5" height="4" /><rect x="10" y="16" width="5" height="4" opacity=".6" /><rect x="16" y="16" width="4" height="4" /></svg>
          <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.7 12 2.7 12 2.7Z" /></svg>
        </button>
        <input
            type="number"
            :min="4"
            :max="60"
            v-model.number="mosaicBlock"
            v-tip="t('snip.tip_block')"
            class="h-7 w-12 rounded-lg border border-white/25 bg-black/30 px-1 text-center text-xs text-white outline-hidden focus:border-gold"
        />
        <input
            type="range"
            :min="4"
            :max="60"
            v-model.number="mosaicBlock"
            v-tip="t('snip.tip_block')"
            class="h-7 w-16 cursor-pointer accent-gold"
        />
      </template>
      <!-- 颜色：当前色按钮 → 复用 UiColorPicker 浮动面板。马赛克/模糊不消费颜色
           （像素块取自画面本身），整组隐藏（审查发现的误导控件） -->
      <template v-if="annoTool !== 'mosaic'">
        <span class="mx-0.5 h-4 w-px bg-white/30" />
        <div class="relative">
        <button
            type="button"
            v-tip="t('snip.tip_color')"
            class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15"
            :class="colorOpen ? 'bg-gold/30' : ''"
            @click.stop="colorOpen = !colorOpen"
        >
          <span class="h-[18px] w-[18px] rounded-full border border-white/50 shadow-xs" :style="{ background: annoColor }" />
        </button>
        <div
            v-if="colorOpen"
            class="absolute left-0 z-20 w-60 rounded-xl border border-accent/60 bg-surface p-2 shadow-lg"
            :class="pickerUp ? 'bottom-8' : 'top-8'"
            :style="{ transform: `scale(${Math.min(uiScale, 1.25) / uiScale})`, transformOrigin: pickerUp ? 'bottom left' : 'top left' }"
            @pointerdown.stop
        >
          <UiColorPicker v-model="annoColor" :presets="SNIP_PALETTE" />
        </div>
        </div>
      </template>
      <!-- 文字背景衬块：默认关，开启后新提交的文字带白底（白底上近白文字自动加深） -->
      <button
          v-if="annoTool === 'text'"
          type="button"
          v-tip="t('snip.text_bg')"
          class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/15"
          :class="textBg ? 'bg-gold/30 text-gold' : 'text-white/90'"
          @click.stop="textBg = !textBg"
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 8h8M12 8v8" /></svg>
      </button>
    </div>

    <!-- 保存面板：保存前自定义目录（记住上次选择）+ 格式 + JPEG 质量等基础参数，
         全部经 snipSettings 持久化，下次截图原样恢复。叠在参数栏/工具条下方 -->
    <div
        v-if="mode === 'selected' && savePanelOpen"
        ref="saveEl"
        class="absolute z-10 flex w-max flex-col gap-2 rounded-xl border border-white/25 bg-black/40 p-2.5 shadow-lg backdrop-blur-sm"
        :style="saveStyle"
        @pointerdown.stop
    >
      <!-- 保存目录：路径展示 + 浏览选择（选中即持久化，下次直存该目录） -->
      <div class="flex items-center gap-2">
        <span class="w-14 shrink-0 text-xs text-white/70">{{ t('snip.save_dir') }}</span>
        <span class="min-w-0 flex-1 truncate rounded-lg border border-white/25 bg-black/30 px-2 py-1 text-xs text-white/90" :title="saveDir">
          {{ saveDir || t('snip.save_no_dir') }}
        </span>
        <button type="button" class="shrink-0 rounded-lg px-2.5 py-1 text-xs text-white/90 transition-colors hover:bg-white/15" @click.stop="browseSaveDir">
          {{ t('snip.save_browse') }}
        </button>
      </div>
      <!-- 格式：PNG（无损直拷）/ JPEG -->
      <div class="flex items-center gap-2">
        <span class="w-14 shrink-0 text-xs text-white/70">{{ t('snip.save_format') }}</span>
        <div class="flex overflow-hidden rounded-lg border border-white/25">
          <button
              v-for="f in ['png', 'jpeg'] as const"
              :key="f"
              type="button"
              class="px-3 py-1 text-xs transition-colors"
              :class="saveFmt === f ? 'bg-gold/30 text-gold' : 'text-white/90 hover:bg-white/15'"
              @click.stop="setSnipFormat(f)"
          >{{ f.toUpperCase() }}</button>
        </div>
        <!-- JPEG 质量（仅 JPEG 显示；滑条实时预览数值，面板确认时落库） -->
        <template v-if="saveFmt === 'jpeg'">
          <span class="ml-1 shrink-0 text-xs text-white/70">{{ t('snip.save_quality') }}</span>
          <input type="range" :min="60" :max="100" v-model.number="saveQuality" class="h-6 w-20 cursor-pointer accent-gold" />
          <span class="w-7 text-center text-xs text-white/90">{{ saveQuality }}</span>
        </template>
      </div>
      <!-- 动作：保存（落库质量并走原保存管线）/ 取消 -->
      <div class="flex items-center justify-end gap-2 border-t border-white/25 pt-1.5">
        <button type="button" class="rounded-lg px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/15" @click.stop="savePanelOpen = false">
          {{ t('snip.btn_cancel') }}
        </button>
        <button type="button" class="btn-gold rounded-lg px-4 py-1 text-xs" @click.stop="commitSavePanel">
          {{ t('snip.btn_save') }}
        </button>
      </div>
    </div>

    <!-- 保存诊断 HUD：左下角固定，逐步显示保存链路状态与错误原文（覆盖窗
         devtools 打不开，用户「看不到原因」——错误必须上屏）。失败时界面保留 -->
    <div
        v-if="saveTrace.length"
        class="pointer-events-none absolute bottom-3 left-3 z-30 max-w-[90%] space-y-0.5 rounded-lg border border-white/25 bg-black/80 p-2 font-mono text-[11px] leading-4 text-white/90 shadow-lg"
    >
      <div v-for="(line, i) in saveTrace" :key="i" :class="line.includes('失败') || line.includes('错误') || line.includes('异常') ? 'text-red-300' : ''">
        {{ line }}
      </div>
    </div>

    <!-- 窗内提示条：会话期间岛不弹窗（会压住本层），操作结果与失败原因就地显示；
         同样的内容由主窗口静默写入灵动岛历史，可事后回查 -->
    <div
        v-if="snipToast.visible"
        class="pointer-events-none absolute bottom-24 left-1/2 z-30 max-w-[80%] -translate-x-1/2 rounded-lg px-3 py-1.5 text-xs leading-5 shadow-lg"
        :class="snipToast.kind === 'error'
          ? 'bg-red-900/90 text-red-100'
          : snipToast.kind === 'success' ? 'bg-emerald-900/90 text-emerald-100' : 'bg-black/85 text-white/90'"
    >
      {{ snipToast.text }}
    </div>

    <!-- OCR 结果确认框：识别结果先预览（可直接改错字），确认后才写剪贴板 -->
    <div
        v-if="ocrResult.visible"
        class="absolute inset-0 z-40 flex items-center justify-center bg-black/45"
        @pointerdown.stop
        @wheel.stop
    >
      <div class="flex max-h-[72vh] w-[min(620px,86vw)] flex-col gap-2 rounded-xl border border-white/20 bg-[#1e1e22]/95 p-3 shadow-2xl">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-medium text-white/90">{{ t('snip.ocr_title') }}</span>
          <span class="text-[11px] text-white/45">{{ t('snip.ocr_edit_hint') }}</span>
        </div>
        <textarea
            ref="ocrTextEl"
            v-model="ocrResult.text"
            class="h-[min(46vh,320px)] w-full resize-none rounded-lg border border-white/15 bg-black/40 p-2 font-mono text-xs leading-5 text-white/95 outline-none focus:border-gold/60"
            spellcheck="false"
        />
        <div class="flex items-center justify-between gap-2 border-t border-white/10 pt-2">
          <span class="text-[11px] text-white/45">{{ t('snip.ocr_confirm_hint') }}</span>
          <div class="flex items-center gap-2">
            <button type="button" class="rounded-lg px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/15" @click="ocrResult.visible = false">
              {{ t('snip.btn_cancel') }}
            </button>
            <button type="button" class="btn-gold rounded-lg px-4 py-1 text-xs" @click="confirmOcrCopy">
              {{ t('snip.btn_copy') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 线宽数字输入去掉原生上下选择器（用户反馈：输入框右侧不需要选择器） */
input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type='number'] {
  -moz-appearance: textfield;
  appearance: textfield;
}
/* 文字草稿：宽度贴合内容（Chromium 123+；不支持的 WebView 退化为固定宽，
   折行语义仍由 wrap=off 保证）；min-width 保空输入时光标可见 */
.snip-text-draft {
  field-sizing: content;
  min-width: 4px;
}
/* 长截图穿透态：隐藏全部交互层（保持窗口可见以驱动抓屏循环），只留 HUD */
.snip-long-mode > *:not(.snip-long-hud) {
  display: none !important;
}
</style>
