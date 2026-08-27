<script setup lang="ts">
/**
 * 快捷截止时间选择（DueTimeSelect）
 *
 * 设计目标：用最少点击完成截止时间选择。
 * - 常用日期：今天 23:59 / 明天 / 后天 / 下周（一键套用）
 * - 常用时长：30 分钟后 / 1 小时后 / 3 小时后
 * - 上次选择：自动记忆用户上次选用的截止时间，一键复用
 * - 自定义：打开 DatePicker 选择具体日期 + 时间
 * - 清除：清空截止时间
 *
 * 下拉通过 <Teleport to="body"> 挂到 body 并用 fixed 定位，
 * 避免被调用方容器（典型场景：TodoList 新建表单的 overflow-hidden 折叠动画）裁切。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import DatePicker from '~/components/common/DatePicker.vue'
import { useDueDateMemory } from '~/composables/useDueDateMemory'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), {
  placeholder: '选择截止时间'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const { lastDueDate, remember } = useDueDateMemory()

const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)
const panelEl = ref<HTMLUListElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const PANEL_WIDTH = 208
const MARGIN = 8

const pad = (n: number) => String(n).padStart(2, '0')
const toISO = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/** 设到指定时分（用于"今天 23:59"等） */
function atTime(base: Date, h: number, m: number) {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d
}

/** 常用日期快捷项（基于当前日期，默认沿用当前时刻的时:分） */
const dateOptions = [
  { key: 'today', label: '今天 23:59', compute: () => atTime(new Date(), 23, 59) },
  { key: 'tomorrow', label: '明天', compute: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d } },
  { key: 'dayAfter', label: '后天', compute: () => { const d = new Date(); d.setDate(d.getDate() + 2); return d } },
  { key: 'nextWeek', label: '下周', compute: () => { const d = new Date(); d.setDate(d.getDate() + 7); return d } },
]

/** 常用时长快捷项（相对当前时刻） */
const durationOptions = [
  { key: '30m', label: '30 分钟后', compute: () => new Date(Date.now() + 30 * 60_000) },
  { key: '1h', label: '1 小时后', compute: () => new Date(Date.now() + 60 * 60_000) },
  { key: '3h', label: '3 小时后', compute: () => new Date(Date.now() + 3 * 60 * 60_000) },
]

/** 已选 / 上次选择的友好展示：今天/明天/后天/具体日期 */
const display = (iso: string): string => {
  if (!iso) return props.placeholder
  const d = new Date(iso)
  if (isNaN(d.getTime())) return props.placeholder
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const dayDiff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - todayStart) / 86_400_000,
  )
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (dayDiff === 0) return `今天 ${time}`
  if (dayDiff === 1) return `明天 ${time}`
  if (dayDiff === 2) return `后天 ${time}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

const triggerDisplay = computed(() => display(props.modelValue))

/** 上次选择：存在且与当前值不同才展示 */
const lastOption = computed(() => {
  const v = lastDueDate.value
  if (!v || v === props.modelValue) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return { value: v, label: display(v) }
})

/** 面板定位：与触发按钮左对齐；根据视口上下空间自动向下或向上展开，避免被窗口底部遮挡。
 *  同时记录展开方向，便于弹入动画从触发侧生长，避免"突然跳到上方"的突兀感。 */
function positionPanel() {
  if (!rootEl.value) return
  const rect = rootEl.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = rect.left
  if (left + PANEL_WIDTH > vw - MARGIN) left = Math.max(MARGIN, vw - PANEL_WIDTH - MARGIN)

  // 面板的实际高度优先以已渲染 DOM 测量；首次渲染前使用估算值
  const panelRect = panelEl.value?.getBoundingClientRect()
  const panelHeight = panelRect?.height ?? 248

  const spaceBelow = vh - rect.bottom - MARGIN
  const spaceAbove = rect.top - MARGIN

  let top: number
  let up = false
  if (spaceBelow >= panelHeight || spaceBelow >= spaceAbove) {
    top = rect.bottom + 4
  } else {
    top = rect.top - panelHeight - 4
    up = true
  }

  panelStyle.value = {
    left: `${left}px`,
    top: `${top}px`,
    width: `${PANEL_WIDTH}px`,
    '--pop-origin': up ? 'bottom' : 'top',
    '--pop-shift': up ? '-6px' : '6px',
  }
}

/** 选择一个快捷项：提交 + 记忆 + 关闭 */
const choose = (iso: string) => {
  emit('update:modelValue', iso)
  void remember(iso)
  open.value = false
}

const clearValue = () => {
  emit('update:modelValue', '')
  open.value = false
}

// ===== 自定义截止时间：关闭下拉，直接打开 DatePicker 面板 =====
const customValue = ref('')
const customPickerOpen = ref(false)

const fmtDateTimeLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/** DatePicker 的最小日期：今天（YYYY-MM-DD 形式） */
const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})

let initializingCustom = false

/** 点「选择具体日期…」：关闭当前下拉，预填（当前已有值优先，否则使用当前时间），编程打开 DatePicker 面板。
 *  时间部分默认取当前时分，避免每次都带上上次选择的历史时间。 */
const openCustom = () => {
  open.value = false
  initializingCustom = true
  const base = props.modelValue || fmtDateTimeLocal(new Date())
  customValue.value = base
  customPickerOpen.value = true
  nextTick(() => { initializingCustom = false })
}

/** DatePicker 选完确定 → customValue 更新 → 同步给父组件并记忆。
 *  注意：不要在回调里检查 customPickerOpen —— Vue 监听器异步刷新，
 *  点击「确定」时 close() 已同步把 customPickerOpen 置为 false，
 *  异步回调读到的是 false，会导致漏发。initializingCustom 已能挡住初始预填。 */
watch(customValue, (v) => {
  if (initializingCustom) return
  if (!v) return
  emit('update:modelValue', v)
  void remember(v)
  customPickerOpen.value = false
})

const onDocClick = (e: MouseEvent) => {
  const t = e.target as Node
  if (rootEl.value?.contains(t) || panelEl.value?.contains(t)) return
  if ((t as Element | null)?.closest?.('.picker-panel')) return
  open.value = false
}

watch(open, (v) => {
  if (v) {
    nextTick(positionPanel)
    window.addEventListener('resize', positionPanel)
    document.addEventListener('scroll', positionPanel, true)
    document.addEventListener('click', onDocClick)
  } else {
    window.removeEventListener('resize', positionPanel)
    document.removeEventListener('scroll', positionPanel, true)
    document.removeEventListener('click', onDocClick)
  }
})

onMounted(() => {
  if (open.value) positionPanel()
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', positionPanel)
  document.removeEventListener('scroll', positionPanel, true)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div ref="rootEl" class="relative w-48">
    <label
      tabindex="0"
      class="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
      :class="open ? 'border-gold' : ''"
      @click="open = !open"
      @keydown.enter.prevent="open = !open"
      @keydown.space.prevent="open = !open"
      @keydown.escape="open = false"
    >
      <span class="truncate" :class="modelValue ? 'text-ink' : 'text-ink-faint'">{{ triggerDisplay }}</span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg
          v-if="modelValue"
          class="h-3.5 w-3.5 text-ink-faint transition-colors hover:text-ink"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
          @click.stop="clearValue"
        >
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
        <svg class="h-4 w-4 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2v4m8-4v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
        </svg>
      </span>
    </label>

    <!-- 隐藏的 DatePicker 容器：仅作"面板"使用，由本组件编程控制开关 -->
    <DatePicker
        v-model="customValue"
        v-model:open="customPickerOpen"
        mode="datetime"
        :min="todayStr"
        :hide-trigger="true"
        :live-emit="false"
        style="position: absolute; inset: 0; opacity: 0; pointer-events: none;"
    />

    <Teleport to="body">
      <Transition name="check-pop">
        <ul
          v-if="open"
          ref="panelEl"
          class="glass-card fixed z-[9999] max-h-80 overflow-y-auto rounded-xl p-1.5 shadow-float"
          :style="panelStyle"
        >
          <!-- 上次选择：一键复用 -->
          <li v-if="lastOption">
            <button
              type="button"
              class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
              @click.stop="choose(lastOption!.value)"
            >
              <span class="truncate">上次选择</span>
              <span class="shrink-0 text-xs text-ink-faint">{{ lastOption!.label }}</span>
            </button>
          </li>

          <!-- 常用日期 -->
          <li class="px-2 pt-1.5 pb-0.5 text-xs text-ink-faint">常用日期</li>
          <li v-for="opt in dateOptions" :key="opt.key">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
              @click.stop="choose(toISO(opt.compute()))"
            >
              {{ opt.label }}
            </button>
          </li>

          <!-- 常用时长 -->
          <li class="px-2 pt-1.5 pb-0.5 text-xs text-ink-faint">常用时长</li>
          <li v-for="opt in durationOptions" :key="opt.key">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
              @click.stop="choose(toISO(opt.compute()))"
            >
              {{ opt.label }}
            </button>
          </li>

          <!-- 自定义 + 清除 -->
          <li class="mt-1 border-t border-accent/60 pt-1">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-gold transition-colors hover:bg-secondary"
              @click.stop="openCustom"
            >
              选择具体日期…
            </button>
          </li>
          <li v-if="modelValue">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-[rgba(176,92,92,1)] transition-colors hover:bg-[rgba(196,122,122,0.12)]"
              @click.stop="clearValue"
            >
              清除截止时间
            </button>
          </li>
        </ul>
      </Transition>
    </Teleport>
  </div>
</template>
