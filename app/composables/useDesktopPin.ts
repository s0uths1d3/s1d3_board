/**
 * 桌面便签窗口（note-pin）创建与定位工具
 *
 * 「拖出钉桌」跟随动画与工具栏「钉到桌面」按钮共用：
 * - openDesktopPin：创建便签的桌签窗（每条便签独立窗口，label = note-pin-{id}，
 *   已存在则复用引用）；落点 = 光标处 + 级联偏移
 * - showDesktopPin：显示桌签窗（不抢主窗口焦点）
 * - followDesktopPin：桌签窗中心对齐光标实时跟随——「拖出钉桌」的转移动画本体：
 *   光标出主窗口后 webview 无法渲染，由真实窗口接管跟随视觉（物理像素直传
 *   setPosition，无单位换算问题）
 *
 * 单位换算：WindowOptions.x/y 为逻辑像素（window.d.ts 明确注释），cursorPosition
 * 为物理像素，按光标所在显示器 scaleFactor 换算（DPI 缩放下否则落点偏移）
 */
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { PhysicalPosition, cursorPosition, monitorFromPoint, primaryMonitor, getAllWindows } from '@tauri-apps/api/window'
import { isTauri } from '~/utils/env'

/** 桌签窗口默认逻辑尺寸（与创建 options 一致，跟随居中换算用） */
export const DESKTOP_PIN_SIZE = { width: 280, height: 240 }

/** 跟随态逻辑尺寸：迷你横条（对齐主窗口幽灵卡样式），定格后恢复 DESKTOP_PIN_SIZE */
export const DESKTOP_PIN_FOLLOW_SIZE = { width: 248, height: 56 }

/** 光标物理坐标 → 逻辑坐标（按光标所在显示器 scaleFactor 换算） */
export async function cursorLogical(): Promise<{ x: number; y: number } | null> {
  const cursor = await cursorPosition().catch(() => null)
  if (!cursor) return null
  let scaleFactor = 1
  try {
    scaleFactor = (await monitorFromPoint(cursor.x, cursor.y).catch(() => null))?.scaleFactor
        ?? (await primaryMonitor().catch(() => null))?.scaleFactor ?? 1
  } catch { scaleFactor = 1 }
  return { x: Math.round(cursor.x / scaleFactor), y: Math.round(cursor.y / scaleFactor) }
}

/** 桌签窗跟随态登记（主窗口内存）：true=跟随中 / false=已转正 / 删除=已关闭。
 *  页面 ready 可能晚于转正事件（快速松手），show 时据此补发跟随态同步 */
const followStates = new Map<string, boolean>()

export function setDesktopPinFollowState(id: string, state: boolean | null): void {
  if (state === null) followStates.delete(id)
  else followStates.set(id, state)
}

/** 桌签窗「页面就绪」监听（主窗口侧，模块加载即注册一次）：所有桌签窗以隐藏
 *  创建，页面渲染完成（透明背景 + 内容就绪）后广播 ready，此处才 show——
 *  加载期的任何默认底色/米色帧都不可见，根治「贴边拖动时主窗口外闪现
 *  背景色实底小窗」（SPA 下 useHead 内联透明插入时机仍晚于全局背景 CSS 首绘） */
let readyListenerStarted = false
async function initDesktopPinReadyListener(): Promise<void> {
  if (readyListenerStarted || !isTauri()) return
  readyListenerStarted = true
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    if (getCurrentWindow().label !== 'main') return // 仅主窗口负责 show
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    await listen<string>('note-pin-ready', async (e) => {
      const id = e.payload
      // show() 会激活子窗、主窗口瞬间失焦：刷新失焦取消/自动隐藏豁免，防拖动被误判打断
      ;(window as any).__childOpeningUntil = Date.now() + 600
      const win = await WebviewWindow.getByLabel(`note-pin-${id}`).catch(() => null)
      if (!win) return // 已取消/销毁：忽略
      // 转正早于页面 ready（快速松手）：页面停在跟随横条态，补发退出跟随同步
      if (followStates.get(id) === false) void win.emit('note-pin-follow', false).catch(() => {})
      void win.show().catch(() => {})
      void win.setSkipTaskbar(true).catch(() => {})
      // 焦点立即归还主窗口：show 激活子窗 → 主窗口 webview 失焦 → 浏览器暂停鼠标
      // 事件派发 → 拖出钉桌按住中松手的 pointerup 丢失（跟随窗永远停在跟随态）。
      // 归还后事件流恢复，dragUpHandler 才能收到松手；~几十 ms 的焦点抖动无感
      void getCurrentWindow().setFocus().catch(() => {})
    })
  } catch { readyListenerStarted = false }
}
void initDesktopPinReadyListener()

/** 创建（或复用）便签的桌签窗；created 后 resolve（error 时 resolve null）。
 *  所有桌签窗一律隐藏创建（visible 恒 false），页面 ready 后由主窗口 show——
 *  加载期底色帧不可见。following=true：跟随模式——初始尺寸即迷你横条、落点
 *  精确在光标处（级联偏移只服务于工具栏多条钉桌）、URL 带 following=1 让页面
 *  首帧即渲染跟随横条（事件先于页面 listen 建立发送会丢失，query 兜底） */
export async function openDesktopPin(id: string, opts?: { following?: boolean }): Promise<WebviewWindow | null> {
  if (!isTauri()) return null
  const label = `note-pin-${id}`
  const existing = await WebviewWindow.getByLabel(label).catch(() => null)
  if (existing) return existing
  const size = opts?.following ? DESKTOP_PIN_FOLLOW_SIZE : DESKTOP_PIN_SIZE
  const pos = await cursorLogical()
  const options: Record<string, unknown> = {
    url: opts?.following ? `/note-pin/${id}?following=1` : `/note-pin/${id}`,
    width: size.width,
    height: size.height,
    minWidth: 200,
    minHeight: 140,
    visible: false,       // 隐藏创建：页面 ready 后由主窗口 show（加载期底色不可见）
    resizable: true,
    decorations: false,   // 无原生窗口栏：页面自绘卡片与拖动把手（同 note-colors 模式）
    transparent: true,
    backgroundColor: [0, 0, 0, 0], // WebView2 默认背景透明：HTML 加载前不闪白/米色实底
    shadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,    // 桌面便签常驻置顶
    focus: false,         // 被动查看窗口：创建不抢主窗口焦点
  }
  if (pos) {
    if (opts?.following) {
      options.x = pos.x
      options.y = pos.y
    } else {
      const pinnedCount = (await getAllWindows().catch(() => []))
          .filter(w => w.label.startsWith('note-pin-')).length
      options.x = pos.x + pinnedCount * 28
      options.y = pos.y + pinnedCount * 28
    }
  }
  const win = new WebviewWindow(label, options as any)
  return await new Promise<WebviewWindow | null>((resolve) => {
    win.once('tauri://created', () => resolve(win))
    win.once('tauri://error', () => resolve(null))
  })
}

/** 显示桌签窗（不抢主窗口焦点；重复调用幂等） */
export async function showDesktopPin(win: WebviewWindow): Promise<void> {
  void win.show().catch(() => {})
  void win.setSkipTaskbar(true).catch(() => {})
}

/** 跟随态尺寸切换：迷你横条（拖动中，对齐幽灵卡）/ 桌签完整尺寸（定格） */
export async function setDesktopPinFollowing(win: WebviewWindow, following: boolean): Promise<void> {
  const { LogicalSize } = await import('@tauri-apps/api/dpi')
  const s = following ? DESKTOP_PIN_FOLLOW_SIZE : DESKTOP_PIN_SIZE
  void win.setSize(new LogicalSize(s.width, s.height)).catch(() => {})
}

/** 桌签窗中心对齐光标实时跟随（物理像素直传；sf 由调用方缓存，避免每帧查询显示器；
 *  size 为当前窗口逻辑尺寸——跟随态迷你横条与定格态完整卡片不同） */
export async function followDesktopPin(
    win: WebviewWindow,
    cursor: { x: number; y: number },
    sf = 1,
    size: { width: number; height: number } = DESKTOP_PIN_SIZE,
): Promise<void> {
  const halfW = Math.round(size.width * sf / 2)
  const halfH = Math.round(size.height * sf / 2)
  void win.setPosition(new PhysicalPosition(Math.round(cursor.x - halfW), Math.round(cursor.y - halfH))).catch(() => {})
}
