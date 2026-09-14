# 灵动岛 API 速查

> v1.0.0 · 正式 · 适用 S1d3 Board ≥ v0.4.0 · 完整变更见 git 历史

第三方应用向本机回环地址发 HTTP 请求，即可在灵动岛显示自定义提示。

**启用**：设置 → 通用 → 灵动岛 API → 打开开关（默认关闭），记下端口（默认 `12935`），可选填 token。

---

## 接口一览

| 接口 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 健康检查 | `GET` | `/api/health` | 返回 `{ok:true,data:{version,port}}` |
| 显示灵动岛 | `POST` | `/api/island/show` | 弹出提示；成功返回 `204` 无响应体 |
| 订阅事件流 | `GET` | `/api/events` | SSE；事件 `island.show`，心跳 `: ping`（15s） |

## 请求头

| 请求头 | 必填 | 说明 |
|---|---|---|
| `Content-Type: application/json` | POST 必填 | UTF-8 JSON 请求体 |
| `Authorization: Bearer {token}` | 条件 | 仅当设置页配置了非空 token 时全接口必填 |

## `POST /api/island/show` 参数

| 参数 | 类型 | 必填 | 默认 | 取值 | 说明 |
|---|---|---|---|---|---|
| `text` | string | 是 | — | 非空，≤2000 字符 | 内容，保留换行；胶囊预览 120 字符，悬停展开看全文+行号 |
| `kind` | string | 否 | `info` | `info`/`success`/`error`/`copy`/`paste` | 决定图标与默认标签 |
| `title` | string | 否 | `null` | ≤24 字符 | 自定义标签；超长静默截断，空白视为未传 |
| `duration` | number | 否 | `0` | 毫秒 | 停留时长；0=应用默认（1800ms）；>0 时钳制 600–60000 |
| `priority` | string | 否 | — | — | 预留字段，接收不处理 |

## 响应格式

```jsonc
// 成功（health）
{ "ok": true, "data": { "version": "1.0.0", "port": 12935 } }
// 失败
{ "ok": false, "error": { "code": "invalid_kind", "message": "..." } }
```

SSE 事件数据：`{"text":"...","kind":"info","title":null,"duration":0,"ts":1726300000000}`

## 错误码

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

## 安全与行为要点

- 仅绑定 `127.0.0.1`；无 CORS 头（浏览器页面无法调用）；明文 HTTP（不出网卡）
- token 为用户在设置页自定义的静态值，更换即时生效；配置后 `EventSource` 不可用，需用支持自定义 header 的客户端订阅 SSE
- 同屏仅保留最后一次弹岛请求；用户关闭「灵动岛提示」总开关后所有 API 请求不再弹岛（SSE 照常）
- 显示样式与动画跟随应用主题，v1 不开放视觉定制

## 排查

| 现象 | 处理 |
|---|---|
| 连接拒绝 | 确认开关已开、端口正确，先 `GET /api/health` |
| 端口启用失败 | 应用日志提示绑定失败；换端口保存即自动重启服务 |
| 401 | 核对设置页 token 与请求头一致 |
| 长文本显示不全 | 胶囊仅预览 120 字符，悬停展开查看全文 |

## 更新日志

- **v1.0.0**（2026-09-14）：首发三个端点；`priority` 为预留字段。替代已移除的旧智能剪贴板开放 API。
