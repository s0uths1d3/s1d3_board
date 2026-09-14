# 灵动岛 API（Island API）接入文档

> 版本：**v1.0.0** · 状态：**正式（Stable）**
> 适用：S1d3 Board ≥ v0.4.0
> 更新日志见 [§11](#11-版本控制与更新日志)。

第三方应用通过本 API 在 S1d3 Board 的灵动岛（屏幕顶部胶囊提示）中显示自定义内容——无需修改本项目代码，只需向本机回环地址发送 HTTP 请求。适用于构建完成提醒、下载进度、消息通知、播放状态等任意第三方场景。

---

## 目录

- [1. API 整体架构说明](#1-api-整体架构说明)
- [2. 快速开始](#2-快速开始)
- [3. API 接口定义](#3-api-接口定义)
- [4. 请求 / 响应格式](#4-请求--响应格式)
- [5. 参数说明](#5-参数说明)
- [6. 认证与授权机制](#6-认证与授权机制)
- [7. 错误处理机制](#7-错误处理机制)
- [8. 可定制功能说明](#8-可定制功能说明)
- [9. 示例代码](#9-示例代码)
- [10. 场景指南与故障排查](#10-场景指南与故障排查)
- [11. 版本控制与更新日志](#11-版本控制与更新日志)

---

## 1. API 整体架构说明

### 1.1 系统组件关系

```
┌────────────────────────────── S1d3 Board（本机） ──────────────────────────────┐
│                                                                                │
│  ┌────────────────────────┐        ┌─────────────────────────────────────────┐ │
│  │ 灵动岛 API 服务 (Rust)  │        │  前端灵动岛管理器 (useCopyIsland.ts)      │ │
│  │ island_api.rs          │        │                                         │ │
│  │                        │ emit   │  ┌───────────────────────────────────┐  │ │
│  │ HTTP/SSE (std 实现)     │───────►│  │ 灵动岛窗口 clipboard-bubble-island │  │ │
│  │ 仅绑定 127.0.0.1:{port} │ island-│  │ bubble.vue?mode=island            │  │ │
│  │                        │ api:show  │ 顶部胶囊 + 悬停展开面板(行号)        │  │ │
│  └───────────┬────────────┘        │  └───────────────────────────────────┘  │ │
│              │ SSE 广播             └─────────────────────────────────────────┘ │
└──────────────┼────────────────────────────────────────────────────────────────────┘
               │
   ┌───────────┴────────────┐
   │  第三方应用（任意进程）    │
   │  A: POST /api/island/show（弹岛）      │
   │  B: GET  /api/events（SSE 订阅事件流）  │
   └────────────────────────┘
```

### 1.2 模块功能划分

| 模块 | 文件 | 职责 |
|---|---|---|
| API 服务（Rust） | `src-tauri/src/island_api.rs` | 监听回环地址、路由、参数校验、token 鉴权、事件广播 |
| TS 客户端 | `app/src/island/islandApi.ts` | 应用内设置变更时启停服务（`island_api_apply` 命令） |
| 岛管理器 | `app/composables/useCopyIsland.ts` | 消费 `island-api:show` 事件、按延迟/时长策略弹岛 |
| 岛窗口 | `app/pages/bubble.vue`（island 模式） | 胶囊渲染、图标/标题/行号面板、动画与自动隐藏 |
| 设置界面 | `app/components/setting/SettingMain.vue` | 开关、端口、token 配置（通用设置 → 灵动岛 API） |

### 1.3 核心交互流程

```
第三方应用                  API 服务 (Rust)                岛管理器 (前端)
    │                            │                            │
    │  POST /api/island/show     │                            │
    │  {text,kind,title,duration}│                            │
    │───────────────────────────►│                            │
    │                            │ 校验（JSON/text/kind）        │
    │                            │─── emit('island-api:show') ─►│
    │                            │                            │ 按出现延迟排队
    │  204 No Content            │                            │ 弹出胶囊（duration 生效）
    │◄───────────────────────────│                            │
    │                            │                            │
    │  GET /api/events（SSE 长连接）                             │
    │───────────────────────────►│                            │
    │  event: island.show        │  （每次 POST 成功后广播       │
    │  data: {...}               │    同一事件给所有订阅者）      │
    │◄───────────────────────────│                            │
```

**数据传递机制**：

1. **弹岛主链路**：第三方 POST → Rust 校验 → Tauri 事件 `island-api:show`（结构化 payload）→ 前端岛管理器 → 岛窗口动画显示。POST 请求在事件投递后即返回 `204`，不等待动画结束。
2. **SSE 广播链路**：每次校验通过的显示请求会同时广播给所有 `/api/events` 订阅者，第三方可据此做联动（如记录日志、聚合统计）。
3. **依赖关系**：API 服务依赖设置页的开关/端口/token 配置（KV：`island_api_enabled` / `island_api_port` / `island_api_token`）；岛窗口行为受应用内设置（出现延迟 `island_delay_ms`、默认停留时长 `island_duration_ms`）影响。

---

## 2. 快速开始

1. 在 S1d3 Board 中打开 **设置 → 通用 → 灵动岛 API**，启用开关（默认关闭）。
2. 记下端口（默认 `12935`）；如需鉴权，填入自定义 token。
3. 验证服务是否在线：

```bash
curl http://127.0.0.1:12935/api/health
```

```json
{ "ok": true, "data": { "version": "1.0.0", "port": 12935 } }
```

4. 弹出你的第一条灵动岛提示：

```bash
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -d '{"text": "构建完成", "kind": "success", "title": "MyApp"}'
```

返回 `204 No Content`，屏幕顶部即出现灵动岛胶囊。

---

## 3. API 接口定义

| 接口名称 | 方法 | 路径 | 功能描述 | 版本 | 状态 |
|---|---|---|---|---|---|
| 健康检查 | `GET` | `/api/health` | 探测服务是否可用，返回 API 版本与实际监听端口 | v1.0.0 | 正式 |
| 显示灵动岛 | `POST` | `/api/island/show` | 提交一条灵动岛显示请求（文本 / 类型 / 标题 / 停留时长） | v1.0.0 | 正式 |
| 订阅事件流 | `GET` | `/api/events` | SSE 长连接，实时接收所有灵动岛显示事件（`island.show`） | v1.0.0 | 正式 |

> 本版本无 `PUT` / `DELETE` 接口；对已知路径使用错误方法返回 `405`（见 [§7](#7-错误处理机制)）。

---

## 4. 请求 / 响应格式

### 4.1 标准请求头

| 请求头 | 必填 | 说明 |
|---|---|---|
| `Content-Type: application/json` | POST 必填 | 请求体为 UTF-8 JSON（服务端按 JSON 解析，未设置时无法保证解析成功） |
| `Authorization: Bearer {token}` | 条件必填 | 仅当用户在设置页配置了非空 token 时必填，所有接口均校验（见 §6） |

### 4.2 响应体结构

统一 JSON 信封（SSE 除外）：

```jsonc
// 成功（health 示例）
{ "ok": true, "data": { ... } }

// 失败
{ "ok": false, "error": { "code": "invalid_kind", "message": "field 'kind' must be one of: info, success, error, copy, paste" } }
```

各接口的成功响应：

| 接口 | 状态码 | 响应体 |
|---|---|---|
| `GET /api/health` | `200 OK` | `{"ok":true,"data":{"version":"1.0.0","port":12935}}` |
| `POST /api/island/show` | `204 No Content` | **空响应体** |
| `GET /api/events` | `200 OK` | `text/event-stream`（SSE 流，见 4.3） |

### 4.3 SSE 事件格式（`GET /api/events`）

响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。

每个显示事件：

```
event: island.show
data: {"text":"构建完成","kind":"success","title":"MyApp","duration":3000,"ts":1726300000000}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 显示文本（服务端已校验非空） |
| `kind` | string | 归一化后的类型（未传或为空时为 `"info"`） |
| `title` | string \| null | 自定义标题（未传或空白时为 `null`；服务端已截断到 24 字符） |
| `duration` | number | 请求的停留时长（毫秒）；`0` 表示使用应用内默认停留时长 |
| `ts` | number | 事件产生时间戳（Unix 毫秒） |

**心跳**：空闲时每 **15 秒**下发一条 SSE 注释帧 `: ping`，用于保活与断连探测；客户端应按 SSE 规范忽略注释帧。

---

## 5. 参数说明

### 5.1 `POST /api/island/show` 请求体字段

| 参数 | 类型 | 必填 | 默认值 | 取值范围 | 描述 |
|---|---|---|---|---|---|
| `text` | string | **是** | — | 非空；≤ **2000** 字符（按 Unicode 字符计数） | 显示的文本内容。保留换行符，悬停展开面板按行渲染并显示行号；胶囊单行预览最多展示前 **120** 字符 |
| `kind` | string | 否 | `"info"` | `info` / `success` / `error` / `copy` / `paste` | 类型决定胶囊图标与默认标签：ℹ️ 信息 / ✓ 成功 / ✕ 错误 / 📋 已复制 / 📥 已粘贴。空字符串按未传处理 |
| `title` | string | 否 | `null` | ≤ 24 字符 | 自定义标题（显示在胶囊前部标签位）。**宽容策略**：首尾空白被 trim；空白字符串视为未传；超过 24 字符服务端**静默截断**，不报错 |
| `duration` | number | 否 | `0` | 毫秒值（整数） | 本次显示的停留时长。`0` 或不传 = 使用应用内默认（设置页「灵动岛停留时长」，默认 1800ms）；`>0` 时单次覆盖，前端钳制到 **600–60000ms**（超出边界取边界值，不报错） |
| `priority` | string | 否 | — | — | **v1 预留字段**：接收但不处理，向前兼容 v1.x（见 §11） |

**特殊格式要求**：

- `text` 为空字符串 → `400 empty_text`；超过 2000 字符 → `422 text_too_long`（不做静默截断，请调用方自行分片）。
- `kind` 传入非法值 → `422 invalid_kind`（不做静默降级）。
- `duration` 传入负数或非整数将导致 JSON 反序列化失败 → `400 invalid_json`。

### 5.2 `GET /api/health` 参数

无请求参数、无请求体。

### 5.3 `GET /api/events` 参数

无查询参数（查询串会被忽略）。鉴权要求与其他接口一致（见 §6）。

---

## 6. 认证与授权机制

### 6.1 认证方式

**Bearer Token（可选）**。是否启用由用户决定：设置页「灵动岛 API」卡片中的 token 输入框**留空 = 不鉴权**（默认），填入非空值 = 所有接口强制校验。

```
Authorization: Bearer <你的token>
```

### 6.2 令牌获取

token 由**用户在设置页自行定义**（任意字符串），仅保存在本机数据库（KV `island_api_token`），不存在服务端下发或注册流程。第三方开发者应向用户索取 token（如同索取 API Key）。

### 6.3 令牌刷新

无自动刷新机制——token 为静态值，更换即用户在设置页修改后立即生效（服务随配置变更自动重启）。客户端应将 `401` 视为「token 配置不一致」，提示用户检查两侧配置是否相同。

### 6.4 安全策略

| 策略 | 实现 |
|---|---|
| 仅本机访问 | 服务**只绑定 `127.0.0.1`**，局域网/外网无法连接 |
| 传输安全 | 明文 HTTP（仅回环，不出网卡，无中间人风险）；未提供 TLS |
| 跨域 | 未返回 CORS 头：浏览器页面无法跨域调用本 API（防网页探测）；Node/Electron/Python 等非浏览器环境不受影响 |
| 请求头上限 | 8 KB，超限断开连接 |
| 订阅者隔离 | SSE 订阅者互相不可见，断开的订阅者自动清理 |
| 明文比对 | token 以明文形式比较（本机场景可接受），配置了 token 后**每个接口**（含 health、events）都要携带 |

> 注意：配置 token 后，浏览器原生 `EventSource` 无法自定义请求头，请改用支持自定义 header 的 SSE 客户端（见 §9 示例）。

---

## 7. 错误处理机制

### 7.1 统一错误响应格式

```json
{ "ok": false, "error": { "code": "错误码", "message": "英文错误描述" } }
```

### 7.2 错误码体系

**系统级错误**（请求根本没到业务逻辑）：

| HTTP 状态码 | code | 触发条件 | 解决方案 |
|---|---|---|---|
| `401 Unauthorized` | `unauthorized` | 用户配置了 token，但请求缺失或 `Authorization: Bearer` 值不匹配 | 核对设置页 token 与请求头是否完全一致 |
| `404 Not Found` | `not_found` | 路径不存在 | 核对路径拼写；确认端口正确（可通过 health 探测） |
| `405 Method Not Allowed` | `method_not_allowed` | 对已知路径使用了错误方法（如 `GET /api/island/show`） | 改用 §3 表格中的正确方法 |

**业务级错误**（`POST /api/island/show` 参数校验）：

| HTTP 状态码 | code | 触发条件 | 解决方案 |
|---|---|---|---|
| `400 Bad Request` | `invalid_json` | 请求体不是合法 JSON | 检查 JSON 语法（尾逗号、未转义引号、编码） |
| `400 Bad Request` | `empty_text` | `text` 缺失或为空字符串 | 传入非空 `text` |
| `422 Unprocessable Entity` | `text_too_long` | `text` 超过 2000 字符 | 自行截断或分多次推送 |
| `422 Unprocessable Entity` | `invalid_kind` | `kind` 不在合法枚举内 | 使用 `info`/`success`/`error`/`copy`/`paste` 之一 |

**服务端内部错误**：

| HTTP 状态码 | code | 触发条件 | 解决方案 |
|---|---|---|---|
| `500 Internal Server Error` | `internal_error` | 事件序列化失败（极罕见） | 重试；持续出现请查看应用日志 |

### 7.3 连接层异常排查

| 现象 | 可能原因 | 排查步骤 |
|---|---|---|
| `ECONNREFUSED` / 连接拒绝 | API 未启用；应用未运行；端口不对 | ① 设置页确认开关已开 ② `GET /api/health` 试探 ③ 核对端口 |
| 端口启用失败 | 端口被其他进程占用 | 应用日志出现 `端口 {port} 绑定失败`；换一个端口保存（服务自动重启） |
| 请求无响应 | 超大请求头（>8KB） | 精简请求头 |
| SSE 收不到事件 | token 不匹配（`/api/events` 同样鉴权） | 核对 token；用支持自定义 header 的 SSE 客户端 |

---

## 8. 可定制功能说明

v1.0.0 的定制能力分为三层：**API 可控**（第三方调用方指定）、**应用内设置**（终端用户配置）、**版本预留**（v1 接收但不生效）。API 遵循「内容与语义可定制，视觉与动画跟随应用主题」的设计——保证所有第三方提示观感一致、不打扰用户。

### 8.1 定制能力矩阵

| 定制维度 | v1 能力 | 控制方 | 说明 |
|---|---|---|---|
| 图标与类型 | ✅ `kind` 字段 | API | `info`/`success`/`error`/`copy`/`paste` 五种图标与默认标签 |
| 标题 | ✅ `title` 字段 | API | 24 字符内自定义胶囊前部标签 |
| 内容文本 | ✅ `text` 字段 | API | 2000 字符内，多行保留换行 |
| 停留时长 | ✅ `duration` 字段 | API | 单次覆盖（600–60000ms 钳制） |
| 出现延迟 | 应用内设置 | 用户 | 「灵动岛出现延迟」（默认 0ms，0–10000ms） |
| 默认停留时长 | 应用内设置 | 用户 | 「灵动岛停留时长」（默认 1800ms，600–60000ms） |
| 展开/收起 | 内置交互 | — | 鼠标悬停胶囊展开面板（多行 + 行号 + 行数统计），移出/超时收起 |
| 优先级 | 🔖 `priority` 字段 | 预留 | v1 接收不处理；为后续「同类事件合并/抢占」预留 |
| 颜色/字体/布局/动画参数 | 🔖 版本预留 | 预留 | v1 不开放，跟随应用主题（见 8.2 说明） |

### 8.2 视觉与动画的行为约定（v1 内置，不可 API 覆盖）

| 项目 | 行为 |
|---|---|
| 位置 | 光标所在显示器顶部居中（距顶 12 逻辑像素） |
| 形态 | 深色胶囊（跟随应用主题 token），入场/退场平滑过渡 |
| 长文本 | 胶囊单行预览 120 字符；悬停展开面板逐行渲染（含行号），最多渲染 400 行并提示省略行数 |
| 连续事件 | 同屏只保留最后一次（出现延迟期间的连续事件以最后一次为准） |
| 显示规则 | 停留超时自动隐藏；鼠标靠近（32px 逻辑像素带内）暂停隐藏 |
| 关闭优先级 | 用户关闭「灵动岛提示」总开关后，**所有 API 请求不再弹岛**（SSE 广播照常） |

### 8.3 数据展示格式建议（`kind` 语义约定）

| kind | 语义 | 典型场景 |
|---|---|---|
| `info` | 中性信息（默认） | 一般状态播报、提示 |
| `success` | 成功结果 | 构建/下载/上传完成、保存成功 |
| `error` | 失败/异常 | 任务失败、连接断开 |
| `copy` | 复制动作 | 与剪贴板写入联动的工具 |
| `paste` | 粘贴动作 | 与粘贴流程联动的工具 |

多行内容建议用 `\n` 分隔（展开面板按行渲染并显示行号），每行不超过约 40 字符以保证面板宽度友好。

---

## 9. 示例代码

以下示例默认**未配置 token**；若已配置，请给每个请求加上 `Authorization: Bearer <token>` 头。

### 9.1 cURL（调试首选）

```bash
# 健康检查
curl http://127.0.0.1:12935/api/health

# 最简弹岛（仅必填字段）
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello Island"}'

# 完整参数
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -d '{"text": "构建完成，用时 42s", "kind": "success", "title": "CI", "duration": 3000}'

# 带 token
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret" \
  -d '{"text": "已同步 12 条记录"}'

# 订阅事件流（Ctrl+C 退出）
curl -N http://127.0.0.1:12935/api/events
```

### 9.2 JavaScript / TypeScript（Node 18+，内置 fetch）

```javascript
const BASE = 'http://127.0.0.1:12935';
// const TOKEN = 'my-secret'; // 用户在设置页配置了 token 时取消注释

function headers(extra = {}) {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}`, ...extra } : extra;
}

/** 健康检查：服务不可达 / 未启用时抛错 */
export async function health() {
  const res = await fetch(`${BASE}/api/health`, { headers: headers() });
  const body = await res.json();
  if (!res.ok || !body.ok) throw new Error(`[${body?.error?.code}] ${body?.error?.message}`);
  return body.data; // { version, port }
}

/**
 * 弹出灵动岛提示。
 * @param {object} opts
 * @param {string} opts.text     必填，≤2000 字符
 * @param {string} [opts.kind]   info | success | error | copy | paste
 * @param {string} [opts.title]  ≤24 字符，超长会被服务端截断
 * @param {number} [opts.duration] 毫秒，0=应用默认
 */
export async function showIsland({ text, kind = 'info', title, duration = 0 }) {
  const res = await fetch(`${BASE}/api/island/show`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text, kind, title, duration }),
  });
  if (res.status === 204) return true;
  const body = await res.json().catch(() => ({}));
  throw new Error(`[${body?.error?.code ?? res.status}] ${body?.error?.message ?? 'island show failed'}`);
}

/** SSE 订阅（支持自定义 header，兼容配置了 token 的场景；自动重连） */
export function subscribeIslandEvents(onEvent) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`${BASE}/api/events`, { headers: headers() });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const data = frame.split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6)).join('\n');
            if (data) onEvent(JSON.parse(data));
          }
        }
      } catch { await new Promise((r) => setTimeout(r, 3000)); } // 断线 3s 后重连
    }
  })();
  return () => { stopped = true; };
}

// 用法
await health();
await showIsland({ text: '下载完成 profile.zip（3.2 MB）', kind: 'success', title: 'Downloader', duration: 3000 });
subscribeIslandEvents((e) => console.log('island.show:', e));
```

### 9.3 Python（3.8+，requests）

```python
import json
import time
import requests

BASE = "http://127.0.0.1:12935"
# TOKEN = "my-secret"  # 用户配置了 token 时取消注释

def _headers():
    h = {}
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    return h

def health() -> dict:
    r = requests.get(f"{BASE}/api/health", headers=_headers(), timeout=3)
    body = r.json()
    if not r.ok or not body.get("ok"):
        err = body.get("error", {})
        raise RuntimeError(f"[{err.get('code', r.status_code)}] {err.get('message')}")
    return body["data"]  # {"version": "1.0.0", "port": 12935}

def show_island(text: str, kind: str = "info", title: str = None,
                duration: int = 0, retries: int = 1) -> None:
    """弹出灵动岛提示。text 非空且 ≤2000 字符；kind ∈ info/success/error/copy/paste。"""
    payload = {"text": text, "kind": kind, "duration": duration}
    if title:
        payload["title"] = title
    for attempt in range(retries + 1):
        r = requests.post(f"{BASE}/api/island/show", headers=_headers(),
                          json=payload, timeout=3)
        if r.status_code == 204:
            return
        body = r.json()
        err = body.get("error", {})
        # 连接层瞬时故障重试；业务错误（4xx）直接抛出
        if r.status_code >= 500 and attempt < retries:
            time.sleep(1)
            continue
        raise RuntimeError(f"[{err.get('code', r.status_code)}] {err.get('message')}")

def subscribe_events(on_event):
    """SSE 订阅（生成器逐帧解析，断线自动重连）。"""
    while True:
        try:
            with requests.get(f"{BASE}/api/events", headers=_headers(),
                              stream=True, timeout=(3, None)) as resp:
                for line in resp.iter_lines(decode_unicode=True):
                    if line and line.startswith("data: "):
                        on_event(json.loads(line[6:]))
        except requests.RequestException:
            time.sleep(3)  # 断线重连

if __name__ == "__main__":
    print(health())
    show_island("Python 任务完成 ✔", kind="success", title="PyWorker", duration=3000)
    # subscribe_events(lambda e: print("island.show:", e))
```

### 9.4 Java（11+，内置 HttpClient）

```java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

public class IslandApi {
    static final String BASE = "http://127.0.0.1:12935";
    static final String TOKEN = ""; // 用户配置了 token 时填入
    static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3)).build();

    static HttpRequest.Builder builder(String url) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(5));
        if (!TOKEN.isEmpty()) b.header("Authorization", "Bearer " + TOKEN);
        return b;
    }

    /** 弹出灵动岛提示 */
    public static void showIsland(String text, String kind, String title, long duration)
            throws Exception {
        String json = String.format(
                "{\"text\":%s,\"kind\":%s,\"title\":%s,\"duration\":%d}",
                quote(text), quote(kind), title == null ? "null" : quote(title), duration);
        HttpRequest req = builder(BASE + "/api/island/show")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json)).build();
        HttpResponse<String> res = CLIENT.send(req, HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 204) {
            throw new IllegalStateException("island show failed: HTTP "
                    + res.statusCode() + " " + res.body());
        }
    }

    /** 健康检查 */
    public static String health() throws Exception {
        HttpRequest req = builder(BASE + "/api/health").GET().build();
        return CLIENT.send(req, HttpResponse.BodyHandlers.ofString()).body();
    }

    static String quote(String s) {
        return s == null ? "null" : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n") + "\"";
    }

    public static void main(String[] args) throws Exception {
        System.out.println(health());
        showIsland("构建完成，用时 42s", "success", "Gradle", 3000);
    }
}
```

### 9.5 Swift（5+，URLSession，macOS/iOS 工具集成示例）

```swift
import Foundation

enum IslandAPI {
    static let base = "http://127.0.0.1:12935"
    static var token = "" // 用户配置了 token 时填入

    private static func request(_ path: String, method: String = "GET",
                                body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        req.timeoutInterval = 5
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    /// 弹出灵动岛提示
    static func show(text: String, kind: String = "info",
                     title: String? = nil, duration: Int = 0) async throws {
        var payload: [String: Any] = ["text": text, "kind": kind, "duration": duration]
        if let t = title { payload["title"] = t }
        let body = try JSONSerialization.data(withJSONObject: payload)
        let (data, resp) = try await URLSession.shared.data(for: request(
            "/api/island/show", method: "POST", body: body))
        guard (resp as? HTTPURLResponse)?.statusCode == 204 else {
            throw NSError(domain: "IslandAPI", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "failed"])
        }
    }

    /// 健康检查
    static func health() async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(for: request("/api/health"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}

// 用法（async 上下文）
Task {
    print(try await IslandAPI.health())
    try await IslandAPI.show(text: "导出完成", kind: "success", title: "MyApp", duration: 3000)
}
```

### 9.6 C#（.NET 6+，HttpClient）

```csharp
using System.Net.Http;
using System.Text;
using System.Text.Json;

public static class IslandApi
{
    const string Base = "http://127.0.0.1:12935";
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    public static string Token = ""; // 用户配置了 token 时填入

    static HttpRequestMessage Build(HttpMethod m, string path, object? body = null)
    {
        var req = new HttpRequestMessage(m, Base + path);
        if (Token != "") req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {Token}");
        if (body != null)
            req.Content = new StringContent(JsonSerializer.Serialize(body),
                Encoding.UTF8, "application/json");
        return req;
    }

    public static async Task ShowAsync(string text, string kind = "info",
        string? title = null, int duration = 0)
    {
        using var req = Build(HttpMethod.Post, "/api/island/show",
            new { text, kind, title, duration });
        using var res = await Http.SendAsync(req);
        if (res.StatusCode != System.Net.HttpStatusCode.NoContent)
        {
            var msg = await res.Content.ReadAsStringAsync();
            throw new HttpRequestException($"island show failed ({(int)res.StatusCode}): {msg}");
        }
    }

    public static async Task<JsonElement> HealthAsync()
    {
        using var req = Build(HttpMethod.Get, "/api/health");
        using var res = await Http.SendAsync(req);
        var doc = await JsonDocument.ParseAsync(await res.Content.ReadAsStreamAsync());
        return doc.RootElement.GetProperty("data");
    }
}

// 用法
// await IslandApi.ShowAsync("部署完成", "success", "Deploy", 3000);
```

---

## 10. 场景指南与故障排查

### 10.1 基础集成（最小改动）

只需两步：启动时探测 health（判断用户是否开启了 API + 端口是否正确），然后在合适的时机 POST 一条提示。

```javascript
// 任意第三方应用内的最小集成
const show = (text, kind) =>
  fetch('http://127.0.0.1:12935/api/island/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, kind }),
  }).catch(() => {}); // 静默失败：岛 API 未开启不应影响应用自身
```

> **最佳实践**：所有调用都应静默失败或低优先级告警——灵动岛是「锦上添花」的反馈通道，不应因它未开启而阻塞业务流程。

### 10.2 高级定制（多行 + 自定义标题 + 时长）

```bash
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Backup",
    "kind": "info",
    "text": "正在备份 128 个文件\n已完成 96 / 128\n剩余约 2 分钟",
    "duration": 5000
  }'
```

悬停胶囊即可展开逐行面板（含行号 1–3）。

### 10.3 典型应用类型接入建议

| 应用类型 | 建议 kind | 建议 duration | 示例 text |
|---|---|---|---|
| 工具类（CI/下载/备份） | `success` / `error` | 3000–5000 | `构建完成，用时 42s` |
| 社交类（消息提醒） | `info` | 3000 | `Alice: 会议改到 3 点` |
| 媒体类（播放状态） | `info` | 1500–2000 | `▶ 正在播放：Song Name` |
| 开发者工具（命令行联动） | `copy` / `paste` | 默认 | 与剪贴板联动的事件回显 |

### 10.4 故障排查清单

1. **弹不出来** → 依次确认：设置页「灵动岛提示」总开关开 → 「灵动岛 API」开关开 → `GET /api/health` 返回 `ok:true` → POST 返回 204（非 204 时按 §7.2 错误码修正参数）。
2. **health 401** → 用户配置了 token，请求头补 `Authorization: Bearer <token>`。
3. **弹岛但不显示自定义标题** → 标题是纯空白（被 trim 丢弃）或传入的是空串。
4. **长文本显示不全** → 胶囊只预览 120 字符，属预期行为；完整内容请让用户悬停展开，或自行分段推送。
5. **duration 设置无效** → 确认传的是毫秒数（不是秒）；低于 600 或高于 60000 会被钳制到边界。

---

## 11. 版本控制与更新日志

### 版本策略

- 采用语义化版本（`MAJOR.MINOR.PATCH`），与 `island_api.rs` 中 `API_VERSION` 常量保持一致，可通过 `GET /api/health` 查询。
- **向后兼容承诺**：v1.x 内所有现有字段与错误码行为不变；新增字段一律从「接收但不处理」的预留字段起步。
- 破坏性变更（不兼容的字段语义修改）将升级 MAJOR 版本并在本节记录迁移指引。

### 更新日志

#### v1.0.0（2026-09-14）

- **首发**：`GET /api/health`、`POST /api/island/show`、`GET /api/events`（SSE，事件名 `island.show`）。
- 仅绑定 `127.0.0.1`；可选 Bearer token 鉴权（所有接口）。
- 请求字段：`text`（必填，≤2000 字符）、`kind`（5 种枚举，默认 `info`）、`title`（≤24 字符，超长截断）、`duration`（毫秒，0=应用默认）、`priority`（**预留**，接收不处理）。
- 错误码体系：`invalid_json` / `empty_text` / `text_too_long` / `invalid_kind` / `unauthorized` / `method_not_allowed` / `not_found` / `internal_error`。
- SSE 心跳 15s（`: ping` 注释帧）；断开订阅者自动清理。
- 该版本替代原「智能剪贴板开放 API」（open_api.rs，v0.3.x 已移除）。

#### 兼容性说明（相对旧开放 API）

| 旧 open_api | 新 island_api |
|---|---|
| 事件仅覆盖复制成功场景 | 任意第三方内容可弹岛 |
| 端点/报文格式不公开 | 本文档为正式契约 |
| — | `priority` 字段已预留，后续版本将用于通知优先级与合并策略 |
