# 功能总览（按模块）

> S1d3 Board 全部用户可见功能的分模块参考文档。每篇含功能总览表（功能 / 说明 / 入口与快捷键）、关键行为解释（附源码位置）与边界限制。
> 由代码审查整理于 2026-10，以 `dev` 分支代码为准；快捷键均经 `app/src/commands/shortcuts/InitShortcuts.ts` 逐条核对。

## 模块索引

| 模块 | 文档 | 一句话定位 | 深读文档 |
|---|---|---|---|
| 📋 剪贴板 | [clipboard.md](./clipboard.md) | 自动记录文本 / 图片 / 富文本 / 文件，可搜索、收藏、序列粘贴 | [clipboard-features.md](../clipboard-features.md) |
| ✂️ 截图 | [screenshot.md](./screenshot.md) | 全局快捷键区域截图 + 标注 + 贴图，与剪贴板历史深度融合（2026-10 实现） | [screenshot-spec.md](../screenshot-spec.md) |
| 📌 常用剪贴板 | [pinned.md](./pinned.md) | 高频内容置顶固定，`Ctrl+1~0` 全局直达粘贴 | — |
| ✅ 待办 | [todo.md](./todo.md) | 优先级 / 分类 / 截止日期 / 智能+自定义重复提醒 / NLP 录入 | [todo-features.md](../todo-features.md) |
| 🗒️ 便签 | [note.md](./note.md) | 多色瀑布流便签，清单勾选、AI 整理、桌面钉选 | [note-features.md](../note-features.md) |
| 📊 统计 | [statistics.md](./statistics.md) | 多维使用数据、趋势分布、趣味数据与用户画像 | — |
| ⏱️ 应用时长 | [app-usage.md](./app-usage.md) | Rust 侧前台时长采集，活跃 / 挂机拆分（默认关闭） | — |
| 🏝️ 灵动岛 | [island.md](./island.md) | 屏幕顶部胶囊反馈中心 + 开放 API / Webhook / SSE | [island-api.md](../island-api.md) |
| 🧠 智能剪贴板 | [smart-clip.md](./smart-clip.md) | 提取器 / 方案重组 / AI 分析 / 环形气泡窗 | [smart-clip-ai-analysis.md](../smart-clip-ai-analysis.md) |
| ⚙️ 设置 | [settings.md](./settings.md) | 快捷键录制与冲突检测、配色、语言、窗口与隐私 | — |
| 🧩 贯穿能力 | [global.md](./global.md) | 快捷键体系 / 全局搜索 / 多窗口协作 / i18n / 隐私 / 备份 | [architecture.md](../architecture.md) |

## 功能规模速览

| 模块 | 功能总览条目 | 关键行为小节 | 默认状态 |
|---|---:|---:|---|
| 剪贴板 | 23 | 10 | 主 tab，始终可用 |
| 截图 | 18 | 3 | 主窗口独立功能，`Ctrl+Alt+A` 唤起 |
| 常用剪贴板 | 11 | 9 | tab 可启停 |
| 待办 | 27 | 11 | tab 可启停 |
| 便签 | 20 | 8 | tab 可启停 |
| 统计 | 14 | 11 | tab 可启停 |
| 应用时长 | 9 | 9 | **默认关闭**，设置内开启 |
| 灵动岛 | 16 | 9 | **默认关闭**，设置内开启 |
| 智能剪贴板 | 16 | 9 | 随剪贴板数据，AI 需配置 |
| 设置 | 21 | 9 | 常驻 |
| 贯穿能力 | 24 | 13 | 始终生效 |

> 「功能规模速览」为各文档功能总览表行数与关键行为小节数的汇总，具体条目以各模块文档为准。

## 全局快捷键速查（经 InitShortcuts.ts 核对）

| 快捷键 | 作用域 | 功能 | 命令 id |
|---|---|---|---|
| `Ctrl+I` | 全局 | 显示 / 隐藏主面板 | `toggle_window` |
| `Ctrl+Shift+1~0` | 全局 | 粘贴剪贴板第 N 项 | `slot_paste_1~10` |
| `Ctrl+1~0` | 全局 | 粘贴常用剪贴第 N 项 | `pinned_paste_1~10` |
| `Esc` | 窗口内 | 隐藏主面板 | `hide_window` |
| `↑` / `↓` | 窗口内 | 选择上一项 / 下一项 | `select_prev` / `select_next` |
| `Enter` | 窗口内 | 粘贴选中项（仅剪贴板 tab） | `paste` |
| `Delete` | 窗口内 | 删除选中项 | `delete_item` |
| `Ctrl+L` | 窗口内 | 收藏 / 取消收藏 | `favorite_item` |
| `Ctrl+U` | 窗口内 | 添加选中项为常用剪贴 | `add_to_pinned` |
| `Ctrl+N` | 窗口内 | 新建便签（仅便签 tab） | `create_note` |
| `Ctrl+Enter` | 窗口内 | 保存便签 / 待办编辑确认 | `save_note` / `ContextEditCommand` |
| `Ctrl+F` | 窗口内 | 聚焦当前页搜索框 | `find_in_tab` |
| `Ctrl+P` | 窗口内 | 全局搜索 | `global_search` |
| `Ctrl+B` | 窗口内 | 唤出智能剪贴板气泡 | `bubble_toggle` |
| `Ctrl+T` | 窗口内 | 切换窗口置顶 | `toggle_always_on_top` |
| `Ctrl+←` / `Ctrl+→` | 窗口内 | 上一个 / 下一个标签页 | `switch_prev_tab` / `switch_next_tab` |
| `Ctrl+Alt+A` | 全局 | 区域截图（标注 / 贴图 / 保存） | `screenshot` |
| （未绑定） | — | 循环切换配色主题 | `cycle_color_scheme` |

全部快捷键可在设置页录制修改（含冲突检测与注册失败回滚）；`Ctrl+←/→` 改键必须含修饰键。

## 与本文档集相关的其他资料

- [架构总览](../architecture.md) · [模块交互](../module-interactions.md) · [数据库](../database.md)
- [剪贴板深读](../clipboard-features.md) · [待办深读](../todo-features.md) · [便签深读](../note-features.md)
- [灵动岛 API](../island-api.md) · [智能剪贴 AI 分析](../smart-clip-ai-analysis.md) · [彩蛋系统](../easter-eggs.md)
- [代码审查报告（2026-10）](../code-review-2026-10.md) — 已知问题与改进清单
