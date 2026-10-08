<template>
  <div class="flex h-screen flex-col overflow-hidden rounded-2xl">
    <!-- 图片查看器/tooltip/智能剪贴板气泡/灵动岛历史/便签配色卡片/自绘托盘菜单等子窗口不渲染主窗口的自定义 TitleBar
         （历史窗口为原生边框，自带标题栏与关闭按钮，不重复渲染导航与窗口控制） -->
    <TitleBar v-if="route.path !== '/viewer' && route.path !== '/tooltip' && route.path !== '/bubble' && route.path !== '/island-history' && route.path !== '/note-colors' && route.path !== '/tray-menu'" />
    <!-- 相对定位包裹层：自绘滚动条滑块（ScrollIndicator）按此定位，只覆盖滚动区、不含标题栏。
         #app-main 由原 flex 项降为层内 h-full，盒子尺寸与原先一致。 -->
    <div class="relative min-h-0 flex-1">
      <main id="app-main" class="h-full overflow-y-auto" :class="{ 'is-main-window': isMainWindow() }">
        <NuxtPage />
      </main>
      <!-- 自绘滚动条只服务主窗口：只有它会在长短不一的 Tab 内容间切换 -->
      <ScrollIndicator v-if="isMainWindow()" />
      <!-- 首次使用引导层：主窗口 KV 门控自动弹出，设置页可回看（子窗口不渲染） -->
      <OnboardingOverlay v-if="isMainWindow()" />
    </div>
  </div>
</template>

<script setup lang="ts">

import TitleBar from "~/components/mainpage/TitleBar.vue";
import ScrollIndicator from "~/components/mainpage/ScrollIndicator.vue";
import {isTauri} from "~/utils/env";
import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import statsService from "~/src/statistics/statsService";
import { savePopupLastPosition } from "~/composables/usePopupPosition";
import { ensureAutoHideLoaded, setupAutoHideOnBlur } from "~/composables/useAutoHide";
import { createAppRegistry, appContext } from "~/src/modules";

// Tauri 2.11 注入脚本缺陷补丁：unregisterListener 读本地表不判空
// （listeners[eventId].handlerId）——listen 返回后立即解绑（注册脚本经 webview eval
// 宏任务队列尚未执行）会抛 unhandled rejection，且中断 _unlisten 后续的 Rust 侧
// unlisten invoke 造成监听泄漏。覆写为容错版：崩溃时延迟到注册入表后重试本地清理，
// _unlisten 的 invoke 正常继续；注册先行时行为与原版完全一致。
// 存在性守卫：注入脚本未就绪时跳过（补丁失效但不影响应用启动）。
if (isTauri()) {
  const internals = (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ as {
    unregisterListener: (event: string, eventId: number) => void;
  } | undefined;
  if (internals && typeof internals.unregisterListener === 'function') {
    const origUnregisterListener = internals.unregisterListener.bind(internals);
    internals.unregisterListener = (event: string, eventId: number) => {
      try {
        origUnregisterListener(event, eventId);
      } catch {
        // 本地表尚无此 eventId（注册 eval 未执行）：延迟一帧重试本地清理
        setTimeout(() => {
          try { origUnregisterListener(event, eventId); } catch { /* 条目已被清理 */ }
        }, 0);
      }
    };
  }
}

/** 剪贴板监听与全局快捷键只需在主窗口注册一次；
 * 子窗口（如图片查看器）跳过，避免重复监听，以及关闭子窗口时误注销主窗口的全局快捷键。 */
function isMainWindow(): boolean {
  return !isTauri() || getCurrentWindow().label === 'main';
}

const route = useRoute();

/** 应用模块注册表（组合根装配；boot 按依赖拓扑序 init→start，shutdown 反序 stop→dispose） */
const registry = createAppRegistry();

onMounted(async () => {
  if (!isMainWindow()) return;

  // 模块引导（依赖声明固化原启动顺序硬约束）：
  // smart-clip 挂处理层监听 → clipboard 启动剪贴板监听器（不遗漏最早复制事件）→
  // island（消费 island:copy）→ statistics → todo-reminder → shortcuts。
  // 模块依赖 Tauri 插件，纯 Web 环境跳过引导。
  if (isTauri()) {
    await registry.boot(appContext);
  }

  // 失焦自动隐藏（后台驻留模式）——窗口生命周期行为，保留在 app.vue。
  // 开关持久化值先落定（默认开），避免首版启动瞬间失焦钩子读到默认值误隐藏
  await ensureAutoHideLoaded();
  await setupAutoHideOnBlur();

  // 退出前强制落库 pending（防崩溃/强制退出丢失当日未落库数据，§14.1.1）
  window.addEventListener('beforeunload', flushStatsOnExit);
  if (isTauri()) {
    getCurrentWindow().onCloseRequested(async (event) => {
      // 标题栏 x = 隐藏到托盘（不退出程序；退出请用托盘右键菜单的「退出」）。
      // 不复用 tryHideMainWindow：它带 viewer/置顶/tooltip 等豁免分支，
      // 显式点击 x 应无条件隐藏（含关闭查看器等子窗口）。
      // 统计先落库再隐藏（fire-and-forget 的 flush 会被窗口销毁中断，丢失当日数据）。
      // 注意此处不可 registry.shutdown()：窗口仅隐藏到托盘，模块须保持运行。
      event.preventDefault();
      try {
        await statsService.flush();
      } finally {
        try {
          const windows = await getAllWindows();
          for (const w of windows) {
            try {
              if (w.label === 'main') continue;
              // 灵动岛独立运行：主窗口隐藏到托盘后岛仍正常提供复制/粘贴反馈
              if (w.label === 'clipboard-bubble-island' || w.label === 'island-history') continue;
              if (await w.isVisible()) await w.close();
            } catch { /* 忽略单窗关闭失败 */ }
          }
          await savePopupLastPosition().catch(() => {});
        } finally {
          await getCurrentWindow().hide();
        }
      }
    });
  }
})

/** 退出前兜底落库（§14.1.1）：pending 未落库数据不丢失 */
async function flushStatsOnExit() {
  await statsService.flush();
}

onBeforeUnmount(async () => {
  if (!isMainWindow()) return;
  // 模块收尾：反拓扑序 stop（shortcuts 注销 → statistics 停跟踪落库 → clipboard 反挂监听）
  await registry.shutdown();
  window.removeEventListener('beforeunload', flushStatsOnExit);
});
</script>