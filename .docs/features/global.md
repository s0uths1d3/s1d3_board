# 贯穿能力（global）

> 跨所有模块的横向能力：快捷键体系、窗口行为、多窗口协作、全局搜索、i18n、隐私、数据安全与流式加载。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 全局快捷键系统 | 全部可录制/启停/重置（单个与分组），`global` 系统级 + `local` 窗口级双作用域，冲突检测与失败回滚 | 设置 → 快捷键设置 |
| 唤出/隐藏主窗口 | 任意时刻唤出（系统级），失焦或按 Esc 隐藏 | `Ctrl+I` / `Esc` |
| 失焦自动隐藏 | 主窗口失焦 150ms 后经豁免链检查自动隐藏（默认开，可关；置顶时豁免） | 自动 / 设置 → 通用 |
| 窗口置顶 | 主窗口置顶切换（置顶时禁用失焦自动隐藏） | `Ctrl+T` |
| Tab 切换 | 上一个/下一个标签页（改键必须含修饰键，防误触） | `Ctrl+←` / `Ctrl+→` |
| 方向键导航 | 选中上一项/下一项，几何最近邻适配网格/瀑布流 | `↑` / `↓` |
| 粘贴选中项 | 粘贴剪贴板列表当前选中项（支持序列粘贴模式，进度弹岛） | `Enter` |
| 删除选中项 | 剪贴板 Tab 弹独立确认窗口；待办 Tab 软删进回收站 | `Delete` |
| 收藏选中项 | 收藏/取消收藏当前剪贴板条目 | `Ctrl+L` |
| 添加为常用剪贴 | 当前选中项加入常用剪贴列表 | `Ctrl+U` |
| 快捷数字粘贴 | 粘贴常用剪贴第 N 项 / 剪贴板第 N 项（第 10 项对应 0），系统级全局生效 | `Ctrl+1`~`Ctrl+0` / `Ctrl+Shift+1`~`Ctrl+Shift+0` |
| 智能剪贴气泡 | 唤出/关闭环形气泡窗（仅主窗口聚焦时响应，不全局拦截加粗键） | `Ctrl+B` |
| 新建便签 / 保存便签 | 新建仅便签页生效；保存按上下文分流（便签页保存 / 待办页进入编辑态） | `Ctrl+N` / `Ctrl+Enter` |
| 页内搜索聚焦 | 聚焦当前页搜索框（各 Tab 均响应） | `Ctrl+F` |
| 全局搜索 | `Ctrl+P` 命令面板并行搜剪贴板/待办/便签（各前 20 条）+ 设置项，键盘选择、跳转定位 | `Ctrl+P` |
| 切换配色 | 跟随系统 → 琥珀 → 浅色 → 深色循环（默认未绑定，可自行录制） | —（可录制） |
| 桌面钉选 | 便签钉为独立置顶桌签窗，常驻桌面不随主窗口收起 | 便签卡工具栏/拖出钉桌 |
| 透明无边框窗口 | 主窗口与子窗口（岛/气泡/tooltip/查看器/桌签/确认框）均为无边框透明自绘 | 自动 |
| 多窗口协作 | 主窗口与岛/气泡/tooltip/查看器/删除确认经 Tauri 事件通信；配色与语言切换广播同步 | 自动 |
| 中英双语 | 跟随系统/中文/English，切换跨窗口同步；显示层翻译 | 设置 → 通用 → 外观 |
| 隐私模式 | 暂停剪贴板记录（不落库/不弹岛/不进智能切分）+ 敏感内容防护 | 设置 → 剪贴板 → 隐私 |
| 数据管理 | 导出/导入 JSON、每日自动备份（保留 7 份）、清空撤回（3 分钟） | 设置 → 通用 → 数据管理 |
| 流式加载 | 各列表分页按需加载（LIMIT/OFFSET），统计页区块随滚动渐进渲染 | 自动 |
| 托盘常驻与单实例 | 关闭按钮隐藏到托盘；重复启动聚焦已运行窗口不开新进程 | 自动 |

## 关键行为

### 全局 + 本地快捷键体系
命令模式：每个快捷键绑定一个 `Command` 对象，双作用域分发：

- `scope: 'global'` 经 Tauri global-shortcut 插件注册（系统级，如 Ctrl+I、Ctrl+1~0、Ctrl+Shift+1~0）。
- `scope: 'local'` 由主窗口 keydown 监听分发（不拦截其他应用按键，如 Ctrl+B 仅主窗口聚焦时响应）。
- 快捷键命令通过进程内事件总线（`core/events.ts` 类型化 bus）派发业务事件，页面监听处理——命令层不知道页面细节。
- `Ctrl+Enter` 为上下文命令：便签页派发 `save-note`、待办页派发 `todo:edit-request`，其余页忽略。
- 切换 Tab（`Ctrl+←`/`Ctrl+→`）、保存/新建便签改键必须含修饰键（脏数据启动时自动修复写回默认）。

见 `app/src/commands/shortcuts/InitShortcuts.ts:50`、`app/src/commands/local/ContextEditCommand.ts:11`、`app/src/core/events.ts`。

### 快捷键健壮性
- 启动时先清理残留：HMR 防重复绑定 + 历史残留全局热键统一注销（清单 = 默认 global ∪ 当前配置 global ∪ 数据库记录过的全部键），避免 Windows 上残留热键剥离按键导致组合键「完全无响应」。
- 注册失败的项落入 `failedShortcutIds` 设置页标红并弹岛通知（失败集随每次重注册整体重算）。
- 改键冲突返回「与「xxx」冲突」；被系统占用时回滚原键不持久化死键。

见 `app/src/commands/shortcuts/InitShortcuts.ts:264`（reloadShortcuts 239、findShortcutConflict 352、updateShortcutKey 360）。

### 失焦自动隐藏豁免链
失焦 150ms 后依次检查，全部通过才隐藏：

- 开关关闭 / 主窗口置顶（置顶语义即「永不退到后台」）。
- 子窗口创建豁免期（`__childOpeningUntil`）/ 拖出钉桌进行中（`__noteDragging`）/ 环形气泡活跃（`__ringActive`，防止环内存状态残留）。
- tooltip 交互中：tooltip 聚焦保持显示；焦点在外则关闭 tooltip（close 而非 hide——父窗口隐藏会使独立子窗口事件通道失效，close 后单例失效由 hover 重建）继续判定。
- 任意子窗口聚焦 / 图片查看器可见（Windows 下查看器 focused 可能漏判，按「存在可见 image-viewer 窗口」兜底）。

隐藏前动作：关闭可见子窗口（island-history、灵动岛、桌签 `note-pin-*` 豁免不关）、保存便签编辑（`save-note` 事件防挂起丢内容）、记录窗口位置供「上次位置」弹出模式。见 `app/composables/useAutoHide.ts:50`（setupAutoHideOnBlur 159）。

### 桌面钉选窗口（useDesktopPin）
- 桌签窗隐藏创建（visible:false）→ 页面 ready 广播 → 主窗口 show + 焦点立即归还（防拖动 pointerup 丢失）。
- 落点 = 光标物理坐标按显示器 scaleFactor 换算为逻辑像素（`cursorLogical`）+ 级联偏移（每多一张 +28px 不重叠）。
- 跟随态迷你横条 248×56 中心对齐光标实时跟随（物理像素直传 setPosition，无单位换算问题）。
- 窗口参数：transparent + 无装饰 + alwaysOnTop + skipTaskbar + focus:false + `backgroundColor:[0,0,0,0]`。

见 `app/composables/useDesktopPin.ts:20`（openDesktopPin 83、followDesktopPin 139、cursorLogical 26）。

### 透明窗口
子窗口页面挂载时注入一次性样式：body 置透明并隐藏全局背景光晕伪元素，悬浮观感由页面根容器自绘圆角承载（同一 webview 幂等注入，页面卸载无需移除）；配合窗口创建参数 `transparent: true` + `backgroundColor:[0,0,0,0]` + 部分页面 useHead 内联透明 CSS，消除加载期实底/白角帧。见 `app/composables/useTransparentWindow.ts:11`。

### 全局搜索（Ctrl+P）
- `GlobalSearchCommand` 派发 `global-search:toggle` 打开面板（Teleport 到 body）。
- 输入 250ms 防抖后 `Promise.all` 并行查三模块（fetchClipboardData/fetchTodos/fetchNotes，各取前 20 条，统一走高级词法与大小写开关）+ 设置项索引本地过滤（`settingGroups.ts` 单一来源，按当前语言文案或 label 键包含匹配）；请求序号作废晚到响应防竞态。
- 键盘处理沿用 DeleteConfirm 的 capture 模式：面板打开期间在 capture 阶段拦截方向键/回车/Esc 抢在 ShortcutManager（bubble 阶段）之前；Esc 仅吞掉不关闭（关闭入口是 ✕，防触发「隐藏主窗口」把整个窗口藏掉）；IME 组合按键放行输入法。
- 跳转契约 `global-search:jump`（`{module, query, clipId?}`）：clip 由 index.vue 写入高亮词并按条目 id 选中定位；todo 强制回列表视图写入搜索词（日历/回收站不展示搜索结果）；note 切「全部」范围；setting 进入跨分组搜索态（右侧即命中项列表）。

见 `app/components/common/GlobalSearch.vue:91`（jump 189、onKey 152）、`app/src/commands/local/GlobalSearchCommand.ts`。

### 共享分发管道（跨模块落地）
- 所有「剪贴板内容 → 待办/便签」动作收敛到 `dispatchClip.ts`：`clipToTodos` 多行清单逐条建待办（`- [ ]`/`- [x]`/`-`/`*`/`•` 前缀剥离、勾选态映射完成态、来源以 `{title:'clipboard', url:原文}` 记入 links）、`clipToNote` 原文落便签（默认配色第一项）。
- 触发入口：列表右键菜单、便签卡菜单、待办行内按钮、岛胶囊快捷动作、环盘分段、拖拽到 Tab（自定义 MIME `application/x-s1de-clip` 识别来源）。
- 岛/环盘为独立窗口不直接写库，统一 emit `island:dispatch` 由主窗口落库并以灵动岛反馈结果；待办完成时按来源标记反哺剪贴板使用计数。

见 `.docs/module-interactions.md`、`app/src/commands/local/dispatchClip.ts`。

### 多窗口 tooltip / 查看器 / 删除确认
- 悬停提示（tooltip，保留原始缩进的完整内容）、图片查看器（缩放/旋转/多图切换）、删除确认均为独立透明子窗口，经 Tauri 事件通信（显示/隐藏/悬停/激活）。
- tooltip 每次 show 置顶、close 后单例失效由 hover 重建（避免向失效窗口发事件导致 tooltip 永远不再出现）。
- 配色/语言切换广播到所有窗口同步刷新；主窗口显式收起到托盘与失焦隐藏均按窗口 label 豁免常驻窗口（岛/岛历史/桌签）。

见 `app/composables/useAutoHide.ts:124`、`README.zh-CN.md` §窗口与托盘。

### i18n 结构
- 语言包为独立 TOML 文件（`assets/lang/zh-cn.toml` / `en-us.toml`），启动时同步解析一次（自研轻量 TOML 解析器，无第三方 i18n 依赖）。
- 功能模块自有文案（如节日彩蛋 `[festival]` 表）经 `withModuleMessages` 启动时浅并入消息树——改/增模块文案只动模块目录，业务包零改动。
- 翻译函数 `t(path, params?)` 每次调用读响应式 locale；切换语言后 `location.reload` 重挂读取新语言包（跨窗口经 `locale:changed` 广播跟随）。
- 画像标签名经 `[tag_names]` 表（`tName`：zh-cn 映射中文、en-us 原样返回英文标签名）。

见 `app/i18n/messages.ts:21`、`app/composables/useI18n.ts:110`。

### 隐私模式与敏感防护
- 隐私模式（KV `privacy_pause`，默认关）开启后剪贴板监听管道对文本/图片更新一律不处理——应用对剪贴板「失明」（不落库、不弹岛、不进智能切分），用于输入敏感内容场景。
- 托盘菜单与设置页共用状态源；托盘每次展示前强制重读（绕过 once 缓存，规避设置页在另一窗口切换后勾选态陈旧）。
- 敏感内容防护（`sensitive_filter`，默认开）命中敏感形态（银行卡号/验证码/密码）的文本不落库。
- 两者均为监听层落库前拦截（不写库、不弹岛）。

见 `app/composables/usePrivacySettings.ts:9`、`README.zh-CN.md` §架构说明。

### 自动备份与数据安全
- 每日首启自动快照（KV `auto_backup_last_date` 同日幂等，失败仅记日志次日再试），与手动导出同一数据包（6 表、图片内联自包含），Rust 侧原子写 + 文件名白名单校验，保留 7 份。
- 自动/手动导入均为替换式恢复（版本守卫）。
- 清空数据库 3 分钟撤回（`clear_backup_*` 合并恢复），启动时清理上次会话遗留备份。
- 数据库侧另有 WAL + busy_timeout + execWithRetry 三件套与启动 quick_check 自检兜底。

见 `app/src/backup/autoBackup.ts:31`、`app/src/core/db/repositories/backupRepository.ts:72`、`.docs/database.md` §7/§8。

### 流式加载（useInfiniteList）
- 统一剪贴板/常用剪贴/便签/待办的分页行为：首屏一页（默认 50，便签 40），底部 sentinel 进入视口（提前 200px）自动加载下一页（offset 按已加载条数，顶部插入导致的重叠按 id 去重合并）。
- 搜索/筛选变化 reload 重置；轮询后 `refreshLoaded` 只刷新已加载范围（签名一致跳过整表替换防无谓重渲染）；loadMore/reload/refreshLoaded 互斥防并发错乱。
- 统计页另有区块级流式（LazySection 骨架占位 + IntersectionObserver 提前 160px 渐进渲染）。
- 各标签页独立保存滚动位置，切换标签自动聚焦搜索框。

见 `app/composables/useInfiniteList.ts:14`、`app/components/statistics/LazySection.vue:3`。

### 模块化与事件解耦
- 快捷键/统计/待办提醒等子系统以 `AppModule` 插件注册进 `ModuleRegistry`：拓扑排序启动（settings → smart-clip → clipboard → island → statistics / todo-reminder / shortcuts）、反序收尾、单模块 init/start/stop 失败被捕获隔离。
- 模块间禁止直接 import 对方内部实现，跨模块通知一律走类型化事件总线；Rust 侧同构为域模块（core/db/clipboard/island/ai/commands），`lib.rs` 装配根注入 traits 实现。
- 主窗口关闭仅隐藏到托盘（模块保持运行：监听/提醒/快捷键不失效），显式退出才 shutdown。

见 `.docs/architecture.md` §2/§4/§7、`app/src/modules/index.ts`。

## 边界与限制

- 局部快捷键仅主窗口聚焦时响应；全局快捷键注册失败多为被系统/其他程序占用，设置页标红并弹岛通知。
- `Ctrl+P` 面板 Esc 不关闭（仅吞掉防隐藏主窗口）；面板为临时弹层，高级词法/大小写开关内存态不持久化；高级词法不适用于设置项过滤（按文案包含匹配）。
- 隐私模式只影响剪贴板记录；待办/便签等用户显式操作不受影响；忽略应用黑名单在监听层落库前拦截。
- 自动备份不含配置类数据（settings KV/快捷键绑定，可能含 API key）与可再生数据（岛历史/图标缓存）。
- 失焦自动隐藏默认开；置顶状态下永不自动隐藏；岛历史窗口/桌签不随主窗口收起。
- 流式列表滚到底才有分页语义；回收站视图与便签「全部」搜索范围不分页（一次性加载）。
- 生产环境打包后禁用右键菜单与 F5/F12 调试快捷键，开发环境保留完整调试能力。
- 单实例运行：重复启动聚焦已有窗口。

## 深读文档

- [模块化架构](../architecture.md)（模块注册表、事件总线、启动顺序与故障隔离）
- [模块交互](../module-interactions.md)（8 项跨模块联动与共享分发管道、全局搜索跳转契约）
- [数据库设计](../database.md)（WAL/busy_timeout/execWithRetry 可靠性三件套与清空撤回）
- [灵动岛 API](../island-api.md)（回环 HTTP/SSE 与 Webhook 开放能力）
- [彩蛋说明](../easter-eggs.md)（s1d3 隐藏动画与节日限时主题）
