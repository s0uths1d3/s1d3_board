# 应用时长（app_usage）

> Rust 侧前台窗口采集按应用聚合的桌面使用时长，活跃/挂机拆分，占比环形图呈现；隐私优先，默认关闭。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 采集开关 | 一键开启/关闭前台时长记录（与应用时长页、设置页共用同一状态源）；未开启时页面显示引导开启卡片 | 页面引导卡 / 设置 → 通用 → 应用 |
| 汇总卡 | 总时长 / 活跃时长 / 挂机时长（总 − 活跃）/ 应用数 四张汇总卡 | 页面顶部 |
| 应用排行 | 按总时长降序条形列表：活跃（实心金）/挂机（淡金）两段叠加条形；排名（榜首金色）、应用图标（缺失回退首字母占位）、占比、榜首皇冠标识 | 应用列表区块 |
| 占比环形图 | 前 6 名应用 + 「其他」聚合段；分段↔图例双向联动，中心 hover 显该段占比、平时显总时长 | 环形图区块 |
| 范围切换 | 与统计页共用 RangeBar：每日/每周/每月/年度/自定义 + 阶段箭头；每个范围按钮带统计口径 hover 说明（与统计页共用文案）；范围/自定义日期变化即重载 | 页面顶部范围栏 |
| 自动刷新 | 页面切入时先立即拉取 Rust 侧内存增量并落库再读表（消除 30s 周期滞后，所见即最新），此后与 30s 拉取节奏对齐自动刷新（仅开启时） | 自动 |
| 平台不支持提示 | Linux Wayland 会话（无 X 服务）下采集不可用，探测后展示不支持提示条（X11 正常；Windows/macOS 恒可用） | 页面顶部提示条 |
| 时长人性化显示 | 秒 → X 小时 Y 分钟 / Y 分钟 / N 秒三级格式化 | 汇总卡与列表 |
| 应用名展示 | 进程名（全小写）展示时首字母大写更友好；环盘与图例共用同一显示名 | 列表与环盘 |

## 关键行为

### Rust 前台采集（30s 分段结算）
数据流（前台切换事件监听为主 + 30s 分段结算为辅）：

- 前台切换系统事件：Windows `SetWinEventHook` + 消息循环 / macOS NSWorkspace 激活通知 / Linux X11 根窗口 `_NET_ACTIVE_WINDOW` PropertyNotify。
- 维护「当前应用 + 分段起点」，切换或 30s tick 时把上一段按空闲分界拆成 总时长/活跃时长，累计进内存 totals。
- 前端每 30s `pull_app_usage` 拉走增量并清空（原子 drain，落盘文件随之删除）→ statsService UPSERT 进 `app_usage` 表（按「日期 × 应用」主键，冲突累加两列）。
- 同名重复切换事件去重（不重复开段）；无前台分段时（刚开启/异常丢失）tick 内补采样当前前台应用开段。
- 平台差异收口为三个函数（监听启动 / 前台采样 / 空闲秒数），三平台共享其余逻辑。

见 `src-tauri/src/app_usage/mod.rs:1`（on_switch 131、segment_tick 151、pull 173）。

### 活跃/挂机拆分
结算一段时：总量 = 段长；活跃 = 段长 − 段尾空闲部分。段尾空闲指键鼠无输入超过 5 分钟（`IDLE_THRESHOLD_SECS = 300`）的部分，阈值内仍算活跃；空闲秒数由平台实现查询。挂机时长 = 总时长 − 活跃时长（页面计算）。见 `src-tauri/src/app_usage/mod.rs:267`（accumulate）、`app/components/appusage/AppUsagePage.vue:85`。

### 增量落盘缓冲（崩溃不丢）
- totals 每次结算/切换后原子快照到 `app_data/pending_app_usage.json`（临时文件 + rename，崩溃不会留半截文件）；文件内容恒等于当前未拉取增量（空则删文件）。
- 启动时读回未拉取增量并入 totals 后删除文件；前端按（日期，应用）UPSERT，读回数据随下一次 pull 正常入库，不产生重复。
- 关闭开关即清空内存增量/分段/图标缓存并删除缓冲文件（未拉取增量一并放弃，重新开启从零累计）。

见 `src-tauri/src/app_usage/mod.rs:210`（persist_totals、load_pending 240）。

### 应用图标获取
- 首次见到某应用时提取真实图标转 PNG data URL：Windows `SHGetFileInfo` → HICON → `GetDIBits` → PNG；macOS NSImage → TIFF → NSBitmapImageRep → PNG；Linux 查 desktop 入口与 hicolor 主题图标。
- 图标随 pull 返回并由前端持久化到 `app_icons` 表（INSERT 覆盖写）；提取失败也记缓存防反复重试（已有记录不覆盖）。
- 页面查询未命中时实时 invoke `app_icon_by_name` 按名提取（应用须在运行，与前台采样同一图标链路），成功后写回表下次直接命中；仍缺失时回退应用名首字母占位。

见 `src-tauri/src/app_usage/mod.rs:9`、`app/src/statistics/statsService.ts:338`。

### 前端开关链路
- 开关持久化到 settings KV（`app_usage_enabled`，默认关）。
- 开启：invoke Rust `set_app_usage_enabled`（Rust 侧立即采样当前前台应用开段，避免等到下一次切换/30s 才计时）+ 启动 30s 拉取定时器。
- 关闭：invoke Rust gate + 停止拉取并强制落库最后一次增量。
- Rust 侧切换失败回滚 UI 状态；app.vue 启动时按持久化值恢复（读取失败按默认关闭处理）。

见 `app/composables/useAppUsage.ts:36`（restoreAppUsageSetting 24）、`app/src/statistics/statsService.ts:276`（startAppUsageTracking 276、pullAppUsageOnce 263、stop 286）。

### 拉取与聚合查询
- 30s 定时拉取与页面切入时的手动拉取可能并发：in-flight 去重（`appUsagePullInFlight`），Rust 侧 pull 为原子 drain，不重复计。
- `getAppUsageRange` 把 SQL 聚合结果与未落库的 `appPending` 增量合并（与统计页同构的 §14.7 口径），按总时长降序返回（含图标）。
- 范围日期由页面计算（本地时区 YYYY-MM-DD）：周一起始整周、自然月/自然年、自定义未选时回退今天；范围变化 watch 即重载。

见 `app/src/statistics/statsService.ts:308`（mergePending 373）、`app/components/appusage/AppUsagePage.vue:40`（load 166）。

### 应用排行渲染
- 条形宽度基准为区间内最大总时长（下限 3% 保证可见）；条形内部实心金为活跃部分占比、外层淡金为挂机部分。
- 每行右侧显示 总时长 · 活跃时长 · 占区间总时长的百分比；榜首应用名旁金色皇冠图标（v-tip「区间内使用时长最长的应用」）。
- 空区间（开启后尚无数据）显示空态提示。

见 `app/components/appusage/AppUsagePage.vue:141`（widthPct/activePct/sharePct）。

### 占比环形图
- 几何与统计页 Tab 访问分布环盘完全一致：r52 / stroke 14 / 段间 2px 间隙 / dashoffset 按段长负累进；金色透明度梯度共用 `DONUT_OPS`。
- hover 分段加粗描边、其余段降透明度，图例行同步高亮；中心 hover 时显示该段占比与应用名，平时显示总时长。

见 `app/components/appusage/AppUsagePage.vue:89`（pieCenter 121）。

### 采集与其他模块的关系
- `foreground_app_name` 命令（仅名称、不取图标，轻量查询）与剪贴板来源标记（`clipboard.source_app`）共用同一平台采样链路（委托注入的 `ForegroundSource` trait，State 不进 invoke 载荷，前端签名不变）。
- `list_process_names` 枚举运行中进程名（小写、去重、排序），供设置页「忽略来源应用」手动输入的匹配建议（平台不支持返回空列表）。
- 剪贴板 `source_app` 仅 INSERT 时写入（应用自身粘贴不覆盖原始来源）。

见 `src-tauri/src/app_usage/mod.rs:334-362`、`.docs/architecture.md` §6、`.docs/database.md` §10。

## 边界与限制

- **默认关闭**：未开启时不累计任何前台时长；开启前无历史数据。
- 隐私边界：只记应用名与图标，**不记窗口标题**（模块头注释明确声明）。
- 平台差异：Windows / macOS / Linux(X11) 各实现「监听启动 / 前台采样 / 空闲秒数」；Wayland 无统一前台窗口协议暂不支持（`app_usage_supported` 仅 Linux 需探测，X11 connect 成败判定）。
- 数据粒度：30s 分段结算 + 前端 30s 拉取节奏，页面数据最多滞后一个拉取周期（切入页面立即补拉消除）。
- 数据聚合口径为本地时区「日期 × 应用」，跨日分段按结算时所在日期归属。
- 图标持久化失败不影响时长统计；查询失败返回空 Map 不阻塞调用方（回退文本占位）。
- 实时按名提取图标要求目标应用正在运行；未运行且无缓存时无图标记录（回退首字母）。
- 关闭开关即放弃未拉取增量（内存与缓冲文件一并清空）。

## 深读文档

- [数据库设计](../database.md)（`app_usage` / `app_icons` 表结构与 v15/v16 迁移）
- [模块化架构](../architecture.md)（ForegroundSource trait 抽象与平台实现注入）
