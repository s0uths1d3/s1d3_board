<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen, emit } from '@tauri-apps/api/event';
import { isTauri } from '~/src/utils/env';

const itemType = ref<'text' | 'image' | 'category' | 'todo' | ''>('');
const confirmBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let unlistenFocus: (() => void) | null = null;
/** 启动保护期：避免窗口刚创建时的短暂失焦误触发自动关闭 */
let focusGuard: ReturnType<typeof setTimeout> | null = null;
/** 当前聚焦的按钮：confirm（删除） / cancel（取消） */
let focusedAction: 'confirm' | 'cancel' = 'confirm';

/** 聚焦指定按钮并更新内部状态 */
function focusAction(action: 'confirm' | 'cancel') {
  focusedAction = action;
  (action === 'confirm' ? confirmBtn.value : cancelBtn.value)?.focus();
}

/** 左右箭头切换焦点；循环切换 */
function moveFocus(direction: -1 | 1) {
  const order: ('confirm' | 'cancel')[] = ['confirm', 'cancel'];
  const idx = order.indexOf(focusedAction);
  const next = (idx + direction + order.length) % order.length;
  focusAction(order[next]!);
}

/** 本窗口 label（防多删除窗口事件串扰） */
let myLabel = '';

async function doDelete() {
  focusedAction = 'confirm';
  // 通知主窗口：确认删除（由主窗口执行删除、刷新列表并恢复焦点/局部快捷键）
  // 主窗口 refocusList 有多重延时聚焦，无需本窗口跨窗口操作主窗口（避免 PostMessage 队列风暴）
  await emit('delete-confirm:yes', myLabel).catch(() => {});
  getCurrentWindow().close();
}

async function cancelDelete() {
  focusedAction = 'cancel';
  await emit('delete-confirm:no', myLabel).catch(() => {});
  getCurrentWindow().close();
}

onMounted(async () => {
  if (!isTauri()) return;
  myLabel = getCurrentWindow().label;

  // 键盘：Enter 执行当前聚焦按钮 / Esc 取消 / ←→ 切换按钮焦点
  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // 按当前聚焦的按钮执行：焦点在「删除」→ 删除；焦点在「取消」→ 取消
      if (focusedAction === 'cancel') {
        cancelDelete();
      } else {
        doDelete();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelDelete();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocus(1);
    }
  };
  window.addEventListener('keydown', keyHandler);

  // 窗口打开后聚焦"删除"按钮（焦点即用即删，回车即可确认）
  await nextTick();
  setTimeout(() => focusAction('confirm'), 100);

  // 接收主窗口传来的待删除项类型（仅用于显示；不展示内容本身）
  await listen('delete-confirm:payload', (ev) => {
    const payload = ev.payload as { label?: string; type?: 'text' | 'image' | 'category' | 'todo' } | undefined;
    if (payload && typeof payload === 'object' && payload.label && payload.label !== myLabel) return;
    itemType.value = payload?.type ?? '';
  });

  await emit('delete-confirm:ready', myLabel);

  // 失焦自动关闭：窗口失去焦点即关闭（带启动保护期）
  const win = getCurrentWindow();
  focusGuard = setTimeout(() => { focusGuard = null; }, 400);
  unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
    if (focusGuard) return;
    if (!focused) getCurrentWindow().close();
  });
});

onBeforeUnmount(() => {
  if (keyHandler) window.removeEventListener('keydown', keyHandler);
  if (unlistenFocus) unlistenFocus();
  // 无论何种方式关闭（确认/取消/失焦），都通知主窗口释放单例并聚焦回列表
  // 窗口销毁后异步 emit 可能丢失，改为同步等待发送完成
  if (isTauri()) {
    try {
      emit('delete-confirm:closed', myLabel);
    } catch { /* 窗口已销毁，主窗口兜底处理 */ }
  }
});
</script>

<template>
  <div class="delete-root">
    <div class="glass-card flex w-[400px] max-w-[90vw] flex-col items-center rounded-2xl p-6 shadow-float">
      <div class="mb-4 flex w-full items-start gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
             class="mt-1 h-6 w-6 shrink-0 text-gold">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div class="flex-1 font-bold text-ink">
          确定要删除{{ itemType === 'image' ? '该图片' : itemType === 'category' ? '该分类' : itemType === 'todo' ? '该任务' : '该项' }}吗？
        </div>
      </div>
      <div class="flex w-full justify-center gap-4">
        <button ref="cancelBtn" class="btn-soft" tabindex="-1" v-tip="'取消 (Esc)'" @click="cancelDelete">取消</button>
        <button ref="confirmBtn" class="btn-gold" tabindex="-1" v-tip="'删除 (Enter)'" @click="doDelete">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delete-root {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与主窗口一致的暖色渐变 */
  background: linear-gradient(135deg, #faf6f2 0%, #f5ede4 50%, #ebe0d4 100%);
  border-radius: 1rem;
}
/* 键盘操作时可见的焦点环 */
.delete-root button:focus-visible {
  outline: 2px solid #c4a77d;
  outline-offset: 2px;
}
</style>
