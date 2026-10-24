# 待办（todo）

> 带优先级、分类、截止日期、智能/自定义提醒与循环规则的本地待办清单，列表/日历双视图 + 回收站。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 创建任务 | 标题 + 优先级 + 截止 + 分类为基础项；描述/提醒/标签/循环/模板折叠在「更多选项」面板 | 待办页新增表单 |
| 编辑任务 | 选中后进入编辑面板，字段与新增一致（含标签/链接/提醒/循环） | 选中卡片 / `Ctrl+Enter` |
| 删除任务 | 软删进回收站（无确认框，误删可恢复），灵动岛反馈 | 卡片删除按钮 / `Delete` |
| 优先级 | 0-255 数值等级，内置低/中/高映射 0/127/255；等级可自定义（名称/颜色/数值增删改，改后其余值自动重映射到最近档位） | PrioritySelect / 卡片优先级下拉 / TodoPriorityManager |
| 分类 | 单选分类（内置「工作/学习/生活/娱乐/其他」+ 自定义增删），显示层翻译（数据库存原始值） | CategorySelect |
| 截止日期 | DueTimeSelect 快捷选择：今天 23:59/明天/后天/下周、30 分钟后/1 小时后/3 小时后、上次选择、自定义 DatePicker、清除 | 表单与卡片截止胶囊 |
| 截止记忆与分组 | 最近 5 条历史、内置分组（recent/duration/date）+ 自定义分组（重命名/删除/默认展开）、历史与默认项自定义别名 | DueTimeSelect 面板 |
| 智能提醒 | 按任务长短分档：长任务（创建距截止 ≥1h）截止前 30/10 分钟各一次；短任务截止前 5 分钟一次；到期时刻通知 | ReminderPicker「智能」（默认） |
| 自定义提醒 | 闹钟规则列表自由增删：按百分比 / 提前分钟 / 指定时刻三类，规则条数即提醒次数 | ReminderPicker「自定义」 |
| 到期提醒与补发 | 到点合成提示音 + 灵动岛 + 系统通知；重启后错过的提醒合并汇总补发（1 条单独发、多条合并） | 自动 |
| 循环/重复任务 | 每天/每周/每月/每年 + 间隔 + 周几多选（周）/几号（月）；下一期起算基准可选按截止顺延或按完成时刻 | RecurrencePicker |
| 循环下一期 | 完成当前一期自动生成下一期未完成任务，全字段继承（描述/优先级/分类/标签/链接/提醒规则），卡片显示循环徽章 | 自动 / 循环摘要 tooltip |
| 子任务 | 单层嵌套；子任务缩进展示在父卡片下，父卡片显示 n/m 进度徽章；父子完成状态双向联动 | 卡片「添加子任务」 |
| 拖拽层级调整 | 拖卡片到目标任务变为其子任务；子任务提供「提升为顶级」按钮 | 卡片左侧拖拽手柄 |
| 标签 | 自由关键字（空格/逗号/顿号分隔，去空去重最多 8 个），卡片金色弱化徽章（不提供筛选入口） | 表单/编辑面板标签输入 |
| 链接 | 附加 URL（可选名称，自动补 `https://`），卡片链形图标 + tooltip 列表，点击经系统浏览器打开 | 编辑面板「添加链接」 |
| 筛视图 | 全部 / 今天（逾期顺延聚合）/ 进行中 / 已完成 / 高优先级 / 逾期 / 逾期已完成 | 列表头部筛选下拉 |
| 排序 | 最新 / 最旧 / 优先级 / 按截止升序 / 名称 | 列表头部排序下拉 |
| 日历视图 | 独立顶级 Tab：月网格 + 拖拽改期（保留原时刻仅改日期）+ 日期点选明细；逾期未完成并入今天格（红色标识） | 导航「日历」Tab |
| 回收站 | 软删任务列表（显示删除时间），支持恢复 / 彻底删除（确认框）；Ctrl+点击加选、Shift+点击范围选批量 | 视图切换按钮 |
| 任务模板 | 表单配置存为模板（标题/描述/优先级/分类/标签/循环，不含提醒），套用即回填；模板可删除 | 表单「存为模板」+ 模板下拉 |
| 批量操作 | 多选模式下批量完成 / 批量删除（进回收站）/ 批量改分类（选择即应用）；Esc 或退出按钮结束 | 列表头部「批量管理」 |
| NLP 快速录入 | 一句话描述 → AI 解析标题/截止/优先级/分类/标签回填表单（可修改后再提交，不直接落库） | 表单 AI 解析按钮（依赖设置页 AI 配置） |
| 搜索 | 防抖搜索 + 高级词法（空格 AND、`\|` 组内 OR、双引号整句、`*`/`?` 通配符）+ 大小写区分 | 搜索框 / `Ctrl+F` 聚焦 |
| 键盘导航 | ↑/↓ 选中上一项/下一项（滚到已加载末尾自动加载下一页） | `↑` / `↓` |
| 全局搜索联动 | `Ctrl+P` 面板命中待办后跳转本页并写入搜索词（视图强制回列表） | `Ctrl+P` |
| 灵动岛反馈 | 完成/取消完成、更新失败、循环下一期等操作统一弹岛 | 自动 |

## 关键行为

### 完成态切换与父子联动
`toggleTodo` 是完成态切换的唯一入口，完成后依次执行：

- 灵动岛反馈（完成 success / 取消 info）。
- 循环任务生成下一期（仅顶级任务，`!parentId` 防御）。
- 提醒重排：完成即撤销其全部已排程提醒（全量重算 diff）。
- 统计埋点 `todo_completed`（仅「切换为完成」时 +1，级联不重复计）。
- 来源剪贴板回写：links 含 `clipboard` 标记时调 `increaseUseCountByContent` 反哺使用计数。

父子联动基于全量集合 `statsTodos`（未加载进列表的子任务也联动）：勾/取消主任务同步全部子任务；子任务全部完成时主任务自动完成，任一子任务取消则已完成的主任务回退。写库失败回滚乐观更新。见 `app/composables/useTodoCore.ts:138`（父子联动 165-194、回写 158-162）。

### 循环下一期推算
纯函数 `nextDueDate` 的规则语义：

- `from='due'`：以当前截止时间为基准顺延（固定日程，如「每周一开会」）。
- `from='complete'`：以完成时刻为基准计算并保留原截止时分（滚动节奏，「几点做」不变）。
- weekly 优先取 weekdays 中晚于基准的下一个命中日（最多扫 interval 周，无命中兜底 +interval 周）。
- monthly 日期钳制到目标月最后一天（1/31→2/28 不进位）；yearly 闰日 2/29 → 平年 2/28。

下一期以新 uuid 插入并 prepend 进列表，继承描述/优先级/分类/标签/链接/提醒规则，`sort_order` 沿用原位（出现在原位置附近）。见 `app/src/todo/recurrence.ts:76`（describeRecurrence 105）、`app/composables/useTodoCore.ts:98`。

### 智能提醒分档与补发
策略纯函数 `computeReminders`（无副作用，每次数据变化全量重算）：

- 完成 → 空计划；无截止时间 → 仅「指定时刻」闹钟可排程。
- 智能分档按「创建时刻距截止的总时长 runway」：≥1 小时长任务截止前 30/10 分钟各一次，否则短任务截止前 5 分钟一次；另有到期时刻通知。
- 距现在不足 2 分钟的未来阶段直接丢弃（临期创建不轰炸）；已错过但截止未到的阶段进 missed 集合（自定义闹钟即便晚于截止也补发）。

调度服务 `reminderService`（app 级单例）负责执行：

- 与现有定时器 diff 增删；已发记录持久化到 KV `todo_remind_fired`（30 天 TTL）防重启重复轰炸。
- 30s 兜底扫描把窗口隐藏/休眠导致 setTimeout 被节流的到点条目直接触发（inFlight 防并发双发）。
- 启动补发阶段多条合并为一条汇总通知（超过 5 条显示「等 N 项」）。
- 超远期定时器按 2^31-1ms 分段续排（WebView setTimeout 32 位溢出防护）。
- 触发前复核任务最新状态与 key 有效性（期间被完成/改期/删除则放弃；查询失败指数退避重试 5 次）。

见 `app/src/todo/reminderPolicy.ts:79`、`app/src/todo/reminderService.ts:136`（sweep 197、flushCatchUp 218、handleFire 243）。

### 提醒发送通道
触发时三通道并行，各自独立门控：

- 合成提示音（`playNotificationSound`，无开关）。
- 灵动岛提醒（受岛总开关门控，设置关闭自动跳过）。
- 系统通知（受「待办系统通知」开关门控，默认开；关闭时跳过权限请求避免无谓弹窗）。

Windows 走 Rust 命令 `send_system_notification` 显式携带 AppId（避免 toast 来源显示「Windows PowerShell」），其他平台走 tauri-plugin-notification。智能提醒另有全局开关 `todo_smart_remind`（默认开）：关闭时提前类/自定义类不排程，仅保留到期通知，切换立即生效无需等轮询。见 `app/src/todo/reminderService.ts:294`、`app/composables/useTodoSmartRemind.ts`、`app/composables/useTodoSystemNotify.ts`。

### NLP 快速录入
`parseTodoFromText` 把一句话交给 AI：

- system prompt 要求严格只输出 JSON（title/description/dueDate/priorityLevel/category/tags），并注入当前本地时间（含星期）供相对日期（今天/明天/下周三/3 天后）推算。
- 响应剥 ```json 围栏 + 截取首尾大括号容错后解析，字段白名单化：title 必填、dueDate 规范化（非法回退空串）、priorityLevel 收敛 0-255 默认 127、category 仅接受已有分类、tags 去重最多 8 个。
- 失败按错误码分流：未配置 AI（引导去设置页）/ 响应格式异常 / 其他失败（经 briefAiError 缩短展示），统一走灵动岛提示。
- 解析结果只回填表单不直接落库；dueDate 解析失败仅回填其余字段不阻塞。

见 `app/src/todo/todoNlp.ts:102`。

### 逾期判定与「今天」聚合
`isTodoOverdue` 统一列表筛选、卡片徽标与统计口径：有截止时间、解析成功且早于当前时刻（非法日期串视为未逾期，而非 NaN 比较的偶然 false）。「今天」视图聚合今天到期 + 全部逾期未完成（逾期自动顺延到今天直到完成），已完成任务仅显示今天完成的；页面用 `useNow` 响应式时间，截止到达时逾期/筛选状态自动刷新。见 `app/src/todo/overdue.ts:8`、`app/components/todo/TodoList.vue:487`。

### 数据刷新与竞态防护
- 列表走流式分页（`useInfiniteList`，每页 50），签名 `${id}:${updated_at}:${completed}` 一致时跳过整表替换，避免全列表重渲染。
- 全量集合 `statsTodos` 由 3s 轮询维护：窗口隐藏/托盘驻留暂停、恢复可见立即补拉一次；TodoList 与日历页互斥挂载，轮询不叠加。
- 写库进行中（`pendingWrites > 0`）与上一轮拉取未完成时轮询跳过，防止旧数据覆盖乐观更新；全量拉取 in-flight 去重。

见 `app/composables/useTodoPolling.ts:11`、`app/composables/useTodoCore.ts:76`、`app/components/todo/TodoList.vue:413`。

### 核心链路共享（列表 ⇄ 日历）
TodoList 与独立日历页（TodoCalendarPage）共用 `useTodoCore` 模块级单例：同一份 `statsTodos` 与同一套变更函数，业务规则（父子联动/循环/回写/提醒重排/统计埋点）只存在一份，两处宿主零重复。日历拖拽改期保留原时刻仅改日期，走 `updateTodo` 通路（同步提醒调度重排）。列表侧经 `registerTodoListBridge` 把「实体同步 / 新增前置」两个钩子注入共享核心（流式列表的乐观更新联动）。见 `app/components/todo/TodoCalendarPage.vue:16`、`app/composables/useTodoCore.ts:36`。

### 键盘交互
- `↑`/`↓`（`CursorMoveCommand` → todoStore）驱动选中；滚到已加载末尾自动加载下一页（回收站视图无分页语义，导航对象自动切换为回收站顶级任务）。
- `Ctrl+Enter` 在待办页由 `ContextEditCommand` 派发 `todo:edit-request`，让当前选中项进入编辑态并聚焦标题输入框。
- `Delete` 由 `DelCommand` 在待办 Tab 派发 `todo:delete-request` 执行软删（与点击删除按钮同一流程）。
- `Ctrl+F` 聚焦待办搜索框；全局搜索跳转监听注册在 onMounted 首个 await 之前（跳转派发发生在挂载后立即）。

见 `app/src/commands/local/ContextEditCommand.ts:11`、`app/src/commands/local/DelCommand.ts:5`、`app/components/todo/TodoList.vue:1180`。

### 截止时间记忆与分组
DueTimeSelect 底层由 `useDueDateMemory`（模块级单例）管理，全部持久化到 settings 表（`last_due_date` / `due_date_groups` 等多个 KV）：

- 最近 5 条历史供「之前选择」分组。
- 内置分组（recent/duration/date）+ 用户自定义分组：重命名、删除、设唯一默认展开。
- 历史时间与默认项（10 分钟后等）支持自定义别名；删除默认项即持久化隐藏。
- 自定义时间可固定到内置 duration/date 分组。

见 `app/composables/useDueDateMemory.ts:1`。

### 表单分层与模板
新增表单默认仅展示基础项（标题/优先级/截止/分类 + 添加/重置），NLP 录入、描述、提醒、标签、循环、模板统一折叠进「更多选项」；AI 解析成功或套用模板后自动展开面板，避免回填结果不可见。模板存 KV（`todo_templates`），读取容错（损坏 JSON/非法条目丢弃），重名允许（以 id 区分）。见 `app/components/todo/TodoList.vue:444`、`app/composables/useTodoTemplates.ts:83`。

## 边界与限制

- 提醒定时器挂在主窗口的 reminderService 上（app.vue 启动），切换 Tab 卸载组件不影响；仅主窗口运行调度。
- 子任务不能再挂子任务（单层约束，UI 层控制）；循环仅顶级任务参与。
- 无截止时间的任务：智能/百分比/提前分钟提醒不可用，仅自定义「指定时刻」闹钟可触发。
- 标签最多 8 个（去重后截断）；不提供标签筛选入口（产品决策，保持工具栏简洁）。
- 回收站不做自动清理（保留至用户手动彻底删除）；图片/文件附件未实现（v1 仅链接）。
- 切换标签页、保存/新建便签的快捷键改键必须包含修饰键（Ctrl/Cmd/Alt/Shift），命中脏数据时启动自动修复数据库。
- 「高优先级」筛选口径随用户自定义等级系统自适应（取当前等级最高档位）。
- 回收站视图无分页语义（一次性加载）。

## 深读文档

- [待办功能扩展实现文档](../todo-features.md)（循环/子任务/标签/日历/批量/回收站/模板/链接/NLP 全量实现记录）
- [模块交互](../module-interactions.md)（待办 ⇄ 剪贴板/便签/全局搜索联动）
- [数据库设计](../database.md)（`todo` 表结构、v8-v10/v19 迁移与 `daily_stat` 待办统计列）
