<script setup lang="ts">
/**
 * 共享删除确认框（DeleteConfirm）
 *
 * 与便签（StickyNote）删除确认一致的样式与操作方式：
 * - 暖色 glass-card 卡片 + 金色感叹号 + 「取消/确定」按钮
 * - 就近定位：跟随触发元素（anchor），视口边界自适应，不遮挡被删项
 * - 键盘：Enter 确认 / Esc 取消 / ←→ 或 Tab 切换按钮焦点
 *
 * 通过 Teleport 挂到 body，避免被调用方容器裁切。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from '~/composables/useI18n'

const { t } = useI18n()

const props = defineProps<{
  visible: boolean
  message?: string
  /** 触发删除按钮在视口内的位置（DOMRect）；缺省时屏幕居中 */
  anchor?: DOMRect | null
}>()

// prop 默认值会被编译提升到 setup() 外部，无法引用局部 t，
// 故改用 computed 提供缺省文案
const displayMessage = computed(() => props.message ?? t('common.deleteConfirm'))

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const okBtn = ref<HTMLButtonElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const style = ref<Record<string, string>>({})
let focusedAction: 'confirm' | 'cancel' = 'confirm'
let keyHandler: ((e: KeyboardEvent) => void) | null = null

const W = 400
const H = 160
const GAP = 12

function computeStyle(anchor?: DOMRect | null) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!anchor) {
    style.value = {
      left: `${Math.max(8, (vw - W) / 2)}px`,
      top: `${Math.max(8, (vh - H) / 2)}px`,
    }
    return
  }
  let left = anchor.right + GAP
  if (left + W > vw - 8) left = Math.max(8, anchor.left - W - GAP)
  let top = anchor.top
  if (top + H > vh - 8) top = Math.max(8, anchor.bottom - H - GAP)
  style.value = { left: `${left}px`, top: `${top}px` }
}

function focusAction(action: 'confirm' | 'cancel') {
  focusedAction = action
  ;(action === 'confirm' ? okBtn.value : cancelBtn.value)?.focus()
}

watch(
    () => props.visible,
    (v) => {
      if (v) {
        computeStyle(props.anchor)
        nextTick(() => focusAction('confirm'))
        keyHandler = (e: KeyboardEvent) => {
          // capture 阶段 + stopImmediatePropagation：
          // 确认框打开时键盘操作优先由确认框处理，抢在 ShortcutManager 的
          // Enter(paste)/Delete 等局部快捷键之前，避免粘贴命令隐藏主窗口或确认无反应。
          const intercepted = ['Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Delete', 'Backspace'].includes(e.key)
          if (intercepted) {
            e.preventDefault()
            e.stopImmediatePropagation()
          }
          if (e.key === 'Enter') {
            if (focusedAction === 'cancel') emit('cancel')
            else emit('confirm')
          } else if (e.key === 'Escape') {
            emit('cancel')
          } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) {
            focusAction(focusedAction === 'confirm' ? 'cancel' : 'confirm')
          }
          // Delete/Backspace：已拦截，不触发删除动作（避免误删列表项）
        }
        // capture 阶段监听：在 ShortcutManager（bubble 阶段）之前处理键盘
        window.addEventListener('keydown', keyHandler, true)
      } else {
        if (keyHandler) window.removeEventListener('keydown', keyHandler, true)
        keyHandler = null
      }
    },
    // immediate：允许以 visible=true 挂载（此时 watch 也会注册键盘监听并计算定位），
    // 否则初始即打开时确认框落到文档流默认位置且键盘无响应
    { immediate: true },
)

onBeforeUnmount(() => {
  if (keyHandler) window.removeEventListener('keydown', keyHandler, true)
})
</script>

<template>
  <Teleport to="body">
    <div
        v-if="visible"
        role="alert"
        class="glass-card fixed z-50 flex w-[400px] max-w-[90vw] flex-col items-center rounded-2xl p-6 shadow-float"
        :style="style"
    >
      <div class="mb-4 flex w-full items-start gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
             class="mt-1 h-6 w-6 shrink-0 text-gold">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <div class="flex-1 font-bold text-ink">{{ displayMessage }}</div>
      </div>
      <div class="flex w-full justify-center gap-4">
        <button ref="cancelBtn" type="button" class="btn-soft outline-none focus:ring-2 focus:ring-gold/60"
                @click="emit('cancel')">{{ t('common.cancel') }}</button>
        <button ref="okBtn" type="button" class="btn-gold outline-none focus:ring-2 focus:ring-gold/60"
                @click="emit('confirm')">{{ t('common.confirm') }}</button>
      </div>
    </div>
  </Teleport>
</template>
