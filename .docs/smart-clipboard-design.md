# 智能剪贴板（Smart Clipboard）设计文档

> 版本：v1.0（2026-09-13）
> 状态：**已实现**（2026-09-13，按 §8 里程碑 1-7 全部落地）
> 关联：v0.3.1 之后的下一个大特性（建议版本 0.4.0）

## 0. 实现状态（2026-09-13）

| 里程碑 | 内容 | 落点 |
|---|---|---|
| 1 存储 | clip_rules / clip_templates 迁移（version 17）+ 实体类型 + dbService CRUD | src-tauri/src/migrations.rs、app/src/entities.ts、app/src/db/dbService.ts |
| 2 规则引擎 | Segment / SmartClipMode / ProcessContext；parseByRule（separator/regex + 降级 + 零宽防护）；processContent 管道；内存 store；smart-clip:copy 事件接线 | app/src/smart-clip/{types,ruleEngine,smartClip}.ts、dbService 广播、app.vue 监听挂载 |
| 3 AI 通道 | ai.rs（AIProvider：openai-compat + anthropic 原生；enum 静态分派）；ai_test_connection / ai_complete；设置页 provider/base_url/model/测试连接 | src-tauri/src/ai.rs、Cargo.toml（reqwest rustls + serde_json）、SettingMain.vue |
| 4 模板渲染 | {content}/{segN}/{date}/{time} + {ai:指令} 异步占位符；渲染降级回退 | app/src/smart-clip/{template,aiClient}.ts |
| 5 气泡窗口 | bubble.vue（列表/钉住双模式）；BubbleToggleCommand（Ctrl+B 全局，ready 握手）；capabilities clipboard-bubble-*；pasteContentToActiveApp 复用 | app/pages/bubble.vue、BubbleToggleCommand.ts、InitShortcuts.ts、capabilities |
| 6 开放 API | open_api.rs（std TCP 手写 HTTP + SSE，仅 127.0.0.1，token 可选，心跳线程）；openApi.ts 前端客户端；smartClip 广播接入 | src-tauri/src/open_api.rs、app/src/smart-clip/openApi.ts |
| 7 收尾 | 设计文档状态 / CHANGELOG / README | 本文件、CHANGELOG.md、README* |

## 1. 背景与目标

在现有剪贴板工具（采集 / 搜索 / 粘贴）之上叠加"智能处理"能力：复制的内容不再只是原样存取，而是经过**可配置的解析管道**（规则拆分 / AI 加工 / 模板重组）变成结构化片段，供气泡窗口快捷粘贴，并通过本地开放 API 把事件暴露给外部窗口（弹窗、灵动岛）。

**核心需求映射**：

| 需求 | 对应模块 |
|---|---|
| ① AI 驱动模式（主流 AI API 格式 + 连接测试） | AI 引擎（§4.2）+ 设置页 API 分组（§5） |
| ② 非 AI 驱动模式（自定义 clip 分词与复制规则） | 规则引擎（§4.1） |
| ③ 内容解析与快捷粘贴（快捷键唤出多个独立气泡窗口） | 处理管道 + 气泡窗口（§4.4） |
| ④ 自定义模板与规则 | 模板渲染（§4.3）+ 规则/模板管理（§5） |
| ⑤ 开放 API（外部弹窗/灵动岛，仅复制成功提示场景） | 开放 API（§4.5） |

**设计原则**：处理管道各环节（解析器、AI 提供商、渲染器、事件）全部接口化，新增一种规则类型 / AI 协议 / 事件类型不改既有代码。

## 2. 总体架构

```
                    ┌─────────────── 处理层 ProcessingLayer ───────────────┐
复制监听(已有) ──► │ RuleEngine(非AI拆分) ─► TemplateRenderer ─► AIEngine │ ──► Segment[]
                    └──────────────────────────────────────────────────────┘
                                   │                          │
                        ┌──────────▼──────────┐    ┌──────────▼─────────────┐
                        │ 气泡窗口 BubbleWindow │    │ 开放 API (Rust HTTP/SSE)│──► 外部弹窗/灵动岛
                        │ 快捷键唤出·选择粘贴   │    │ 仅复制成功事件推送       │
                        └─────────────────────┘    └────────────────────────┘
```

- **Segment 统一数据结构**：`{ index, text, source: 'rule' | 'ai' | 'template', meta? }`——所有消费者（气泡、开放 API、未来功能）只依赖它
- **处理模式三档**（`smart_clip_mode`）：`off`（关闭）/ `rule`（纯规则）/ `ai`（规则 + AI 加工），设置页一键切换

## 3. 数据模型（migrations.rs 追加迁移）

```sql
CREATE TABLE clip_rules (
    id          TEXT PRIMARY KEY,          -- uuid
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('separator', 'regex')),
    pattern     TEXT NOT NULL,             -- 分隔符字符串或正则表达式
    priority    INTEGER NOT NULL DEFAULT 0,-- 越大越先
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE clip_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    body        TEXT NOT NULL,             -- 含 {content} {seg0} {date} {ai:指令} 占位符
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);
```

settings KV 新增键：

| 键 | 说明 | 默认值 |
|---|---|---|
| `smart_clip_mode` | 处理模式 off / rule / ai | `off` |
| `smart_default_rule_id` | 默认规则 | 空 |
| `smart_default_template_id` | 默认模板 | 空 |
| `smart_bubble_hotkey` | 气泡唤出快捷键 | `Ctrl+B` |
| `open_api_enabled` | 开放 API 开关 | `0` |
| `open_api_port` | 监听端口 | `12935` |
| `open_api_token` | 可选鉴权 token | 空 |
| `ai_provider` | AI 提供商：`openai-compat` / `anthropic` | `openai-compat` |
| `ai_base_url` | AI API 地址 | `https://api.openai.com/v1` |
| `ai_model` | 模型名 | `gpt-4o-mini` |
| `ai_api_key` | 沿用现有 `api_key` 键 | 空 |

## 4. 模块详细设计

### 4.1 规则引擎（`app/src/smart-clip/ruleEngine.ts`，纯 TS 可单测）

```ts
interface Segment { index: number; text: string; source: 'rule' | 'ai' | 'template' }

parseByRules(content: string, rules: ClipRule[]): Segment[]
processContent(content: string): Promise<Segment[]>   // 按 smart_clip_mode 分派的统一入口
```

- `separator`：按字符串分隔（去空段、trim 可配置）
- `regex`：按正则捕获组提取（捕获组 1..n 各成一段；无捕获组则整匹配成一段）
- 解析失败 / 无匹配 → **降级返回 `[content]` 单段（永不丢内容）**
- 快速连续复制：解析防抖 300ms + 内存 store（最近 N 条）去重

### 4.2 AI 引擎（Rust 侧，`src-tauri/src/ai.rs`）

```rust
#[tauri::command] async fn ai_test_connection(cfg: AiConfig) -> Result<TestResult, String>
#[tauri::command] async fn ai_complete(cfg: AiConfig, system: String, content: String) -> Result<String, String>
```

- reqwest 调用，超时 15s；`AIProvider` trait 抽象提供商，内置两个实现：

**提供商 ①：`openai-compat`（默认）**

- POST `{base_url}/chat/completions`，Header `Authorization: Bearer <key>`
- Body：`{ model, messages: [{role:'system'},{role:'user'}], max_tokens }`
- 解析：`choices[0].message.content`
- 适用于 OpenAI / DeepSeek / 通义 / Kimi / Ollama 等一切兼容端点

**提供商 ②：`anthropic`（Anthropic 原生 Messages API）**

- POST `{base_url}/v1/messages`，Header `x-api-key: <key>` + `anthropic-version: 2023-06-01`
- Body：`{ model, max_tokens(必填), system, messages: [{role:'user', content}] }`——system 是**顶层字段**而非 message
- 解析：`content[0].text`（取 type==='text' 的块拼接）
- base_url 默认 `https://api.anthropic.com`
- 连接测试同样用 `max_tokens=1` 最小请求

- **连接测试**：统一返回 `{ok, latency_ms, error?}`（各提供商差异封装在 trait 实现内）
- **前端不直接 fetch AI**：CSP 的 connect-src 无需放宽、API Key 不暴露给 WebView
- AI 分支的 system prompt 来自模板 `{ai:指令}`；无模板时默认指令："将内容整理为结构化片段，逐行输出"
- **扩展方式**：新增提供商 = 实现 `AIProvider` trait（`complete()` + `test()`）+ 枚举注册，不改调用方

### 4.3 模板渲染（`app/src/smart-clip/template.ts`）

| 占位符 | 含义 |
|---|---|
| `{content}` | 原始复制内容 |
| `{segN}` | 第 N 段（N 从 0 开始） |
| `{date}` / `{time}` | 当前日期 / 时间 |
| `{ai:指令}` | 将 content 送 AI 按"指令"加工，结果替换占位符 |

渲染输出仍是 `Segment[]`，与气泡窗口解耦。

### 4.4 气泡窗口（`app/pages/bubble.vue` + capabilities 通配 `clipboard-bubble-*`）

- 全局快捷键 `Ctrl+B`（可录制）：新增 `BubbleToggleCommand`（命令体系内注册，可在设置页改键）
- **主气泡**：列出当前 `Segment[]`；`↑↓` 选择、`Enter` 粘贴（复用 `pasteContentToActiveApp`）、`Esc` 关闭
- **钉住**：任意片段可"钉出"为独立小气泡窗（每片段一个 `clipboard-bubble-<n>` 窗口：置顶、可拖动、点击即粘贴）——对应"多个独立气泡窗口"
- 新复制到达时：已开启的气泡实时刷新内容（事件监听）
- 窗口定位：主气泡出现在鼠标附近（复用 usePopupPosition 思路）

### 4.5 开放 API（Rust 侧 `src-tauri/src/open_api.rs`，tiny_http 轻量实现）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | `{ok, version, port}` |
| `/api/events` | GET | **SSE** 流式推送（`event: copy`，data: JSON） |
| `/api/notify/copy` | POST | 外部主动注入复制事件（可选 token） |

- **仅绑定 127.0.0.1**；端口默认 12935，占用自动 +1，实际端口写回 KV 供外部发现
- 可选 `open_api_token`：SSE 连接与 POST 均校验 `Authorization: Bearer <token>`
- 事件接入点：dbService 复制入库成功后广播 `copy` 事件（payload：content + 解析后 segments + ts）
- **仅复制成功提示场景调用**（需求边界）；事件总线抽象，未来可加 paste / rule-matched 等事件
- 生命周期：随 app 启动（enabled=true 时）；设置切换实时启停

## 5. UI 变更（设置页 SettingMain.vue）

- **「API 设置」分组**（已有，type: ai_setting）：
  - API Key（已有）
  - Base URL 输入（新增）
  - Model 输入（新增）
  - **「测试连接」按钮**（新增 action 类型 item，结果展示 `{ok, latency}`，toast 反馈）
- **新增「智能剪贴板」分组**：
  - 处理模式三档切换（关闭 / 规则 / AI）
  - 规则列表 CRUD（拖拽排序 = 优先级）
  - 模板列表 CRUD
  - 气泡快捷键录制（复用 ShortcutRow 组件）
  - 开放 API：开关 / 端口 / token

## 6. 快捷键汇总

| 快捷键 | 默认 | 说明 |
|---|---|---|
| `Ctrl+B`（可录制） | 气泡主窗 | 唤出/关闭解析片段气泡 |
| 片段钉住 | 点击 | 每片段独立小气泡窗口 |

## 7. i18n

所有新文案进 `assets/lang/zh-cn.toml` / `en-us.toml`，命名空间 `smart.*` / `bubble.*` / `openapi.*`，键 snake_case（与既有规范一致）。

## 8. 实施里程碑（7 步，每步独立可验证）

1. **存储**：两表迁移 + settings 键 + i18n 键
2. **规则引擎**：`smart-clip/` 模块 + `processContent` 管道骨架（off / rule 生效）
3. **AI 通道**：Rust `ai.rs` 两个 command + 设置 UI + 测试连接
4. **模板渲染**：占位符解析 + `{ai:}` 分支
5. **气泡窗口**：页面 + capabilities + 快捷键命令 + 选择 / 钉住 / 粘贴交互
6. **开放 API**：HTTP/SSE 服务 + 复制事件接入 + 设置项
7. **收尾**：README / CHANGELOG / 全量回归

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 快速连续复制导致重复解析 | 解析防抖 300ms + 内存 store 去重 |
| HTTP 端口被占用 | 自动 +1 重试，实际端口写回 KV |
| AI API 各家差异 | 仅承诺 OpenAI 兼容；Provider trait 预留扩展 |
| SSE 连接泄漏（外部异常退出） | 心跳 15s + 断开自动清理 |

