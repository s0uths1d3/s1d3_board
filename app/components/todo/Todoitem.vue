<template>
  <div
      class="glass-card todo-item group rounded-2xl p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="selected ? '!border-gold ring-2 ring-gold/60 bg-gold/10 shadow-[0_0_22px_-2px_rgba(196,167,125,0.6)]' : ''"
      @click="$emit('select')"
  >
    <div class="p-0">
      <div class="flex items-start gap-3">
        <div class="pt-1">
          <label
              class="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-all duration-300 ease-soft hover:shadow-sm"
              :class="visualCompleted ? 'border-gold bg-gold hover:bg-gold-soft' : 'border-line bg-surface-field hover:border-gold hover:bg-secondary'"
              v-tip="t('common.markComplete')"
          >
            <input
                type="checkbox"
                :checked="visualCompleted"
                @change="$emit('toggle', todo.id)"
                class="sr-only"
            />
            <Transition name="check-pop">
              <svg
                  v-if="visualCompleted"
                  class="h-3 w-3 text-white"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  stroke-width="3"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"></path>
              </svg>
            </Transition>
          </label>
        </div>

        <div class="min-w-0 flex-1">
          <div class="mb-1 flex items-center gap-2">
            <h3
                class="truncate font-semibold text-ink"
                :class="{ 'text-ink-faint line-through': visualCompleted, 'text-danger': isOverdue && !visualCompleted }"
            >
              <HighlightText
                  :text="todo.title"
                  :highlight-string="highlightString"
                  :active="highlight"
              />
            </h3>

            <!-- 优先级徽章：等级色点 + 名称，颜色/数值一眼可辨（悬停显示数值档位） -->
            <span
                class="flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
                :style="{
                  backgroundColor: pLevel.color + '26',
                  color: pLevel.color,
                  border: `1px solid ${pLevel.color}59`,
                }"
                v-tip="t('todo.priorityBadge', { level: pLevel.level })"
            >
              <span class="h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: pLevel.color }" />
              {{ priorityName(pLevel) }}
            </span>

            <span class="rounded-full border border-accent px-2 py-0.5 text-xs text-ink-soft">
              {{ categoryName(todo.category) }}
            </span>

            <!-- 已逾期标签：截止时间已过。未完成=红色"已逾期"，已完成=金色"逾期完成" -->
            <span
                v-if="isOverdue"
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="overdueCompleted
                  ? 'bg-gold/20 text-gold'
                  : 'bg-[rgba(200,90,90,0.15)] text-danger'"
            >
              {{ overdueCompleted ? t('todo.overdueCompleted') : t('todo.overdue') }}
            </span>
          </div>

          <p
              v-if="todo.description"
              class="mb-2 text-sm text-ink-soft"
              :class="{ 'text-ink-faint line-through': visualCompleted, 'text-danger/85': isOverdue }"
          >
            <HighlightText
                :text="todo.description"
                :highlight-string="highlightString"
                :active="highlight"
            />
          </p>

          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3 text-xs text-ink-faint">
              <span>{{ formatDateLocalized(Number(todo.created_at) || 0)}}</span>
              <span
                  v-if="todo.dueDate"
                  class="flex items-center gap-1"
                  :class="{ 'text-danger': isOverdue && !visualCompleted }"
                  v-tip="t(isOverdue && !visualCompleted ? 'todo.overdue' : 'todo.dueTime')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 7v5l3 2"></path>
                  <circle cx="12" cy="12" r="9"></circle>
                </svg>
                {{ formatDueDate }}
              </span>
              <!-- 自定义提醒时刻：用户显式设置的闹钟时间也要在卡片上可见
                   （"指定时刻"规则显示最早一条的时间；百分比/提前分钟由截止时间推导，仅显示铃铛），
                   悬停查看全部规则明细 -->
              <span
                  v-if="remindRules.length"
                  class="flex items-center gap-1"
                  v-tip="remindRulesTip"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"></path>
                </svg>
                {{ customRemindAt }}
              </span>
            </div>

            <!-- 操作按钮区：relative z-10 提升 dropdown 下拉菜单的 stacking context，
                 避免被相邻的 glass-card（同样 backdrop-filter）覆盖造成"外层元素显示错误"。
                 默认隐藏（opacity-0），hover 卡片时显示。 -->
            <div class="relative z-10 ml-auto flex items-center gap-1 opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
              <button
                  @click="startEditing"
                  class="btn-soft flex h-8 w-8 items-center justify-center p-2"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                </svg>
              </button>

              <!-- 优先级选择：三层递减线表示高/中/低优先级 -->
              <UiDropdown align="center" :aria-label="t('todo.priority')" panel-class="glass-card menu w-max min-w-44 rounded-2xl p-2">
                <template #trigger>
                  <label class="btn-soft flex h-8 w-8 cursor-pointer items-center justify-center p-2">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h10M4 18h6"></path>
                    </svg>
                  </label>
                </template>
                <template #default="{ close }">
                  <ul class="menu max-h-60 w-full overflow-y-auto p-2">
                    <li v-for="p in priorityLevels" :key="p.level">
                      <a
                          @click="choosePriorityLevel(p.level, close)"
                          class="flex items-center gap-2 rounded-lg hover:bg-secondary"
                          :class="currentLevel === p.level ? 'bg-gold/20 font-semibold' : ''"
                      >
                        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: p.color }" />
                        <span class="flex-1 whitespace-nowrap">{{ priorityName(p) }}</span>
                        <span class="shrink-0 text-[10px] tabular-nums text-ink-faint">{{ p.level }}</span>
                      </a>
                    </li>
                  </ul>
                </template>
              </UiDropdown>

              <!-- 分类选择：标签图标 -->
              <UiDropdown align="center" :close-on-select="false" aria-label="分类" panel-class="glass-card menu w-max min-w-48 max-w-80 rounded-2xl p-2">
                <template #trigger>
                  <label class="btn-soft flex h-8 w-8 cursor-pointer items-center justify-center p-2">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path>
                    </svg>
                  </label>
                </template>
                <template #default="{ close }">
                  <ul class="menu p-2">
                    <li v-for="category in categories" :key="category">
                      <div class="flex w-full items-center rounded-lg hover:bg-secondary">
                        <a
                            @click="chooseCategory(category, close)"
                            class="flex-1 truncate whitespace-nowrap px-2 py-1"
                        >{{ categoryName(category) }}</a>
                        <button
                            type="button"
                            data-dd-keep-open
                            v-tip="t('common.deleteCategory')"
                            class="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                            @click.stop="onDeleteCategory(category, $event)"
                        >
                          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                               stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </li>
                    <li class="mt-1 border-t border-accent/60 pt-1" data-dd-keep-open>
                      <input
                          v-model="newCategory"
                          type="text"
                          :placeholder="t('todo.newCategoryPlaceholder')"
                          maxlength="10"
                          class="w-full rounded-lg border border-accent bg-surface-field px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                          @keydown.enter.prevent="addNewCategory(close)"
                      />
                    </li>
                  </ul>
                </template>
              </UiDropdown>

              <!-- 提醒设置：智能 / 多闹钟（百分比·提前分钟·指定时刻）/ 不提醒 -->
              <ReminderPicker
                  variant="icon"
                  :mode="currentMode"
                  :rules="rulesList"
                  :has-due="!!todo.dueDate"
                  :smart-hint="smartHint"
                  :disabled="reminderDisabled"
                  @update:mode="onReminderMode"
                  @update:rules="onReminderRules"
              />

              <!-- 删除按钮：红色垃圾桶 -->
              <button
                  @click="deleteTodo($event)"
                  class="btn-soft flex h-8 w-8 items-center justify-center p-2 text-danger hover:bg-danger/10"
              >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                    </svg>
                  </button>

                </div>
          </div>
        </div>
      </div>

    </div>
    <Transition name="edit-panel">
      <div v-if="isEditing" class="mt-4 rounded-xl bg-surface-field p-4">
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <input
                v-model="editTitle"
                :data-todo-edit-title="todo.id"
                type="text"
                class="min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
                :placeholder="t('todo.titlePlaceholder')"
                @keyup.enter="onTitleEnterSave"
            />
          <button
              type="button"
              v-tip="t('common.save')"
              @click="saveEdit"
              class="btn-gold flex h-9 w-9 shrink-0 items-center justify-center p-0"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 13l4 4L19 7"></path>
            </svg>
          </button>
          <button
              type="button"
              v-tip="t('common.cancel')"
              @click="cancelEdit"
              class="btn-soft flex h-9 w-9 shrink-0 items-center justify-center p-0"
          >
            <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12"></path>
            </svg>
          </button>
        </div>
        <textarea
            v-model="editDescription"
            class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-none"
            :placeholder="t('todo.descPlaceholder')"
            rows="2"
        ></textarea>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type {Todo} from "~/src/entities";
import { useI18n } from '~/composables/useI18n';
import HighlightText from "~/components/mainpage/HighlightText.vue";
import ReminderPicker from "~/components/todo/ReminderPicker.vue";
import type { ReminderRule } from "~/src/entities";
import { useFormatDate } from "~/composables/useFormatDate";
import { useNow } from "~/composables/useNow";
import { useTodoPriorities } from "~/composables/useTodoPriorities";
import { useDisplayNames } from "~/composables/useDisplayNames";

const { t } = useI18n();
const { priorityName, categoryName } = useDisplayNames();
const formatDateLocalized = useFormatDate();
import { describeSmartPlan } from "~/src/todo/reminderPolicy";
import { isTodoOverdue } from "~/src/todo/overdue";


const props = defineProps<{
  todo: Todo
  highlightString?: string
  highlight?: boolean
  /** 是否被方向键选中（高亮提示） */
  selected?: boolean
  /** 编辑触发信号：Ctrl+Enter 递增，为当前选中项进入编辑态 */
  editSignal?: number
}>()

const emit = defineEmits<{
  (e: 'toggle', id: string): void
  (e: 'update', id: string, updates: Partial<Todo>): void
  (e: 'delete', id: string, rect?: DOMRect): void
  (e: 'priority-level-change', id: string, level: number): void
  (e: 'category-change', id: string, category: string): void
  (e: 'reminder-change', id: string, mode: Todo['remindMode'], rules?: ReminderRule[]): void
  (e: 'category-delete', name: string, rect?: DOMRect): void
  (e: 'select'): void
}>()

const isEditing = ref(false)
const editTitle = ref('')
const editDescription = ref('')

/** Ctrl+Enter（editSignal 递增）：当前选中项进入编辑态并聚焦标题输入框；
 *  已在编辑态则保存（与"Enter 保存"语义一致）。 */
watch(() => props.editSignal, (signal, old) => {
  if (signal === undefined || signal === old) return
  if (!props.selected) return
  if (isEditing.value) {
    saveEdit()
    return
  }
  startEditing()
  nextTick(() => {
    const input = document.querySelector(`[data-todo-edit-title="${props.todo.id}"]`) as HTMLInputElement | null
    input?.focus()
    input?.select()
  })
})

/** 优先级徽章/快捷选择：数值等级系统（0-255），定义见 useTodoPriorities */
const { levels: priorityLevels, getLevelInfo } = useTodoPriorities()
const pLevel = computed(() => getLevelInfo(props.todo.priorityLevel))
const currentLevel = computed(() => pLevel.value.level)

const choosePriorityLevel = (level: number, close: () => void) => {
  emit('priority-level-change', props.todo.id, level)
  close()
}

/** 响应式当前时间，用于截止时间到达时自动刷新逾期状态 */
const now = useNow()

/** 分类由 useCategories 统一管理（支持用户自定义/删除） */
const { categories, addCategory, removeCategory } = useCategories()
const newCategory = ref('')

// 分类下拉：UiDropdown 统一管理开关（点击开/关、外部点击与 Escape 收起）

/** 选择分类后收起面板（close 由 UiDropdown 提供） */
const chooseCategory = (category: string, close: () => void) => {
  emit('category-change', props.todo.id, category)
  close()
}

/** 新增分类并立即应用到当前待办，成功后收起面板；失败（重名）保留输入便于改名重试 */
const addNewCategory = async (close: () => void) => {
  const name = newCategory.value.trim()
  if (!name) return
  const ok = await addCategory(name)
  if (ok) {
    emit('category-change', props.todo.id, name)
    close()
    newCategory.value = ''
  }
}

/** 删除分类：交由父组件弹确认窗口并持久化（附带触发位置，用于确认窗口就近定位） */
const onDeleteCategory = (name: string, e?: MouseEvent) => {
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null
  emit('category-delete', name, btn?.getBoundingClientRect())
}

// ===== 提醒设置（铃铛）：智能 / 多闹钟（百分比·提前分钟·指定时刻）/ 不提醒 =====
/** 当前生效模式：未设置（undefined）视为智能 */
const currentMode = computed<'smart' | 'off' | 'custom'>(() => props.todo.remindMode || 'smart')
/** 自定义闹钟规则列表（DB 读取时已折算旧 remindAt） */
const rulesList = computed<ReminderRule[]>(() => props.todo.remindRules ?? [])
/** 逾期/已完成的待办不再提供提醒设置 */
const reminderDisabled = computed(() => props.todo.completed === 1 || (isOverdue.value && !visualCompleted.value))
/** 智能策略摘要：直接消费 reminderPolicy 的分档实现，策略调整时提示自动跟随 */
const smartHint = computed(() => {
  if (!props.todo.dueDate) return t('todo.noDueSet')
  return describeSmartPlan(props.todo) || t('todo.noDueSet')
})

function onReminderMode(mode: 'smart' | 'off' | 'custom') {
  emit('reminder-change', props.todo.id, mode, rulesList.value)
}

function onReminderRules(rules: ReminderRule[]) {
  emit('reminder-change', props.todo.id, 'custom', rules)
}

const startEditing = () => {
  // 再次点击编辑按钮时收起编辑表单（与其它下拉按钮一致的开/关切换）
  if (isEditing.value) {
    isEditing.value = false
    return
  }
  isEditing.value = true
  editTitle.value = props.todo.title
  editDescription.value = props.todo.description || ''
}

const saveEdit = () => {
  if (!editTitle.value.trim()) return

  emit('update', props.todo.id, {
    title: editTitle.value.trim(),
    description: editDescription.value.trim()
  })

  isEditing.value = false
}

/** 标题输入框按 Enter 保存；Ctrl+Enter（带修饰键）由全局快捷键系统统一处理，
 *  避免 keyup 阶段重复触发 saveEdit 导致"展开后立刻收起"。 */
const onTitleEnterSave = (e: KeyboardEvent) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  saveEdit()
}

const cancelEdit = () => {
  isEditing.value = false
}

const deleteTodo = (e?: MouseEvent) => {
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null
  emit('delete', props.todo.id, btn?.getBoundingClientRect())
}

/** 是否已过截止时间：共享实现（含非法日期串守卫），见 app/src/todo/overdue.ts。 */
const isOverdue = computed(() => isTodoOverdue(props.todo, now.value))

/** 视觉完成态：数据库已完成即为完成（含"逾期完成"：已完成但已过截止时间）。 */
const visualCompleted = computed(() => props.todo.completed === 1)

/** 逾期完成态：已完成但已过截止时间。 */
const overdueCompleted = computed(() => props.todo.completed === 1 && isOverdue.value)

/** 截止时间友好展示：月-日 时:分（无秒），用于卡片底部显示。 */
const pad2 = (n: number) => String(n).padStart(2, '0')
const formatDueDate = computed(() => {
  if (!props.todo.dueDate) return ''
  const d = new Date(props.todo.dueDate)
  if (isNaN(d.getTime())) return ''
  return t('todo.dueDisplay', {
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
})

// ===== 卡片上的自定义提醒展示（仅自定义模式；智能/关闭不显示） =====
/** 自定义闹钟规则列表 */
const remindRules = computed<ReminderRule[]>(() =>
  (props.todo.remindMode || '') === 'custom' ? props.todo.remindRules ?? [] : []
)

/** 单条规则的摘要文案：与 ReminderPicker 的 ruleSummary 同源（ruleAt 的时间格式化为 MM-DD HH:mm） */
const remindRuleSummary = (rule: ReminderRule): string => {
  if (rule.kind === 'percent') return t('reminder.rulePercent', { n: rule.value })
  if (rule.kind === 'offset') return t('reminder.ruleOffset', { n: rule.value })
  const d = new Date(rule.value)
  const time = isNaN(d.getTime())
    ? rule.value
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return t('reminder.ruleAt', { time })
}

/** 悬停提示：全部自定义规则的明细（多个以 " / " 连接） */
const remindRulesTip = computed(() => remindRules.value.map(remindRuleSummary).join(' / '))

/** 卡片显示的提醒时刻："指定时刻"规则中最早的一条；仅相对规则时为空（其触发时刻由截止时间推导） */
const customRemindAt = computed(() => {
  const times = remindRules.value
      .filter(r => r.kind === 'at')
      .map(r => new Date(r.value).getTime())
      .filter(v => !isNaN(v))
  if (times.length === 0) return ''
  const d = new Date(Math.min(...times))
  return t('todo.dueDisplay', {
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
})
</script>

<style scoped>
/* 编辑表单展开/收起动画：淡入 + 轻微下移，与点击编辑按钮展开效果一致 */
.edit-panel-enter-active {
  transition: opacity 0.22s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.edit-panel-enter-from {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}
.edit-panel-leave-active {
  transition: opacity 0.16s ease-in,
    transform 0.16s cubic-bezier(0.4, 0, 1, 1);
}
.edit-panel-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.99);
}
</style>