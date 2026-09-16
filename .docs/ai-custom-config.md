# AI 自定义提供商配置

设置 → 通用 → AI 提供商 → 自定义 JSON。用一份 JSON 描述任意 HTTP AI 接口的请求与响应映射，Rust 侧代理请求（API Key 不进前端网络层）。

## 接口一览

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 否 | 接口路径，拼在 Base URL 后；以 `http(s)://` 开头时整体作为最终 URL。支持 `{{baseUrl}}` `{{model}}` `{{apiKey}}` 占位符。缺省 = 直接用 Base URL |
| `headers` | object | 否 | 请求头模板，键值均须为字符串，值支持占位符。缺省无自定义头（Content-Type 由请求体自动带出，可在此覆盖） |
| `body` | object | 是 | 请求体模板，字符串值支持占位符 |
| `responsePath` | string | 否 | 非流式（JSON）响应的文本提取路径。默认 `choices[0].message.content` |
| `streamResponsePath` | string | 否 | 流式（SSE）每帧的增量文本提取路径。默认 `choices[0].delta.content` |

## 占位符

| 占位符 | 替换值 |
|---|---|
| `{{baseUrl}}` | 设置页「Base URL」字段 |
| `{{model}}` | 设置页「模型」字段 |
| `{{apiKey}}` | 设置页「API Key」字段 |
| `{{system}}` | 提取器指令（连接测试时为固定测试语） |
| `{{content}}` | 剪贴板原文（连接测试时为 `ping`） |

整串恰为一个占位符时替换为原始值（长文本不转义）；否则做字面替换。适用范围：`headers`、`body` 支持全部占位符；`path` 仅支持 `{{baseUrl}}` `{{model}}` `{{apiKey}}`（不开放 `{{system}}`/`{{content}}`，避免长文本注入 URL）。

## 流式行为

响应 `Content-Type` 含 `text/event-stream` 时按 SSE 解析：逐帧取 `data:` 载荷 JSON，按 `streamResponsePath` 提取增量并累积，`data: [DONE]` 终止；每帧广播事件 `ai:chunk`（payload `{text: 累计全文}`）。最终返回值为拼接全文，与非流式一致。非 SSE 响应按 `responsePath` 一次性提取。

提取路径写法：`a.b.0.c` 与 `a[0].b` 等价，数字 token 先按数组下标再按对象键解析。

## 默认模板（设置页「套用模板」）

```json
{
  "path": "/chat/completions",
  "headers": { "Authorization": "Bearer {{apiKey}}" },
  "body": {
    "model": "{{model}}",
    "messages": [
      { "role": "system", "content": "{{system}}" },
      { "role": "user", "content": "{{content}}" }
    ]
  },
  "responsePath": "choices[0].message.content",
  "streamResponsePath": "choices[0].delta.content"
}
```

流式请求在 `body` 中自行加入 `"stream": true`；是否流式以响应 `Content-Type` 为准（API 强制流式时无需改动，自动按 SSE 解析）。

## 校验与错误

| 场景 | 行为 |
|---|---|
| 编辑器 JSON 解析失败 / 非对象 / `body` 非对象 / `headers` 非对象或含非字符串值 | 红字提示，不落库；「测试连接」拦截不发请求 |
| `custom` 模式下配置为空 | 「测试连接」提示先填写；调用侧报「缺少 JSON 配置」 |
| 非 2xx | 报状态码 + 响应体前 300 字符 |
| 流式未提取到任何文本 | 报「检查 streamResponsePath」 |
| JSON 响应路径无文本 | 报「在 responsePath 处没有文本」 |

存储：`ai_provider = "custom"`，模板存 KV `ai_custom_config`。超时统一 15 秒。

## 更新日志

- 2026-09-16 新增自定义 JSON 提供商（请求模板 + SSE 流式解析 + `ai:chunk` 事件）
- 2026-09-16 占位符补全：新增 `{{baseUrl}}`，`path`/`headers`/`body` 均支持变量替换；`path` 不开放 `{{system}}`/`{{content}}`
