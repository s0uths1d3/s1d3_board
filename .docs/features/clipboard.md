# 剪贴板（clip）

> 自动记录系统剪贴板的文本 / 富文本 / 图片 / 文件，提供搜索、收藏、序列粘贴与保留策略的主历史列表。

由代码审查整理于 2026-10。

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 主窗口唤出/隐藏 | 显示或隐藏整个面板窗口，失焦自动隐藏 | `Ctrl+I`（全局） |
| 自动记录 | 复制文本/图片/文件自动入库并刷新列表，事件驱动 | 自动（—） |
| 富文本保留 | 带格式复制存 HTML 源码，粘贴还原格式、纯文本目标自动降级 | 自动（—） |
| 文件条目 | 复制文件记录「N 个文件」条目，粘贴还原 CF_HDROP 文件语义 | 自动（—） |
| 图片落盘 | 原图落文件（DB 存 `imgfile:` 引用），缩略图 + 二维码识别 | 自动（—） |
| 全文搜索 | 关键词过滤 + 匹配文本金色高亮 | `Ctrl+F` 聚焦搜索框 |
| 高级搜索 | 空格拆词 AND + 双引号整句短语；开关状态持久化 | 搜索栏开关（—） |
| 大小写区分 | 关键词按字面大小写匹配（GLOB）或忽略大小写（LIKE，默认） | 搜索栏开关（—） |
| 条目筛选 | 仅收藏 / 类型多选（文本/图片/文件）/ 来源应用筛选 | 搜索栏旁控件（—） |
| 收藏 | 收藏/取消收藏选中项，收藏条目豁免裁剪与过期清理 | `Ctrl+L` |
| 粘贴选中项 | 写剪贴板并模拟 Ctrl+V 粘贴到目标应用 | `Enter` |
| 快捷粘贴前 10 项 | 全局粘贴主列表第 N 项（第 10 项对应 0） | `Ctrl+Shift+1 ~ Ctrl+Shift+0`（全局） |
| 方向键选择 | 上/下一项移动选中行 | `↑` / `↓` |
| 删除条目 | 删除当前选中项（独立确认窗口） | `Delete` |
| 添加常用剪贴 | 把选中项加入常用剪贴板 | `Ctrl+U` |
| 序列粘贴 | 多选 ≥2 条设为队列，`Enter` 逐步粘贴并弹岛进度 | 批量工具栏按钮 + `Enter` |
| 批量操作 | `Ctrl` 逐条 / `Shift` 范围多选后批量删除 | 鼠标（—） |
| 转为待办/便签 | 多行清单逐条建待办（默认最低优先级，来源记入 links）；或整条转便签 | 右键菜单（—） |
| 悬停提示 | 悬停弹出完整内容预览（保留原始缩进，可切换自动换行） | 鼠标悬停（—） |
| 图片查看器 | 图片条目放大查看，支持缩放/旋转/多图切换 | 点击图片条目（—） |
| 来源应用展示 | 条目信息行显示来源应用图标与名称（图标缓存 + 负缓存重试） | 自动（—） |
| 流式加载 | 首屏 50 条，滚动到底自动加载下一页 | 滚动（—） |
| 隐藏窗口 | 收起主窗口 | `Esc` |

## 关键行为

### 自动记录与事件驱动刷新
- 监听文本/图片/文件三类剪贴板变化，落库前逐条过「隐私模式 → 敏感内容拦截 → 来源应用忽略名单」三道闸。
- 写库成功后派发 `clipboard:changed` 事件驱动列表刷新（替代轮询）。
- 列表刷新用条目指纹（id:updated_at:count:is_favorite）判断是否变化，内容未变跳过重赋值，避免图片大字段无谓重渲染。
- 实现：`app/src/clipboard/clipboardListener.ts:65`、`app/src/commands/local/clipboardStore.ts:160`。

### 富文本保留
- 文本监听内先 `hasHTML()` 探测、再 `readHtml()` 读取，裁出 `<!--StartFragment-->…<!--EndFragment-->` 真实片段。
- `content` 存纯文本兜底（列表/搜索/tooltip 全链路按纯文本工作），`html_content` 单独存 HTML 源码；读取失败/为空回退纯文本条目。
- 粘贴时 `html` 类型走 `writeHtmlAndText` 双格式写入，目标应用按能力择优；右键「复制」同样双格式写回。
- 实现：`app/src/clipboard/clipboardListener.ts:84`、`app/src/commands/local/pasteUtil.ts:57`。

### 图片落盘（imgfile: 引用）
- 快速通道（Windows）：单命令 `clipboard_capture_image` 在 Rust 侧一次完成读位图/落盘/缩略图/二维码扫描，原图字节不过前端 IPC；触发源为插件 watcher 与岛 80ms 轮询双通道，`capturing` 互斥并发只捕获一次。
- 旧链路回退：`save_clipboard_image` 落盘（sha256 内容寻址去重 + 单条 20MB 上限），DB 只存 `imgfile:` 引用，落盘失败回退存 dataUrl 兜底不丢数据。
- 二维码识别结果落 `qr_text` 列：已扫无码写 `''` 哨兵不再补扫；扫描完全不可用留 NULL，存量图片列表可见时惰性补扫。
- 实现：`app/src/clipboard/clipboardListener.ts:143`、`:181`。

### 文件条目
- 复制文件不携带 `CF_UNICODETEXT`，经 `onSomethingUpdate` 的 `files` 分支 `readFiles()`（Rust 解析 CF_HDROP）取绝对路径数组，`content` 存 `JSON.stringify(paths)`。
- 列表显示文件名序列与「N 个文件」徽章；岛胶囊显示文件名序列（`clipFilesPreview` 解析 JSON 取尾段）。
- 粘贴时解析 JSON 后 `writeFiles` 写回系统剪贴板再模拟 `Ctrl+V`，还原真实文件拖放语义。
- 实现：`app/src/clipboard/clipboardListener.ts:107`、`app/src/commands/local/pasteUtil.ts:62`。

### 全文搜索与高亮
- 过滤条件含关键字/仅收藏/类型多选/来源应用，SQL 侧执行；条目 `type IN ('text','html')`，富文本按纯文本兜底命中。
- 高级搜索按空格拆词 AND + 双引号整句短语；大小写区分开关切换 LIKE/GLOB 词法（通配语义不变）；两开关状态持久化且防晚到恢复覆盖用户操作。
- 列表条目用 `HighlightText` 按同一拆词规则渲染金色高亮，二维码识别结果也可参与高亮。
- 实现：`app/src/commands/local/clipboardStore.ts:75`、`app/src/core/db/repositories/clipboardRepository.ts:437`、`app/pages/index.vue:1559`。

### 收藏
- `Ctrl+L` 切换选中条目 `is_favorite`，结果经 `favorite:result` 事件回主窗口反馈。
- 收藏条目豁免上限裁剪与过期清理（淘汰候选与过期 SQL 均带 `is_favorite <> 1`）。
- 实现：`app/src/commands/local/FavoriteCommand.ts:17`、`app/src/core/db/repositories/clipboardRepository.ts:203`。

### 粘贴与使用计数
- `Enter` 粘贴时序：取选中内容 → 显式 `count+1` 刷新 `updated_at` → 写剪贴板 → 隐藏窗口 → 模拟 Ctrl/Cmd+V（顺序不可颠倒）。
- 同时开抑制窗口（`suppressUseCountBump`）防止写剪贴板触发的监听再 bump 双计。
- 任意应用内全局 `Ctrl+V` 由 Rust 钩子感知，文本按内容精确匹配 +1（图片 base64 编码不稳定不计数）。
- 计数参与上限裁剪排序（用得少先淘汰）。
- 实现：`app/src/commands/local/PasteCommand.ts:60`、`app/composables/useCopyIsland.ts:297`。

### 序列粘贴
- Ctrl/Shift 多选 ≥2 条后批量工具栏「设为序列粘贴队列」建队：点选顺序即粘贴顺序，队列存共享 store，不持久化。
- 激活后 `Enter` 忽略选中行、按游标取模循环步进粘贴，粘贴后 700ms 弹岛显示 `序列粘贴 i/n`（延迟到「已粘贴」胶囊之后，岛单窗覆盖展示）。
- 队列条目被删除/裁剪后自动退出序列模式防贴错；批量选择清空后显示「序列粘贴中」状态条可退出。
- 实现：`app/src/commands/local/clipboardStore.ts:263`、`app/src/commands/local/PasteCommand.ts:33`。

### 上限裁剪与过期清理
- 每次新插入后按「剪贴板最大存储数量」（KV `max_save_count`，默认 1000）裁剪：淘汰候选按 count 升序 → updated_at 升序 → id 兜底，收藏豁免。
- 过期清理按「历史保留时间」（KV `clip_retention_days`，永久/7/30/90/365 天）在应用启动与设置变更时触发，500 条/批删除。
- 图片条目过期时联动 `deleteImageFileByRef` 删除原图文件；变更设置立即清理并弹岛反馈删除条数。
- 实现：`app/src/core/db/repositories/clipboardRepository.ts:186`、`:595`。

### 转为待办 / 便签
- 右键菜单把选中条目派发给 `dispatchClip`：多行清单逐条建待办（默认最低优先级，来源条目 id 记入 links，完成待办时回写剪贴板使用计数）。
- `clipToNote` 整条转为便签内容，来源标题回链剪贴板。
- 实现：`app/src/commands/local/dispatchClip.ts:46`、`app/pages/index.vue:998`。

## 边界与限制

- 条目类型四种：`text / image / html / files`；`html` 条目 `content` 存纯文本兜底，HTML 源码单独存 `html_content` 列（迁移 v18）。
- 上限默认 1000 条（KV `max_save_count`）；淘汰策略「用得少先删、久未用先删」，收藏永不被挤掉。
- 保留时间默认永久；到期清理由启动/插入/设置变更触发（非后台定时器），图片原图联动删除。
- 图片缓存磁盘占用另有上限（KV `image_cache_max_mb`，默认 256MB），超限清理孤儿文件。
- 忽略名单（KV `ignored_apps`，小写比较）中的应用复制不落库、不弹岛，文本/图片/文件同样受控。
- 敏感内容防护（卡号/验证码/密码形态，默认开启）命中不落库，弹岛提示但不回显内容本身。
- 隐私模式开启时一切记录暂停（不落库/不弹岛/不解析）。
- 文件条目不能加入常用剪贴板；从应用拖出文件条目仅携带纯文本路径列表（WebView 无法还原拖放语义）。
- 历史条目只读，不支持原地编辑（去重与统计依赖 `content UNIQUE` 的不可变语义）；常用剪贴板条目可编辑。
- 不做通用 OCR：图片条目仅二维码识别（搜索按 `qr_text` 命中）；富文本条目计数入「复制文本次数」。
- 无粘贴前处理规则引擎，按原始内容还原；格式加工走智能剪贴板管线。
- 序列队列为会话级，重启后自动失效；未激活时对普通粘贴零影响。
- 图片复制快速通道仅 Windows 可用；非 Windows/捕获失败回退旧链路，行为不劣化。

## 深读文档

- [../clipboard-features.md](../clipboard-features.md) — 富文本/文件/忽略应用/保留时间/标签/序列粘贴的实现细节与迁移说明
- [smart-clip.md](smart-clip.md) — 复制内容进入智能剪贴板管线的加工流程
- [island.md](island.md) — 复制/粘贴/剪切的全局感知与弹岛反馈
