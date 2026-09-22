<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute } from 'vue-router';
import { listen, emit, emitTo } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow, cursorPosition, LogicalSize, PhysicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '~/utils/env';
import { useI18n } from '~/composables/useI18n';
import { showImagePreview, hideImagePreview, dismissImagePreview } from '~/composables/useImagePreview';
import type { IslandKind } from '~/composables/useCopyIsland';

/**
 * 智能剪贴板气泡窗口：四种模式（route.query.mode 区分）。
 *
 * - pin（?mode=pin）：单片段常驻钉住卡片，点击复制，不模拟粘贴、不自我隐藏。
 * - island（?mode=island）：灵动岛提示胶囊（复制/粘贴反馈）。创建与定位由
 *   useCopyIsland 管理；窗口显隐、进出场动画与超时自动隐藏由本页控制，
 *   事件流：island:ready 握手 → island:show-ui（主窗口路径，小缩略图载荷）/
 *   island:show（第三方 API 路径兜底，原图）推送 → 显示动画 → SHOW_MS 后收起并隐藏窗口。
 * - ring（?mode=ring&index=N）：环形布局中的一只独立气泡窗口。文本由管理器
 *   ready 握手后 emitTo('bubble:ring:data') 投递（窗口级 listen 定向接收，防串台）；
 *   选中高亮来自 ring:state 广播；Ctrl+悬停 / 左键点击 → ring:select-req；
 *   双击 → ring:paste-req（由管理器统一隐藏全部环形窗口并模拟粘贴）。
 * - ring-hub（?mode=ring-hub）：环心控制盘，**持有系统焦点的唯一键盘入口**：
 *   ←↑/→↓ 空间导航（ring:nav 按方向）、PgUp/PgDn 翻页（ring:page-nav）、Enter 粘贴选中项
 *   （ring:paste-req）、Esc 整体关闭（ring:close），状态由 ring:state 广播回显。
 *
 * 窗口的创建/定位/分页显隐/层级（选中置顶）全部由 BubbleToggleCommand 管理。
 */

const route = useRoute();
const { t } = useI18n();
const mode = String(route.query.mode ?? 'list');
const isPinMode = mode === 'pin';
const isIsland = mode === 'island';
const isRingBubble = mode === 'ring';
const isRingHub = mode === 'ring-hub';
const ringIndex = Number(route.query.index ?? -1);

// ===== 钉住模式 =====
const pinnedText = ref('');
const pinCopied = ref(false);
let pinCopiedTimer: ReturnType<typeof setTimeout> | null = null;

// ===== 环形气泡 =====
const ringText = ref('');
const ringSelected = ref(false);
/** 选中一次性脉冲：金光在卡片上闪现渐隐（方向键/点击切换时目标气泡"亮一下"），配合双层辉光让选中态一眼可辨 */
const selPulse = ref(false);
let selPulseTimer: ReturnType<typeof setTimeout> | null = null;
watch(ringSelected, (v) => {
  if (selPulseTimer) { clearTimeout(selPulseTimer); selPulseTimer = null; }
  if (!v) { selPulse.value = false; return; }
  selPulse.value = false; // 复位后下一帧再点亮：连续切换时动画从头重播
  requestAnimationFrame(() => { selPulse.value = true; });
  selPulseTimer = setTimeout(() => { selPulse.value = false; }, 700);
});

// ===== 环心控制盘 =====
const hubSelected = ref(0);
const hubTotal = ref(0);
const hubSource = ref('');
/** 总页数（环上限 RING_LIMIT=8/页）：仅 1 页时翻页行整体隐藏 */
const hubPages = computed(() => Math.ceil(hubTotal.value / 8));

// 控制盘高度自适应：窗口创建时固定 240×192（BubbleToggleCommand HUB_W/HUB_H），
// 原文内容少（一两行）时预览区大片空白。按内容实际高度收缩窗口（宽度不动），
// 并保持垂直中心不变——环气泡围绕的是环中心点（与控制盘高度无关），收缩后环绕关系不变。
const HUB_MAX_H = 192;   // 与创建尺寸一致（只缩不涨）
const HUB_MIN_H = 112;   // 最小高度：约两行预览 + 导航行 + 内外留白
let hubFitBusy = false;
let hubFitPending = false;

async function fitHubHeight(): Promise<void> {
  if (!isTauri()) return;
  if (hubFitBusy) { hubFitPending = true; return; }
  hubFitBusy = true;
  try {
    do {
      hubFitPending = false;
      await nextTick();
      const card = document.querySelector('.hub-card') as HTMLElement | null;
      const source = card?.querySelector('.hub-source') as HTMLElement | null;
      if (!card || !source) return;
      // 内容自然高度：预览区不能直接用自身 scrollHeight——内容少时 flex-1 会把它撑大，
      // 测出来永远是撑大值导致永不收缩；取内部 span 的高度（= 文本真实行数高）。
      // 内容超长时 span 自身高度即完整内容高，同样正确。
      const span = source.firstElementChild as HTMLElement | null;
      const srcH = span ? span.scrollHeight : source.scrollHeight;
      let contentH = srcH;
      const rows = card.children;
      for (let i = 1; i < rows.length; i++) {
        const el = rows[i] as HTMLElement;
        if (el instanceof HTMLElement) contentH += el.offsetHeight;
      }
      const gaps = 8 * Math.max(0, rows.length - 1);        // flex-col gap-2（行间）
      const chrome = 20 + 2 + 12;                            // 卡片 py-2.5 + 上下边框 + 外层 p-1.5（×2）
      const targetCss = Math.min(Math.max(contentH + gaps + chrome, HUB_MIN_H), HUB_MAX_H);
      const win = getCurrentWindow();
      const size = await win.outerSize();
      const pos = await win.outerPosition();
      const dpr = await win.scaleFactor();
      const targetPhys = Math.round(targetCss * dpr);
      if (Math.abs(targetPhys - size.height) < 2) continue;  // 已就位（含每次导航广播的重复触发）
      await win.setSize(new PhysicalSize(size.width, targetPhys)).catch(() => {});
      // 垂直中心不动：气泡排布以环中心为基准，中心偏移会破坏环绕视觉
      const newY = Math.round(pos.y + (size.height - targetPhys) / 2);
      await win.setPosition(new PhysicalPosition(pos.x, newY)).catch(() => {});
    } while (hubFitPending);
  } finally {
    hubFitBusy = false;
  }
}

// 仅内容/页数变化影响高度（选中等导航广播不触发）；AI 阶段二补片段跨页时翻页行出现/消失同样重算
watch([hubSource, hubPages], () => { void fitHubHeight(); });

// ===== 灵动岛提示胶囊（island 模式）=====
// 停留时长由 useCopyIsland 按设置随 island:show 下发（durationMs），此处仅作兜底默认值
const ISLAND_SHOW_MS = 1800;
const ISLAND_OUT_MS = 240;
const ISLAND_W = 360;
const ISLAND_H = 56;
const ISLAND_TOP_OFFSET = 8;       // 窗口顶部留白（与 .island-wrap padding-top 一致）
const ISLAND_PILL_H = 40;          // 胶囊高度（与 .island-pill CSS 一致）
const ISLAND_PANEL_GAP = 8;        // 胶囊与下拉面板间距
const ISLAND_PANEL_PAD_BOTTOM = 12; // 面板底部留白（窗口扩高余量）
const ISLAND_PANEL_MAX_H = 280;    // 下拉面板最大高度：防止占满整屏
const ISLAND_PROXIMITY_PX = 32;    // 鼠标邻近检测阈值（逻辑像素）：进入即暂停自动隐藏
const ISLAND_HOVER_INTENT_MS = 150; // 悬停意图：光标停留在岛区域持续此时长才展开下拉
const islandVisible = ref(false);
const islandKind = ref<IslandKind>('copy');
const islandText = ref('');
const islandImage = ref('');             // 图片内容（data URL）：复制/粘贴/剪切图片事件在胶囊内渲染缩略图（悬停放大预览）
const islandTitle = ref('');             // 自定义标签（灵动岛 API 调用可指定；空则用 kind 默认标签）

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
async function applyIsland(payload: { kind: IslandKind; text?: string; image?: string; thumb?: string; title?: string; durationMs?: number; sticky?: boolean }): Promise<void> {
  islandKind.value = payload.kind;
  islandText.value = payload.text ?? '';
  // 图片内容：优先渲染显示级缩略图（几十 KB，复杂图片秒弹），缺省回退 image 原图；
  // 复制图片兼容旧载荷（data URL 在 text）——text 现为二维码链接时不当作图片
  islandImage.value = payload.thumb || payload.image
    || (payload.kind === 'copy-image' && payload.text?.startsWith('data:') ? payload.text : '');
  islandTitle.value = payload.title ?? '';
  islandDuration.value = payload.durationMs ?? ISLAND_SHOW_MS;
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
        - ISLAND_TOP_OFFSET - ISLAND_PILL_H - ISLAND_PANEL_GAP - ISLAND_PANEL_PAD_BOTTOM - 8;
      maxPanel = Math.max(96, Math.min(ISLAND_PANEL_MAX_H, Math.floor(avail)));
    }
  } catch { /* 取不到显示器信息则用全局上限 */ }
  islandPanelMaxH.value = maxPanel;
  await nextTick();
  const inner = islandPanelInnerEl.value;
  if (!inner) return;
  const panelH = Math.min(inner.offsetHeight, maxPanel); // 内容自适应：仅略微溢出也只轻微扩高
  if (panelH <= 0) return;
  // 先扩窗再展面板：窗口裁剪 DOM，反序会让内容闪现截断（高度 = 顶留白 + 胶囊 + 间距 + 面板 + 底留白）
  const winH = ISLAND_TOP_OFFSET + ISLAND_PILL_H + ISLAND_PANEL_GAP + panelH + ISLAND_PANEL_PAD_BOTTOM;
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

/** 钉住：把当前片段复制为独立常驻小气泡窗（ring 模式与 pin 模式均可触发） */
async function pinCurrent(): Promise<void> {
  const text = isRingBubble ? ringText.value : pinnedText.value;
  if (!isTauri() || !text) return;
  // 习惯记录：钉住也是一次强偏好信号（ring 模式下上报给管理器落库）
  if (isRingBubble) void emit('ring:habit', { index: ringIndex, action: 'pin' });
  const label = `clipboard-bubble-pin-${Date.now()}`;
  (window as any).__childOpeningUntil = Date.now() + 600;
  const unReady = await listen('bubble:pin:ready', (ev) => {
    if ((ev.payload as string | undefined) !== label) return;
    void emitTo(label, 'bubble:pin:data', { text });
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

// ===== 环形气泡交互 =====
/** Ctrl+悬停 / 左键点击：请求选中（已选中则不重复发） */
function ringSelect(): void {
  if (!ringSelected.value) void emit('ring:select-req', { index: ringIndex });
}
function ringPointerMove(e: PointerEvent): void {
  if (e.ctrlKey) ringSelect();
}
/** 双击：请求粘贴（管理器统一隐藏全部窗口并模拟粘贴） */
function ringPaste(): void {
  void emit('ring:paste-req', { index: ringIndex });
}
function ringClose(): void {
  void emit('ring:close');
}

// ===== 控制盘指令 =====
function hubNav(delta: number): void {
  void emit('ring:nav', { delta });
}
/** 键盘方向键：按空间方向导航（管理器按 3×3 网格行/列带折算目标气泡） */
function hubNavDir(dir: 'up' | 'down' | 'left' | 'right'): void {
  void emit('ring:nav', { dir });
}
function hubPageNav(delta: number): void {
  void emit('ring:page-nav', { delta });
}
function hubClose(): void {
  void emit('ring:close');
}

onMounted(async () => {
  if (!isTauri()) return;
  if (isIsland) {
    // 透明窗口：body 渐变背景与光晕必须去除，否则透出灰底（.island-body 规则见样式块）
    document.body.classList.add('island-body');
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
  if (isRingBubble) {
    // 透明窗口：body 渐变背景与光晕必须去除，否则透出灰底、圆角卡片四角露方块
    // （复用 .island-body 规则——该规则即"body 透明 + 去全局光晕"，与岛模式共用）
    document.body.classList.add('island-body');
    // 窗口级 listen（同 pin 模式注释）：emitTo 定向投递只命中本窗口，杜绝多气泡文本串台
    unlisteners.push(await getCurrentWebviewWindow().listen<{ text: string }>('bubble:ring:data', (ev) => {
      ringText.value = ev.payload.text;
    }));
    unlisteners.push(await listen<{ selected: number }>('ring:state', (ev) => {
      ringSelected.value = ev.payload.selected === ringIndex;
    }));
    // ready 握手：通知管理器投递本文本
    await emit('bubble:ring:ready', getCurrentWindow().label);
    return;
  }
  if (isRingHub) {
    // 透明窗口：同 ring 气泡，去除 body 背景让圆润卡片直接悬浮于桌面
    document.body.classList.add('island-body');
    unlisteners.push(await listen<{ selected: number; page: number; total: number; source?: string }>('ring:state', (ev) => {
      hubSelected.value = ev.payload.selected;
      hubTotal.value = ev.payload.total;
      hubSource.value = ev.payload.source ?? '';
    }));
    // ready 握手：通知管理器推送初始状态
    await emit('bubble:ring:hub-ready', getCurrentWindow().label);
    // Esc 关闭整个环（控制盘获得焦点时可用）
    window.addEventListener('keydown', onHubKeydown);
    return;
  }
});

/**
 * 控制盘键盘导航（控制盘持有系统焦点，是环形系统的唯一键盘入口）：
 * ←↑/→↓ 空间导航（↑↓ 列内上下移动，←→ 行内左右移动，行首/行尾折转最近的上方/下方气泡）
 * · Enter 粘贴选中项 · PgUp/PgDn 翻页 · Esc 关闭整环
 */
function onHubKeydown(e: KeyboardEvent): void {
  // Ctrl+B（局部快捷键的环内延伸）：环打开时焦点在本控制盘，主窗口收不到 keydown，
  // 在此转发 ring:close 保持「Ctrl+B toggle 关环」行为一致
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    hubClose();
    return;
  }
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      hubNavDir('left');
      break;
    case 'ArrowUp':
      e.preventDefault();
      hubNavDir('up');
      break;
    case 'ArrowRight':
      e.preventDefault();
      hubNavDir('right');
      break;
    case 'ArrowDown':
      e.preventDefault();
      hubNavDir('down');
      break;
    case 'Enter':
      e.preventDefault();
      void emit('ring:paste-req', { index: hubSelected.value });
      break;
    case 'PageUp':
      e.preventDefault();
      hubPageNav(-1);
      break;
    case 'PageDown':
      e.preventDefault();
      hubPageNav(1);
      break;
    case 'Escape':
      e.preventDefault();
      hubClose();
      break;
  }
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onHubKeydown);
  for (const u of unlisteners) u();
  unlisteners = [];
  if (pinCopiedTimer) clearTimeout(pinCopiedTimer);
  if (isIsland) {
    clearIslandTimers();
    cancelIslandExpand();
    if (islandCollapseTimer) { clearTimeout(islandCollapseTimer); islandCollapseTimer = null; }
    stopIslandProximity();
  }
  // ring / ring-hub 模式挂载时也加了 island-body（body 透明），统一在此移除
  document.body.classList.remove('island-body');
});
</script>

<template>
  <!-- 灵动岛模式：复制/粘贴反馈胶囊（配色随主窗口主题同步，靠窗口透明悬浮于屏幕顶部） -->
  <div v-if="isIsland" class="island-wrap">
    <div class="island-col" @mouseenter="onIslandEnter" @mouseleave="onIslandLeave">
      <div
          ref="islandPillEl"
          class="island-pill bg-surface text-ink border-line shadow-float"
          :class="[islandVisible ? 'island-in' : '', islandPulse ? 'island-pill-new' : '']"
      >
        <!-- 图标随 kind 变化并带语义色：粘贴=剪贴板打勾（中性）/ 成功=对勾圈（绿）/ 失败=叹号圈（红）/
             信息=i圈（中性）/ 解析中=旋转圆弧（金，动画传达"进行中"）/ 复制=双层卡片（中性） -->
        <svg v-if="islandKind === 'paste'" class="island-icon text-ink-soft" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
        <span class="shrink-0 text-xs font-medium">{{ islandLabel }}</span>
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
        <span v-if="islandText" ref="islandTextEl" class="min-w-0 flex-1 truncate text-xs text-ink-soft">{{ islandText }}</span>
        <!-- 重复提示计数徽标：同一时段相同内容再次弹出时递增（×2/×3…），用户可明确辨识是新提示 -->
        <span
            v-if="islandRepeat > 1"
            class="island-badge shrink-0 rounded-full bg-gold/15 px-1.5 text-[10px] font-semibold leading-4 tabular-nums text-gold"
        >×{{ islandRepeat }}</span>
      </div>
      <!-- 悬停展开的下拉面板：仅当内容溢出胶囊时渲染，逐行带行号展示完整内容（超高可滚动，样式与胶囊一致） -->
      <div
          v-if="islandOverflow"
          class="island-panel bg-surface text-ink border-line shadow-float"
          :class="islandExpanded ? 'island-panel-in' : ''"
          :style="{ maxHeight: islandPanelMaxH + 'px' }"
      >
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

  <!-- 环形气泡：独立透明窗口 + 圆润卡片（四周 8px 留白供圆角与阴影渲染，四角透出桌面），
       选中高亮（金边 + 外发光 + 序号徽章），Ctrl+悬停/点击选中，双击粘贴 -->
  <div v-else-if="isRingBubble"
       class="group relative h-screen cursor-pointer rounded-2xl border p-2 shadow-soft transition-all duration-200 ease-soft"
       :class="[ringSelected
         ? 'bubble-selected border-gold bg-surface-field ring-2 ring-gold shadow-[0_0_4px_rgb(var(--c-gold)/0.55),0_0_20px_rgb(var(--c-gold)/0.55)]'
         : 'border-line bg-surface-field/95 hover:border-accent',
         selPulse ? 'bubble-sel-pulse' : '']"
       @pointermove="ringPointerMove"
       @click="ringSelect"
       @dblclick="ringPaste">
    <p class="line-clamp-3 text-[11px] leading-relaxed text-ink">{{ ringText }}</p>
    <button type="button"
            class="absolute right-1 top-1 hidden rounded-md bg-surface px-1 text-[10px] text-ink-faint shadow-xs transition-colors hover:text-gold group-hover:block"
            :title="t('bubble.pin')"
            @click.stop="pinCurrent">📌</button>
    <span v-if="ringSelected"
          class="bubble-badge-in absolute bottom-1 right-2 text-[10px] font-semibold tabular-nums text-gold">{{ ringIndex + 1 }}</span>
  </div>

  <!-- 环心控制盘：极简布局——原文预览 + 片段导航，无标题栏/状态文本/操作提示；
       Esc 关环、PgUp/PgDn 翻页键盘始终可用（透明窗口 + 圆润卡片，外层 p-1.5 为阴影留白） -->
  <div v-else-if="isRingHub" class="h-screen p-1.5">
    <div class="hub-card flex h-full flex-col justify-center gap-2 rounded-2xl border border-accent bg-surface/95 px-3.5 py-2.5 shadow-soft backdrop-blur">

    <!-- 原文预览：环心展示本次拆分的原始 clip 内容（占满剩余空间，超长滚动查看） -->
    <div class="hub-source min-h-0 flex-1 overflow-y-auto rounded-lg bg-surface-muted/60 px-2 py-1">
      <span class="whitespace-pre-wrap break-all text-[10px] leading-relaxed text-ink-soft">{{ hubSource }}</span>
    </div>

    <!-- 片段导航：仅箭头按钮，选中态由环气泡金边高亮呈现 -->
    <div class="flex items-center justify-center gap-6">
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.prev')"
              @click="hubNav(-1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <button type="button" class="btn-soft btn-circle p-1 disabled:opacity-30" :title="t('bubble.next')"
              @click="hubNav(1)">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>

    <!-- 翻页：仅多页时显示（单页完全隐藏） -->
    <div v-if="hubPages > 1" class="flex items-center justify-center gap-6">
      <button type="button" class="text-ink-faint transition-colors hover:text-gold" :title="t('bubble.prev_page')"
              @click="hubPageNav(-1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17-5-5 5-5" /><path d="m18 17-5-5 5-5" /></svg>
      </button>
      <button type="button" class="text-ink-faint transition-colors hover:text-gold" :title="t('bubble.next_page')"
              @click="hubPageNav(1)">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 17 5-5-5-5" /><path d="m14 17 5-5-5-5" /></svg>
      </button>
    </div>
    </div>
  </div>
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

<style>
/* 透明悬浮窗口通用（island / ring / ring-hub 模式经 body class 作用）：
   去除全局 body 渐变与光晕，保持窗口透明以悬浮于桌面 */
body.island-body {
  background: transparent !important;
}
body.island-body::before,
body.island-body::after {
  display: none !important;
}

/* 环心原文预览：窄窗口内使用细滚动条（WebView2 默认滚动条过宽，挤占 240px 环心宽度） */
.hub-source {
  scrollbar-width: thin;
  scrollbar-color: rgba(128, 128, 128, 0.45) transparent;
}
.hub-source::-webkit-scrollbar { width: 4px; }
.hub-source::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.45); border-radius: 2px; }
.hub-source::-webkit-scrollbar-track { background: transparent; }
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
  /* 行号：固定宽度、右对齐，从 1 递增到总行数 */
  flex: none;
  width: 1.6em;
  text-align: right;
  font-size: 0.65rem;
  line-height: inherit;
  color: rgba(150, 120, 90, 0.85);
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
  /* 行数统计：面板底部弱化小字，选中文字时不误选 */
  margin-top: 0.375rem;
  font-size: 0.65rem;
  line-height: 1.4;
  color: rgba(150, 120, 90, 0.85);
  user-select: none;
}
/* 选中气泡一次性脉冲：金光闪现渐隐（inset:0 不越窗口裁剪区，透明窗无需担心边缘）；
   与静态双层辉光叠加：切换瞬间"亮一下"，静止时靠辉光与金边持续辨识 */
.bubble-sel-pulse::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: rgb(var(--c-gold) / 0.16);
  border: 2px solid rgb(var(--c-gold) / 0.85);
  pointer-events: none;
  animation: bubble-sel-flash 0.6s ease-out forwards;
}
@keyframes bubble-sel-flash {
  0% { opacity: 0; }
  22% { opacity: 1; }
  100% { opacity: 0; }
}
/* 选中序号徽章入场：随选中切换淡入上浮，与卡片 200ms 高亮过渡 + 金光脉冲衔接成连贯的焦点移动感 */
.bubble-badge-in {
  animation: bubble-badge-in 0.2s ease-out both;
}
@keyframes bubble-badge-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
