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
import ContextMenu from '~/components/mainpage/ContextMenu.vue'
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

const { lastDueDate, recentDueDates, renames, defaultRenames, hiddenDurations, hiddenDates, customDurations, customDates, groups, visibleGroups, expandedGroupId, groupItems, nameOf, defaultNameOf, isDefaultHidden, groupOf, isExpanded, remember, removeHistory, rename, renameDefault, hideDefault, addToGroup, removeFromGroup, createGroup, renameGroup, deleteGroup, restoreGroup, setExpandedGroup } = useDueDateMemory()

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
const dateOptionsBase = [
  { key: 'today', label: '今天 23:59', compute: () => atTime(new Date(), 23, 59) },
  { key: 'tomorrow', label: '明天', compute: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d } },
  { key: 'dayAfter', label: '后天', compute: () => { const d = new Date(); d.setDate(d.getDate() + 2); return d } },
  { key: 'nextWeek', label: '下周', compute: () => { const d = new Date(); d.setDate(d.getDate() + 7); return d } },
]

/** 常用时长快捷项（相对当前时刻） */
const durationOptionsBase = [
  { key: '10m', label: '10 分钟后', compute: () => new Date(Date.now() + 10 * 60_000) },
  { key: '30m', label: '30 分钟后', compute: () => new Date(Date.now() + 30 * 60_000) },
  { key: '1h', label: '1 小时后', compute: () => new Date(Date.now() + 60 * 60_000) },
  { key: '2h', label: '2 小时后', compute: () => new Date(Date.now() + 2 * 60 * 60_000) },
  { key: '3h', label: '3 小时后', compute: () => new Date(Date.now() + 3 * 60 * 60_000) },
]

/** 显示用默认项（过滤已被删除/隐藏的项；label 含自定义别名，如「别名称 + 原标签」） */
const dateOptions = computed(() =>
  dateOptionsBase
    .filter(o => !isDefaultHidden(o.key, 'date'))
    .map(o => ({ ...o, label: defaultNameOf(o.key) ? `${defaultNameOf(o.key)} ${o.label}` : o.label })),
)

const durationOptions = computed(() =>
  durationOptionsBase
    .filter(o => !isDefaultHidden(o.key, 'duration'))
    .map(o => ({ ...o, label: defaultNameOf(o.key) ? `${defaultNameOf(o.key)} ${o.label}` : o.label })),
)

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

/** 列表项显示文本：有自定义名称则「名称 + 时间」，否则仅时间 */
const labelOf = (iso: string): string => {
  const name = nameOf(iso)
  return name ? `${name} ${display(iso)}` : display(iso)
}

/** 上次选择：最近一次且与当前值不同才展示（一键复用） */
const lastOption = computed(() => {
  const v = lastDueDate.value
  if (!v || v === props.modelValue) return null
  const d = new Date(v)
  if (isNaN(d.getTime())) return null
  return { value: v, label: labelOf(v) }
})

/** 之前选择：最近 MAX 条历史（新的在前），剔除当前已选值与非法值 */
const recentOptions = computed(() =>
  recentDueDates.value
    .filter(v => v !== props.modelValue && !isNaN(new Date(v).getTime()))
    .map(v => ({ value: v, label: labelOf(v) })),
)

/** 自定义固定到常用时长/常用日期分组的时间（ISO，显示重命名+时间） */
const customDurationOptions = computed(() =>
  customDurations.value
    .filter(v => !isNaN(new Date(v).getTime()))
    .map(v => ({ value: v, label: labelOf(v) })),
)
const customDateOptions = computed(() =>
  customDates.value
    .filter(v => !isNaN(new Date(v).getTime()))
    .map(v => ({ value: v, label: labelOf(v) })),
)

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
    // 视口上下空间均不足时钳制上边界，避免面板顶出屏幕外
    if (top < MARGIN) top = MARGIN
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

/** 各分组的展开状态：{ 分组id: 是否展开 }；打开面板时按默认展开分组初始化 */
const groupOpen = ref<Record<string, boolean>>({})

/** 初始化展开状态：默认展开分组展开，其余折叠 */
const initGroupOpen = () => {
  const map: Record<string, boolean> = {}
  for (const g of visibleGroups.value) map[g.id] = isExpanded(g.id)
  groupOpen.value = map
}

/** 点击分组标题：切换展开/折叠 */
const toggleGroup = (id: string) => {
  groupOpen.value = { ...groupOpen.value, [id]: !groupOpen.value[id] }
}

/** 打开面板时按默认展开分组重置展开状态 */
watch(open, (v) => {
  if (v) initGroupOpen()
})

// ===== 右键时间项：重命名 / 添加至分组 / 删除 =====
const ctxVisible = ref(false)
const ctxX = ref(0)
const ctxY = ref(0)
const ctxValue = ref('')              // ISO 时间或默认项 key
const ctxGroupId = ref('')            // 当前项所在分组 id（'recent'/'duration'/'date'/自定义 id）
const ctxIsDefault = ref(false)       // 是否为默认项（10 分钟后/明天等固定项）

/** 打开历史/自定义项右键菜单 */
const openCtxMenu = (value: string, groupId: string, e: MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
  ctxValue.value = value
  ctxGroupId.value = groupId
  ctxIsDefault.value = false
  ctxX.value = e.clientX
  ctxY.value = e.clientY
  ctxVisible.value = true
}

/** 打开默认项右键菜单（重命名/添加到其他分组/删除隐藏） */
const openDefaultCtxMenu = (key: string, group: 'duration' | 'date', e: MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
  ctxValue.value = key
  ctxGroupId.value = group
  ctxIsDefault.value = true
  ctxX.value = e.clientX
  ctxY.value = e.clientY
  ctxVisible.value = true
}

const closeCtxMenu = () => {
  ctxVisible.value = false
}

/** 重命名输入：当前正在编辑的标识（ISO 或默认项 key，null 表示不在编辑） */
const renameDraft = ref('')
const renamingValue = ref<string | null>(null)
const renameInputRef = ref<HTMLInputElement | null>(null)

const startRename = () => {
  renamingValue.value = ctxValue.value
  renameDraft.value = ctxIsDefault.value ? defaultNameOf(ctxValue.value) : nameOf(ctxValue.value)
  ctxVisible.value = false
  nextTick(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  })
}

const confirmRename = () => {
  if (renamingValue.value) {
    if (ctxIsDefault.value) void renameDefault(renamingValue.value, renameDraft.value)
    else void rename(renamingValue.value, renameDraft.value)
  }
  renamingValue.value = null
  renameDraft.value = ''
}

const cancelRename = () => {
  renamingValue.value = null
  renameDraft.value = ''
}

/** 删除当前右键项：默认项持久化隐藏；历史/自定义项从历史删除 */
const deleteCtxItem = () => {
  if (ctxIsDefault.value) {
    void hideDefault(ctxValue.value, ctxGroupId.value as 'duration' | 'date')
  } else {
    void removeHistory(ctxValue.value)
  }
}

/** 默认项：取当前 key 的快捷项计算出的实际时间 ISO */
const isoOfDefaultKey = (key: string, group: 'duration' | 'date'): string => {
  const base = (group === 'duration' ? durationOptionsBase : dateOptionsBase).find(o => o.key === key)
  return base ? toISO(base.compute()) : ''
}

/** 把当前右键项添加到指定分组 */
const addCtxToGroup = (groupId: string) => {
  const iso = ctxIsDefault.value ? isoOfDefaultKey(ctxValue.value, ctxGroupId.value as 'duration' | 'date') : ctxValue.value
  if (iso) void addToGroup(iso, groupId)
}

const ctxMenuItems = computed(() => {
  // 可添加的目标分组：除当前所在分组外的所有可见分组
  const targetGroups = visibleGroups.value.filter(g => g.id !== ctxGroupId.value)
  if (ctxIsDefault.value) {
    const addItems = targetGroups.map(g => ({
      label: `添加到 ${g.name}`,
      action: () => addCtxToGroup(g.id),
    }))
    return [
      { label: '重命名', action: startRename },
      ...addItems,
      { label: '删除', danger: true, action: deleteCtxItem },
    ]
  }
  const isCustomGroup = ctxGroupId.value !== 'recent'
  const addItems = targetGroups.map(g => ({
    label: `添加到 ${g.name}`,
    action: () => addCtxToGroup(g.id),
  }))
  return [
    { label: '重命名', action: startRename },
    ...addItems,
    ...(isCustomGroup
      ? [{ label: '从分组移除', action: () => { void removeFromGroup(ctxValue.value, ctxGroupId.value) } }]
      : []),
    { label: '删除', danger: true, action: deleteCtxItem },
  ]
})

// ===== 右键分组标题：新增/重命名/设为展开/删除分组 =====
const groupCtxVisible = ref(false)
const groupCtxX = ref(0)
const groupCtxY = ref(0)
const groupCtxId = ref('')

const openGroupCtxMenu = (id: string, e: MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
  groupCtxId.value = id
  groupCtxX.value = e.clientX
  groupCtxY.value = e.clientY
  groupCtxVisible.value = true
}

const closeGroupCtxMenu = () => {
  groupCtxVisible.value = false
}

/** 分组重命名输入 */
const groupRenameDraft = ref('')
const groupRenamingId = ref<string | null>(null)
const groupRenameInputRef = ref<HTMLInputElement | null>(null)

/** 新增分组：输入名称创建空分组 */
const startCreateGroup = () => {
  closeGroupCtxMenu()
  groupRenamingId.value = '__new__'
  groupRenameDraft.value = ''
  nextTick(() => {
    groupRenameInputRef.value?.focus()
  })
}

const startRenameGroup = () => {
  const g = groupOf(groupCtxId.value)
  groupRenamingId.value = groupCtxId.value
  groupRenameDraft.value = g?.name ?? ''
  closeGroupCtxMenu()
  nextTick(() => {
    groupRenameInputRef.value?.focus()
    groupRenameInputRef.value?.select()
  })
}

/** 提交新建/重命名分组 */
const submitGroupName = () => {
  if (groupRenamingId.value === '__new__') {
    void createGroup(groupRenameDraft.value).then(() => initGroupOpen())
  } else if (groupRenamingId.value) {
    void renameGroup(groupRenamingId.value, groupRenameDraft.value)
  }
  groupRenamingId.value = null
  groupRenameDraft.value = ''
}

/** 设为默认展开（单选）：已是展开分组则取消 */
const toggleExpandedGroup = () => {
  const id = groupCtxId.value
  void setExpandedGroup(isExpanded(id) ? '' : id)
  closeGroupCtxMenu()
  initGroupOpen()
}

/** 删除分组 */
const deleteCtxGroup = () => {
  const id = groupCtxId.value
  void deleteGroup(id)
  closeGroupCtxMenu()
  initGroupOpen()
}

const groupCtxMenuItems = computed(() => {
  const g = groupOf(groupCtxId.value)
  if (!g) return []
  return [
    { label: '新增分组', action: startCreateGroup },
    { label: '重命名', action: startRenameGroup },
    { label: isExpanded(g.id) ? '取消默认展开' : '设为默认展开', action: toggleExpandedGroup },
    { label: g.builtin ? '删除分组（可恢复）' : '删除分组', danger: true, action: deleteCtxGroup },
  ]
})

/** 已删除的内置分组（供恢复） */
const deletedBuiltinGroups = computed(() => groups.value.filter(g => g.builtin && g.hidden))

/** 取消分组新建/重命名 */
const cancelGroupRename = () => {
  groupRenamingId.value = null
  groupRenameDraft.value = ''
}

/** 恢复所有已删除的内置分组 */
const restoreDeletedGroups = () => {
  for (const g of deletedBuiltinGroups.value) void restoreGroup(g.id)
  initGroupOpen()
}

/** 自定义分组的时间项（ISO → { value, label }） */
const customGroupOptions = (groupId: string) =>
  (groupItems.value[groupId] ?? [])
    .filter(v => !isNaN(new Date(v).getTime()))
    .map(v => ({ value: v, label: labelOf(v) }))

/** DatePicker 的最小日期：今天（YYYY-MM-DD 形式）。
 *  普通函数（而非无依赖 computed）：无响应式依赖的 computed 只求值一次，跨天运行后 min 停留旧日期 */
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

let initializingCustom = false

/** 点「选择具体日期…」：关闭当前下拉，预填（当前已有值优先，否则使用当前时间），编程打开 DatePicker 面板。
 *  时间部分默认取当前时分，避免每次都带上上次选择的历史时间。 */
const openCustom = () => {
  open.value = false
  initializingCustom = true
  const base = props.modelValue || toISO(new Date())
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
  // 右键菜单打开期间不关闭面板，避免菜单项点击被误判为外部点击
  if (ctxVisible.value || groupCtxVisible.value) return
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
  <div ref="rootEl" class="relative w-auto max-w-[13rem]">
    <label
      tabindex="0"
      class="flex w-full cursor-pointer items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-accent bg-surface-field px-3 py-2 text-sm transition-colors duration-300 ease-soft focus:border-gold focus:outline-none"
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
        :min="todayStr()"
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

          <!-- 分组循环：右键标题可新增/重命名/设为展开/删除分组 -->
          <template v-for="g in visibleGroups" :key="g.id">
            <li>
              <!-- 分组重命名输入态 -->
              <div v-if="groupRenamingId === g.id" class="flex items-center gap-1 px-1 py-1">
                <input
                  ref="groupRenameInputRef"
                  v-model="groupRenameDraft"
                  type="text"
                  maxlength="12"
                  placeholder="分组名称"
                  class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                  @keydown.enter.prevent="submitGroupName"
                  @keydown.esc.prevent="cancelGroupRename"
                  @click.stop
                />
                <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="submitGroupName">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                </button>
                <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelGroupRename">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <!-- 分组标题：点击展开/折叠，右键管理 -->
              <button
                v-else
                type="button"
                class="flex w-full items-center justify-between rounded-md px-2 pt-1.5 pb-0.5 text-xs text-ink-faint transition-colors hover:text-ink"
                @click.stop="toggleGroup(g.id)"
                @contextmenu.prevent="openGroupCtxMenu(g.id, $event)"
              >
                <span class="truncate">{{ g.name }}</span>
                <svg class="h-3 w-3 shrink-0 transition-transform duration-200" :class="{ 'rotate-180': groupOpen[g.id] }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </li>
            <template v-if="groupOpen[g.id]">
              <!-- 新增分组输入态 -->
              <li v-if="groupRenamingId === '__new__'" class="flex items-center gap-1 px-1 py-1">
                <input
                  ref="groupRenameInputRef"
                  v-model="groupRenameDraft"
                  type="text"
                  maxlength="12"
                  placeholder="新分组名称"
                  class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                  @keydown.enter.prevent="submitGroupName"
                  @keydown.esc.prevent="cancelGroupRename"
                  @click.stop
                />
                <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="submitGroupName">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                </button>
                <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelGroupRename">
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </li>

              <!-- 内置 recent：历史记录 -->
              <template v-if="g.id === 'recent'">
                <li v-for="opt in recentOptions" :key="opt.value">
                  <div v-if="renamingValue === opt.value" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(opt.value)"
                    @contextmenu.prevent="openCtxMenu(opt.value, g.id, $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
                <li v-if="!recentOptions.length" class="px-2 py-1 text-xs text-ink-faint">暂无历史记录</li>
              </template>

              <!-- 内置 duration：预设时长 + 自定义固定项 -->
              <template v-else-if="g.id === 'duration'">
                <li v-for="opt in durationOptions" :key="opt.key">
                  <div v-if="renamingValue === opt.key" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(toISO(opt.compute()))"
                    @contextmenu.prevent="openDefaultCtxMenu(opt.key, 'duration', $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
                <li v-for="opt in customDurationOptions" :key="opt.value">
                  <div v-if="renamingValue === opt.value" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(opt.value)"
                    @contextmenu.prevent="openCtxMenu(opt.value, g.id, $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
              </template>

              <!-- 内置 date：预设日期 + 自定义固定项 -->
              <template v-else-if="g.id === 'date'">
                <li v-for="opt in dateOptions" :key="opt.key">
                  <div v-if="renamingValue === opt.key" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(toISO(opt.compute()))"
                    @contextmenu.prevent="openDefaultCtxMenu(opt.key, 'date', $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
                <li v-for="opt in customDateOptions" :key="opt.value">
                  <div v-if="renamingValue === opt.value" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(opt.value)"
                    @contextmenu.prevent="openCtxMenu(opt.value, g.id, $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
              </template>

              <!-- 自定义分组：groupItems -->
              <template v-else>
                <li v-for="opt in customGroupOptions(g.id)" :key="opt.value">
                  <div v-if="renamingValue === opt.value" class="flex items-center gap-1 px-1 py-1">
                    <input
                      ref="renameInputRef"
                      v-model="renameDraft"
                      type="text"
                      maxlength="20"
                      placeholder="名称"
                      class="w-full min-w-0 rounded-md border border-accent bg-surface-field px-1.5 py-1 text-xs text-ink outline-none focus:border-gold"
                      @keydown.enter.prevent="confirmRename"
                      @keydown.esc.prevent="cancelRename"
                      @click.stop
                    />
                    <button type="button" v-tip="'确定'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="confirmRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                    </button>
                    <button type="button" v-tip="'取消'" class="btn-soft flex h-6 w-6 shrink-0 items-center justify-center p-0" @click.stop="cancelRename">
                      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                  </div>
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-secondary"
                    @click.stop="choose(opt.value)"
                    @contextmenu.prevent="openCtxMenu(opt.value, g.id, $event)"
                  >
                    {{ opt.label }}
                  </button>
                </li>
                <li v-if="!customGroupOptions(g.id).length" class="px-2 py-1 text-xs text-ink-faint">空分组，右键时间项可加入</li>
              </template>
            </template>
          </template>

          <!-- 已删除的内置分组：可恢复 -->
          <li v-if="deletedBuiltinGroups.length" class="border-t border-accent/60 pt-1">
            <button
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-xs text-ink-soft transition-colors hover:bg-secondary"
              @click.stop="restoreDeletedGroups"
            >
              恢复已删除分组
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
              class="w-full rounded-md px-2 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              @click.stop="clearValue"
            >
              清除截止时间
            </button>
          </li>
        </ul>
      </Transition>
    </Teleport>

    <!-- 右键时间项菜单：重命名 / 添加到分组 / 删除 -->
    <ContextMenu
        :visible="ctxVisible"
        :x="ctxX"
        :y="ctxY"
        :items="ctxMenuItems"
        @close="closeCtxMenu"
    />
    <!-- 右键分组标题菜单：新增 / 重命名 / 设为展开 / 删除分组 -->
    <ContextMenu
        :visible="groupCtxVisible"
        :x="groupCtxX"
        :y="groupCtxY"
        :items="groupCtxMenuItems"
        @close="closeGroupCtxMenu"
    />
  </div>
</template>
