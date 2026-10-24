# 便签（note）

> 多色瀑布流轻量便签：置顶、标签、清单勾选、轻量 Markdown 渲染、AI 整理，可钉到桌面常驻。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 新建便签 | 新建空白便签并进入编辑态（仅便签页生效） | `Ctrl+N` |
| 编辑保存 | 双击或 `Ctrl+Enter` 进入编辑；`Ctrl+Enter` 保存（输入防抖自动保存、失焦保存兜底）；`Esc` 取消编辑 | 双击卡片 / `Ctrl+Enter` |
| 多色便签 | 配色为「名称 + 十六进制颜色」的自定义列表（默认黄/粉/蓝/绿/紫/橙六色），卡片低透明底 + 同色描边动态着色 | 卡片工具栏配色选择 |
| 配色管理 | 独立窗口增删改配色（名称≤8 字符、取色器 15 色板），提交后跨窗口广播刷新所有便签卡 | 卡片工具栏「管理配色」 |
| 置顶 | 置顶便签在列表顶部独立「置顶」区优先展示（带图钉图标分隔行），不受排序影响 | 卡片工具栏图钉（金色实心 = 已置顶） |
| 标签 | 空格/逗号分隔（最多 8 个，去空去重），卡片金色弱化徽章；不设全局筛选栏（仅展示） | 编辑态行内标签输入 |
| 清单勾选 | `- [ ]` / `- [x]`（`*` 亦可）语法行渲染为可点击复选框，点选就地改写内容并自动保存；普通文本与清单可混排 | 只读卡片点击复选框 |
| 轻量格式渲染 | `#`~`###` 标题、`**粗体**`、`*斜体*`、`~~删除线~~`、`` `行内代码` ``、`-`/`*` 列表、搜索关键词高亮 | 只读卡片 |
| 字数统计 | 非空白字符逐个计数（中英文/数字/标点同权），卡片右下角实时更新 | 卡片角落 |
| AI 整理 | 总结要点（≤5 行 `- ` 列表）/ 提取待办（≤10 行 `- [ ]` 清单语法），结果**追加**到便签尾部不覆盖 | 卡片工具栏「AI 整理」（依赖设置页 AI 配置） |
| 搜索 | LIKE 搜索 + 高级词法（与剪贴板同一套：空格 AND、`\|` OR、引号整句、`*`/`?` 通配符）+ 大小写区分；范围可切「当前加载 / 全部」，命中文本金色高亮 | 搜索框 / `Ctrl+F` 聚焦 |
| 排序 | 最近更新（默认）/ 创建时间 / 颜色 / 手动排序（拖动落位时自动切换） | 搜索栏旁排序下拉 |
| 拖动重排 | 按住卡片拖动，其余卡片实时让位（FLIP 动画），松手落位持久化（`sort_order`） | 直接拖动卡片 |
| 拖出钉桌 | 按住卡片拖出主窗口/贴边（28px，金色图钉预览持续 ~130ms）松手即钉为桌面便签；ESC/失焦/pointercancel 取消飞回 | 拖拽手势 |
| 桌面便签窗口 | 独立置顶小窗（无边框/透明/skipTaskbar/不抢焦点），顶部把手行拖动，只读渲染 + 双击编辑，与主窗口近实时双向同步 | 卡片工具栏「钉到桌面」/ 拖出钉桌 |
| 回收站 | 删除为软删（不弹确认框，灵动岛反馈）；回收站视图显示删除时间，支持恢复/彻底删除（确认框） | 视图切换按钮 |
| 批量操作 | 多选模式下批量改色（选色即应用）/ 批量删除（进回收站）/ 全选 | 「批量管理」 |
| 复制/转待办 | 卡片「更多操作」菜单：复制内容 / 转为待办（经共享分发管道 dispatchClip） | 卡片菜单 |
| 删除确认 | 仅回收站「彻底删除」需要确认；主列表删除直接软删可恢复 | DeleteConfirm 组件 |
| 全局搜索联动 | `Ctrl+P` 面板命中便签后切本 Tab + 写入搜索词（强制切回「全部」范围） | `Ctrl+P` |

## 关键行为

### 轻量渲染管线（无 XSS 面）
纯函数 `renderNote(content, highlight)` 把纯文本 content 解析为「行类型 + 行内 token」数组（非 HTML 字符串），模板经 `NoteInline.vue` 组件渲染——无 v-html、无 XSS 面：

- 行类型：heading（1-3 级）/ checklist（含勾选态）/ list / text / empty，携带 srcIndex 源行号用于勾选回写定位。
- 行内解析先切行内代码（内部不再解析其余语法），再 bold → strike → italic；italic 正则用 lookbehind/lookahead 防止吃掉未闭合 `**`。
- 搜索高亮作为第二 pass 注入 token（大小写不敏感），与剪贴板 HighlightText 观感一致。
- `toggleChecklistLine(content, srcIndex)` 就地改写该行 `[ ]`⇄`[x]`（大小写 X 统一为 x），行号无效或非清单行原样返回（调用方跳过保存）。
- 字数 `countNoteChars`：非空白字符逐个计数。

见 `app/src/note/markdown.ts:104`（勾选写回 129、字数 95）。

### 存储与排序
content 恒为纯文本（清单/格式用 Markdown 惯用语法表达，渲染层解析，不加列）；`pinned`/`tags`/`deleted_at`/`sort_order` 为独立列（v20/v21 迁移）。排序在展示层 `compareNotes` 做：

- `updated_at` 倒序（默认）/ `created_at` 倒序。
- 按 `color`：当前配色顺序（`noteColors` 索引），自定义配色排后。
- `sort_order` 升序（拖动落位顺序，`updated_at` 倒序兜底）。

置顶便签永远在置顶区，与排序解耦。见 `app/components/note/StickyNote.vue:247`（compareNotes 255、pinnedNotes 272、gridNotes 275）。

### 拖动重排（手动排序）
- `sort_order` 落位走专用批量方法 `updateNoteSortOrder`：单条 CASE WHEN 批量 UPDATE，天然原子（不用 BEGIN/COMMIT——tauri-plugin-sql 走连接池，事务语句可能落不同连接）；不经过 `updateNote`、不刷 `updated_at`，时间排序与轮询签名 `${id}:${updated_at}` 完全不受影响；落位整列回填 0..n-1。
- 命中检测以「去掉拖动卡后的列表」为基准（其余卡让位后的稳定布局，插入点语义恒定防振荡）；卡片矩形取 `offsetLeft/offsetTop` 布局位（不受 FLIP transform 中间态干扰）；光标过垂直中线插其后、未过插其前（自带滞后）。
- 预览保留到 `sort_order` 落库 + manual 排序就绪才释放（gridNotes 已与预览一致，落位不跳变）。
- 与「拖出钉桌」共用同一手势：窗内松手 = 重排落位，拖出窗口/贴边松手 = 钉桌，ESC/失焦/pointercancel = 取消飞回。

见 `.docs/note-features.md` §12、`app/components/note/StickyNote.vue:362`。

### 桌面便签窗口（note-pin）
每条便签独立 Tauri 窗口（label = `note-pin-{id}`，重复点击唤起已有窗口）：

- 窗口参数：alwaysOnTop、decorations:false、transparent、skipTaskbar、focus:false（创建不抢焦点）。
- 时序根治闪底：一律隐藏创建（visible:false），页面数据加载 + 内容渲染完成后广播 `note-pin-ready`，主窗口侧 `useDesktopPin` 收到才 show——加载期任何默认底色帧不可见。
- ready-show 焦点链：show 激活子窗会抢焦点 → 主窗口 webview 失焦 → 浏览器暂停鼠标事件 → 拖动 pointerup 丢失；show 后立即 `setFocus()` 归还主窗口恢复事件流。
- 透明三重保障：窗口 `backgroundColor:[0,0,0,0]` + 页面 useHead 内联透明 CSS + useTransparentWindow。
- 数据同步：3s 轮询 fetchSingleNote（签名去重，无变化不重渲染；编辑中暂停轮询防覆盖输入）；便签被删除/进回收站自动关窗，坏 id 显示「便签不存在」缺失态。
- 独立生命周期：主窗口失焦自动隐藏与显式收起的「关闭可见子窗口」循环均豁免 `note-pin-*`，桌签随自身关闭按钮/便签删除收尾。

见 `app/composables/useDesktopPin.ts:59`（openDesktopPin 83）、`.docs/note-features.md` §11。

### 拖出钉桌手势
- 窗口内阶段：原卡片半透明缩小 + 幽灵迷你卡跟随光标（>6px 移动阈值激活，不干扰单击/双击进编辑）。
- 光标贴近边缘（28px，金色图钉「可钉住」预览）持续 ~130ms 即实体化跟随窗（快速划过不创建）——跟随窗是独立窗口不受主窗口 webview 裁剪，横条跨边界完整可见（初始即 248×56 迷你横条、落点精确在光标处、URL 带 `following=1`）。
- 进入贴边/出界区幽灵立即隐藏；拖回安全区跟随窗立即销毁、幽灵卡接管；贴边或出界松手都钉住（恢复完整尺寸 + 金色脉冲定格动画），安全区松手取消。
- 打断即取消（`cancelDrag` 统一收尾：销毁跟随窗 + 解除监听 + 幽灵飞回）；拖动中 `__noteDragging` 豁免主窗口失焦自动隐藏。
- 位置：光标处 + 级联偏移（每多一张桌签 +28px 不重叠）；DPI 缩放按光标所在显示器 scaleFactor 换算（`cursorLogical`）。

见 `app/composables/useDesktopPin.ts:83`、`.docs/note-features.md` §11。

### 配色管理与主题适配
- `useNoteColors` 模块级单例：增删改/整表替换持久化到 settings KV（`note_colors`）；旧版颜色名存储经 `LEGACY_NAME_MAP` 透明解析为 hex（非法值回退默认色）。
- `adaptNoteColorToScheme` 按当前配色转换卡片色：琥珀（default）原样使用；浅色转清透粉彩纸（色相保留、饱和收敛、明度向 0.9 收拢）；深色转同相深彩卡片（避免低彩深底叠深灰发闷）。仅用于卡片着色，配色选中判断/色板展示仍用原色。
- 配色编辑窗口提交后广播 `note-colors:changed`，主窗口所有便签卡共用同一 colors ref 收到事件重载。

见 `app/composables/useNoteColors.ts:115`（addColor 182、replaceColors 217）。

### AI 整理
复用 smart-clip 的 `aiClient`（`loadAiConfig` + `aiComplete`）：

- 摘要输出 ≤5 行 `- ` 列表、提取待办输出 ≤10 行 `- [ ]` 清单语法（与清单模式渲染一致），以便签原语言输出。
- 结果**追加**到原内容尾部走既有保存链路，用户自行删改。
- 未配置 AI（缺 apiKey/baseUrl）→ 灵动岛引导设置页；其余错误透传（reason 截断 60 字）。
- `aiBusy` 防重入；空便签直接提示无需整理。

见 `app/components/note/StickyNoteItem.vue:324`（ai-organize 事件）、`.docs/note-features.md` §10。

### 数据刷新与事件
- 列表走 `useInfiniteList` 流式分页（每页 40，签名 `${id}:${updated_at}` 一致跳过整表替换）；3s 轮询（窗口隐藏暂停）保持多窗口同步。
- `Ctrl+N` 由 `CreateNoteCommand` 派发 `create-note`（仅便签页响应）；`Ctrl+F` 聚焦便签搜索框。
- `Ctrl+Enter` 由 `ContextEditCommand` 分流：便签页派发 `save-note`（仅编辑态卡片响应，无编辑零开销；失焦自动隐藏前也会触发一次防丢内容），待办页派发 `todo:edit-request`。
- 搜索「全部」范围时全量查库 `replace` 展示（无分页语义），「当前加载」仅刷新已加载范围。

见 `app/components/note/StickyNote.vue:206`（onMounted 轮询 989）、`app/src/commands/local/CreateNoteCommand.ts:9`、`app/src/commands/local/ContextEditCommand.ts:11`。

## 边界与限制

- 便签提醒已移除（产品决策）：`remind_at` 列保留 schema 但恒空串，UI 与调度已删除；待办提醒通道不受影响。
- 不上完整 Markdown 引擎/富文本编辑器、不做图片/语音/手绘附件、不做导出 txt、不做云同步与协作、不做 OCR（产品决策，详见 note-features.md「未实现项」）。
- 配色名称最多 8 字符、重名/重命名到已存在名称拒绝；删除配色至少保留 1 个；空列表自动回退默认六色。
- 桌签窗最小 200×140，默认 280×240；跟随态迷你横条 248×56；每条便签一个独立窗口（label 已存在时复用）。
- 主列表删除无确认框（软删可恢复）；仅彻底删除走 DeleteConfirm；回收站不做自动清理。
- Wayland/纯浏览器环境无跨窗口场景，相关监听静默忽略。

## 深读文档

- [便签功能增强实现文档](../note-features.md)（12 项增强全量实现记录，含桌签窗口时序/焦点链与拖动手势细节）
- [模块交互](../module-interactions.md)（便签 ⇄ 剪贴板/待办分发管道、全局搜索跳转契约）
- [数据库设计](../database.md)（`note` 表结构与 v20/v21 新增列）
