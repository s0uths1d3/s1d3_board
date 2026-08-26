<script setup lang="ts">
/**
 * 快捷截止时间选择（DueTimeSelect）
 *
 * 用于待办截止时间：因为截止时间一般选"未来一小段时间"，
 * 所以不再使用完整的年-月-日 + 时-分选择器，而是提供若干相对当前时刻的快捷选项，
 * 天然满足"只能选未来时间"的校验。
 *
 * 下拉通过 <Teleport to="body"> 挂到 body 并用 fixed 定位，
 * 避免被调用方容器（典型场景：TodoList 新建表单的 overflow-hidden 折叠动画）裁切。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import DatePicker from '~/components/common/DatePicker.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
}>(), {
  placeholder: '选择截止时间'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const open = ref(false)
const rootEl = ref<HTMLDivElement | null>(null)
const panelEl = ref<HTMLUListElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const PANEL_WIDTH = 192 // w-48

const pad = (n: number) => String(n).padStart(2, '0')

/** 快捷选项：全部基于当前时刻计算，天然位于未来 */
const quickOptions = [
  { label: '30 分钟后', compute: () => new Date(Date.now() + 30 * 60_000) },
  { label: '1 小时后', compute: () => new Date(Date.now() + 60 * 60_000) },
  { label: '3 小时后', compute: () => new Date(Date.now() + 3 * 60 * 60_000) },
  {
    label: '今天结束',
    compute: () => {
      const d = new Date()
      d.setHours(23, 59, 0, 0)
      return d
    },
  },
  {
    label: '明天',
    compute: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      return d
    },
  },
  { label: '3 天后', compute: () => new Date(Date.now() + 3 * 24 * 60 * 60_000) },
]

const toISO = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/** 已选截止时间的友好展示：今天/明天/后天/具体日期 */
const display = computed(() => {
  if (!props.modelValue) return props.placeholder
  const d = new Date(props.modelValue)
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
})

/** 面板定位：与触发按钮左对齐，向下展开；视口右边界自适应。 */
function positionPanel() {
  if (!rootEl.value) return
  const rect = rootEl.value.getBoundingClientRect()
  const vw = window.innerWidth
  let left = rect.left
  if (left + PANEL_WIDTH > vw - 8) left = Math.max(8, vw - PANEL_WIDTH - 8)
  panelStyle.value = {
    left: `${left}px`,
    top: `${rect.bottom + 4}px`,
    width: `${PANEL_WIDTH}px`,
  }
}

const select = (opt: { compute: () => Date }) => {
  emit('update:modelValue', toISO(opt.compute()))
  open.value = false
}

const clearValue = () => {
  emit('update:modelValue', '')
  open.value = false
}

// ===== 自定义截止时间：关闭 DueTimeSelect 下拉，直接打开 DatePicker 面板 =====
const customValue = ref('')
/** DatePicker 面板开关（v-model:open 桥接） */
const customPickerOpen = ref(false)

const fmtDateTimeLocal = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

/** DatePicker 的最小日期：今天（YYYY-MM-DD 形式） */
const todayStr = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})

/** 进入自定义视图时是否正在预填初始值（用于抑制 watch 误触发） */
let initializingCustom = false

/** 点「自定义…」：关闭 DueTimeSelect 下拉，预填 1 小时后，编程打开 DatePicker 面板 */
const openCustom = () => {
  open.value = false
  initializingCustom = true
  customValue.value = fmtDateTimeLocal(new Date(Date.now() + 60 * 60_000))
  customPickerOpen.value = true
  nextTick(() => { initializingCustom = false })
}

/** DatePicker 选完确定 → customValue 更新 → 同步给父组件 */
watch(customValue, (v) => {
  if (initializingCustom) return
  if (!v) return
  if (!customPickerOpen.value) return
  emit('update:modelValue', v)
  customPickerOpen.value = false
})

// 点击组件/面板外部时关闭下拉。
// 注意：自定义视图中嵌入了 DatePicker（面板 Teleport 到 body），
// 点击 DatePicker 面板时不应当作"外部"关闭 DueTimeSelect。
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
    // capture 捕获所有祖先滚动，保证面板跟随按钮位置
    document.addEventListener('scroll', positionPanel, true)
    document.addEventListener('click', onDocClick)
  } else {
    // 注意：这里【不能】重置 customPickerOpen / customValue。
    // openCustom 里先 open=false 再 customPickerOpen=true，
    // 若在此处重置，会覆盖掉刚打开的 DatePicker 面板，导致"自定义"无反应。
    // customPickerOpen 由 DatePicker 的 v-model:open 自行同步（选完/外部点击 → emit update:open）。
    window.removeEventListener('resize', positionPanel)
    document.removeEventListener('scroll', positionPanel, true)
    document.removeEventListener('click', onDocClick)
  }
})

onMounted(() => {
  // 若初始已 open（不常见），补一次定位
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
      <span class="truncate" :class="modelValue ? 'text-ink' : 'text-ink-faint'">{{ display }}</span>
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

    <!-- 隐藏的 DatePicker 容器：仅作"面板"使用，由 DueTimeSelect 编程控制开关。
         用 inline style 强制 absolute+inset:0 覆盖触发按钮位置（DatePicker 根元素自带
         relative inline-block，Tailwind absolute 类与其冲突不可靠），opacity 0 + pointer-events:none
         不显示也不拦截点击，positionPanel 据此把面板定位到按钮下方。 -->
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
          class="glass-card fixed z-[9999] rounded-xl p-1 shadow-float"
          :style="panelStyle"
        >
          <li v-for="opt in quickOptions" :key="opt.label">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
              @click.stop="select(opt)"
            >
              {{ opt.label }}
            </button>
          </li>
          <li class="mt-1 border-t border-accent/60 pt-1">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-gold transition-colors hover:bg-secondary"
              @click.stop="openCustom"
            >
              自定义…
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
