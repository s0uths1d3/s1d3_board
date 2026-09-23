## Unreleased（模块化重构）

> 行为与 0.4.0 完全一致的架构重构；架构文档见 `.docs/architecture.md`。

### ✨ 新功能（统计界面升级）

- **数据故事卡**：统计区间转叙事句（操作总量/字量 A4 换算/主力功能/粘贴复用率/峰值日/时长电影换算），金色数字高亮；个性化洞察规则库（深夜/早起/复用/待办完成率等 11 条）按日期种子每日轮换取 2 条；环比上一等长区间增长徽章（正增长金色脉冲）
- **图表增强**：趋势图新增柱状/折线双视图切换（折线为 SVG 面积图 + 峰值点 + 逐点 hover）；Tab 访问分布新增甜甜圈图（分段 hover 与列表行双向联动，中心显示占比）；指标卡入场级联动画 + 趋势柱条自底部升起动画
- **纯函数模块**：`src/statistics/story.ts`（故事事实/洞察规则/每日轮换），i18n 双语全覆盖，新增 vitest 13 个（总计 121 全绿）

### ♻️ 重构（前端）

- **core 层**：新增 `core/events.ts` 类型化事件总线（模块间通信唯一通道）、`core/registry.ts` 模块注册表（拓扑排序启动、反向序收尾、单模块故障隔离）、`core/context.ts` 模块能力抽象、`core/db/` 连接层（PRAGMA + execWithRetry）与 9 个领域仓储
- **插件化模块**：7 个功能域模块（settings / smart-clip / clipboard / island / statistics / todo-reminder / shortcuts）经 `ModuleRegistry` 统一注册，`app.vue` 改为 `registry.boot()` 引导；依赖声明化（smart-clip 先于 clipboard 的启动硬约束固化进拓扑序）
- **门面兼容**：`dbService` / `statsService` 公共 API 不变，内部委托仓储；剪贴板监听管道平移至 `clipboard/clipboardListener.ts`（单例装配，防双计语义保留）
- **测试基建**：vitest + happy-dom 全量单测 108 个（仓储 / 注册表 / 事件 / 连接 / 启动顺序）

### ♻️ 重构（Rust）

- **依赖抽象**：`core/traits.rs` 三抽象——`ImageStore`（图片文件存取）/ `ForegroundSource`（前台查询）/ `IslandSink`（岛事件出站），`lib.rs` setup 装配 managed state 注入，命令层只依赖接口（State 不进 invoke 载荷，前端签名不变）
- **目录分域**（对齐前端 core/ + 域目录 + 装配根）：`core/`（events + traits）、`clipboard/`（image_store + thumb）、`island/`（api + webhook）、`ai/`（engine）、`db/`（migrations）；命令域 `commands/{paste,menu,lifecycle}`，事件名常量集中 `core/events.rs`
- **实现改造**：image_store 核心逻辑抽目录级函数 + `FsImageStore`；app_usage 平台前台源；island/api 出站桥改 `Arc<dyn IslandSink>` 捕获
- **测试**：`cargo test` 42+9 全绿——图片消毒/穿越/回环/超限、qrcode QR 扫描回环、CF_DIB 解析、迁移链不变式、Webhook URL 白名单等

### ⬆️ 依赖升级

- **Tailwind CSS 3.4 → 4.3**：CSS-first 迁移——`@import "tailwindcss"` + `@theme inline` 令牌取代 `tailwind.config.js`（16 色令牌指向运行时 CSS 变量，透明度修饰符走 color-mix，与 v3 rgb alpha 数学等价；v4 不支持 v3 的 `<alpha-value>` 占位符，残留会导致颜色整体失效）；`@nuxtjs/tailwindcss` 模块（仅支持 v3）替换为 `@tailwindcss/vite` 插件；类名跟随 v4 重命名：`shadow-sm→shadow-xs`、`outline-none→outline-hidden`、`rounded-sm→rounded-xs`、`blur-sm→blur-xs`；补回 v4 preflight 移除的 `button/[role=button]` 手型光标
- 小版本直升：vue 3.5.43 / vue-router 5.3.1 / @tauri-apps/* / plugin-sql 2.4.1 / plugin-notification 2.4.0 / plugin-opener 2.5.5 / uuid 14.0.2 / @types/node 26.6.2；npm 插件包升级后同步 `cargo update` 刷新 Cargo.lock，使 Rust crate 与 npm 包 major/minor 对齐（notification 2.4.0 / opener 2.5.5 / sql 2.4.1，Tauri 启动时校验两侧版本一致性）；typescript 保持 5.8（latest 7.0.2 为主版本跨越，待 vue-tsc 生态跟进）

## 0.4.0 (2026-09-21)

本次更新带来两大全新模块——**智能剪贴板**（提取器分词、方案重组与 AI 分析）与**灵动岛**（屏幕顶部胶囊式反馈 + 开放 API / Webhook），为 AI 能力引入自定义提供商与流式响应，并将各窗口的操作反馈统一收敛到灵动岛。

### ✨ 新功能

- **全新「智能剪贴板」模块**
  - 「提取器 + 方案」两级模型：分隔符 / 正则提取器（捕获组各成一段）负责分词，方案模板（`{content}` / `{segN}` / `{date}` / `{time}` 占位符 + `{ai:指令}` 实时 AI 加工）负责重组
  - AI 辅助新建提取器与专属方案：粘贴示例内容自动归纳规则
  - 处理简化为单一开关（关闭 / 开启），方案为开启态之上的叠加层；解析永不丢内容（方案零产出、失败时降级智能切分或原文）
  - 本地切分增强：路径按层级拆分、简单词串直拆、超长内容（>1000 字）按句读分块兜底
  - 复制入库即本地预判打标（零 AI 成本）：过短、结构化、代码 / JSON / SQL 等技术内容一律本地处理，不送 AI
- **AI 分析与提供商体系**
  - `Ctrl+B` 唤出**环形气泡窗**：选中剪贴项本地切分先上环，AI 补充关键词与一句话总结（单次调用双产出），新增片段即时补上环
  - 方向键空间导航（含跨行折转）+ `PgUp`/`PgDn` 翻页；环心控制盘展示原文预览；任意片段可钉住为独立置顶小气泡
  - 习惯画像：本地采集使用习惯，仅以确定性统计摘要辅助分析，原文不出域
  - 提供商：OpenAI 兼容 / Anthropic 原生 / **自定义 JSON**（一份 JSON 描述任意 HTTP 接口的请求与响应映射），支持 SSE 流式响应
  - 结果冷却缓存 + 请求飞行中去重（连按 `Ctrl+B` 不重复消耗 token）；失败结果不缓存，失败原因可读化
- **全新「灵动岛」**：屏幕顶部胶囊式反馈
  - 全局复制 / 粘贴 / 剪切感知：任意应用内 `Ctrl+C` / `Ctrl+V` / `Ctrl+X` 弹对应胶囊（剪切需窗口内真实变化才提示，不误报）
  - 图片缩略图悬停放大预览；重复提示 ×N 计数徽标与新提示金环脉冲
  - 「解析中」过程岛（loading / 驻留），解析完成平滑替换为结果岛
  - 灵动岛历史窗口：记录 / 日期筛选 / 流式渲染 / 一键复制 / CSV·TXT 导出
  - 各窗口 toast 反馈统一迁移至灵动岛（便签、待办、常用剪贴、设置页、提醒等），跟随灵动岛总开关
- **灵动岛开放 API 与 Webhook**
  - 入站：仅回环 `127.0.0.1` 的 HTTP 端点（端口可配、可选 Bearer token），第三方 `POST /api/island/show` 推送自定义提示、`GET /api/history` 查询岛历史
  - 出站：SSE 事件流实时订阅应用内所有岛事件；Webhook 出站推送（HMAC 签名 + 事件白名单 + 失败重试）
  - 设置页独立配置卡片，API key 默认掩码显示，连接测试按时延分档着色
- **其他**
  - 统计新增「AI 分析」与「剪切」指标卡及合并趋势
  - 剪贴条目记录**来源应用**（复制瞬间的前台进程名），列表卡片与悬停预览展示
  - 全局粘贴（含应用外 `Ctrl+V`）按内容计入使用次数
  - 待办提醒新增「系统通知」独立开关：关闭后不再弹 OS 通知，仍保留提示音与灵动岛提醒
  - 鼠标侧键（后退 / 前进）切换标签页，与 `Ctrl+←`/`Ctrl+→` 行为一致
  - 常用剪贴板支持单条删除（确认框防误删）
  - 导航激活状态持久化，重启恢复上次所在模块
  - 应用时长页切入立即拉取最新增量，消除 30 秒数据滞后

### 🐛 修复

- 修复粘贴使用次数双计（命令层显式计数与剪贴板监听 bump 各计一次，一次粘贴 +2）
- 浮层面板（下拉 / 日期选择 / 右键菜单 / 删除确认框）空间不足时钳制高度并内部滚动，不再被窗口边缘裁切
- 数据库启用 WAL 模式缓解并发写锁，启动执行 `quick_check` 完整性自检；提醒规则列名归一
- 灵动岛窗口单例复用、创建串行化、生命周期独立于主窗口，修复并发通知静默丢失与失效引用
- `Ctrl+B` 改为局部快捷键；修复「上次位置」弹出位置越界导致 `Ctrl+I` 无法唤出窗口
- 悬停 tooltip 显示时重挂 topmost，避免复用时被主窗口遮挡
- v-tip 焦点提示仅限键盘导航触发，按下立即隐藏
- 历史英文种子分类 / 优先级名按当前语言显示；无 `navigator` 环境默认语言由中文改为英文
- 最小化窗口跳过 webview 级聚焦，消除 HRESULT(0x80070057) 错误日志
- 托盘图标按固定 id 复用，修复 reload 后图标累积；开发模式禁用开机自启并清理残留注册
- AI 收到 2xx 非 JSON 响应时附响应片段，便于定位服务端错误；修复环盘内容串台与空指针崩溃
- 数据库写锁竞争退避重试（`busy_timeout` + `execWithRetry`），修复多窗口并发写报 "database is locked"(517)
- 冷启动按所在显示器居中主窗口；`datetime` 时间面板选完日期保持展开、时/分下拉滚动到当前选中项
- 收藏后即时同步本地行数据（星标 / 金边 / 徽标即时切换），并加强收藏态金色高亮

### ♻️ 重构与优化

- 智能剪贴板概念收敛：预设 → 提取器、模板 → 方案，设置页重设计
- AI 提示词前缀缓存优化：偏好摘要等动态内容移出 system 消息，保住 provider 前缀缓存，降低 token 成本
- 图片岛显示加速：Rust 侧从剪贴板位图直出高 384px 缩略图（岛 UI 渲染缩略图，出站事件仍发原图）
- 灵动岛总开关语义收敛为「只关显示」：历史落库、统计与 SSE / Webhook 出站推送不受影响
- 中英双语文案多轮同步补漏（处理开关 / 统计指标 / 剪切岛 / Webhook 配置 / 统计标签名等）

### 📚 文档

- 新增 `.docs/island-api.md`：灵动岛开放 API 完整文档（入站命令 / SSE 出站 / Webhook / 历史查询 / 场景配方 / 错误码）
- 新增 `.docs/smart-clip-ai-analysis.md`：AI 分析分流策略说明
- 新增 `.docs/ai-custom-config.md`：自定义 AI 提供商 JSON 配置指南
- README 同步 0.4.0 新模块说明

---

变更范围：`v0.3.1` → `0.4.0`，共 92 次提交、89 个文件
