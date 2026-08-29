# s1de-board 全代码库审查报告

> 审查日期：2026-08-29 · 审查范围：全部前端（Nuxt 4，约 11,000 行）+ 后端（Tauri/Rust，约 400 行）+ 构建配置
> 审查方式：按模块（页面外壳层 / 待办子系统 / 剪贴板与命令系统 / 数据·统计·设置层 / Rust 后端）全量逐行审查，关键结论已逐一核实源码与交叉引用。
>
> 严重度定义：**高** = 数据损坏 / 核心功能失效 / 构建发布必挂；**中** = 特定场景出错 / 明显性能浪费 / 维护陷阱；**低** = 边角缺陷 / 一致性问题。

## 目录

- [0. 总览与问题统计](#0-总览与问题统计)
- [1. 最严重问题 Top 10（跨模块）](#1-最严重问题-top-10跨模块)
- [2. 逻辑错误](#2-逻辑错误)
- [3. 异常处理缺失](#3-异常处理缺失)
- [4. 性能瓶颈](#4-性能瓶颈)
- [5. 代码重复与死代码](#5-代码重复与死代码)
- [6. 命名不一致](#6-命名不一致)
- [7. 目录结构与构建配置混乱](#7-目录结构与构建配置混乱)
- [8. 建议的优化路线图](#8-建议的优化路线图)

---

## 0. 总览与问题统计

| 分类 | 高 | 中 | 低 | 小计 |
|---|---|---|---|---|
| 逻辑错误 | 9 | 11 | 10 | 30 |
| 异常处理缺失 | — | 7 | 10 | 17 |
| 性能瓶颈 | 2 | 7 | 7 | 16 |
| 代码重复与死代码 | 1 | 6 | 8 | 15 |
| 命名不一致 | — | 2 | 11 | 13 |
| 目录结构与构建配置 | 2 | 5 | 7 | 14 |
| **合计** | **14** | **38** | **53** | **105** |

代码库整体质量的两面性很明显：组件库（`app/components/ui`）、composables 单例模式、快捷键 Command 模式等设计意图是好的；但**三条主线问题贯穿全库**：

1. **「1 秒轮询 + 全量替换」反模式**：主页面、待办、便签三个模块各自 `setInterval(…, 1000)` 全量查库并整表替换响应式数组，空闲时持续做功，并与写操作的乐观更新形成竞态。
2. **「同一概念多套实现」**：删除确认 ×3、tooltip ×2、方向键移动 ×3、粘贴时序 ×2、日期处理 ≥6 处、下拉定位 ×3、滚动定位 ×4，修一处漏一处。
3. **「异常静默」**：DB 写入、命令执行、事件监听大量无 try/catch，失败时 UI 与数据库不一致且无任何提示。

---

## 1. 最严重问题 Top 10（跨模块）

| # | 位置 | 问题 | 后果 |
|---|---|---|---|
| 1 | `app/src/commands/local/PasteCommand.ts:36` | 把**行索引**当数据库 **id** 传给 `increaseUseCount` | 每次按 Enter 粘贴，都会给一条 `id === 行号` 的无关记录 count+1 并刷新 `updated_at`；列表按 `updated_at DESC` 排序 → 无关记录被顶到最前，使用统计全部失真 |
| 2 | `app/app.vue:180-184` + `app/src/statistics/mockData.ts:157` | 生产启动流程中未解锁统计即 `seedMockStats(true)`，force 分支先 `DELETE FROM daily_stat` 再灌 180 天假数据 | 新用户前 1~6 天的**真实统计数据在每次启动时被整体删除**；mock 代码静态打包进生产 bundle；解锁门槛被永久绕过 |
| 3 | `app/src/todo/reminderService.ts:111` | `setTimeout` 延迟未钳制，超过 2³¹-1（约 24.86 天）溢出 | 创建 30 天后截止的任务：提醒**创建当时立即误触发**（弹"已到期"），且 firedLog 已记录 key，到点后的**真提醒永远不会发** |
| 4 | `src-tauri/tauri.conf.json:7` + `nuxt.config.ts:23` + 根目录 `dist` 符号链接 | `frontendDist: "../dist"` 指向一个不入库的符号链接，目标 `E:\dev\s1d3\.output\public` 在**仓库外**（`nitro.output.publicDir` 覆盖所致） | 全新 clone / GitHub Actions 上 `tauri build` 直接失败（release.yml 必挂）；本地构建则把**上层目录的陈旧前端**打进安装包 |
| 5 | `app/src/commands/shortcuts/ShortcutManager.ts:71-79` | 本地快捷键 handler 在命令执行**前**无条件 `preventDefault`，且无"正在编辑输入框"守卫 | 便签编辑中 Enter 无法换行、Delete/方向键失效；**常用剪贴编辑框里按 Enter 会把无关剪贴写入系统剪贴板、隐藏主窗口并模拟 Ctrl+V** |
| 6 | `app/components/todo/TodoList.vue:599` + `:425-428` | 每秒全量轮询整表替换，与 toggle 的乐观更新竞态 | 快速勾选两次可产生**与用户意图相反的落库状态**；复选框每秒回跳闪烁；空闲 CPU/IPC 持续消耗 |
| 7 | `src-tauri/src/lib.rs:333-352` | `paste` 为同步命令（主线程执行），函数体第一行 `sleep(300ms)`，4 处 `unwrap()` | 每次粘贴 UI 冻结 ≥500ms（前端另有 200ms sleep）；SendInput 被 UIPI 拦截时**整个进程 panic**，错误无法传回前端 |
| 8 | `app/composables/useTodoSmartRemind.ts:25-30` | `setTodoSmartRemindEnabled` 全仓库**零调用方**，设置页直接 v-model 改共享 ref | 关闭智能提醒**重启即被悄悄改回**（永远不落库）；关闭也不触发 reminderService.sync，已排程定时器继续生效 |
| 9 | `app/src/commands/shortcuts/InitShortcuts.ts:157-163` | `find_in_tab`（Ctrl+F）`scope: 'global'` 注册为**系统级**全局快捷键 | 应用驻留托盘时**所有其他应用里的 Ctrl+F 被本应用截走**；叠加问题 #14 的冲突检测缺陷还会跨 scope 双重触发 |
| 10 | `app/src/db/dbService.ts:105-122` | priority_level 迁移回填条件写反：循环补列后再 `PRAGMA` 检查"列是否缺失"，恒为 false | **结构性死代码**——旧三档 priority 存量数据永远无法回填为 priority_level，老用户升级后优先级静默丢失 |

---

## 2. 逻辑错误

### 2.1 高严重度

**L1. 剪贴板主列表竞态与整表替换** — `app/components/todo/TodoList.vue:599-601, 425-428, 579`（详见 [性能瓶颈 P1](#41-高严重度)，此处只记逻辑面）
`fetchTodos` 每秒 `todos.value = fetchedTodos` 整表替换；`toggleTodo` 先翻转本地 `completed` 再异步写库。时序：点1（本地=1，写库中）→ 轮询取回旧值 0 整表替换 → 点2 基于新对象又置 1 → 最终落库 1，与用户 off→on→off 的意图相反。
**修复**：写操作期间挂起轮询（或写后主动刷新）；`fetchTodos` 按 id 合并而非整表替换；加 in-flight 标志。
**预期**：杜绝状态翻转竞态与复选框回跳。

**L2. 生产环境强制重建演示数据，摧毁真实统计** — `app/app.vue:180-184`、`app/src/statistics/mockData.ts:155-158`
```ts
let unlocked = await statsService.isStatsUnlocked();
if (!unlocked) { await seedMockStats(true); ... }   // force=true → DELETE FROM daily_stat
```
新用户第 1~6 天的真实统计在下次启动时被整体删除并替换为 180 天假数据；随后真实增量经 flush UPSERT 永久混入假行；同时向真实剪贴板注入 20 条 `source='演示数据'` 记录。`StatsPage.vue:15` 还静态 import `buildMockDays`，"测试数据"面板（`StatsPage.vue:477-480`）在生产 UI 永久可达，其 `saveEditData`（L437-454）可**覆盖任意日期的真实统计**。
**修复**：删除 app.vue 中的调用（或 `import.meta.dev` 门控 + 动态 import）；mockData 移入 dev-only 目录；测试面板加 `v-if="import.meta.dev"`。
**预期**：真实统计曲线不被摧毁，生产 bundle 剔除 mock，解锁门槛恢复设计语义。

**L3. 远期提醒 setTimeout 溢出：立即误报 + 真提醒永久丢失** — `app/src/todo/reminderService.ts:111-113`
```ts
const delay = Math.max(0, item.fireAt - now);
const timer = setTimeout(() => void this.handleFire(key, todo.id, item.stage), delay);
```
WebView 将 delay 存为 32 位有符号整数，超过约 24.86 天溢出为立即执行。创建一个月后截止的任务 → "已到截止时间"立即弹出，`firedLog[key]` 写入（L176）→ 真正到点时被 L109 的去重拦截，**再也不会提醒**。
**修复**：`delay = Math.min(delay, 2**31 - 1)`，触发后未到点则重新 setTimeout 剩余时长；或只调度 7 天内的提醒，更远的靠每秒 sync 逐次续排。
**预期**：远期任务在正确时刻提醒，创建不再误报。

**L4. Enter 粘贴把行索引当 id** — `app/src/commands/local/PasteCommand.ts:36`
`await clipboardService.increaseUseCount(getSelectedRowIndex())`；对照 `dbService.ts:286` 的 `UPDATE clipboard SET count=count+1, updated_at=$2 WHERE id=$1`，其余两处调用（`ClipboardSlotPasteCommand.ts:18`、`index.vue:620`）都传 `item.id`。
**修复**：改传 `getSelectedItem().id`；顺带让 PasteCommand 复用 `pasteUtil`（见 D2）。
**预期**：消除每次粘贴对随机行的污染与列表顺序错乱。

**L5. pinned 页 Enter 粘贴的是不可见条目** — `app/src/commands/local/PasteCommand.ts:29`
守卫允许 `activeTab === 'pinned'`，但 `getSelectedContent()` 读的是**主剪贴板** store 的选中态；常用剪贴页自己的选中态是 `PinnedClipList.vue:22` 的本地 `selectedIndex`，两者完全不同步。在常用剪贴页按 Enter 会粘贴一个屏幕上根本不显示的主剪贴板条目。
**修复**：pinned 页禁止 Enter 粘贴，或让 PinnedClipList 的选中态接入共享 store 并按页取数。
**预期**：粘贴内容与用户看到的选中项一致。

**L6. 快捷键系统无编辑态守卫，preventDefault 前置** — `app/src/commands/shortcuts/ShortcutManager.ts:71-79`
handler 命中即在命令执行前 `preventDefault + stopImmediatePropagation`；"是否在输入框"的判断散落在各命令内部且太晚。已验证连锁后果：便签 textarea（`StickyNoteItem.vue:119-128`）按 Enter 无法换行、方向键无法移动光标（`TargetMovementCommand.ts:40` 提前 return）、Delete 完全失效（`DelCommand.ts:13` 仅 clip 页生效）；常用剪贴编辑框（`PinnedClipList.vue:249-254`）按 Enter 直接触发粘贴链。
**修复**：ShortcutManager 开头统一 `isEditingField()` 守卫（白名单豁免搜索框），命中可编辑元素时不拦截；或把 preventDefault 移到命令确认处理之后。
**预期**：所有输入框恢复原生键盘行为，消除编辑态误粘贴。

**L7. Ctrl+F 注册为系统全局快捷键** — `app/src/commands/shortcuts/InitShortcuts.ts:157-163`
`find_in_tab` `scope: 'global'`。应用驻留托盘时全系统劫持 Ctrl+F；窗口隐藏时 `FocusSearchCommand.ts:13` 的 CustomEvent 毫无意义，还白记一条 `shortcut_count` 统计。focus-search 是窗口内语义（对比 DelCommand/CreateNoteCommand 均 local）。
**修复**：改为 `scope: 'local'`。
**预期**：其他应用的 Ctrl+F 不再被劫持。

**L8. priority_level 迁移回填是结构性死代码** — `app/src/db/dbService.ts:105-122`
循环（L94-102）补列成功后，L108 重查 `PRAGMA` 得到的 `addedPriorityLevel = !cols.some(c => c.name === 'priority_level')` 只在**补列失败**时为 true，而此时 L116 的 UPDATE 又因列不存在必然报错被吞。"刚补建时回填存量数据"这条路径永远不会执行。
**修复**：循环内记录"本次实际执行了 priority_level 的 ALTER"（如 `didAddPriorityLevel = true`），循环外据此回填。
**预期**：老用户升级后旧三档优先级正确映射为 0/127/255。

**L9. 构建产物指向仓库外的符号链接** — `src-tauri/tauri.conf.json:7`、`nuxt.config.ts:21-25`、`.gitignore:7`
`frontendDist: "../dist"` → 根目录 `dist` 是不入库的符号链接，指向 `E:\dev\s1d3\.output\public`（仓库上一层，`nitro.output.publicDir: '../.output/public'` 覆盖所致）。全新 clone / CI 上该路径不存在，`tauri build` 必失败；本地则可能打包陈旧产物。另外 `nuxt.config.ts:17-19` 注释写 "Tauri requires a consistent port" 却配 `strictPort: false`，端口被占时 Tauri 加载到错误服务。
**修复**：删除 nitro publicDir 覆盖与 dist 符号链接，`frontendDist` 直接改 `"../.output/public"`；`strictPort: true`。
**预期**：CI/新环境可直接构建发布包；本地产物与源码严格一致。

### 2.2 中严重度

**L10. tooltip 焦点抢占** — `app/pages/index.vue:394-408`：鼠标从 tooltip 移到**其它应用**窗口时，仅因主窗口可见就无条件 `await win.setFocus()`，把 OS 焦点从用户当前应用抢回。→ 仅在确认鼠标回到主窗口时恢复焦点。

**L11. reminderService 启动竞态：重启后已补发过的提醒可能再轰炸** — `app/src/todo/reminderService.ts:46-49` + `TodoList.vue:577-581`：`start()` 先置 `started=true` 再异步加载 firedLog；TodoList 随即 `sync()`，若 sync 先于 firedLog 加载完成，`handleMissed` 把已发过的 missed 当 fresh 再次补发。→ `start()` 缓存初始化 Promise，`sync()` 首行 `await this.ready`。

**L12. 晚于截止时间的自定义闹钟被静默吞掉** — `app/src/todo/reminderPolicy.ts:87` + `reminderService.ts:169-174`：排程时 `stage==='custom'` 只要求 `fireAt > now`；触发时 `hasReminderKey` 重算落入 missed 分支，而 missed 要求 `fireAt < dueMs` → 返回 false 直接 return。"今天 18:00 截止、明天 9:00 提醒"这类合法配置无声失效。→ 对 `at` 类型放宽约束，或 ReminderPicker 配置期即警示。

**L13. 百分比提醒规则可保存非法值** — `app/components/todo/ReminderPicker.vue:186` vs `reminderPolicy.ts:123`：UI 只钳下限（`max=99` 仅是 input 属性，手输 500 照样提交），策略端 `>99` 返回 null → 规则永不触发。→ `updateRule` 按 kind 钳制（percent 1-99 / offset 1-10080）。

**L14. 快捷键冲突检测漏报** — `app/src/commands/shortcuts/InitShortcuts.ts:288-293`：`findShortcutConflict` 只做 `toLowerCase().replace(/\s+/g,'')`，不归一化 `CommandOrControl/Ctrl/Command`；录制产出 `Control+F` 与默认 `CommandOrControl+F` 字符串不等 → 判定无冲突，local 与 global 同键双重触发。→ 修饰键别名归一化后再比较。

**L15. 智能提醒开关持久化函数零调用** — `app/composables/useTodoSmartRemind.ts:25-30`：设置页 `SettingMain.vue:691` 直接 v-model 改共享 ref，`todo_smart_remind` 永不落库，重启回滚；切换也不触发 `reminderService.sync`，已排程定时器要等回到待办 Tab 才拆除。→ 设置页改调 `setTodoSmartRemindEnabled` 并在其中触发 sync。

**L16. 点当前 Tab 也计统计** — `app/composables/useTabs.ts:13-17`：注释称"仅在真正切换时 +1"，但 `setActiveTab` 无同值守卫；反复点击当前 Tab 使 `tab_x` 虚高，进而影响"活跃 ≥7 天"解锁判定。→ 首行加同值守卫。

**L17. 首次安装导航拖拽/排序完全失效** — `app/composables/useTabs.ts:43,154-176`：`tabOrder` 初始为空数组，`moveTab/reorderTab` 对空数组 `indexOf === -1` 直接 return；且因 `dragged=false` 不触发保存，形成死循环，直到用户先改过启用开关。→ tabOrder 为空时先以 `tabItems.map(t=>t.key)` 初始化。

**L18. "高优先级"筛选硬编码阈值 128** — `app/components/todo/TodoList.vue:339`：`(t.priorityLevel ?? 127) >= 128`，而档位是用户可增删改的（`useTodoPriorities.ts:148-160`）；用户只配 0-100 档时筛选永远为空。→ 跟随等级定义或改为按档位多选。

**L19. `updated_at` 本地写入格式不统一（parseInt 得 NaN）** — `app/components/note/StickyNote.vue:280,303` 与 `app/components/todo/TodoList.vue:557` 写 `new Date().toString()`，DB 层（`dbService.ts:469`）写毫秒数，消费端 `StickyNoteItem.vue:134`/`PinnedClipList.vue:298` 一律 `formatDate(parseInt(...))` → 保存/换色后卡片短暂显示"无效日期"，直到 1s 轮询覆盖。→ 统一 `String(Date.now())`。

**L20. Ctrl+F 冲突之外：编辑便签时 Ctrl+N 丢稿** — `app/components/note/StickyNote.vue:357-362`：Ctrl+N 分支在 `isEditingField` 检查（L365）之前执行，正在编辑时创建新便签并切换 `editingId`，旧 textarea 卸载不触发 blur，`saveAndClose` 不执行，未保存输入丢失。→ 分支前加编辑态守卫或先保存。

**L21. FavoriteCommand 空指针** — `app/src/commands/local/FavoriteCommand.ts:11-12`：`fetchClipboardSingleData`（`dbService.ts:274-276`）行不存在时返回 `undefined` 却签名 `Promise<ClipboardData>`，`res.is_favorite` 直接 TypeError；且该方法不调 `ensureDbInitialized`。→ 判空 + 补初始化守卫。

**L22. 时间列格式混用两种体系** — `app/src/db/dbService.ts:168,176-178,193,404,435-441` + `src-tauri/src/lib.rs:40-45,84-86`：schema 默认 `DEFAULT CURRENT_TIMESTAMP`（字符串），前端写毫秒数；排序全靠字符串比较（`ORDER BY updated_at`，L221/270）。一旦任何行以日期字符串入库（迁移默认值生效），`"2026-..." > "1759..."` 字典序恒真，排序与"裁剪最旧记录"（trimClipboard）会删错行。→ 统一由应用层写毫秒数，schema 默认值仅兜底。

**L23. 配色默认值冲突："跟随系统"永不生效** — `app/composables/useColorScheme.ts:29` + `src-tauri/src/lib.rs:92`：composable 默认 `'system'`，但迁移向 settings 播种 `('color_scheme','light',...)`（description 还误写成"最大保存数量"，复制粘贴痕迹），首启读到 light，system 默认被覆盖。→ 迁移清理该种子行或改播种 system。

**L24. "拖更选手"标签误伤零待办用户** — `app/src/statistics/userTags.ts:273-274`：`condition: c.todoCompleteRate < 0.2`，而 `todo_added === 0` 时该值为 0 → 从不用待办的用户必然中标签。→ 加 `todo_added > 0` 前置条件。

### 2.3 低严重度

| 位置 | 问题 | 修复 → 预期 |
|---|---|---|
| `app/pages/index.vue:187-189` | `tooltip:ready` 补发路径漏发 top/bottom，与已有窗口路径避让行为不一致 | 补发完整载荷 → 显示位置一致 |
| `app/pages/index.vue:639` | `Math.max(0, findIndex(...))`：findIndex=-1 静默回退第 0 张，查看器显示错误图片 | 区分未找到提前返回 |
| `app/pages/tooltip.vue:83-84` | `monitor.size.width`（物理像素）与 `window.screen.width`（CSS 像素）混用，DPR≠1 贴边计算错 | monitor 为空直接返回原坐标 |
| `app/pages/tooltip.vue:157-175` | `showTooltip` 无并发令牌，快速跨项 hover 时窗口内容与尺寸可能来自两次调用混合 | 自增 requestId，await 后校验 |
| `app/components/common/DatePicker.vue:365,375` | 月份切换 v-tip 越界："0 月"/"13 月"，年份不联动 | 用 `new Date(y, m±1, 1)` 计算 |
| `app/components/common/DatePicker.vue:140`、`app/components/todo/DueTimeSelect.vue:429-432` | `todayStr` 仅求值一次（后者还是无依赖 computed 永不失效），跨天后"今日"描边/DatePicker min 过期 | 打开面板时刷新 |
| `app/pages/viewer.vue:23` | `let images: string[] = []` 非响应式，模板计数/禁用靠"碰巧"重渲染 | 改 `ref` |
| `app/components/common/DeleteConfirm.vue:61-93` | `watch(visible)` 无 `immediate: true`，以 visible=true 挂载时键盘无响应、定位失效 | 加 immediate |
| `app/components/pinned/PinnedClipList.vue:54-58` | `load()` 失败文案从不重置，错误提示与正常列表同时显示 | try 开头清空 errorMsg |
| `app/components/todo/TodoList.vue:550-562` | 删光分类后回退值 '其他' 可能不在列表中，待办被赋成选不回的分类 | 回退值不在列表时补建 |
| `app/components/todo/DueTimeSelect.vue:157` | 上翻定位未钳上边界，视口不足时 top 为负 | `Math.max(MARGIN, top)` |
| `app/src/db/dbService.ts:255-256,484-486,530-533` | LIKE 通配符未转义：搜 "100%" 命中 "100abc"，搜 "a_b" 命中 "axb" | escape 函数 + `ESCAPE '\'` |
| `app/src/db/dbService.ts:384-392` | `clearDatabase` 不清 `pinned_clip`，与设置页"清空数据"文案不符，Ctrl+1~0 仍能粘贴旧项 | 补 DELETE 或改文案 |
| `app/src/db/dbService.ts:270` | LIMIT 值拼接（虽经 parseInt 守卫无注入），但可填超大值导致全量加载 | 参数化 + clamp 上限 |
| `app/components/statistics/StatsPage.vue:290-310,640-642` | 年度视图降采样后把**月数**当"最长连续 X 天"返回 | 换算展示或基于原始日集计算 |
| `app/src/commands/shortcuts/InitShortcuts.ts:312-324` | `registerAll` 单键失败仅 console.error，`updateShortcutKey` 仍持久化新键并返回成功 | 收集失败项，失败回滚 |
| `app/pages/index.vue:618-621` | 以 `dropEffect === 'copy'` 判定是否计数，dropEffect 由拖放目标决定，不可靠 | 拖入目标回调后计数 |

---

## 3. 异常处理缺失

### 3.1 中严重度

**E1. TodoList 全部 DB 写操作裸奔** — `app/components/todo/TodoList.vue:402,428,440,457,471,487,496,558`
`insertTodo/updateTodo/deleteTodo` 均无 try/catch（同文件仅 `fetchTodos` 有）。SQLite 写失败（磁盘满/库锁）时本地状态已改、无回滚无提示，并产生 unhandled rejection。TodoList 是全项目唯一整段无防护 DB 写入的组件（其他 composable 内部均有 catch）。
**修复**：封装 `withDb(fn)` 统一 catch + toast；toggleTodo 失败回滚 `completed` 并撤销统计埋点。
**预期**：DB 异常时 UI 与库一致、用户可感知。

**E2. 剪贴板保存"先查后插"竞态 + 监听回调无保护** — `app/src/db/dbService.ts:167-201,135-137`
schema 有 `content UNIQUE`（lib.rs:39），文本/图片监听并发时同一内容两条事件都查空 → 第二条 INSERT 撞约束抛错；`onTextUpdate` 回调无 try/catch（`onSomethingUpdate` 分支却有，行为不一致）→ unhandled rejection，该条剪贴与统计埋点、trim 全部丢失。
**修复**：改单语句 upsert `ON CONFLICT(content) DO UPDATE SET count=count+1`；两个回调统一包 try/catch。
**预期**：高频复制零丢失，少一次往返查询。

**E3. 三个单条查询缺初始化守卫且类型不诚实** — `app/src/db/dbService.ts:274-277,489-492,537-540`
`fetchClipboardSingleData/fetchSingleNote/fetchSingleTodo` 是唯二不调 `ensureDbInitialized()` 就 `this.db!.select` 的方法（首调即 TypeError）；查无记录返回 `undefined` 却签名 `Promise<T>`，把 undefined 伪装成合法值（reminderService 捕获后每 5 秒无限重试）。
**修复**：补守卫；返回类型改 `Promise<T | undefined>`；重试加上限/退避。
**预期**：消除启动时序炸点，无无限重试。

**E4. ShortcutManager 命令执行无 try/catch** — `app/src/commands/shortcuts/ShortcutManager.ts:25,76`
`await config.command.execute(...)` 两处均无保护；任何命令抛错（如 L21 的 TypeError）都是 unhandled rejection，且 `stopImmediatePropagation` 已执行，后续监听器被跳过，错误无任何反馈。
**修复**：命令执行包 try/catch + 错误上报。
**预期**：命令故障被隔离、可诊断。

**E5. 快捷键注册失败仍显示"保存成功"** — `app/src/commands/shortcuts/InitShortcuts.ts:312-324` + `ShortcutManager.ts:97-101`
`registerAll` 对单个快捷键注册失败仅 console.error 后继续，`reloadShortcuts()` 永远 resolve；`updateShortcutKey` 照常改 key、持久化、返回成功。新全局键与系统/其他软件冲突时用户看到成功但快捷键死了。
**修复**：registerAll 收集失败项返回；有失败回滚并报错。
**预期**：非法快捷键不被持久化。

**E6. 主页面删除/收藏无错误处理 + 监听器泄漏** — `app/pages/index.vue:521-532,360-376,451-455,618-621`
`confirmDelete` 中 `deleteClipboardData` 无 catch（失败时确认框已关、无提示、列表不刷新）；`listen('add-to-pinned:result')` 等 3 个 Tauri 监听未保存 unlisten（对比 L346-357 有完整清理），组件卸载即泄漏重复回调；`favorite`/`increaseUseCount` fire-and-forget 无 catch。
**修复**：统一 try/catch + toast；保存 unlisten 并在 onBeforeUnmount 调用。
**预期**：删除失败可见，无监听泄漏。

**E7. DB 初始化失败后应用"处处静默失败"** — `app/app.vue:144-149`
`startClipboardListener` 失败仅 console.error，后续每个业务方法各自重试 `Database.load` 继续抛——无用户可见反馈。纯 Web 下 `isMainWindow()` 恒 true 还会执行 clipboard 插件调用（L145），每次 web dev 启动打印"初始化失败"。
**修复**：初始化失败给全局错误提示/降级 UI；插件调用前加 `isTauri()` 守卫（statsService 已有，两入口防护不一致）。
**预期**：数据库故障从全面静默变为单一明确提示。

### 3.2 低严重度

| 位置 | 问题 | 修复 → 预期 |
|---|---|---|
| `app/components/note/StickyNote.vue:261-268,285-297` | confirmDelete 先清目标再 await deleteNote（无 catch），失败时"删了但没删"且无提示 | catch 后恢复目标并提示 |
| `app/src/commands/local/AddToPinnedCommand.ts:24-31`、`FavoriteCommand.ts:11-18` | 命令内 DB 操作全程无 try/catch，直通 E4 的无保护回调 | catch 并经 result 事件上报 error |
| `app/src/commands/local/HideWindowCommand.ts:10-11` | `await win.hide()` 无保护；同类操作三处三种防护等级（ToggleWindowCommand 有整体 catch） | 统一包 try/catch 或抽公共 hideMainWindow |
| `app/src/todo/reminderService.ts:158-163` | fetchSingleTodo 失败每 5 秒无限重试，DB 持久故障时每个提醒常驻一个永久定时器 | 最大重试次数/指数退避 |
| `app/app.vue:170-175,192-194` | 退出落库不可靠：beforeunload 里 async 函数不被等待；onCloseRequested 中 flush fire-and-forget，最多丢 30s 统计 | onCloseRequested 中 await flush 后再放行 |
| `app/components/statistics/StatsPage.vue:162-166` | load 失败仅 console.error，空态与查询失败无法区分、无重试入口 | 加 loadError 状态 + 重试按钮 |
| `app/components/todo/Todoitem.vue:342-351`、`CategorySelect.vue:43-52` | 新增分类重名失败无反馈且输入被清空 | 失败提示"分类已存在"并保留输入 |
| `app/pages/index.vue:451-455` | favorite() DB 失败时星标 UI 与数据不一致 | try/catch + 回滚/提示 |
| `app/src/statistics/statsService.ts:156-165` | flush 把 `Object.keys(acc)` 直接拼进 INSERT（当前调用方合法，属防御缺失） | record() 入口按 StatField 白名单过滤 |

---

## 4. 性能瓶颈

### 4.1 高严重度

**P1. 三处「1 秒全量轮询 + 整表替换」** — `app/components/todo/TodoList.vue:599`、`app/pages/index.vue:336-338`、`app/components/note/StickyNote.vue:415-416,436`
每秒执行：IPC → `SELECT * ... LIMIT 500`（dbService.ts:525-535）→ 整表替换响应式数组（全部子组件 props 对象身份变化、全列表重渲染）→ reminderService.sync 对每条 todo 重算提醒并 diff 定时器。主窗口隐藏（托盘驻留）时照常轮询；切到其他 tab 时 todo/note 因 v-if 卸载会停，但主页轮询不停。对比之下 `clipboardStore.ts:44-48` 专门做了 lastSignature 签名去重——三个轮询只有它做对了。
**修复**：改写后主动刷新 / DB 变更事件驱动；至少放宽到 3-5s + in-flight 去重 + 签名比对；窗口隐藏时暂停、`window-shown` 时恢复。
**预期**：后台驻留时 CPU/IPC 趋近于零；列表不再每秒无意义重渲染；顺带消除 L1 竞态。

**P2. paste 同步命令阻塞主线程 300ms + 4 处 unwrap 可 panic** — `src-tauri/src/lib.rs:333-352`
`#[tauri::command] fn paste` 为同步命令（Tauri v2 中在主线程执行），首行 `sleep(300ms)` 冻结 UI 事件循环；前端（PasteCommand.ts:58-64、pasteUtil.ts:41-47）还有 `setTimeout(200)`，单次粘贴总延迟 ≥500ms。`Enigo::new(...).unwrap()` 等 4 处 unwrap：Windows 上 SendInput 被 UIPI 拦截（目标窗口以管理员运行）等情况直接 panic 整个进程；命令无 Result 返回，错误无法传回前端。
**修复**：`async fn paste` + 返回 `Result<(), String>`，unwrap 改 `?`/log；评估能否缩短固定 sleep。
**预期**：粘贴期间 UI 不冻结；失败可感知可重试，无 panic 退出风险。

### 4.2 中严重度

**P3. 剪贴板主列表查询：排序无索引 + base64 全量加载** — `app/src/db/dbService.ts:264-271,214` + `src-tauri/src/lib.rs:112`
主查询 `ORDER BY updated_at DESC`，现有索引却建在 `created_at`（idx_timestamp）上，排序全表扫描；`SELECT *` 把 content（图片行是整段 base64 data URL）随最多 max_save_count 行全量拉进 WebView 内存；每次 fetch 还要先额外查一次 settings 的 max_save_count（L264，无缓存）。trimClipboard 的 `ORDER BY updated_at ASC`（L221）同样无索引。
**修复**：补 `idx_clip_updated ON clipboard(updated_at DESC)`；列表查询分两段——先查元数据列、图片 content 懒加载；max_save_count 缓存并在修改时失效。
**预期**：列表打开从"全表排序 + 数 MB base64 传输"降为索引序 + 轻量列，内存与滚动卡顿显著下降。

**P4. 统计页每次加载 11 次 SQL，其中 7 次完全重复** — `app/src/statistics/userTags.ts:334-341` + `StatsPage.vue:144-150`
`computeTags/computeUniqueTitle/computeTitleScores` 各自 `buildCtx`（getStatsRange + getActiveDays + getEarliestDate），叠加页面自身调用：getStatsRange ×4、getActiveDays ×3、getEarliestDate ×3，参数完全相同；自定义日期选择还触发两次完整 load（L178-180 无防抖）。
**修复**：buildCtx 按 `from|to` memo，或页面算一次传入。
**预期**：每次 load 从 11 次查询降到 4 次，切换范围更跟手。

**P5. HighlightText 逐字符拆 span** — `app/components/mainpage/HighlightText.vue:2-5,18-61`
`text.split('')` + `v-for` 每字符一个 span：搜索框每敲一键对每个可见行重建全部字符（50 行 × 百余字符 ≈ 上万 span/键）；`split('')` 按 UTF-16 码元切分会拆散 emoji（乱码）；未开启高亮时也走拆分分支。
**修复**：无高亮直接渲染纯文本；有高亮按"普通片段+命中片段"分片；用 `Intl.Segmenter` 处理字素。
**预期**：搜索输入显著流畅，emoji 正常显示。

**P6. useNow 每个组件实例一个每秒定时器** — `app/composables/useNow.ts:11-16`
`Todoitem.vue:327` 每张卡片调用一次 + `TodoList.vue:270` 一次：100 张卡 = 101 个每秒定时器，各自触发卡片内 `isOverdue/formatDueDate` 重算。同项目其他 composable 均为模块级单例，此处不一致。
**修复**：模块级共享 ref + 单定时器。**预期**：定时器数从 O(N) 降为 1。

**P7. 逾期判断挂进每秒变化的 now，统计每秒全量重算** — `app/components/todo/TodoList.vue:303-313`
`onTimeRate` computed 无条件依赖 `now.value`，即使与逾期无关也每秒触发全列表 filter + 模板重渲染；overdue 筛选下每秒重算+重排并连锁触发 L616 的 watch 重写 todoStore。
**修复**：算出"下一个最近截止时刻"用单个 setTimeout 刷新；或 now 粒度降为分钟级。**预期**：每秒重算降为按需刷新。

**P8. 设置页每敲一个字符写一次库** — `app/components/setting/SettingMain.vue:83-88`
`watch(apiKey)` / `watch(maxLimit)` 对输入框深度监听并直接 `setKeyValue`（INSERT ... ON CONFLICT DO UPDATE），粘贴长 API key 瞬间十几次写库。
**修复**：300-500ms 防抖或改 @change/@blur 持久化。**预期**：写库次数从每键 1 次降为停止输入后 1 次。

**P9. 便签搜索每键查库** — `app/components/note/StickyNote.vue:174-190`：`watch([searchScope, noteSearch])` 无防抖，连续输入 = 连续 SQL。→ 300ms debounce。**预期**：查询次数从每键一次降为停顿后一次。

**P10. tooltip 文本模式全行渲染** — `app/pages/tooltip.vue:43-51,270-275`：`lines` computed 无上限，万行级内容创建 2 万+ DOM 节点（窗口可滚动但 DOM 不裁剪）。→ 仅渲染可视范围附近行或截断提示。**预期**：超长内容不再卡死 tooltip 窗口。

**P11. 图片查看器全量 IPC** — `app/pages/index.vue:640`：`latestImagePayload` 把当前列表全部图片 base64 打进一个事件负载，双击/切换时全量序列化传输。→ 只发当前图 ± 相邻 N 张或传 id 按需拉取。**预期**：双击大图打开延迟显著下降。

### 4.3 低严重度

| 位置 | 问题 | 修复 → 预期 |
|---|---|---|
| `app/components/note/StickyNoteItem.vue:214` | 每张卡片向 window 挂一个 `save-note` 监听（首屏 40 个），仅编辑中的生效 | 父组件统一监听 → O(1) |
| `app/pages/index.vue:589-591` | refocusList 固定 3 次 restoreFocus（120/320/600ms），每次多次 IPC 并连带 resetTooltipSingleton | 执行一次 + 按结果决定重试 |
| `app/components/mainpage/TitleBar.vue:91` | `onResized` 每个 resize 事件发一次 isMaximized IPC，无节流 | rAF/100ms 节流 |
| `app/src/db/dbService.ts:249-257` + `lib.rs:48-53,116-135,175-197` | FTS5 全文索引"只写不读"：3 个触发器每次写入维护 clipboard_fts，搜索却走 `LIKE` 全表扫描；且外部内容表触发器未用官方 `'delete'` 命令模式，有索引残留风险 | 搜索改 MATCH，或删除 FTS 与触发器 |
| `app/components/todo/DueTimeSelect.vue:774,804` | 模板对每分组两次调用 customGroupOptions，每次渲染重复 filter+map | 面板打开时预计算 computed |
| `app/pages/index.vue:45-87` | 对 activeTab 连挂三个 watch（关 tooltip / 存滚动 / 聚焦搜索） | 合并为一个 watcher |
| `app/src/statistics/statsService.ts` + `mockData.ts` + `dbService.ts` | 同一数据库三处独立 `Database.load`，各持连接 | 抽 `getDb()` 单例 |

---

## 5. 代码重复与死代码

### 5.1 高严重度

**D1. 三套"删除确认"实现并存，其中一整套窗口机制是死代码**
- `app/components/common/DeleteConfirm.vue` — 唯一实际使用的（index.vue:22, 870-876）；
- `app/components/mainpage/DeleteConfirmation.vue` — **全项目零引用**，死组件；
- `app/pages/delete-confirm.vue` — **死页面**：全项目没有任何 `new WebviewWindow(..., { url: '/delete-confirm' })`，其 emit 的 `delete-confirm:yes/no/closed`（L38/44/104）零监听、其 `listen('delete-confirm:payload')`（L80）无人发送；
- `app/pages/index.vue:383` 注释仍声称"焦点恢复已由 delete-confirm:yes/no/closed 事件可靠触发"，与实际代码（只监听 image-viewer:closed）矛盾，误导维护。
**修复**：删除死组件与死页面（连同 app.vue:4 对 '/delete-confirm' 的判断），更正注释。
**预期**：删除路径唯一，净减约 280 行死代码与错误文档。

### 5.2 中严重度

**D2. 粘贴时序两份实现** — `app/src/commands/local/PasteCommand.ts:38-65` ≡ `pasteUtil.ts:21-48`：整段"写剪贴板 → hide 窗口 → 200ms 后 invoke('paste')"逐行相同（连注释都一样），PasteCommand 未复用 pasteUtil（L4 的 id bug 正是没复用导致的）。→ PasteCommand 改调 `pasteContentToActiveApp()`。

**D3. 剪贴板方向键移动三套实现** — `clipboardStore.ts:96-102`（moveSelection，index.vue 在用）、`TargetMovementCommand.ts:41-45,57-61`（手写 + selectRow 内部双重赋值）、`index.vue:225,229`。→ 统一只保留 moveSelection。

**D4. 便签/常用剪贴键盘导航约 60 行逐行复制** — `StickyNote.vue:333-409` ≈ `PinnedClipList.vue:142-197`（capture 监听、编辑态豁免、findNearestInDirection、Delete 确认、preventDefault 收尾）；`scrollSelectedIntoView` 更有四份变体（StickyNote.vue:309-325、PinnedClipList.vue:133-139、clipboardStore.ts:105-111、index.vue refocusList 内联）。→ 抽 `useListKeyNav(options)`。**预期**：键盘导航行为统一，新列表页零成本接入。

**D5. 两套 tooltip 实现** — `app/components/mainpage/Tooltip.vue` 死组件（其派发的 CustomEvent 全项目零监听）+ 实际使用的独立窗口 `app/pages/tooltip.vue`；`index.vue:98-103,277,290-313,431` 维护的 tooltip ref 从未被模板渲染。→ 删除死组件与死状态。

**D6. 逾期判断两套** — `Todoitem.vue:431-436`（带 isNaN 守卫）vs `TodoList.vue:312-313`（靠 `NaN <= x === false` 的巧合）。→ 抽公共 `isTodoOverdue(todo, nowMs)`。

**D7. 智能提醒分档口径两处硬编码** — `Todoitem.vue:370-376` 的悬停提示 vs `reminderPolicy.ts:106-112` 的实际策略，阈值一改提示即漂移。→ reminderPolicy 导出 `describeSmartPlan(todo)`。

**D8. 下拉定位三套路线** — `DueTimeSelect.vue:137-168,459-488` 自研约 55 行（文件头自述的"防裁切"理由 UiDropdown 已解决）；CategorySelect/PrioritySelect/ReminderPicker 统一走 `UiDropdown`；另有窗口级 `usePopupPosition.ts` 概念并存易混。→ DueTimeSelect 迁移 UiDropdown 或抽 `useDropdownPosition.ts`。

**D9. 日期格式化/解析散布 ≥6 处，时区语义无单点保证** — 格式化：`formatDate.ts:16-99`、`Todoitem.vue:445-451`、`DueTimeSelect.vue:83-97`、`ReminderPicker.vue:97`、statsService/mockData/StatsPage 各自的 toDateString/fmtDate 三份逐字拷贝（`statsService.ts:56-61`、`StatsPage.vue:30-35`、`mockData.ts:36-41`）；解析：`new Date(...)` 散布 15+ 处。风险：`new Date('2026-08-29')`（date-only）按 **UTC** 解析而 `'2026-08-29T10:00'` 按本地时区——dueDate 混入 date-only 字符串时东八区偏 8 小时，各处均无防御。→ 新建 `app/src/utils/datetime.ts` 收敛 parseLocalDateTime/formatDueShort/toISO，全部调用点迁移。

**D10. DueTimeSelect 同文件两个逐字等价的 ISO 格式化函数 + 6 段复制模板** — `DueTimeSelect.vue:42-43` vs `425-426`（toISO ≡ fmtDateTimeLocal）；L612-793 六段近乎相同的"重命名输入行"（各约 19 行）。→ 删一个函数；抽 `RenameRow.vue` 净减约 100 行（也是给 860 行文件减负的最大单项）。

**D11. 快捷键归一化启发式三份** — `StickyNote.vue:210-215`、`StickyNoteItem.vue:203-208`、`ShortcutManager.ts:47-48` 各自手写"被污染默认键"判断（`k === 'control+n' || k === 'n'` 等）。→ shortcutFormat.ts 增加 `normalizeShortcutKey/matchesKeyId` 共享。

### 5.3 低严重度（死代码合集）

| 位置 | 内容 |
|---|---|
| `app/src/clip.ts` | 全文件 38 行纯注释（旧实现残留） |
| `app/src/commands/local/EnterCommand.ts` | 全文件空壳（"待迁移"），零 import |
| `app/src/commands/local/DelCommand.ts:6` | 导出的 `deleteTarget` ref 无命令/页面引用 |
| `app/src/commands/local/TargetMovementCommand.ts:66-72` | "兼容导出" re-export 垫片 |
| `app/src/commands/local/todoStore.ts:21-27` | getSelectedTodo/getSelectedTodoIndex 死导出 |
| `app/src/db/dbService.ts:394-397` | `getShortcutSetting` 死代码（查询 type='shortcut' 永远为空，真实数据在 shortcut_binding 表） |
| `app/src/statistics/mockData.ts:193-201` | `isStatsEmpty` 零调用方 |
| `app/src/statistics/userTags.ts:407` | 死 re-export `DailyStatRow` |
| `app/src/utils/formatDate.ts` | `formatTimestamp` 零引用；docblock 写 ISO 字符串、签名却是 number |
| `app/components/todo/TodoList.vue:296` | `pendingCount` computed 零引用 |
| `app/components/todo/Todoitem.vue:367,378-382` | `reminderActive/reminderTip` 模板零引用，等价逻辑已在 ReminderPicker 内实现（双份维护） |
| `app/pages/index.vue:5,604-608` | 未使用的导入 dataLength/getSelectedRow；`lines.length === 0` 不可达分支 |
| `app/assets/css/index.css` | **整个文件无任何 import**，却定义了与 main.css:400-407 同名冲突的 `.list-row`（覆盖 transition 与 hover 缩放）——一旦被引入会静默破坏列表样式 |
| `tailwind.config.js:47-60` | curtainIn/curtainOut keyframes 与 animate-curtain-in/out 零使用 |
| `app/app.vue:33` | `mainFocused` 只赋值从未读取 |
| `app/app.vue:94-98` | 关闭子窗口循环 tooltip 分支与 else 分支完全等价 |
| `src-tauri/src/lib.rs:323,328-331` | `close_app` 命令前端零调用 + `window.close().unwrap()` 可 panic |
| `app/src/db/dbService.ts:328-331` + `lib.rs:215,220` | `pinned_clip.sort_order` 恒写 0，迁移专建的 idx_pinned_sort 索引无查询可用 |

另有两处同类样板重复：`useTooltipEnabled.ts:8-16` ≡ `useSearchHighlight.ts:8-16`（同构布尔设置单例，SettingMain 里还有第三、四个同款）→ 抽 `createBooleanSetting(key, default)` 工厂；`StickyNote.vue:240-246` ≡ `PinnedClipList.vue:40-44`（hint toast）→ 抽 `useHint()`。

---

## 6. 命名不一致

**N1.（中）`Todoitem.vue` emit 参数名与类型直接矛盾** — `app/components/todo/Todoitem.vue:290`：`(e:'reminder-change', id, mode, remindAt?: string)` 实际传 `ReminderRule[]`（L384-390 传 rulesList），是旧 remindAt API 残留；父组件 `changeReminder` 签名则是 `rules: ReminderRule[]`。→ 改 `rules?: ReminderRule[]`。

**N2.（中）DB 列命名 camelCase/snake_case 混用** — 同一 todo 表：`dueDate`（camelCase，lib.rs:65）vs `remind_mode/remind_at/remind_rules`（snake_case）；Entity 层映射 `remindRules` 只能靠 `as unknown as { remind_rules?: string }` 强转桥接（dbService.ts），类型系统在此失效。→ 迁移统一 snake_case，Entity 补原始字段。

**N3.（低）拼写错误（用户可见）** — `index.vue:362,363,473,485,489` "常用剪贴**版**"（正确为"常用剪贴板"，见 useTabs.ts:30）；`index.vue:323,327` `handelFilter/handelTypeFilter`（handle）。

**N4.（低）文件名大小写两套并存** — 同目录 `app/src/commands/local/` 下 PascalCase（TargetMovementCommand.ts 等 16 个命令）与 camelCase（clipboardStore.ts、todoStore.ts、pasteUtil.ts）混装；`app/src/Entities.ts`、`app/src/utils/SystemOS.ts` 是仅有的 PascalCase ts 文件。→ 命令类 PascalCase、store/工具 camelCase 各归目录；Entities.ts → entities.ts。

**N5.（低）名不副实的命名** — `TargetMovementCommand`（内部是 ArrowUp/ArrowDown 按键命名而非行为命名）；`SaveNoteCommand` 实际还负责待办编辑（L15-16 派发 todo:edit-request）；`StickyNote.vue:411` 的 `fetchTodos` 实际拉便签（复制粘贴痕迹）；类名 `ClipboardService` 实际承载六大领域，且同一模块被 import 为 `clipboardService`（SettingMain.vue:7）与 `dbService`（useColorScheme.ts:3）两个惯用名。

**N6.（低）注释/文档漂移** — `useLongPressReorder.ts:18` 注释"默认 700"实际 500；`formatDate.ts:3-15` docblock 与签名不符；`Command.ts:2` 用临时结构类型 `{ state: string }` 而非 `'Pressed'|'Released'` 字面量联合（拼错不报编译错）。

**N7.（低）legacy 双字段长期交织** — `Entities.ts:44-45,52-55`：`priority`（文本三档）vs `priorityLevel`、`remindAt` vs `remindRules`；TodoList.vue:501-507 每次改提醒仍写 `remindAt: ''`。→ 迁移完成后删除 legacy 列。

---

## 7. 目录结构与构建配置混乱

**S1.（高）构建链路三处互相矛盾** — 见 L9（`frontendDist` → 仓库外符号链接、nitro publicDir 覆盖、strictPort: false 与注释矛盾、`.env` 的 TAURI_DEV_PORT 无人读取）。这是唯一"在别人机器上必然失败、在自己机器上静默出错"的结构性问题。

**S2.（高）`tauri:dev` 脚本在 Windows 下永远起不来** — `package.json:11` `"tauri:dev": "nuxt dev & tauri dev"`：Windows npm 经 cmd.exe 执行，`&` 是顺序执行，`nuxt dev` 永不退出、`tauri dev` 永不启动；且该 nuxt dev 不带端口参数，beforeDevCommand 又会再起一个 → 双 dev server。→ 改 `"tauri:dev": "tauri dev"`。

**S3.（中）`app/src` 与 Nuxt 4 约定并存，共享代码两个家** — Nuxt 4 srcDir 是 `app/`（components/composables/pages 自动导入），项目又自建 `app/src/{commands,db,statistics,todo,utils}` 全靠 `~/src/...` 手动 import；同是全局状态，`clipboardStore/todoStore` 住在 commands 目录（且直接做 DOM 操作，clipboardStore.ts:105-111），而 `useTabs/useCategories` 住在 composables——两套单例模式并存；`~/src` 与 `~/composables` 别名混用遍布 20+ 文件；tailwind content 也不覆盖 app/src（目前只靠"src 里不拼类名"的隐含约定未踩坑）。→ `app/src/utils` → `app/utils`（自动导入），store 迁 `app/composables`，src 仅保留领域模块（db/statistics/todo/commands）或整体更名 `app/services` 并在 README 固化约定。

**S4.（中）commands 目录划分依据名不副实** — 目录按 scope 命名（global/local/shortcuts），但目录归属 ≠ 实际注册 scope：`local/FocusSearchCommand` 默认注册为 global（InitShortcuts.ts:161）、`local/PinnedClipPasteCommand`、`local/ClipboardSlotPasteCommand` 也是 global（:188,198）、`HideWindowCommand` 与 `global/ToggleWindowCommand` 同为窗口控制却分居两目录；local/ 还混装命令、状态 store、工具三类模块。→ 按领域分（window/、clip/、note/、todo/），scope 只是配置数据；store/工具外迁。

**S5.（中）Rust 侧 7 个直接依赖零引用** — `src-tauri/Cargo.toml:21-36`：`serde/serde_json/arboard/tokio(features=full)/chrono/time/sqlx` 在代码中零引用（lib.rs 实际只用 std::time、tauri 及插件、enigo、log）。→ 删除。**预期**：编译时间显著缩短、二进制更小、供应链面缩小。

**S6.（中）过度授权与安全配置缺失** —
- `capabilities/default.json:55-56` `fs:read-all` / `fs:write-all`：授予 WebView 全盘读写，但前端 grep 无任何 `@tauri-apps/plugin-fs` 导入（剪贴板内容常含敏感文本，WebView 被注入时波及文件系统）→ 删除插件与权限；
- `tauri.conf.json:26-28` `csp: null` 关闭内容安全策略 → 配置最小 CSP；
- `capabilities/default.json:54` devtools 权限 + `Cargo.toml:24` `unstable` 特性带入生产 → 移除；
- `.github/workflows/release.yml:83-88` workflow_dispatch 的 tag 输入直接内插进 shell（注入面）→ 改 env 传递；:38-43 用 `npm install` 替代 `npm ci` 牺牲可复现性 → 统一 Node 版本后改回。

**S7.（中）未使用的 alpha 依赖** — `package.json:22` `@tauri-apps/plugin-window@^2.0.0-alpha.1`：前端 grep 零导入（窗口操作全走 `@tauri-apps/api/window`），且 lock 中来自 npmmirror（registry 混用）。→ 删除。

**S8.（中）`sqlTest.sql`：已入库、含语法错误、与真实 schema 全面漂移** — `src-tauri/src/sqlTest.sql`：L87 `key text title not null ,` 两个类型名无法执行；列名是旧 schema（create_time/last_use vs 真实 created_at/updated_at）；settings CHECK、默认值（'dark' vs 'light'）、表名（setting_shortcut vs shortcut_setting）全部漂移。→ 删除或移入 docs/ 归档并标注"仅历史参考"。

**S9.（中）单文件过大、多职责耦合** — `DueTimeSelect.vue` 860 行（快捷项计算 + 自研定位 + 右键菜单 ×2 + 分组管理 + 6 处编辑态，见 D10）→ 拆为 DueTimeSelect/DueTimePanel/RenameRow + useDropdownPosition；`dbService.ts` 547 行混装剪贴板/常用剪贴/便签/待办/设置 KV/快捷键六个领域且埋点散布 8 处 → 拆 clipboardRepo/noteRepo/todoRepo/settingsRepo + 共享 getDb()；`index.vue` 898 行、`StatsPage.vue` 805 行、`SettingMain.vue` 819 行同理值得拆分。

**S10.（低）根目录与仓库卫生** — `.doc/统计模块设计文档.md`（72KB）已提交进 git 且藏在隐藏目录；`.commit_msg`、`src-tauri/cargo_update.log`（34KB UTF-16 会话日志，含本机用户路径）散落根目录；`src-tauri/gen/schemas` 提交进 git（可生成物）。→ 设计文档移 `docs/`，删除杂物，gen/ 评估入库策略。

**S11.（低）nuxt.config plugins 冗余** — `nuxt.config.ts:26-30` 显式列出 plugins 数组，与 `app/plugins` 目录自动注册重复（已核实不会双重注册，但配置冗余、掩盖"目录即注册"约定）。→ 删除数组。

**S12.（低）分层方向倒置** — `app/src/todo/reminderService.ts:20`（领域服务层）反向依赖 `app/composables/useTodoSmartRemind`（视图层目录）里的策略开关。→ 开关状态移入 `app/src/todo/`，composables 只留设置页绑定入口。

**S13.（低）组件目录职责漂移** — `app/components/mainpage/` 里放的是 Tooltip/DeleteConfirmation/ContextMenu 这类通用弹层（且前两个是死代码）；`commands/global` 与窗口隐藏相关命令分裂。→ 按职责归位。

---

## 8. 建议的优化路线图

### 第一阶段：止血（数据正确性与构建，约 1~2 天）
1. **L9/S1** 修复构建链路（frontendDist、nitro publicDir、dist 符号链接、strictPort）——否则 CI 与他人环境永远不可用；
2. **L2** 移除生产环境 seedMockStats 调用与测试面板入口（防数据摧毁，改动极小）；
3. **L4** PasteCommand 改传 id（一行）；
4. **L8** 修复 priority_level 回填条件（老用户数据在丢失，每拖一天多丢一批）;
5. **L3** setTimeout 溢出钳制；
6. **L15** 接通 setTodoSmartRemindEnabled。

### 第二阶段：核心体验（快捷键/粘贴/轮询，约 3~5 天）
7. **L6** ShortcutManager 编辑态守卫（便签换行、编辑误粘贴）；
8. **L7/L14** Ctrl+F 改 local + 冲突检测归一化；
9. **P1** 三处轮询改造（签名比对 + 间隔放宽 + in-flight + 隐藏暂停），顺带消除 L1 竞态；
10. **P2** Rust paste 改 async + Result；
11. **L5** pinned 页 Enter 粘贴语义；
12. **E1-E6** 统一错误处理（withDb 封装 + 命令 catch + unlisten 清理）。

### 第三阶段：结构与还债（约 1~2 周，可分批）
13. **D1/D5** 删除三套删除确认中的两套死实现、死 tooltip 组件、L11 全部死代码合集（净减约 600+ 行）；
14. **S3/S4** 目录归位：app/src/utils → app/utils，store 迁 composables，commands 按领域分；
15. **D9** 建 `utils/datetime.ts` 收敛日期处理，统一时间戳格式（L19/L22 一并解决）；
16. **D2-D4、D8、D10** 合并重复实现（粘贴、方向键、键盘导航、下拉、重命名行）；
17. **P3-P9** 性能项（索引、懒加载 base64、统计 memo、useNow 单例、防抖）。

### 第四阶段：加固与规范
18. **S5-S7** 依赖瘦身（Rust 7 个死依赖、alpha 包）与权限收敛（fs:read-all、CSP）；
19. **S8/S10** 清理 sqlTest.sql 与仓库杂物；
20. 统一命名（N1-N7）、补 AGENTS/README 目录约定、修正误导性注释（index.vue:383、useLongPressReorder.ts:18 等）。

**总体预期效果**：修复第一批后，应用的数据可信度（统计不被摧毁、提醒不误报不丢失、粘贴计数正确）和 CI/发布可用性恢复；第二批后，核心操作（粘贴、快捷键、勾选待办）不再有竞态与冻结，后台空闲资源占用接近零；第三批后，代码库净减约 800~1000 行重复/死代码，"改一处漏一处"的多实现问题消除，新人可按 Nuxt 约定预测文件位置；第四批后，攻击面缩小、依赖健康、构建可复现。

---

## 附录：修复实施记录（2026-08-29）

本报告中的全部问题已按四阶段路线图逐项修复。以下为分类修复摘要与少量有意保留的偏差说明。

### 已修复（按阶段）

**第一阶段（止血）**
- L9/S1 构建链路：`frontendDist` 改为 `../.output/public`、删除 `nitro.output.publicDir` 覆盖与仓库外 `dist` 符号链接、`strictPort: true`、devServer 端口接 `TAURI_DEV_PORT`（nuxt build/generate 已验证产物落位 `.output/public`）。
- L2 mock 数据生产泄漏：删除 app.vue 的 `seedMockStats(true)` 启动调用；测试面板 `v-if="import.meta.dev"` 门控；mockData 改为 dev-only 动态导入；删除死函数 `isStatsEmpty`。
- L4 PasteCommand 行索引当 id：改传 `getSelectedRowId()`。
- L8 priority_level 回填死逻辑：循环内记录本次实际补列，回填恢复生效。
- L3 提醒 setTimeout 溢出：新增 `scheduleTimer` 分段挂载（超过 2³¹-1 续排）。
- L15 智能提醒开关：设置页改走 `setTodoSmartRemindEnabled` 持久化；reminderService 内 watch 开关即时重排。

**第二阶段（核心体验）**
- L6 编辑态守卫：ShortcutManager 全局 `isEditingField()`（白名单 `.todo-search-input`）+ E4 命令执行 try/catch。
- L7 Ctrl+F 改回 `local`；L14 冲突检测修饰键归一化（`normalizeShortcutKey`）；E5 `registerAll` 返回失败项，`updateShortcutKey` 失败回滚不持久化。
- P1 三处轮询：主页/待办/便签统一「签名比对 + in-flight 去重 + 窗口隐藏暂停 + Tab 非激活暂停」，待办放宽至 3s；L1 竞态通过 `pendingWrites` 写库挂起轮询 + 失败回滚解决。
- P2 Rust `paste` 改 `async` + `spawn_blocking` + `Result<(), String>`（4 处 unwrap 消除）。
- L5 pinned 页 Enter 误粘贴：PasteCommand 仅在 clip Tab 响应。
- E1-E7 错误处理：TodoList `withDbWrite` 统一包装、index.vue 删除/收藏 try/catch、3 个未清理 listen 补 unlisten、dbService upsert + 回调保护、3 个单条查询补 `ensureDbInitialized` 与 `| undefined` 返回类型、registerAll 失败回滚、退出 flush 等待完成后再关闭窗口。

**第三阶段（结构与还债）**
- D1/D5 死代码删除：`pages/delete-confirm.vue`、`mainpage/DeleteConfirmation.vue`、`mainpage/Tooltip.vue`（连同 app.vue 模板条件与 capabilities `delete-confirm-*`）、`assets/css/index.css`、`EnterCommand.ts`、`clip.ts`、`DelCommand.deleteTarget`、`TargetMovementCommand` 垫片、`todoStore` 死导出、`getShortcutSetting`、`formatTimestamp`、`pendingCount`、`reminderActive/reminderTip`、tailwind curtain keyframes 之外的死状态等。
- S3/S4 目录归位：`app/src/utils` → `app/utils`（Nuxt 约定，23 个文件 import 重写）；`TargetMovementCommand.ts` → `CursorMoveCommand.ts`（统一方向参数）、`SaveNoteCommand.ts` → `ContextEditCommand.ts`、`Entities.ts` → `entities.ts`、`SystemOS.ts` → `systemOS.ts`；D3 方向键统一走 `clipboardStore.moveSelection`；D2 PasteCommand 复用 `pasteUtil`。
- D9/D19 日期收敛：新建 `app/utils/datetime.ts`（`toDateString` 三份拷贝合一、`parseLocalDateTime` 统一时区语义、`toLocalISO`）；reminderPolicy 接入统一解析。
- D6 formatDate 接受 string|number 并归一化（三处 `parseInt` 强转兜底）；D7 `describeSmartPlan` 单一来源；D11 `matchesKeyId` 共享匹配；P5 HighlightText 分片渲染；P6 useNow 模块级单例；P9/P8 防抖；P10 tooltip 行数上限；P11 图片查看器按临近窗口传输；D21 `SettingInput`/`ShortcutRow` 子组件收敛重复模板；布尔设置工厂 `createBooleanSetting`。
- 命名与杂项：`handelFilter` 拼写、"常用剪贴版"错别字、`Todoitem` emit 参数类型、`remind_rules` 原始字段直读（去掉 `as unknown as`）、`DatabaseService` 类名、L12/L13/L16/L17/L18/L19/L20/L21-L24 等逻辑错误全部修复、低严重度表格逐项修复（LIKE 转义、LIMIT 钳制、月份提示越界、todayStr 跨天、viewer 响应式、DeleteConfirm immediate、errorMsg 重置、面板上边界钳制、拖拽计数 catch、release.yml 注入面等）。

**第四阶段（加固与规范）**
- S5 Rust 删除 7 个零引用依赖（serde/serde_json/arboard/tokio/chrono/time/sqlx）；S6 移除 fs 全盘授权、devtools 权限、`unstable` 特性、`csp: null` 改为最小 CSP；S7 删除未使用的 `plugin-window` alpha 依赖与 `plugin-fs`；S2 `tauri:dev` 改为 `tauri dev`；S8 删除 `sqlTest.sql`；close_app 死命令删除；FTS 只写不读 → 迁移 11 删除触发器与索引表；迁移 12/13/14 补 `idx_clip_updated`、删除无用 `idx_pinned_sort`、修正 `color_scheme` 种子默认值；S10 仓库杂物清理（`.commit_msg`、`cargo_update.log` 删除，`.doc/` 设计文档迁入 `docs/`）。

### 有意保留/部分实施的项（及原因）

1. **D4 键盘导航三处实现未合并为 `useListKeyNav`**：便签（网格最近邻 + Ctrl+N/Ctrl+Enter 特殊键）与常用剪贴（双列瀑布流）语义差异明显，强行抽取会引入难以验证的键盘回归；已修复各自缺陷（编辑态守卫、确认框互斥），重复保留并注释。`scrollSelectedIntoView` 的主页列表变体已统一进 `clipboardStore`。
2. **D8 DueTimeSelect 未迁移 UiDropdown**：该组件面板内含分组管理与右键菜单等复杂交互，整体迁移风险大于收益；已修复其自研定位的上边界缺陷、重复函数与跨天 min 过期问题。
3. **D10 六段重命名输入行未抽取 `RenameRow`**：纯模板去重（约 100 行），需人工逐段验证六处交互，本轮未做；同文件的两个逐字等价函数已合并。
4. **N2 DB 列名 camelCase/snake_case 混用（`dueDate` vs `remind_*`）**：统一列名需要数据迁移改列名，影响存量库且收益纯观感；已在实体层消除类型强转漏洞，列名统一留给下次 schema 演进。
5. **release.yml 的 `npm install`（未改回 `npm ci`）**：注释明确记录本地 Node 24 与 CI Node 22 的 lock 兼容性问题；需先统一 Node 版本再切换，本轮不动以免破坏 CI。

### 验证

- `nuxt build` / `nuxt generate`：通过（generate 产物正确落在 `.output/public`，与 `frontendDist` 一致）。
- `cargo check`：通过（Rust 侧含 4 个新增迁移与 paste 异步化）。
- 数据库迁移安全性：未改动任何已发布迁移（v1-v10 原样保留，仅追加 v11-v14），避免 sqlx checksum 校验失败毁坏存量库。
- 建议人工冒烟路径：复制/粘贴（Enter 与 Ctrl+数字）、待办勾选与提醒、便签编辑与 Ctrl+N、常用剪贴编辑、设置页开关重启后保持、托盘驻留失焦隐藏与唤出、双击图片查看器。

### 附记：运行验证暴露的收尾修复（同日第二轮）

首轮修复后在实际运行中暴露两个批量重命名遗漏（`nuxt build` 不做类型检查，无法在编译期拦截）：

1. `dbService.ts` 底部实例化行 `const clipboardService = ClipboardService.getInstance()` 与 `getInstance` 内的 `return ClipboardService.instance` 未随类名改名 `DatabaseService` → 运行时 `ReferenceError`（用户报告的 547:26）。已修复。
2. `reminderPolicy.ts` 中 `../utils/datetime` 相对导入未随 `app/src/utils → app/utils` 目录迁移更新 → dev 模块解析 404。已改为 `~/utils/datetime`。

**新增验证门禁**：安装 `vue-tsc + typescript@5.8 + @types/node`（devDependencies），`npx nuxi typecheck` 全量通过（0 错误）。类型检查额外揪出并修复了 9 处存量严格模式问题（TodoList 提醒回调签名、`withDbWrite` 泛型、userTags `CtxBase` 类型与 `scored[0]` 越界守卫、statsService `mergePending` 边界、AddToPinnedCommand 访问 `ClipboardData` 不存在的 `name` 字段等）。

后续验证均带 `pipefail` 严格退出码：`nuxt build` ✓、`nuxt generate` ✓、`cargo check` ✓、dev server 请求级验证（`/`、`/tooltip`、`/viewer`、dbService 模块转换）全部 200、日志 0 错误。建议保留 `npx nuxi typecheck` 作为提交前检查。

### 附记：快捷键编辑态守卫二次修正（同日第三轮）

用户实测反馈剪贴板页 Ctrl+←/→ 失效。原因：编辑态守卫一刀切拦截了所有可编辑元素内的按键，而主剪贴板页**默认聚焦在搜索框**（搜索框是"命令面板"：↑/↓ 选择、Enter 粘贴、Ctrl+←/→ 切标签都从这里触发）。守卫重构为分级放行：

- 带修饰键（Ctrl/Alt/Cmd）的命令与 Escape：任何可编辑元素内都放行（恢复切标签/收藏/保存等）；
- 搜索框（`todo-search-input` / `list-search-input`）：额外放行无修饰的方向键与 Enter（列表导航与粘贴），Delete/Backspace 保持原生删字；
- 其余可编辑元素（便签 textarea、常用剪贴编辑框）：无修饰的文本编辑键不触发命令（保留 L6 修复：换行/删字/光标正常，不误触发粘贴）。

顺带行为改进：搜索框内 Delete 键由"劫持为删除列表项"改回原生删字。验证：typecheck 0 错误、build 通过、dev server 下 StatsPage 懒加载模块与 ShortcutManager 转换均 200。

### 附记：tooltip「消失」诊断结论（同日第四轮）

用户反馈剪贴板 hover 不再出现 tooltip 窗口。通过 WebView2 远程调试（CDP）对运行中的应用做端到端自动化验证：

1. **功能链路完好**：mouseenter 触发 → tooltip 独立窗口创建 → `is_visible=true`、屏幕内坐标 (179,552)、卡片渲染行号/多行文本/元信息齐全（CDP 截图确认）；移到短内容项后窗口正确隐藏。
2. **根因是环境而非代码**：被悬停的剪贴内容本身就是用户复制的报错文本（`ERR_CONNECTION_REFUSED`）——复现"消失"的那次会话中 dev server 已死，tooltip 子窗口加载 `/tooltip` 页面失败（连接拒绝），自然什么都不显示；此外若在**纯浏览器**中打开 localhost:12912 测试，tooltip 独立窗口本身就不存在（`isTauri()` 为 false 时按设计禁用，该功能依赖 Tauri 多窗口）。
3. **结论**：无需代码修复；用 `npm run tauri:dev`（或保证 dev server 存活）并在 **Tauri 应用窗口**（非浏览器）内测试即可。诊断用的 playwright-core 依赖与脚本已移除。
