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
import { emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from 'tauri-plugin-clipboard-api';
import { useI18n } from '~/composables/useI18n';
import { useTransparentWindow } from '~/composables/useTransparentWindow';
import { notifyIsland, suppressIslandCopy } from '~/composables/useCopyIsland';
import UiColorPicker from '~/components/ui/UiColorPicker.vue';
import { ensureSnipAnnoLoaded, snipAnno } from '~/src/snip/snipSettings';
import { ensureSnipSettingsLoaded, useSnipMaskOpacity } from '~/src/snip/snipSettings';
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
let probeTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 标注系统（P1-T1）：对象数组 + 快照栈，页面逻辑坐标，烘焙时乘 scale =====
type AnnoTool = 'move' | 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text' | 'mosaic';
interface Annotation {
  id: number;
  tool: AnnoTool;
  color: string;
  size: number;
  /** rect/ellipse/arrow/mosaic：拖拽对角；text：落点 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** pen：采点折线（逻辑坐标） */
  points?: Array<{ x: number; y: number }>;
  /** text：文本内容（\n 分行） */
  text?: string;
  /** text：白底衬块（提交时取当期开关，默认关） */
  bg?: boolean;
  /** mosaic：块大小（逻辑 px 4~60，创建时随标注记录；渲染时即时重采样。
   *  马赛克=像素块尺寸，模糊=强度，同一数值双语义） */
  block?: number;
  /** mosaic：遮挡样式（创建时随标注记录；mosaic=像素块，blur=平滑模糊） */
  style?: 'mosaic' | 'blur';
  /** rect：圆角半径（逻辑 px，创建时随标注记录；渲染再钳到 min(w,h)/2） */
  radius?: number;
}
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
const annoTool = ref<AnnoTool | null>(null);
const annoColor = computed({
  get: () => snipAnno.color,
  set: (v: string) => { snipAnno.color = v; },
});
/** 线宽/笔刷大小按工具独立记忆：每个标注工具保留自己的值（默认 5，范围 1~80）。
 *  方框/椭圆描边过粗视觉不可用，单独钳制到 20；马赛克笔刷上限 100 */
const DEFAULT_ANNO_SIZE = 5;
const TOOL_SIZE_MAX: Partial<Record<AnnoTool, number>> = { rect: 20, ellipse: 20 };
const currentSizeMax = computed(() =>
  (annoTool.value && TOOL_SIZE_MAX[annoTool.value]) ?? SNIP_SIZE_MAX,
);
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
/** 移动工具拖拽状态（目标标注 id + 上一步光标） */
const moveState = reactive({ active: false, id: 0, lastX: 0, lastY: 0 });
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

// ===== 生命周期 =====
onMounted(async () => {
  useTransparentWindow();
  await ensureSnipSettingsLoaded();
  await ensureSnipAnnoLoaded();
  maskOpacity.value = useSnipMaskOpacity().value;

  const win = getCurrentWebviewWindow();
  // 窗口级监听（禁止全局 listen：多窗口串扰，见 bubble.vue ring 模式注释）
  unlisteners.push(await win.listen<{ dataUrl: string; scale: number; originX: number; originY: number; width: number; height: number }>('snip:data', (ev) => {
    void startSession(ev.payload);
  }));
  unlisteners.push(await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    // 覆盖窗失焦 = 被系统/其他应用抢焦点：兜底取消（正常路径是 Esc/右键 snip:cancel）
    if (!focused && mode.value !== 'loading') void emit('snip:cancel');
  }));
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('dblclick', onDblClick);
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
async function startSession(p: { dataUrl: string; scale: number; originX: number; originY: number; width: number; height: number }): Promise<void> {
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
  textDraft.visible = false;
  hoveredWindow.value = null;
  magnifier.visible = false;
  colorOpen.value = false;
  toolbarManual.value = null; // 新会话：工具条恢复自动定位
  viewW.value = p.width;
  viewH.value = p.height;
  monitorPhysicalH.value = Math.round(p.height * p.scale);
  // 冻结画面 = 管理器随事件直达的预览图（≤2K 原图 / 4K 缩小，热路径快编产物）：
  // 无读盘、无二次 IPC，mask 与底图同帧就位。全分辨率原图仅确认裁剪时由 Rust 用
  if (!p.dataUrl.startsWith('data:')) {
    notifyIsland({ kind: 'error', text: t('snip.capture_failed') });
    void emit('snip:cancel');
    return;
  }
  bgDataUrl.value = p.dataUrl;
  mode.value = 'idle';
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
  // 画布区域按下：收起取色面板、提交未落定的文字草稿（工具条自身 pointerdown.stop，不经过此处）
  colorOpen.value = false;
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
    // 移动工具：拾取最上层标注（无命中不动作），快照后进入拖拽平移
    if (annoTool.value === 'move') {
      const target = topmostAnnoAt(e.clientX, e.clientY);
      if (!target) return;
      snapshotForUndo();
      moveState.active = true;
      moveState.id = target.id;
      moveState.lastX = e.clientX;
      moveState.lastY = e.clientY;
      return;
    }
    snapshotForUndo();
    annoDragging = true;
    activeAnno.value = {
      id: ++annoSeq,
      tool: annoTool.value,
      color: annoColor.value,
      size: currentSize.value,
      x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY,
      points: annoTool.value === 'pen' ? [{ x: e.clientX, y: e.clientY }] : undefined,
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
  // 移动工具：目标标注实时平移（选区钳制），光标位置推进
  if (moveState.active) {
    const target = annotations.value.find((a) => a.id === moveState.id);
    if (!target) { moveState.active = false; return; }
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
    if (a.tool === 'pen') a.points!.push({ x: cx, y: cy });
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
  if (annoDragging && activeAnno.value) {
    annoDragging = false;
    const a = activeAnno.value;
    // 过小（单点矩形/两点箭头）丢弃并回退快照
    const tiny = a.tool !== 'pen' && Math.abs(a.x2 - a.x1) < 3 && Math.abs(a.y2 - a.y1) < 3;
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
        notifyIsland({ kind: 'success', text: t('snip.color_copied', { hex: magnifier.hex }) });
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
  const img = bgImgRef.value;
  const canvas = magCanvas.value;
  if (!img || !img.naturalWidth || !canvas) {
    magnifier.visible = false;
    return;
  }
  magnifier.visible = true;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  // 源区域钳制在图内（光标贴边时区域随之收进），保证画布中心恒为光标像素
  const sx = Math.min(Math.max(0, Math.floor(cursor.x * scale.value) - 6), img.naturalWidth - 12);
  const sy = Math.min(Math.max(0, Math.floor(cursor.y * scale.value) - 6), img.naturalHeight - 12);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 96, 96);
  ctx.drawImage(img, sx, sy, 12, 12, 0, 0, 96, 96);
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
      x: Math.round(cx * scale.value),
      y: Math.round(cy * scale.value),
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
  if (e.key === 'Escape') {
    e.preventDefault();
    // Esc 阶梯（逐层退出，不一键全关）：草稿 → 取色面板 → 工具模式 → 选中态 → 关闭截图
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
  if (e.key === 'Enter' && mode.value === 'selected' && !annoTool.value) {
    e.preventDefault();
    confirmSelection('copy');
    return;
  }
  // 数字 1~7 切换标注工具（selected 态；7 = 移动，与工具条 tooltip 编号一致）
  if (mode.value === 'selected' && ['1', '2', '3', '4', '5', '6', '7'].includes(e.key)) {
    e.preventDefault();
    toggleTool((['rect', 'ellipse', 'arrow', 'pen', 'text', 'mosaic', 'move'] as AnnoTool[])[Number(e.key) - 1]!);
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
      const img = bgImgRef.value;
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
}

// 选区变化（拖拽建区/手柄缩放/移动/清空）同步重绘：裁剪矩形在绘制时烘焙，
// 不重绘会残留旧边界的裁剪结果（手柄放大后标注仍被旧范围截断）
watch(selection, () => {
  if (toolbarManual.value) toolbarManual.value = null; // 选区变化：工具条恢复自动定位
  redrawAnnos();
});

/** 近白色判定（文字白底衬块时自动把近白文字加深，避免白字白底不可读） */
function isNearWhite(hex: string): boolean {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 230;
}

/** 标注的包围盒（移动工具命中与选区钳制用；逻辑坐标） */
function annoBounds(a: Annotation): Rect | null {
  if (a.tool === 'text') return textAnnoBounds(a);
  if (a.tool === 'mosaic') return mosaicRegion(a);
  if (a.tool === 'pen') {
    if (!a.points?.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of a.points) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const pad = a.size;
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);
  if (a.tool === 'arrow') {
    const pad = a.size * 2;
    return { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
  }
  if (w <= 0 || h <= 0) return null; // rect/ellipse/mosaic 未成形
  return { x, y, w, h };
}

/** 最上层包含指定点的标注（移动工具拾取；从数组尾部向前） */
function topmostAnnoAt(px: number, py: number): Annotation | null {
  for (let i = annotations.value.length - 1; i >= 0; i--) {
    const a = annotations.value[i]!;
    const b = annoBounds(a);
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
  // 烘焙：输出画布为全分辨率物理尺寸（payload.w×h），底图源是「预览图」——
  // 4K 会话的预览长边 ≤2560，源坐标必须按 预览natural/全分辨率 比例映射，
  // 否则会从预览图的右下象限采样（区域错位）。标注逻辑坐标 × scale 不变。
  // 已知取舍：4K 屏带标注导出的底图为预览放大（轻微软化），无标注路径仍走
  // Rust 全分辨率裁剪，产物无损
  const out = document.createElement('canvas');
  out.width = payload.w;
  out.height = payload.h;
  const ctx = out.getContext('2d');
  if (!ctx) { void emit('snip:confirm', payload); return; }
  const src = bgSourceCanvas ?? bgImgRef.value!;
  const kx = src.width / (viewW.value * scale.value);
  const ky = src.height / (viewH.value * scale.value);
  ctx.drawImage(
    src,
    payload.x * kx, payload.y * ky, payload.w * kx, payload.h * ky,
    0, 0, payload.w, payload.h,
  );
  ctx.setTransform(scale.value, 0, 0, scale.value, -rect.x * scale.value, -rect.y * scale.value);
  for (const a of annotations.value) strokeAnno(ctx, a);
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
  if (mode.value !== 'selected' || textDraft.visible || colorOpen.value) return false;
  const s = selection.value;
  return !!s && isValidSelection(s) && !inRect(s, cursor.x, cursor.y);
});
const hintLines = computed(() => [
  { k: 'Enter', label: t('snip.btn_copy') },
  // Shift 约束仅对矩形/椭圆有意义，其他工具不显示该行（审查发现的噪音）
  ...(annoTool.value === 'rect' || annoTool.value === 'ellipse'
    ? [{ k: 'Shift', label: t('snip.hint_square') }]
    : []),
  { k: '1~7', label: t('snip.hint_tools') },
  { k: 'Ctrl+Z', label: t('snip.tip_undo') },
  { k: 'G', label: t('snip.toggle_guides') },
  { k: 'Esc', label: t('snip.btn_cancel') },
]);
const sizeLabel = computed(() => {
  const s = selection.value;
  if (!s) return '';
  return `${Math.round(s.w * scale.value)} × ${Math.round(s.h * scale.value)}`;
});

const TOOL_ICONS: Array<{ tool: AnnoTool; key: string }> = [
  { tool: 'rect', key: 'tool_rect' },
  { tool: 'ellipse', key: 'tool_ellipse' },
  { tool: 'arrow', key: 'tool_arrow' },
  { tool: 'pen', key: 'tool_pen' },
  { tool: 'text', key: 'tool_text' },
  { tool: 'mosaic', key: 'tool_mosaic' },
  { tool: 'move', key: 'tool_move' },
];

function toggleTool(tool: AnnoTool): void {
  annoTool.value = annoTool.value === tool ? null : tool;
  if (annoTool.value === 'text') textDraft.visible = false;
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

// 模式/工具变化后重测两栏（渲染完成再量，避免首帧 0 宽）
watch([mode, annoTool], () => {
  if (mode.value !== 'selected') return;
  void nextTick(measureToolbar);
}, { flush: 'post' });
</script>

<template>
  <div
      class="fixed inset-0 select-none overflow-hidden"
      :class="rootCursorClass"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
  >
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
        <button type="button" v-tip="t('snip.btn_save')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15" @click.stop="confirmSelection('save')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>
        </button>
        <button type="button" v-tip="t('snip.btn_pin')" class="flex h-7 w-7 items-center justify-center rounded-lg text-white/90 transition-colors hover:bg-white/15" @click.stop="confirmSelection('pin')">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></svg>
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
        <!-- 工具（1~6 快捷切换；再点一次收起回移动/吸附模式） -->
        <button
            v-for="(ti, tiIdx) in TOOL_ICONS"
            :key="ti.tool"
            type="button"
            v-tip="`${t(`snip.${ti.key}`)}（${tiIdx + 1}）`"
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
          <svg v-else-if="ti.tool === 'text'" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7V5h16v2M12 5v14m-3 0h6" /></svg>
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
</style>
