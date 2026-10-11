# 待办功能扩展实现文档

> 本文档记录本轮待办（Todo）功能对齐（对标成熟待办工具差距分析）的实现内容、技术方案与操作指南。
> 实现过程中逐项更新状态标记（⏳ 未开始 / 🚧 进行中 / ✅ 已完成 / ❌ 未实现），全部完成后附验证结论。

## 功能总览

| # | 功能 | 状态 | 关键词 |
|---|------|------|--------|
| 1 | 循环/重复任务 | ✅ 已完成 | `recurrence` JSON 列、完成即生成下一期 |
| 2 | 子任务 | ✅ 已完成 | `parent_id` 列、单层嵌套、父卡片进度 n/m |
| 3 | 标签系统 | ✅ 已完成 | `tags` JSON 列、卡片徽章、标签筛选 |
| 4 | 拖拽层级调整 | ✅ 已完成 | `parent_id` 列、拖入变子任务、提升为顶级 |
| 5 | 「今天」聚合视图 | ✅ 已完成 | 今天到期 + 逾期顺延（`today` 筛选项） |
| 6 | 日历视图 | ✅ 已完成 | 月网格、拖拽改期、日期点选 |
| 7 | 批量操作 | ✅ 已完成 | 多选模式、批量完成/删除/改分类 |
| 8 | 回收站 | ✅ 已完成 | `deleted_at` 软删列、恢复/彻底删除 |
| 9 | 任务模板 | ✅ 已完成 | KV `todo_templates`、存为模板/套用 |
| 10 | 附件/链接 | ✅ 已完成 | `links` JSON 列、链接卡片（v1 仅链接） |
| 11 | 自然语言录入 | ✅ 已完成 | AI 解析 → JSON → 回填表单（依赖设置页 AI Key） |

---

## 〇、数据模型（前置基础）

### todo 表新增列（Rust v19 迁移 + migrator.ts 兜底，双侧同 DDL）

| 列 | 类型 | 说明 |
|---|---|---|
| `recurrence` | TEXT | 循环规则 JSON（功能 1），NULL = 不循环 |
| `parent_id` | TEXT | 子任务父任务 id（功能 2），NULL = 顶级任务 |
| `tags` | TEXT | 标签 JSON 字符串数组（功能 3），NULL/'' = 无标签 |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | 兄弟作用域手动排序号（功能 4），越大越靠后 |
| `deleted_at` | TEXT | 软删时间戳（毫秒文本，功能 8），NULL = 未删除 |
| `links` | TEXT | 链接 JSON 数组 `[{title,url}]`（功能 10），NULL = 无 |

### 核心类型（entities.ts）

```ts
/** 循环规则：freq 频率 + interval 间隔 + 可选 weekdays/monthDay 细化 + from 下一期起算基准 */
export interface TodoRecurrence {
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;          // ≥1，每 N 天/周/月/年
    weekdays?: number[];       // freq=weekly：0=周日…6=周六
    monthDay?: number;         // freq=monthly：1-31（大月自动钳制到月末）
    from: 'due' | 'complete';  // 下一期起算：按截止时间顺延 / 按完成时刻计算
}

/** 链接/附件条目（v1 仅链接；图片附件不做，见未实现项） */
export interface TodoLink { title: string; url: string }
```

`Todo` 接口扩展：`recurrence?` / `parentId?` / `tags?`（应用层解析为 string[]，DB 行保留 `tags` 原始 JSON 文本，与 remind_rules 同模式）/ `sortOrder?` / `deletedAt?` / `links?`。

### 仓储扩展（todoRepository.ts / dbService.ts 门面）

- `insertTodo`/`updateTodo` 写入新列；`sort_order` 未显式提供时自动取兄弟最大值 +1（`COALESCE(MAX(sort_order),0)+1`）
- `fetchTodos` 默认过滤 `deleted_at IS NULL`；搜索/分页行为不变
- 新方法：`deleteTodo(id)`（软删 = 写 `deleted_at`，含子任务级联）、`restoreTodo(id)`（恢复，含子任务）、`purgeTodo(id)`（彻底删除，含子任务）、`fetchDeletedTodos()`（回收站列表）

---

## 一、循环/重复任务

### 功能介绍

任务可设置循环规则（每天/每周/每月/每年，或自定义间隔），完成当前一期后**自动生成下一期未完成任务**（标题/描述/优先级/分类/标签/循环规则原样带入），截止时间按规则顺延。下一期起算基准可选：**按截止时间顺延**（固定日程，如「每周一开会」）或**按完成时刻计算**（滚动节奏，如「每次打扫后隔 3 天再打扫」）。

### 技术方案

- 纯函数模块 `app/src/todo/recurrence.ts`：`nextDueDate(due: string, rule: TodoRecurrence, completedAt: number): string`——daily/`+interval 天`；weekly 优先取 `weekdays` 中晚于当前的下一个（无则 +interval 周），否则同 weekday +interval 周；monthly 按月叠加（日期钳制到目标月最后一天）；yearly 按年叠加（2/29 → 2/28 兜底）。`from='complete'` 时基准为完成时刻。
- `TodoList.toggleTodo` 完成顶级任务且 `recurrence` 存在时：`insertTodo` 生成下一期（新 uuid、completed=0、dueDate=`nextDueDate` 结果），**全字段带入**（描述/优先级/分类/标签/链接/提醒规则原样继承，`sort_order` 沿用原位）并 `prepend` 进列表、弹岛「已生成下一期」；子任务不参与循环（`!parentId` 防御）。批量完成同样触发下一期生成。
- `RecurrencePicker.vue` 下拉组件：频率/间隔/星期多选/几号/from 基准，卡片显示循环图标。

---

## 二、子任务

### 功能介绍

任务卡片上可**添加子任务**（单层嵌套：子任务下不能再挂子任务），子任务缩进展示在父卡片下方，父卡片显示完成进度（n/m）。完成父任务不自动完成子任务（保持独立勾选）；删除/恢复/彻底删除父任务时子任务级联处理。

### 技术方案

- `parent_id` 列 + 单层约束（UI 层控制：子任务卡片不提供「添加子任务」入口）。
- `Todoitem.vue` 接收 `children?: Todo[]` prop 渲染缩进区；进度徽章 `n/m`。
- `TodoList` 计算属性把 `fetchTodos` 结果组装为「顶级 + children」树（子任务不进主列表遍历）。
- 级联：软删/恢复/彻底删除父任务时按 `parent_id` 一并处理（仓储层 SQL 带 `OR parent_id = $id`）。

---

## 三、标签系统

### 功能介绍

任务可打多个**标签**（自由命名关键字），卡片上以徽章展示。与「分类」（单选、预置列表）互补：分类管归属，标签管主题。标签只做标记与展示，不提供筛选入口（保持工具栏简洁；后续如有跨主题检索需求再评估）。

### 技术方案

- `tags` JSON 列（DB 存 JSON 字符串数组，读取时解析——与 pinned_clip tags 同模式）。
- 新增表单与编辑面板提供标签输入（空格分隔、兼容逗号、去空去重，对齐 PinnedClipList 交互）。
- 卡片金色弱化徽章展示；不提供标签筛选（v2 已按产品决策移除，i18n 键 `tag_filter`/`no_tags` 同步清理）。

---

## 四、拖拽层级调整

### 功能介绍

排序下拉不设「手动排序」选项（时间/优先级/名称等规则排序已覆盖排序诉求）。拖拽卡片到**目标任务卡片上**松手，可将该任务**变为目标任务的子任务**；子任务卡片提供「提升为顶级」按钮反向操作。拖拽手柄在卡片左侧，列表视图下常驻可用（批量多选模式除外）。

> 迭代记录：最初版本含「手动排序」模式与同级前后插入重排，后按易用性反馈移除——规则排序下重排本会被排序规则覆盖，仅保留层级调整这一有效操作；`sort_order` 列保留，用于子任务在父内的顺序与新增任务追加位置。

### 技术方案

- HTML5 拖拽（`dragstart/dragover/drop`，手柄在卡片左侧，`dragover` 需 `preventDefault` 才允许 drop）；悬停目标卡金色高亮提示可落为子任务。
- 变子任务/提升：更新 `parent_id` 与 `sort_order`（兄弟末尾 / 顶级末尾 `maxOrder+1`），列表树即时重组。
- 防孙层级：源任务已有子任务、或目标本身是子任务时，拒绝「变子任务」。

---

## 五、「今天」聚合视图

### 功能介绍

筛选栏新增「今天」视图：聚合**今天到期**与**全部逾期未完成**的任务（逾期自动顺延到今天，直到完成），即「今天该做什么」单一清单。推荐搭配「按截止时间升序」排序（最紧急在前）。

### 技术方案

- `filters` 数组新增 `{ label: 今天, value: 'today' }`；过滤逻辑（本地时区，与 isTodoOverdue 同口径）：未完成任务按 `dueDate 日期 ≤ 今天`（逾期自动顺延到今天），已完成任务仅显示**今天完成**的。
- 排序沿用用户当前排序设置，推荐搭配「按截止时间升序」（最紧急在前）。

---

## 六、日历视图

### 功能介绍

待办页顶部「列表 / 日历」视图切换。日历为**月网格**：每天格内列出当日到期（含逾期顺延显示在今天）的未完成任务与当日完成的任务；**拖拽任务卡到目标日期格即可改期**；点击日期格查看当日任务明细。

### 技术方案

- 新组件 `app/components/todo/TodoCalendar.vue`：props `{ todos: Todo[] }`，emit `change-due(id, date)`——数据源为**全量统计集合**（`statsTodos`，单页最多 500 条，跨月也能看到未分页加载的任务）；月导航（上月/今天/下月）。
- 任务按 `dueDate` 日期部分分桶（逾期未完成并入今天格，红色标识）。
- 改期：HTML5 拖放，drop 后 emit 给 TodoList 走既有 `updateTodo(id, { dueDate })` 链路（同步提醒调度）。
- 日期点选：选中日的任务在侧栏/下方明细区高亮展示。

---

## 七、批量操作

### 功能介绍

列表头部「批量管理」按钮进入**多选模式**：卡片左侧出现复选框（点选/全选），底部工具栏提供**批量完成、批量删除（进回收站）、批量改分类**；与剪贴板批量工具栏交互一致。Esc 或点击退出按钮结束多选。

### 技术方案

- `TodoList` 增加 `batchMode/batchSelected(Set)` 状态；`Todoitem` 增加 `batchMode/selected` props 与 `toggle-select` emit。
- 批量操作循环调用既有 `toggleTodo/updateTodo/deleteTodo`（软删；乐观更新 + 写库包装复用 withDbWrite）；批量改分类用分类下拉**选择即应用**（选中后立即对已选项生效）。
- 工具栏常驻列表上方（z-40），显示已选数量与三个操作按钮 + 全选/退出；批量完成汇总书记录 `todo_completed` 统计。

---

## 八、回收站

### 功能介绍

删除任务改为**软删除**（进回收站，不再弹确认框二次打断——误删可在回收站一键恢复）。筛选栏新增「回收站」视图：列出已删除任务（显示删除时间），支持**恢复**与**彻底删除**（彻底删除前确认）。子任务随父任务级联进出回收站。

### 技术方案

- `deleted_at` 软删列；原 `DELETE` 语义迁至 `purgeTodo`，`deleteTodo` 改为写 `deleted_at`。
- `fetchDeletedTodos()`：`WHERE deleted_at IS NOT NULL`，按删除时间倒序。
- 回收站视图复用 TodoItem 渲染（操作按钮区切换为 恢复/彻底删除）；彻底删除走既有 DeleteConfirm 确认。
- 明确不做自动清理（保留至用户手动彻底删除），文档如实标注。

---

## 九、任务模板

### 功能介绍

高频重复创建的任务配置可**存为模板**（标题/描述/优先级/分类/标签/循环规则），新增表单提供模板下拉：选中即回填全部字段；模板支持删除管理。模板存储于 KV（`todo_templates`），跨会话保留。

### 技术方案

- `app/composables/useTodoTemplates.ts`：KV 读写 JSON 数组 `[{id,name,title,description,priorityLevel,category,tags,recurrence}]`，模块级单例（对齐 useCategories 模式）。
- 新增表单区「存为模板」按钮（按当前表单内容保存，**模板名直接取任务标题**）+ 模板下拉（应用/删除）；应用模板回填除截止时间外的全部字段。

---

## 十、附件/链接

### 功能介绍

任务可附**链接**（URL + 可选名称），卡片与编辑面板展示链接徽章，点击调用系统浏览器打开。典型场景：参考资料、工单地址、会议链接。

### 技术方案（v1 范围）

- `links` JSON 列 `[{title,url}]`；编辑面板「添加链接」行（url 必填、title 可选，自动 `https://` 前缀补全），卡片链形图标 + tooltip 列表，点击 `openUrl`（@tauri-apps/plugin-opener）。
- **图片/文件附件 v1 不做**（需复用图片落盘机制与安全边界改造，投入产出比不足），文档如实标注。

---

## 十一、自然语言录入（AI）

### 功能介绍

新增表单提供**自然语言输入框**：用一句话描述任务（如「明天下午3点提醒我给老板发周报，标签工作，高优先级」），点击「AI 解析」自动抽取标题/截止时间/优先级/分类/标签并**回填表单**（可修改后再提交，不直接落库）。依赖设置页已配置的 AI 接入（`ai_provider/ai_base_url/ai_model/api_key`），未配置时按钮引导去设置。

### 技术方案

- `app/src/todo/todoNlp.ts`：`parseTodoFromText(text, cfg)`——system prompt 要求**严格输出 JSON**（`{title, description?, dueDate?('YYYY-MM-DDTHH:mm'|''), priorityLevel?(0-255), category?, tags?: string[]}`），prompt 内注入当前本地时间供相对日期（明天/下周三）推算；响应剥 ```json 围栏后 `JSON.parse`，字段白名单化（非法值丢弃回退默认）。
- 调用复用 `aiClient.aiComplete`；失败按错误码分流提示：未配置 AI（`nlp_no_ai`）/ 响应格式异常（`nlp_bad_response`）/ 其他失败（`nlp_failed`），统一走 `notifyIsland({kind:'error', briefAiError})` 既有模式。
- 解析结果回填 `newTodo`（dueDate 解析失败仅回填其余字段，不阻塞）。

---

## i18n 说明

全部新增文案（视图切换/标签/批量/子任务/循环/日历/回收站/模板/链接/NLP 等约 90 个键）已同步添加至 `app/assets/lang/zh-cn.toml` 与 `en-us.toml` 的 `[todo]` 段，无硬编码文案。

---

## 表单分层（易用性）

新增任务表单默认仅展示基础项（标题 / 优先级 / 截止 / 分类 + 添加/重置）；NLP 录入、描述、提醒、标签、循环、模板统一折叠进「更多选项」面板（再点「收起选项」合上）。AI 解析成功或套用模板后会自动展开面板，避免回填结果不可见。

---

## 未实现项（如实标注）

### 图片/文件附件 — ❌ v1 不做
附件链接先行（功能 10）；图片附件需复用剪贴板 imgfile 落盘机制并扩展删除联动边界，待后续版本评估。

### 回收站自动清理 — ❌ 不做
软删任务永久保留至用户手动彻底删除（可预期数据量小，不做 30 天自动清空）。

---

## 验证结论（2026-10-10）

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 前端类型检查 | `npx vue-tsc --noEmit`（app/） | ✅ 0 错误 |
| 单元测试 | `npx vitest run`（仓库根） | ✅ 259 passed（含新增 tags 4 + todoNlp 8 + useTodoTemplates 4） |
| Rust 编译检查 | `cargo check`（src-tauri/） | ✅ 通过（v19 迁移 + 兜底迁移双侧同 DDL） |
