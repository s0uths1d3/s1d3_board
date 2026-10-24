# 代码审查报告（2026-10）

全量代码审查：交互体验 / 缺陷 / 增强 / 新功能设想。审查范围为 `dev` 分支当前代码（v0.5.1）。

- **范围**：应用外壳与主面板交互、todo / 便签 / 剪贴板 / 常用剪贴 / 智能剪贴（AI）、灵动岛 / 设置 / 统计 / 应用时长、数据层与 Rust 后端、i18n 与工具层
- **方法**：三路并行深读源码 + 关键结论逐条复核；所有条目均给出 `file:line` 引用
- **严重级别**：🔴 P0（数据正确性 / 数据丢失 / 明显功能失效）· 🟠 P1（功能在特定路径失效或明显伤体验）· 🟡 P2（边界场景缺陷 / 体验粗糙）· ⚪ P3（打磨项）
- 标注 **✅已验证** 的条目经过人工读码确认；其余条目定位准确但建议修复前先复现。

---

## 目录

1. [总览与优先修复清单](#1-总览与优先修复清单)
2. [Bug 清单](#2-bug-清单)
3. [交互体验提升](#3-交互体验提升)
4. [增强建议](#4-增强建议)
5. [新功能设想](#5-新功能设想)
6. [审查确认的亮点](#6-审查确认的亮点)

---

## 1. 总览与优先修复清单

| 类别 | 🔴 P0 | 🟠 P1 | 🟡 P2 | ⚪ P3 | 合计 |
|---|---:|---:|---:|---:|---:|
| Bug | 3 | 13 | 17 | 11 | 44 |
| 交互体验 | — | 5 | 9 | 5 | 19 |
| 增强 | — | 1 | 2 | 5 | 8 |
| 新功能设想 | — | — | — | 11 | 11 |

### 只修十件事（推荐顺序）

1. **统计 flush 部分失败后整批重试，daily_stat 虚增**（§2.1.1，🔴）
2. **备份导入无事务且列名未白名单**（§2.1.2，🔴——既是数据丢失风险也是注入面）
3. **Esc 关闭弹窗后事件冒泡，整窗被隐藏**（§2.9.1，🟠——每天都会撞到）
4. **note-colors 窗口竞态：点「完成」用默认色覆盖用户配色**（§2.3.1，🔴）
5. **置顶图片剪贴把整段 base64 写入 SQLite**（§2.4.1，🟠）
6. **周循环「每 N 周周 X」忽略 interval**（§2.2.1，🟠）
7. **重复任务继承过期 `at` 提醒规则，只响一次从此静默**（§2.2.2，🟠）
8. **`smart.new_scheme` i18n key 双语缺失，用户直接看到原始 key**（§2.6.1，🟠）
9. **统计遗漏 `tab_calendar` / `tab_app_usage` 两个新 tab**（§2.1.3，🟡）
10. **灵动岛文本读取补序列号门控**（§4.1，图片路径已门控、文本路径仍每 80ms 全量读，性能/健康收益最大的一项）

---

## 2. Bug 清单

### 2.1 数据层与统计

**2.1.1 🔴 统计 flush 部分失败后整批重试，daily_stat 虚增** ✅已验证
`app/src/statistics/statsService.ts:177-187`（`flushAppUsage` 同模式 :236-253）
`flush()` 遍历 `pending` 逐日 upsert，循环全部结束后才 `pending.clear()`。若第 N 天 upsert 抛错，catch 保留**全部** pending 下次重试——已写库的日期会被再次 upsert，而 `upsertDailyStat`（`statsRepository.ts:39-48`）冲突时执行 `col = col + excluded.col` 累加，重试即虚增。
**建议**：每写完一天立即从 pending 删除（逐日确认），或失败时只保留未成功日期。

**2.1.2 🔴 备份导入：破坏性操作无事务 + 列名未白名单**
`app/src/core/db/repositories/dataTransferRepository.ts:52-62, 106-114`
① `importData` 先对 6 张表 `DELETE FROM` 再逐行 INSERT，无事务包裹。中途失败（坏行 / DB 锁 / 磁盘错）会留下**半导入且原数据已删**的库，无快照可回滚——一个恢复操作反而可能丢数据。
② `insertRows` 用 `INSERT INTO ${table} (${cols.join(', ')})` 拼接列名，`cols` 直接来自导入 JSON 的 key。值虽参数化，标识符未防护——手工编辑或外发的备份文件可通过对象 key 注入 SQL。
**建议**：导入前先做一次快照（复用 `backupRepository` 的清空备份模式）或整表事务；列名按表白名单过滤。

**2.1.3 🟡 新增 tab 未纳入操作量统计**
`app/src/statistics/chartMath.ts:16-22`、`app/src/statistics/userTags.ts:129-147`、`app/src/statistics/story.ts:40-43`
`OPS_FIELDS`、`statTotal` 与两处 `sumTabs` 硬编码最初的 6 个 tab，遗漏 v15/v22 迁移新增的 `tab_calendar`、`tab_app_usage`（`app/src/tabs/tabKeys.ts` 的 `TAB_STAT_FIELDS` 是动态来源）。「总操作量」、画像标签分母（`todo_freak`、`note_poet` 等）与访问分布环图全部少算这两个 tab。
**建议**：从 `TAB_KEYS` 派生，`statsService.ts:60-67` 已有正确示范。

**2.1.4 🟡 Rust 同步命令在主线程做重磁盘 IO**
`src-tauri/src/commands/backup.rs:42-48`（`write_auto_backup` 全量 JSON 快照，含内联图片时可达数十~数百 MB）、`src-tauri/src/clipboard/image_store.rs:269-274`（`save_clipboard_image` 单次最大 20MB 写盘）、`image_store.rs:279-284`（读图 + base64）。这些是同步命令（Tauri 2 中跑在主线程），团队已为同样原因把 `read_clipboard_image_files` 改为 async（:287-296），但上述三个仍是同步；图片迁移（`migrator.ts:273`）与 importData 会在循环里调用 `save_clipboard_image`。
**建议**：改为 `async fn`。

**2.1.5 ⚪ 岛历史 API 超时状态码与文档矛盾**
`src-tauri/src/island/api.rs:360-362` 超时返回 **503**（`history_unavailable`），模块文档（api.rs:19 与头部注释）写的是 **504**；第三方按文档对接会错误分类。另外头部写「API v1.5.0 强制鉴权」而 `API_VERSION` 是 `"1.4.0"`（:36），版本漂移。

**2.1.6 ⚪ 生产日志泄漏剪贴板内容**
`app/src/core/db/repositories/clipboardRepository.ts:366` 每次保存 `console.log` 含内容概要；`statsService.ts:347,359` 的 `[icon-diag]` 日志每次渲染 dump 全部应用名与图标。devtools 里生产 console 变成剪贴板历史副本，建议降级或移除。

### 2.2 待办（todo）

**2.2.1 🟠 周循环忽略 interval 间隔** ✅已验证
`app/src/todo/recurrence.ts:59-68`
`nextWeekly` 在 1..`7*interval` 天里返回**第一个**命中的 weekday。「每 2 周周一」（interval=2）实际每周一都会触发；而 `describeRecurrence`（:113-121）会正确显示「每 2 周 周一」——文案与行为不一致。
**建议**：interval 应作用于锚点相位（以基准日所在周为第 0 周，只接受 `(weeksDelta % interval) === 0` 的命中日），并让 UI 预览下几次触发日期（见 §5.3）。

**2.2.2 🟠 重复任务继承过期的绝对提醒规则 → 提醒只响一次**
`app/composables/useTodoCore.ts:106`
生成下一期时 `remindRules: [...(todo.remindRules ?? [])]` 原样复制。`kind:'at'` 规则携带的是上一期的绝对时间，复制后永远在过去：`computeReminders` 归为 missed，`handleMissed`（`app/src/todo/reminderService.ts:207-215`）静默标记已发送。结果闹钟只响一次，之后每期都无声，过期规则还一直挂在任务上。相对规则（percent/offset）复制没问题，`at` 需要按新 due 重新锚定。

**2.2.3 🟡 日历「今天」在挂载时冻结**
`app/components/todo/TodoCalendar.vue:57`
`const todayKey = ymd(new Date())` 是普通常量。常驻托盘应用跨零点后，逾期携带分桶（:131）、今日高亮、isCarried 着色全部基于昨天的 key，直到 tab 重挂载。对照 `TodoList.vue:529` 已正确使用响应式 `useNow()`。

**2.2.4 🟡 `updateTodo` 乐观更新无回滚**
`app/composables/useTodoCore.ts:198-207`
先 `Object.assign(todo, updates, …)` 直接改共享单例对象，DB 失败仅 `return`——UI 显示新值、DB 是旧值，直到下次 3s 轮询被纠正（非 Tauri 模式则永远不一致）。`setCompletedState`（:119-135）是有回滚的，模块内部不一致。同模式还有 `TodoList.vue:717-725`（改优先级）、`744-752`（改分类），且都无条件 `syncTodoRef`。

**2.2.5 🟡 删除分类只重映射已加载页**
`app/components/todo/TodoList.vue:826-833`
`executeCategoryDelete` 遍历 `todos.value`（分页加载的前 ≤50 条）。该分类下未加载页的待办保留悬空分类串，之后在 `CategorySelect` 里选不中也看不到。应遍历 `statsTodos`（全量已在内存）或直接发一条 SQL UPDATE。

**2.2.6 🟠 提醒通知文案硬编码中文**
`app/src/todo/reminderPolicy.ts:56-76`（`'待办提醒'`、`「…」还有 30 分钟到期`）、`app/src/todo/reminderService.ts:230-236`（补发摘要）。英文 locale 用户收到的 OS 通知仍是中文，而模块其余部分已完整 i18n。

**2.2.7 🟡 宽限期内的提醒被静默吞掉**
`app/src/todo/reminderPolicy.ts:112-115`：自定义 `at` 提醒设在 90 秒后（或会话中设为过去时间）落入 2 分钟宽限被丢弃，`handleMissed` 直接标记已发送，用户「设了提醒却没响」且无任何解释。`ReminderPicker.vue:105-109` 只忽略空值，对过去/临近时间无守卫。

**2.2.8 ⚪ `reminderService.sync` 可能产生未处理 rejection**
`app/src/todo/reminderService.ts:136-139` await `readyPromise`；若 `start()` 初始化失败（:72-77 置 null 并 rethrow），`useTodoCore.ts:84` 的 `void reminderService.sync(all)` 每 3s 轮询都会抛一次未处理 rejection。

### 2.3 便签（note）

**2.3.1 🔴 配色管理窗口竞态：提交会用默认色覆盖用户配色** ✅已验证
`app/pages/note-colors.vue:36` 在 `onMounted` 里 `drafts.value = colors.value.map(...)` 快照，但 `useNoteColors()`（`app/composables/useNoteColors.ts:174-178`）只是**启动**异步 `load()`（走 `getKeyValue` IPC）。子窗口里 IPC 回复必然晚于挂载，草稿实际从 `DEFAULT_NOTE_COLORS` 起步——用户点「完成」（note-colors.vue:49-59）就把默认配色整表写库，覆盖自定义配色。
**建议**：快照前 `await ensureLoaded()`。

**2.3.2 🟠 重命名/删除配色会静默改掉使用该配色的便签**
`app/composables/useNoteColors.ts:192-214`
配色按**名称**做 key：`updateColor` 把「粉」改名「桃」后，所有存着 `color:'粉'` 的便签经 `resolveNoteColor`（:54-58）回退到默认黄色；删除同理。`note-colors.vue:49-59` 没有对依赖该配色的便签做迁移提示。

**2.3.3 🟠 便签搜索默认只搜已加载页且无感知**
`app/components/note/StickyNote.vue:226, 236-242`
`searchScope` 默认 `'current'`，输入只过滤流式加载的前几十条；UI 上没有任何范围控件，只有全局搜索跳转才翻转成 `'all'`（:1031）。搜索第 500 条便签会得到「无结果」。DB 搜索（300ms 防抖）已存在（:406-418），建议默认 `'all'` 或显式暴露范围。

**2.3.4 🟡 编辑保存窗口期内卸载导致双写**
`app/components/note/StickyNoteItem.vue:516-528, 534-538`
blur/Ctrl+Enter 后 emit `update` 并把 `finish-edit` 延迟 420ms；若组件在这 420ms 内卸载（保存后立刻切 tab），卸载守卫因 `props.note.content` 尚未更新（父组件在 `StickyNote.vue:524-525` 用新对象替换数组项）会再次 emit `update`——重复 DB 写 + 重复「已保存」岛提示。`commitTags` 也有同样的基于过期 props 的比对风险。

**2.3.5 🟡 `createNote` 无错误处理**
`app/components/note/StickyNote.vue:467-479`：`await clipboardService.insertNote(newNote)` 未捕获，DB 失败时按钮静默无反应（对照 `updateNote`/`deleteNote` 都有岛错误反馈）。

**2.3.6 ⚪ 批量换色先改本地后写库、无回滚**
`app/components/note/StickyNote.vue:741-757`：`note.color`/`updated_at` 乐观赋值，失败只计数，UI 颜色与 DB 分叉直到轮询刷新。

### 2.4 剪贴板与常用剪贴（clip / pinned）

**2.4.1 🟠 置顶图片剪贴把整段 base64 写入 SQLite** ✅已验证
`app/src/commands/local/AddToPinnedCommand.ts:20-31`
Ctrl+U 取 `getSelectedItem().content` 直接入库。而列表数据来自 `fetchClipboardData`，图片条目在 `clipboardRepository.ts:528-531` 已把 `imgfile:` 引用解析回**原图 data URL**；`pinnedClipRepository.fetchPinnedClips`（`pinnedClipRepository.ts:36-50`）没有对应的 resolve 步骤，且孤儿文件保护逻辑（`clipboardRepository.ts:227-248`）明确期望常用剪贴持有 `imgfile:` 引用。净效果：置顶一张 10MB 截图会往 `pinned_clip` 写约 13MB base64 行——正是 `imgfile:` 迁移刚从 clipboard 表去掉的膨胀——而 `PinnedClipList.vue:434-439` 每页渲染 40 张。
**建议**：置顶时改存 `imgfile:` 引用（与保护集假设一致），读取时统一 resolve。

**2.4.2 🟡 剪贴板监听回调乱序导致历史倒序插入**
`app/src/clipboard/clipboardListener.ts:65-99`
`onTextUpdate` 处理器是含多次 await 的 async（`queryForegroundApp` → `hasHTML`/`readHtml` → `saveClipboard`）。快速连续复制时后发起的复制可能先落库，历史按 `updated_at DESC` 排序即出现新旧颠倒。建议按类型做 promise 串行队列。

### 2.5 智能剪贴 / AI / Ring

**2.5.1 🟠 用户自定义正则同步执行、无步数预算**
`app/src/smart-clip/ruleEngine.ts:23`、`app/src/smart-clip/template.ts:100-103`
正则在复制流水线里于 UI 线程同步 `new RegExp(pattern, 'gm')` 执行；灾难性回溯模式（如 `(a+)+$`）会挂死整个 webview 且之后每次复制都挂。`parseByRule` 只捕获**编译**错误，`aiGenerate.ts:68-74` 也只验证可编译性。
**建议**：步数预算执行器或挪进 Web Worker。

**2.5.2 🟠 AI 提取器缓存 key 不含指令文本；hash 过弱**
`app/src/smart-clip/template.ts:69-73`
`cacheKey = hash(content):extractor.id`。编辑 AI 提取器的指令后，整个 `ai_result_window`（默认 300s）内命中的还是旧指令产出的缓存。另外 `hashText` 是 32 位 djb2（`app/utils/hash.ts:6-12`），不同内容碰撞会静默返回错误的缓存 AI 结果。
**建议**：key 加入 `hash(expression)`；此处可换更强的 hash（Rust 侧已有 sha256）。

**2.5.3 🟡 `analysis` 的围栏剥离过于脆弱**
`app/src/smart-clip/analysis.ts:42` 只剥最首/最尾的 ``` 围栏；`todoNlp.extractJson`（`app/src/todo/todoNlp.ts:44-55`）对同一问题的处理更健壮——统一实现可省掉每次 Ctrl+B 失败后的整轮重试。

**2.5.4 ⚪ `habitProfile` 读-改-写无串行化**
`app/src/smart-clip/habitProfile.ts:94-109`：`recordPaste` 对 KV JSON blob 做读改写，两次快速粘贴会丢计数。照 `inflightAi` 的模块级 promise 链三行可修。

**2.5.5 ⚪ 高熵 token 默认仍发往第三方 API**
`app/src/smart-clip/analyzer.ts:137-150`：`redactSecrets` 只识别已知前缀/赋值形态；无前缀的 base64/高熵 token 会照发（覆盖率 >60% 时直接短路为 encoded）。加一个「总是脱敏高熵 token」设置项是廉价的信任加分。

### 2.6 设置（setting）

**2.6.1 🟠 缺失 i18n key：`smart.new_scheme`** ✅已验证
`app/components/setting/SettingMain.vue:862, 877` 用 `t('smart.new_scheme')` 作为新建方案默认标题/空标题回退，该 key 在 `zh-cn.toml` 与 `en-us.toml` **均不存在**（已确认 0 命中），`resolve()` 回退输出原始 key——用户直接看到一个名为「smart.new_scheme」的方案。已全量 diff 双语各 1374 个 key（零漂移）并扫了全部静态 `t()` 调用：这是唯一真实缺失。

**2.6.2 🟡 硬编码中文绕过 i18n**
- `app/components/setting/ShortcutRow.vue` 模板：`tip-on="点击禁用" tip-off="点击启用"`，英文用户看到中文 tooltip
- `app/src/commands/shortcuts/InitShortcuts.ts:362-374, 386-389, 404-405`：`updateShortcutKey`/`resetShortcut` 返回中文错误文案（「快捷键不能为空」「与「…」冲突」等），原样渲染进设置 UI
- `app/composables/useColorScheme.ts:26-31`：`COLOR_SCHEME_LABELS` 硬编码中文，被 `SettingMain.vue:82` 导入但从未渲染（死代码，会漂移），建议删除
- `app/components/appusage/AppUsagePage.vue:317`：`v-tip` 拼接全角标点 `（${pct}%）`，不分 locale

**2.6.3 🟡 Webhook 行失效时静默不持久化**
`app/components/setting/SettingMain.vue:1178-1185`：URL 为空/非法的行被同时从持久化与 Rust apply 中过滤。用户粘贴 URL 后中途切走，整行无反馈消失，但界面上看起来像已保存。

**2.6.4 ⚪ 回退版本号过期**
`SettingMain.vue:1589` `FALLBACK_VERSION = '0.5.0'`，而 `tauri.conf.json:4` 已是 0.5.1。非 Tauri 预览构建的更新对比报错版本，建议从 package.json / 构建常量派生。

### 2.7 统计与应用时长（statistics / app_usage）

**2.7.1 🟡 usage tick 虚增「时段操作量」**
`app/src/statistics/statsService.ts:139-152`
`record()` 对**每条**记录无条件给 `active_dawn/day/evening/night` 时段桶 +1，包括每 30 秒一次的 `usage_seconds` tick（:498-515）。面板停留在前台阅读时，每 30s 产生一次幻影「操作」，时段画像（`periodDist`、`night_owl` 等标签）向用户闲挂的时段漂移。建议非操作类指标（`usage_seconds`，可斟酌 `todo_chars`）豁免桶自增。

**2.7.2 🟡 失败的应用图标查询每次渲染都全量重试**
`app/src/statistics/statsService.ts:354-368`：不在 `app_icons` 表的应用每次加载都现场 `app_icon_by_name`，Windows 上每次调用走完整进程快照（`windows.rs:121-155`）；「不在运行」的应用永远返回 null、永远重试。建议内存负缓存 + TTL（Rust 侧 `app_usage/mod.rs:117-120` 已有同款）。

**2.7.3 ⚪ 跨午夜的使用时长整段归入一边**
`src-tauri/src/app_usage/mod.rs:267-283` + `statsService.recordAppUsage`：跨越本地零点的前台分段整段记进 30s 拉取落点那天，深夜会话漂移到次日。在 `accumulate` 处按本地午夜切分即可。

**2.7.4 ⚪ 数字格式化硬编码 locale**
`app/components/statistics/AnimatedNumber.vue`（模板）与 `StatsPage.vue:451` 硬编码 `toLocaleString('zh-CN')`，建议传 `locale.value`。

### 2.9 应用外壳与窗口管理

**2.9.1 🟠 Esc 关闭弹窗后事件继续冒泡，整窗被隐藏** ✅已验证
`app/components/mainpage/ContextMenu.vue:32-34`、`app/components/ui/UiDropdown.vue:143-145`、`app/components/common/DatePicker.vue:426-428` 都在 Esc 时仅 `close()` 不 `stopPropagation()`；事件随后到达冒泡阶段的本地快捷键 `hide_window`（`InitShortcuts.ts:71-79`，经 `ShortcutManager.ts:113-115` 执行）。**右键剪贴条目 → 按 Esc 关菜单 → 整个面板消失**。`DeleteConfirm.vue:84-92`、`GlobalSearch.vue:168-173` 已经用捕获 + `stopImmediatePropagation` 正确处理——ContextMenu / UiDropdown / DatePicker（以及完全没做 Esc 关闭的 SearchHelpPanel）漏掉了同一套处理。

**2.9.2 🟠 Ring 钉选窗口被失焦自动隐藏关闭，违背「常驻」设计**
`app/pages/bubble.vue:18, 394` 创建的 `clipboard-bubble-pin-*` 自述为常驻（「不自我隐藏」），但 `useAutoHide.ts:129-144` 的子窗口豁免清单只有 `island-history` / `clipboard-bubble-island` / `note-pin-*`——主窗口失焦（默认开启自动隐藏，`useAutoHide.ts:17`）时 pin（以及 ring `clipboard-bubble-ring-*`）窗口直接被 `close()`。`bubble.vue:395` 的 `__childOpeningUntil` 集合在 ring webview 里而非主窗口，保护不到。标题栏 ✕ 路径（`app.vue:112-123`）有同样的豁免遗漏。

**2.9.3 🟠 托盘唤出跳过 `window-shown` 管线**
`app/plugins/init.ts:28-39` 托盘点击直接 `show()+setFocus()`；而标准唤出路径（`ToggleWindowCommand.ts:54-57`）会发 `window-shown` 事件，主窗口用它重置失效的 tooltip 单例（`resetTooltipSingleton`，`index.vue:615, 754-757`）并聚焦搜索框。经托盘唤出后可能出现「tooltip 从此不再出现」与搜索框不聚焦。

**2.9.4 🟠 全局搜索跳转在结果超过 50 条时静默失败**
`app/pages/index.vue:649-657`：跳转剪贴板命中项是固定等 420ms 后 `data.value.findIndex(d => d.id === p.clipId)`，但列表分页 `PAGE_SIZE = 50`（`clipboardStore.ts:19`）——命中在第 2 页之后永远选不中，且无回退、无提示。

**2.9.5 🟡 应用图标 / 二维码识别链路存在未处理 rejection**
`index.vue:67`（`fetchAppIcons(...).then(...)` 无 `.catch`）、`index.vue:155-157`（`decodeQrText(...).then(...)` 无 catch）、`index.vue:942-944`（`judgeQrForMenu` await 无 try/catch，经 `:933` 的 `void` 触发）。

**2.9.6 🟡 OnboardingOverlay 注释承诺 Esc 退出但从未实现**
`app/components/onboarding/OnboardingOverlay.vue:2` 写着「Escape/跳过随时退出」，脚本（:66-163）没注册任何 keydown——引导期间按 Esc 实际触发 `hide_window` 把主窗口藏了，引导层还在，唤回后继续悬着。

**2.9.7 🟡 灵动岛历史活动插入的负 id 可重复**
`app/pages/island-history.vue:395, 406`：`id = -Date.now()`，同一毫秒内两个岛事件（复制风暴、×N 合并）产生重复 key，`v-for :key`（:705）与 `expandedIds`/聚合 map 碰撞。改用递减计数器。

**2.9.8 ⚪ 主窗口自动隐藏可能关掉刚打开的托盘菜单**
`useAutoHide.ts:131-141` 的跳过清单漏了 `tray-menu`（`app.vue:119` 的 ✕ 路径明确保留它）。Windows 前台锁场景下托盘菜单不持有焦点（`tray-menu.vue:98-121`），主窗口若可见则失焦后 150ms 隐藏时把菜单一起关了。

**2.9.9 ⚪ 频道日志/杂项**
`src-tauri/src/island/api.rs` 版本漂移见 §2.1.5；`app/src/commands/shortcuts/InitShortcuts.ts` 的中文错误串见 §2.6.2。

---

## 3. 交互体验提升

### 3.1 外壳 / 全局

**3.1.1 🟠 删除确认框默认焦点落在「确认」**
`app/components/common/DeleteConfirm.vue:69`：连按 Enter 直接删除。破坏性确认的安全默认是**取消**。另外 `role="alert"`（:126）应为 `role="alertdialog"` + `aria-modal`（alert 是实时播报语义，不是模态对话框）。

**3.1.2 🟠 全局搜索把 Esc 吃掉却不关面板**
`app/components/common/GlobalSearch.vue:168-173`：为防整窗隐藏刻意吞掉 Esc，但面板此后只能靠角落 ✕ 或点击外部关闭。Ctrl+P 调色板的肌肉记忆是 Esc 关面板——吞掉 Esc 后应该拿它关闭自己。

**3.1.3 🟡 右键菜单首帧闪现在 (0,0)**
`app/components/mainpage/ContextMenu.vue:19, 43-55`：`menuStyle` 初始 `left/top: 0`，渲染后才在 `requestAnimationFrame` 里校正——每次右键都有一帧画在左上角。`DatePicker.vue:430-441` 的「渲染前定位」就是正确写法，照搬即可。

**3.1.4 🟡 懒加载 tab 的滚动位置恢复失效**
`index.vue:191-204` 在 `nextTick + rAF` 恢复 scrollTop，但 statistics / calendar 是 `defineAsyncComponent`（:46-48），内容在恢复之后才挂载，记住的位置被钳回 0。

**3.1.5 🟡 图标按钮对辅助技术不可见**
导航 tab（`TitleBar.vue:232-256`）与最小化/最大化/钉选/关闭（:304-350）只有 `v-tip`（`utils/vTip.ts:80-86` 是纯 div，从不设 `role="tooltip"` 或 aria）；仅配色与岛历史按钮有 `aria-label`。剪贴列表是带自定义选中模型的裸 `<ul tabindex="0">`（`index.vue:1493-1633`），无 `listbox/option/aria-selected` 语义，选中变化从不播报。零内容成本改进：给 v-tip 单例设 `role="tooltip"`、触发元素挂 `aria-describedby`（vTip 已跟踪 `currentEl`）。

**3.1.6 🟡 批量选择纯鼠标路径**
Ctrl/Shift+点击与框选是唯一多选方式（`index.vue:356-367`），没有键盘路径（如 Ctrl+A 选已加载行、Shift+方向键），整套批量工具条（:1466-1483）键盘用户够不到。ContextMenu 菜单项同样没有方向键导航（`ContextMenu.vue:78-87`）。

**3.1.7 🟡 全局搜索可跳进已禁用的 tab**
`GlobalSearch.vue:200` 直接 `setActiveTab(hit.module)`，不查 `disabledTabs`（`useTabs.ts:150-162`）——被用户停用的模块经搜索变得可达并渲染。

**3.1.8 ⚪ 类型/应用筛选面板缺少 Esc 收起**
`index.vue:510-567`：只能靠外部 pointerdown 关闭，且切 tab 后仍存活。接入与 DeleteConfirm/GlobalSearch 相同的捕获式 Esc 模式（同时完成 §2.9.1 的修复）可统一全应用弹层语义。

**3.1.9 ⚪ 右键菜单「复制二维码内容」无判定中反馈**
`index.vue:932-934`：慢速识别时菜单静置数秒，条目可能中途才出现；一条「识别中…」的禁用行能让异步追加可感知。

### 3.2 待办

**3.2.1 🟠 无效拖拽落点静默失败但高亮暗示可放**
`app/components/todo/TodoList.vue:994`：拖到有子级的任务上、或拖到子级卡片上，静默 return；而 `Todoitem.vue:674-679` 对每个悬停卡片一律高亮为可放置（`dropPos='child'` 无条件）。金色「放这里」指示经常什么也不做。

**3.2.2 🟡 搜索激活时 3s 轮询整列表重渲染**
`TodoList.vue:1136-1145`：搜索期间每个轮询 tick 重新查询全匹配集并无签名检查地 `replace()`（`useInfiniteList.ts:140-143` 绕过 `signatureOf`），整个结果列表每 3s 重渲染一次。

**3.2.3 🟡 忙等循环无上限**
`TodoList.vue:1164`（`while (isFetching()) await sleep(50)`）与 `StickyNote.vue:436`：fetch 一旦悬挂则无限自旋。

**3.2.4 ⚪ 3s 轮询每 tick 两次 DB 查询**
`useTodoCore.ts:76-92` + `TodoList.vue:1132-1152`（全量 `fetchTodos` + `refreshLoaded`）。SQLite 无碍，但剪贴板已用事件驱动 `bus.emit('clipboard:changed')`（`clipboardListener.ts:95`）解决了本窗口内写入的刷新——todo/notes 可复用同模式，顺带把轮询间隔放宽到仅服务跨窗口同步。

### 3.3 便签

**3.3.1 🟠 桌面钉选便签不能勾选清单**
`app/pages/note-pin/[id].vue:296-304` 只读渲染 checkbox 字形（无点击处理），主窗口卡片可交互（`StickyNoteItem.vue:176-189`）。`toggleChecklistLine` 是纯函数，补齐是最低成本的体验对齐。

**3.3.2 🟡 AI 整理追加无撤销**
`StickyNote.vue:780-808`：糟糕的总结/清单直接写进便签正文，恢复靠手改。预保存内容可以留作一次性撤销（岛提示位已有）。

**3.3.3 🟡 批量 Backspace 全选删除无确认**
`StickyNote.vue:933-943`：软删除可救，但批量模式下一个误触 Backspace 把整个选中集送进回收站，只有一条计数 toast。

**3.3.4 ⚪ 桌面钉选编辑冲突无提示**
`[id].vue:123-127` 编辑期间暂停轮询；期间主窗口的修改在提交时（:173-187）被覆盖且无警告。一条「便签已在别处修改」toast 即可。

### 3.4 剪贴板 / 常用剪贴

**3.4.1 🟠 常用剪贴卡片没有可见的复制/粘贴操作**
`PinnedClipList.vue:477-489` 只有编辑/钉选/删除；真正的粘贴依赖隐藏的 Ctrl+1..0（角落徽标有提示，:395）。点击即复制（带岛反馈，`copyNoteContent` 模式现成）能让模块自解释。

**3.4.2 ⚪ 序列粘贴状态离开剪贴板 tab 就不可见**
`index.vue:1485-1491` 的 `sequenceActive` 只在剪贴板 tab 内渲染；别处打字时 Enter 突然变成「粘贴队列下一条」，无从知晓。在剪贴板导航图标上加一个金点（`favBadgeClass` 同款，:80）即可。

---

## 4. 增强建议

### 4.1 灵动岛

**文本读取仍每 80ms 全量打开剪贴板 → 补上序列号门控（本清单健康收益最大的一项）**
`app/composables/useCopyIsland.ts:197-219`：`startIslandPoller` 里**图片路径已做序列号门控**（`:200-207` 用 `clipboard_image_probe` 的 GetClipboardSequenceNumber，无变化即 return，做得很好），但**文本路径 `:208` 仍无条件每 80ms 调 `readText()`**，与插件自身 200ms watcher 抢全局剪贴板互斥锁——Rust 侧为此加了 25ms×8 重试（`thumb.rs:93-99`）才抢得回来。给文本读取补上同样的门控：probe 返回的 seq 未变时跳过 `readText()` → 同样延迟，稳态剪贴板打开次数约降 20 倍。

其余：
- **延迟窗口静默丢事件**（🟡）：`useCopyIsland.ts:527-541` 在 `island_delay_ms > 0` 时中间事件整体丢弃（last-wins），**包括其历史行与统计**（`clip_cut` 只给幸存载荷计数）。展示层去重是有意设计，但数据丢失大概率不是——建议入队时即记历史。
- **未就绪 pin 窗口滞留**（⚪）：`bubble.vue:396-401` 的 `bubble:pin:ready` 监听由 ready/error/5s 超时清理，但创建后始终未 ready 且用户已关 ring 时，pin 窗口以隐形窗口形式永久滞留。加 `tauri://destroyed` 监听或创建超时兜底关闭。
- **Linux 全局 Ctrl+V 注入失败无提示**（⚪）：`src-tauri/src/commands/paste.rs:74-91` 在 Linux 注册真实全局快捷键并回注入按键，应用挂起会拖累系统级粘贴；注册失败只有 `eprintln!`，对照 macOS 权限缺失路径（`islandApi.ts:90-100`）补一个等价的失败事件。

### 4.2 设置 / 数据 / 窗口

- **主窗口没有最小尺寸**（🟡）：`src-tauri/tauri.conf.json:11-22` 的窗口配置无 `minWidth`/`minHeight`，面板可被拖到几个像素宽，剪贴行与标题栏完全破碎。加 `minWidth: 320, minHeight: 240` 一行配置即可。

- **「清空数据」不覆盖岛历史与习惯分词**（🟠）：`backupRepository.ts:56-70` 清 clipboard/note/todo/stats，但 `island_history`（最多 500 条复制文本，与剪贴板内容 1:1 镜像）、`clip_habits.segment_text`（200 字摘录）、`clip_ai_cache` 原样保留。对一个 privacy-first、清空还带撤销故事的应用，这些侧表应一并纳入。
- **Webhook 行静默丢失**：见 §2.6.3。
- **备份完整性 manifest**（想法）：备份是自包含 JSON + 内联图片；在 bundle 里加入 tables 的 sha256（或每表行数），恢复时先校验再执行破坏性导入（呼应 §2.1.2），而不是中途失败。

### 4.3 统计 / 后端

- **应用时长跨午夜分段归属**：见 §2.7.3。
- **迁移 v18 重建依赖前端自愈**（⚪）：`src-tauri/src/db/migrations.rs:399-436` 的 clipboard 表重建（CREATE/copy/DROP/RENAME）非原子，中断后靠前端 `relaxClipboardTypeCheck` 自愈（`migrator.ts:57-100`）——但只覆盖这一张表且要等 webview 下次运行。建议在迁移内注释说明该依赖。
- **农历表覆盖年不齐**（⚪）：`festival-eggs/core.ts:38-59` 七夕/中秋覆盖 2020-2030，春节/元宵/端午只有 2026-2030。注释说「每年初按万年历续表」但忘了续表没有任何运行时提示；建议 dev 模式在当年无覆盖时输出一条 `console.info`。
- **`fun-eggs/board`、`fun-eggs/lang` 是零引用的空目录**（⚪）：与 `festival-eggs/core.ts:11-18` 的「加彩蛋」文档对照易误导，建议删除。

---

## 5. 新功能设想

全部基于现有能力，落地成本低：

1. **序列粘贴的灵动岛进度胶囊**：岛已能渲染任意文本（`index.vue:1045-1047`），序列状态是全局的（`clipboardStore.ts`）——每步粘贴发「3/5」更新，把队列变成可见、可预期的进度条。
2. **常用剪贴板纳入全局搜索**：搜索面板已并行查三张表（`GlobalSearch.vue:91-100`），PinnedClipList 及其粘贴管线现成——命中行带上 Ctrl+N 粘贴提示（`InitShortcuts.ts:207-215`）即可。
3. **循环任务预览下 2-3 次触发日期**：`RecurrencePicker.vue` 调用纯函数 `nextDueDate` 即可；顺带让 interval/weekday 语义（含 §2.2.1 的 bug）在保存前可见。
4. **过期待办一键推期**：逾期待办已自动携带进「今天」，卡片上加「推到今天 18:00 / 明天 09:00」一键动作（`DueTimeSelect` 选项 + `updateTodo` 全部现成）。
5. **待办模板支持相对截止日**：模板目前刻意跳过 dueDate（`TodoList.vue:1078`）；允许「应用时 +3 天」类相对偏移，复用 `DueTimeSelect.vue:66-72` 的时长换算。
6. **画像驱动的自动方案推荐**：`habitProfile.topExtractors` 已在追踪用户真正粘贴的提取器产出——在方案编辑器里提示「你的粘贴多来自 url_extract + smart_tokenize，要创建这个方案吗？」，把既有遥测变成功能。
7. **Ring 段落一键「存为常用剪贴」**：`RingBubbleCard.vue:24-26` 现有派发 todo/note，`insertPinnedClip` 直接复用即可加上 pinned 派发。
8. **岛作为待办提醒的统一展示面**：todo 提醒目前走 OS 通知（`notify.rs`）；一切桥接已就绪（`island:show` → SSE + webhook + history），智能提醒走岛（用现有的 sticky kind）可得到尊重岛时长/延迟设置的统一可关闭通知流。
9. **托盘菜单快捷操作**：托盘菜单是常驻热窗口（`plugins/init.ts:96-112`）——加「灵动岛历史」（`toggleIslandHistoryWindow` 已存在）与「弹出位置」循环切换，零新增基础设施。
10. **Onboarding 键盘化**：兑现注释承诺的 Esc 退出 + ←/→ 步进（复用 `DeleteConfirm.vue:84-104` 的捕获按键模式），焦点落在「下一步」，引导全程可键盘走完。
11. **筛选 chips 行**：`activeFilterLabels`（`index.vue:572-578`）把筛选渲染成一坨可整体移除的文本；改为逐标签 chips（状态本就按字段分离）让「收藏 + 类型 + 应用」混合筛选可单独撤销。

---

## 6. 审查确认的亮点

以下实现质量高，后续改动时**不要顺手重构**：

- **Markdown 渲染安全**：`app/src/note/markdown.ts` + `NoteInline.vue` 为 token 驱动，全模块 grep 确认无 `v-html`，无 XSS 面。
- **提醒服务防重发设计完整**：`reminderService.ts` 的 `firedLog` 持久化、`inFlight` 去重、32 位 `setTimeout` 溢出分片（:182-191）、30s 节流定时器清扫均正确。
- **共享原语质量高**：`useInfiniteList`、`useNow`（引用计数单例消灭了 N-timer 问题）可直接复用。
- **提醒规则单源**：`computeReminders` / `describeSmartPlan` 共用 `reminderPolicy.ts:170-177` 一处实现，正是应有的模式。
- **快捷键系统扎实**：冲突检测含修饰键归一化、注册失败回滚、陈旧 key 清理（`InitShortcuts.ts:328-334`）。
- **统计页工程细节**：范围切换防抖 + 竞态守卫（`StatsPage.vue:154-286`）、聚合用 `shallowRef`、>92 天降采样、热图占位格、来源应用 → 剪贴板过滤交叉跳转。
- **SQL 全参数化**：前端 TS 层与 Rust 层均未发现字符串拼接 SQL（唯一例外见 §2.1.2 的标识符拼接）。
- **i18n 基础设施健康**：双语各 1374 key 零漂移；动态 key（`island.ai_err_*`、`island.ai_skipped_*`）逐一核实存在；`settingTip` 的 key 相等回退用法正确。
- **彩蛋克制**：`s1d3` 彩蛋精确匹配才触发（`bubble.vue:162-164`），节日开关收敛在设置里（`settingGroups.ts:129`），有 `DISABLED_FESTIVALS` 一键停用（`core.ts:73`）。

---

*本报告由三路并行深读（外壳交互 / 功能模块 / 支撑系统与 Rust 后端）生成，关键结论经人工复核。条目定位以 `dev` 分支当前代码为准，修复后行号会漂移，建议按「模块 + 符号名」检索。*
