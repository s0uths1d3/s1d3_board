# 模块交互（跨模块联动）实现文档

剪贴板 / 待办 / 便签 / 统计 / 灵动岛 / 环盘之间的 8 项交互能力。核心设计：**共享分发管道 + 事件驱动**——所有「剪贴板内容 → 待办/便签」的落地动作收敛到 `app/src/commands/local/dispatchClip.ts`，各触发入口只负责收集意图；跨窗口动作经 Tauri 事件（`island:dispatch`）由主窗口落库，主窗口内跳转经进程内总线（`global-search:jump`）。

## 功能总览

| # | 能力 | 入口 | 落点 |
|---|------|------|------|
| 1 | 剪贴板 → 待办/便签 | 列表右键菜单 | `index.vue` ctxMenuItems |
| 2 | 统计榜跳转筛选 | 统计页「来源应用」榜行点击 | `StatsPage.vue` → `filter.sourceApp` + 切剪贴板 Tab |
| 3 | 便签 → 复制/待办 | 便签卡「更多操作」菜单 | `StickyNoteItem.vue` → `StickyNote.vue` |
| 4 | 待办 → 便签 | 待办行内按钮 | `Todoitem.vue` → `TodoList.vue` |
| 5 | 岛胶囊快捷动作 | 灵动岛胶囊悬停展开动作组 | `bubble.vue` → emit `island:dispatch` |
| 6 | 拖拽到 Tab 分发 | 剪贴板行拖到待办/便签 Tab | `TitleBar.vue`（自定义 MIME `application/x-s1de-clip` 识别来源） |
| 7 | 环盘分段落地 | 环盘气泡卡片动作按钮 | `RingBubbleCard` → `RingOverlay` → `bubble.vue` → emit `island:dispatch` |
| 8 | 全局搜索 | Ctrl+P 命令面板 | `GlobalSearch.vue` 聚合查询 + 跳转定位 |

## 共享分发管道（dispatchClip.ts）

- `clipToTodos(content, sourceClip?)`：多行清单逐条建待办（`- [ ]`/`- [x]`/`-`/`*`/`•` 前缀剥离，勾选态映射完成态；单行无前缀整行一条），默认最低优先级；`sourceClip` 以 `{ title: 'clipboard', url: 原文 }` 记入待办 links。
- `clipToNote(content)`：原文落便签，默认配色第一项。
- `CLIP_SOURCE_LINK_TITLE = 'clipboard'`：来源标记常量，待办完成回写时据此识别。

## 跨窗口事件流（岛 / 环盘 → 主窗口）

岛与环盘都是独立窗口，不直接写库。统一事件契约：`emit('island:dispatch', { action: 'todo' | 'note', text })`，主窗口 `index.vue` 监听后走 `clipToTodos`（带来源链接）/ `clipToNote` 落库，并以灵动岛提示反馈结果（成功/失败）。环盘触发时附带 `ring:close` 关环。

## 全局搜索（Ctrl+P）

- 注册：`InitShortcuts.ts` `global_search`（local scope，默认 `CommandOrControl+P`）→ `GlobalSearchCommand` 派发总线事件 `global-search:toggle`。
- 面板：`components/common/GlobalSearch.vue`，Teleport 到 body；输入 250ms 防抖后并行查三模块（各取前 20 条，统一走高级搜索词法）+ 本地过滤设置项，↑↓/悬停选择、Enter/点击跳转、✕ 按钮关闭（Esc 不关闭，仅吞掉防落「隐藏主窗口」；IME 组合中的按键放行输入法）；打开期间以 capture 阶段 keydown 拦截方向键/回车/Esc，抢在 ShortcutManager 之前（同 DeleteConfirm 模式）。
- 高级搜索（独立共享，与剪贴板完全一致）：
  - 词法核心 `parseSearchTokens` + `likePatternFromToken`（`src/core/db/sql.ts`）——空格拆词组间 AND、`|` 组内 OR、双引号整句、`*`/`?` 通配符；关闭时整串字面单词元。待办/便签仓储经共享 helper `buildLikeGroups(input, field, advanced)` 接入，开关随 `filter.advanced`（缺省视为开启，同剪贴板）；空搜索词无 LIKE 条件，调度/全量场景行为不变。
  - 帮助面板 `components/common/SearchHelpPanel.vue`（? 按钮 + 弹出说明 + 点外收起自治）：剪贴板搜索区与全局搜索面板共用同一组件、同一套 `clip.search_help_*` 文案。
  - 全局面板开关：与剪贴板同款魔棒按钮（内存态默认开，不持久化），三个 DB 查询统一透传 `advanced`。
- 设置项搜索：分组静态清单移至 `src/setting/settingGroups.ts`（SettingMain 与 GlobalSearch 共用单一来源），面板按当前语言文案或 label 键包含匹配（与设置页搜索同语义）。
- 跳转契约：总线事件 `global-search:jump`（载荷 `{ module, query, clipId? }`），各模块监听并按 module 过滤：
  - clip → `index.vue`：搜索词写入高亮词联动既有防抖重查，切 Tab 后按条目 id 选中定位；
  - todo → `TodoList.vue`：写入搜索词走既有防抖搜索管道，视图强制回列表（日历/回收站不展示搜索结果）；监听器注册在 onMounted 首个 await 之前（跳转派发发生在挂载后立即）；
  - note → `StickyNote.vue`：切「全部」范围 + 写入搜索词，既有 watcher 查库刷新；
  - setting → `SettingMain.vue`：写入设置搜索词进入跨分组搜索态，右侧即命中项列表（可经「前往分组」落到具体分组）。

## 待办完成 → 剪贴板使用计数回写

经「转为待办」创建的任务（links 含 `clipboard` 标记）完成时，`TodoList.vue` toggleTodo 对每个来源链接调 `increaseUseCountByContent(原文)` 反哺剪贴板使用统计。

## i18n

新增键（zh-cn / en-us 对称）：`clip.ctx_to_todo|ctx_to_note|dispatched_todo|dispatched_todos|dispatched_note|dispatch_failed`、`note.more_actions|copy_content|to_todo|copied|copy_failed`、`todo.to_note|island_to_note|island_to_note_failed`、`island.to_todo|to_note`、`shortcut.global_search`、`global_search.*`（面板文案与模块徽标）。

## 变更记录

- 2026-10-15：首版实现全部 8 项模块交互；全局搜索快捷键 Ctrl+P（可自定义）。
