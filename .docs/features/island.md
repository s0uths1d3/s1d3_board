# 灵动岛（island）

> 屏幕顶部的胶囊式反馈中心：全局复制/粘贴/剪切感知、各窗口操作反馈统一弹岛，并经回环 HTTP 开放双向 API。

由代码审查整理于 2026-10。

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 复制感知 | 任意应用 `Ctrl+C`（文本/图片/文件）弹「已复制」胶囊，文本 ≤80ms | 自动（—） |
| 粘贴感知 | 任意应用 `Ctrl+V` 弹「已粘贴」，文本按内容精确匹配 +1 使用次数 | 自动（—） |
| 剪切感知 | `Ctrl+X` 后窗口内剪贴板真实变化才弹「已剪切」，不误报 | 自动（—） |
| 操作反馈统一弹岛 | 便签保存、待办完成与提醒、常用剪贴增删、设置变更、快捷键注册失败等收敛于此 | 自动（—） |
| ×N 重复徽标 | 同内容 5 秒窗口内再次弹出递增 ×N 计数，每条新提示带金环脉冲 | 自动（—） |
| 过程岛 | 耗时过程（如 AI 解析中）显示驻留 loading 岛，完成后结果岛平滑替换 | 自动（—） |
| 悬停展开面板 | 内容溢出胶囊时逐行带行号查看完整内容（可滚动，面板最大高 280px） | 鼠标悬停 150ms（—） |
| 图片预览 | 复制/粘贴/剪切图片在胶囊内渲染缩略图，悬停放大查看（独立预览窗） | 鼠标悬停（—） |
| 历史窗口 | 全部岛记录（500 条 FIFO）日期分组吸顶、类型/日期筛选、一键复制、CSV/TXT 导出 | 主窗口标题栏时钟图标（—） |
| 开放 API（Inbound） | 第三方 `POST /api/island/show` 推送提示、`GET /api/history` 查询历史 | 设置 → 灵动岛 API 开关（—） |
| 事件流（Outbound） | `GET /api/events` SSE 实时订阅全部岛显示事件 | 同上（—） |
| Webhook 出站 | 每次岛事件 POST 到外部 URL（HMAC 签名 + 重试 + 熔断 + URL 白名单） | 设置 → 灵动岛 API → Webhook（—） |
| 延迟与时长 | 出现延迟（默认 0ms，0–10s）与停留时长（默认 1800ms，0.6–60s）自由输入 | 设置 → 灵动岛（—） |
| 总开关 | 关闭后不弹岛，历史落库/剪切统计/SSE/Webhook 照常工作 | 设置 → 灵动岛提示（—） |
| 节日彩蛋 | 节日当天整岛换装（边框动效/骑缘徽章/面板装饰）+ 凌晨首弹台词 | 自动（受节日彩蛋开关控制） |
| s1d3 隐藏动画 | 复制/剪切/粘贴内容全等 `s1d3` 时播放键帽动画（约 1.9s） | 自动（—） |

## 关键行为

### 全局复制/粘贴/剪切感知
- 复制走双通道：80ms 轻量轮询（仅服务岛，只读文本 + 图片序列号探测）抢先用缩略图弹岛，原生 watcher 的 `island:copy` 事件随后按内容去重跳过（html 归一 text 同桶，900ms 窗口）。
- 粘贴由 Rust 全局 `Ctrl+V` 钩子发 `island:paste-detected`（仅主窗口上下文响应）；应用自身粘贴由 Rust 侧 PASTE_INJECTING 标志拦截，不重复弹岛/计数。
- 剪切由 `Ctrl+X` 钩子开 1.5s 一次性感知窗口，窗口内剪贴板真实变化（文本/图片均可）才按「已剪切」提示；无选区剪切（剪贴板未变）不弹岛不误报。
- 检测不受总开关门控（使用计数与出站推送始终工作）。
- 实现：`app/composables/useCopyIsland.ts:164`、`:264`、`:307`。

### 弹岛链路与单例队列
- 所有来源（感知/操作反馈/API）汇聚到 `showIsland`：先过隐私模式闸（暂停记录时直接丢弃，不弹岛/不落历史/不计统计）。
- 按出现延迟排队：延迟窗口内连续事件只显示最后一条（中间事件被丢弃且不广播、不落历史），是高频推送的天然节流器。
- 经 `emitIslandShow` 落历史、记剪切统计、发 `island:show-ui`（岛显示）与 `island:show`（出站桥 → SSE/Webhook）。
- 岛窗口单例常驻复用（启动预创建 + ready 握手 + 存活窗口接管）；新事件立即替换当前显示，无排队/抢占。
- 实现：`app/composables/useCopyIsland.ts:527`、`:445`。

### 定位与窗口形态
- 岛窗口 440×96 透明无边框置顶（胶囊 344×40 + 余量供脉冲环扩散/节日光晕/彩蛋动画越界演出，余量不足动画会被窗口边界物理裁切）。
- 定位在光标所在显示器顶部居中，多显示器混用 DPI 按缩放换算物理坐标。
- kind 八种（copy/copy-image/cut/paste/info/success/error/loading）决定图标与默认标签，视觉跟随主题 token。
- 实现：`app/composables/useCopyIsland.ts:418`、`app/pages/bubble.vue:46`。

### ×N 合并与金环脉冲
- 岛页面按 `kind|text|图片标记` 做重复键，5 秒窗口内重复弹岛递增 ×N 计数徽标。
- 每条新提示（无论是否重复）触发一次金环扩散脉冲（主环 + 余韵涟漪 + 图标弹跳），与入场动画叠加。
- 结果岛替换过程岛时重置悬停态并重走停留计时。
- 实现：`app/pages/bubble.vue:137`、`:170`。

### 过程岛（sticky）
- `notifyIsland` 支持 `sticky: true`：不按停留时长收回，直到下一条岛替换（页面侧有兜底超时防残留）。
- 典型消费方是 AI 解析中的 loading 驻留岛（智能剪贴板 `Ctrl+B`），分析完成后结果岛（成功/失败/信息）平滑替换。
- loading 过程岛不落历史库——它只是瞬时过程态，结果岛才值得回溯。
- 实现：`app/composables/useCopyIsland.ts:255`、`app/src/commands/local/BubbleToggleCommand.ts:175`。

### 历史窗口
- 单例窗口 `island-history`（标题栏时钟图标打开，已存在则聚焦置前，主窗口置顶时跟随置顶）。
- 打开时全量查询（表 FIFO 上限 500 条），存活期间监听实时把新消息插到列表头部。
- 按日期分组吸顶；类型下拉筛选（附计数）+ 日期筛选（今天/昨天/近 7 天/指定日期，本地时区按日切界）。
- 导出 CSV/TXT，范围可选「当前筛选/全部」，save 对话框选路径，完成后经灵动岛提示结果（尊重岛开关）。
- 图片事件历史存降采样缩略图（webp 高 56px），按「[图片]」占位渲染。
- 实现：`app/pages/island-history.vue:74`、`:271`、`app/composables/useCopyIsland.ts:478`。

### 开放 API 与 Webhook
- Rust 侧仅监听 `127.0.0.1`（端口 KV `island_api_port`，默认 12935），全接口强制 Bearer token（首次开启自动生成 64 位 hex，`?token=` query 兜底，常量时间比对）。
- Inbound：`POST /api/island/show`（text ≤2000 字符、显示层截断 120 字符、kind 五种、duration 钳制 600–60000ms、priority 预留）、`GET /api/history`（limit/kind/from–to 过滤，最新在前）。
- Outbound：`GET /api/events` SSE 全量显示事件流（15s 心跳、不回放、总开关关闭仍广播，图片事件带 `image` 原图与 `qr_text`）。
- Webhook 出站带 `X-S1d3-Signature`（HMAC-SHA256），失败指数退避重试 3 次、连败熔断 5 分钟，URL 白名单（https 任意主机，http 仅回环）。
- 第三方显示请求经 `island-api:show` 事件走同一条 `showIsland` 链路（kind 防御性收敛、duration 单次钳制覆盖）。
- 实现：`app/composables/useCopyIsland.ts:591`、`src-tauri/src/island/api.rs`。

### 二维码识别与文件预览
- 图片事件（复制/粘贴/剪切）在 Rust 侧自动扫描二维码：识别到时出站携带 `qr_text`（≤120 字符截断），岛内缩略图旁显示链接；非二维码图片零额外字段。
- 图片出站事件的 `image` 字段保持调用方提交的原始 data URL；岛内渲染用 Rust 侧降采样缩略图（高 384px webp）提速，复制快速通道经 `imgfile:` 引用由 Rust 桥按需读盘展开。
- 文件条目的岛胶囊展示文件名序列（`clipFilesPreview` 解析 JSON 路径数组取尾段），不显示 JSON 原串。
- 实现：`app/composables/useCopyIsland.ts:180`、`app/pages/bubble.vue:94`。

### 节日彩蛋注入点
- 节日判定与换装收口在独立模块 `app/festival-eggs/`（公历表 + 农历映射表，跨零点自续 ticker）：岛窗口经 `useIslandFestivalEgg()` 消费 `{ festival, tip, beforeShow }`。
- 根节点绑 `data-festival` 触发节日变量组换装（胶囊/面板/脉冲/徽章 token 全继承），`<FestivalIslandDecor>` 三个槽位挂边框动效/骑缘徽章/面板装饰，徽章悬停弹 v-tip（气泡同步换装）。
- `beforeShow` 在每次弹岛前重读总开关（跨窗口同步）并注入弹岛行为（ISLAND_QUIRKS：中秋/除夕/春节凌晨 0–5 点首弹专属台词）。
- s1d3 内容彩蛋独立于节日体系：文本复制/剪切/粘贴内容 trim 后全等 `s1d3`（忽略大小写）时播放约 1.9s 键帽动画（保底停留 2.6s），图片与系统提示不触发；彩蛋态隐藏常规图标/标签/原文，保留 ×N 徽标。
- 实现：`app/pages/bubble.vue:87`、`.docs/easter-eggs.md`。

## 边界与限制

- 总开关 KV `island_enabled` 默认开；关闭仅停显示，历史/统计/出站推送照常（API 仍返回 204）。
- 出现延迟 KV `island_delay_ms`（0–10000ms，默认 0）；延迟窗口内被合并的事件不广播、不落历史（节流建议：进度类状态变化才推或 ≥2s 间隔）。
- 停留时长 KV `island_duration_ms`（600–60000ms，默认 1800）；API 单次 `duration>0` 可覆盖本次。
- 历史表 FIFO 上限 500 条；文本显示层 120 字符硬截断（历史与出站一致），loading 过程岛不落历史。
- API 默认关闭，仅回环 `127.0.0.1`，无 TLS；token 全接口强制（含 health），修改端口/token/开关会重启服务（SSE 断开需重连）。
- SSE 不回放历史事件，重连后从新事件开始；Webhook 不缓存补投，停机窗口内事件丢失、不保证跨事件顺序。
- 图片使用计数不可靠（base64 编码不稳定）：全局 Ctrl+V 仅对文本 +1。
- 胶囊内文本预览上限 120 字符；悬停展开面板仅当内容溢出胶囊时渲染（150ms 悬停意图 + 32px 邻近检测暂停自动隐藏）。
- 节日彩蛋受设置总开关控制（KV `festival_egg_enabled`，默认开，岛侧每次弹岛前重读），s1d3 内容彩蛋不受其控制；农历节日未收录年份不触发，除夕恒为春节前一天派生。
- 快捷键注册失败（全局键被占用）也会经灵动岛通知用户（启动期失败弹岛 + 设置页标红）。
- 岛窗口无专属快捷键；历史窗口入口为主窗口标题栏时钟图标。

## 深读文档

- [../island-api.md](../island-api.md) — 开放 API 完整规范（认证/端点/事件格式/Webhook/行为模型/错误码/排查）
- [../easter-eggs.md](../easter-eggs.md) — 节日彩蛋架构、判定表、换装机制与测试方法
- [smart-clip.md](smart-clip.md) — 过程岛的触发方（AI 解析驻留岛）
- [clipboard.md](clipboard.md) — 感知事件的数据源（复制入库/使用计数）
