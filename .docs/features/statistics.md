# 统计（statistics）

> 多维使用数据面板：核心指标、趋势分布、活跃时段、趣味数据与用户画像标签，全部基于本地 `daily_stat` 表。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 时间范围切换 | RangeBar 范围栏（与应用时长页共用）：每日/每周/每月/年度/自定义 + 阶段切换箭头（不允许进入未来阶段）；另有「全部」= 完整历史（禁用箭头）；每个范围按钮带统计口径 hover 说明 | 页面顶部范围栏 |
| 专属称号横幅 | 唯一大标签：综合评分 ≥1.0 且最高者，点击可看 Top5 评分明细；无达标时兜底「好奇的萌新」；样本不足显示占位 | 页面顶部 |
| 用户画像小标签 | 五类（使用时段/使用强度/内容偏好/功能偏好/粘性）按相对指标计算，互斥类取 1、其余按类别上限截取，显示层翻译 | 「我的标签」区块 |
| 核心指标卡片 | 剪贴总量 / 图片 / 粘贴 / AI 分析 / 剪切 / 待办操作 / 待办字量 / 便签 / 收藏 / 使用时长 / 快捷键，数字滚动动画 + 入场级联 | 页面指标网格 |
| 环比徽章 | 操作总量环比上一等长区间（pct 为 null 时无对照不展示） | 指标区 |
| 待办概览 | 当前存量快照（总数/完成率等），不随日期范围变化（自待办页迁入） | 指标下方 |
| 活跃热图 | GitHub 风格贡献格（仅跨年区间展示），每日总操作量按五档金色深度着色；hover 显「日期 · 次数」；点击某格跳转该日自定义区间；峰值日金色描边；未来日期格灰显禁用 | 热图区块 |
| 数据故事 | 叙事句（总操作量/字量换算/主力 Tab/粘贴占比/峰值日/星期最佳/来源应用 No.1）+ 个性化洞察（每日轮换 2 条）+ 阶段增长徽章 | 故事卡片 |
| 趣味数据 | 打字量（万字换算）、复制之王（最常复制内容 + 次数）、最长连续使用天数（降采样区间按月计数）、时长换算（A4 页数等） | 趣味数据区块 |
| 活跃时段 | 四时段（凌晨 05-08 / 白天 09-17 / 傍晚 18-22 / 深夜 23-04）操作分布 | 活跃时段区块 |
| Tab 访问分布 | 各功能 Tab 访问占比环形图（前 6 名 + 其他），分段↔图例双向联动、中心 hover 显占比 | 环形图区块 |
| 来源应用 Top | 区间内复制条数按来源应用排行（含真实程序图标，null 回退纯文本名）；点击跳剪贴板 Tab 并按该应用筛选 | 来源应用区块 |
| 每日趋势 | 多序列切换：剪贴活动（文本+图片+粘贴）/ 粘贴 / 智能（AI+剪切）/ 使用时长 / 快捷键 / 待办 / 待办字量 / 便签；含环比幽灵序列叠显 | 趋势区块序列切换 |
| 区块流式渲染 | 长页面区块随滚动渐进出现（骨架占位 + 渐入动画），降低首屏 DOM 成本 | 自动 |

## 关键行为

### 写入合并与退出落库
`record()` 是核心写入口（fire-and-forget），只写内存累加器：

- 按日期暂存未落库增量 `pending`，首条写入后启动 2s 节流定时器，到期批量 UPSERT 到 `daily_stat`。
- 退出前（beforeunload / Tauri 退出事件）强制 flush 防内容损耗；flush 失败保留 pending 下次重试（数据零丢失）。
- 时段列（`active_*`）按当前小时自动累加（埋点无需感知时段）。
- 未知字段名白名单过滤静默丢弃（不拼进 SQL 造成非法语句）。
- `app_usage` 增量走独立的 `appPending` 累加器（同 2s 节流模式）随公共 flush 一并落库。

见 `app/src/statistics/statsService.ts:133`（flush 169、flushAppUsage 236）。

### 读取时合并 pending
所有区间/单日/序列/应用时长查询在 SQL 聚合结果之上把未落库的 pending 增量合并进返回值（§14.7 纯内存加法），避免「刚操作完统计页不动」的短暂不一致。见 `app/src/statistics/statsService.ts:373`（getStatsRange 394、getDailySeries 408、getAppUsageRange 308）。

### 查询裁剪与趋势降采样
- 区间聚合只 SELECT 所需列（`DEFAULT_RANGE_FIELDS`），聚合在数据库侧完成（§14.3）。
- 区间跨度 > 92 天（`TREND_DOWNSAMPLE_DAYS` ≈ 一季）时趋势按月聚合返回稀疏月柱，避免上千柱条常驻 DOM（§14.4）。
- 热力图/星期节奏等需要完整逐日的场景传 `forceDaily` 强制逐日。

见 `app/src/statistics/statsService.ts:57`（getDailySeries 408）。

### 范围栏（RangeBar）
- 预设范围按钮 + `‹ ›` 阶段箭头（offset ≤ 0，右箭头在当前阶段禁用，不允许进入未来阶段）。
- 自定义范围：双 DatePicker 互相约束 min/max，隐藏阶段文案改显日期输入组。
- 「全部」等无阶段概念的范围经 `disableShift` 禁用箭头；切换预设范围时自动重置阶段偏移回当前阶段。
- 阶段偏移与范围日期计算由页面各自维护（props/事件同步），组件只负责交互。

见 `app/components/statistics/RangeBar.vue:51`。

### 画像标签计算
`userTags.ts` 纯函数规则驱动，与 statsService 职责边界严格分离（本模块不写库、无副作用）：

- 构建 TagContext：区间基础量（stats/days/spanDays/earliestDate）+ 派生相对量（四时段占比/粘贴占比/日均剪贴/快捷键占比/完成率/最早使用距今天数等）。
- 小标签五类各设上限（时段互斥 1、强度/内容/功能 3、粘性 2），类别内按 priority（小→大）截取。
- 专属称号取 score ≥1.0 的最高分；全部不达标返回兜底称号「好奇的萌新」。
- 预处理查询（区间聚合 + 活跃天数 + 最早日期）做 2s TTL 短缓存 + in-flight 去重（同区间多次计算复用，失败不留缓存）。
- 规则数组驱动，扩展只改规则表；标签名经语言包 `[tag_names]` 表显示层翻译。

见 `app/src/statistics/userTags.ts:207`（规则表、CATEGORY_LIMIT 97、computeTags 371、computeUniqueTitle 403、computeTitleScores 421）。

### 标签展示门槛
区间跨度 < 15 天（`TAG_MIN_SPAN_DAYS`）时小标签整块不显示、专属称号显示「样本不足」占位；规则全部为相对指标（比例驱动，无绝对阈值）。见 `app/src/statistics/userTags.ts:20`。

### 趣味数据与故事
`story.ts` 纯函数把聚合结果转成叙事事实（全部可空，空态由页面兜底）：

- 主力 Tab 为访问量最高者；峰值日为操作量最高一天；A4 换算 = 字符总量/500 向上取整；粘贴占比等。
- 洞察为条件命中 id 集合（阈值与画像标签同口径但文案偏建议/鼓励），允许同时命中多条。
- `pickDailyInsights` 以日期字符串哈希为种子的确定性轮换 2 条（同一天同一数据源结果稳定，无随机数）；兜底 insight_keep 保持末位语义优先展示命中项。
- 最长连续使用天数由页面从逐日序列计算（降采样区间按月计数并切换单位文案）。

见 `app/src/statistics/story.ts:46`（computeInsightIds 103、pickDailyInsights 152）、`app/components/statistics/StatsPage.vue:364`（typingChars、longestStreak 370）。

### 趋势环比与幽灵序列
- 趋势图支持叠加「上一等长区间」幽灵序列：`chartMath.alignGhost` 按索引 zip 截断最短对齐（逐日等长区间天然对齐）。
- 阶段增长徽章 fire-and-forget 计算（失败不展示）。
- 加载会话（主链/growth）与趋势会话（series/ghost）分离计数作废过期响应，防竞态错乱。

见 `app/src/statistics/chartMath.ts:155`、`app/components/statistics/StatsPage.vue:112`（148-152）。

### 流式区块渲染与数字动画
- 每个区块包 `LazySection`：IntersectionObserver 进入视口（提前 160px 预加载）才渲染真实内容，之前显示骨架占位并带渐入动画；不支持 Observer 的极旧环境直接渲染。
- 指标数字经 `AnimatedNumber`（`useCountUp` 补间从旧值滚动到新值 + 千分位 + tabular-nums 防宽度抖动），纯展示组件。

见 `app/components/statistics/LazySection.vue:3`、`app/components/statistics/AnimatedNumber.vue:3`。

### 图表数学层与热图
- `chartMath.ts` 纯函数层把逐日序列/区间聚合转成图表可消费结构（热力图分格/星期聚合/环比对齐/金色透明度梯度 `DONUT_OPS` 与应用时长页共用）；与 story.ts / userTags.ts 同模式，便于 vitest 覆盖。
- 热图组件不查询只渲染，level→颜色类必须用完整字面量数组（Tailwind v4 源码扫描，拼接类名会静默丢样式）；月份标注与主体列宽严格同构（GitHub 式溢出绘制）。
- 点击热图格子 emit `select-day`，页面层把范围切换为该日的自定义区间。

见 `app/src/statistics/chartMath.ts:17`（OPS_FIELDS、DONUT_OPS 29）、`app/components/statistics/ActivityHeatmap.vue:3`。

### 跨模块联动
- 来源应用 Top 行点击 → 写入 `filter.sourceApp` 并切剪贴板 Tab（复用主列表来源过滤条件）。
- 统计页挂节日引言横幅挂载点（`FestivalQuoteBanner`，七夕/除夕/春节/元宵/端午在 `QUOTE_BANNERS` 登记，受节日彩蛋开关控制）。

见 `app/components/statistics/StatsPage.vue:699`、`app/festival-eggs/points.ts`。

## 边界与限制

- 统计页不写库：只读 `daily_stat`，写入方为各模块 fire-and-forget 埋点（statsService 单例，统计失败不影响业务）。
- 使用时长（`usage_seconds`）口径为主窗口「可见且聚焦」时长，30s 结算一次（`startUsageTracking` 仅主窗口启动，停止时补结算最后一次）。
- 画像标签与称号按所选区间计算，切换范围即重算；「全部」范围同样受 15 天门槛约束。
- 「来源应用」依赖 `clipboard.source_app`（2026-09-20 起记录），旧数据无此列时该区块为空（不阻塞整页）。
- 趋势/热图在超长区间（>92 天）表现不同：趋势月聚合、热图横向滚动且未来日期格灰显禁用交互。
- 清空数据库会一并清空 daily_stat 与内存累加器（否则 pending 写回表现为「清不掉」的残留）。
- 节日引言横幅仅主窗口局部点缀，整窗换装只在灵动岛。

## 深读文档

- [数据库设计](../database.md)（`daily_stat` 全列定义与统计写入合并/性能约束 §14）
- [模块化架构](../architecture.md)（statistics 模块启停与 statsService 门面定位）
- [彩蛋说明](../easter-eggs.md)（统计页节日引言横幅挂载点与节日判定）
