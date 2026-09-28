<script setup lang="ts">
/**
 * 自绘托盘菜单页（/tray-menu）
 *
 * Windows 原生托盘菜单由系统渲染，无法自定义配色/圆角/字体，且 SetPreferredAppMode
 * 在 Win11 上经常不生效（菜单永远跟随系统深浅色）——改为无边框透明小窗口自绘菜单：
 * 样式与主窗口同 token（bg-surface / hover:bg-secondary / 圆角描边），配色随
 * useColorScheme（<html data-scheme>）实时跟随应用主题。
 *
 * 窗口由主窗口 init.ts 在托盘 click 时创建/定位/显示；本页只做展示与意图派发：
 * 点击项 emit('tray-menu:action') → 主窗口 listen 执行（toggle/privacy/quit 的
 * 状态逻辑集中在主窗口，子窗口不直接操作其他窗口与全局设置）。
 * 失焦自关（popup 语义）；ESC 关闭；打开时现读隐私模式勾选态。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { emit } from '@tauri-apps/api/event'
import { useColorScheme } from '~/composables/useColorScheme'
import { useI18n, initI18n } from '~/composables/useI18n'
import { ensurePrivacyLoaded, isPrivacyPaused } from '~/composables/usePrivacySettings'
import { useTransparentWindow } from '~/composables/useTransparentWindow'
import { isTauri } from '~/utils/env'

const { t } = useI18n()
// 弹出卡片沿用全局配色主题（<html data-scheme> 换肤对本窗口同样生效）
useColorScheme()

/** 隐私模式勾选态（打开时从持久化拉平——子窗口模块级 ref 初始值不可信） */
const privacy = ref(false)

type MenuAction = 'toggle' | 'privacy' | 'quit'

const items = ref<{ kind: MenuAction; label: string; checked?: boolean }[]>([])

/** 常规项（toggle/privacy）；quit 危险项由模板在分隔线后单独渲染 */
function buildItems() {
  items.value = [
    { kind: 'toggle', label: t('tray.toggle') },
    { kind: 'privacy', label: t('tray.privacy_pause'), checked: privacy.value },
  ]
}

onMounted(async () => {
  // 透明窗口：去除全局 body 渐变与光晕，避免自绘卡片圆角外露实底「白角」
  useTransparentWindow()
  // 语言与隐私态都需要从持久化拉平：子窗口是新 webview，模块级状态全新
  await initI18n().catch(() => {})
  await ensurePrivacyLoaded().catch(() => {})
  privacy.value = isPrivacyPaused()
  buildItems()
  startFocusWatcher()
  startFocusGuard()
})

/** 点击菜单项：派发意图给主窗口执行，随即收起（菜单语义：点一项即走） */
async function act(kind: MenuAction) {
  await emit('tray-menu:action', kind).catch(() => {})
  await closeWindow()
}

async function closeWindow() {
  await getCurrentWebviewWindow().close().catch(() => {})
}

/** 失焦自关：popup 语义（点击卡片外任意位置收起）。
 *  延迟启用——窗口创建初期存在 focus false→true 的过渡事件序列，立即监听会误关 */
let focusUnlisten: (() => void) | null = null
async function startFocusWatcher() {
  if (!isTauri()) return
  setTimeout(async () => {
    try {
      focusUnlisten = await getCurrentWebviewWindow().onFocusChanged((focused) => {
        if (!focused) void closeWindow()
      })
    } catch { /* 监听失败仅损失失焦自关，不影响功能 */ }
  }, 500)
}

/** 关闭守卫（轮询，对 Windows 前台锁定免疫）。
 *  实测点托盘图标时 Explorer 是前台进程，setFocus 被 Windows 前台锁定机制
 *  静默拒绝——菜单窗口从未持焦，onFocusChanged 的 blur 永不触发，菜单残留不关。
 *  轮询 isFocused 覆盖两条路径：
 *  1. 焦点正常：曾持焦 → 检测到失焦 → 关（等同系统菜单「点外即关」）
 *  2. 前台锁定：从未持焦 → 显示 6s 后兜底自动收起（防残留） */
let pollTimer: number | null = null
let everFocused = false
const openedAt = Date.now()
function startFocusGuard() {
  pollTimer = window.setInterval(async () => {
    const focused = await getCurrentWebviewWindow().isFocused().catch(() => false)
    if (focused) {
      everFocused = true
    } else if (everFocused && Date.now() - openedAt > 800) {
      // 曾持焦后失焦：点击了菜单外 → 收起（系统语义）。
      // 800ms 启动宽限：弹出瞬间焦点序列会闪一次 false→true→false，立即判定会误关
      void closeWindow()
    } else if (Date.now() - openedAt > 6000) {
      // 从未持焦（前台锁定）：超时兜底收起
      void closeWindow()
    }
  }, 300)
}

/** ESC 关窗 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') void closeWindow()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  focusUnlisten?.()
  if (pollTimer !== null) window.clearInterval(pollTimer)
})
</script>

<template>
  <!-- 透明窗口内自绘圆角卡片：外层留白给阴影/圆角，卡片承担视觉层次 -->
  <div class="flex min-h-screen items-start justify-center p-1">
    <div class="flex w-full flex-col rounded-lg border border-accent/60 bg-surface p-1 shadow-2xl menu-pop">
      <button
          v-for="item in items" :key="item.kind"
          type="button"
          class="flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink transition-colors hover:bg-secondary"
          @click="act(item.kind)"
      >
        <!-- 行图标：眼睛（显示/隐藏）/ 盾牌（隐私）/ 电源（退出） -->
        <svg v-if="item.kind === 'toggle'" class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <svg v-else-if="item.kind === 'privacy'" class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
        </svg>
        <svg v-else class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
        </svg>

        <!-- :title 兜底：文案超宽被 truncate 时悬停可看完整内容 -->
        <span class="min-w-0 flex-1 truncate" :title="item.label">{{ item.label }}</span>

        <!-- 隐私模式勾选态：金色对勾（与主窗口开关选中色一致） -->
        <svg v-if="item.checked" class="h-3.5 w-3.5 shrink-0 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>

      <!-- 退出前分隔线：危险操作与常规操作隔开 -->
      <div class="mx-1.5 my-0.5 border-t border-accent/40" />
      <button
          type="button"
          class="flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-danger transition-colors hover:bg-danger/10"
          @click="act('quit')"
      >
        <svg class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
        </svg>
        <span class="flex-1 truncate">{{ t('tray.quit') }}</span>
      </button>
    </div>
  </div>
</template>

<style>
/* dev 模式下 Nuxt DevTools / Vite overlay 会注入到每个页面的 document，
   透明悬浮窗必须隐藏（黑色锚球污染菜单视觉，生产构建无此项）——同 bubble.vue 处理 */
#nuxt-devtools-container,
[id^="nuxt-devtools"],
.vite-error-overlay,
vue-devtools-anchor {
  display: none !important;
}

/* 透明窗口的 body 置透明处理统一由 useTransparentWindow composable 注入
   （去除全局 body 渐变与光晕，视觉层次完全由卡片圆角+描边+阴影承载） */

/* 弹出动效：与主窗口右键菜单同量级的缩放浮现 */
.menu-pop {
  animation: tray-menu-pop 0.16s ease-out;
  transform-origin: bottom center;
}
@keyframes tray-menu-pop {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
