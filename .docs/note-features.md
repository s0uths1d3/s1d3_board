# 便签功能增强实现文档

> 本文档记录本轮便签（Notes）功能增强的实现内容、技术方案与操作指南，规划依据为主流便签工具（Microsoft Sticky Notes / Google Keep / StickyHover / Stickies 等）的共性功能调研。
> 实现过程中逐项更新状态标记（⏳ 未开始 / 🚧 进行中 / ✅ 已完成 / ❌ 未实现），全部完成后附验证结论。

## 功能总览

| # | 功能 | 状态 | 关键词 |
|---|------|------|--------|
| 1 | 置顶便签 | ✅ 已完成 | `pinned` 列、置顶区优先展示 |
| 2 | 便签标签 | ✅ 已完成 | `tags` JSON 列、卡片徽章、编辑态行内输入 |
| 3 | 清单模式 | ✅ 已完成 | `- [ ]` 复选框语法解析、卡片可点勾选 |
| 4 | 便签提醒 | ❌ 已移除 | 产品决策：删除 UI 与调度；`remind_at` 列保留 schema（无害） |
| 5 | 便签回收站 | ✅ 已完成 | `deleted_at` 软删列、恢复/彻底删除 |
| 6 | 排序选项 | ✅ 已完成 | 更新时间/创建时间/颜色（置顶区始终最前） |
| 7 | 批量操作 | ✅ 已完成 | 多选模式、批量改色/删除 |
| 8 | 轻量格式渲染 | ✅ 已完成 | Markdown 子集 token 渲染（粗体/斜体/删除线/代码/清单/标题） |
| 9 | 字数统计 | ✅ 已完成 | 卡片角落字数 |
| 10 | AI 便签整理 | ✅ 已完成 | 摘要/提取待办（依赖设置页 AI Key，结果追加） |
| 11 | 桌面便签窗口 | ✅ 已完成 | 便签钉到桌面置顶小窗常驻（`note-pin/:id`） |
| 12 | 拖动重排 | ✅ 已完成 | `sort_order` 列（v21）、按住卡片拖动让位、手动排序持久化 |

---

## 〇、现状与数据模型

### 现状（增强前）

- `note` 表仅 5 列：`id / content / color / created_at / updated_at`（Rust v1 建表 + migrator.ts 兜底）
- UI：Grid 卡片流式加载（StickyNote.vue）+ 单卡悬浮工具栏（StickyNoteItem.vue）——配色选择、管理配色、删除、双击进 textarea 编辑、Ctrl+E 保存、输入自动保存
- 搜索：SQL LIKE 内存过滤，Enter 跳转首个匹配，可切换搜索范围（当前加载/全部）
- 配色：`note_colors` 存 settings KV（默认六色 + 自定义增删改 + 独立配色管理窗口）
- 快捷键：Ctrl+N 新建、Ctrl+E 保存

### note 表新增列（双侧同 DDL：migrations.rs v20/v21 + migrator.ts 兜底）

| 列 | 类型 | 说明 |
|---|---|---|
| `pinned` | INTEGER NOT NULL DEFAULT 0 | 置顶标记（功能 1），1 = 置顶 |
| `tags` | TEXT | 标签 JSON 字符串数组（功能 2），NULL/'' = 无 |
| `deleted_at` | TEXT | 软删时间戳（毫秒文本，功能 5），NULL = 未删除 |
| `remind_at` | TEXT | 提醒时刻 ISO 文本（原功能 4 已移除，列保留 schema 兼容历史数据，恒空串） |
| `sort_order` | INTEGER NOT NULL DEFAULT 0 | 手动排序序号（功能 12），拖动重排落位持久化 |

清单模式（功能 3）与轻量格式（功能 8）**不加列**：`content` 保持纯文本，用 Markdown 惯用语法表达，渲染层解析。

---

## 一、置顶便签

### 功能介绍

常用便签可**置顶**：列表顶部独立「置顶」区优先展示（对齐 Google Keep），置顶便签不受排序影响；卡片悬浮工具栏提供置顶/取消置顶按钮。

### 技术方案

- `pinned` 列；仓储 `updateNote` 支持写入；`fetchNotes` 不变（排序在展示层做）
- StickyNote.vue：`pinnedNotes`（置顶区）+ `gridNotes`（置顶区 + 其余按排序）计算属性，置顶区分隔行带图钉图标
- 卡片工具栏新增置顶按钮（图钉，金色实心 = 已置顶）；灵动岛反馈置顶/取消

---

## 二、便签标签

### 功能介绍

便签可打**标签**（自由命名关键字，最多 8 个）：卡片以金色弱化徽章展示，编辑态提供行内标签输入（对齐待办标签交互：不设全局筛选栏，标签仅展示不筛选）。

### 技术方案

- `tags` JSON 列（与待办 tags 同模式：DB 存 JSON 文本，仓储 parseNoteTags/stringifyNoteTags 转换，应用层 `string[]`）
- 编辑态标签输入（空格/逗号分隔，复用 `parseTagsText` 清洗，失焦/回车提交）
- 卡片金色弱化徽章（只读态展示）

---

## 三、清单模式

### 功能介绍

便签内容支持 Markdown **复选框语法**（`- [ ]` 待办 / `- [x]` 已完成）：只读卡片把清单行渲染为可点击的复选框（点选切换 `[ ]`/`[x]` 并自动保存），典型场景：购物清单、待办步骤。不强制模式——普通文本与清单可混排。

### 技术方案

- 只读渲染：逐行解析，`- [ ]`/`- [x]`/`* [ ]` 前缀行渲染为 checkbox 行（勾选状态实时反映 content 文本）
- 点选：就地改写 content 中该行的 `[ ]`⇄`[x]`，走既有 updateNote 自动保存链路
- 编辑态仍是 textarea（纯文本），用户手写语法；卡片渲染所见即所得

---

## 四、便签提醒（已移除）

> **状态：❌ 已移除（产品决策）**。曾实现：卡片工具栏时钟按钮设提醒时刻 + reminderService note 通道到点通知（系统通知 + 灵动岛 + 提示音，firedLog 防重启重复、过期补发、30s 兜底扫描）。
>
> 移除范围：StickyNoteItem 工具栏提醒下拉与底部时刻展示、StickyNote `setRemind`、reminderService `syncNotes`/`syncNotesInternal`/`handleNoteFire`/`sendNoteRemind`/`noteTimers`、i18n `note.remind*` 四键。
> 保留：`remind_at` 列与仓储读写（v20 迁移已发布，删列代价大且恒空串无害）；待办提醒通道不受影响。

---

## 五、便签回收站

### 功能介绍

删除便签改为**软删除**（进回收站，不弹确认框——对齐待办删除交互）；筛选栏新增「回收站」视图：显示删除时间，支持**恢复**与**彻底删除**（彻底删除前确认）。

### 技术方案

- `deleted_at` 软删列；`deleteNote` 改软删，`purgeNote`/`restoreNote`/`fetchDeletedNotes` 新增（对齐待办仓储命名）
- StickyNote.vue 复用删除交互：主列表删除直接软删（island 提示），回收站视图切换渲染恢复/彻底删除按钮，DeleteConfirm 确认彻底删除
- 不做自动清理（保留至手动彻底删除）

---

## 六、排序选项

### 功能介绍

搜索栏旁排序下拉：**最近更新 / 创建时间 / 颜色 / 手动排序（拖动）**（默认最近更新倒序）；置顶便签永远在置顶区，不参与排序。手动排序选项由拖动重排（功能 12）落位时自动切换，无需手动选择。

### 技术方案

- 展示层排序 `compareNotes`：`updated_at` 倒序（默认）/ `created_at` 倒序 / 按 `color`（当前配色顺序 noteColors 索引，自定义配色排后）/ `sort_order` 升序（拖动落位顺序，`updated_at` 倒序兜底）
- 置顶便签永远在置顶区（与排序解耦）

---

## 七、批量操作

### 功能介绍

「批量管理」进入多选模式：卡片复选框点选/全选，工具栏提供**批量删除（进回收站）、批量改色**（选色即应用）；与剪贴板/待办批量工具栏交互一致。

### 技术方案

- `batchMode/batchSelectedIds` 状态；批量删除循环软删；批量改色循环 `updateNote({ color })`
- 工具栏常驻列表上方（z-40），显示已选数量 + 改色色板 + 删除 + 全选/退出

---

## 八、轻量格式渲染

### 功能介绍

只读卡片对 `content` 做 **Markdown 子集**渲染：`**粗体**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``、`- [ ]` 清单（功能 3）、普通 `-` 列表、`# 标题`（最多三级）。存储保持纯文本（编辑态所见即所写），仅展示增强——对齐 Sticky Notes / Keep 的轻格式定位，不上完整 Markdown 引擎。

### 技术方案

- 纯函数模块 `app/src/note/markdown.ts`：`renderNote(content, highlight): RenderedNote` 输出**行类型 + 行内 token**（非 HTML 字符串）；`toggleChecklistLine(content, srcIndex)` 勾选写回；`countNoteChars(content)` 字数
- 行类型：heading（1-3 级）/ checklist / list / text / empty，携带 srcIndex 源行号用于回写定位；行内 token：bold/italic/strike/code/hl（搜索高亮）
- 模板经 `NoteInline.vue` 组件渲染 token——**无 v-html、无 XSS 面**；italic 正则用 lookbehind/lookahead 防止吃掉未闭合 `**`
- 单元测试 9 例：行分型/行内语法/code 不解析/未闭合容错/高亮注入/勾选写回/越界原样/字数

---

## 九、字数统计

### 功能介绍

卡片右下角显示**字数**（中文字符 + 英文单词计数），编辑态实时更新；不弹独立面板，保持轻量。

### 技术方案

- `countNoteChars(content)`：CJK 按字符、连续拉丁按词计数；卡片角落 `text-[10px] text-ink-faint` 展示

---

## 十、AI 便签整理

### 功能介绍

卡片工具栏「AI 整理」（依赖设置页 AI 配置，未配置引导设置页）：**总结要点**与**提取待办**（从内容提取条目生成清单语法）；结果**追加**到便签而非覆盖，用户自行删改。

### 技术方案

- 复用 `aiClient.loadAiConfig` + `aiComplete`；两个 prompt（以便签原语言输出）：摘要（≤5 行 `- ` 列表）/ 提取待办（≤10 行 `- [ ]` 清单语法，与清单模式渲染一致）
- 未配置 AI（缺 apiKey/baseUrl）→ 灵动岛引导设置页；其余错误透传（reason 截断 60 字）；结果**追加**到原内容尾部走既有 updateNote 保存链路
- `aiBusy` 防重入；空便签直接提示无需整理

---

## 十一、桌面便签窗口

### 功能介绍

便签可**钉到桌面**：独立置顶小窗（无边框、透明、始终在桌面最前），只读渲染 + 双击可直接编辑（Ctrl+Enter / 失焦保存），与主窗口数据近实时双向同步——本工具作为桌面效率板的招牌特性（StickyHover / Stickies 的核心卖点在桌面端的等价物）。

### 技术方案

- Tauri `WebviewWindow` 动态创建：`/note-pin/:id` 路由页（`app/pages/note-pin/[id].vue`），每条便签独立窗口（label = `note-pin-{id}`，重复点击唤起已有窗口）；alwaysOnTop、decorations: false、transparent、skipTaskbar、创建不抢焦点；**权限**：capabilities `windows` 白名单含 `note-pin-*`（缺失会导致子窗口全部 invoke 被拒：拖动/关闭/查询失效）+ `core:window:allow-start-dragging`；**弹出时序**：所有桌签窗一律**隐藏创建（visible:false）**，页面首次数据加载 + 内容渲染完成后广播 `note-pin-ready`，主窗口侧 `useDesktopPin` 模块级监听收到才 show——加载期任何默认底色帧（WebView2 默认背景 / body 米色渐变）都不可见，根治「贴边拖动时主窗口外闪现背景色实底小窗」（SPA 下 useHead 内联透明插入时机仍晚于全局背景 CSS 首绘，CSS 侧无法根治，改为时序根治）；跟随态登记 `followStates` Map：转正早于页面 ready（快速松手）时 show 时补发 `note-pin-follow=false`，停在横条态的窗口恢复完整卡片；透明背景三重保障：`transparent:true` + `backgroundColor:[0,0,0,0]` + 页面 `useHead` 内联透明 CSS（show 前生效，双保险）
- **ready-show 焦点链**（「松手后跟随横条不收尾」根因修复）：跟随窗 `show()` 激活抢焦点 → 主窗口 webview 失焦 → 浏览器暂停鼠标事件派发 → 拖动中的 `pointerup` 丢失 → `dragUpHandler` 永不执行。修复：ready listener show 后立即 `setFocus()` 焦点归还主窗口（恢复事件流）；show 前刷新 `__childOpeningUntil` 豁免（防失焦取消误判）；跟随横条 `@pointerup` 转发 `note-pin-drag-up` 作为兜底通道（主窗口失焦收不到 pointerup 时由跟随窗上报，光标松手必然落在横条上）；转正分支不再直接 `show`（未 ready 窗口会闪底色帧且抢焦点），统一交 ready listener（`followStates=false` 时附带补发退出跟随同步）
- **无导航**：app.vue 子窗口路由豁免名单（`CHILD_WINDOW_ROUTES`）含 `/note-pin`——桌面便签窗口不渲染主窗口 TitleBar，窗口即便签本身（顶部细把手行拖动）
- **可编辑**：双击进编辑（textarea 自适应高度）；Ctrl+Enter / 失焦保存、Esc 取消（快捷键与主卡片一致）；全列写回 updateNote（主窗口轮询签名变化近实时回流列表）；编辑中暂停轮询防覆盖输入
- 页面复用 StickyNoteItem 同源只读渲染（renderNote + NoteInline）与主题适配配色（adaptNoteColorToScheme）；顶部把手行整行 mousedown 直调 `startDragging()` 拖动（`data-tauri-drag-region` 依赖 target 自带属性，把手内 svg 命中不触发，不可靠）；关闭按钮常显 + ESC 关窗
- 数据同步：3s 轮询 fetchSingleNote（签名去重，无变化不重渲染）；便签被删除/进回收站自动关窗（曾展示过内容的桌签不残留空壳），坏 id 显示「便签不存在」缺失态
- **独立生命周期**：主窗口失焦自动隐藏（useAutoHide）与显式收起到托盘（app.vue onCloseRequested）的「关闭可见子窗口」循环均豁免 `note-pin-*`——主窗口收起后桌签仍常驻桌面；桌签随自身关闭按钮或便签被删除收尾
- **拖出钉桌**：按住卡片拖出主窗口松手即钉。窗口内阶段：原卡片半透明缩小 + 幽灵迷你卡跟随光标；**光标贴近边缘（28px，金色图钉「可钉住」预览）持续 ~130ms 即实体化跟随窗**（快速划过不创建）——主窗口 webview 裁剪窗口外区域、幽灵卡无法显示超出部分，跟随窗（独立窗口）不受裁剪，**横条跨边界完整可见**（窗口初始即迷你横条尺寸 `DESKTOP_PIN_FOLLOW_SIZE` 248×56、落点精确在光标处、URL 带 `?following=1` 页面首帧即横条）；**进入贴边/出界区幽灵立即隐藏**（跟随窗置顶覆盖同位置，双显示无意义；出界后 client 坐标被 clamp 幽灵会僵在边缘）；**拖回安全区跟随窗立即销毁**、幽灵卡接管；**贴边或出界松手都钉住**（贴边预览即确认）→ 恢复完整尺寸（`setDesktopPinFollowing(false)`）+ 页面重播 `note-pop-in` 定格 + 金色脉冲；安全区松手取消；跟随窗创建失败回退父级创建路径。**打断即取消**（`cancelDrag` 统一收尾：销毁跟随窗 + 解除全部监听/豁免 + 幽灵飞回）：拖动中 **ESC** 主动取消、**主窗口失焦**（Alt-Tab / 其它应用抢焦点）自动取消（豁免子窗口打开期 600ms 防误判）、**pointercancel** 系统打断强制取消（不按出界松手处理、不误钉）、组件卸载全清。跟随定位窗口中心对齐光标、物理像素直传 `setPosition`；主窗口边界拖动期间缓存 + 33ms 步进 ≈ 30fps，每帧仅 2 次 invoke。创建/落点/跟随统一在 `useDesktopPin.ts`（与工具栏钉桌按钮共用）。6px 移动阈值不干扰单击/双击进编辑；拖动结束合成 click 抑制选中；出界判定用 OS 级 `cursorPosition` 与主窗口 outer 边界比对；拖动中 `__noteDragging` 豁免主窗口失焦自动隐藏（useAutoHide），创建跟随窗/松手先立 `__childOpeningUntil` 再清标记
- 位置：光标当前位置 + 级联偏移（每多一张桌签 +28px），多条钉住不重叠；**单位换算**：`WindowOptions.x/y` 为逻辑像素而 `cursorPosition` 为物理像素，按光标所在显示器 `monitorFromPoint().scaleFactor` 换算（DPI 缩放下否则偏移）；子窗口打开豁免期 `__childOpeningUntil`（同 note-colors 先例）。**加载期透明**：窗口创建参数 `backgroundColor: [0,0,0,0]`（WebView2 默认背景）+ 页面 `useHead` 内联 `html,body{background:transparent}`（随 HTML 解析即生效，早于 mounted 的 useTransparentWindow）——消除跟随窗加载瞬间闪「主窗口背景色（body 米色渐变）实底小窗随后消失」的帧

---

## 十二、拖动重排（手动排序）

### 功能介绍

主窗口内**按住便签卡片拖动**即可自由排序：其余卡片实时让位（FLIP 动画），松手落位并持久化，排序下拉自动切换为**手动排序（拖动）**。与「拖出钉桌」（功能 11）共用同一手势——**窗内松手 = 重排落位，拖出窗口/贴边松手 = 钉桌**，ESC / 失焦 / pointercancel = 取消飞回。

### 技术方案

- `sort_order` 列（v21 迁移 + migrator.ts 兜底）；`insertNote` 子查询 `MAX(sort_order)+1`，新便签排在手动顺序末尾
- 持久化走专用批量方法 `updateNoteSortOrder`（**单条 CASE WHEN 批量 UPDATE，天然原子**——不用 BEGIN/COMMIT：tauri-plugin-sql execute 走连接池，事务语句可能落不同连接报 "cannot commit - no transaction is active"；**不经过 updateNote**，不刷 `updated_at`）——时间排序与轮询签名（`${id}:${updated_at}`）完全不受影响；落位整列回填 0..n-1，置顶/普通分区的相对顺序随全列表保留
- 命中检测（基准列表算法，根治让位振荡）：判定基准 = **去掉拖动卡后的列表**（其余卡让位后的稳定布局，插入点语义恒定，不会"插入→判定无变化→强制回退→再插入"来回切换）；卡片矩形取 `offsetLeft/offsetTop` 布局位（不受 FLIP transform 动画中间态干扰）；光标命中同区卡 → 过垂直中线插其后、未过插其前（自带滞后）；未命中 → 区末；落异区卡上 → 预览不动。预览顺序未变时**保持现状不清空**
- 拖动中 `dragPreview` 实时更新（`drag-move` 事件经 rAF 节流上报光标），`<TransitionGroup name="note">` + `.note-move`（transform 0.26s）让其余卡片让位；**源卡禁用 FLIP move**（`.note-drag-source` transition: none——拖动态 scale(0.97) 与 FLIP inline transform 冲突会缩放跳动）；松手预览保留到 `sort_order` 落库 + manual 排序就绪后才释放（gridNotes 已与预览一致，落位不跳变）
- 复用 StickyNoteItem 既有拖动手势（>6px 激活）：原「窗内安全区松手取消飞回」改为 `drag-drop` 落位合入（幽灵卡 140ms 快速淡出）；取消路径（ESC/失焦/pointercancel）仍飞回
- 已选排序模式不受影响——切换到其它排序（更新时间/创建时间/颜色）即按该模式展示，`sort_order` 保留待切回

---

## 未实现项（如实标注）

### 导出 txt — ❌ 不做
按产品决策移除（原规划第 9 项）；如需迁移内容可复制粘贴。

### 完整 Markdown 引擎 / 富文本编辑器 — ❌ 不做
轻量格式（功能 8）覆盖 90% 场景；引入 markdown-it/Tiptap 包体与复杂度不成比例。

### 图片/语音/手绘附件 — ❌ 不做
便签定位轻量速记；需要落盘机制与删除联动改造，参考剪贴板图片链路再评估。

### 云同步 / 协作 — ❌ 不做
本工具数据只留本机的产品原则，不做云同步与多人协作。

### OCR / 语音转写 — ❌ 不做
依赖平台能力与模型投入，待后续版本评估。

---

## 验证结论

| 验证项 | 命令 | 结果 |
|--------|------|------|
| 前端类型检查 | `npx vue-tsc --noEmit` | ✅ 0 错误 |
| 单元测试 | `npm run test`（vitest） | ✅ 31 文件 / 271 用例全绿（含 `updateNoteSortOrder` CASE WHEN 批量断言） |
| Rust 编译检查 | `cargo check`（src-tauri/） | ✅ Finished（含 v20/v21 迁移） |
