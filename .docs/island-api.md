# S1d3 Board 开放 API · 灵动岛

> API v1.4.0 · 适用 S1d3 Board ≥ v0.4.0 · 本文档与实现严格同步，以代码为准（实现：`src-tauri/src/island/api.rs`）

S1d3 Board 通过回环 HTTP 服务对外开放**双向**能力：

```
┌─────────────────┐   Inbound  命令 API    ┌──────────────────┐
│  第三方软件/脚本  │ ────────────────────▶ │                  │
│  网页 (浏览器 JS) │ ◀──────────────────── │    S1d3 Board    │
└─────────────────┘   Outbound 事件流 SSE  └──────────────────┘
```

- **Inbound（第三方 → 应用）**：推送灵动岛显示请求，让你的工具获得系统级消息出口；查询灵动岛历史，读取显示记录
- **Outbound（应用 → 第三方）**：订阅 SSE 事件流，实时接收应用内**所有**灵动岛显示事件（复制/粘贴/剪切、任务与便签操作反馈、待办提醒、第三方推送）——把 S1d3 Board 当作事件源接入你的自动化链路（n8n、自建服务、桌面机器人、网页面板）；另可配置 Webhook 出站推送（§8）

---

## 1. 设计规范

| 约定 | 说明 |
|---|---|
| 风格 | REST + SSE；JSON over HTTP/1.1；仅回环 `127.0.0.1` |
| 响应封装 | 统一信封 `{ "ok": bool, "data"?: T, "error"?: { code, message } }`；成功无载荷时返回 `204` 无响应体 |
| 字段命名 | 请求/响应均为小驼峰 `camelCase` |
| 时间戳 | 毫秒级 Unix epoch（`ts`） |
| 时长单位 | 毫秒（`duration`） |
| 字符编码 | UTF-8 |
| 版本化 | 语义化版本，经 `GET /api/health` 的 `data.version` 暴露；破坏性变更升主版本并保留旧端点一个过渡期 |
| 幂等性 | `POST /api/island/show` 非幂等（每次调用都产生显示请求），调用方自行去重 |
| 错误处理 | 快速失败：校验错误返回 4xx + 结构化错误码，绝不半执行 |
| 兼容策略 | 新增字段向后兼容（调用方忽略未知字段）；`priority` 即预留字段示例 |

## 2. 快速开始

**启用**：设置 → 通用 → 灵动岛 API → 打开开关（默认关闭），记下端口（默认 `12935`），可选配置 token。

```bash
# 1. 健康检查
curl http://127.0.0.1:12935/api/health
# {"ok":true,"data":{"version":"1.4.0","port":12935}}

# 2. 推送一条提示（Inbound）
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -d '{"text":"构建完成，耗时 42s","kind":"success"}'
# HTTP 204 No Content

# 3. 订阅事件流（Outbound）
curl -N http://127.0.0.1:12935/api/events
```

Node.js 完整示例见 §7 / §8。

## 3. 认证与授权

| 项 | 规则 |
|---|---|
| 机制 | 静态 Bearer token：`Authorization: Bearer {token}`，全接口统一 |
| 配置 | 设置页自定义；**为空 = 免认证**；修改即时生效（服务自动重启） |
| 强制时机 | 仅当配置了非空 token；未配置时发送该头会被忽略 |
| 失败响应 | `401` + `{"ok":false,"error":{"code":"unauthorized",...}}` |
| 传递方式 | 仅请求头（不支持 query 参数） |
| CORS | `Access-Control-Allow-Origin: *` 全接口开放；preflight（`OPTIONS`）免 token 应答——**预检不携带 Authorization，故 token 校验只发生在实际请求** |
| 威胁模型 | 回环绑定隔绝外部网络；CORS 全开放使同机任意网页可调用——**对抗同机恶意网页的唯一防线是 token**，对外发布集成方案时强烈建议启用 token |

## 4. 接口一览

| 接口 | 方法 | 路径 | 方向 | 说明 |
|---|---|---|---|---|
| 健康检查 | `GET` | `/api/health` | Inbound | 服务探活与版本协商 |
| 显示灵动岛 | `POST` | `/api/island/show` | Inbound | 推送显示请求 |
| 历史查询 | `GET` | `/api/history` | Inbound | 查询灵动岛历史（条数/kind/时间区间过滤） |
| 事件流 | `GET` | `/api/events` | Outbound | SSE，实时接收全部显示事件 |

## 5. Inbound：`POST /api/island/show`

### 5.1 参数

| 参数 | 类型 | 必填 | 默认 | 取值 | 说明 |
|---|---|---|---|---|---|
| `text` | string | 是 | — | 非空，≤2000 字符 | 内容。**显示层截断到 120 字符**（超出静默丢弃不报错），换行保留，悬停胶囊可展开查看这 120 字符内全部行 |
| `kind` | string | 否 | `info` | `info` / `success` / `error` / `copy` / `paste` | 图标与默认标签，见 §5.3 |
| `title` | string | 否 | `null` | ≤24 字符 | 自定义标签，显示在内容左侧；超长静默截断，空白视为未传 |
| `duration` | number | 否 | `0` | 毫秒 | 停留时长；`0`/缺省 = 应用默认（设置页可调，默认 1800ms）；`>0` 钳制到 600–60000 |
| `priority` | string | 否 | — | — | **预留字段**，接收不处理，为未来抢占/排队语义保留 |

### 5.2 返回值

| 场景 | 响应 |
|---|---|
| 受理成功 | `204 No Content`（无响应体）。**204 = 请求已受理**，实际显示还经过应用侧延迟/合并/总开关（§9），SSE 订阅者以收到 `island.show` 事件为准 |
| 校验失败 | `400` / `422` + 错误信封 |
| 认证失败 | `401` + 错误信封 |

### 5.3 kind 视觉对照

| kind | 图标 | 默认标签 | 适用 |
|---|---|---|---|
| `info` | ⓘ 信息 | 信息 | 中性通知：开始、进行中、一般状态 |
| `success` | ✓ 成功 | 成功 | 完成、通过 |
| `error` | ✕ 错误 | 错误 | 失败、异常、告警（最醒目） |
| `copy` | ⧉ 复制 | 已复制 | 复制类回执 |
| `paste` | ⎘ 粘贴 | 已粘贴 | 粘贴类回执 |

视觉跟随应用当前主题，不开放定制。

### 5.4 调用示例

curl：

```bash
curl -X POST http://127.0.0.1:12935/api/island/show \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-token" \
  -d '{"text":"部署完成","kind":"success","title":"CI","duration":5000}'
```

Node.js：

```js
const BASE = "http://127.0.0.1:12935";

async function show(text, kind = "info", title, duration = 0) {
  const res = await fetch(`${BASE}/api/island/show`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Authorization: `Bearer ${token}`,   // 应用配置了 token 时必须
    },
    body: JSON.stringify({ text, kind, title, duration }),
  });
  if (res.status !== 204) console.error("island error:", await res.json());
}

await show("构建完成，耗时 42s", "success", "CI");
```

## 6. Inbound：`GET /api/history`

查询灵动岛历史（与历史窗口同库，保留最近 500 条），按时间倒序（最新在前）返回。

### 6.1 参数（query string）

| 参数 | 类型 | 必填 | 默认 | 取值 | 说明 |
|---|---|---|---|---|---|
| `limit` | number | 否 | `100` | 1–1000 | 返回条数上限 |
| `kind` | string | 否 | — | 同 §5.3 | 精确匹配；缺省 = 不过滤 |
| `from` | number | 否 | — | 毫秒时间戳 | 只返回 `createdAt >= from` |
| `to` | number | 否 | — | 毫秒时间戳 | 只返回 `createdAt < to`（含头不含尾） |

过滤在库侧执行（先 WHERE 后 LIMIT）；`from` / `to` 可单侧使用。非法参数静默取默认值，不报错。

### 6.2 返回值

`200 OK`：

```json
{
  "ok": true,
  "data": {
    "count": 2,
    "items": [
      { "id": 482, "kind": "success", "text": "部署完成", "createdAt": 1758000000000 },
      { "id": 481, "kind": "info", "text": "开始部署", "createdAt": 1757999900000 }
    ]
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `count` | number | 实际返回条数 |
| `items[].id` | number | 历史记录自增主键 |
| `items[].kind` | string | 同 §5.3 |
| `items[].text` | string | 显示内容（120 字符截断版，与历史窗口一致） |
| `items[].createdAt` | number | 落历史时间戳（毫秒） |

### 6.3 错误与边界

| 场景 | 响应 |
|---|---|
| 主窗口不可用 / 查询超时 | `503` + `history_unavailable`（等待期 3s，可重试） |
| 认证失败 | `401`（与其他接口一致，见 §3） |

历史库仅保留最近 500 条，需全量/实时数据请订阅 SSE（§7）落自己的存储。

### 6.4 调用示例

```bash
# 最近 20 条
curl "http://127.0.0.1:12935/api/history?limit=20"

# 最近 1 小时的 error 事件（from/to 为毫秒时间戳）
curl "http://127.0.0.1:12935/api/history?kind=error&from=1757996400000&to=1758000000000"
```

## 7. Outbound：`GET /api/events`（SSE 事件流）

### 7.1 连接

- 长连接 `text/event-stream`；空闲心跳为注释行 `: ping`（每 15s，兼做断连探测）
- 服务重启（改端口/开关）会断开全部订阅，客户端需自动重连；**不回放历史事件**，重连后从新事件开始
- 浏览器 `EventSource` 与 Node.js 客户端均可连接（CORS 全开放）；配置 token 后 `EventSource` 无法携带请求头，需改用支持自定义 header 的客户端

### 7.2 事件格式

```
event: island.show
data: {"text":"构建完成","kind":"success","title":"CI","duration":5000,"ts":1758000000000}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string \| null | 文本内容（与弹岛一致，120 字符截断版；`copy-image` 图片事件为 `null`，粘贴/剪切二维码图片时为二维码文本） |
| `kind` | string | 同 §5.3 |
| `image` | string \| null | 图片内容（data URL）：复制/粘贴/剪切图片事件携带，其余为 `null` |
| `qr_text` | string \| null | 图片事件解码出的二维码文本（链接等）：图片中识别到二维码时携带，其余为 `null`（v1.4.0） |
| `title` | string \| null | 自定义标签（未传为 `null`） |
| `duration` | number | 本次停留时长（0 = 应用默认） |
| `ts` | number | 服务端时间戳（毫秒） |

### 7.3 事件目录与来源

`island.show` 是**全量岛事件流**——凡是真实触发的岛事件都会广播，不区分来源：

| 来源 | 事件示例 |
|---|---|
| 应用自身 | 复制/剪切/粘贴、任务增删改与完成、便签保存/删除/配色、常用剪贴编辑置顶删除、待办提醒 |
| 第三方 API | 其他软件经 §5 推送的消息 |

被合并丢弃（出现延迟窗口内后者覆盖前者）的事件**不会**广播；灵动岛总开关只控制岛窗口是否显示，事件本身照常广播（总开关关闭时 SSE/Webhook 出站仍可用）——SSE 等于「用户实际触发的岛事件」。

### 7.4 消费示例

curl：

```bash
curl -N http://127.0.0.1:12935/api/events
```

Node.js：

```js
const BASE = "http://127.0.0.1:12935";

// Node 18+ 内置 fetch/ReadableStream；token 已配置时改用支持 header 的 SSE 库
async function subscribe() {
  const res = await fetch(`${BASE}/api/events`, { headers: {} });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        const ev = JSON.parse(dataLine.slice(6));
        console.log("island event:", ev.kind, ev.text, ev.ts);
        // 在这里接入你的自动化链路：n8n webhook、自建服务、日志管道……
      }
    }
  }
}

subscribe().catch(() => setTimeout(subscribe, 3000)); // 断线退避重连
```

网页（浏览器）：

```js
// 网页可直接订阅（CORS 已开放）；应用配置 token 后 EventSource 不可用
const es = new EventSource("http://127.0.0.1:12935/api/events");
es.addEventListener("island.show", (e) => {
  const ev = JSON.parse(e.data);
  console.log("S1d3 Board:", ev.text);
});
```

### 7.5 典型联动

| 场景 | 做法 |
|---|---|
| 事件中转站 | 订阅 SSE → 按规则转发到飞书/钉钉/Slack webhook、邮件、数据库 |
| 网页面板 | 本地仪表盘订阅 SSE，实时展示剪贴板/待办动态 |
| 行为统计 | 消费事件流做使用习惯分析（kind 分布、时段热度） |
| 联动自动化 | `kind:error` 触发告警脚本；待办提醒触发外部日历写入 |

## 8. Webhook 出站推送

应用主动把每个灵动岛显示事件 POST 到用户配置的外部 URL（适合无法维持长连接的远程服务/网页：n8n、飞书/钉钉机器人、自建服务）。

### 8.1 配置

设置 → 通用 → 灵动岛 API → **Webhook 出站推送**：

- 总开关 + 目标列表（每条：URL + 可选签名密钥）
- URL 白名单：`https` 任意主机；`http` 仅回环（`127.0.0.1` / `localhost` / `[::1]`）
- 「测试」按钮对全部启用目标各发一条测试消息（单次投递，3s 超时，不重试），结果以灵动岛提示反馈

### 8.2 请求格式

每次岛显示事件（与应用内/SSE 同源：复制/粘贴/剪切、任务与便签操作反馈、待办提醒、第三方 API 推送）向每个启用目标投递；灵动岛总开关关闭时仍照常投递，仅不弹岛：

```
POST {url}
Content-Type: application/json
X-S1d3-Event: island.show
X-S1d3-Signature: <hex>        # 仅配置了签名密钥时附带
User-Agent: S1d3Board-Webhook/{version}

{"text":"构建完成","kind":"success","title":"CI","duration":5000,"ts":1758000000000}
```

body 与 SSE `island.show` 事件完全一致（§7.2）。

### 8.3 验签（接收端）

`X-S1d3-Signature = HMAC-SHA256(raw_body, secret)` 的 hex 小写编码。接收端以**原始请求体**（勿先解析再序列化）计算 HMAC 比对，防伪造调用。未配置密钥的 URL 不带签名头——对外公开的接收端务必配置密钥。

Node.js 验签示例：

```js
import crypto from "node:crypto";

function verify(req, rawBody, secret) {
  const sig = req.headers["x-s1d3-signature"];
  if (!sig) return false;
  const expect = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex"));
}
```

### 8.4 可靠性语义

| 机制 | 行为 |
|---|---|
| 超时 | 单次投递 5s |
| 重试 | 失败后指数退避 1s / 4s / 16s（初次 + 3 次重试，最多 4 次尝试） |
| 熔断 | 连续 5 轮交付全败 → 暂停该目标 5 分钟（静默跳过，恢复后自动重新投递）；成功即清零计数；状态在内存，应用重启清零 |
| 顺序 | 不保证跨事件顺序（每事件独立异步投递）；按 `ts` 排序/去重 |
| 总开关 | Webhook 总开关关闭时零投递（与灵动岛显示开关、API HTTP 开关相互独立） |
| 约束 | 应用休眠/退出期间不缓存补投——停机窗口内的事件会丢失，关键业务接收端需容忍丢失或轮询补偿 |

## 9. 行为模型（集成必读）

| 机制 | 行为 |
|---|---|
| 单例队列 | 灵动岛是单例窗口，所有来源共享一条显示通道；新事件**立即替换**当前显示，无排队/抢占 |
| 出现延迟 | 应用可配全局延迟（默认 0ms）；延迟窗口内连续事件**只显示最后一条**，中间事件被丢弃且不广播、不落历史——高频推送的天然节流器 |
| 停留时长 | `duration=0` 跟随应用默认（1800ms 可调）；`>0` 本次覆盖（600–60000ms 钳制） |
| 历史记录 | 每条岛显示事件写入灵动岛历史窗口（用户可回溯）：文本为 120 字符截断版，图片事件存缩略图 |
| 岛内渲染 | 岛窗口 UI 对图片事件渲染降采样缩略图（高 384px webp）以加速显示；出站事件的 `image` 字段始终保持调用方提交的原始 data URL，不做任何修改 |
| 二维码识别 | 图片事件（复制/粘贴/剪切）在 Rust 侧自动扫描二维码：识别到时出站携带 `qr_text`（≤120 字符截断），灵动岛内同时在缩略图旁显示链接；非二维码图片零额外出站字段 |
| 总开关 | 关闭「灵动岛提示」后：不弹岛（API 仍返回 `204`）；事件照常落历史并广播 SSE/Webhook——出站推送独立于显示开关，SSE 连接保持 |
| 节流建议 | 进度类推送状态变化才推（或 ≥2s 间隔），否则中间帧被合并机制吞掉 |

## 10. 技术约束

- 仅回环 `127.0.0.1` 绑定，数据不出网卡，外部设备不可达
- 无 TLS：因仅回环不涉及传输加密；需要跨机时请在应用侧前置反代（自行承担暴露风险）
- 请求头上限 8KB，超限连接直接断开
- HTTP/1.1，单响应 `Connection: close`（SSE 除外，长连接）
- 显示层 120 字符硬截断；`text` API 层上限 2000 字符
- 单实例服务：修改端口/token/开关会重启服务（SSE 连接随之断开）

## 11. 错误码

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `invalid_json` | 请求体非合法 JSON |
| 400 | `empty_text` | `text` 缺失或为空 |
| 401 | `unauthorized` | 配置了 token 但请求头不匹配 |
| 404 | `not_found` | 路径不存在 |
| 405 | `method_not_allowed` | 方法错误 |
| 422 | `text_too_long` | `text` > 2000 字符 |
| 422 | `invalid_kind` | `kind` 非法枚举 |
| 500 | `internal_error` | 服务内部错误 |
| 503 | `history_unavailable` | `/api/history` 主窗口不可用或查询超时（3s） |

## 12. 最佳实践

1. **先 health 后业务**：集成启动时探活，`version` 做能力协商
2. **灵动岛定位为「尽力而为」通知**：可能被合并/顶掉/总开关关闭（不弹岛）——关键路径保留系统通知或日志；SSE 确认（收到 `island.show`）是**事件回执**，不代表已在屏幕上显示
3. **节流**：进度/状态类按变化推送，避免逐帧推送
4. **重连退避**：SSE 断开后指数退避重连（如 1s/3s/10s），避免连接风暴
5. **token 卫生**：对外分发集成方案时默认启用 token；token 泄露即更换（设置页改完即时生效）
6. **处理 4xx**：`invalid_kind`/`text_too_long` 属调用方 bug，应修复而非重试；`401` 提示用户核对 token
7. **事件幂等**：SSE 重连可能错过事件（不回放），业务侧以 `ts` 去重并容忍丢失

## 13. 排查

| 现象 | 处理 |
|---|---|
| 连接拒绝 | 确认开关已开、端口正确，先 `GET /api/health` |
| 端口启用失败 | 应用日志提示绑定失败；设置页换端口保存即自动重启 |
| 401 | 核对 token；注意 preflight 不带 token 属正常 |
| 推送 204 但没显示 | ① 总开关已关闭 ② 被更高频事件顶掉（§9 单例队列）③ 处于出现延迟窗口被合并 |
| 长文本显示不全 | 显示层固定截断 120 字符；需完整内容请推系统通知或分段推送 |
| SSE 收不到应用自身事件 | 确认事件未被延迟合并吞掉（§9）；总开关不影响广播；重连后不回放历史 |
| 网页调用失败 | 检查是否触发 preflight（自定义头/JSON POST）；本服务已开放 CORS，若仍失败检查浏览器扩展拦截 |
| SSE 收不到事件（配了 token） | `EventSource` 无法带 token，改用 fetch 流式或带 header 的 SSE 客户端 |
| 历史查询 503 | 主窗口未启动或正退出；确认应用主窗口已打开后重试 |

## 更新日志

- **v1.4.0**（2026-09-21）：
  - `island.show` 事件新增 `qr_text` 字段：图片事件（复制/粘贴/剪切）在 Rust 侧自动扫描二维码，识别到时携带文本（链接等），灵动岛内同时在缩略图旁显示该链接
  - 智能剪贴板环盘（Ctrl+B）：选中的二维码图片条目把解码链接当文本参与切分，Enter 直接粘贴链接
  - 图片条目二维码识别结果落库（`clipboard.qr_text`）：存量图片在主窗口列表可见时惰性补扫
- **v1.0.0**（2026-09-14）：首发三个端点；`priority` 为预留字段。替代已移除的旧智能剪贴板开放 API。
- **v1.1.0**（2026-09-20）：
  - SSE 升级为**全量显示事件流**：应用自身事件（复制/粘贴/提醒/操作反馈）经事件桥统一广播，此前仅广播第三方 API 事件
  - 新增 **CORS 全开放**（含 OPTIONS 预检免 token）：网页可直接订阅事件流、调用 API
  - 文档重构为双向开放 API 完整版（设计规范/行为模型/Webhook 规划/最佳实践）
- **v1.2.0**（2026-09-20）：
  - 新增 `GET /api/history`（Inbound）：查询灵动岛历史，支持 limit / kind / from–to 毫秒区间过滤（库侧执行，最新在前）
  - 修复 POST 请求在 header+body 同段到达时被丢弃导致挂死的问题（read_request 返回 leftover）
  - Webhook 出站推送正式实现（§8）：HMAC 签名 / 重试退避 / 连败熔断 / URL 白名单
- **v1.3.0**（2026-09-20）：
  - 出站事件（SSE/Webhook）与灵动岛总开关**解耦**：总开关关闭时事件照常广播/落历史，仅不弹岛
  - `island.show` 事件新增 `image` 字段（data URL）：复制/粘贴/剪切图片事件携带；复制图片的 data URL 从 `text` 迁移至 `image`（`text` 回归 120 字符截断语义，图片事件为 `null`）
  - 全局 Ctrl+V 粘贴计入剪贴板使用次数（文本按内容精确匹配）
