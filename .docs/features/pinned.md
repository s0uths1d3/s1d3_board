# 常用剪贴板（pinned）

> 把高频内容固定为可命名、可打标签、可直达粘贴的常用项集合，独立于主剪贴板历史。

由代码审查整理于 2026-10。

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 添加常用剪贴 | 将主剪贴板选中项存为常用项（按 content+type 去重，已存在则忽略） | `Ctrl+U` |
| 直达粘贴前 10 项 | 按手动顺序粘贴第 N 项（第 10 项对应 0），卡片角标显示槽位号 | `Ctrl+1 ~ Ctrl+0`（全局） |
| 方向键导航 | 双列瀑布流上按 `↑↓←→` 几何最近邻移动选中 | `↑` `↓` `←` `→` |
| 删除 | 删除选中项，弹内联确认框防误删 | `Delete` / `Backspace`（或卡片删除按钮） |
| 编辑 | 名称/标签/文本内容可改（图片仅名称/标签/替换），脏检查未保存关闭有丢弃提示 | 双击或悬浮「编辑」（—） |
| 标签 | 空格分隔（兼容逗号/中文逗号）输入，去空去重，卡片金色徽章常驻展示 | 编辑器内（—） |
| 置顶 | 移到列表最前并回填手动顺序，图钉标识 | 右滑卡片 / 悬浮图钉按钮（—） |
| 长按拖拽排序 | 自由 2D（xy 轴）拖拽重排，手动 FLIP 动画平滑落位 | 长按卡片拖动（—） |
| 粘贴 | 点击卡片粘贴到唤起窗口前的目标应用 | 点击卡片（—） |
| 类型标识 | 链接（http(s) 开头）/ 图片 / 文本分类展示 | 自动（—） |
| 流式加载 | 首屏 40 条，滚动到底自动加载下一页 | 滚动（—） |

## 关键行为

### 添加与去重（Ctrl+U）
- 在剪贴板 Tab 选中条目按 `Ctrl+U`，命令按 `content + type` 查重（`isPinnedContentExist`），已存在直接忽略。
- 新增经 `add-to-pinned:result` 事件回主窗口弹岛反馈（added/exists/error）。
- 只支持文本/图片两类——文件条目不可入常用剪贴。
- 实现：`app/src/commands/local/AddToPinnedCommand.ts:20`。

### 槽位直达粘贴（Ctrl+1~0）
- 十个全局命令实例分别绑定 `Ctrl+1`~`Ctrl+0`（`CommandOrControl` 修饰），执行时实时拉取常用剪贴列表、按下标取第 N 项粘贴。
- 列表按手动顺序排序：`sort_order > 0` 的已排序项在前，未排序存量按创建时间倒序续接——编号由顺序决定，调整排序即改变槽位归属。
- 实现：`app/src/commands/local/PinnedClipPasteCommand.ts:14`、`app/src/core/db/repositories/pinnedClipRepository.ts:41`。

### 方向键几何导航
- 双列网格行优先逻辑网格（上下 ±列数、左右 ±1），实际选中用 `findNearestInDirection` 做 DOM 序（左右列容器列优先拼接）到几何最近邻的换算，避免行序错位。
- 方向键处理内嵌在组件 keydown 中（非全局命令），Ctrl 组合键交还给全局快捷键系统。
- 列表刷新后修正选中索引防越界。
- 实现：`app/components/pinned/PinnedClipList.vue:280`、`:296`。

### 删除确认
- `Delete`/`Backspace` 或卡片按钮触发内联确认框（`DeleteConfirm` 独立组件，视口居中）。
- 确认框打开期间键盘操作由确认框统一接管，列表侧不响应，防止误删/重复弹框。
- 仅删常用剪贴记录，不动主剪贴板原条目；结果经灵动岛反馈。
- 实现：`app/components/pinned/PinnedClipList.vue:236`。

### 编辑与标签
- 编辑态含名称/内容/标签三字段（悬浮「编辑」或双击进入）；图片条目内容只读，仅可改名称/标签/替换。
- 标签输入按空白/逗号切分、去空去重存 JSON 数组（`tags` 列，迁移 v18 加列），查看态以金色弱化徽章展示。
- 脏检查覆盖三字段（图片条目只看名称/标签），取消编辑且有未保存改动时弹岛提示丢弃。
- 富文本条目入常用剪贴按纯文本兜底保存（不保留 HTML 源码）。
- 实现：`app/components/pinned/PinnedClipList.vue:43`、`:197`。

### 置顶与手动排序
- 置顶是「移到列表最前并回填手动顺序」的即时操作（`pinned_at` 仅作图钉标识，不参与排序键）。
- 重排用长按拖拽（`useLongPressReorder`，xy 自由轴适配双列瀑布流；输入框/按钮/链接区不启动拖拽，不干扰文字选择）。
- 跨列移动因 TransitionGroup 无法跨容器 FLIP 改为手动 FLIP：变更前后采卡片矩形差，WAAPI 滑行落位，被更快的新重排打断时重定向不跳变。
- 落位后整列回填 `sort_order`（从 1 起，0 保留为未排序标记）。
- 实现：`app/components/pinned/PinnedClipList.vue:103`、`:126`。

### 粘贴通道与剪贴板恢复
- 卡片点击与 `Ctrl+1~0` 共用 `pasteContentToActiveApp`：写剪贴板（文本 `writeText` / 图片 `writeImageBase64`）→ 隐藏窗口让焦点交还目标应用 → 延迟 200ms 模拟 Ctrl/Cmd+V（顺序不可颠倒）。
- 写剪贴板前先 `suppressIslandCopy()` 抑制随之触发的「已复制」，写入成功后再弹「已粘贴」。
- 此路径不做显式 `increaseUseCount`，靠剪贴板监听的 upsert bump 计数。
- 「粘贴后恢复原剪贴板」开启时（KV `paste_restore_clipboard`，默认关闭）：粘贴完成把粘贴前文本写回（恢复写入同样抑制弹岛与计数 bump，不污染历史）。
- 实现：`app/src/commands/local/pasteUtil.ts:33`、`app/components/pinned/PinnedClipList.vue:145`。

### 槽位与双列布局
- 数字键标签：第 N 项对应 `Ctrl+N`（第 10 项为 0），角标由 `slotKey` 计算。
- 卡片按索引奇偶分配列：偶数索引进左列、奇数进右列——`Ctrl+1` 左上、`Ctrl+2` 右上、`Ctrl+3` 在 `Ctrl+1` 正下方。
- 左右列容器独立纵向堆叠，避免 grid 行轨道按最高卡撑行导致矮卡下方出现大块空白。
- 实现：`app/components/pinned/PinnedClipList.vue:53`、`:60`。

### 操作反馈与流式加载
- 增删改/置顶/保存失败等反馈统一弹灵动岛（`notifyIsland`，替代窗口内 toast）。
- 列表经 `useInfiniteList` 流式分页（每页 40 条，sentinel 触底加载）。
- 常用剪贴无轮询，仅在进入页面/操作后刷新已加载范围。
- 实现：`app/components/pinned/PinnedClipList.vue:19`、`:155`。

## 边界与限制

- 不限量存储（无条数上限设置）；仅前 10 条支持 `Ctrl+1~0` 快捷粘贴，槽位跟随当前手动顺序。
- 类型仅 `text / image`；富文本条目按纯文本保存（不保留 HTML 源码），文件条目不可添加。
- 粘贴通道只还原文本/图片语义：常用剪贴粘贴不参与序列粘贴，也不支持 files 类型。
- 键盘行为与主列表隔离：常用剪贴页的选中态是组件本地状态，`Enter`（PasteCommand）仅在剪贴板 Tab 响应，避免粘贴屏幕上不可见的条目。
- 标签为条目级字段，无全局标签管理。
- `Ctrl+1~0` 为全局作用域，会拦截其他应用的该组合键；可在设置中重绑或停用（快捷键分组「常用剪贴快捷粘贴」）。
- 拖拽排序只回填已加载范围的顺序，未加载的存量续接在已加载序列之后。
- 粘贴图片条目走 `writeImageBase64`（DB 存的是 base64/dataUrl 副本，不依赖主剪贴板原图文件）；删除常用剪贴不影响主剪贴板历史与图片文件。
- 快捷粘贴路径无显式使用计数：靠粘贴写剪贴板触发的监听 upsert bump（`count+1`），与主列表 `Enter` 粘贴的显式计数路径不同。
- 标签输入兼容英文逗号与中文逗号分隔（按空白/逗号统一切分后去重）。
- 置顶/重排后立即持久化手动顺序，写库失败弹岛报错且不中断本次会话操作。
- 长按拖拽在编辑态与输入框/按钮/链接等交互区不启动（卡片按下时过滤目标），避免干扰文字选择。

## 深读文档

- [../clipboard-features.md](../clipboard-features.md) §5 — 常用剪贴板标签的数据模型与编辑器实现
- [clipboard.md](clipboard.md) — 主剪贴板历史与 `Ctrl+U` 添加入口
- [island.md](island.md) — 常用剪贴增删改的弹岛反馈
