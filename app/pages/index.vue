<script setup lang="ts">
import type {ClipboardData} from '~/src/Entities';
import {formatDate} from "~/src/utils/formatDate";
import {
  dataLength, getSelectedRowId, getSelectedRowIndex,
  selectedRowIndex,
  selectRow
} from '~/src/commands/local/TargetMovementCommand';
import { data, filter, fetchData, getSelectedItem } from '~/src/commands/local/clipboardStore';
import HighlightText from "~/components/mainpage/HighlightText.vue";
import {isTauri} from "~/src/utils/env";
import clipboardService from "~/src/db/dbService";
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import StickyNote from "~/components/note/StickyNote.vue";
import TodoList from "~/components/todo/TodoList.vue";
import SettingMain from "~/components/setting/SettingMain.vue";
import { activeTab } from "~/composables/useTabs";

const listElement = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLElement | null>(null);

let updateInterval: NodeJS.Timeout;

const highlightState = ref(true);
const highlightContent = ref('')

watch(highlightContent, (newValue, oldValue) => {
  filter.value.searchContent = newValue;
});

// 切换 tab 时隐藏 tooltip（clip 列表随 tab 卸载，tooltip 需同步关闭）
watch(activeTab, () => {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  hoveringClip = false;
  hoveringTooltip = false;
  tooltip.value.visible = false;
  // 同步关闭独立 tooltip 窗口
  emit('tooltip:hide').catch(() => {});
})

const tooltip = ref({
  visible: false,
  text: '',
  x: 0,
  y: 0,
});

/** tooltip 独立窗口单例 label */
let tooltipLabel: string | null = null;
/** 最新一次待显示的 tooltip 数据（窗口就绪前缓存，避免事件丢失） */
let latestTooltipPayload: { text?: string; image?: string; meta?: string; x: number; y: number } | null = null;
/** tooltip 悬停跨窗口事件监听的取消函数 */
let unlistenTooltipHover: Array<() => void> = [];
/** 鼠标是否悬停在 tooltip 弹层上（悬停期间保持显示） */
let hoveringTooltip = false;
/** 鼠标是否悬停在触发 clip 项上 */
let hoveringClip = false;
/** 延迟隐藏计时器：给鼠标从触发元素移到 tooltip 留出过渡时间 */
let hideTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 将相对主窗口视口的 CSS 像素坐标转换为物理屏幕像素坐标（供独立 tooltip 窗口定位）。
 * Tauri v2 的 outerPosition() 返回的是物理像素（已含 DPR），故换算为：
 *   物理像素 = 主窗口物理位置 + 视口 CSS 坐标 * 设备像素比
 */
async function toPhysicalCoords(viewX: number, viewY: number): Promise<{ x: number; y: number }> {
  if (!isTauri()) return { x: viewX, y: viewY };
  try {
    const win = getCurrentWindow();
    const pos = await win.outerPosition(); // 物理像素
    const scale = await win.scaleFactor();
    return {
      x: Math.round(pos.x + viewX * scale),
      y: Math.round(pos.y + viewY * scale),
    };
  } catch {
    return { x: viewX, y: viewY };
  }
}

/**
 * 让子窗口（tooltip / image-viewer 等）在主窗口置顶时也"置顶"，
 * 避免被置顶的主窗口压在后方导致看不到（表现为 tooltip 无法显示/被遮挡）。
 * 必须在窗口 tauri://created 之后调用；后创建的置顶窗口在 Z 序上更靠前，
 * 从而稳定显示在主窗口前方，且不抢主窗口键盘焦点（与子窗口 focus:false 兼容）。
 */
async function syncChildOnTop(win: WebviewWindow) {
  if (!isTauri()) return;
  try {
    const mainOnTop = await getCurrentWindow().isAlwaysOnTop();
    if (mainOnTop) await win.setAlwaysOnTop(true);
  } catch {
    // 忽略（如窗口尚未就绪或 API 不可用）
  }
}

/** 打开（或定位到）独立 tooltip 窗口并推送内容 */
async function openTooltipWindow() {
  if (!isTauri()) return;
  // 图片查看器（image-viewer）打开期间禁止 tooltip 窗口出现：
  // 查看器为独立前台窗口，悬停主列表项不应再弹出 tooltip，关闭查看器后 viewerLabel 置空即恢复。
  if (viewerLabel) return;
  if (tooltipLabel) {
    const existing = await WebviewWindow.getByLabel(tooltipLabel).catch(() => null);
    if (existing) {
      // 窗口已存在：直接补发最新内容（此时窗口已在监听 tooltip:show）
      if (latestTooltipPayload) {
        const coords = await toPhysicalCoords(latestTooltipPayload.x, latestTooltipPayload.y);
        await emit('tooltip:show', { ...latestTooltipPayload, x: coords.x, y: coords.y });
      }
      return;
    }
    tooltipLabel = null; // 已销毁，走新建
  }
  // 标记子窗口豁免期，避免创建瞬间触发主窗口失焦隐藏
  (window as any).__childOpeningUntil = Date.now() + 600;
  const label = `tooltip-${Date.now()}`;
  tooltipLabel = label;
  // 关键：必须在 new WebviewWindow 之前注册 ready 监听，
  // 否则独立窗口 onMounted 的 emit('tooltip:ready') 可能早于本监听注册而丢失，
  // 导致后续补发永不触发、tooltip 间歇不显示。
  const unReady = await listen('tooltip:ready', async (ev) => {
    const readyLabel = (ev.payload as string | undefined) ?? '';
    if (readyLabel && readyLabel !== label) return;
    // 窗口已就绪：用最新 payload 实时计算物理坐标后补发（不依赖之前的竞态 emit）
    if (latestTooltipPayload) {
      const coords = await toPhysicalCoords(latestTooltipPayload.x, latestTooltipPayload.y);
      await emit('tooltip:show', { ...latestTooltipPayload, x: coords.x, y: coords.y });
    }
    unReady();
  });
  // 兜底清理：5s 内未收到 ready 也释放监听
  setTimeout(() => unReady(), 5000);

  const win = new WebviewWindow(label, {
    url: '/tooltip',
    title: '详情',
    width: 480,
    height: 360,
    resizable: false,
    decorations: false,
    transparent: false,  // 不透明：tooltip 窗口自带背景，避免透出主窗口导航与控件
    skipTaskbar: true,
    focus: false,        // 不抢焦点：避免打断主窗口键盘交互与触发主窗口自动隐藏
    visible: false,      // 定位与尺寸就绪后再 show，避免闪烁/错位的空窗口
  });
  win.once('tauri://created', () => {
    (window as any).__childOpeningUntil = Date.now() + 400;
    // 主窗口置顶时同步让 tooltip 窗口置顶，避免被置顶主窗口遮挡（tooltip 不抢焦点、显示在前方）
    syncChildOnTop(win);
  });
  win.once('tauri://error', () => {
    if (tooltipLabel === label) tooltipLabel = null;
  });
}

function showTooltip(index: number, item: ClipboardData, event: MouseEvent) {
  // 图片查看器（image-viewer）打开期间禁止 tooltip 出现：
  // 查看器为独立前台窗口，悬停主列表项不再弹出 tooltip；关闭查看器（viewerLabel 置空）后自动恢复。
  if (viewerLabel) return;
  const el = event.currentTarget as HTMLElement;
  // 取消挂起的隐藏计时器，避免移动到其他项时旧 tooltip 误关闭新 tooltip
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  hoveringClip = true;
  const rect = el.getBoundingClientRect();

  // 构建 tooltip 内容：图片项展示放大预览 + 元信息；文本项展示多行文本 + 元信息
  // 元信息统一为单行，显示在 tooltip 底部
  const isImageItem = !!el.querySelector('img');
  const meta = `创建时间${formatDate(parseInt(item.created_at))} · 使用次数:${item.count} · 最后使用:${formatDate(parseInt(item.updated_at))}`;
  let payload: { text?: string; image?: string; meta?: string; x: number; y: number };
  if (isImageItem) {
    payload = {
      image: item.content,
      meta,
      x: rect.left,
      y: rect.bottom + 4,
    };
  } else {
    const text = item.content;
    // 文本项仅在行数较多时展示，避免单行内容也弹出 tooltip
    if (text.split('\n').length - 1 <= 2) {
      tooltip.value.visible = false;
      return;
    }
    payload = {
      text,
      meta,
      x: rect.left,
      y: rect.bottom + 4,
    };
  }

  tooltip.value = {
    visible: true,
    text: payload.text ?? '',
    x: payload.x,
    y: payload.y,
  };
  if (isTauri()) {
    // 缓存 viewport 坐标（供窗口 ready 后实时换算物理坐标），由 openTooltipWindow 的
    // ready 握手统一补发 tooltip:show，避免竞态导致的间歇不显示
    latestTooltipPayload = payload;
    openTooltipWindow();
  }
}

/**
 * 延迟隐藏：仅当鼠标既不在 clip 项上、也不在 tooltip 窗口上时，
 * 才真正隐藏。给鼠标在 clip 项与 tooltip 窗口之间移动留出过渡时间。
 */
function scheduleHideTooltip() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!hoveringClip && !hoveringTooltip) {
      tooltip.value.visible = false;
      emit('tooltip:hide').catch(() => {});
    }
  }, 200);
}

function hideTooltip() {
  hoveringClip = false;
  scheduleHideTooltip();
}

function handelFilter() {
  filter.value.favorite = filter.value.favorite === 1 ? 0 : 1
}

function handelTypeFilter() {
  filter.value.type = filter.value.type === 'image' ? 'all' : 'image'
}

onMounted(async () => {
  console.log('mounting...')

  // 全局快捷键已在 app.vue 统一注册；列表项的本地 keydown 仍绑定在 <ul> 上
  // 仅在 Tauri 桌面容器内启用轮询（Web 端无数据，避免空转）
  if (isTauri()) {
    updateInterval = setInterval(fetchData, 1000);
  }
  if (searchInput.value) {
    searchInput.value.focus();
  }
  // 窗口被 Ctrl+I 唤出后，自动聚焦搜索框：直接输入字符即可搜索，无需点击
  window.addEventListener('window-shown', onMainWindowShown);
  // tooltip 弹层悬停：进入保持显示，离开后允许隐藏（独立窗口通过 Tauri 事件通信）
  if (isTauri()) {
    const u1 = await listen('tooltip:hover-enter', onTooltipHoverEnter);
    const u2 = await listen('tooltip:hover-leave', onTooltipHoverLeave);
    // tooltip 激活状态（显示/使用中）：设全局标志，主窗口失焦自动隐藏据此跳过；
    // 停用时若主窗口已失焦，则补执行一次隐藏（避免 tooltip 关闭后主窗口卡在显示态）
    const u3 = await listen('tooltip:active', (ev) => {
      const active = !!ev.payload;
      (window as any).__tooltipActive = active;
      if (!active && (window as any).__mainFocused === false) {
        (window as any).__tryHideMainWindow?.();
      }
    });
    unlistenTooltipHover = [u1, u2, u3];
  }
  // Delete 键请求删除：打开独立删除确认窗口
  window.addEventListener('delete-request', onDeleteRequest);

  // 删除确认窗口的回执：yes=删除，no=取消。
  // 收到回执后设标志并延迟兜底聚焦；真正聚焦在 delete-confirm:closed（窗口销毁后）。
  // 兜底定时器：若 closed 事件因窗口销毁丢失，300ms 后仍恢复焦点（避免 Del 键失效）
  const scheduleRefocus = () => {
    deleteConfirmClosedByUser = true;
    setTimeout(() => {
      if (deleteConfirmClosedByUser) {
        deleteConfirmClosedByUser = false;
        refocusList();
      }
    }, 300);
  };
  listen('delete-confirm:yes', (ev) => {
    const l = (ev.payload as string | undefined) ?? '';
    if (l && l !== deleteConfirmLabel) return;
    if (deleteConfirmLabel) deleteConfirmLabel = null;
    confirmDelete();
    scheduleRefocus();
  });
  listen('delete-confirm:no', (ev) => {
    const l = (ev.payload as string | undefined) ?? '';
    if (l && l !== deleteConfirmLabel) return;
    if (deleteConfirmLabel) deleteConfirmLabel = null;
    scheduleRefocus();
  });
  // 删除确认窗口已销毁（此时聚焦不再被抢占）：
  // - 用户主动操作关闭（Enter/Esc，yes/no 回执置位标志）→ 恢复焦点，局部快捷键可用
  // - 失焦自动关闭（用户主动切到其他应用）→ 不抢焦点，尊重用户切换意图
  listen('delete-confirm:closed', (ev) => {
    const l = (ev.payload as string | undefined) ?? '';
    if (l && l !== deleteConfirmLabel) return;
    if (deleteConfirmLabel) deleteConfirmLabel = null;
    if (deleteConfirmClosedByUser) {
      deleteConfirmClosedByUser = false;
      refocusList();
    }
  });
  // 图片查看器已关闭：焦点回归列表（用户主动关闭查看器）
  listen('image-viewer:closed', () => {
    refocusList();
  });
});

// 注意：不要在主窗口 onFocusChanged 中调用 refocusList！
// refocusList 内部的 setFocus() 会再次触发 onFocusChanged(focused=true)，
// 形成"获得焦点 → 强制聚焦 → 再获得焦点"的无限循环，导致主窗口持续抢焦点，
// 用户无法切到其他窗口/最小化主窗口。
// 焦点恢复已由 delete-confirm:yes/no/closed 与 image-viewer:closed 事件可靠触发。

function onTooltipHoverEnter() {
  hoveringTooltip = true;
  // 进入 tooltip：取消挂起的隐藏计时器，保持显示
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

async function onTooltipHoverLeave() {
  hoveringTooltip = false;
  // 鼠标离开 tooltip 回到主窗口侧：主动把焦点交还主窗口。
  // 否则主窗口仍记录为失焦（之前操作 tooltip 时 tooltip 获焦），
  // 后续 tooltip 关闭的补隐藏逻辑会误判主窗口失焦而一起隐藏。
  // 鼠标在主窗口内时，主窗口应保持显示。
  if (isTauri()) {
    const win = getCurrentWindow();
    if (await win.isVisible().catch(() => false)) {
      await win.setFocus().catch(() => {});
    }
  }
  // 离开 tooltip：延迟隐藏，给鼠标移回 clip 项留出过渡时间
  scheduleHideTooltip();
}

function focusList() {
  searchInput.value?.focus();
}

/**
 * 主窗口从隐藏/最小化重新显示时（window-shown）的兜底清理：
 * 关闭并重置可能已在父窗口隐藏期间被系统挂起的 tooltip 单例，
 * 确保下次 hover 走 openTooltipWindow 的 new WebviewWindow 重建鲜活窗口，
 * 避免事件通道失效导致 tooltip 无法显示（此前需刷新应用才能恢复）。
 */
async function resetTooltipSingleton() {
  if (tooltipLabel) {
    const existing = await WebviewWindow.getByLabel(tooltipLabel).catch(() => null);
    if (existing) {
      try { await existing.close(); } catch { /* 忽略关闭失败 */ }
    }
    tooltipLabel = null;
  }
  latestTooltipPayload = null;
  hoveringClip = false;
  hoveringTooltip = false;
  tooltip.value.visible = false;
}

function onMainWindowShown() {
  resetTooltipSingleton();
  focusList();
}

onBeforeUnmount(async () => {
  console.log('unmounting outside...')
  window.removeEventListener('window-shown', onMainWindowShown);
  unlistenTooltipHover.forEach((u) => u());
  unlistenTooltipHover = [];
  window.removeEventListener('delete-request', onDeleteRequest);
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null as unknown as NodeJS.Timeout;
  }
});

async function favorite(id: number, value: number) {
  value = value === 0 ? 1 : 0;
  await clipboardService.updateFavorite(id, value)
}

/** 删除确认窗口 label（单例） */
let deleteConfirmLabel: string | null = null;
/** 删除确认窗口正在创建中（防止快速多次按 Delete 重复创建窗口） */
let deleteConfirmOpening = false;
/** 删除确认窗口是否由用户主动操作关闭（Enter/Esc），用于区分"失焦自动关闭"不抢焦点 */
let deleteConfirmClosedByUser = false;

/** 点击删除按钮：在独立确认窗口弹窗，不再内嵌展示内容 */
async function handleDelete(target: ClipboardData) {
  if (!target || !isTauri() || deleteConfirmOpening) return;

  // 复用已存在的删除确认窗口，直接更新待删除项
  if (deleteConfirmLabel) {
    const existing = await WebviewWindow.getByLabel(deleteConfirmLabel).catch(() => null);
    if (existing) {
      await emit('delete-confirm:payload', { label: deleteConfirmLabel, type: target.type });
      return;
    }
    deleteConfirmLabel = null;
  }

  deleteConfirmOpening = true;
  const label = `delete-confirm-${Date.now()}`;
  deleteConfirmLabel = label;
  // 标记子窗口正在打开，临时豁免主窗口的失焦自动隐藏（避免创建瞬间误隐藏）
  (window as any).__childOpeningUntil = Date.now() + 600;
  const win = new WebviewWindow(label, {
    url: '/delete-confirm',
    title: '删除确认',
    width: 360,
    height: 200,
    resizable: false,
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    center: true,
  });
  win.once('tauri://created', () => {
    deleteConfirmOpening = false;
    // 窗口已创建，延长豁免期至其稳定聚焦
    (window as any).__childOpeningUntil = Date.now() + 400;
  });
  win.once('tauri://error', () => {
    console.error('删除确认窗口创建失败:', label);
    deleteConfirmOpening = false;
    if (deleteConfirmLabel === label) deleteConfirmLabel = null;
  });

  // 等待确认窗口 ready 后发送待删除项类型
  const unlistenReady = await listen('delete-confirm:ready', async (ev) => {
    const readyLabel = (ev.payload as string | undefined) ?? '';
    if (readyLabel && readyLabel !== label) return;
    await emit('delete-confirm:payload', { label, type: target.type });
    unlistenReady();
  });
  setTimeout(() => unlistenReady(), 5000);
}

/** 收到删除确认：执行删除并刷新列表 */
async function confirmDelete() {
  const item = getSelectedItem();
  if (item) {
    await clipboardService.deleteClipboardData(item.id);
    await fetchData();
  }
}

/** Delete 键请求：对当前选中项打开独立删除确认窗口 */
function onDeleteRequest() {
  // 直接从 store 取当前选中项，避免依赖易过期的 deleteTarget（fetchData 每秒刷新 data 数组）
  const item = getSelectedItem();
  if (item) handleDelete(item);
}

/** 防抖计时器：多个关闭路径（yes/no/closed/onFocusChanged）同时触发时只聚焦一次 */
let refocusTimer: ReturnType<typeof setTimeout> | null = null;

/** 子窗口关闭后：主窗口重新聚焦并滚动到当前选中项（删除窗口与图片查看器一致） */
function refocusList() {
  if (!isTauri()) return;

  // 防抖：删除窗口关闭时 yes/no/closed 会触发多次，
  // 每次 refocusList 又产生 3 次延时聚焦，会形成 PostMessage 消息风暴
  // （WebView2 报 0x80070718 配额不足）。合并为一次执行。
  if (refocusTimer) clearTimeout(refocusTimer);
  refocusTimer = setTimeout(() => {
    refocusTimer = null;

    // 与 ToggleWindowCommand（Ctrl+I 唤出窗口）相同的三层聚焦方案：
    // 窗口 setFocus + webview setFocus + JS window.focus + window-shown 事件。
    const restoreFocus = async () => {
      try {
        // 主窗口不可见（后台驻留隐藏中）时不 show，保持隐藏状态；
        // 可见时才聚焦
        const visible = await getCurrentWindow().isVisible();
        if (visible) {
          await getCurrentWindow().setFocus();
          try {
            await getCurrentWebview().setFocus();
          } catch (e) {
            console.warn('webview 聚焦失败:', e);
          }
        }
      } catch (e) {
        console.warn('主窗口聚焦失败:', e);
      }
      window.focus();
      if (await getCurrentWindow().isVisible().catch(() => false)) {
        window.dispatchEvent(new CustomEvent('window-shown'));
        searchInput.value?.focus();
      }
    };

    // 多重延时补偿：删除窗口完全销毁、webview 状态稳定后再聚焦
    setTimeout(() => restoreFocus(), 120);
    setTimeout(() => restoreFocus(), 320);
    setTimeout(() => restoreFocus(), 600);

    // 列表滚动到选中项
    setTimeout(() => {
      const listElement = document.querySelector('#listElement') as HTMLElement | null;
      const items = listElement?.querySelectorAll('.list-row');
      const current = items?.[selectedRowIndex.value] as HTMLElement | undefined;
      current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 120);
  }, 80);
}

function getFirstTwoLines(input: string): string {
  const lines = input.split('\n');
  if (lines.length === 0) {
    return '';
  }
  if ( lines.length === 1) {
    return lines[0] as string;
  }
  return lines[0] + '\n' + lines[1];
}

function handleDragStart(item: ClipboardData, event: DragEvent) {
  event.dataTransfer?.setData('text/plain', item.content);
}

function handleDragEnd(item: ClipboardData, event: DragEvent) {
  if (event.dataTransfer?.dropEffect === 'copy')
    clipboardService.increaseUseCount(item.id)
}

/** 唯一的图片查看器窗口 label（窗口关闭后置 null，复用单例） */
let viewerLabel: string | null = null;
/** 最近一次发送给查看器的图片数据（首次创建窗口 ready 后补发，避免创建期间双击丢失） */
let latestImagePayload: { images: string[]; index: number } | null = null;

/**
 * 双击图片项：在唯一的图片查看器窗口中查看。
 * - 查看器已存在 → 复用并切换图片；
 * - 查看器不存在 → 新建窗口。
 * 图片数据（base64 列表 + 当前序号）通过事件传递，避免超大 base64 触发 dev server 431 错误。
 * 窗口尺寸固定（不可调整），图片的缩放/旋转只在窗口内容区内进行。
 */
async function openImageViewer(item: ClipboardData) {
  if (item.type !== 'image' || !isTauri()) return;

  const images = data.value.filter((i: ClipboardData) => i.type === 'image');
  const index = Math.max(0, images.findIndex((i) => i.id === item.id));
  latestImagePayload = { images: images.map((i) => i.content), index };

  // 复用已存在的查看器窗口，直接切换图片
  if (viewerLabel) {
    const existing = await WebviewWindow.getByLabel(viewerLabel).catch(() => null);
    if (existing) {
      await emit('image-viewer:switch', { label: viewerLabel, ...latestImagePayload });
      return;
    }
    viewerLabel = null; // 窗口已销毁，走新建流程
  }

  const label = `image-viewer-${Date.now()}`;
  viewerLabel = label;
  // 标记子窗口正在打开，临时豁免主窗口的失焦自动隐藏（避免双击时主窗口被连带隐藏）
  (window as any).__childOpeningUntil = Date.now() + 600;
  const viewer = new WebviewWindow(label, {
    url: '/viewer',
    title: '图片查看器',
    width: 720,
    height: 540,
    resizable: false,
    decorations: false,
    transparent: true,
    skipTaskbar: true,
    center: true,
  });
  viewer.once('tauri://created', () => {
    console.log('查看器窗口创建成功:', label);
    // 窗口已创建，延长豁免期至其稳定聚焦，避免创建期间的失焦误触发隐藏
    (window as any).__childOpeningUntil = Date.now() + 400;
    // 主窗口置顶时同步让查看器窗口置顶，避免被置顶主窗口遮挡
    syncChildOnTop(viewer);
  });
  viewer.once('tauri://error', () => {
    console.error('查看器窗口创建失败:', label);
    if (viewerLabel === label) viewerLabel = null;
  });

  // 等待查看器窗口 ready 后补发最新图片数据，避免事件竞态与创建期间多次双击丢失
  const unlistenReady = await listen('image-viewer:ready', async (ev) => {
    const readyLabel = (ev.payload as string | undefined) ?? '';
    if (readyLabel && readyLabel !== label) return;
    if (latestImagePayload) {
      await emit('image-viewer:payload', { label, ...latestImagePayload });
    }
    unlistenReady();
  });
  // 兜底：窗口创建失败时自动清理监听，避免泄漏
  setTimeout(() => unlistenReady(), 5000);

  // 监听查看器窗口关闭，重置单例引用
  const unlistenClosed = await listen('image-viewer:closed', (ev) => {
    if ((ev.payload as string | undefined) === label && viewerLabel === label) {
      viewerLabel = null;
    }
    unlistenClosed();
  });
}

</script>

<template>
  <div class="min-h-full flex flex-col">
    <main class="flex-1 px-4 pb-12 pt-4">
      <div class="mx-auto max-w-6xl">
        <Transition name="page-curtain" mode="out-in">
          <div :key="activeTab">
            <!-- 剪贴板 -->
            <div v-if="activeTab === 'clip'" class="space-y-4">
              <!-- 常驻搜索框：始终悬浮在列表最上方 -->
              <div class="sticky top-0 z-30 -mx-4 bg-[linear-gradient(135deg,var(--bg-grad-1),var(--bg-grad-3))] px-4 pt-1 pb-2">
                <div class="glass-card flex items-center gap-2 rounded-2xl px-3 py-2 text-ink">
                  <svg
                      class="h-5 w-5 shrink-0 text-ink-faint"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      viewBox="0 0 24 24"
                  >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M21 21l-4.35-4.35m0 0A7.5 7.5 0 104.5 4.5a7.5 7.5 0 0012.15 12.15z"
                    />
                  </svg>
                  <input
                      ref="searchInput"
                      v-model="highlightContent"
                      type="text"
                      placeholder="输入以搜索 · ↑/↓ 选择 · Enter 粘贴"
                      class="w-full bg-transparent text-ink placeholder:text-ink-faint focus:outline-none"
                  />
                  <button
                      type="button"
                      class="btn-soft btn-circle p-0 ml-1"
                      title="高亮匹配"
                      @click="highlightState = !highlightState"
                  >
                    <svg v-if="highlightState" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 6h16M4 12h16M4 18h10" />
                    </svg>
                    <svg v-else class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 6h10M4 12h16M4 18h16" />
                    </svg>
                  </button>
                  <button
                      type="button"
                      class="btn-soft btn-circle p-0 ml-1"
                      :class="filter.favorite === 1 ? 'text-gold bg-gold/15 border-gold/60' : 'text-ink-faint'"
                      :title="filter.favorite === 1 ? '仅显示收藏（点击取消）' : '仅显示收藏'"
                      @click="handelFilter"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 1059 1024" xmlns="http://www.w3.org/2000/svg">
                      <path d="M253.488042 1024c-16.9 0-33.2875-5.1125-47.6125-15.3625-26.625-18.425-39.425-49.6625-34.3125-81.925l40.9625-251.9c1.5375-10.2375-1.5375-20.475-8.7-27.65L28.213042 466.4375c-22.0125-22.525-29.1875-55.3-19.45-84.9875 9.725-29.7 35.325-51.2 66.05-55.8125l237.575-36.35c10.75-1.5375 19.4625-8.1875 24.0625-17.925L441.388042 48.125c13.825-29.7 42.5-48.125 75.2625-48.125s61.4375 18.4375 75.2625 48.125l104.45 223.2375c4.6125 9.725 13.825 16.375 24.0625 17.925L958.000542 325.625a82.355 82.355 0 0 1 66.05 55.8125c10.2375 29.7 2.5625 62.4625-19.45 84.9875l-175.625 180.7375c-7.1625 7.175-10.2375 17.925-8.7 27.65l40.9625 251.9c5.125 31.75-8.1875 63.4875-34.3 81.925-26.1125 18.4375-59.9 20.4875-88.0625 4.6125l-206.85-114.6875c-9.725-5.1125-20.9875-5.1125-30.7125 0l-207.3625 115.2c-12.8125 6.65-26.6375 10.2375-40.4625 10.2375zM516.650542 51.2c-12.8 0-23.55 7.1625-29.1875 18.4375L383.525542 292.875c-11.775 25.0875-35.325 43.0125-62.975 47.1l-237.575 36.35c-12.2875 2.05-21.5 9.7375-25.6 21.5-4.1 11.775-1.025 24.0625 7.665 32.775L240.688042 611.325c18.4375 18.95 26.625 45.5625 22.525 71.675L222.250542 934.9125c-2.05 12.8 3.075 24.575 13.3125 31.7775 10.2375 7.175 23.0375 7.6875 33.7875 1.5375l207.3625-115.2c25.0875-13.825 55.3-13.825 80.3875 0l207.3625 115.2c10.75 6.1375 23.55 5.625 33.8-1.5375 10.2375-7.1625 15.3625-18.95 13.3125-31.7375L770.625542 683.0125c-4.1-26.1125 4.1-52.7375 22.525-71.675l175.625-180.7375c8.7-8.7 11.2625-20.9875 7.675-32.775-4.0875-11.775-13.3125-19.9625-25.6-21.5l-237.5625-36.35c-27.65-4.0875-51.2-22.0125-62.975-47.1L545.838042 69.6375c-5.625-11.2625-16.375-18.4375-29.1875-18.4375z m0 0" fill="currentColor"></path>
                    </svg>
                  </button>
                  <button
                      type="button"
                      class="btn-soft btn-circle p-0 ml-1"
                      :class="filter.type === 'image' ? 'text-gold bg-gold/15 border-gold/60' : 'text-ink-faint'"
                      :title="filter.type === 'image' ? '仅显示图片（点击取消）' : '仅显示图片'"
                      @click="handelTypeFilter"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                  </button>
                  <button
                      type="button"
                      class="btn-soft btn-circle p-0 ml-1"
                      title="清空搜索"
                      @click="highlightContent = ''"
                  >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 筛选状态提示条：当前处于"仅图片/仅收藏"筛选时显示，点击 ✕ 取消筛选 -->
              <div
                  v-if="filter.favorite === 1 || filter.type === 'image'"
                  class="flex items-center justify-between rounded-2xl border border-gold/50 bg-gold/10 px-3 py-1.5 text-xs text-gold"
              >
                <span>
                  已筛选：{{ filter.type === 'image' ? '仅显示图片' : '' }}{{ filter.type === 'image' && filter.favorite === 1 ? ' + ' : '' }}{{ filter.favorite === 1 ? '仅显示收藏' : '' }}
                </span>
                <button
                    type="button"
                    class="flex h-5 w-5 items-center justify-center rounded-full text-gold transition-colors hover:bg-gold/20"
                    title="取消全部筛选"
                    @click="filter.favorite = 0; filter.type = 'all'"
                >
                  <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <ul
                ref="listElement"
                id="listElement"
                class="list space-y-2 rounded-2xl outline-none"
                tabindex="0"
              >
                <li
                  class="glass-card list-row cursor-pointer rounded-2xl p-4 transition-all duration-300 ease-soft hover:-translate-y-0.5 hover:shadow-float"
                  v-for="(item, index) in data"
                  :key="item.id"
                  :class="{ 'border-gold ring-1 ring-gold/60': index === getSelectedRowIndex() }"
                  draggable="true"
                  @dragstart="handleDragStart(item, $event)"
                  @dragend="handleDragEnd(item,$event)"
                  @click="selectRow(index)"
                  @dblclick="openImageViewer(item)"
                >
                  <div class="text-4xl font-thin opacity-30 tabular-nums">{{ index + 1 }}</div>
                  <div class="list-col-grow flex min-w-0 flex-col">
                    <div class="relative min-h-0 overflow-hidden" @mouseenter="showTooltip(index, item, $event)" @mouseleave="hideTooltip">
                      <!-- 图片条目 -->
                      <img
                        v-if="item.type === 'image'"
                        :src="item.content"
                        alt="clipboard image"
                        class="max-h-[3.6em] max-w-[6em] rounded-md object-contain"
                      />
                      <!-- 文本条目 -->
                      <span
                        v-else
                        class="tabular-nums overflow-hidden text-ellipsis break-words whitespace-pre-wrap p-[3px]"
                        style="display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2"
                      >
                        <HighlightText
                          :text="getFirstTwoLines(item.content)"
                          :highlightString="highlightContent"
                          :active="highlightState"
                        />
                      </span>
                    </div>
                    <!-- 基础信息固定显示在容器最后一行 -->
                    <div class="mt-1 shrink-0 text-xs uppercase font-semibold opacity-60 text-ink-soft">
                      {{ item.type === 'image' ? '图片' : '文本' }}
                      创建时间{{ formatDate(parseInt(item.created_at)) }}
                      使用次数:{{ item.count }}
                      最后使用:{{ formatDate(parseInt(item.updated_at)) }}
                    </div>
                  </div>
                  <button class="btn-soft btn-circle p-2" @click="favorite(item.id,item.is_favorite)">
                    <svg v-if="item.is_favorite===0" class="size-[1.2em]" viewBox="0 0 1059 1024" xmlns="http://www.w3.org/2000/svg">
                      <path d="M253.488042 1024c-16.9 0-33.2875-5.1125-47.6125-15.3625-26.625-18.425-39.425-49.6625-34.3125-81.925l40.9625-251.9c1.5375-10.2375-1.5375-20.475-8.7-27.65L28.213042 466.4375c-22.0125-22.525-29.1875-55.3-19.45-84.9875 9.725-29.7 35.325-51.2 66.05-55.8125l237.575-36.35c10.75-1.5375 19.4625-8.1875 24.0625-17.925L441.388042 48.125c13.825-29.7 42.5-48.125 75.2625-48.125s61.4375 18.4375 75.2625 48.125l104.45 223.2375c4.6125 9.725 13.825 16.375 24.0625 17.925L958.000542 325.625a82.355 82.355 0 0 1 66.05 55.8125c10.2375 29.7 2.5625 62.4625-19.45 84.9875l-175.625 180.7375c-7.1625 7.175-10.2375 17.925-8.7 27.65l40.9625 251.9c5.125 31.75-8.1875 63.4875-34.3 81.925-26.1125 18.4375-59.9 20.4875-88.0625 4.6125l-206.85-114.6875c-9.725-5.1125-20.9875-5.1125-30.7125 0l-207.3625 115.2c-12.8125 6.65-26.6375 10.2375-40.4625 10.2375zM516.650542 51.2c-12.8 0-23.55 7.1625-29.1875 18.4375L383.525542 292.875c-11.775 25.0875-35.325 43.0125-62.975 47.1l-237.575 36.35c-12.2875 2.05-21.5 9.7375-25.6 21.5-4.1 11.775-1.025 24.0625 7.665 32.775L240.688042 611.325c18.4375 18.95 26.625 45.5625 22.525 71.675L222.250542 934.9125c-2.05 12.8 3.075 24.575 13.3125 31.7775 10.2375 7.175 23.0375 7.6875 33.7875 1.5375l207.3625-115.2c25.0875-13.825 55.3-13.825 80.3875 0l207.3625 115.2c10.75 6.1375 23.55 5.625 33.8-1.5375 10.2375-7.1625 15.3625-18.95 13.3125-31.7375L770.625542 683.0125c-4.1-26.1125 4.1-52.7375 22.525-71.675l175.625-180.7375c8.7-8.7 11.2625-20.9875 7.675-32.775-4.0875-11.775-13.3125-19.9625-25.6-21.5l-237.5625-36.35c-27.65-4.0875-51.2-22.0125-62.975-47.1L545.838042 69.6375c-5.625-11.2625-16.375-18.4375-29.1875-18.4375z m0 0" fill="currentColor"></path>
                    </svg>
                    <svg v-else class="size-[1.2em]" viewBox="0 0 1426 1024" xmlns="http://www.w3.org/2000/svg">
                      <path d="M985.6 1022.976c-14.848 0-31.744-4.096-47.104-12.288L716.288 899.584l-223.744 111.104c-14.336 7.68-30.208 11.776-47.104 11.776-21.504 0-42.496-6.656-59.392-19.456-31.232-23.552-47.104-64-39.936-101.376l45.568-237.056-175.616-163.328c-27.136-27.648-37.376-67.072-27.136-104.448l0.512-1.024c12.8-38.4 44.544-65.024 82.944-70.144l243.712-44.544L625.152 58.88C642.56 23.552 678.4 1.024 716.288 1.024c39.424 0 76.288 23.552 91.648 58.368l109.056 221.696 243.712 42.496c38.4 5.632 70.656 33.28 81.408 71.168 12.288 36.864 2.048 77.312-25.6 104.96l-0.512 0.512-174.592 164.864 44.032 237.568c7.168 37.888-8.192 76.288-39.424 100.352-17.92 12.8-38.912 19.968-60.416 19.968z" fill="#c4a77d"></path>
                    </svg>
                  </button>
                  <button class="btn-soft btn-circle p-2 text-[rgba(176,92,92,1)]" @click="handleDelete(item)">
                    <svg class="size-[1.2em]" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" p-id="4580">
                      <path d="M254.398526 804.702412l-0.030699-4.787026C254.367827 801.546535 254.380106 803.13573 254.398526 804.702412zM614.190939 259.036661c-22.116717 0-40.047088 17.910928-40.047088 40.047088l0.37146 502.160911c0 22.097274 17.930371 40.048111 40.047088 40.048111s40.048111-17.950837 40.048111-40.048111l-0.350994-502.160911C654.259516 276.948613 636.328122 259.036661 614.190939 259.036661zM893.234259 140.105968l-318.891887 0.148379-0.178055-41.407062c0-22.13616-17.933441-40.048111-40.067554-40.048111-7.294127 0-14.126742 1.958608-20.017916 5.364171-5.894244-3.405563-12.729929-5.364171-20.031219-5.364171-22.115694 0-40.047088 17.911952-40.047088 40.048111l0.188288 41.463344-230.115981 0.106424c-3.228531-0.839111-6.613628-1.287319-10.104125-1.287319-3.502777 0-6.89913 0.452301-10.136871 1.296529l-73.067132 0.033769c-22.115694 0-40.048111 17.950837-40.048111 40.047088 0 22.13616 17.931395 40.048111 40.048111 40.048111l43.176358-0.020466 0.292666 617.902982 0.059352 0 0 42.551118c0 44.233434 35.862789 80.095199 80.095199 80.095199l40.048111 0 0 0.302899 440.523085-0.25685 0-0.046049 40.048111 0c43.663452 0 79.146595-34.95 80.054267-78.395488l-0.329505-583.369468c0-22.135136-17.930371-40.047088-40.048111-40.047088-22.115694 0-40.047088 17.911952-40.047088 40.047088l0.287549 509.324054c-1.407046 60.314691-18.594497 71.367421-79.993892 71.367421l41.575908 1.022283-454.442096 0.26606 52.398394-1.288343c-62.715367 0-79.305207-11.522428-80.0645-75.308173l0.493234 76.611865-0.543376 0-0.313132-660.818397 236.82273-0.109494c1.173732 0.103354 2.360767 0.166799 3.561106 0.166799 1.215688 0 2.416026-0.063445 3.604084-0.169869l32.639375-0.01535c1.25355 0.118704 2.521426 0.185218 3.805676 0.185218 1.299599 0 2.582825-0.067538 3.851725-0.188288l354.913289-0.163729c22.115694 0 40.050158-17.911952 40.050158-40.047088C933.283394 158.01792 915.349953 140.105968 893.234259 140.105968zM774.928806 815.294654l0.036839 65.715701-0.459464 0L774.928806 815.294654zM413.953452 259.036661c-22.116717 0-40.048111 17.910928-40.048111 40.047088l0.37146 502.160911c0 22.097274 17.931395 40.048111 40.049135 40.048111 22.115694 0 40.047088-17.950837 40.047088-40.048111l-0.37146-502.160911C454.00054 276.948613 436.069145 259.036661 413.953452 259.036661z" fill="currentColor" p-id="4581"></path>
                    </svg>
                  </button>
                </li>
              </ul>
            </div>

            <!-- 待办 -->
            <TodoList v-else-if="activeTab === 'todo'" />

            <!-- 便签 -->
            <StickyNote v-else-if="activeTab === 'note'" />

            <!-- 设置 -->
            <SettingMain v-else-if="activeTab === 'setting'" />
          </div>
        </Transition>
      </div>
    </main>
  </div>
</template>
