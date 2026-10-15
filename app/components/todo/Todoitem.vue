<template>
  <div
      class="glass-card todo-item group rounded-2xl p-4 shadow-soft transition-all duration-300 ease-soft hover:-translate-y-1 hover:shadow-float"
      :class="[
        selected ? '!border-gold ring-2 ring-gold/60 bg-gold/10 shadow-[0_0_22px_-2px_rgba(196,167,125,0.6)]' : '',
        // 手动排序拖拽落点指示：before/after 高亮卡片，child（变子任务）金色描边
        dropPos ? '!border-gold ring-2 ring-gold/60' : '',
      ]"
      @click="$emit('select')"
      @dragover="onCardDragOver"
      @dragleave="dropPos = ''"
      @drop="onCardDrop"
  >
    <div class="p-0">
      <div class="flex items-start gap-3">
        <div class="flex flex-col items-center gap-1.5 pt-1">
          <!-- 拖拽排序手柄：仅手动排序模式显示（拖到卡片间隙重排 / 拖到卡片中间变子任务） -->
          <span
              v-if="dragEnabled"
              draggable="true"
              class="cursor-grab text-ink-faint/50 transition-colors hover:text-gold active:cursor-grabbing"
              v-tip="t('todo.drag_hint')"
              @dragstart="onHandleDragStart"
              @dragend="onHandleDragEnd"
          >
            <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <circle cx="9" cy="5" r="1.6" /><circle cx="15" cy="5" r="1.6" />
              <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
              <circle cx="9" cy="19" r="1.6" /><circle cx="15" cy="19" r="1.6" />
            </svg>
          </span>
          <label
              class="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-all duration-300 ease-soft hover:shadow-xs"
              :class="visualCompleted ? 'border-gold bg-gold hover:bg-gold-soft' : 'border-line bg-surface-field hover:border-gold hover:bg-secondary'"
              v-tip="t('common.mark_complete')"
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

            <!-- 优先级徽章：等级色点 + 名称；点击直接弹出优先级选择（回收站/批量模式只读） -->
            <span
                class="flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium"
                :class="badgeClickable ? 'cursor-pointer transition-opacity hover:opacity-75' : ''"
                :style="{
                  backgroundColor: pLevel.color + '26',
                  color: pLevel.color,
                  border: `1px solid ${pLevel.color}59`,
                }"
                v-tip="priorityTip"
                @click="clickPriority($event)"
            >
              <span class="h-1.5 w-1.5 rounded-full" :style="{ backgroundColor: pLevel.color }" />
              {{ priorityName(pLevel) }}
            </span>

            <!-- 分类徽章：点击直接弹出分类选择（回收站/批量模式只读） -->
            <span
                class="rounded-full border border-accent px-2 py-0.5 text-xs text-ink-soft"
                :class="badgeClickable ? 'cursor-pointer transition-opacity hover:opacity-75' : ''"
                v-tip="badgeClickable ? t('todo.click_to_edit') : ''"
                @click="clickCategory($event)"
            >
              {{ categoryName(todo.category ?? '') }}
            </span>

            <!-- 标签行内编辑器：点击标签徽章就地编辑（chips 删除 + 输入追加），失焦/Enter 保存，Esc 取消 -->
            <div v-if="inlineTagsEditing" class="flex flex-wrap items-center gap-1.5">
              <span
                  v-for="(tag, i) in inlineTags"
                  :key="tag"
                  class="flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-xs text-gold"
              >
                # {{ tag }}
                <button
                    type="button"
                    class="flex h-3 w-3 items-center justify-center rounded-full transition-colors hover:bg-gold/30"
                    :aria-label="t('common.delete')"
                    @mousedown.prevent
                    @click="inlineTags.splice(i, 1)"
                >
                  <svg class="h-2 w-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </span>
              <input
                  ref="inlineTagInput"
                  v-model="inlineTagText"
                  type="text"
                  class="w-28 rounded-full border border-gold/50 bg-transparent px-2 py-0.5 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                  :placeholder="t('todo.tags_input_placeholder')"
                  @keydown.enter.prevent="inlineTagCommit"
                  @keydown.backspace="onInlineBackspace"
                  @keydown.esc.prevent="cancelInlineTags"
                  @blur="saveInlineTags"
              />
            </div>
            <template v-else>
              <!-- 标签徽章：点击就地进入行内编辑（回收站/批量模式只读） -->
              <span
                  v-for="tag in todo.tags ?? []"
                  :key="tag"
                  class="whitespace-nowrap rounded-full bg-gold/15 px-2 py-0.5 text-xs text-gold"
                  :class="badgeClickable ? 'cursor-pointer transition-opacity hover:opacity-75' : ''"
                  v-tip="badgeClickable ? t('todo.click_to_edit') : ''"
                  @click="clickTags"
              ># {{ tag }}</span>
            </template>

            <!-- 子任务进度徽章：n/m 已完成 -->
            <span
                v-if="children && children.length > 0"
                class="flex items-center gap-1 whitespace-nowrap rounded-full bg-secondary px-2 py-0.5 text-xs tabular-nums text-ink-soft"
                v-tip="t('todo.subtask_progress_tip', { done: childrenDone, total: children.length })"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              {{ childrenDone }}/{{ children.length }}
            </span>

            <!-- 循环徽章：频率摘要（完成后自动生成下一期） -->
            <span
                v-if="todo.recurrence"
                class="flex items-center gap-1 whitespace-nowrap rounded-full bg-gold/15 px-2 py-0.5 text-xs text-gold"
                v-tip="t('todo.recurrence')"
            >
              <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 014-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 01-4 4H3" />
              </svg>
              {{ recurrenceText }}
            </span>

            <!-- 已逾期标签：截止时间已过。未完成=红色"已逾期"，已完成=金色"逾期完成" -->
            <span
                v-if="isOverdue"
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="overdueCompleted
                  ? 'bg-gold/20 text-gold'
                  : 'bg-[rgba(200,90,90,0.15)] text-danger'"
            >
              {{ overdueCompleted ? t('todo.overdue_completed') : t('todo.overdue') }}
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
              <!-- 截止时间：始终显示在创建时间右侧（已逾期红色警示）；
                   未设截止时以灰字占位提示，悬停文案与已设状态区分 -->
              <span
                  class="flex items-center gap-1"
                  :class="{ 'text-danger': isOverdue && !visualCompleted }"
                  v-tip="t(isOverdue && !visualCompleted ? 'todo.overdue' : 'todo.due_time')"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 7v5l3 2"></path>
                  <circle cx="12" cy="12" r="9"></circle>
                </svg>
                {{ formatDueDate || t('todo.no_due_set') }}
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
              <!-- 链接徽章：点击系统浏览器打开（参考资料/工单/会议链接等） -->
              <a
                  v-for="(link, i) in todo.links ?? []"
                  :key="i"
                  href="#"
                  class="flex max-w-40 items-center gap-1 text-gold/90 hover:text-gold hover:underline"
                  v-tip="link.title ? `${link.title} · ${link.url}` : link.url"
                  @click.prevent.stop="openLink(link.url)"
              >
                <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"></path>
                  <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"></path>
                </svg>
                <span class="truncate">{{ link.title || linkHost(link.url) }}</span>
              </a>
              <!-- 回收站：显示删除时间 -->
              <span v-if="trash && todo.deletedAt" class="flex items-center gap-1 text-danger/80">
                {{ t('todo.deleted_at') }} {{ formatDeletedAt }}
              </span>
            </div>

            <!-- 操作按钮区：relative z-10 提升 dropdown 下拉菜单的 stacking context，
                 避免被相邻的 glass-card（同样 backdrop-filter）覆盖造成"外层元素显示错误"。
                 默认隐藏（opacity-0），hover 卡片时显示。 -->
            <div class="relative z-10 ml-auto flex items-center gap-1 opacity-0 transition-opacity duration-300 ease-soft group-hover:opacity-100">
              <!-- 回收站模式：恢复 / 彻底删除（彻底删除走父级确认框） -->
              <template v-if="trash">
                <button
                    @click.stop="$emit('restore', todo.id)"
                    class="btn-soft flex h-8 w-8 items-center justify-center p-2 text-gold"
                    v-tip="t('todo.restore')"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
                  </svg>
                </button>
                <button
                    @click="purgeTodo($event)"
                    class="btn-soft flex h-8 w-8 items-center justify-center p-2 text-danger hover:bg-danger/10"
                    v-tip="t('todo.purge')"
                >
                  <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                  </svg>
                </button>
              </template>

              <template v-else>
              <button
                  @click="startEditing"
                  v-tip="t('todo.edit')"
                  class="btn-soft flex h-8 w-8 items-center justify-center p-2"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path>
                </svg>
              </button>

              <!-- 优先级选择：三层递减线表示高/中/低优先级（open 受控 + 锚点覆盖：
                   徽章点击锚定徽章、按钮点击清锚回退按钮自身，面板均出现在点击处附近；
                   底部「管理等级」进入共用管理器，增改删即时持久化） -->
              <UiDropdown v-model:open="priorityOpen" :anchor-el="priorityAnchor" align="center" :aria-label="t('todo.priority')" :panel-class="managingPriority ? 'glass-card w-64 rounded-2xl p-2 shadow-float' : 'glass-card menu w-max min-w-44 rounded-2xl p-2'">
                <template #trigger>
                  <label class="btn-soft flex h-8 w-8 cursor-pointer items-center justify-center p-2" v-tip="t('todo.priority')" @click="priorityAnchor = null">
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h10M4 18h6"></path>
                    </svg>
                  </label>
                </template>
                <template #default="{ close }">
                  <!-- 管理器：数值 / 名称 / 颜色 增改删（与新建表单共用组件） -->
                  <div v-if="managingPriority" class="p-2">
                    <TodoPriorityManager @commit="onPriorityManageDone(close)" />
                  </div>
                  <template v-else>
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
                    <!-- 管理等级入口：保持面板打开，切换到管理器视图 -->
                    <div class="px-2 pb-2">
                      <button
                          type="button"
                          data-dd-keep-open
                          class="w-full rounded-lg border-t border-accent/60 px-2 py-1.5 text-left text-xs text-ink-soft transition-colors hover:bg-secondary hover:text-ink"
                          @click="managingPriority = true"
                      >
                        {{ t('todo.manage_levels') }}
                      </button>
                    </div>
                  </template>
                </template>
              </UiDropdown>

              <!-- 分类选择：标签图标（open 受控 + 锚点覆盖：徽章/按钮各自锚定点击处） -->
              <UiDropdown v-model:open="categoryOpen" :anchor-el="categoryAnchor" align="center" :close-on-select="false" aria-label="分类" panel-class="glass-card menu w-max min-w-48 max-w-80 rounded-2xl p-2">
                <template #trigger>
                  <label class="btn-soft flex h-8 w-8 cursor-pointer items-center justify-center p-2" v-tip="t('todo.category')" @click="categoryAnchor = null">
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
                            v-tip="t('common.delete_category')"
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
                          :placeholder="t('todo.new_category_placeholder')"
                          maxlength="10"
                          class="w-full rounded-lg border border-accent bg-surface-field px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
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

              <!-- 转为便签：标题+描述合并为便签内容（跨模块分发，StickyNote 卡片常显） -->
              <button
                  v-if="!trash"
                  @click="$emit('to-note', todo.id)"
                  v-tip="t('todo.to_note')"
                  class="btn-soft flex h-8 w-8 items-center justify-center p-2 text-ink-soft hover:bg-secondary hover:text-ink"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h10.5L20 15.5V5z" />
                  <path d="M15.5 20v-4.5H20" />
                </svg>
              </button>

              <!-- 删除按钮：红色垃圾桶（软删进回收站，可恢复） -->
              <button
                  @click="deleteTodo($event)"
                  v-tip="t('todo.delete')"
                  class="btn-soft flex h-8 w-8 items-center justify-center p-2 text-danger hover:bg-danger/10"
              >
                    <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                    </svg>
                  </button>
              </template>

                </div>
          </div>
        </div>
      </div>

    </div>

    <!-- 子任务缩进区（单层嵌套：仅顶级任务可挂子任务；子任务行内勾选/提升/删除） -->
    <div v-if="!trash && children && children.length > 0" class="mt-3 space-y-1 border-l-2 border-accent/60 pl-3 ml-6">
      <div
          v-for="child in children"
          :key="child.id"
          class="group/child flex items-center gap-2 rounded-lg bg-surface-field/70 px-2 py-1.5"
          :draggable="dragEnabled"
          @dragstart="onChildDragStart(child.id, $event)"
          @dragend="onChildDragEnd"
      >
        <label
            class="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors"
            :class="child.completed === 1 ? 'border-gold bg-gold' : 'border-line bg-surface-field hover:border-gold'"
        >
          <input type="checkbox" :checked="child.completed === 1" class="sr-only" @change="$emit('toggle', child.id)" />
          <svg v-if="child.completed === 1" class="h-2.5 w-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </label>
        <!-- 子任务标题：点击进入行内编辑（轻量：仅标题，类型/标签等完整编辑留给主任务面板） -->
        <input
            v-if="editingChildId === child.id"
            :ref="setChildEditInput"
            v-model="editingChildTitle"
            type="text"
            maxlength="200"
            class="min-w-0 flex-1 rounded-md border border-gold/60 bg-surface px-1.5 py-0.5 text-sm text-ink focus:outline-hidden"
            @keydown.enter.prevent="saveChildEdit"
            @keydown.esc.prevent="cancelChildEdit"
            @blur="saveChildEdit"
        />
        <span
            v-else
            class="min-w-0 flex-1 cursor-text truncate text-sm"
            :class="child.completed === 1 ? 'text-ink-faint line-through' : 'text-ink-soft'"
            @click.stop="startChildEdit(child)"
        >{{ child.title }}</span>
        <span v-if="child.dueDate" class="shrink-0 text-xs tabular-nums text-ink-faint">{{ childDueText(child) }}</span>
        <!-- 提升为顶级任务 -->
        <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-all group-hover/child:opacity-100 hover:text-gold"
            v-tip="t('todo.subtask_promote')"
            @click.stop="$emit('promote', child.id)"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
          </svg>
        </button>
        <!-- 删除子任务（软删进回收站） -->
        <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-all group-hover/child:opacity-100 hover:text-danger"
            v-tip="t('todo.delete_task_confirm')"
            @click.stop="$emit('delete', child.id)"
        >
          <svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 添加子任务内联输入（顶级任务 + 非回收站态） -->
    <div v-if="!trash && !todo.parentId" class="ml-6 mt-2">
      <input
          v-model="childTitle"
          type="text"
          maxlength="200"
          class="w-full rounded-lg border border-dashed border-accent bg-transparent px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
          :placeholder="t('todo.subtask_add_placeholder')"
          @keydown.enter.prevent="submitChild"
      />
    </div>

    <Transition name="edit-panel">
      <div v-if="isEditing" class="mt-4 rounded-xl bg-surface-field p-4">
        <div class="space-y-3">
          <div class="flex items-center gap-2">
            <input
                v-model="editTitle"
                :data-todo-edit-title="todo.id"
                type="text"
                class="min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                :placeholder="t('todo.title_placeholder')"
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
            class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
            :placeholder="t('todo.desc_placeholder')"
            rows="2"
        ></textarea>

        <!-- 标签编辑：空格/逗号分隔，保存时清洗去重（标签徽章点击后聚焦此输入） -->
        <input
            ref="tagsInputRef"
            v-model="editTagsText"
            type="text"
            class="w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
            :placeholder="t('todo.tags_input_placeholder')"
        />

        <!-- 链接编辑：url 必填（自动补 https://）、名称可选 -->
        <div class="space-y-1.5">
          <div v-for="(link, i) in editLinks" :key="i" class="flex items-center gap-1.5">
            <input
                v-model="link.title"
                type="text"
                maxlength="50"
                class="w-32 shrink-0 rounded-lg border border-accent bg-surface-field px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                :placeholder="t('todo.link_title_placeholder')"
            />
            <input
                v-model="link.url"
                type="text"
                class="min-w-0 flex-1 rounded-lg border border-accent bg-surface-field px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                :placeholder="t('todo.link_url_placeholder')"
            />
            <button
                type="button"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-danger hover:bg-danger/10"
                v-tip="t('common.delete')"
                @click="editLinks.splice(i, 1)"
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <button
              type="button"
              class="btn-soft flex items-center gap-1 px-2 py-1 text-xs"
              @click="editLinks.push({ title: '', url: '' })"
          >
            <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            {{ t('todo.link_add') }}
          </button>
        </div>

        <!-- 循环规则编辑（子任务不参与循环：有 parentId 时隐藏） -->
        <div v-if="!todo.parentId" class="flex items-center gap-2">
          <span class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.recurrence') }}</span>
          <RecurrencePicker v-model="editRecurrence" :disabled="!todo.dueDate" />
        </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type {Todo, TodoLink, TodoRecurrence} from "~/src/entities";
import { useI18n } from '~/composables/useI18n';
import HighlightText from "~/components/mainpage/HighlightText.vue";
import ReminderPicker from "~/components/todo/ReminderPicker.vue";
import RecurrencePicker from "~/components/todo/RecurrencePicker.vue";
import TodoPriorityManager from "~/components/todo/TodoPriorityManager.vue";
import type { ReminderRule } from "~/src/entities";
import { useFormatDate } from "~/composables/useFormatDate";
import { useNow } from "~/composables/useNow";
import { useTodoPriorities } from "~/composables/useTodoPriorities";
import { useDisplayNames } from "~/composables/useDisplayNames";
import { describeRecurrence } from "~/src/todo/recurrence";
import { parseTagsText } from "~/src/todo/tags";
import { beginElementDrag, endElementDrag } from "~/src/core/dragState";
import { isTauri } from "~/utils/env";

const { t } = useI18n();
const { priorityName, categoryName } = useDisplayNames();
const formatDateLocalized = useFormatDate();
import { describeSmartPlan } from "~/src/todo/reminderPolicy";
import { isTodoOverdue } from "~/src/todo/overdue";
import { openUrl } from '@tauri-apps/plugin-opener';
import { useCategories } from '~/composables/useCategories';


const props = defineProps<{
  todo: Todo
  highlightString?: string
  highlight?: boolean
  /** 是否被方向键选中（高亮提示） */
  selected?: boolean
  /** 编辑触发信号：Ctrl+Enter 递增，为当前选中项进入编辑态 */
  editSignal?: number
  /** 子任务列表（单层嵌套，缩进渲染在父卡片下方；仅顶级任务有） */
  children?: Todo[]
  /** 回收站模式：操作区切换为 恢复 / 彻底删除 */
  trash?: boolean
  /** 手动排序模式：启用拖拽手柄（重排 / 拖到卡片中间变子任务） */
  dragEnabled?: boolean
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
  (e: 'restore', id: string): void
  (e: 'purge', id: string, rect?: DOMRect): void
  (e: 'promote', id: string): void
  (e: 'add-child', parentId: string, title: string): void
  (e: 'drag-start', id: string): void
  (e: 'drag-end'): void
  (e: 'drop', targetId: string, pos: 'before' | 'after' | 'child'): void
  /** 转为便签（跨模块分发）：父级合并标题+描述建便签 */
  (e: 'to-note', id: string): void
}>()

// ===== 链接辅助：地址规整 + 域名展示 + 打开 =====
/** 链接地址规整：无协议时补 https://（空串原样返回，由调用方过滤） */
function normalizeUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u) ? u : `https://${u}`
}

/** 链接域名展示（无自定义标题时用），解析失败回退原文 */
function linkHost(url: string): string {
  try {
    return new URL(normalizeUrl(url)).hostname
  } catch {
    return url
  }
}

/** 打开链接：Tauri 内用系统浏览器（openUrl），浏览器环境用新标签页 */
function openLink(url: string) {
  const u = normalizeUrl(url)
  if (!u) return
  if (isTauri()) void openUrl(u)
  else window.open(u, '_blank', 'noopener')
}

// ===== 拖拽层级调整：手柄拖起 → 落到目标卡片上 → 父级统一处理（变为子任务） =====
/** 拖拽悬停状态：child = 可落为本卡子任务，'' = 无 */
const dropPos = ref<'' | 'child'>('')

/** 悬停即可落为子任务（金色高亮提示），松手交给父级处理层级 */
function onCardDragOver(e: DragEvent) {
  if (!props.dragEnabled) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dropPos.value = 'child'
}

/** 松手：携带目标卡 id 与落点交给父级（变子任务）；阻止冒泡防列表容器空白区 drop 双触发 */
function onCardDrop(e: DragEvent) {
  const pos = dropPos.value
  dropPos.value = ''
  if (!props.dragEnabled || !pos) return
  e.preventDefault()
  e.stopPropagation()
  emit('drop', props.todo.id, pos)
}

/** 子任务行拖起：同样走 drag-start 交给父级记录（拖到其他顶级卡 = 换父，拖到空白区 = 提升为顶级） */
function onChildDragStart(id: string, e: DragEvent) {
  if (!props.dragEnabled) return
  beginElementDrag()
  e.dataTransfer?.setData('text/plain', props.children?.find(c => c.id === id)?.title ?? '')
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  emit('drag-start', id)
}
function onChildDragEnd() {
  if (!props.dragEnabled) return
  endElementDrag()
  emit('drag-end')
}

/** 手柄拖起：携带任务标题（便于调试），拖拽源 id 由父级通过 drag-start 记录 */
function onHandleDragStart(e: DragEvent) {
  beginElementDrag()
  e.dataTransfer?.setData('text/plain', props.todo.title)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  emit('drag-start', props.todo.id)
}

/** 手柄拖拽结束（取消/落点均触发）：归还全局拖拽计数，父级语义照常派发 */
function onHandleDragEnd() {
  endElementDrag()
  emit('drag-end')
}

// ===== 展示：子任务进度 / 循环摘要 / 子任务到期 / 回收站删除时间 =====
/** 子任务完成数（卡片进度徽章 n/m） */
const childrenDone = computed(() => (props.children ?? []).filter(c => c.completed === 1).length)

/** 循环规则摘要文案（与 RecurrencePicker 面板同源，见 recurrence.ts） */
const recurrenceText = computed(() =>
  props.todo.recurrence ? describeRecurrence(props.todo.recurrence, t) : ''
)

/** 子任务到期文本：沿用 due_display（MM-DD HH:mm），仅在有 dueDate 时显示 */
const childDueText = (child: Todo): string => {
  const d = new Date(child.dueDate || '')
  if (isNaN(d.getTime())) return ''
  return t('todo.due_display', {
    m: d.getMonth() + 1,
    d: d.getDate(),
    hh: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
  })
}

/** 回收站：删除时间（MM-DD HH:mm），非法日期串原样展示 */
const formatDeletedAt = computed(() => {
  if (!props.todo.deletedAt) return ''
  const d = new Date(props.todo.deletedAt)
  if (isNaN(d.getTime())) return props.todo.deletedAt
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
})

/** 彻底删除（回收站）：附按钮位置供确认框就近定位 */
function purgeTodo(e?: MouseEvent) {
  const btn = (e?.target as HTMLElement | undefined)?.closest?.('button') as HTMLElement | null
  emit('purge', props.todo.id, btn?.getBoundingClientRect())
}

// ===== 子任务内联添加 =====
const childTitle = ref('')
/** 回车提交子任务（父级负责入库与排序），空标题忽略；提交后清空输入 */
function submitChild() {
  const title = childTitle.value.trim()
  if (!title) return
  emit('add-child', props.todo.id, title)
  childTitle.value = ''
}

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

/** 是否处于等级管理模式（面板切换为共用管理器） */
const managingPriority = ref(false)

/** 管理器确认后收尾：退出管理态并关闭面板；当前任务等级被收敛掉时回填中档 */
const onPriorityManageDone = (close: () => void) => {
  managingPriority.value = false
  if (!priorityLevels.value.some(p => p.level === currentLevel.value)) {
    emit('priority-level-change', props.todo.id, 127)
  }
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
  if (!props.todo.dueDate) return t('todo.no_due_set')
  return describeSmartPlan(props.todo) || t('todo.no_due_set')
})

function onReminderMode(mode: 'smart' | 'off' | 'custom') {
  emit('reminder-change', props.todo.id, mode, rulesList.value)
}

function onReminderRules(rules: ReminderRule[]) {
  emit('reminder-change', props.todo.id, 'custom', rules)
}

// ===== 编辑面板草稿：标题/描述 + 标签 + 链接 + 循环 =====
/** 标签输入文本（空格/逗号分隔，保存时清洗） */
const editTagsText = ref('')
/** 链接行编辑草稿（url 必填、title 可选） */
const editLinks = ref<TodoLink[]>([])
/** 循环规则草稿（undefined = 不循环） */
const editRecurrence = ref<TodoRecurrence | undefined>(undefined)

const startEditing = () => {
  // 再次点击编辑按钮时收起编辑表单（与其它下拉按钮一致的开/关切换）
  if (isEditing.value) {
    isEditing.value = false
    return
  }
  isEditing.value = true
  editTitle.value = props.todo.title
  editDescription.value = props.todo.description || ''
  // 标签以空格连接成一段文本；链接克隆为草稿行；循环克隆规则
  editTagsText.value = (props.todo.tags ?? []).join(' ')
  editLinks.value = (props.todo.links ?? []).map(l => ({ ...l }))
  editRecurrence.value = props.todo.recurrence ? { ...props.todo.recurrence } : undefined
}

// ===== 徽章快捷编辑：点徽章 = 就地弹出对应选择器 / 聚焦编辑面板对应输入 =====
/** 优先级 / 分类下拉的受控开关（点徽章可直接打开，图标按钮照常可用） */
const priorityOpen = ref(false)
const categoryOpen = ref(false)
/** 面板定位锚点：点徽章打开时锚定徽章（面板出现在点击处附近），
 *  点右上角图标按钮打开时清空（回退锚定按钮自身） */
const priorityAnchor = ref<HTMLElement | null>(null)
const categoryAnchor = ref<HTMLElement | null>(null)
/** 编辑面板标签输入框（标签徽章点击后聚焦） */
const tagsInputRef = ref<HTMLInputElement | null>(null)
/** 徽章可点击：回收站视图（只读）不响应 */
const badgeClickable = computed(() => !props.trash)
/** 优先级徽章 hover 提示：等级档位 + 点击修改（回收站仅档位信息） */
const priorityTip = computed(() => {
  const base = t('todo.priority_badge', { level: pLevel.value.level })
  return badgeClickable.value ? `${base} · ${t('todo.click_to_edit')}` : base
})
/** 点击优先级徽章 ⇆ 开/关优先级下拉（面板锚定徽章自身） */
const clickPriority = (e: MouseEvent) => {
  if (!badgeClickable.value) return
  priorityAnchor.value = e.currentTarget as HTMLElement
  priorityOpen.value = !priorityOpen.value
}
/** 点击分类徽章 ⇆ 开/关分类下拉（面板锚定徽章自身） */
const clickCategory = (e: MouseEvent) => {
  if (!badgeClickable.value) return
  categoryAnchor.value = e.currentTarget as HTMLElement
  categoryOpen.value = !categoryOpen.value
}
/** 点击标签徽章：徽章区就地切换为行内标签编辑器（不展开编辑面板） */
const inlineTagsEditing = ref(false)
/** 行内编辑草稿：已有标签 chips + 未提交输入 */
const inlineTags = ref<string[]>([])
const inlineTagText = ref('')
const inlineTagInput = ref<HTMLInputElement | null>(null)

const clickTags = () => {
  if (!badgeClickable.value) return
  inlineTags.value = [...(props.todo.tags ?? [])]
  inlineTagText.value = ''
  inlineTagsEditing.value = true
  nextTick(() => inlineTagInput.value?.focus())
}

/** 行内输入 Enter：把输入（支持空格/逗号分隔多个）并入 chips，继续编辑 */
const inlineTagCommit = () => {
  for (const p of parseTagsText(inlineTagText.value)) {
    if (!inlineTags.value.includes(p)) inlineTags.value.push(p)
  }
  inlineTagText.value = ''
}

/** 空输入时 Backspace：删除最后一个 chip */
const onInlineBackspace = () => {
  if (!inlineTagText.value) inlineTags.value.pop()
}

/** 保存行内编辑：并入未提交输入，清洗去重后回传（无变化不写库）；Esc 取消后 input 卸载触发的 blur 不再重复保存 */
const saveInlineTags = () => {
  if (!inlineTagsEditing.value) return
  inlineTagsEditing.value = false
  inlineTagCommit()
  const cleaned = inlineTags.value.slice(0, 8)
  const original = props.todo.tags ?? []
  if (cleaned.length === original.length && cleaned.every((v, i) => v === original[i])) return
  emit('update', props.todo.id, { tags: cleaned })
}

/** 取消行内编辑：丢弃草稿 */
const cancelInlineTags = () => {
  inlineTagsEditing.value = false
}

/** 每次重新打开优先级下拉都从等级列表开始（管理器挂载时重新克隆草稿，未确认即弃） */
watch(priorityOpen, (v) => {
  if (v) managingPriority.value = false
})

/** 链接草稿清洗：url 必填（补协议）、title 去空白、按 url 去重 */
function cleanLinkDrafts(drafts: TodoLink[]): TodoLink[] {
  const out: TodoLink[] = []
  const seen = new Set<string>()
  for (const d of drafts) {
    const url = normalizeUrl(d.url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ title: (d.title || '').trim(), url })
  }
  return out
}

const saveEdit = () => {
  if (!editTitle.value.trim()) return

  emit('update', props.todo.id, {
    title: editTitle.value.trim(),
    description: editDescription.value.trim(),
    // 标签/链接/循环随编辑面板一并保存（仓储层写入前还会再清洗一遍）
    tags: parseTagsText(editTagsText.value),
    links: cleanLinkDrafts(editLinks.value),
    recurrence: editRecurrence.value ? { ...editRecurrence.value } : undefined,
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

// ===== 子任务行内编辑（轻量：仅标题；Enter/失焦保存，Esc 取消） =====
const editingChildId = ref<string | null>(null)
const editingChildTitle = ref('')
const childEditInput = ref<HTMLInputElement | null>(null)
/** v-for 内同一时刻只有一行处于编辑态：函数 ref 捕获输入框供自动聚焦 */
const setChildEditInput = (el: unknown) => { childEditInput.value = (el as HTMLInputElement | null) ?? null }
function startChildEdit(child: Todo) {
  if (props.trash) return
  editingChildId.value = child.id
  editingChildTitle.value = child.title
  nextTick(() => {
    childEditInput.value?.focus()
    childEditInput.value?.select()
  })
}
function saveChildEdit() {
  if (editingChildId.value === null) return
  const id = editingChildId.value
  const title = editingChildTitle.value.trim()
  editingChildId.value = null // 先退出编辑态：Esc 取消后的 blur 由此不再重复保存
  if (!title || title === (props.children?.find(c => c.id === id)?.title ?? '')) return
  emit('update', id, { title })
}
function cancelChildEdit() {
  editingChildId.value = null
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
  return t('todo.due_display', {
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
  if (rule.kind === 'percent') return t('reminder.rule_percent', { n: rule.value })
  if (rule.kind === 'offset') return t('reminder.rule_offset', { n: rule.value })
  const d = new Date(rule.value)
  const time = isNaN(d.getTime())
    ? rule.value
    : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return t('reminder.rule_at', { time })
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
  return t('todo.due_display', {
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