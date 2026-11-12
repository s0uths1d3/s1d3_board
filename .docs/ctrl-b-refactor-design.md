# Ctrl+B 智能提取重构设计

> 版本：v1.1（设计评审稿）
> 范围：`Ctrl+B`（`bubble_toggle`）触发链路的内容来源、AI 输入与产出契约；以及提取器 / 方案模型的简化
> 约束：`Ctrl+B` 环盘的界面呈现、UI 样式、布局结构、交互方式 **零变更**
> 文档结构：第一部分（§1–§12）内容源与 AI 输入净化；第二部分（§13–§19）提取器 / 方案模型简化。两部分可独立评审，按「第一部分 → 第二部分」顺序实施
> 关联文档：`.docs/smart-clip-ai-analysis.md`（现有分流策略）、`.docs/features/smart-clip.md`、`.docs/database.md`

---

## 1. 背景与问题

`Ctrl+B` 当前会打开环形片段盘（`/bubble?mode=ring`），已具备「本地切分 + 散文 AI 关键词/一句话总结」能力。但内容来源与 AI 输入存在三类偏离「只处理当前剪贴板内容」的问题：

| 编号 | 现状 | 问题 |
|---|---|---|
| P1 | 内容源取主窗口列表的**选中项**（`getSelectedItem()`，`BubbleToggleCommand.ts:198`） | 选中项可能不是系统剪贴板当前内容（用户移动过选择、选择已过期），分析对象不确定 |
| P2 | 无选中项/解析为空时**回退最近一条解析缓存**（`BubbleToggleCommand.ts:167-170`） | 把其他历史剪贴内容混入本次环盘，属于「无关信息」 |
| P3 | AI 请求在 user 消息头部拼接**用户偏好摘要**（`analysis.ts:89-91` 的 `buildDigest()`），方案内 AI 提取器还拼接习惯提示（`template.ts:76-81`） | 发给模型的输入不再是纯剪贴板内容，属于「额外内容」 |
| P4 | AI 产出仅「关键词 + 一句话总结」 | 缺少结构化「提炼」产物（可独立粘贴的要点） |

---

## 2. 目标与非目标（需求边界）

### 2.1 目标

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 唯一内容源 = 按下 `Ctrl+B` 瞬间的系统剪贴板 | 源码中不存在任何历史条目回退；日志可追踪本次来源 |
| G2 | 发往 AI 的 user 内容 = 当前剪贴板内容（经脱敏），无任何附加上下文 | 单测断言 `aiComplete` 的 user 入参严格等于 `redactSecrets(content)` |
| G3 | 在纯剪贴板内容上支持「总结 / 提炼」 | 新增可粘贴的要点片段；总结与关键词行为保持 |
| G4 | 界面、样式、布局、交互、快捷键完全不变 | 视觉回归 + DOM 快照 diff 无差异；不改 `RingOverlay.vue` / `bubble.vue` 的模板、类名、尺寸与动画 |
| G5 | 向后兼容，可整体回滚 | 无 DB schema 变更、无 KV 迁移；回滚仅 revert 代码 |

### 2.2 非目标（明确不做）

- 不新增设置项、开关、快捷方式（`CommandOrControl+B`、`scope: local`、toggle 语义保持不变）；设置页的变化仅限第二部分对提取器/方案编辑器的**收敛删除**，不新增任何入口（后续增量例外：§22/§23 新增「本地切分 / AI 关键字 / AI 总结」开关）。
- 不新增窗口、不改变环盘尺寸/位置/层级、不调整环形布局与槽位数（8/页、24 上限）。
- 不做图片 OCR（图片仅沿用已解码的二维码文本）、不支持文件类型、不做跨设备同步。
- 不改变八级分流（`analyzeVerdict`）阈值与判定顺序；不改变「技术内容不外发」策略（后续增量例外：§22 分隔符/多行放行，见该节）。
- 不修改 `aiClient` 的协议实现、超时（15s）与提供商适配。

---

## 3. 核心设计原则

1. **单一内容源（Single Source of Truth）**：本次会话的 `content` 只来自一次系统剪贴板读取；任何缓存、选中项、历史条目都不得替代或补充它。
2. **输入零注入**：AI 请求 = 静态 system 指令 + 当前内容（脱敏后）。习惯摘要、历史片段、其他条目的产出一律不进请求。
3. **规则不是内容**：本地切分使用的规则（内置切分器、用户自定义正则/分隔符）是**处理规则**，不构成内容注入；第二部分下线 AI 提取器后，AI 只存在于分析阶段且只接收同一份 `content`。
4. **UI 冻结**：数据层可扩展（新增片段），但不新增控件、不改变既有片段的表现形式与顺序语义。
5. **失败不污染**：任何读取/AI 失败都不写缓存、不落半成品片段。

---

## 4. 现状与目标数据流

### 4.1 现状

```
Ctrl+B(local)
  → BubbleToggleCommand.openRing
      → getSelectedItem()                    // P1：选中项
      → content = selected.content | qr_text
      → planAnalysis(content)                // 八级分流
      → parseRingSegments
            → parseClipItem(选中项)           // 方案/智能切分
            → raw 为空 → getSmartClipEntries()[0]   // P2：历史回退
      → 环盘上屏
      → AI：aiComplete(system, digest + redact(content))   // P3
      → mergeAiSegments(keywords, summary)
```

### 4.2 目标

```
Ctrl+B(local)
  → resolveClipboardSource()                  // 新增：唯一内容源
        text        → { kind:'text', content }
        image-qr    → { kind:'text', content: qr_text }   // 兼容保留
        empty/files → 岛提示，不开环
  → planAnalysis(content)（不变）
  → 本地切分（parseClipItem / runScheme，不变；删除历史回退）
  → AI：aiComplete(system, redactSecrets(content))         // 零注入
  → 产出 { keywords[], bullets[], summary }
  → mergeAiSegments(base, { keywords, bullets, summary })  // 关键词→要点→总结
  → ring:data 上屏（UI 不变）
```

---

## 5. 技术实现方案

### 5.1 内容源解析（新增 `app/src/smart-clip/clipboardSource.ts`）

```ts
export type ClipSource =
  | { kind: 'text'; content: string; origin: 'text' | 'image-qr' }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: 'files' | 'image' }
  | { kind: 'error'; error: unknown };

export async function resolveClipboardSource(): Promise<ClipSource>;
```

判定顺序（固定，首个命中即返回）：

| 步骤 | 判定 | 结果 |
|---|---|---|
| 1 | `readText()` 返回非空白（`trim()` 后非空） | `text`，`origin='text'`，`content = 原文`（仅 trim 首尾，不做其他归一化） |
| 2 | `readText()` 抛错 | `error`（岛提示「读取剪贴板失败」，不开环） |
| 3 | 文本为空，`readImageBase64()` 有值 | 视为图片：取**最近 10s 内**落库、`type='image'` 的最新记录；若其 `qr_text` 非空 → `text`（`origin='image-qr'`）；否则 `unsupported:'image'` |
| 4 | 剪贴板为文件列表 | `unsupported:'files'` |
| 5 | 其余（空剪贴板） | `empty` |

实现要点：

- 步骤 3 的 10s 新鲜度窗口保证「图片来自当前剪贴板」：剪贴板监听在变更后 ~100ms 内落库，超窗则不采用，宁可不支持也不引用旧内容。
- **禁止任何历史回退**：删除 `BubbleToggleCommand.ts:167-170` 的 `getSmartClipEntries()[0]` 分支。
- 解析失败（`parseClipItem` 抛错）时：环盘只展示本次 `content` 的本地切分结果（或原文单段），不借用其他条目；岛提示失败原因（沿用现有 `island.parse_failed`）。
- `contentHash` 改为 `hashText(content)`（原为 `selected.content`），习惯/统计的键语义与原来一致（同一内容同一 hash）。

### 5.2 AI 输入净化（移除全部外部注入）

| 位置 | 现状 | 目标 |
|---|---|---|
| `analysis.ts:89-91` | `user = digest + '\n\n' + content` | `user = content`（digest 不再参与请求） |
| `analysis.ts:3` | `import { buildDigest, getDigestVersion ... }` | 仅保留 `getDigestVersion`（缓存分区用）；`buildDigest` 导入移除 |
| `template.ts:76-81` | 方案 AI 提取器拼接 `habitHint` | 移除 `habitHint`，只传 `content` |
| `analysis.ts:94` | `aiComplete(cfg, system, redactSecrets(user))` | `aiComplete(cfg, system, redactSecrets(content))`（脱敏保留） |

- `system` 仍为纯静态指令（保持 provider 前缀缓存命中原状）。
- 缓存键 `analysis:${contentFingerprint(content)}:${version}`（`version` 仍取 `getDigestVersion()`，仅作分区因子，不再影响请求内容）；`contentFingerprint` 为双 32 位哈希 + 长度，替代单一 djb2。缓存值改为带归属信封 `{ v:2, fp, len, head, tail, result }`，读取时必须与当前内容逐项比对（见 §21）。键变更使旧缓存条目自然失效，分析缓存窗口仅 300s，无迁移成本。
- 单测用 mock 捕获 `aiComplete` 入参，断言 `user === redactSecrets(content)` 且不包含任何 digest 前缀。

### 5.3 总结 / 提炼产出契约（向后兼容扩展）

`INSTRUCTION` 的 JSON 契约扩展为：

```json
{
  "keywords": ["关键词1", "关键词2"],
  "bullets": ["要点1", "要点2", "要点3"],
  "summary": "一句话总结"
}
```

规则：

- `keywords`：≤5 个，语义不变。
- `bullets`（新技术能力）：≤5 条，每条 ≤40 字，必须是可独立粘贴的事实/结论，不含指代与寒暄；**可选字段**。
- `summary`：≤60 字，语义不变。
- 输出语言与内容主语言一致；`[REDACTED]` 不得出现在任何字段（关键词侧已有兜底，`bullets/summary` 同规则）。
- 校验：三字段全空 → 视为失败，不写缓存（沿用现有语义）。

解析与合并：

- `parseResult` 增加 `bullets` 解析（`string[]`、去空、去 `[REDACTED]`、`slice(0,5)`）；旧缓存 JSON 无 `bullets` 时返回 `[]`，行为与现状完全一致。
- `mergeAiSegments(base, outcome, cap)` 的 `outcome` 增加可选 `bullets?: string[]`；合并顺序固定为 **关键词 → 要点 → 总结（总结仍排最后）**，沿用 `blankNormalize` 去重与 24 段封顶。
- 新增片段仍标记 `extractorId: 'ai-analysis'`，粘贴/钉住路径、采纳统计（`recordAiAdoption`）与 `recordAnalysisShown` 语义不变（分母仍按关键词数量计，避免历史指标口径漂移）。

### 5.4 UI 不变性约束（冻结清单）

以下内容本次**禁止改动**（评审时逐项核对）：

- 快捷键注册：`InitShortcuts.ts` 中 `bubble_toggle` 的 `CommandOrControl+B`、`scope:'local'`、`enabled` 语义。
- 窗口：`BubbleToggleCommand.ts` 中 overlay 的 `url:'/bubble?mode=ring'`、label 前缀、920×640、小屏收缩规则、透明/无边框/置顶/`focus:false`、居中算法、`ready` 握手超时 8s。
- 页面：`app/pages/bubble.vue` 的 ring 模式模板与 `RingOverlay` 组件——环盘布局、8 槽/页、24 段上限、控制盘、翻页与键盘映射、动画与过渡。
- 交互时序：粘贴 = 关环 → 抑制「已复制」岛 → 写剪贴板 → 200ms 后模拟粘贴 → 习惯落库（`BubbleToggleCommand.pasteRing`）。
- 样式：类名、尺寸、颜色、字体、层级、动效参数一律不改；不新增按钮、输入框、开关或提示面板。
- 文案：除新增的 3 条边界提示（见 5.6）外，不改动现有 i18n 文案。

> 允许变化的只有「片段数据」本身（多出若干可粘贴的要点片段），其渲染方式完全复用既有气泡。

### 5.5 关键伪代码

```ts
// BubbleToggleCommand.openRing（替换内容源与回退逻辑）
const source = await resolveClipboardSource();
if (source.kind === 'empty') {
  notifyIsland({ kind: 'info', text: t('island.ctrl_b_empty') });
  return;
}
if (source.kind === 'unsupported') {
  notifyIsland({ kind: 'info', text: t(`island.ctrl_b_unsupported_${source.reason}`) });
  return;
}
if (source.kind === 'error') {
  notifyIsland({ kind: 'error', text: t('island.ctrl_b_read_failed') });
  return;
}
const content = source.content;
const contentHash = hashText(content);          // 习惯/统计口径不变
// ……其余流程保持不变（planAnalysis / 建窗 / 阶段一 / 阶段二）
```

```ts
// analysis.ts:runAnalysis（净化后的请求）
const system = INSTRUCTION + JSON_CONTRACT;
const out = await aiComplete(cfg, system, redactSecrets(content));
const parsed = parseResult(out);   // { keywords, bullets, summary }
if (!parsed) throw new Error('AI 分析产出为空');
void dbService.setAiCache(cacheKey, JSON.stringify(parsed)).catch(() => {});
```

### 5.6 文件变更清单

| 文件 | 变更 |
|---|---|
| `app/src/smart-clip/clipboardSource.ts` | 新增：唯一内容源解析（含单测） |
| `app/src/smart-clip/__tests__/clipboardSource.spec.ts` | 新增：文本 / 空 / 图片二维码 / 文件 / 读取失败 |
| `app/src/commands/local/BubbleToggleCommand.ts` | 接入 `resolveClipboardSource`；删除历史回退；`contentHash` 取 `content` |
| `app/src/smart-clip/analysis.ts` | 去 `buildDigest` 注入；契约加 `bullets`；`parseResult` 扩展 |
| `app/src/smart-clip/ringSegments.ts` | `mergeAiSegments` 支持可选 `bullets`（顺序：关键词→要点→总结） |
| `app/src/smart-clip/template.ts` | 移除 `habitHint` 注入 |
| `app/assets/lang/{zh-cn,en-us}.toml` | 新增 3 条边界提示（空剪贴板 / 类型不支持 / 读取失败） |

明确**不改**：`app/pages/bubble.vue`、`app/components/ring/RingOverlay.vue`、`app/src/commands/shortcuts/InitShortcuts.ts`、`aiClient.ts`、数据库表结构。

---

## 6. 功能演示示例

> 约定：`环上新增` 列只展示 AI 追加的片段；本地片段来自当前剪贴板内容本身。所有示例均不含任何历史条目或偏好摘要。

### 6.1 示例 A：中文说明文（散文，320 字）

剪贴板内容（节选）：
> 我们的发布流程分为三段：提交前本地自测、合并前 CI 校验、合并后灰度发布。本地自测要求跑通单元测试与静态检查；CI 会额外执行端到端用例与依赖漏洞扫描；灰度发布按 1%、10%、100% 三档放量，每档观察 30 分钟错误率与延迟。

处理结果：
- 本地片段：按句读拆出的 3 段（与现状一致）
- AI 新增：关键词 `["发布流程","灰度发布","CI 校验"]`；要点 `["发布分三段：本地自测、CI 校验、灰度发布","灰度按 1%/10%/100% 放量，每档观察 30 分钟","CI 额外执行端到端用例与依赖漏洞扫描"]`；总结 `「发布流程分三段并逐级放量验证」`
- 岛提示：解析中 → 成功
- 证明无外部内容：请求体只含上面这段 320 字（脱敏后），不含历史记录与偏好摘要

### 6.2 示例 B：英文技术说明（散文）

剪贴板内容：
> Our cache layer uses write-through for small objects and write-behind for large payloads. Eviction is LRU with a 15-minute TTL. On cache miss, requests are coalesced per key so only one upstream call is issued.

处理结果：
- 关键词 `["write-through","LRU","cache miss coalescing"]`
- 要点 `["Small objects use write-through; large payloads use write-behind","LRU eviction with a 15-minute TTL","Concurrent misses per key are coalesced into one upstream call"]`
- 总结 `"Hybrid write policy with LRU and request coalescing"`
- 输出语言跟随内容（英文），行为与现状一致

### 6.3 示例 C：代码片段（技术工件，不外发）

剪贴板内容：
```ts
const cache = new Map<string, number>();
export function get(k: string) { return cache.get(k) ?? 0; }
```
处理结果：命中第 4 级「技术工件」→ 仅本地切分；**不发起 AI**（无关键词/要点）；岛提示「代码或技术内容，已跳过 AI 分析」。与现状一致。

### 6.4 示例 D：JSON（结构化）

剪贴板内容：`{"id":12,"name":"alice","roles":["admin","dev"]}`
处理结果：命中第 2 级「结构化」→ 本地键值切分；不发起 AI；岛提示「结构化内容，已本地切分」。

### 6.5 示例 E：单行短句（<20 字）

剪贴板内容：`明天上午十点开会`
处理结果：`too_short` → 本地单段且无 AI 增量 → 按现有规则**不开环**，岛提示「内容过短，无需 AI 分析」。行为与现状一致。

### 6.6 示例 F：空剪贴板 / 纯空白

处理结果：`resolveClipboardSource → empty` → 弹岛「剪贴板为空，没有可提取的内容」，**不开环**（现状为读取选中项/历史回退，本次收敛）。

### 6.7 示例 G：图片二维码（兼容保留）

剪贴板内容：一张含 `https://example.com/r/42` 的二维码截图
处理结果：文本为空 → 图片分支取 10s 内落库记录的解码文本 → 该链接为结构化内容 → 本地单段 → 按现有规则不开环（单段且无 AI）。若二维码文本为一段散文则与示例 A 相同。

### 6.8 示例 H：含密钥的散文

剪贴板内容：说明文 + `api_key=sk-live-************`
处理结果：发送前 `redactSecrets` 替换为 `[REDACTED]`；AI 产出的关键词/要点/总结均不含 `[REDACTED]`；本地片段仍展示原文（用户自己的剪贴板，不改变展示）。与现状一致。

### 6.9 示例 I：超长文本（>1000 字）

处理结果：命中第 1 级 → 不送 AI，本地按 ~300 字分块（≤24 段）；岛提示「内容超过 {n} 字，已跳过 AI 分析」。行为与现状一致。

### 6.10 示例 J：选中项 ≠ 当前剪贴板（行为收敛）

场景：用户在主窗口选中第 5 条历史，此时系统剪贴板是另一段新复制的文字。
处理结果：本次以**系统剪贴板**为准（旧实现会分析选中的第 5 条）。这是本设计的**有意收敛**，见 §10.2 兼容性说明。

### 6.11 改造前后对比

| 场景 | 改造前 | 改造后 |
|---|---|---|
| 剪贴板有文本，列表有选中项 | 分析选中项 | 分析剪贴板当前文本（通常与选中项相同） |
| 剪贴板为空、列表有历史 | 回退最近解析结果，开环展示旧内容 | 岛提示为空，不开环 |
| AI 请求内容 | `偏好摘要 + 内容` | `内容`（脱敏后） |
| 散文产出 | 关键词 + 一句话总结 | 关键词 + 要点 + 一句话总结 |
| UI/交互 | — | 完全一致 |

---

## 7. 性能指标

| 指标 | 目标（p95） | 说明 / 测量点 |
|---|---|---|
| 剪贴板读取（`readText` + 判定） | ≤ 30ms | `resolveClipboardSource` 前后打点 |
| 本地切分（≤1000 字） | ≤ 50ms | `parseClipItem` 前后打点，纯本地 |
| 按键 → 首屏灵动岛 | ≤ 80ms | 预判/提示岛路径 |
| 按键 → 环盘可见（热） | ≤ 600ms | `ring:shown`，不含 AI |
| 按键 → 环盘可见（冷启 WebView） | ≤ 1.5s，且不比现状劣化 >10% | 既有瓶颈为 WebView 冷建，本次不改变窗口创建方式 |
| AI 首结果 | ≤ 8s | 沿用 15s 超时；失败立即回落 |
| 缓存命中（300s 窗口） | ≤ 20ms | `getAiCache` |
| 连按去重 | 300ms 内连按 N 次 → 1 次真实请求 | `inflight` 复用不变 |
| 片段规模 | ≤ 24 段（8/页） | 沿用 `RING_MAX_SEGMENTS` |
| 内存增量 | ≤ 5MB/次会话 | 环关闭即释放 |

测量方式：在 `openRing` 关键节点写入 `performance.mark`（`ctrl-b:press` / `source-ready` / `segments-ready` / `ring-shown` / `ai-done`），开发构建下输出到控制台；发布前抽样 20 次统计 p95。

---

## 8. 异常处理规则

| 场景 | 行为 | 用户可见 | 消耗 token | 写缓存 |
|---|---|---|---|---|
| `readText` 抛错 | 终止，不开环 | 岛：读取剪贴板失败 | 否 | 否 |
| 剪贴板为空/纯空白 | 终止，不开环 | 岛：剪贴板为空 | 否 | 否 |
| 图片无二维码文本 | 终止，不开环 | 岛：当前为图片，暂不支持提取 | 否 | 否 |
| 剪贴板为文件 | 终止，不开环 | 岛：暂不支持文件类型 | 否 | 否 |
| 图片记录超 10s 新鲜度 | 视为不支持图片 | 岛：同上 | 否 | 否 |
| 本地解析抛错 | 保留本地原文兜底 | 岛：解析失败 + 原因 | 否 | 否 |
| AI 未配置 | 环照常（若本地 ≥2 段） | 岛：请先配置 AI 提供商 | 否 | 否 |
| 内容超长（> 上限） | 本地分块 | 岛：超过 {n} 字已跳过 | 否 | 否 |
| 内容过短（< 20 字） | 本地单段 | 岛：内容过短 | 否 | 否 |
| 高熵/技术/结构化/噪声 | 本地处理 | 对应岛提示 | 否 | 否 |
| 脱敏后内容为空 | 不发起 AI | 岛：内容无有效语义 | 否 | 否 |
| AI 超时 / 非 2xx / 空产出 / JSON 非法 | 环保留本地片段 | 岛：失败 + 分类原因 | 是 | 否 |
| `bullets` 缺失或非法 | 按无要点处理 | 无额外提示 | — | 是（按新结构缓存） |
| 环页 `ready` 超时（8s） | 关环 | 无（静默收尾） | 视阶段 | — |
| 环被用户关闭（toggle/Esc） | 纪元失效，后续异步全部丢弃 | 无 | 可能已发出 | 按结果 |
| 写剪贴板失败（粘贴） | 关环后终止，不模拟粘贴 | 岛：粘贴失败（现有逻辑） | 否 | 否 |

统一原则：**失败不产生半成品片段、失败不写缓存、失败不弹第二个互相矛盾的提示**。

---

## 9. 兼容性要求

### 9.1 保持不变（向后兼容）

- 快捷键：`Ctrl/Command+B`，局部作用域，再按一次关闭；环内 `Esc`/方向键/数字键行为不变。
- 窗口：尺寸、位置、透明/置顶/不抢焦点、外观与动画不变。
- 交互：点气泡粘贴 = 关环 → 写剪贴板 → 模拟粘贴 → 习惯落库；钉住行为不变。
- 数据：无 DB schema 变更，无 KV 迁移；AI 缓存窗口（默认 300s）不变，缓存键升级为内容指纹 + 归属信封（旧键条目自然失效，不迁移）。
- 统计：`daily_stat.ai_analysis` 与采纳率口径不变。
- 国际化：除新增 3 条边界提示外无文案变化。

### 9.2 行为收敛（有意变更，需在更新日志说明）

| 变更 | 旧行为 | 新行为 | 理由 | 影响面 |
|---|---|---|---|---|
| 内容源 | 列表选中项 | 系统剪贴板当前内容 | G1 | 选中项与剪贴板不同的少数场景 |
| 空内容 | 回退最近解析结果 | 不开环 + 提示 | G1/G2 | 剪贴板为空时不再展示旧内容 |
| AI 输入 | 含偏好摘要/习惯提示 | 仅内容 | G2 | 模型输出不再受历史习惯影响，更可预期 |
| 产出 | 关键词 + 总结 | + 可粘贴要点 | G3 | 环上可能多出 1–5 个气泡（布局规则不变，自动分页） |

> 兼容性兜底：当用户「刚复制完立刻按 Ctrl+B」时，选中项与剪贴板通常是同一内容，行为与改造前完全一致。

### 9.3 回滚方案

- 纯前端改动（4 个文件 + i18n），无数据/协议变更；`git revert` 对应提交即可恢复旧行为。
- 旧缓存条目在新代码下仍可解析（缺 `bullets` 按空处理），不存在「回滚后缓存不可用」。

---

## 10. 测试计划

### 10.1 单元测试

| 用例 | 断言 |
|---|---|
| `resolveClipboardSource` 文本 | 返回 `text`，`content` 与 `readText` 一致（仅 trim） |
| 文本为空白 | 走图片/空分支，不返回文本 |
| `readText` 抛错 | 返回 `error`，不抛异常 |
| 图片 + 10s 内二维码记录 | 返回 `text`、`origin='image-qr'` |
| 图片 + 超窗/无 qr_text | 返回 `unsupported` |
| 文件列表 | 返回 `unsupported:'files'` |
| 净化断言（mock `aiComplete`） | user 严格等于 `redactSecrets(content)`，不含摘要前缀 |
| `parseResult` 含/不含 `bullets` | 分别得到 3 组/2 组字段；非法条目被过滤 |
| `mergeAiSegments` 顺序 | 关键词 → 要点 → 总结；总结最后；去重；24 段封顶 |
| 回归 | 现有 409 用例全过（`npm test`），`npx vue-tsc --noEmit` 0 错误 |

### 10.2 手工验收（对应 §6 示例 A–J）

1. 中文/英文散文：环上出现关键词、要点、总结，粘贴任一条内容正确。
2. 代码/JSON/日志：无 AI 片段，岛提示正确。
3. 单行短句/超长文本：不开环或仅本地分块，提示与现状一致。
4. 空剪贴板 / 文件 / 纯图片：岛提示，不开环。
5. 选中历史项后复制新内容再按 Ctrl+B：以新内容为准。
6. 连续快速按 3 次：只发生一次 AI 请求（看缓存/日志）。
7. 关闭 AI Key 后再按：提示未配置，环仍展示本地片段。
8. 视觉回归：改造前后环盘截图对比（同一内容、同一显示器缩放），布局/尺寸/动画无差异。

---

## 11. 实施步骤（按提交拆分）

| # | 提交 | 内容 |
|---|---|---|
| 1 | `feat: 新增 Ctrl+B 剪贴板内容源解析` | `clipboardSource.ts` + 单测 |
| 2 | `refactor: Ctrl+B 仅以当前剪贴板为内容源` | `BubbleToggleCommand.ts` 接入、删除历史回退、`contentHash` 修正 |
| 3 | `refactor: AI 分析请求去除外部注入并新增要点提炼` | `analysis.ts` / `template.ts` / `ringSegments.ts` + 单测 |
| 4 | `chore: 补充 Ctrl+B 边界提示文案与设计文档` | i18n 3 条 + 本文档 |

依赖顺序：1 → 2 → 3 → 4；每步可独立编译与运行。

---

## 12. 验收清单

- [ ] 源码中不存在 `getSmartClipEntries()[0]` 形式的 Ctrl+B 内容回退
- [ ] `analysis.ts` / `template.ts`（第二部分下线后为 `runRules`）不再向 AI 请求注入任何摘要或历史信息
- [ ] 单测断言 AI user 入参严格等于脱敏后的当前内容
- [ ] 散文场景环上出现「要点」片段，且粘贴可用、去重与分页正确
- [ ] 旧缓存（无 `bullets`）解析正常
- [ ] `bubble.vue` / `RingOverlay.vue` / 窗口参数 / 快捷键注册零 diff
- [ ] 视觉回归对比通过（同内容、同缩放）
- [ ] `npm test` 全过、`npx vue-tsc --noEmit` 0 错误
- [ ] §6 十个示例逐条手工验证通过
- [ ] 更新 `.docs/smart-clip-ai-analysis.md` 中「习惯摘要参与请求」的描述
- [ ] 第二部分（提取器/方案简化）验收见 §19

---

# 第二部分：提取器与方案模型简化（§13–§19）

## 13. 问题与目标

### 13.1 现状结构

| 层 | 位置 | 内容 |
|---|---|---|
| 提取器 | `app/src/smart-clip/extractors.ts:51-88`、`entities.ts:152-161` | 单个提取单元：`method = regex / separator / ai`，AI 类型带自然语言指令 |
| 方案 | `entities.ts:133-144`、`template.ts:114-135` | 提取器成员集合（空 = 接入全部）+ 可选 body 模板（`{content}` `{segN}` `{date}` `{time}`）+ 启用态 |
| 设置页 | `SettingMain.vue:2378-2630` | 模式开关（2378–2390）、方案编辑器（2391–2483：成员勾选/排序、body 模板、AI 生成草稿）、提取器编辑器（2484–2630：增删改、上下移动、恢复内置、AI 草稿生成） |
| 处理层 | `smartClip.ts:46-65` | 有启用方案 → `runScheme` 合并全部成员产出 → `renderSchemeBody` 套模板；零产出/原文直通 → 降级 `autoSplit` |
| 存储 | `clip_extractors` KV（seed v4）、`clip_schemes` 表、`smart_default_scheme_id` KV | 见 `.docs/database.md:297-313` |

### 13.2 问题

| 编号 | 问题 | 影响 |
|---|---|---|
| P5 | 两级概念（提取器 → 方案 → 成员/模板）认知成本高，普通用户不会配置 | 绝大多数用户停留在默认值，功能复杂度只增加维护成本 |
| P6 | 默认方案 `members=[]` = 接入全部提取器，而内置含 `ai_netdisk` / `ai_summarize` 两个 AI 提取器（`SettingMain.vue:968-977`） | 一次 `Ctrl+B` 可能触发 **0–3 次 AI 调用**（2 个提取器 + 1 次分析），token 与延迟成倍增加，输出还会互相竞争 |
| P7 | AI 提取器输出不可预测，且缓存键弱（`.docs/code-review-2026-10.md` 2.5.2：键不含指令文本） | 改指令后窗口期内仍返回旧结果；与「结果可预期」的目标冲突 |
| P8 | 方案支持 body 模板重组（`renderSchemeBody`），与片段序列的语义耦合 | 出错面大：方案零产出/原文直通/模板占位符错写都要专门降级（历史 bug 见 `smart-clip-ai-analysis.md` 2026-09-18） |
| P9 | 配置变更递增 `configVersion`，影响解析缓存 | 复杂度外溢到处理层与缓存逻辑 |

### 13.3 目标

| 编号 | 目标 |
|---|---|
| G6 | **开箱即用、零配置**：默认管线不依赖任何用户配置，且默认输出与现状一致或更少（不产生 AI 提取器片段） |
| G7 | **单层、可预期**：删除「方案」概念；配置能力收敛为「自定义提取规则」一个可选列表；AI 调用全局唯一（分析阶段） |
| G8 | **数据不丢、可回滚**：旧配置只迁移不删除；revert 代码即可恢复旧编辑器与执行路径 |

---

## 14. 目标模型

### 14.1 单层管线（固定顺序）

```
内容
 ├─ 1. 结构层切分（json / links / log / path / multiline / separators）→ ≥2 段即采用
 ├─ 2. 技术/代码保护（verdict=tech）→ 不拆词，跳过 3~5
 ├─ 3. 内置精确切分器（URL → 邮箱，编译进代码、不可见、不可编辑）
 ├─ 4. 自定义提取规则（用户列表，按序；首个产出 ≥2 段的规则生效）
 ├─ 5. 内置分词兜底（不配规则也能按逗号/换行切句）
 ├─ 6. 关键词提取 / 超长分块 / 原文
 └─ 7. 仅 verdict=prose → 唯一一次 AI（关键词 / 要点 / 总结，见第一部分 §5.3）
```

> 顺序说明：分词内置器排在自定义规则**之后**——分词几乎能命中所有含逗号/换行的文本，
> 若排在其前会令自定义规则永远不生效；URL/邮箱是精确提取，排在其前可保证「链接列表」
> 优先按链接出段（与改造前默认方案的实际表现一致）。

与现状的差异：

- **首个命中即停止**（first-match-wins），不再把多个提取器的产出合并去重——结果可预测，避免同一段文字被 URL 规则与分词规则重复拆出。
- 删除 body 模板与成员编排：片段序列即最终结果，不再二次排版。
- AI 只发生在第 7 步，且全局 0–1 次；`ai_summarize` / `ai_netdisk` 提取器下线，其能力由分析阶段的「要点/总结」承担。

### 14.2 数据结构

```ts
/** 自定义提取规则（单层，不引入新概念） */
export interface ExtractRule {
  id: string;
  name: string;
  type: 'regex' | 'separator';   // 删除 'ai'：规则不得联网
  expression: string;             // 长度 ≤500
  enabled: 0 | 1;                 // 默认 1
}
```

约束：规则总数 ≤10；单条执行 `try/catch`，失败/非法正则跳过并在设置页标红；不提供 AI 类型，从类型层面杜绝隐式 AI 调用。

### 14.3 设置页形态（只删不增）

| 区域 | 现状 | 目标 |
|---|---|---|
| 智能剪贴板开关 | 有 | 保留（`off` 直通原文，语义不变） |
| 方案区（2378–2483） | 方案列表、成员勾选/排序、body 模板、AI 生成方案 | **整块删除** |
| 提取器区（2484–2630） | 提取器列表、增删改、排序、恢复内置、AI 草稿生成 | 收敛为「自定义提取规则（高级）」**折叠区，默认收起**：名称 / 类型（正则、分隔符）/ 表达式 / 启用 / 拖拽排序 / 删除 |
| 内置标记与恢复内置 | 有 | 删除（内置切分器不可见、不可编辑） |

说明：该变更只发生在设置页，不影响 `Ctrl+B` 环盘的任何界面元素（第一部分 §5.4 冻结清单仍然有效）。

### 14.4 迁移规则（一次性、幂等）

| 数据 | 处理 |
|---|---|
| 内置提取器（`builtin=1`） | 丢弃（由代码内置），不迁移 |
| 自定义 `regex` / `separator` 提取器 | 迁移为 `ExtractRule`，保留 `id/name/type/expression`，`enabled=1` |
| 自定义 `ai` 提取器 | **不迁移执行**；设置页顶部提示「N 条 AI 提取器已停用，其总结能力由智能分析替代」，用户可手动删除 |
| `clip_schemes` 表 / `smart_default_scheme_id` | **软弃用**：表与数据保留、不再读写（沿用 v17 `clip_rules` 先例） |
| 新存储 | `settings` KV `clip_extract_rules`（`{v:1, list: ExtractRule[], disabledAi: number}`）；新键存在即视为迁移完成，不重复迁移 |
| 旧键 `clip_extractors` | 只读保留，不删（回滚时可直接复用） |

输出差异（有意收敛）：

| 用户类型 | 改造前 | 改造后 |
|---|---|---|
| 未配置过（绝大多数） | 默认方案 = 全部提取器，含 2 个 AI 提取器 | 结构/内置规则切分；散文仅 1 次分析 AI（无 AI 提取器片段） |
| 有自定义正则/分隔符 | 方案合并产出 | 单层规则，首个命中即用 |
| 有自定义 AI 提取器 / 自定义方案 body | 执行 AI 提取器 / 套模板 | 停用并提示；片段直出（模板重组能力下线） |

---

## 15. 处理层改造点

| 文件 | 变更 |
|---|---|
| `app/src/smart-clip/smartClip.ts` | 删除 `activeScheme`、`ProcessContext.scheme`；`updateSmartClipConfig({ mode, rules })`；`processContent` 调用 `splitByPipeline()` |
| `app/src/smart-clip/pipeline.ts` | **新增**：单层切分管线 `splitByPipeline()` + 单条规则执行 `runExtractRule()`（复用 `ruleEngine`） |
| `app/src/smart-clip/autoSplit.ts` | 主入口拆为 `splitLocal(raw, splitters)`：结构层/技术保护不变，扩展切分器插在代码保护之后；`autoSplit` 保持原行为（无扩展切分器） |
| `app/src/smart-clip/template.ts` | **整体删除**：`runScheme` / `renderSchemeBody` / AI 提取器执行 / 输出契约 / 连接测试（均无调用方） |
| `app/src/smart-clip/extractors.ts` | 内置切分器收敛为代码常量（URL/邮箱/分词）；对外只保留 `loadExtractRules/persistExtractRules/createExtractRule/isExtractRuleValid` + 一次性迁移 |
| `app/src/smart-clip/aiGenerate.ts` | **整体删除**（不再提供 AI 草稿生成） |
| `app/components/setting/SettingMain.vue` | 删除方案区与 AI 生成相关状态/方法；提取器区收敛为默认收起的「自定义提取规则（高级）」折叠区 |
| `app/src/entities.ts` / `types.ts` | 新增 `ExtractRule`；`ProcessContext` 改为 `{ mode, rules }`；`ClipScheme` 仅由软弃用的仓储引用，旧编辑器已下线 |
| `app/src/db/dbService.ts` / `schemeRepository.ts` | 保留表与仓储（软弃用），不再新增调用方；新增 `fetchRecentImageQr`（第一部分内容源用） |

`Segment.extractorId` 语义保持：内置切分器沿用 `url_extract` / `email_extract` / `smart_tokenize`，自定义规则用规则 id，分析片段仍为 `ai-analysis`——历史习惯统计无需迁移。

---

## 16. 性能与稳定性收益

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 单次 `Ctrl+B` 的 AI 调用次数 | 0–3 次（2 个 AI 提取器 + 分析） | 0–1 次（仅散文分析） |
| 本地切分 IO | 读 `clip_extractors` KV / 方案表 | 内置规则零 IO；仅自定义规则读一次 KV |
| 失败面 | 方案零产出、直通、模板、AI 提取器缓存 | 规则执行失败单条跳过；无模板与方案降级分支 |
| 冷启动首次解析 | 需等 AI 提取器返回才有片段 | 本地片段先上屏，AI 仅补充分析片段 |

---

## 17. 测试计划（第二部分）

| 用例 | 断言 |
|---|---|
| 迁移：内置项 | 不写入新 KV 列表 |
| 迁移：自定义 regex/separator | 字段完整保留，`enabled=1` |
| 迁移：自定义 ai | 不迁移执行，返回停用计数供 UI 提示 |
| 迁移幂等 | 连续执行两次，结果一致、不重复 |
| 管线顺序 | 结构层命中即返回；技术内容跳过内置/自定义规则 |
| first-match-wins | 两条规则都能匹配时只采用第一条的产出 |
| 规则异常 | 非法正则/空表达式不抛错，继续下一条 |
| 规则上限 | 超过 10 条拒绝新增（UI 置灰） |
| 回归 | `autoSplit` / `analyzer` / `ringSegments` 现有用例全部保持通过 |
| 手工 | 未配置用户改造前后各 10 个示例输出对比（差异仅限 AI 提取器片段消失） |

---

## 18. 实施步骤（第二部分，独立于第一部分）

| # | 提交 | 内容 |
|---|---|---|
| 1 | `refactor: 截图智能切分改为单层管线（内置规则 + 自定义规则）` | `smartClip.ts` / `template.ts` / `extractors.ts` + 单测，行为等价（此时设置页仍读旧配置） |
| 2 | `feat: 提取器配置迁移为单层提取规则` | 迁移函数 + `clip_extract_rules` KV + 幂等单测 |
| 3 | `refactor: 设置页收敛提取器与方案编辑区` | 删除方案区/AI 生成，新增折叠规则区 |
| 4 | `refactor: 下线方案模型与 AI 提取器` | 删除 `template` 方案逻辑 / `aiGenerate.ts`；`clip_schemes` 软弃用；更新文档 |

回滚：第 1–4 步均为前端改动，`clip_schemes` 与 `clip_extractors` 数据保留，revert 后旧编辑器与执行路径可恢复。

---

## 19. 验收清单（第二部分）

- [ ] 设置页不再存在方案编辑器、成员编排、body 模板、AI 生成草稿入口
- [ ] 提取器编辑器收敛为默认收起的「自定义提取规则」区（仅正则/分隔符）
- [ ] 单次 `Ctrl+B` 的 AI 调用次数 ≤ 1（可用 mock/日志断言）
- [ ] 未配置用户的输出与改造前一致（除 AI 提取器片段不再产生）
- [ ] 自定义 regex/separator 提取器迁移后生效；AI 提取器停用并有提示
- [ ] `clip_schemes` / `clip_extractors` 数据未被删除，回滚可用
- [ ] `Ctrl+B` 环盘 UI 零 diff（第一部分 §5.4 冻结清单仍全部通过）
- [ ] `npm test` 全过、`npx vue-tsc --noEmit` 0 错误

---

## 20. 实施记录（v1.1 已落地）

| 项 | 结果 |
|---|---|
| 第一部分（§1–§12） | 新增 `smart-clip/clipboardSource.ts`（文本 → 图片二维码 → 文件 → 空，固定顺序）；`BubbleToggleCommand` 接入唯一内容源并删除历史回退；`analysis.ts` 移除 `buildDigest` / `habitHint` 注入、契约新增 `bullets`；`mergeAiSegments` 顺序 关键词→要点→总结；新增 4 条 Ctrl+B 边界岛提示（zh/en） |
| 第二部分（§13–§19） | `ExtractRule` 单层模型 + `pipeline.ts`（内置精确切分器 → 自定义规则 → 内置分词）；`template.ts` / `aiGenerate.ts` 删除；设置页方案区与提取器编辑区下线，收敛为默认折叠的「自定义提取规则（高级）」；`clip_extractors` 一次性迁移到 `clip_extract_rules`，`clip_schemes` / 旧键软弃用 |
| 新增单测 | `clipboardSource.spec.ts`（7 例）、`extractors.spec.ts`（7 例）、`pipeline.spec.ts`（9 例） |
| 全量验证 | `npm test`：41 个文件 / 432 个用例全部通过；`npx vue-tsc --noEmit`：0 错误 |
| 未改动 | `RingOverlay.vue` / 环盘窗口参数 / 快捷键注册 / 八级分流阈值 / `aiClient` 协议与超时（`bubble.vue` 的 AI 投递校验见 §21） |

---

## 21. 结果归属校验（增量修复）

**问题**：AI 分析缓存仅以「`analysis:` + 32 位 djb2 内容 hash + 版本号」为键，且缓存值不带来源信息。键碰撞（djb2 为多项式哈希，结构性碰撞可构造；自然碰撞虽罕见但确实存在）或任何键拼接错位，都会让命中的缓存被当作**当前对象**的分析结果展示——表现为「某个无法分析的对象显示了此前另一个条目的分析结果」。环盘的 AI 补位事件亦只按窗口投递、载荷不带归属信息，页面侧无法自证结果属于本次内容。

**修复**（三层归属校验）：

| 层 | 机制 | 拒绝条件 |
|---|---|---|
| 内容身份 | `contentFingerprint()`（djb2 + FNV-1a + 长度），替代单一 32 位 hash 作为缓存键 | 指纹不同 |
| 缓存信封 | `analysisCache.encodeAnalysisCache/decodeAnalysisCache`：缓存值为 `{ v:2, fp, len, head, tail, result }`，读取时逐项比对当前内容 | 版本非 2（旧格式无法证明归属）/ 指纹 / 长度 / 首尾 64 字符任一不符 → 按未命中重新分析 |
| 事件投递 | `ring:ai-result` 载荷新增 `contentHash`；`bubble.vue` 严格比对本页 `ringContentHash` | 不相等即丢弃 |

**配套**：`BubbleToggleCommand.execute` 增加开环重入锁（`opening`）——`openRing` 内多次 `await` 期间 `ring` 尚未赋值，此前连按会并发建出两只环，前一只窗口无人关闭，其旧内容/旧分析结果滞留在屏幕上。

**兼容性**：缓存键变更使旧条目自然失效；分析缓存窗口仅 300s（`ai_result_window`），无迁移成本，无 DB schema 变更。`hashText` 语义不变（习惯/统计分组口径不受影响）。

**测试**：`app/src/smart-clip/__tests__/analysisCache.spec.ts`（信封往返、异内容拒绝、旧格式拒绝、篡改拒绝、字段清洗）。

---

## 22. AI 智能提取开关与分隔符/多行放行（增量）

**问题**：八级分流把「分隔符命中」一律判为结构化，导致 `我们的发布流程分为三段：…、…；…` 这类**最值得总结的说明文**永远不送 AI，用户看到环盘只有本地切分片段，误以为 AI 分析未开启；且当时没有任何开关可开。

**改动**：

| 项 | 内容 |
|---|---|
| 设置开关 | 设置 → AI → 「AI 智能提取」开关（默认开启），KV `ai_analysis_enabled`（`'1'`/`'0'`，缺省按开启）。关闭后 `planAnalysis` 直接返回 `skipped(disabled)`，环盘只做本地切分；开关即时落库，不等防抖（§23 已将该单开关拆分为三个独立开关并迁移） |
| 分流放行 | `analyzeVerdict` 中 `detectStructured` 命中 `separators` / `multiline` 时不再直接判 `structured`，继续走高熵 → 技术工件 → 噪声 → 简单词串 → 过短 → 散文；JSON / 链接 / 日志 / 路径仍直接本地处理不放行 |
| 隐私边界 | 「技术内容不外发」不变：代码、SQL、命令、密钥/编码、噪声仍在放行后的下游判定被拦截 |

**测试**：`app/src/smart-clip/__tests__/analyzer.spec.ts`（示例说明文 → `prose`；多行散文 → `prose`；JSON → `structured`；代码 → `tech`；噪声/超长/过短不变）。

---

## 23. 三个独立功能开关 + 关键词数量控制（增量）

**需求**：本地切分、AI 分析关键字、AI 总结三个模块各自独立开关，统一放在「智能与AI」设置页；本地切分与 AI 关键字互斥（关键字关闭 → 本地切分不得启用）；AI 关键字数量上下限可调（默认上限 16）；AI 总结保留 Ctrl+B 现有快捷方式且默认开启；任何依赖/配置异常经灵动岛如实提示；全部开关持久化。

**实现**：

| 项 | 内容 |
|---|---|
| 开关 KV | `local_split_enabled` / `ai_keywords_enabled` / `ai_summary_enabled`，缺省开启，`'0'` 关闭；设置页切换即时落库（不等防抖），启动时读取并回填 |
| 模式推导 | `planAnalysis` 读双 AI 开关：全开 `both`；仅关键字 `keywords`；仅总结 `summary`；全关 `skipped(disabled)`。system 指令按模式生成，未开启的字段不索要 |
| 互斥约束 | `refreshSmartClipConfig` 推送 `splitEnabled = 本地切分 && AI 关键字`；`smartClip.resolveContext` 兜底同式；设置页关闭关键字时同步把本地切分落库为 `'0'` 并置灰开关（`disabled-tip` 说明原因） |
| 本地切分关闭 | `processContent` 直通原文单段（与 `smart_clip_mode=off` 同路径），AI 结果仍可追加；若 AI 也全关则环盘无可展示片段，灵动岛提示后不开环 |
| 关键词数量 | `ai_keywords_min`（默认 3）/ `ai_keywords_max`（默认 16）：prompt 约束 + `parseAnalysisOutput` 按 max 截断；硬上限 18（环盘 24 段容量扣除要点 5 + 总结 1）；下限大于上限时归一为上限 |
| 缓存隔离 | 缓存键追加 `mode` 与 `min-max`：切换开关或数量后不复用另一形态的结果 |
| 异常提示 | 未配置 / 两个 AI 开关全关 / 内容过长 / 技术内容 / 高熵 / 噪声 / 过短 / 调用失败：均由灵动岛给出原因与状态，不静默 |
| 迁移 | 新键缺省且旧 `ai_analysis_enabled='0'` → 两个 AI 能力视为关闭（无需打开设置页）；旧键保留不删 |

**测试**：`analysisSwitches.spec.ts`（钳制/归一/模式裁剪/上限截断/无效产出）、`analysisCache.spec.ts`（关键词上限参数化）、`analyzer.spec.ts`（分流回归）。

### 23.1 列表条目显式分析入口（增量）

`Ctrl+B` 仍只读当前系统剪贴板。为覆盖「剪贴板里是图片、要分析的文本躺在历史里」的场景，列表文本/富文本条目右键新增「AI 分析本条」：

- 入口：`index.vue` 右键菜单（仅 `text` / `html` 条目）→ `analyzeClipboardItemContent(item.content)`
- 管线：与 `Ctrl+B` 完全一致（`openRing(contentOverride)` → 本地切分 → `planAnalysis` → 环盘两阶段上屏），开关/关键词范围/互斥/异常岛提示全部复用
- 边界：内容由用户显式点名，不属于 §3「单一内容源」所禁止的隐式回退；不读选中项、不做任何历史兜底
- 并发：复用模块级 `opening` 锁与 `ring` 会话，开环期间重复触发被忽略

---

## 24. 内容源优先级（增量：选中项优先）

**需求**：Ctrl+B 分析「当前选中的那一项」，而不是列表第一项或剪贴板里的旧内容。

**优先级**（`openRing`）：

| 顺序 | 来源 | 条件 |
|---|---|---|
| 1 | 右键点名条目 | `openRing(contentOverride)`，用户显式触发 |
| 2 | **列表当前选中项** | 主窗口 `isVisible()` 且选中条目为 `text` / `html` 且内容非空 |
| 3 | 系统剪贴板 | 其余情况（窗口隐藏 / 选中项为图片、文件 / 无选中） |

**约束**：

- 窗口不可见时不采用选中项——此时选择可能已过期，会重现「分析结果与对象不符」的历史问题（§1 P1）
- 选中项为图片/文件时回落到剪贴板链路，图片仍走二维码分支
- 判定函数 `pickSelectedRingContent`（`clipboardSource.ts`）为纯函数，单测覆盖文本/富文本/图片/文件/空内容/未选中
- 新增能力权限 `core:window:allow-is-visible`（`src-tauri/capabilities/default.json`）

**取舍**：窗口可见时「选中项」压过剪贴板。若用户在主窗口开着时从外部复制了新内容再按 Ctrl+B，分析的是选中项——这是本需求要求的行为；需要分析刚复制的内容时，取消选中或最小化窗口即可。
