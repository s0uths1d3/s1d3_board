<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, cursorPosition, LogicalSize } from '@tauri-apps/api/window';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '~/utils/env';
import { useI18n } from '~/composables/useI18n';
import { showImagePreview, hideImagePreview, dismissImagePreview } from '~/composables/useImagePreview';
import { useTransparentWindow } from '~/composables/useTransparentWindow';
import type { RingSegment } from '~/src/smart-clip/ringSegments';
import type { IslandKind } from '~/composables/useCopyIsland';
import { FestivalIslandDecor, useIslandFestivalEgg, type IslandEggPayload } from '~/festival-eggs';

/**
 * 智能剪贴板气泡窗口：四种模式（route.query.mode 区分）。
 *
 * - pin（?mode=pin）：单片段常驻钉住卡片，点击复制，不模拟粘贴、不自我隐藏。
 * - island（?mode=island）：灵动岛提示胶囊（复制/粘贴反馈）。创建与定位由
 *   useCopyIsland 管理；窗口显隐、进出场动画与超时自动隐藏由本页控制，
 *   事件流：island:ready 握手 → island:show-ui（主窗口路径，小缩略图载荷）/
 *   island:show（第三方 API 路径兜底，原图）推送 → 显示动画 → SHOW_MS 后收起并隐藏窗口。
 * - ring（?mode=ring）：Ctrl+B 环形盘的单 overlay 窗口（视觉与交互收口在
 *   components/ring/RingOverlay，选中/导航/翻页/键盘全在组件内自治）。本页只做
 *   数据接收（管理器 ready 握手后 emitTo 'ring:data' / 'ring:ai-result' 定向投递）、
 *   意图转发（ring:paste-req / ring:close / ring:habit）、失焦自动关环与钉住子窗创建。
 *
 * 窗口的创建/定位/显示/取焦由 BubbleToggleCommand 管理。
 */

const route = useRoute();
const { t } = useI18n();
const mode = String(route.query.mode ?? 'list');
const isPinMode = mode === 'pin';
const isIsland = mode === 'island';
const isRingOverlay = mode === 'ring' || mode === 'ring-hub'; // ring-hub 为旧路由参数，并入 overlay

// ===== 钉住模式 =====
const pinnedText = ref('');
const pinCopied = ref(false);
let pinCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 环形盘（单 overlay，此处仅数据接收与意图转发） =====
const ringSegments = ref<RingSegment[]>([]);
const ringSource = ref('');
const ringContentHash = ref('');
const ringAiPending = ref(false);

// ===== 灵动岛提示胶囊（island 模式）=====
// 停留时长由 useCopyIsland 按设置随 island:show 下发（durationMs），此处仅作兜底默认值
const ISLAND_SHOW_MS = 1800;
const ISLAND_OUT_MS = 240;
// 窗口宽 440 > 胶囊 344：为开场脉冲环扩散（344×1.12≈385）、节日光晕（blur 外扩约 22px/侧）
// 与彩蛋扫光/金粒的越界演出留余量——窗口过窄这些动画两侧会被物理边界裁掉（Windows 透明区不拦截点击，加宽无副作用）
const ISLAND_W = 440;
// 窗口高 96：胶囊 40 + 底部 48px 余量——节日光晕（远层外扩约 44px）与脉冲环的纵向越界演出
// 需要完整渲染空间，余量不足时光晕在窗口底缘被物理裁切（表现为辉光外侧"直接消失"的硬边）；
// 顶部由定位公式 y+12 与 wrap padding-top 8 提供约 20px 空间
const ISLAND_H = 96;
const ISLAND_TOP_OFFSET = 8;       // 窗口顶部留白（与 .island-wrap padding-top 一致）
const ISLAND_PILL_H = 40;          // 胶囊高度（与 .island-pill CSS 一致）
const ISLAND_PANEL_GAP = 8;        // 胶囊与下拉面板间距
const ISLAND_PANEL_PAD_BOTTOM = 12; // 面板底部留白（窗口扩高余量）
/** 面板盒额外高度：面板自身的上下 padding（10×2）+ 边框（1×2）——扩高按内部文本高计算，
    这 22px 不计入会被窗口底缘裁掉（表现为下边框消失） */
const ISLAND_PANEL_BOX_EXTRA = 22;
const ISLAND_PANEL_MAX_H = 280;    // 下拉面板最大高度：防止占满整屏
const ISLAND_PROXIMITY_PX = 32;    // 鼠标邻近检测阈值（逻辑像素）：进入即暂停自动隐藏
const ISLAND_HOVER_INTENT_MS = 150; // 悬停意图：光标停留在岛区域持续此时长才展开下拉
const islandVisible = ref(false);
const islandKind = ref<IslandKind>('copy');
const islandText = ref('');
const islandImage = ref('');             // 图片内容（data URL）：复制/粘贴/剪切图片事件在胶囊内渲染缩略图（悬停放大预览）
const islandTitle = ref('');             // 自定义标签（灵动岛 API 调用可指定；空则用 kind 默认标签）

// ===== 彩蛋（内容包含 s1d3）：胶囊切换专属动画场景 =====
const islandEaster = ref(false);
const EGG_CHARS = ['s', '1', 'd', '3'] as const;
// 粒子迸发方向（px）：固定六向星形分布——CSS 无法算三角函数，这里算好经 --dx/--dy 注入
const EGG_SPARKS = [
  { dx: 20, dy: -12 }, { dx: 28, dy: 0 }, { dx: 20, dy: 12 },
  { dx: -20, dy: -12 }, { dx: -28, dy: 0 }, { dx: -20, dy: 12 },
] as const;

// 节日限时主题（festival-eggs 注入模块）：通用挂载点消费——节日知识全部收口在模块内，
// 本页只保留根节点 data-festival 绑定与三处 <FestivalIslandDecor> 装饰挂载；
// 弹岛行为（如中秋凌晨台词）经 beforeShow 注入，载荷可被改写
const { festival: islandFestival, tip: festivalTip, beforeShow: islandEggBeforeShow } = useIslandFestivalEgg();

// 岛窗口隐藏/收起时同步关掉图片放大预览（预览是独立窗口，不随岛 DOM 隐藏）
watch(islandVisible, (v) => { if (!v) dismissImagePreview(); });

/** 岛内缩略图悬停：独立 tooltip 窗口放大预览原图（islandImage 即完整 data URL） */
function onIslandImageEnter(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement | null;
  if (el && islandImage.value) {
    void showImagePreview(islandImage.value, el);
  }
}
const islandPillEl = ref<HTMLElement | null>(null);
const islandTextEl = ref<HTMLElement | null>(null);
const islandPanelInnerEl = ref<HTMLElement | null>(null);
const islandDuration = ref(ISLAND_SHOW_MS);
const islandOverflow = ref(false);        // 内容超出胶囊单行（下拉展开的必要条件）
const islandExpanded = ref(false);        // 下拉面板展开中
const islandPanelMaxH = ref(ISLAND_PANEL_MAX_H);
/** kind → 默认标签 i18n 键（copy-image 与 copy 同标签；loading=解析过程提示；title 自定义标签优先） */
const ISLAND_LABEL_KEYS: Record<IslandKind, string> = {
  copy: 'copied', 'copy-image': 'copied', cut: 'cut', paste: 'pasted', info: 'info', success: 'success', error: 'error', loading: 'parsing',
};
const islandLabel = computed(() => islandTitle.value || t(`island.${ISLAND_LABEL_KEYS[islandKind.value]}`));

// ===== 下拉面板逐行渲染（与 tooltip 窗口一致：行号 + 完整内容 + 行数统计） =====
/** 万行级内容全量渲染会创建海量 DOM 节点（面板可滚动但 DOM 不裁剪），与 tooltip 同一上限 */
const ISLAND_MAX_RENDER_LINES = 400;
const islandLines = computed<string[]>(() => {
  const txt = islandText.value || '';
  if (!txt) return [' '];
  return txt.replace(/\r\n/g, '\n').split('\n').map((l) => (l.length ? l : ' ')); // 空行占位保持行号对齐
});
const islandLineCount = computed(() => (islandText.value ? islandLines.value.length : 0));
const islandHiddenLines = computed(() => Math.max(0, islandLines.value.length - ISLAND_MAX_RENDER_LINES));
const islandRenderedLines = computed(() =>
  islandHiddenLines.value > 0 ? islandLines.value.slice(0, ISLAND_MAX_RENDER_LINES) : islandLines.value);
let islandDomHover = false;   // 光标在岛窗口 DOM 上（mouseenter/leave 精确判定）
let islandProxHover = false;  // 光标在邻近阈值内（窗口外轮询判定）
let islandOutTimer: ReturnType<typeof setTimeout> | null = null;
let islandHideTimer: ReturnType<typeof setTimeout> | null = null;
let islandExpandTimer: ReturnType<typeof setTimeout> | null = null;
let islandCollapseTimer: ReturnType<typeof setTimeout> | null = null;
let islandProxTimer: ReturnType<typeof setInterval> | null = null;
/** 岛窗口矩形缓存（逻辑像素，show/展开/收起时刷新；邻近检测每 tick 只查一次光标 IPC） */
let islandScale = 1;
let islandRect = { x: 0, y: 0, w: ISLAND_W, h: ISLAND_H };

// ===== 重复提示辨识（同一时段多条相同提示）：×N 计数徽标 + 新提示金环脉冲 =====
const ISLAND_REPEAT_WINDOW_MS = 5000; // 窗口期：相同内容在此时长内再次弹出视为重复（过后重新计数）
const islandRepeat = ref(1);          // 当前重复轮次（>1 时胶囊显示 ×N 徽标）
const islandPulse = ref(false);       // 新提示到达的一次性高亮脉冲（金环扩散渐隐）
let islandRepeatKey = '';             // 上一条提示的唯一键（kind|text）
let islandRepeatAt = 0;               // 上一条提示到达时刻（ms）
let islandPulseTimer: ReturnType<typeof setTimeout> | null = null;
/** sticky 驻留岛兜底时长：结果岛丢失（进程异常）时防止过程岛永久残留 */
const ISLAND_STICKY_MAX_MS = 20000;

/** 展示灵动岛：窗口 show 后强制回流再切动画类，保证进出场动画可见且首帧即动（隐藏窗口里 transition 会瞬间跑完） */
async function applyIsland(payload: IslandEggPayload): Promise<void> {
  // 节日注入点（festival-eggs 模块）：刷新总开关缓存（跨窗口）→ 即时重算节日（跨天）
  // → 执行该节日登记的弹岛行为（ISLAND_QUIRKS，如中秋凌晨台词），载荷可被整体改写
  payload = await islandEggBeforeShow(payload);
  islandKind.value = payload.kind;
  islandText.value = payload.text ?? '';
  // 图片内容：优先渲染显示级缩略图（几十 KB，复杂图片秒弹），缺省回退 image 原图；
  // 复制图片兼容旧载荷（data URL 在 text）——text 现为二维码链接时不当作图片
  islandImage.value = payload.thumb || payload.image
    || (payload.kind === 'copy-image' && payload.text?.startsWith('data:') ? payload.text : '');
  islandTitle.value = payload.title ?? '';
  islandDuration.value = payload.durationMs ?? ISLAND_SHOW_MS;
  // 彩蛋检测收口在岛显示层：文本复制/剪切/粘贴的内容「就是」s1d3 四个字（trim 后全等，忽略大小写）才命中。
  // 不用 includes 宽匹配——开发中复制的项目路径/代码/URL 常含 s1d3 子串（本项目就叫 s1d3），
  // 宽匹配会把彩蛋变成高频误触发；图片事件（缩略图/二维码链接文本）不触发，仅纯文本场景播放
  islandEaster.value = !islandImage.value && !!payload.text
    && (payload.kind === 'copy' || payload.kind === 'cut' || payload.kind === 'paste')
    && payload.text.trim().toLowerCase() === 's1d3';
  // 彩蛋动画序列较长（键帽落位+波浪跳+扫光+粒子 ≈1.9s）：保底停留时长保证完整演出
  if (islandEaster.value) islandDuration.value = Math.max(islandDuration.value, 2600);
  // 重复提示辨识：同内容（kind+text+图片标记）短时间内再次弹出 → ×N 递增（胶囊显示徽标，用户可区分
  // "又来了一条新提示"与"正在显示的旧条目"）；窗口期过后视为新一轮，重新计数。
  // 每条新提示（无论是否重复）都触发一次金环脉冲，与入场动画叠加出"新鲜感"
  const repeatKey = `${payload.kind}|${payload.text ?? ''}|${payload.image ? 'img' : ''}`;
  const now = Date.now();
  islandRepeat.value = repeatKey === islandRepeatKey && now - islandRepeatAt <= ISLAND_REPEAT_WINDOW_MS
    ? islandRepeat.value + 1
    : 1;
  islandRepeatKey = repeatKey;
  islandRepeatAt = now;
  islandPulse.value = false;
  if (islandPulseTimer) clearTimeout(islandPulseTimer);
  // 复位动画起点与展开态：连续事件到来时从收起态重新展开
  cancelIslandExpand();
  islandExpanded.value = false;
  // 新提示到达即取消上一轮隐藏计划：旧 hide 回调若在新 show 之后执行，
  // 会把刚要显示的窗口藏回去（间歇性"弹了又立刻消失/不显示"的竞态来源）
  if (islandOutTimer) { clearTimeout(islandOutTimer); islandOutTimer = null; }
  if (islandHideTimer) { clearTimeout(islandHideTimer); islandHideTimer = null; }
  const win = getCurrentWindow();
  // 平滑替换：岛可见期间收到新岛（解析中 → 结果切换）不闪断窗口、不重播入场动画，
  // 仅切换内容 + 金环脉冲；替换时重置悬停态，让结果岛从零开始走正常停留计时
  const replacing = islandVisible.value;
  if (replacing) {
    islandDomHover = false;
    islandProxHover = false;
  } else {
    islandVisible.value = false;
    await nextTick();
  }
  // 复位窗口为收起尺寸（替换与首显都需：上次展开面板后可能残留大窗口），再显示
  await win.setSize(new LogicalSize(ISLAND_W, ISLAND_H)).catch(() => {});
  if (!replacing) {
    await win.show().catch(() => {});
    await nextTick();
  }
  // 强制回流让浏览器记录收起态（替代双 rAF，节省约 2 帧延迟）；回流后挂脉冲动画类才可靠重播
  void islandPillEl.value?.offsetHeight;
  islandPulse.value = true;
  // 覆盖最长动画链（涟漪 0.12s 延迟 + 0.75s ≈ 0.87s），避免复位截断余韵波纹
  islandPulseTimer = setTimeout(() => { islandPulse.value = false; }, 900);
  islandVisible.value = true;
  // 溢出检测：胶囊单行截断放不下才允许下拉展开（图片/空内容不展开）
  const el = islandTextEl.value;
  islandOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1; // 1px 容差：略微溢出也可展开
  void refreshIslandRect();
  if (payload.sticky) {
    // 过程岛驻留：不按设置时长收回，持续显示直到结果岛替换；兜底计时防止结果岛丢失后残留
    islandOutTimer = setTimeout(() => { islandVisible.value = false; }, ISLAND_STICKY_MAX_MS);
    islandHideTimer = setTimeout(() => {
      stopIslandProximity();
      islandDomHover = false;
      islandProxHover = false;
      void getCurrentWindow().hide().catch(() => {});
    }, ISLAND_STICKY_MAX_MS + ISLAND_OUT_MS);
  } else if (!replacing && islandDomHover) {
    clearIslandTimers();
    scheduleIslandExpand(); // 新内容落下时正悬停：重新走悬停意图展开
  } else if (!replacing && islandProxHover) {
    clearIslandTimers();
  } else {
    scheduleIslandHide();
  }
  startIslandProximity();
}

/** 启动/重启自动隐藏倒计时（悬停暂停、离开恢复时复用） */
function scheduleIslandHide(): void {
  if (islandOutTimer) clearTimeout(islandOutTimer);
  if (islandHideTimer) clearTimeout(islandHideTimer);
  islandOutTimer = setTimeout(() => { islandVisible.value = false; }, Math.max(0, islandDuration.value - ISLAND_OUT_MS));
  islandHideTimer = setTimeout(() => {
    // 必须隐藏整个窗口：透明区域在 Windows 上仍捕获点击（见项目约定），残留窗口会挡住顶部点击
    stopIslandProximity();
    islandDomHover = false;
    islandProxHover = false;
    void getCurrentWindow().hide().catch(() => {});
  }, islandDuration.value);
}

/** 离开岛区域后恢复隐藏倒计时（岛可见则整段重新计时，已收起则按剩余时长直接隐藏窗口） */
function resumeIslandHide(): void {
  if (islandVisible.value) {
    scheduleIslandHide();
  } else {
    islandHideTimer = setTimeout(() => {
      void getCurrentWindow().hide().catch(() => {});
    }, Math.max(0, islandDuration.value - ISLAND_OUT_MS));
  }
}

// ===== 鼠标邻近检测（窗口外）：轮询全局光标位置，接近岛区域即暂停自动隐藏 =====
function startIslandProximity(): void {
  if (islandProxTimer) { clearInterval(islandProxTimer); islandProxTimer = null; } // 重启轮询但保留悬停状态
  if (!isTauri()) return;
  islandProxTimer = setInterval(() => { void islandProximityTick(); }, 100);
}

function stopIslandProximity(): void {
  if (islandProxTimer) { clearInterval(islandProxTimer); islandProxTimer = null; }
  islandProxHover = false;
}

/** 缓存岛窗口矩形（逻辑像素）：定位由管理器在 show 前完成，此后每 tick 仅一次光标 IPC */
async function refreshIslandRect(): Promise<void> {
  const win = getCurrentWindow();
  const [pos, size, scale] = await Promise.all([
    win.outerPosition().catch(() => null),
    win.outerSize().catch(() => null),
    win.scaleFactor().catch(() => 1),
  ]);
  if (!pos || !scale) return;
  islandScale = scale;
  islandRect = {
    x: pos.x / scale,
    y: pos.y / scale,
    w: (size?.width ?? ISLAND_W * scale) / scale,
    h: (size?.height ?? ISLAND_H * scale) / scale,
  };
}

async function islandProximityTick(): Promise<void> {
  if (!islandVisible.value) return;
  const c = await cursorPosition().catch(() => null);
  if (!c) return;
  // 物理像素 → 逻辑像素：阈值按逻辑像素定义，多屏混用 DPI 时行为一致
  const x = c.x / islandScale;
  const y = c.y / islandScale;
  const dx = Math.max(islandRect.x - x, 0, x - (islandRect.x + islandRect.w));
  const dy = Math.max(islandRect.y - y, 0, y - (islandRect.y + islandRect.h));
  const dist = Math.hypot(dx, dy);
  if (dist <= ISLAND_PROXIMITY_PX) {
    if (!islandProxHover && !islandDomHover) {
      islandProxHover = true; // 邻近视同悬停：暂停自动隐藏，等用户靠近
      clearIslandTimers();
    }
  } else if (islandProxHover && !islandDomHover) {
    islandProxHover = false; // 彻底离开邻近区：收起下拉并恢复倒计时
    if (islandExpanded.value) collapseIsland();
    resumeIslandHide();
  }
}

// ===== 下拉面板展开/收起（窗口随之扩高/收回） =====
/** 悬停意图：进入岛区域持续 ISLAND_HOVER_INTENT_MS 且内容溢出才展开，扫过不误触 */
function scheduleIslandExpand(): void {
  if (islandExpandTimer) clearTimeout(islandExpandTimer);
  islandExpandTimer = setTimeout(() => {
    islandExpandTimer = null;
    void expandIsland();
  }, ISLAND_HOVER_INTENT_MS);
}

function cancelIslandExpand(): void {
  if (islandExpandTimer) { clearTimeout(islandExpandTimer); islandExpandTimer = null; }
}

async function expandIsland(): Promise<void> {
  if (!islandOverflow.value || islandExpanded.value || !islandVisible.value) return;
  if (islandCollapseTimer) { clearTimeout(islandCollapseTimer); islandCollapseTimer = null; } // 收起中途可反转
  const win = getCurrentWindow();
  // 视口边缘：面板高度上限 = 显示器底部 - 岛窗口顶 - 胶囊/间距/留白，且不超过全局上限
  let maxPanel = ISLAND_PANEL_MAX_H;
  try {
    const [mon, pos, scale] = await Promise.all([
      currentMonitor().catch(() => null),
      win.outerPosition().catch(() => null),
      win.scaleFactor().catch(() => 1),
    ]);
    if (mon && pos && scale) {
      const avail = (mon.position.y + mon.size.height - pos.y) / scale
        - ISLAND_TOP_OFFSET - ISLAND_PILL_H - ISLAND_PANEL_GAP - ISLAND_PANEL_PAD_BOTTOM - ISLAND_PANEL_BOX_EXTRA - 8;
      maxPanel = Math.max(96, Math.min(ISLAND_PANEL_MAX_H, Math.floor(avail)));
    }
  } catch { /* 取不到显示器信息则用全局上限 */ }
  islandPanelMaxH.value = maxPanel;
  await nextTick();
  const inner = islandPanelInnerEl.value;
  if (!inner) return;
  const panelH = Math.min(inner.offsetHeight, maxPanel); // 内容自适应：仅略微溢出也只轻微扩高
  if (panelH <= 0) return;
  // 先扩窗再展面板：窗口裁剪 DOM，反序会让内容闪现截断（高度 = 顶留白 + 胶囊 + 间距 + 面板文本 + 面板盒额外 + 底留白）
  const winH = ISLAND_TOP_OFFSET + ISLAND_PILL_H + ISLAND_PANEL_GAP + panelH + ISLAND_PANEL_BOX_EXTRA + ISLAND_PANEL_PAD_BOTTOM;
  await win.setSize(new LogicalSize(ISLAND_W, winH)).catch(() => {});
  void refreshIslandRect();
  islandExpanded.value = true;
}

function collapseIsland(): void {
  if (!islandExpanded.value) return;
  islandExpanded.value = false;
  if (islandCollapseTimer) clearTimeout(islandCollapseTimer);
  // 等面板退场动画播完再收回窗口，避免内容瞬间被窗口裁剪
  islandCollapseTimer = setTimeout(() => {
    islandCollapseTimer = null;
    if (islandExpanded.value) return;
    void getCurrentWindow().setSize(new LogicalSize(ISLAND_W, ISLAND_H)).catch(() => {});
    void refreshIslandRect();
  }, ISLAND_OUT_MS);
}

// ===== 悬停交互（绑定在胶囊+面板的公共容器上，跨间隙移动不丢悬停） =====
function onIslandEnter(): void {
  islandDomHover = true;
  clearIslandTimers();
  scheduleIslandExpand();
}

function onIslandLeave(): void {
  islandDomHover = false;
  cancelIslandExpand();
  if (islandExpanded.value) collapseIsland();
  if (islandProxHover) return; // 仍在邻近阈值内：保持暂停，由 proximity tick 收尾
  resumeIslandHide();
}

function clearIslandTimers(): void {
  if (islandOutTimer) { clearTimeout(islandOutTimer); islandOutTimer = null; }
  if (islandHideTimer) { clearTimeout(islandHideTimer); islandHideTimer = null; }
}

let unlisteners: (() => void)[] = [];

/** 钉住环片段：把选中片段创建为独立常驻小气泡窗（RingOverlay 钉住按钮触发） */
async function pinRingSegment(seg: RingSegment): Promise<void> {
  if (!isTauri() || !seg.text) return;
  void emit('ring:habit', { action: 'pin', extractorId: seg.extractorId, segmentText: seg.text, contentHash: ringContentHash.value });
  const label = `clipboard-bubble-pin-${Date.now()}`;
  (window as any).__childOpeningUntil = Date.now() + 600;
  const unReady = await listen('bubble:pin:ready', (ev) => {
    if ((ev.payload as string | undefined) !== label) return;
    void emitTo(label, 'bubble:pin:data', { text: seg.text });
    unReady();
  });
  setTimeout(() => unReady(), 5000);
  const win = new WebviewWindow(label, {
    url: '/bubble?mode=pin',
    title: 'Pinned',
    width: 300,
    height: 96,
    resizable: false,
    decorations: false,
    transparent: true,   // 透明窗口：页面根元素自绘圆角（rounded-xl）——不透明窗口在 Win11
                         // 被系统强制圆角，圆角外露出窗口底色（白色残角）
    skipTaskbar: true,
    alwaysOnTop: true,
    focus: false,        // 钉住卡片不抢目标应用焦点
    visible: false,
  });
  win.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 300;
  });
  win.once('tauri://error', () => {
    unReady();
  });
}

/**
 * 岛胶囊快捷动作：把当前文本提示分发到待办/便签。
 * 岛窗口不直接落库——emit 全局事件由主窗口监听执行（与 ring:habit 同款跨窗口模式），
 * 转发后立即收起胶囊，落库反馈由主窗口另起新岛提示。
 */
function dispatchIsland(action: 'todo' | 'note'): void {
  if (!isTauri() || !islandText.value) return;
  void emit('island:dispatch', { action, text: islandText.value });
  collapseIsland();
  // 用户已表达意图：取消悬停态并立即恢复隐藏计时（很快收起），主窗口反馈岛随后弹出
  islandDomHover = false;
  resumeIslandHide();
}

/** 钉住卡片：点击 = 复制到剪贴板（带已复制反馈，不模拟粘贴、不自我隐藏） */
async function copyPinned(): Promise<void> {
  if (!pinnedText.value) return;
  try {
    if (isTauri()) await writeTextSafe(pinnedText.value);
    else await navigator.clipboard.writeText(pinnedText.value);
  } catch { /* 忽略写失败 */ }
  pinCopied.value = true;
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  pinCopiedTimer = setTimeout(() => { pinCopied.value = false; }, 1500);
}

async function writeTextSafe(text: string): Promise<void> {
  const mod = await import('tauri-plugin-clipboard-api');
  await mod.writeText(text);
}

function closePin(): void {
  void getCurrentWindow().close();
}

// ===== 环形盘意图转发（选中/导航/翻页/键盘全在 RingOverlay 内自治） =====
function onRingPaste(seg: RingSegment): void {
  void emit('ring:paste-req', { text: seg.text, extractorId: seg.extractorId, contentHash: ringContentHash.value });
}
/** 环盘分段落地分发（转待办/存便签）：复用岛快捷动作事件由主窗口落库，转发后关环 */
function onRingDispatch(p: { action: 'todo' | 'note'; segment: RingSegment }): void {
  if (!isTauri() || !p.segment.text) return;
  void emit('island:dispatch', { action: p.action, text: p.segment.text });
  void emit('ring:close');
}
function onRingClose(): void {
  void emit('ring:close');
}

onMounted(async () => {
  if (!isTauri()) return;
  // 透明窗口通用：去除全局 body 渐变与光晕，避免自绘圆角外露实底「白角」。
  // 此前经 body class（.island-body）逐分支添加，pin 模式曾漏加导致白角
  useTransparentWindow();
  if (isIsland) {
    unlisteners.push(await listen<{ kind: IslandKind; text?: string; image?: string; thumb?: string; title?: string; durationMs?: number; sticky?: boolean }>('island:show-ui', (ev) => {
      void applyIsland(ev.payload);
    }));
    // island:show 兜底：仅第三方 island-api 路径（Rust handle_island_show 直接 emit，无 uiHandled
    // 标记）由此显示——主窗口路径的 island:show 携带数 MB 原图且已由 show-ui 驱动显示，按标记跳过
    unlisteners.push(await listen<{ kind: IslandKind; text?: string; image?: string; thumb?: string; title?: string; durationMs?: number; sticky?: boolean; uiHandled?: boolean }>('island:show', (ev) => {
      if (ev.payload?.uiHandled) return;
      void applyIsland(ev.payload);
    }));
    // ready 握手：通知管理器本窗口已就绪（首次 show 前会等待此信号）
    await emit('island:ready');
    return;
  }
  if (isPinMode) {
    // 窗口级 listen（target 绑定本窗口 label）：管理器 emitTo 定向投递只会命中目标窗口。
    // 全局 listen（target=Any）会收到发往**所有** pin 窗口的投递（tauri v2 对 Any 监听器无条件放行），
    // 多个钉住卡片并存时文本互相覆盖——此前环盘气泡内容全部相同的根因。
    unlisteners.push(await getCurrentWebviewWindow().listen<{ text: string }>('bubble:pin:data', (ev) => {
      pinnedText.value = ev.payload.text;
      void getCurrentWindow().show();
    }));
    // ready 握手：通知创建者本窗口 label（创建者随后 emitTo 定向投递文本）
    await emit('bubble:pin:ready', getCurrentWindow().label);
    return;
  }
  if (isRingOverlay) {
    // 窗口级 listen：emitTo 定向投递只命中本窗口（全局 listen 会被所有同名前缀窗口收到）
    unlisteners.push(await getCurrentWebviewWindow().listen<{ segments: RingSegment[]; source: string; contentHash: string; aiPending: boolean }>('ring:data', (ev) => {
      ringSegments.value = ev.payload.segments ?? [];
      ringSource.value = ev.payload.source ?? '';
      ringContentHash.value = ev.payload.contentHash ?? '';
      ringAiPending.value = !!ev.payload.aiPending;
    }));
    unlisteners.push(await getCurrentWebviewWindow().listen<{ segments: RingSegment[]; status: 'done' | 'failed' }>('ring:ai-result', (ev) => {
      ringAiPending.value = false;
      const added = ev.payload.segments ?? [];
      if (added.length > 0) ringSegments.value = [...ringSegments.value, ...added];
    }));
    // 失焦自动关环：数据到达前不武装（处理期间窗口尚未显示，焦点抖动不误杀）
    unlisteners.push(await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused && ringSegments.value.length > 0) onRingClose();
    }));
    // ready 握手：通知管理器投递环数据（随后显示窗口并取焦）
    await emit('bubble:ring:ready', getCurrentWindow().label);
    return;
  }
});

onBeforeUnmount(() => {
  for (const u of unlisteners) u();
  unlisteners = [];
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  if (isIsland) {
    clearIslandTimers();
    cancelIslandExpand();
    if (islandCollapseTimer) { clearTimeout(islandCollapseTimer); islandCollapseTimer = null; }
    stopIslandProximity();
  }
});
</script>

<template>
  <!-- 灵动岛模式：复制/粘贴反馈胶囊（配色随主窗口主题同步，靠窗口透明悬浮于屏幕顶部）；
       data-festival 节日限时主题：根节点覆盖 --c-* 变量，后代 token 全部继承染色（整体换装零组件改动） -->
  <div v-if="isIsland" class="island-wrap" :data-festival="islandFestival ?? undefined">
    <div class="island-col" @mouseenter="onIslandEnter" @mouseleave="onIslandLeave">
      <div
          ref="islandPillEl"
          class="island-pill group relative bg-surface text-ink border-line shadow-float"
          :class="[islandVisible ? 'island-in' : '', islandPulse ? 'island-pill-new' : '']"
      >
        <!-- 节日装饰挂载点（festival-eggs 注入模块）：边框动效层 + 骑缘徽章，节日知识全部收口在模块内；
             开关关闭/无节日时组件输出空，彩蛋场景（islandEaster）下由 v-if 整体让位 -->
        <FestivalIslandDecor v-if="!islandEaster" kind="border" />
        <FestivalIslandDecor v-if="!islandEaster" kind="badges" />
        <!-- 彩蛋场景：内容包含「s1d3」时替换常规复制/粘贴反馈——四枚金色键帽依次落位（spring 过冲）→
             错峰波浪跳 → 金光扫掠 → 粒子迸发；配色走主题 gold token，与金环脉冲同套曲线语言 -->
        <template v-if="islandEaster">
          <span class="island-egg-chips" aria-hidden="true">
            <span v-for="(ch, i) in EGG_CHARS" :key="'chip-' + i" class="island-egg-chip" :style="{ '--i': i }">{{ ch }}</span>
            <span
                v-for="(s, i) in EGG_SPARKS"
                :key="'spark-' + i"
                class="island-egg-spark"
                :style="{ '--dx': s.dx + 'px', '--dy': s.dy + 'px', '--p': i }"
            />
            <span class="island-egg-shine" />
          </span>
          <span class="island-egg-tag">{{ t('island.easter_tagline') }}</span>
        </template>
        <!-- 图标随 kind 变化并带语义色：粘贴=剪贴板打勾（中性）/ 成功=对勾圈（绿）/ 失败=叹号圈（红）/
             信息=i圈（中性）/ 解析中=旋转圆弧（金，动画传达"进行中"）/ 复制=双层卡片（中性） -->
        <svg v-else-if="islandKind === 'paste'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <path d="m9 14 2 2 4-4" />
        </svg>
        <svg v-else-if="islandKind === 'success'" class="island-icon text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="m8.5 12.5 2.5 2.5 5-5" />
        </svg>
        <svg v-else-if="islandKind === 'error'" class="island-icon text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <svg v-else-if="islandKind === 'loading'" class="island-icon animate-spin text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
        <svg v-else-if="islandKind === 'info'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        <!-- 剪切=剪刀（与复制的双层卡片区分） -->
        <svg v-else-if="islandKind === 'cut'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
        <svg v-else class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span v-if="!islandEaster" class="shrink-0 text-xs font-medium">{{ islandLabel }}</span>
        <!-- 图片复制/粘贴/剪切：缩略图预览（悬停弹出独立窗口放大预览原图，按原图比例适配+屏幕钳制）；文本复制：单行截断预览 -->
        <img
            v-if="islandImage"
            :src="islandImage"
            alt=""
            class="h-7 w-7 shrink-0 rounded-md object-cover"
            @mouseenter="onIslandImageEnter"
            @mouseleave="hideImagePreview"
        />
        <!-- 文本与缩略图并存渲染（v-if 非 v-else-if）：二维码图片事件的链接文本显示在缩略图旁 -->
        <span v-if="islandText && !islandEaster" ref="islandTextEl" class="min-w-0 flex-1 truncate text-xs text-ink-soft">{{ islandText }}</span>
        <!-- 重复提示计数徽标：同一时段相同内容再次弹出时递增（×2/×3…），用户可明确辨识是新提示 -->
        <span
            v-if="islandRepeat > 1"
            class="island-badge shrink-0 rounded-full bg-gold/15 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-gold"
        >×{{ islandRepeat }}</span>
        <!-- 跨模块快捷动作（悬停淡入，绝对定位不挤占文本）：把当前文本提示分发到待办/便签；
             主窗口监听 island:dispatch 执行落库，这里只负责转发与收起 -->
        <div
            v-if="islandText && !islandImage && !islandEaster"
            class="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-full bg-surface/90 p-0.5 opacity-0 shadow-soft transition-opacity duration-150 group-hover:opacity-100"
        >
          <button
              type="button"
              v-tip="t('island.to_todo')"
              class="flex h-6 w-6 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-gold/15 hover:text-gold"
              @click.stop="dispatchIsland('todo')"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="2" width="8" height="4" rx="1" />
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <path d="m9 14 2 2 4-4" />
            </svg>
          </button>
          <button
              type="button"
              v-tip="t('island.to_note')"
              class="flex h-6 w-6 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-gold/15 hover:text-gold"
              @click.stop="dispatchIsland('note')"
          >
            <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10.5L20 15.5V5z" />
              <path d="M15.5 20v-4.5H20" />
            </svg>
          </button>
        </div>
      </div>
      <!-- 悬停展开的下拉面板：仅当内容溢出胶囊时渲染，逐行带行号展示完整内容（超高可滚动，样式与胶囊一致） -->
      <div
          v-if="islandOverflow"
          class="island-panel bg-surface text-ink border-line shadow-float"
          :class="islandExpanded ? 'island-panel-in' : ''"
          :style="{ maxHeight: islandPanelMaxH + 'px' }"
      >
        <!-- 面板节日装饰挂载点（festival-eggs 注入模块）：随节日皮肤染色（面板容器在 island-wrap 内，
             变量天然继承），不遮文本 -->
        <FestivalIslandDecor v-if="!islandEaster" kind="panel" />
        <div ref="islandPanelInnerEl" class="island-panel-text">
          <div v-for="(line, i) in islandRenderedLines" :key="i" class="island-panel-row">
            <span v-if="islandLineCount > 1" class="island-line-num">{{ i + 1 }}</span>
            <span class="island-line">{{ line }}</span>
          </div>
          <!-- 元信息：总行数；行数被渲染上限截断时附带省略提示（与 tooltip 行为一致） -->
          <div v-if="islandLineCount > 1" class="island-panel-meta">
            {{ islandHiddenLines > 0
                ? `${t('island.line_count', { n: islandLineCount })} · ${t('island.lines_hidden', { n: islandHiddenLines })}`
                : t('island.line_count', { n: islandLineCount }) }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 钉住模式：单片段常驻卡片（灵动岛形态） -->
  <div v-else-if="isPinMode" class="h-screen overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
    <div class="flex items-center justify-between px-3 pt-2">
      <span class="text-[10px] uppercase tracking-wide text-ink-faint">{{ t('bubble.pinned_title') }}</span>
      <button type="button" class="text-ink-faint transition-colors hover:text-danger" @click="closePin">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
    <button type="button"
            class="block w-full px-3 pb-2 pt-1 text-left"
            @click="copyPinned">
      <p class="line-clamp-2 text-xs leading-relaxed text-ink">{{ pinnedText }}</p>
      <p class="mt-1 text-[10px]" :class="pinCopied ? 'text-gold' : 'text-ink-faint'">
        {{ pinCopied ? t('bubble.copied') : t('bubble.click_to_copy') }}
      </p>
    </button>
  </div>

  <!-- 环形盘（单 overlay）：视觉与交互收口在 RingOverlay，此处只做意图转发 -->
  <RingOverlay v-else-if="isRingOverlay"
               :segments="ringSegments"
               :source="ringSource"
               :content-hash="ringContentHash"
               :ai-pending="ringAiPending"
               @paste="onRingPaste"
               @pin="pinRingSegment"
               @dispatch="onRingDispatch"
               @close="onRingClose" />
</template>

<style>
/* dev 模式下 Nuxt DevTools / Vite overlay 会注入到每个页面的 document，
   悬浮窗（island/ring/hub/pin）必须隐藏，否则黑色胶囊浮层污染气泡视觉（生产构建无此项） */
#nuxt-devtools-container,
[id^="nuxt-devtools"],
.vite-error-overlay,
vue-devtools-anchor {
  display: none !important;
}
</style>

<style scoped>
.island-wrap {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  padding-top: 8px;
  overflow: hidden;
}
.island-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
/* 节日彩蛋岛侧样式（光晕/辉光呼吸/骑缘徽章/边框动效/面板装饰）已迁至
   festival-eggs/styles/festival.css（经 nuxt.config css 数组全局注入——装饰 DOM 由
   FestivalIslandDecor 组件渲染，.island-pill-new .fest-badge 等跨组件选择器需全局样式命中） */
.island-pill {
  position: relative;
  z-index: 1; /* 胶囊在上：下拉面板从其下方展开，互不遮挡 */
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: 40px;
  max-width: 344px;
  padding: 0 1rem;
  border-radius: 9999px;
  /* 配色/文字/阴影走主题 token（模板上的 bg-surface text-ink border-line shadow-float），
     随主窗口配色同步，此处只管布局与进出场动画 */
  border-width: 1px;
  opacity: 0;
  /* 收起态上浮 6px：wrap 顶部留 8px，动画全程不越出窗口裁剪区 */
  transform: translateY(-6px) scale(0.92);
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.34, 1.4, 0.4, 1);
}
.island-pill.island-in {
  opacity: 1;
  transform: translateY(0) scale(1);
}
/* 新提示脉冲（多层组合）：主光环点亮后扩散 + 延迟余韵涟漪 + 图标弹跳 + ×N 徽标弹入；
   全部走独立伪元素/子元素动画，不动胶囊原 border/box-shadow 与主题 token */
.island-pill.island-pill-new::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 9999px;
  border: 1.5px solid rgb(var(--c-gold) / 0.9);
  pointer-events: none;
  animation: island-new-ring 0.6s ease-out forwards;
}
/* 主光环：先短暂点亮（金边清晰可见）再扩散渐隐，节奏上"先确认后离去" */
@keyframes island-new-ring {
  0% { opacity: 0; transform: scale(1); }
  18% { opacity: 1; transform: scale(1.005); }
  100% { opacity: 0; transform: scale(1.12); }
}
/* 余韵涟漪：延迟出现、更淡更慢的第二圈，扩散感更柔（两层错峰形成波纹层次） */
.island-pill.island-pill-new::before {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 9999px;
  border: 1px solid rgb(var(--c-gold) / 0.4);
  pointer-events: none;
  animation: island-new-ripple 0.75s ease-out 0.12s forwards;
  opacity: 0;
}
@keyframes island-new-ripple {
  0% { opacity: 0; transform: scale(1); }
  25% { opacity: 1; transform: scale(1.02); }
  100% { opacity: 0; transform: scale(1.22); }
}
/* 图标弹跳：spring 曲线强调"新内容落下" */
.island-pill.island-pill-new .island-icon {
  animation: island-new-icon-pop 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes island-new-icon-pop {
  0% { transform: scale(0.8); }
  55% { transform: scale(1.18); }
  100% { transform: scale(1); }
}
/* ×N 徽标弹入：与脉冲同帧出现，随重复次数持续强化"又来了一条"的感知 */
.island-pill.island-pill-new .island-badge {
  animation: island-new-badge-pop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes island-new-badge-pop {
  0% { transform: scale(0.4); opacity: 0; }
  60% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.island-icon {
  height: 1rem;
  width: 1rem;
  flex-shrink: 0;
  opacity: 0.85;
}
/* ===== 彩蛋场景（内容含 s1d3）：配色走主题 gold token，spring 曲线与"新提示脉冲"同语言 ===== */
.island-egg-chips {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
/* 键帽：金描边圆角方块模拟按键——依次落位（spring 过冲）+ 落定后错峰波浪跳（两段动画独立 delay） */
.island-egg-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 22px;
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  color: rgb(var(--c-gold));
  background: rgb(var(--c-gold) / 0.12);
  border: 1px solid rgb(var(--c-gold) / 0.5);
  box-shadow:
    0 2px 0 rgb(var(--c-gold) / 0.3),
    inset 0 -2px 0 rgb(var(--c-gold) / 0.15);
  animation:
    island-egg-drop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both,
    island-egg-wave 0.45s ease-in-out 1;
  animation-delay:
    calc(0.15s + var(--i) * 0.12s),
    calc(1.25s + var(--i) * 0.07s);
}
@keyframes island-egg-drop {
  0% { opacity: 0; transform: translateY(-16px) scale(0.6); }
  62% { opacity: 1; transform: translateY(2px) scale(1.08); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes island-egg-wave {
  0%, 100% { transform: translateY(0); }
  45% { transform: translateY(-4px); }
}
/* 扫光：键帽落定后一道斜金光带从左掠到右（blur 柔化边缘，skew 出速度感） */
.island-egg-shine {
  position: absolute;
  top: -7px;
  bottom: -7px;
  left: 0;
  width: 34%;
  background: linear-gradient(105deg, transparent, rgb(var(--c-gold) / 0.4), transparent);
  filter: blur(1.5px);
  transform: translateX(-140%) skewX(-14deg);
  animation: island-egg-shine 0.7s ease 1.1s forwards;
  pointer-events: none;
}
@keyframes island-egg-shine {
  to { transform: translateX(360%) skewX(-14deg); }
}
/* 金粒：从键帽中心向六向星形迸发渐隐（方向经 --dx/--dy 注入，--p 错峰起爆） */
.island-egg-spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px;
  border-radius: 9999px;
  background: rgb(var(--c-gold));
  opacity: 0;
  pointer-events: none;
  animation: island-egg-spark 0.65s cubic-bezier(0.2, 0.9, 0.35, 1) forwards;
  animation-delay: calc(1.0s + var(--p) * 0.05s);
}
@keyframes island-egg-spark {
  0% { opacity: 0; transform: translate(0, 0) scale(1); }
  18% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.3); }
}
/* 台词：金色小字延迟淡入上浮，与键帽落位节奏错开（先看清演出再读字） */
.island-egg-tag {
  min-width: 0;
  font-size: 0.6875rem;
  font-weight: 500;
  color: rgb(var(--c-gold) / 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: island-egg-fade 0.45s ease 0.25s both;
}
@keyframes island-egg-fade {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
/* 悬停下拉面板：与胶囊同宽同配色 token（bg-surface/border-line/shadow-float），内容超高时滚动 */
.island-panel {
  z-index: 0;
  width: 344px;
  max-width: calc(100vw - 16px);
  margin-top: 8px;
  padding: 0.625rem 0.875rem;
  border-width: 1px;
  border-radius: 1rem;
  overflow-y: auto;
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
  transform-origin: top center;
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.34, 1.4, 0.4, 1);
}
.island-panel.island-panel-in {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.island-panel-text {
  font-size: 0.75rem;
  line-height: 1.5;
  user-select: text;
  cursor: default;
}
.island-panel-row {
  /* 每行：左侧行号 + 右侧文本 横向排列（与 tooltip 窗口同构） */
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.island-line-num {
  /* 行号：固定宽度、右对齐，从 1 递增到总行数；色走 --c-ink-faint 随主题/节日皮肤染色
     （写死暖棕在节日皮肤深底上会突兀） */
  flex: none;
  width: 1.6em;
  text-align: right;
  font-size: 0.65rem;
  line-height: inherit;
  color: rgb(var(--c-ink-faint) / 0.85);
  white-space: nowrap;
  user-select: none;
}
.island-line {
  /* 完整显示：保留原始空白（tab/连续空格），超长行自动换行展示全部内容 */
  flex: 1;
  min-width: 0;
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.island-panel-meta {
  /* 行数统计：面板底部弱化小字，选中文字时不误选；色随 --c-ink-faint 染色（与行号同源） */
  margin-top: 0.375rem;
  font-size: 0.65rem;
  line-height: 1.4;
  color: rgb(var(--c-ink-faint) / 0.85);
  user-select: none;
}
</style>
