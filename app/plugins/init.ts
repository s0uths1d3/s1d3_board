import {TrayIcon} from '@tauri-apps/api/tray';
import {Image} from '@tauri-apps/api/image';
import {invoke} from '@tauri-apps/api/core';
import {resolveResource} from '@tauri-apps/api/path';
import {WebviewWindow} from '@tauri-apps/api/webviewWindow';
import {getCurrentWindow} from "@tauri-apps/api/window";
import {listen} from '@tauri-apps/api/event';
import {isTauri} from "~/utils/env";
import statsService from "~/src/statistics/statsService";
import { ensurePrivacyLoaded, isPrivacyPaused, setPrivacyPaused } from "~/composables/usePrivacySettings";
import {bus} from "~/src/core/events";
import {closeTooltipWindows} from "~/composables/useTooltipEnabled";
import { useI18n, initI18n } from "~/composables/useI18n";

// 托盘文案 i18n：initI18n 幂等（首次读持久化语言模式），模块加载即启动、菜单构建前 await 落定；
// 语言切换走 location.reload → 插件重跑 → 托盘菜单/悬浮提示自动跟随新语言
const i18nReady = initI18n().catch(() => {});

// ===== 自绘托盘菜单：原生菜单（Menu.new）由系统渲染，无法自定义配色/圆角/字体，
// 且 Windows SetPreferredAppMode 在 Win11 上经常不生效（菜单永远跟随系统深浅色）——
// 改为 tray-menu 无边框透明小窗口自绘（与主窗口同 token 样式，页面内 useColorScheme
// 主题实时跟随）。托盘 click → 显示窗口；点击菜单项 emit('tray-menu:action') →
// 主窗口执行动作（toggle/privacy/quit 的状态逻辑集中在主窗口，子窗口纯展示）。

/** 托盘菜单动作执行（主窗口侧） */
async function handleTrayAction(kind: string) {
    if (kind === 'toggle') {
        const main = await WebviewWindow.getByLabel('main');
        if (!main) return;
        if (await main.isVisible()) {
            // 主窗口收起前关闭 tooltip 子窗口：否则 tooltip 仍置顶残留在屏幕上
            await closeTooltipWindows().catch(() => {});
            await main.hide();
        } else {
            await main.show();
            // 等待窗口/WebView2 就绪后再聚焦，避免 SetFocus 报 0x80070057
            await new Promise(r => setTimeout(r, 50));
            await main.setFocus();
        }
    } else if (kind === 'privacy') {
        // 与设置页共用同一布尔设置；菜单勾选态由菜单窗口每次打开时现读
        await setPrivacyPaused(!isPrivacyPaused());
    } else if (kind === 'quit') {
        // 真正退出程序：直接结束进程（绕过主窗口 close 拦截——
        // 标题栏 x 已改为隐藏到托盘，托盘退出是唯一退出入口）。
        // process exit 不会触发 beforeunload 的统计落库，这里先手动 flush。
        try {
            await statsService.flush();
        } catch { /* 落库失败仍退出 */ }
        await invoke('quit_app');
    }
}

const TRAY_MENU_LABEL = 'tray-menu';
/** 窗口尺寸对齐系统托盘菜单量级（紧凑：行高 32px / 字号 13px），过大显得笨重；
 *  宽度预留英文长文案（如 "Pause clipboard recording"）不截断的余量 */
const TRAY_MENU_W = 248, TRAY_MENU_H = 118;

/** 托盘点击载荷（Rust on_tray_icon_event 转发；position=点击光标物理坐标，恒有效。
 *  实测部分 Windows 环境 event.rect 上报全 0，定位一律以光标为锚） */
interface TrayRectPayload {
    position: { x: number; y: number };
}

/** 显示自绘托盘菜单窗口（先定位后显示，避免闪现在默认位置）。
 *  toggle 语义与系统菜单一致：菜单已显示时再次点击托盘 = 收起 */
async function showTrayMenuWindow(event: TrayRectPayload) {
    const existing = await WebviewWindow.getByLabel(TRAY_MENU_LABEL).catch(() => null);
    if (existing && await existing.isVisible().catch(() => false)) {
        await existing.close().catch(() => { /* 关闭失败下次点击重建兜底 */ });
        return;
    }
    // close 后立即重建可能撞上销毁进行中：销毁是异步的，getByLabel 仍返回旧实例时
    // new 会报 label 冲突——稍等一拍让销毁落定
    if (existing) await new Promise(r => setTimeout(r, 120));
    let win = await WebviewWindow.getByLabel(TRAY_MENU_LABEL).catch(() => null);
    if (!win) {
        win = new WebviewWindow(TRAY_MENU_LABEL, {
            url: '/tray-menu',
            width: TRAY_MENU_W,
            height: TRAY_MENU_H,
            visible: false,      // 先隐藏创建：PhysicalPosition 定位完成后再显示
            resizable: false,
            decorations: false,  // 无原生窗口栏：页面自绘圆角卡片（同 note-colors 模式）
            transparent: true,   // 透明窗口：卡片自绘圆角，规避 Win11 系统圆角残角
            shadow: false,       // 关 DWM 阴影：无边框窗口阴影黑线难看，层次由卡片阴影承载
            skipTaskbar: true,
            alwaysOnTop: true,
            focus: true,         // 失焦自关依赖焦点
            maximizable: false,
            minimizable: false,
        });
        const created = await new Promise<boolean>((resolve) => {
            win!.once('tauri://created', () => resolve(true));
            win!.once('tauri://error', () => resolve(false));
        });
        if (!created) return;
    }
    try {
        // 定位：以点击光标为锚（托盘图标位置）——菜单弹在光标上方水平居中，
        // 上方放不下（顶部任务栏）→ 翻到光标下方；clamp 进显示器**工作区**
        // （workArea 已排除任务栏：clamp 到整屏会让菜单底边压进任务栏盖住托盘图标）
        const mon = await import('@tauri-apps/api/window').then(m => m.currentMonitor().catch(() => null));
        const cx = event.position.x, cy = event.position.y;
        const waX = mon?.workArea.position.x ?? 0, waY = mon?.workArea.position.y ?? 0;
        const waW = mon?.workArea.size.width ?? 1920, waH = mon?.workArea.size.height ?? 1080;
        const GAP = 14;
        const px = Math.min(Math.max(cx - Math.round(TRAY_MENU_W / 2), waX + GAP), waX + waW - TRAY_MENU_W - GAP);
        const aboveY = cy - GAP - TRAY_MENU_H;
        let py = aboveY >= waY ? aboveY : cy + GAP;
        py = Math.min(Math.max(py, waY + GAP), waY + waH - TRAY_MENU_H - GAP);
        const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
        await win.setPosition(new PhysicalPosition(px, py)).catch(() => {});
    } catch { /* 定位失败保持系统默认位置 */ }
    await win.show().catch(() => {});
    // 焦点可靠性：show 后立即 setFocus 在 Windows 上偶发静默失败——焦点从未建立
    // 会让菜单页的失焦自关永不触发（点击别处菜单不消失）。重试直到确认持焦
    for (let i = 0; i < 3; i++) {
        if (await win.isFocused().catch(() => false)) break;
        await win.setFocus().catch(() => {});
        await new Promise(r => setTimeout(r, 60));
    }
}

/** 托盘悬浮提示：隐私模式开启期间带状态后缀（持续可见提醒，防「忘记关闭」） */
async function refreshTrayTooltip() {
    if (!trayIconRef) return;
    const { t } = useI18n();
    await trayIconRef.setTooltip(isPrivacyPaused()
        ? `s1d3 board — ${t('tray.privacy_pause')}`
        : 's1d3 board').catch(() => { /* tooltip 失败不影响功能 */ });
}

/** 当前托盘实例（刷新 tooltip 时调用） */
let trayIconRef: TrayIcon | null = null;
/** 托盘固定 id：同一窗口多次执行插件（F5 / 语言切换 location.reload / dev HMR）时
 *  通过 getById 复用已有托盘，避免 TrayIcon.new 每次都新建一个托盘图标 */
const TRAY_ID = 'main-tray';

export default defineNuxtPlugin(async (nuxtApp) => {
    // 托盘图标 / 窗口 API 仅存在于 Tauri 桌面容器内，
    // 纯 Web dev server 下直接跳过，避免 Tauri API 缺失导致 H3Error。
    if (!isTauri()) {
        return;
    }
    // 只在主窗口创建托盘图标，避免子窗口（查看器/删除确认）重复创建多个托盘
    if (getCurrentWindow().label !== 'main') {
        return;
    }

    // 隐私开关状态落定后再创建托盘（悬浮提示后缀读取该状态；失败按默认关闭处理）
    await ensurePrivacyLoaded().catch(() => {});

    // 隐私模式开关变化（设置页/托盘菜单任一入口）→ 刷新悬浮提示状态后缀
    // （自绘菜单的勾选态由菜单窗口每次打开时现读，无需事件联动）
    bus.on('privacy-pause-changed', () => {
        void refreshTrayTooltip();
    });

    try {
        // 复用检查：窗口 reload / dev HMR 会让插件重新执行，TrayIcon.new 每次都会
        // 新建一个托盘图标（旧的不随窗口销毁），导致托盘区图标累积。已有同 id
        // 托盘时直接复用并刷新提示，跳过创建。
        const existing = await TrayIcon.getById(TRAY_ID);
        if (existing) {
            trayIconRef = existing;
            void refreshTrayTooltip();
            return;
        }

        // 图标：通过 resolveResource 解析打包资源（bundle.resources 已配置 icons/icon_256x256.ico）
        // 获得绝对路径，再用 Image.fromPath 加载。不能直接传相对路径（运行时无法解析）。
        const iconPath = await resolveResource('icons/icon_256x256.ico');
        const trayIcon = await Image.fromPath(iconPath);

        const { t } = useI18n();
        const options = {
            id: TRAY_ID,
            title: 's1d3 board',
            tooltip: isPrivacyPaused() ? `s1d3 board — ${t('tray.privacy_pause')}` : 's1d3 board',
            icon: trayIcon,
        };
        trayIconRef = await TrayIcon.new(options);

        // 托盘点击（Rust on_tray_icon_event 转发）：弹出自绘菜单窗口
        //（原生 Menu 已弃用——无法自定义配色且不随应用主题）
        await listen<TrayRectPayload>('tray-click', (e) => {
            void showTrayMenuWindow(e.payload);
        });
        // 菜单项动作由 tray-menu 子窗口派发、本窗口执行
        await listen<string>('tray-menu:action', (e) => {
            void handleTrayAction(e.payload);
        });

        console.log('Tray icon created successfully');
        await getCurrentWindow().setIcon(trayIcon);
    } catch (error) {
        console.error('Error initializing tray:', error);
    }
});
