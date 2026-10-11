<template>
  <div>
    <!-- 边距与宽度由外壳统一提供（main px-4 + max-w-6xl），各模块保持一致；
         概览统计（总数/完成率/按时率）已迁至统计页，待办页聚焦任务管理 -->
    <div>
      <!-- 搜索/筛选栏：relative z-40 提升 stacking context 层级，
           避免下拉菜单被下方 TodoItem 列表（同样 backdrop-filter 的 glass-card）覆盖 -->
      <div class="glass-card relative z-40 mb-6 rounded-2xl p-4 shadow-soft">
        <div class="flex flex-col gap-4 lg:flex-row">
          <div class="flex flex-1 items-center gap-2">
            <input
                ref="todoSearchInput"
                v-model="searchQuery"
                type="text"
                :placeholder="t('todo.search_placeholder')"
                class="todo-search-input min-w-0 flex-1 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
            />

            <UiDropdown align="center" :aria-label="t('todo.filter')" panel-class="glass-card menu w-max min-w-32 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex shrink-0 cursor-pointer items-center">
                  {{ currentFilterLabel }}
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="filter in filters" :key="filter.value">
                  <a @click="setFilter(filter.value)" class="cursor-pointer whitespace-nowrap rounded-lg hover:bg-secondary">{{ filter.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <UiDropdown align="center" :aria-label="t('todo.sort')" panel-class="glass-card menu w-max min-w-40 rounded-2xl p-2">
              <template #trigger="{ open }">
                <label class="btn-soft flex cursor-pointer items-center">
                  {{ t('todo.sort') }}
                  <svg class="ml-1 h-4 w-4 transform transition-transform duration-200" :class="{ 'rotate-180': open }" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path>
                  </svg>
                </label>
              </template>
              <ul class="menu p-2">
                <li v-for="sort in sortOptions" :key="sort.value">
                  <a @click="setSort(sort.value)" class="cursor-pointer whitespace-nowrap rounded-lg hover:bg-secondary">{{ sort.label }}</a>
                </li>
              </ul>
            </UiDropdown>

            <!-- 视图切换：列表 / 日历 / 回收站 -->
            <div class="flex shrink-0 items-center rounded-xl border border-accent bg-surface-field p-0.5">
              <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-200"
                  :class="view === 'list' ? 'bg-gold/20 font-medium text-gold' : 'text-ink-soft hover:text-ink'"
                  v-tip="t('todo.view_list')"
                  @click="view = 'list'"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span class="hidden text-sm md:inline">{{ t('todo.view_list') }}</span>
              </button>
              <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-200"
                  :class="view === 'calendar' ? 'bg-gold/20 font-medium text-gold' : 'text-ink-soft hover:text-ink'"
                  v-tip="t('todo.view_calendar')"
                  @click="view = 'calendar'"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
                </svg>
                <span class="hidden text-sm md:inline">{{ t('todo.view_calendar') }}</span>
              </button>
              <button
                  type="button"
                  class="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-200"
                  :class="view === 'trash' ? 'bg-gold/20 font-medium text-gold' : 'text-ink-soft hover:text-ink'"
                  v-tip="t('todo.trash')"
                  @click="view = 'trash'"
              >
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                <span class="hidden text-sm md:inline">{{ t('todo.trash') }}</span>
              </button>
            </div>

            <!-- 批量模式：进入/退出多选（列表视图） -->
            <button
                v-if="view === 'list'"
                type="button"
                class="btn-soft flex h-10 shrink-0 items-center gap-1.5 px-3"
                :class="batchMode ? '!text-gold' : ''"
                v-tip="t(batchMode ? 'todo.batch_exit' : 'todo.batch')"
                @click="toggleBatchMode"
            >
              <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 5l7 7-7 7" /><rect x="3" y="5" width="6" height="6" rx="1" /><path d="M9 15.5l2 2 4-4" />
              </svg>
              <span class="hidden text-sm sm:inline">{{ t(batchMode ? 'todo.batch_exit' : 'todo.batch') }}</span>
            </button>

            <!-- 新增任务：位于搜索框最右侧，点击下拉展开表单（与原先效果一致） -->
            <button
                @click="toggleAddForm"
                class="btn-gold ml-auto flex h-10 shrink-0 items-center gap-1.5 px-3"
                v-tip="t(showAddForm ? 'todo.collapse' : 'todo.expand_add_form')"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
              </svg>
              <span class="hidden text-sm sm:inline">{{ t('todo.new_task_btn') }}</span>
            </button>
          </div>
        </div>

        <!-- 新增任务：在搜索框所在卡片内部下拉/收起，与搜索框贴合 -->
        <div
            class="collapse-wrap"
            :class="showAddForm ? 'is-open' : ''"
        >
          <div class="min-h-0">
            <div class="pt-3">
              <!-- 自然语言录入（高级项）：collapse-wrap 渐变动画，同「新增任务」折叠观感；行距放内层，折叠时不留残隙 -->
              <div class="collapse-wrap" :class="{ 'is-open': advancedOpen }">
                <div class="min-h-0">
                  <div class="flex items-center gap-2 pt-3">
                    <input
                        v-model="nlpText"
                        type="text"
                        class="min-w-0 flex-1 rounded-xl border border-dashed border-gold/50 bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                        :placeholder="t('todo.nlp_placeholder')"
                        @keydown.enter.prevent="parseNlp"
                    />
                    <button
                        type="button"
                        class="btn-soft flex h-9 shrink-0 items-center gap-1.5 px-3 text-sm"
                        :disabled="!nlpText.trim() || nlpParsing"
                        v-tip="t('todo.nlp_parse')"
                        @click="parseNlp"
                    >
                      <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l4.5 11-2 .5-1.5 4.5L9.5 8 13 3z" />
                      </svg>
                      {{ nlpParsing ? t('todo.nlp_parsing') : t('todo.nlp_parse') }}
                    </button>
                  </div>
                </div>
              </div>

              <input
                  v-model="newTodo.title"
                  type="text"
                  class="todo-title-input mt-3 w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                  :placeholder="t('todo.title_placeholder') + ' *'"
                  @keyup.enter="goDescription"
              />

              <!-- 描述（高级项）：同款折叠动画 -->
              <div class="collapse-wrap" :class="{ 'is-open': advancedOpen }">
                <div class="min-h-0">
                  <textarea
                      ref="descriptionInput"
                      v-model="newTodo.description"
                      class="mt-3 w-full rounded-xl border border-accent bg-surface-field px-3 py-2 text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                      :placeholder="t('todo.desc_placeholder')"
                      rows="2"
                  ></textarea>
                </div>
              </div>

              <!-- 基础控件行 + 操作按钮：截止时间（任务锚点）→ 优先级 → 分类；窄窗口自动换行不裁切 -->
              <div class="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.due') }}</label>
                    <DueTimeSelect v-model="newTodo.dueDate" :placeholder="t('todo.due_time')" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.priority') }}</label>
                    <PrioritySelect v-model="newTodo.priorityLevel" />
                  </div>

                  <div class="flex items-center gap-2">
                    <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.category') }}</label>
                    <CategorySelect v-model="newTodo.category" :placeholder="t('todo.category')" @category-delete="handleCategoryDelete" />
                  </div>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <!-- 分层开关：默认只露基础项，更多（NLP/描述/提醒/标签/循环/模板）收进面板 -->
                  <button
                      type="button"
                      class="btn-soft flex h-9 shrink-0 items-center gap-1 px-3 text-sm"
                      v-tip="advancedOpen ? t('todo.more_options_hide') : t('todo.more_options')"
                      @click="advancedOpen = !advancedOpen"
                  >
                    {{ advancedOpen ? t('todo.more_options_hide') : t('todo.more_options') }}
                    <svg
                        class="h-3.5 w-3.5 transition-transform" :class="advancedOpen ? 'rotate-180' : ''"
                        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                  <button
                      type="button"
                      @click="addTodo"
                      v-tip="t('common.add_task')"
                      class="btn-gold flex h-9 w-9 items-center justify-center p-0"
                      :disabled="!newTodo.title.trim()"
                  >
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
                    </svg>
                  </button>
                  <button
                      type="button"
                      @click="resetForm"
                      v-tip="t('common.reset')"
                      class="btn-soft flex h-9 w-9 items-center justify-center p-0"
                  >
                    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 高级控件行（collapse-wrap 渐变动画）：提醒 → 循环（均派生于截止时间）→ 标签 → 模板工具 -->
              <div class="collapse-wrap" :class="{ 'is-open': advancedOpen }">
                <div class="min-h-0">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 pt-3">
                    <div class="flex items-center gap-2">
                      <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.reminder_label') }}</label>
                      <ReminderPicker
                          v-model:mode="newTodo.remindMode"
                          v-model:rules="newTodo.remindRules"
                          variant="field"
                          :has-due="!!newTodo.dueDate"
                      />
                    </div>

                    <div class="flex items-center gap-2">
                      <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.recurrence') }}</label>
                      <RecurrencePicker v-model="newTodo.recurrence" :disabled="!newTodo.dueDate" />
                    </div>

                    <div class="flex items-center gap-2">
                      <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.tags') }}</label>
                      <input
                          v-model="newTodo.tagsText"
                          type="text"
                          class="w-40 rounded-xl border border-accent bg-surface-field px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-gold focus:outline-hidden"
                          :placeholder="t('todo.tags_input_placeholder')"
                      />
                    </div>

                    <div class="flex items-center gap-2">
                      <label class="whitespace-nowrap text-sm text-ink-faint">{{ t('todo.template') }}</label>
                      <UiDropdown align="center" :close-on-select="false" :aria-label="t('todo.template')" panel-class="glass-card menu w-max min-w-44 rounded-2xl p-2">
                        <template #trigger>
                          <label class="flex h-9 cursor-pointer items-center gap-1 rounded-xl border border-accent bg-surface-field px-3 text-sm text-ink transition-colors hover:border-gold">
                            {{ t('todo.template_apply') }}
                            <svg class="h-3.5 w-3.5 text-gold" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M6 9l6 6 6-6" />
                            </svg>
                          </label>
                        </template>
                        <template #default="{ close }">
                          <ul class="menu max-h-60 overflow-y-auto p-2">
                            <li v-for="tpl in templates" :key="tpl.id">
                              <div class="flex w-full items-center rounded-lg hover:bg-secondary">
                                <a @click="applyTemplate(tpl, close)" class="flex-1 truncate whitespace-nowrap px-2 py-1">{{ tpl.name }}</a>
                                <button
                                    type="button"
                                    data-dd-keep-open
                                    v-tip="t('todo.template_delete')"
                                    class="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
                                    @click.stop="removeTemplate(tpl.id)"
                                >
                                  <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                                </button>
                              </div>
                            </li>
                            <li v-if="templates.length === 0" class="px-2 py-1.5 text-xs text-ink-faint">{{ t('todo.template_none') }}</li>
                          </ul>
                        </template>
                      </UiDropdown>
                      <button
                          type="button"
                          class="btn-soft h-9 shrink-0 px-2 text-xs"
                          :disabled="!newTodo.title.trim()"
                          v-tip="t('todo.template_save')"
                          @click="saveAsTemplate"
                      >{{ t('todo.template_save') }}</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 批量操作栏：多选后的统一操作（完成 / 分类 / 删除 / 全选） -->
      <div v-if="batchMode && view === 'list'" class="glass-card mb-3 flex flex-wrap items-center gap-2 rounded-2xl p-3">
        <span class="text-sm text-gold">{{ t('todo.batch_selected', { n: batchSelectedIds.size }) }}</span>
        <button type="button" class="btn-soft px-3 py-1.5 text-xs" @click="toggleSelectAll">{{ t('todo.select_all') }}</button>
        <div class="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" class="btn-gold px-3 py-1.5 text-xs" :disabled="batchSelectedIds.size === 0" @click="batchComplete">{{ t('todo.batch_complete') }}</button>
          <CategorySelect v-model="batchCategory" :placeholder="t('todo.batch_category')" @update:model-value="batchSetCategory" />
          <button type="button" class="btn-soft px-3 py-1.5 text-xs text-danger hover:!bg-danger/10" :disabled="batchSelectedIds.size === 0" @click="batchDelete">{{ t('todo.batch_delete') }}</button>
        </div>
      </div>

      <!-- 日历视图：按月分桶展示，拖拽改期 / 勾选完成 -->
      <TodoCalendar v-if="view === 'calendar'" :todos="calendarTodos" @change-due="changeDueFromCalendar" @toggle="toggleTodo" />

      <!-- 回收站视图：软删任务（恢复 / 彻底删除） -->
      <div v-else-if="view === 'trash'" id="todoListContainer" class="space-y-3">
        <TodoItem
            v-for="todo in trashTopTodos"
            :key="todo.id"
            :todo="todo"
            trash
            :children="trashChildrenMap.get(todo.id) ?? []"
            @restore="restoreTodo"
            @purge="askPurge"
        />
        <div v-if="trashTopTodos.length === 0" class="py-20 text-center">
          <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
          </svg>
          <p class="text-lg text-ink-faint">{{ t('todo.trash_empty') }}</p>
        </div>
      </div>

      <!-- 列表视图：仅渲染顶级任务，子任务由父卡片内联展示 -->
      <div v-else id="todoListContainer" class="space-y-3">
        <TodoItem
            v-for="(todo, index) in topTodos"
            :key="todo.id"
            :todo="todo"
            :children="childrenMap.get(todo.id) ?? []"
            :highlight-string="searchQuery"
            :highlight="searchQuery.trim() !== ''"
            :selected="!batchMode && index === selectedTodoIndex"
            :edit-signal="editSignal"
            :batch-mode="batchMode"
            :batch-selected="batchSelectedIds.has(todo.id)"
            :drag-enabled="dragEnabled"
            @toggle="toggleTodo"
            @update="updateTodo"
            @delete="deleteTodo"
            @priority-level-change="changePriorityLevel"
            @category-change="changeCategory"
            @reminder-change="changeReminder"
            @category-delete="handleCategoryDelete"
            @select="selectTodoIndex(index)"
            @toggle-select="toggleBatchSelect"
            @promote="promoteTodo"
            @add-child="addChild"
            @drag-start="draggingId = $event"
            @drag-end="draggingId = null"
            @drop="handleDrop"
        />
      </div>

      <!-- 流式加载：sentinel 进入视口时自动加载下一页；到底后显示"已全部加载"（仅列表视图） -->
      <div
          v-if="view === 'list' && hasMore && todos.length"
          ref="sentinel"
          class="flex items-center justify-center gap-2 py-4 text-xs text-ink-faint"
      >
        <span v-if="loadingMore">{{ t('todo.loading_more') }}</span>
        <span v-else>{{ t('clip.scroll_more') }}</span>
      </div>
      <div v-else-if="view === 'list' && todos.length" class="py-4 text-center text-xs text-ink-faint">{{ t('clip.no_more') }}</div>

      <div v-if="view === 'list' && filteredAndSortedTodos.length === 0" class="py-20 text-center">
        <svg class="mx-auto mb-4 h-24 w-24 text-ink-faint/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="text-lg text-ink-faint">
          {{ !searchQuery.trim() && todos.length === 0 ? t('todo.empty') : t('todo.empty_search') }}
        </p>
      </div>

      <!-- 删除确认框：与全局一致的 DeleteConfirm 组件（视口居中、键盘操作一致） -->
      <DeleteConfirm
          :visible="deleteConfirmVisible"
          :message="deleteConfirmMessage"
          @confirm="onDeleteConfirm"
          @cancel="onDeleteCancel"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import TodoItem from './Todoitem.vue'
import TodoCalendar from './TodoCalendar.vue'
import RecurrencePicker from '~/components/todo/RecurrencePicker.vue'
import clipboardService from '~/src/db/dbService'
import { v4 as uuidv4 } from 'uuid'
import type {Todo, ReminderRule, TodoRecurrence} from '~/src/entities'
import { nextDueDate } from '~/src/todo/recurrence'
import { parseTagsText } from '~/src/todo/tags'
import { parseTodoFromText, NLP_ERR_NOT_CONFIGURED, NLP_ERR_BAD_RESPONSE } from '~/src/todo/todoNlp'
import { useTodoTemplates, type TodoTemplate } from '~/composables/useTodoTemplates'
import { bus } from '~/src/core/events'
import {isTauri} from "~/utils/env"
import statsService from "~/src/statistics/statsService"
import DueTimeSelect from '~/components/todo/DueTimeSelect.vue'
import CategorySelect from '~/components/todo/CategorySelect.vue'
import ReminderPicker from '~/components/todo/ReminderPicker.vue'
import PrioritySelect from '~/components/todo/PrioritySelect.vue'
import { useCategories } from "~/composables/useCategories"
import { notifyIsland } from "~/composables/useCopyIsland"
import { useTodoPriorities } from "~/composables/useTodoPriorities"
import { useDueDateMemory } from "~/composables/useDueDateMemory"
import reminderService from '~/src/todo/reminderService'
import { isTodoOverdue } from '~/src/todo/overdue'
import DeleteConfirm from '~/components/common/DeleteConfirm.vue'
import { useNow } from '~/composables/useNow'
import { useI18n } from '~/composables/useI18n'
import { todoList, selectedTodoIndex, editSignal, selectTodo, setTodoLoadMoreHook } from '~/src/commands/local/todoStore'
import { useInfiniteList } from '~/composables/useInfiniteList'

/** 流式加载：首屏只加载第一页，滚动到底部自动加载下一页；
 *  轮询/操作后仅刷新已加载范围（签名一致时跳过整表替换，避免全列表重渲染） */
const {
  items: todos, hasMore, loading: loadingMore, sentinel,
  loadMore, reload, replace, prepend, remove: removeTodo, refreshLoaded,
} = useInfiniteList<Todo>({
  fetchPage: (offset, limit) =>
    clipboardService.fetchTodos({ value: { searchContent: '' } }, { offset, limit }),
  pageSize: 50,
  signatureOf: (t) => `${t.id}:${t.updated_at}:${t.completed}`,
})

const { t } = useI18n();

/** 全量待办集合（轮询全量查询结果）：仅用于统计卡片与提醒调度，不参与列表渲染 */
const statsTodos = ref<Todo[]>([])
let pollTimer: ReturnType<typeof setInterval> | null = null
/** 轮询请求去重：上一轮未完成时跳过，避免 DB 慢时请求堆积 */
let fetching = false
/** 写库进行中计数：>0 时轮询跳过，防止拿旧数据覆盖乐观更新（竞态根源） */
let pendingWrites = 0

/** 乐观更新同步到统计全量集合（statsTodos 可能比已加载列表大，需单独同步） */
function applyToStats(todo: Todo) {
  const t = statsTodos.value.find(x => x.id === todo.id)
  if (t) Object.assign(t, todo)
}

const showAddForm = ref(false)
/** 表单分层：默认仅展示基础项（标题/优先级/截止/分类），高级项折叠进「更多选项」 */
const advancedOpen = ref(false)
const newTodo = ref({
  title: '',
  description: '',
  priorityLevel: 127,
  category: '其他',
  dueDate: '',
  remindMode: 'smart' as 'smart' | 'off' | 'custom',
  remindRules: [] as ReminderRule[],
  /** 标签文本（空格/逗号分隔），入库前经 parseTagsText 清洗 */
  tagsText: '',
  /** 循环规则（undefined = 不循环），完成后自动生成下一期 */
  recurrence: undefined as TodoRecurrence | undefined,
})

// ===== 视图切换：列表 / 日历 / 回收站 =====
const view = ref<'list' | 'calendar' | 'trash'>('list')

// ===== 批量多选模式：顶级任务复选，统一完成/分类/删除 =====
const batchMode = ref(false)
const batchSelectedIds = ref<Set<string>>(new Set())
/** 批量分类选择器的临时值（选择即应用，应用后清空） */
const batchCategory = ref('')

// ===== 拖拽层级调整：draggingId 由 drag-start/drag-end 事件维护 =====
const draggingId = ref<string | null>(null)
/** 拖拽手柄在列表视图（非批量）下常驻可用：拖到目标卡片上即变为它的子任务 */
const dragEnabled = computed(() => view.value === 'list' && !batchMode.value)

// ===== 优先级等级系统（0-255）：选择/排序/筛选/删除等级后的自动重映射 =====
const { levels: priorityLevels, nearestLevel } = useTodoPriorities()

const searchQuery = ref('')
/** 搜索框 ref：Ctrl+F 聚焦使用 */
const todoSearchInput = ref<HTMLInputElement | null>(null)
/** 任务描述输入框（回车从标题跳转到描述时聚焦） */
const descriptionInput = ref<HTMLTextAreaElement | null>(null)

/** 标题回车跳描述：描述属高级项，先展开面板再聚焦 */
function goDescription() {
  if (!newTodo.value.title) return
  advancedOpen.value = true
  nextTick(() => descriptionInput.value?.focus())
}
const currentFilter = ref('pending')
const currentSort = ref('date-desc')

/** 响应式当前时间，用于截止时间到达时自动刷新逾期/筛选状态 */
const now = useNow()

const filters = computed(() => [
  { label: t('todo.all'), value: 'all' },
  { label: t('todo.today'), value: 'today' },
  { label: t('todo.active'), value: 'pending' },
  { label: t('todo.completed'), value: 'completed' },
  { label: t('todo.high_priority'), value: 'high' },
  { label: t('todo.overdue'), value: 'overdue' },
  { label: t('todo.overdue_completed'), value: 'overdue-completed' },
])

const sortOptions = computed(() => [
  { label: t('todo.newest'), value: 'date-desc' },
  { label: t('todo.oldest'), value: 'date-asc' },
  { label: t('todo.priority'), value: 'priority' },
  { label: t('todo.due_asc'), value: 'due-asc' },
  { label: t('todo.name'), value: 'name' },
])

/** 筛选按钮显示的标签：value→label 映射（避免点击后显示英文 value） */
const currentFilterLabel = computed(() => filters.value.find(f => f.value === currentFilter.value)?.label ?? currentFilter.value)

/** 当前等级系统中的最高档位（"高优先级"筛选口径，随用户自定义档位自适应） */
const highLevel = computed(() => {
  const ls = priorityLevels.value.map(l => l.level)
  return ls.length > 0 ? Math.max(...ls) : 255
})

// 提醒调度：统一由 reminderService 负责（智能提前提醒 30/10/5 分钟、自定义提醒、到期通知）。
// 服务挂载在主窗口（app.vue 启动），切换 Tab 卸载本组件不影响定时器；
// 本组件只负责在数据变化后把最新列表同步给服务。

// 计算属性（统计基于全量集合 statsTodos，流式加载下仍保证数字准确）
// 概览统计（总数/完成率/按时率）已迁至统计页 StatsPage，此处不再重复计算

/** 判断任务是否已逾期：有截止时间且早于当前时间（共享实现，见 app/src/todo/overdue.ts）。 */
const isOverdueTodo = (todo: Todo) => isTodoOverdue(todo, now.value)

/** 本地时区日期键 'YYYY-MM-DD'：「今天」聚合与日历视图统一口径 */
const ymdKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayKey = computed(() => ymdKey(new Date(now.value)))

/** 截止时间毫秒（无/非法 → 极大值，排序时排最后） */
const dueTimeOf = (t: Todo) => {
  if (!t.dueDate) return Number.MAX_SAFE_INTEGER
  const v = new Date(t.dueDate).getTime()
  return isNaN(v) ? Number.MAX_SAFE_INTEGER : v
}

const filteredAndSortedTodos = computed(() => {
  let filtered = todos.value

  if (searchQuery.value.trim()) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(todo =>
        todo.title.toLowerCase().includes(query) ||
        (todo.description && todo.description.toLowerCase().includes(query))
    )
  }

  // "已逾期"筛选仅显示已逾期且未完成的任务；"逾期完成"仅显示已完成且已逾期的任务；
  // 其余筛选（全部/进行中/已完成/高优先级）均包含逾期状态，不单独剔除。
  if (currentFilter.value === 'overdue') {
    filtered = filtered.filter(t => isOverdueTodo(t) && t.completed !== 1)
  } else if (currentFilter.value === 'overdue-completed') {
    filtered = filtered.filter(t => isOverdueTodo(t) && t.completed === 1)
  } else if (currentFilter.value === 'today') {
    // 「今天」聚合：今天到期的全部任务 + 逾期未完成的任务顺延进今天
    filtered = filtered.filter(t => {
      if (!t.dueDate) return false
      const d = new Date(t.dueDate)
      if (isNaN(d.getTime())) return false
      const key = ymdKey(d)
      return t.completed === 1 ? key === todayKey.value : key <= todayKey.value
    })
  }

  if (currentFilter.value === 'pending') {
    filtered = filtered.filter(t => !t.completed)
  } else if (currentFilter.value === 'completed') {
    filtered = filtered.filter(t => t.completed)
  } else if (currentFilter.value === 'high') {
    // "高优先级"跟随用户自定义档位：取等级系统中的最高档，
    // 不再硬编码 128（用户只配置 0-100 档位时原写法永远为空）
    filtered = filtered.filter(t => (t.priorityLevel ?? 127) === highLevel.value)
  }

  return [...filtered].sort((a, b) => {
    switch (currentSort.value) {
      case 'date-asc':
        return (parseInt(a.created_at || '0') || 0) - (parseInt(b.created_at || '0') || 0)
      case 'date-desc':
        return (parseInt(b.created_at || '0') || 0) - (parseInt(a.created_at || '0') || 0)
      case 'priority':
        // 数值优先级：越大越优先，降序
        return (b.priorityLevel ?? 127) - (a.priorityLevel ?? 127)
      case 'due-asc':
        // 截止时间升序：无截止时间的排最后
        return dueTimeOf(a) - dueTimeOf(b)
      case 'name':
        return a.title.localeCompare(b.title)
      default:
        return 0
    }
  })
})

// ===== 树组装：列表仅渲染顶级任务，子任务按 parentId 分组由父卡片内联渲染 =====
const topTodos = computed(() => filteredAndSortedTodos.value.filter(t => !t.parentId))

const childrenMap = computed(() => groupByParent(filteredAndSortedTodos.value))

/** 按 parentId 分组子任务（保持筛选排序后的相对顺序） */
function groupByParent(list: Todo[]): Map<string, Todo[]> {
  const map = new Map<string, Todo[]>()
  for (const t of list) {
    if (!t.parentId) continue
    const arr = map.get(t.parentId)
    if (arr) arr.push(t)
    else map.set(t.parentId, [t])
  }
  return map
}

// 方法
const { lastDueDate } = useDueDateMemory()

/** 上次选择的截止时间若仍在未来，则作为新增表单默认值；否则留空 */
function defaultDueDate(): string {
  const v = lastDueDate.value
  if (!v) return ''
  const t = new Date(v).getTime()
  if (isNaN(t) || t <= Date.now()) return ''
  return v
}

const toggleAddForm = () => {
  showAddForm.value = !showAddForm.value
  if (showAddForm.value) {
    // 截止时间默认套用上次选择（若仍有效），否则留空
    newTodo.value.dueDate = defaultDueDate()

    nextTick(() => {
      const titleInput = document.querySelector('input.todo-title-input') as HTMLInputElement
      titleInput?.focus()
    })
  }
}

/**
 * 统一 DB 写入包装：失败时 console.error 并返回 false（不产生 unhandled rejection），
 * 写库期间 pendingWrites > 0 使轮询跳过，避免旧数据覆盖乐观更新。
 * onFail：调用方可选的失败回调（收到原始 error，用于灵动岛等用户可见反馈）。
 */
async function withDbWrite(fn: () => Promise<void>, onFail?: (error: unknown) => void): Promise<boolean> {
  pendingWrites++
  try {
    await fn()
    return true
  } catch (error) {
    console.error('[todo] 数据库写入失败:', error)
    onFail?.(error)
    return false
  } finally {
    pendingWrites--
  }
}

/** 提取错误原因给灵动岛显示（Error message / 任意值字符串化，截断防溢出胶囊） */
const islandErrText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 100)

const addTodo = async () => {
  if (!newTodo.value.title.trim()) return

  const nowMs = Date.now()
  const todo: Todo = {
    id: uuidv4(),
    title: newTodo.value.title.trim(),
    description: newTodo.value.description.trim(),
    completed: 0,
    priorityLevel: newTodo.value.priorityLevel,
    category: newTodo.value.category,
    dueDate: newTodo.value.dueDate,
    remindMode: newTodo.value.remindMode,
    remindRules: newTodo.value.remindRules,
    tags: parseTagsText(newTodo.value.tagsText),
    links: [],
    recurrence: newTodo.value.recurrence ? { ...newTodo.value.recurrence } : undefined,
    created_at: String(nowMs),
    updated_at: String(nowMs)
  }

  const ok = await withDbWrite(() => clipboardService.insertTodo(todo), (error) => {
    notifyIsland({ kind: 'error', text: t('todo.island_add_failed', { reason: islandErrText(error) }) })
  })
  if (!ok) return
  prepend(todo)
  statsTodos.value.unshift(todo)
  void reminderService.sync(statsTodos.value)
  resetForm()

  showAddForm.value = false
  notifyIsland({ kind: 'success', text: t('todo.island_added', { title: todo.title.slice(0, 100) }) })
}

const resetForm = () => {
  newTodo.value = {
    title: '',
    description: '',
    priorityLevel: 127,
    category: '其他',
    dueDate: '',
    remindMode: 'smart',
    remindRules: [],
    tagsText: '',
    recurrence: undefined
  }
}

/** 查找任务：已加载列表优先，其次统计全量集合（日历视图的数据源可能含未加载任务） */
const findTodo = (id: string) => todos.value.find(t => t.id === id) ?? statsTodos.value.find(t => t.id === id)

/** 实体变更同步到已加载列表与统计全量集合（同一引用时 Object.assign 幂等） */
function syncTodoRef(todo: Todo) {
  const inList = todos.value.find(x => x.id === todo.id)
  if (inList && inList !== todo) Object.assign(inList, todo)
  applyToStats(todo)
}

/**
 * 循环任务完成：生成下一期（继承全部业务字段，刷新 id/完成态/时间戳；
 * sortOrder 继承原值使下一期出现在原位置附近，提醒规则继承相对规则自然顺延）。
 */
async function spawnRecurrenceNext(todo: Todo): Promise<void> {
  if (!todo.recurrence) return
  const nowMs = Date.now()
  const next: Todo = {
    ...todo,
    id: uuidv4(),
    completed: 0,
    dueDate: nextDueDate(todo.dueDate || '', todo.recurrence, nowMs),
    remindRules: [...(todo.remindRules ?? [])],
    tags: [...(todo.tags ?? [])],
    links: [...(todo.links ?? [])],
    created_at: String(nowMs),
    updated_at: String(nowMs),
  }
  const ok = await withDbWrite(() => clipboardService.insertTodo(next))
  if (!ok) return
  prepend(next)
  statsTodos.value.unshift(next)
}

const toggleTodo = async (id: string) => {
  const todo = findTodo(id)
  if (todo) {
    const prevCompleted = todo.completed
    const prevUpdatedAt = todo.updated_at
    const completing = todo.completed === 0
    todo.completed = completing ? 1 : 0
    todo.updated_at = String(Date.now())
    const ok = await withDbWrite(() => clipboardService.updateTodo(todo), () => {
      notifyIsland({ kind: 'error', text: t('todo.update_failed') })
    })
    if (!ok) {
      // 写库失败：回滚乐观更新，保证 UI 与数据库一致
      todo.completed = prevCompleted
      todo.updated_at = prevUpdatedAt
      return
    }
    // 灵动岛反馈：完成（success）/ 取消完成（info）
    notifyIsland({ kind: completing ? 'success' : 'info', text: t(completing ? 'todo.island_completed' : 'todo.island_uncompleted', { title: todo.title.slice(0, 100) }) })
    // 完成状态变化影响提醒计划，同步给调度服务（完成 → 撤销其全部提醒）
    syncTodoRef(todo)
    // 循环任务完成：生成下一期（仅顶级任务参与循环；下一期继承规则与业务字段）
    if (completing && todo.recurrence && !todo.parentId) {
      await spawnRecurrenceNext(todo)
    }
    void reminderService.sync(statsTodos.value)
    // 统计埋点（fire-and-forget）：仅"切换为完成"时 +1
    if (completing) void statsService.record({ todo_completed: 1 })
  }
}

const updateTodo = async (id: string, updates: Partial<Todo>) => {
  const todo = findTodo(id)
  if (todo) {
    Object.assign(todo, updates, { updated_at: String(Date.now()) })
    const ok = await withDbWrite(() => clipboardService.updateTodo(todo))
    if (!ok) return
    // 截止时间/提醒设置/完成状态可能变化，同步给调度服务重排
    syncTodoRef(todo)
    void reminderService.sync(statsTodos.value)
  }
}

/**
 * 点击待办删除：直接软删进回收站（可在回收站恢复，无需确认框）；
 * 子任务随父级联软删（仓储层 OR parent_id 处理）。
 */
const deleteTodo = async (id: string) => {
  const ok = await withDbWrite(() => clipboardService.deleteTodo(id), (error) => {
    notifyIsland({ kind: 'error', text: t('todo.island_delete_failed', { reason: islandErrText(error) }) })
  })
  if (!ok) return
  removeTodo(t => t.id === id || t.parentId === id)
  statsTodos.value = statsTodos.value.filter(t => t.id !== id && t.parentId !== id)
  void reminderService.sync(statsTodos.value)
  notifyIsland({ kind: 'info', text: t('todo.island_trashed') })
}

/** 优先级等级变更：持久化后由 sync/徽章响应式跟随 */
const changePriorityLevel = async (id: string, level: number) => {
  const todo = findTodo(id)
  if (todo) {
    todo.priorityLevel = level
    todo.updated_at = String(Date.now())
    await withDbWrite(() => clipboardService.updateTodo(todo))
    syncTodoRef(todo)
  }
}

/** 等级列表被管理器修改后：把引用了已删档位的待办重映射到最近档位 */
watch(priorityLevels, async (levels) => {
  const ls = levels.map(l => l.level)
  const changed: Todo[] = []
  for (const t of todos.value) {
    if (!ls.includes(t.priorityLevel ?? 127)) {
      t.priorityLevel = nearestLevel(t.priorityLevel ?? 127)
      t.updated_at = String(Date.now())
      changed.push(t)
    }
  }
  if (changed.length > 0) {
    await withDbWrite(async () => { await Promise.all(changed.map(t => clipboardService.updateTodo(t))) })
    changed.forEach(applyToStats)
  }
})

const changeCategory = async (id: string, category: string) => {
  const todo = findTodo(id)
  if (todo) {
    todo.category = category
    todo.updated_at = String(Date.now())
    await withDbWrite(() => clipboardService.updateTodo(todo))
    syncTodoRef(todo)
  }
}

/** 提醒设置（智能 / 多闹钟规则 / 不提醒）：持久化后同步调度服务重排 */
const changeReminder = async (id: string, mode?: Todo['remindMode'], rules?: ReminderRule[]) => {
  await updateTodo(id, {
    remindMode: mode || 'smart',
    remindRules: rules || [],
    remindAt: ''
  })
}

/** 分类列表（含用户增删后的状态） */
const { categories, addCategory, removeCategory } = useCategories()

// ===== 删除确认（DeleteConfirm 内联组件，样式/操作与便签一致）=====
// 仅「彻底删除（purge）」与「删除分类」需要确认；普通删除为软删（可恢复）无需确认
const deleteConfirmVisible = ref(false)
const deleteConfirmMessage = ref('')
let deleteConfirmAction: 'purge' | 'category' | null = null
let deleteConfirmId: string | null = null

/** 回收站「彻底删除」：先弹确认框（不可恢复） */
const askPurge = (id: string) => {
  deleteConfirmAction = 'purge'
  deleteConfirmId = id
  deleteConfirmMessage.value = t('todo.purge_confirm')
  deleteConfirmVisible.value = true
}

/** 点击分类 ×：弹出内联删除确认框 */
const handleCategoryDelete = (name: string) => {
  deleteConfirmAction = 'category'
  deleteConfirmId = name
  deleteConfirmMessage.value = t('todo.delete_category_confirm')
  deleteConfirmVisible.value = true
}

/** 确认删除：执行对应删除动作并关闭确认框 */
const onDeleteConfirm = () => {
  const action = deleteConfirmAction
  const id = deleteConfirmId
  deleteConfirmVisible.value = false
  deleteConfirmAction = null
  deleteConfirmId = null
  if (action === 'purge' && id) void executeTodoPurge(id)
  else if (action === 'category' && id) void executeCategoryDelete(id)
}

/** 取消删除：仅关闭确认框 */
const onDeleteCancel = () => {
  deleteConfirmVisible.value = false
  deleteConfirmAction = null
  deleteConfirmId = null
}

/** 确认后真正执行分类删除：持久化 + 清理使用该分类的待办（重置为剩余第一个分类） */
async function executeCategoryDelete(name: string) {
  const ok = await removeCategory(name)
  if (!ok) return
  // 回退分类取剩余的第一个；分类被删光时回退到「其他」并补回列表，
  // 避免待办被赋成一个 CategorySelect 里选不回的悬空分类
  let fallback = categories.value[0] ?? '其他'
  if (!categories.value.includes(fallback)) {
    await addCategory(fallback)
  }
  for (const todo of todos.value) {
    if (todo.category === name) {
      todo.category = fallback
      todo.updated_at = String(Date.now())
      await withDbWrite(() => clipboardService.updateTodo(todo))
      applyToStats(todo)
    }
  }
  if (newTodo.value.category === name) newTodo.value.category = fallback
}

// ===== 回收站（软删任务）：进入视图时加载；恢复/彻底删除均以顶级任务为单位（子任务级联） =====
const trashTodos = ref<Todo[]>([])
const trashTopTodos = computed(() => trashTodos.value.filter(t => !t.parentId))
const trashChildrenMap = computed(() => groupByParent(trashTodos.value))

/** 切到回收站视图时拉取软删列表（每次进入刷新，保持与库一致） */
watch(view, (v) => {
  if (v === 'trash') void loadTrash()
})

async function loadTrash() {
  try {
    trashTodos.value = await clipboardService.fetchDeletedTodos()
  } catch (e) {
    console.error('加载回收站失败:', e)
    trashTodos.value = []
  }
}

/** 恢复：清软删标记（子任务级联），刷新主列表与统计集合 */
async function restoreTodo(id: string) {
  const ok = await withDbWrite(() => clipboardService.restoreTodo(id), () =>
    notifyIsland({ kind: 'error', text: t('todo.update_failed') }))
  if (!ok) return
  trashTodos.value = trashTodos.value.filter(t => t.id !== id && t.parentId !== id)
  notifyIsland({ kind: 'success', text: t('todo.island_restored') })
  // 恢复的任务可能不在已加载页内，强制整表刷新
  await fetchTodos({ force: true })
}

/** 确认后彻底删除：真 DELETE（子任务级联），不可恢复 */
async function executeTodoPurge(id: string) {
  const ok = await withDbWrite(() => clipboardService.purgeTodo(id))
  if (!ok) return
  trashTodos.value = trashTodos.value.filter(t => t.id !== id && t.parentId !== id)
  removeTodo(t => t.id === id || t.parentId === id)
  statsTodos.value = statsTodos.value.filter(t => t.id !== id && t.parentId !== id)
  void reminderService.sync(statsTodos.value)
  notifyIsland({ kind: 'success', text: t('todo.island_purged') })
}

// ===== 拖拽层级调整：落在目标任务卡片上 = 变为它的子任务 =====
async function handleDrop(targetId: string, pos: 'before' | 'after' | 'child') {
  const srcId = draggingId.value
  draggingId.value = null
  if (!srcId || srcId === targetId) return
  const src = findTodo(srcId)
  const target = findTodo(targetId)
  if (!src || !target || src.parentId) return // 仅顶级任务参与拖拽
  if (pos !== 'child') return // 同级重排已随手动排序模式移除，仅保留层级调整

  // 单层嵌套：目标必须是顶级任务；带子任务的任务不能变为子任务（避免出现孙层级）
  if (target.parentId || (childrenMap.value.get(srcId)?.length ?? 0) > 0) return
  const siblings = todos.value.filter(t => t.parentId === targetId && t.id !== srcId)
  src.parentId = targetId
  src.sortOrder = siblings.length ? Math.max(...siblings.map(s => s.sortOrder ?? 0)) + 1 : 0
  src.updated_at = String(Date.now())
  const ok = await withDbWrite(() => clipboardService.updateTodo(src), () =>
    notifyIsland({ kind: 'error', text: t('todo.update_failed') }))
  if (!ok) return
  syncTodoRef(src)
}

/** 子任务提升为顶级：parentId 置空（写 NULL），追加到顶级末尾 */
async function promoteTodo(id: string) {
  const child = findTodo(id)
  if (!child?.parentId) return
  const maxOrder = topTodos.value.reduce((m, t) => Math.max(m, t.sortOrder ?? 0), -1)
  child.parentId = undefined
  child.sortOrder = maxOrder + 1
  child.updated_at = String(Date.now())
  const ok = await withDbWrite(() => clipboardService.updateTodo(child), () =>
    notifyIsland({ kind: 'error', text: t('todo.update_failed') }))
  if (!ok) return
  syncTodoRef(child)
}

/** 添加子任务：继承父级分类/优先级，排序追加到兄弟末尾 */
async function addChild(parentId: string, title: string) {
  const parent = findTodo(parentId)
  if (!parent || parent.parentId) return
  const nowMs = Date.now()
  const siblings = todos.value.filter(t => t.parentId === parentId)
  const child: Todo = {
    id: uuidv4(),
    title,
    description: '',
    completed: 0,
    priorityLevel: parent.priorityLevel,
    category: parent.category ?? '',
    dueDate: '',
    remindMode: 'smart',
    remindRules: [],
    parentId,
    sortOrder: siblings.length ? Math.max(...siblings.map(s => s.sortOrder ?? 0)) + 1 : 0,
    tags: [],
    links: [],
    created_at: String(nowMs),
    updated_at: String(nowMs),
  }
  const ok = await withDbWrite(() => clipboardService.insertTodo(child), (error) =>
    notifyIsland({ kind: 'error', text: t('todo.island_add_failed', { reason: islandErrText(error) }) }))
  if (!ok) return
  todos.value.push(child)
  statsTodos.value.push(child)
  void reminderService.sync(statsTodos.value)
  notifyIsland({ kind: 'success', text: t('todo.island_added', { title: title.slice(0, 100) }) })
}

// ===== 批量操作：多选后统一完成/分类/删除（子任务随父级联） =====
function toggleBatchMode() {
  batchMode.value = !batchMode.value
  batchSelectedIds.value = new Set()
}

function toggleBatchSelect(id: string) {
  const next = new Set(batchSelectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  batchSelectedIds.value = next
}

/** 全选/清空：以当前可见顶级任务为准 */
function toggleSelectAll() {
  const all = topTodos.value.map(t => t.id)
  const allSelected = all.length > 0 && all.every(id => batchSelectedIds.value.has(id))
  batchSelectedIds.value = allSelected ? new Set() : new Set(all)
}

function exitBatch() {
  batchMode.value = false
  batchSelectedIds.value = new Set()
}

/** 批量完成：未完成任务逐条置完成（循环任务同步生成下一期），汇总一条灵动岛反馈 */
async function batchComplete() {
  const targets = [...batchSelectedIds.value]
      .map(id => findTodo(id))
      .filter((t): t is Todo => !!t && t.completed === 0)
  if (targets.length === 0) return
  for (const todo of targets) {
    todo.completed = 1
    todo.updated_at = String(Date.now())
  }
  const ok = await withDbWrite(async () => {
    for (const todo of targets) await clipboardService.updateTodo(todo)
  }, () => notifyIsland({ kind: 'error', text: t('todo.update_failed') }))
  if (!ok) return
  targets.forEach(syncTodoRef)
  // 循环任务生成下一期（写库成功后再生成，避免失败残留）
  for (const todo of targets) {
    if (todo.recurrence && !todo.parentId) await spawnRecurrenceNext(todo)
  }
  void statsService.record({ todo_completed: targets.length })
  void reminderService.sync(statsTodos.value)
  notifyIsland({ kind: 'success', text: t('todo.island_batch_done', { n: targets.length }) })
  exitBatch()
}

/** 批量删除：软删进回收站（可恢复），子任务随父级联 */
async function batchDelete() {
  const ids = [...batchSelectedIds.value]
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const ok = await withDbWrite(async () => {
    for (const id of ids) await clipboardService.deleteTodo(id)
  }, (error) => notifyIsland({ kind: 'error', text: t('todo.island_delete_failed', { reason: islandErrText(error) }) }))
  if (!ok) return
  removeTodo(t => idSet.has(t.id) || (!!t.parentId && idSet.has(t.parentId)))
  statsTodos.value = statsTodos.value.filter(t => !idSet.has(t.id) && !(t.parentId && idSet.has(t.parentId)))
  void reminderService.sync(statsTodos.value)
  notifyIsland({ kind: 'success', text: t('todo.island_batch_deleted', { n: ids.length }) })
  exitBatch()
}

/** 批量设置分类：选中任务统一改分类（CategorySelect 选择即应用） */
async function batchSetCategory(category: string) {
  const ids = [...batchSelectedIds.value]
  if (!category || ids.length === 0) return
  const targets = ids.map(id => findTodo(id)).filter((t): t is Todo => !!t)
  if (targets.length === 0) return
  for (const todo of targets) {
    todo.category = category
    todo.updated_at = String(Date.now())
  }
  const ok = await withDbWrite(async () => {
    for (const todo of targets) await clipboardService.updateTodo(todo)
  }, () => notifyIsland({ kind: 'error', text: t('todo.update_failed') }))
  if (!ok) return
  targets.forEach(syncTodoRef)
  notifyIsland({ kind: 'success', text: t('todo.island_batch_categorized', { n: targets.length }) })
  batchCategory.value = ''
  exitBatch()
}

// ===== 日历视图：数据源为全量集合（跨月可见未加载任务）；改期复用 updateTodo 通路 =====
const calendarTodos = computed(() => statsTodos.value)

/** 日历拖拽改期：保留原时刻仅改日期（TodoCalendar 已处理），持久化并重排提醒 */
async function changeDueFromCalendar(id: string, dueDate: string) {
  await updateTodo(id, { dueDate })
}

// ===== 任务模板：一键应用 / 将当前表单存为模板（存 KV，跨会话保留） =====
const { templates, saveTemplate, removeTemplate } = useTodoTemplates()

/** 当前表单存为模板：模板名取任务标题（重名允许，以 id 区分） */
async function saveAsTemplate() {
  const title = newTodo.value.title.trim()
  if (!title) return
  const ok = await saveTemplate({
    name: title,
    title,
    description: newTodo.value.description,
    priorityLevel: newTodo.value.priorityLevel,
    category: newTodo.value.category,
    tags: parseTagsText(newTodo.value.tagsText),
    recurrence: newTodo.value.recurrence ? { ...newTodo.value.recurrence } : undefined,
  })
  if (ok) notifyIsland({ kind: 'success', text: t('todo.template_saved') })
}

/** 应用模板：回填表单（模板不携带截止时间/提醒——多与具体任务时间相关） */
function applyTemplate(tpl: TodoTemplate, close: () => void) {
  showAddForm.value = true
  advancedOpen.value = true
  newTodo.value.title = tpl.title
  newTodo.value.description = tpl.description
  newTodo.value.priorityLevel = tpl.priorityLevel
  if (tpl.category) newTodo.value.category = tpl.category
  newTodo.value.tagsText = tpl.tags.join(' ')
  newTodo.value.recurrence = tpl.recurrence ? { ...tpl.recurrence } : undefined
  close()
}

// ===== 自然语言录入：一句话 → AI 解析 → 回填表单（需在设置页接入 AI） =====
const nlpText = ref('')
const nlpParsing = ref(false)

async function parseNlp() {
  const text = nlpText.value.trim()
  if (!text || nlpParsing.value) return
  nlpParsing.value = true
  try {
    const result = await parseTodoFromText(text, { categories: categories.value })
    showAddForm.value = true
    advancedOpen.value = true
    newTodo.value.title = result.title
    newTodo.value.description = result.description
    newTodo.value.priorityLevel = result.priorityLevel
    if (result.category) newTodo.value.category = result.category
    if (result.dueDate) newTodo.value.dueDate = result.dueDate
    newTodo.value.tagsText = result.tags.join(' ')
    nlpText.value = ''
    notifyIsland({ kind: 'success', text: t('todo.nlp_done') })
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e)
    const key = code === NLP_ERR_NOT_CONFIGURED
        ? 'todo.nlp_no_ai'
        : code === NLP_ERR_BAD_RESPONSE ? 'todo.nlp_bad_response' : 'todo.nlp_failed'
    notifyIsland({ kind: 'error', text: t(key, { reason: code.slice(0, 60) }) })
  } finally {
    nlpParsing.value = false
  }
}

const setFilter = (filter: string) => {
  currentFilter.value = filter
}

const setSort = (sort: string) => {
  currentSort.value = sort
}

// 筛选/排序下拉：UiDropdown 统一管理开关（点击开/关、外部点击与 Escape 收起、选择后自动收起）

const fetchTodos = async (opts?: { force?: boolean }) => {
  // 上一轮未完成不重叠；写库进行中跳过本轮（防止拿旧数据覆盖乐观更新造成复选框回跳/竞态）
  if (fetching) return
  if (!opts?.force && pendingWrites > 0) return
  fetching = true
  try {
    // 确保调度服务已启动（幂等；正常由 app.vue 更早启动，此处兜底覆盖"直达待办 Tab"的场景）
    await reminderService.start()
    // 全量查询（500 条上限）仅用于统计卡片与提醒调度，不参与列表渲染
    const fetchedTodos = await clipboardService.fetchTodos({ value: { searchContent: '' } });
    statsTodos.value = fetchedTodos
    // 把最新列表同步给调度服务（内部按计划 diff，仅增删变化的定时器；首个 sync 处于补发阶段）
    void reminderService.sync(fetchedTodos)
    // 搜索态：保持搜索结果的实时刷新（全量 LIKE 查询，一次性展示全部匹配），不被普通列表覆盖
    const q = searchQuery.value.trim()
    if (q) {
      try {
        const matches = await clipboardService.fetchTodos({ value: { searchContent: q } })
        replace(matches)
      } catch (e) {
        console.error('搜索任务失败:', e)
      }
      return
    }
    // UI 仅刷新已加载范围（与 loadMore/reload 互斥；签名一致时跳过整表替换，避免全列表重渲染）
    await refreshLoaded()
  } catch (error) {
    console.error("Failed to fetch todos:", error);
  } finally {
    fetching = false
  }
}

// ===== 搜索：全量查库一次性展示全部匹配（涵盖未加载任务）；清空搜索重置为流式第一页 =====
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void onSearchQueryChange(q.trim()), 300)
})

async function onSearchQueryChange(q: string) {
  if (!q) {
    // 等待轮询中的全量刷新结束再重置（busy 互斥导致跳过时最多重试 2 秒）
    while (fetching) await new Promise(r => setTimeout(r, 50))
    for (let i = 0; i < 20; i++) {
      if (await reload()) break
      await new Promise(r => setTimeout(r, 100))
    }
    return
  }
  try {
    const matches = await clipboardService.fetchTodos({ value: { searchContent: q } })
    replace(matches)
  } catch (e) {
    console.error('搜索任务失败:', e)
  }
}

// 生命周期
onMounted(async () => {
  await fetchTodos() // 先完成首次加载并进入调度（含启动补发汇总）

  // 方向键下移到已加载末尾时，触发加载下一页（todoStore 由全局方向键命令驱动）
  setTodoLoadMoreHook(() => { if (hasMore.value) void loadMore() })

  // Ctrl+F：聚焦待办搜索框
  bus.on('focus-search', onFocusSearch)

  // Ctrl+Enter：进入选中待办的编辑态
  bus.on('todo:edit-request', onEditRequest)

  // Del：删除当前选中的待办
  bus.on('todo:delete-request', onDeleteRequest)

  // 仅在 Tauri 桌面容器内定时从数据库刷新列表（数据同步用；提醒由调度服务的精确定时器负责）。
  // 3s 粒度 + in-flight 去重 + 签名跳过 + 写库期间挂起；窗口隐藏（托盘驻留）时暂停轮询。
  if (isTauri()) {
    pollTimer = setInterval(() => {
      if (!document.hidden) void fetchTodos()
    }, 3000)
    // 窗口重新可见时立即刷新一次
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
})

/** 窗口从隐藏恢复可见：立即拉取一次，弥补暂停期间的空窗 */
const onVisibilityChange = () => {
  if (!document.hidden) void fetchTodos()
}

onBeforeUnmount(() => {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  // 提醒定时器由主窗口的 reminderService 持有，切 Tab 卸载本组件不影响提醒
  setTodoLoadMoreHook(null)
  if (searchTimer) clearTimeout(searchTimer)
  bus.off('focus-search', onFocusSearch)
  bus.off('todo:edit-request', onEditRequest)
  bus.off('todo:delete-request', onDeleteRequest)
})

/** 列表同步：顶级任务列表 → todoStore（供方向键选择/编辑使用，子任务不参与导航），并修正越界选中 */
watch(topTodos, (list) => {
  todoList.value = list
  if (selectedTodoIndex.value >= list.length) {
    selectedTodoIndex.value = Math.max(0, list.length - 1)
  }
  if (selectedTodoIndex.value < 0) {
    selectedTodoIndex.value = 0
  }
}, { immediate: true })

/** Ctrl+Enter：让当前选中的待办进入编辑态 */
const onEditRequest = () => {
  if (todoList.value.length === 0) return
  editSignal.value += 1
}

/** Del 键：对当前选中待办执行软删（进回收站，可恢复；与点击卡片删除按钮同一流程） */
const onDeleteRequest = () => {
  if (batchMode.value) return
  const todo = todoList.value[selectedTodoIndex.value]
  if (!todo) return
  void deleteTodo(todo.id)
}

/** 点击列表行：选中对应索引 */
const selectTodoIndex = (index: number) => {
  selectTodo(index)
}

/** Ctrl+F 聚焦待办搜索框 */
const onFocusSearch = () => {
  nextTick(() => todoSearchInput.value?.focus())
}
</script>