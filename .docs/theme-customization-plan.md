# 自定义主题色（兼容系统主题）设计与实施计划

> 版本：v1.0  
> 编制日期：2026-11-20  
> 状态：计划评审中（Gate 1；入口形态已确认：设置页内嵌面板）  
> 适用项目：s1de-board（Nuxt 4 + Vue 3 + Tailwind v4 + Tauri 2）

## 1. 背景与目标

### 1.1 现状

当前应用已有四档配色模式 `system / default（琥珀）/ light / dark`，实现方式为 `<html data-scheme>` 属性切换 `main.css` 中的变量组：

- 令牌定义：`app/assets/css/main.css`（RGB 通道三元组，供 Tailwind `rgb(var(--x) / alpha)` 消费）
- 模式解析与持久化：`app/composables/useColorScheme.ts`
- 全局初始化插件：`app/plugins/colorScheme.ts`
- 设置入口：`app/components/setting/SettingMain.vue`（外观与语言分组）
- 跨窗口同步：Tauri 事件 `scheme:changed`
- 原生跟随：`set_menu_theme` + `getCurrentWindow().setTheme()`

现有系统缺少：用户自定义颜色、多套方案管理、主题模板导入导出。

### 1.2 目标

| 模块 | 目标 | 成功标准 |
|---|---|---|
| 自定义主题色 | 用户可视化编辑语义色令牌，实时预览 | 修改后 ≤50ms 全局生效，无刷新、无重启 |
| 多套配色方案 | 新建/复制/重命名/删除/启用，持久化 | 方案 CRUD 全可用；重启、升级、跨窗口保持一致 |
| 主题模板封装 | 预设模板一键应用；主题 JSON 一键导入导出 | 导出→导入语义无损；非法文件被明确拒绝 |
| 系统主题兼容 | 每套主题同时定义浅色/深色变体，跟随系统自动切换 | 系统明暗切换时，自定义主题同步切换且显示一致 |
| 无障碍与性能 | 对比度校验、切换性能预算、多 WebView 兼容 | 达到第 7 节质量门禁 |

### 1.2.1 兼容承诺（强约束）

原有四档主题 **全部保留、行为不变**，自定义主题只做增量扩展：

| `color_scheme` 取值 | 解析结果 | 保留要求 |
|---|---|---|
| `system` | 系统深色 → `dark`，系统浅色 → `default（琥珀）` | 默认值不变，系统切换逻辑不变 |
| `default` | 琥珀（暖米色） | 变量值、视觉不变 |
| `light` | 浅色（中性白灰） | 变量值、视觉不变 |
| `dark` | 深色（Darcula） | 变量值、视觉不变 |
| `custom`（新增） | 自定义主题的 `light` / `dark` 变体 | 仅从「设置 → 通用设置 → 外观 → 主题方案管理」启用 |

补充约束：

- 设置页原有的四选一配色下拉**保持原样**，不替换、不合并；主题管理作为其下方独立入口。
- 快捷键 `cycle_color_scheme` 仍只循环原四档（跟随系统 → 琥珀 → 浅色 → 深色），不插入自定义主题。
- 未创建/未启用任何自定义主题时，应用行为与升级前完全一致。
- 从自定义主题切回任意原四档时，清除全部内联变量，恢复 `data-scheme` 原生行为，无颜色残留。

### 1.3 非目标（本期不做）

- 不开放任意 CSS 属性 / 任意选择器编辑（仅白名单令牌）。
- 不改变业务组件结构，不重写现有 Tailwind 工具类。
- 不引入第三方主题/颜色运行时库（保持零新增运行时依赖）。
- 不做主题商店、云同步、在线分享。

## 2. 设计原则与约束

1. **令牌单一来源**：所有可编辑令牌由一份 `themeTokens.ts` 描述，CSS 变量、编辑器表单、校验、导入导出均从该表派生，禁止三处手写。
2. **变量注入而非换表**：自定义主题通过 `document.documentElement.style.setProperty` 覆盖 CSS 变量，不动态生成 `<style>`，避免样式表解析与级联抖动。
3. **RGB 通道存储**：沿用 `--c-*: R G B` 格式，保证 Tailwind 透明度修饰符、`color-mix` 行为与现有主题完全一致。
4. **双变体**：每套主题必须同时提供 `light` / `dark` 两套令牌，跟随系统时按 `prefers-color-scheme` 解析，保证「自定义主题 + 系统主题」不打架。
5. **持久化双写**：settings KV 为准 + localStorage 运行时快照（首帧同步恢复，消除启动闪烁）。
6. **跨窗口一致**：所有窗口共用同一主题事件总线，KV 为唯一事实源，事件只做通知。
7. **失败可回退**：任何非法主题、导入失败、变量缺失，都回退到内置基准主题，不允许出现不可读界面。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────┐
│ UI 层  ThemeManager / TokenEditor / PresetGallery     │
│        ContrastBadge / ImportExportPanel              │
├──────────────────────────────────────────────────────┤
│ 运行时 useTheme / useColorScheme                       │
│        解析系统明暗 → 选择变体 → 注入变量 → 广播事件     │
├──────────────────────────────────────────────────────┤
│ 领域层 themeModel / themeValidation / themePresets    │
│        主题定义、校验、迁移、对比度、令牌派生            │
├──────────────────────────────────────────────────────┤
│ 存储层 themeStorage                                    │
│        settings KV（主）+ localStorage（首帧快照）      │
├──────────────────────────────────────────────────────┤
│ 令牌层 themeTokens + colorUtils                        │
│        白名单、默认值、hex/RGB/HSL/对比度/派生算法       │
└──────────────────────────────────────────────────────┘
```

### 3.1 文件规划

| 类型 | 文件 | 职责 |
|---|---|---|
| 新增 | `app/src/theme/themeTokens.ts` | 令牌白名单：key、CSS 变量名、分组、名称、默认浅/深值、是否高级 |
| 新增 | `app/src/theme/colorUtils.ts` | hex↔rgb、hex↔hsl、相对亮度、对比度、明暗自动建议 |
| 新增 | `app/src/theme/themeModel.ts` | `ThemeDefinition` 类型、默认主题工厂、深拷贝、ID 生成 |
| 新增 | `app/src/theme/themeValidation.ts` | 导入校验、字段白名单、体积/数量限制、版本迁移 |
| 新增 | `app/src/theme/themeStorage.ts` | KV 读写、localStorage 运行快照、旧数据兼容 |
| 新增 | `app/src/theme/themePresets.ts` | 内置预设模板（含浅/深变体） |
| 新增 | `app/src/theme/themeApply.ts` | 变量注入/清除、`data-scheme`、`color-scheme` 设置 |
| 新增 | `app/src/theme/__tests__/*.spec.ts` | 颜色算法、校验、派生、存储、注入单测 |
| 新增 | `app/composables/useTheme.ts` | 主题列表状态、CRUD、启用、导入导出、跨窗口同步 |
| 新增 | `app/components/theme/ThemeManager.vue` | 设置页内嵌主题管理面板：方案列表 + 编辑器 + 预设 + 导入导出 |
| 新增 | `app/components/theme/ThemeTokenEditor.vue` | 令牌分组编辑、取色器、对比度提示 |
| 新增 | `app/components/theme/ThemePreview.vue` | 当前主题的组件样张实时预览 |
| 修改 | `app/composables/useColorScheme.ts` | 扩展 `custom` 模式、变体解析、快照恢复 |
| 修改 | `app/plugins/colorScheme.ts` | 启动时同步恢复自定义主题 |
| 修改 | `app/assets/css/main.css` | 增加 `[data-scheme='custom']` 兜底与主题相关工作注释（不改令牌语义） |
| 修改 | `app/components/setting/SettingMain.vue` | 外观分组内嵌「主题方案管理」折叠面板，挂载 `ThemeManager` |
| 修改 | `app/src/setting/settingGroups.ts` | 设置搜索索引新增主题管理项 |
| 修改 | `app/assets/lang/zh-cn.toml`、`en-us.toml` | 新增主题管理文案 |
| 修改 | `.docs/features/settings.md` | 功能说明同步 |

> 不新增数据库表：主题数据走 `settings` KV，避免 schema 迁移，且与现有跨窗口读写路径一致。主题不进入「数据备份」（现有备份明确排除 settings），可移植性由模板导入导出承担。

### 3.2 数据模型

```ts
export type ThemeVariant = 'light' | 'dark';

export interface ThemeTokens {
  // 基础可编辑令牌（高级模式下再暴露派生令牌）
  primary: string;      // 页面底色 #rrggbb
  surface: string;      // 卡片/面板底色
  ink: string;          // 主文字
  accent: string;       // 品牌强调色（对应现有 gold）
  line: string;         // 描边
  danger: string;
  success: string;
  // 派生令牌由算法生成，也允许高级模式覆盖
  secondary?: string;
  surfaceField?: string;
  goldSoft?: string;
  onGold?: string;
  inkSoft?: string;
  inkFaint?: string;
  code?: string;
  shadow?: string;
  highlight?: string;
  highlightInk?: string;
  // 背景渐变、光晕、玻璃拟态、tip 气泡
  bgA?: string; bgB?: string; bgC?: string;
  glowA?: string; glowB?: string;
  glassBg?: string; tipBg?: string; tipText?: string;
}

export interface ThemeDefinition {
  schemaVersion: 1;
  id: string;              // uuid
  name: string;            // 1-24 字符
  description?: string;    // <=120 字符
  builtin?: boolean;       // 预设副本为 false，可编辑
  createdAt: number;
  updatedAt: number;
  variants: Record<ThemeVariant, ThemeTokens>;
}
```

存储键：

| 键 | 内容 | 说明 |
|---|---|---|
| `theme_custom_themes_v1` | `ThemeDefinition[]` | 用户主题列表（JSON，建议上限 50 套） |
| `theme_active_id_v1` | `string` | 当前启用的自定义主题 ID |
| `theme_variant_policy_v1` | `system \| light \| dark` | 自定义主题的变体策略，默认 `system` |
| `theme_runtime_snapshot_v1` | `{ themeId, variant, vars, updatedAt }` | localStorage 首帧快照，仅缓存 |

向后兼容：

- 原四档 `system/default/light/dark` 的取值、默认值、解析逻辑、视觉变量全部保持不变。
- 新增第五个取值 `custom`；设置页原四选一下拉保持原样，主题管理为独立入口。
- 旧客户端读到 `custom` 会回退到 `system`，不会崩溃。
- 主题 JSON 导入采用 `schemaVersion`，未知字段忽略，缺失字段补默认值。
- `cycle_color_scheme` 不感知 `custom`，仍按原四档循环，避免改变既有快捷键行为。

### 3.3 令牌与派生规则

基础令牌（基本模式可编辑，8 个）：

| 令牌 | CSS 变量 | 作用 | 校验 |
|---|---|---|---|
| primary | `--c-primary` | 页面主背景 | 与 ink 对比度 ≥ 4.5 |
| surface | `--c-surface` | 卡片/面板 | 与 ink 对比度 ≥ 4.5 |
| ink | `--c-ink` | 主文字 | 与 primary/surface 对比度 ≥ 4.5 |
| accent | `--c-gold` | 品牌/强调/焦点 | 与非文字背景对比度 ≥ 3.0 |
| line | `--c-line` | 分隔线/描边 | 与 surface 对比度 ≥ 1.5（装饰性） |
| danger | `--c-danger` | 危险操作 | 与 surface 对比度 ≥ 4.5 |
| success | `--c-success` | 成功/低优先级 | 与 surface 对比度 ≥ 4.5 |
| shadow | `--c-shadow` | 阴影基色 | 任意有效颜色 |

派生令牌（高级模式可覆盖）：

- `secondary` = primary 向 ink 混合 8%
- `accentSoft` = accent 向 primary 混合 35%
- `surfaceField` = surface 向 primary 混合 50%
- `inkSoft` = ink 向 primary 混合 30%
- `inkFaint` = ink 向 primary 混合 50%
- `onGold` = 在 `#ffffff` / `#1b1c1e` 中选与 accent 对比度更高者
- `bgA/bgB/bgC` = primary 的轻微明度阶梯
- `glowA/glowB` = accent 与 line 的低透明色
- `glassBg` 固定白/黑，透明度按明暗变体切换（0.45/0.04）
- `tipBg/tipText` = ink / primary 反转，保证 tooltip 对比度

派生算法放在 `colorUtils.ts`，纯函数、可单测；编辑器展示「自动派生 / 手动覆盖」开关。

### 3.4 运行时注入

启用自定义主题时执行：

1. 解析变体：`variantPolicy = system` 时取 `prefers-color-scheme`，否则取指定变体。
2. 取该变体令牌 → 派生补全 → 转成 `"r g b"` 通道。
3. `document.documentElement.style.setProperty('--c-primary', '240 233 225')` 批量写入（约 25 个变量，单次任务 <2ms）。
4. 设置 `data-scheme="custom"`、`data-theme-variant="light|dark"`、`style.colorScheme`。
5. 写入 localStorage 快照，广播 `theme:changed`。
6. 原生层：`getCurrentWindow().setTheme('light'|'dark')`；托盘菜单沿用 `set_menu_theme`，按解析变体映射。

切回内置主题时，逐项 `removeProperty`，删除 `data-theme-variant`，恢复 `data-scheme`，避免残留覆盖。

系统切换监听：沿用 `matchMedia('(prefers-color-scheme: dark)')` 的 `change`，仅当当前为 `custom + system` 时重新注入，不刷新页面、不重建组件。

### 3.5 多方案与模板

- **列表**：卡片展示名称、浅/深双色预览、启用状态、更新时间；支持搜索、复制、重命名、删除（至少保留 1 套）。
- **编辑**：左侧令牌分组，右侧实时预览；修改为草稿态，「保存」落库，「取消」丢弃。
- **预设**：内置 6 套模板（琥珀、石墨、Darcula、森林、深海、玫瑰），一键应用 = 复制为可编辑用户主题，不覆盖原预设。
- **导入导出**：
  - 导出单个/全部，格式 `{ format: 's1de-board-theme', schemaVersion: 1, exportedAt, themes: [...] }`。
  - Tauri 使用 `@tauri-apps/plugin-dialog` + `plugin-fs`；纯 Web 回退 `<a download>` 与 `<input type=file>`。
  - 导入前校验：格式标识、版本、体积 ≤256KB、数量 ≤50、名称长度、颜色格式、令牌白名单；同名追加 `(2)`，同 ID 重新生成。
  - 导入后展示预览，用户确认再落库；失败给出具体原因，不写入半成品。

## 4. 五阶段实施计划

### 4.1 阶段总览

| 阶段 | 时间节点 | 关键交付物 | 责任人 | 阶段门禁 |
|---|---|---|---|---|
| P1 需求梳理 | 2026-11-20 ~ 11-23 | 需求边界、令牌清单、兼容基线、验收用例 | 产品/主程 | Gate 1：范围与令牌冻结 |
| P2 技术选型 | 2026-11-24 ~ 11-25 | 注入/存储/导入导出/对比度方案 PoC + ADR | 前端架构 | Gate 1：方案评审通过 |
| P3 核心开发 | 2026-11-26 ~ 12-09 | 三大模块代码、设置入口、i18n、单测 | 前端/桌面端 | 功能自测通过 |
| P4 联调测试 | 2026-12-10 ~ 12-14 | 兼容/性能/无障碍/回归报告，缺陷清零 | QA/前端 | Gate 2：质量门禁通过 |
| P5 上线验证 | 2026-12-15 ~ 12-16 | 安装包、发布说明、灰度验证、回滚演练 | 发布负责人 | 发布验收通过 |

> 人日估算：P1 2 人日、P2 2 人日、P3 10 人日、P4 3 人日、P5 2 人日，合计 19 人日。当前项目可由主程兼任全部角色，评审后替换为实际姓名。

### 4.2 P1 需求梳理（11-20 ~ 11-23）

| 编号 | 任务 | 责任人 | 依赖 | 交付物 | 验收标准 | 时间 |
|---|---|---|---|---|---|---|
| 1.1 | 盘点现有四配色、令牌、跨窗口、原生跟随链路 | 主程 | 现有代码 | 现状与兼容基线说明 | 覆盖 `useColorScheme`、`main.css`、设置页、Tauri 原生主题 | 11-20 |
| 1.2 | 确定可编辑令牌范围与派生规则 | 主程 | 1.1 | 令牌清单（基础 8 + 高级 20） | 每个令牌有变量名、用途、默认值、对比度要求 | 11-20 |
| 1.3 | 明确三模块边界与非目标 | 产品/主程 | 1.1 | 需求边界文档 | 三模块范围、非目标、用户故事齐全 | 11-21 |
| 1.4 | 输出验收用例与兼容矩阵 | QA/主程 | 1.2 | 用例清单（功能/兼容/性能/无障碍） | 每条用例可执行、可判定 | 11-23 |
| 1.5 | Gate 1 评审：范围与令牌冻结 | 全体 | 1.1-1.4 | 评审记录 | 无未决范围争议 | 11-23 |

### 4.3 P2 技术选型（11-24 ~ 11-25）

| 编号 | 任务 | 责任人 | 依赖 | 交付物 | 验收标准 | 时间 |
|---|---|---|---|---|---|---|
| 2.1 | 注入方案对比：html inline style vs 动态 `<style>` vs CSSOM | 前端架构 | 1.2 | PoC + ADR | 选定方案切换 ≤50ms，无样式闪烁 | 11-24 |
| 2.2 | 存储方案对比：settings KV vs localStorage vs IndexedDB | 前端架构 | 1.1 | PoC + ADR | 首帧无快切，跨窗口一致，失败可回退 | 11-24 |
| 2.3 | 导入导出方案：Tauri dialog/fs vs Web File API | 桌面端 | 1.3 | PoC + ADR | Windows/macOS/Linux 均可完成导入导出 | 11-25 |
| 2.4 | 对比度算法与自动修正策略 | 前端架构 | 1.2 | `colorUtils` 原型 + 单测 | WCAG 2.1 公式验证通过（黑白对比 21:1） | 11-25 |
| 2.5 | 主题 JSON Schema 与版本迁移策略 | 主程 | 1.2 | Schema v1 + 校验规则 | 非法样本全部拒绝，合法样本往返一致 | 11-25 |
| 2.6 | Gate 1 技术评审 | 全体 | 2.1-2.5 | ADR 文档 | 方案、风险、回滚路径明确 | 11-25 |

### 4.4 P3 核心开发（11-26 ~ 12-09）

| 编号 | 模块 | 任务 | 责任人 | 依赖 | 交付物 | 验收标准 | 时间 |
|---|---|---|---|---|---|---|---|
| 3.1 | 令牌层 | `themeTokens.ts` + `colorUtils.ts` | 前端 A | 2.4 | 令牌表、颜色算法 | 单测覆盖 hex/RGB/HSL/亮度/对比度/派生；`npm test` 全绿 | 11-26 |
| 3.2 | 领域层 | `themeModel.ts` + `themeValidation.ts` | 前端 A | 2.5、3.1 | 类型、默认工厂、校验、迁移 | 合法/非法样本用例 100% 通过 | 11-27 |
| 3.3 | 存储层 | `themeStorage.ts` | 前端 A | 2.2、3.2 | KV + snapshot 读写 | 重启恢复、镜像缺失回退、并发写不丢数据 | 11-30 |
| 3.4 | 运行时 | `themeApply.ts` + `useTheme.ts` | 前端 A | 3.1、3.3 | 注入、CRUD、启用、跨窗口事件 | 启停 ≤50ms；子窗口实时跟随；切回内置无残留 | 12-01 |
| 3.5 | 系统兼容 | 扩展 `useColorScheme.ts` + 插件 | 桌面端 | 3.4 | `custom` 模式、变体解析、原生主题映射 | 原四档逐项回归无变化；custom 系统明暗切换 500ms 内完成；标题栏/托盘菜单同步 | 12-02 |
| 3.6 | 管理 UI | `ThemeManager.vue` + `ThemeTokenEditor.vue` | 前端 B | 3.3、3.4 | 方案列表、CRUD、编辑器 | 新建/复制/重命名/删除/启用全通过；草稿可取消 | 12-04 |
| 3.7 | 预览与无障碍 | `ThemePreview.vue` + `ContrastBadge` | 前端 B | 3.1、3.6 | 实时样张、对比度提示 | 不达标即时提示；支持一键建议色 | 12-05 |
| 3.8 | 模板 | `themePresets.ts` + 导入导出面板 | 桌面端 | 3.2、3.6 | 6 套预设、JSON 导入导出 | 预设一键应用；往返语义一致；非法文件有明确错误 | 12-08 |
| 3.9 | 集成 | 设置页内嵌面板、`settingGroups.ts`、i18n | 前端 B | 3.6 | 入口、折叠面板、文案 | 中英文齐全；设置搜索可定位；展开/收起正常且不影响其他设置项 | 12-09 |
| 3.10 | 测试 | 单元/组件测试 | 前端 A/B | 3.1-3.9 | 测试用例 | 新增逻辑覆盖率 ≥80%，全量 `npm test` 通过 | 12-09 |

### 4.5 P4 联调测试（12-10 ~ 12-14）

| 编号 | 任务 | 责任人 | 依赖 | 交付物 | 验收标准 | 时间 |
|---|---|---|---|---|---|---|
| 4.1 | 多窗口联调：主窗/查看器/tooltip/托盘菜单/便签配色窗 | 前端/桌面端 | 3.5、3.9 | 联调记录 | 所有窗口配色一致，切换无延迟、无残留 | 12-10 |
| 4.2 | 多 WebView 兼容：WebView2 / WKWebView / WebKitGTK | QA | 3.10 | 兼容矩阵报告 | 三平台浅/深色显示一致，滚动条/玻璃拟态/tooltip 正常 | 12-11 |
| 4.3 | 性能测试：切换耗时、长任务、内存、启动开销 | QA | 3.10 | 性能报告 | 切换 P95 ≤50ms；无 >50ms 长任务；100 次切换无内存增长；启动 ≤30ms | 12-12 |
| 4.4 | 无障碍：对比度、焦点可见、reduced-motion | QA | 3.7 | 无障碍报告 | 正文 ≥4.5:1；非文字 ≥3:1；焦点环可见；动画降级正常 | 12-13 |
| 4.5 | 回归：现有四配色、设置页、备份导入导出 | QA | 3.10 | 回归报告 | 原有功能零回归；备份不含主题且不影响数据 | 12-14 |
| 4.6 | 缺陷修复与 Gate 2 评审 | 全体 | 4.1-4.5 | 缺陷清单、评审记录 | P0/P1 缺陷清零，P2 有明确计划 | 12-14 |

### 4.6 P5 上线验证（12-15 ~ 12-16）

| 编号 | 任务 | 责任人 | 依赖 | 交付物 | 验收标准 | 时间 |
|---|---|---|---|---|---|---|
| 5.1 | 构建与 CI 打包 | 发布负责人 | Gate 2 | Windows/macOS/Linux 安装包 | 构建成功，版本号与 CHANGELOG 一致 | 12-15 |
| 5.2 | 发布说明与文档 | 主程 | 5.1 | CHANGELOG、功能文档 | 说明自定义主题、导入导出、回滚方式 | 12-15 |
| 5.3 | 灰度/安装验证 | QA | 5.1 | 验证记录 | 全新安装、覆盖升级、旧配置迁移均正常 | 12-16 |
| 5.4 | 回滚演练 | 发布负责人 | 5.1 | 回滚记录 | 关闭自定义主题后界面恢复默认；旧版本可启动 | 12-16 |

## 5. 责任矩阵（RACI）

| 模块 | 负责（R） | 审批（A） | 协作（C） | 知会（I） | 主要依赖 |
|---|---|---|---|---|---|
| 令牌与颜色算法 | 前端 A（主程） | 前端架构 | QA | 产品 | 无 |
| 主题存储与运行时 | 前端 A（主程） | 前端架构 | 桌面端 | QA | settings KV、Tauri event |
| 系统主题/原生跟随 | 桌面端 | 前端架构 | 前端 A | QA | `useColorScheme`、Rust `set_menu_theme` |
| 管理 UI 与编辑器 | 前端 B | 产品 | 前端 A | QA | 令牌层、`UiColorPicker` |
| 模板与导入导出 | 桌面端 | 前端架构 | 前端 B | 产品 | dialog/fs 插件、校验层 |
| 测试与验收 | QA | 发布负责人 | 前端 A/B | 全体 | 测试用例、安装包 |

> 当前人员不足时由主程兼任 R，审批角色保留评审职责；Gate 1/Gate 2 必须留评审记录。

## 6. 依赖与风险

### 6.1 依赖项

| 依赖 | 类型 | 影响 | 应对 |
|---|---|---|---|
| Tailwind v4 `@theme inline` 令牌映射 | 技术 | 变量覆盖必须保持 `rgb(var(--x))` 形态 | P2 PoC 验证，禁止改动 `@theme` 结构 |
| settings KV（SQLite/IPC） | 基础设施 | 主题列表持久化 | 复用现有 `dbService`，不新增表 |
| Tauri dialog/fs 插件 | 平台能力 | 导入导出 | 已在 `package.json` 与 capabilities 中启用 |
| Tauri 窗口主题 API | 平台能力 | 原生标题栏/托盘菜单跟随 | 复用现有 `setTheme` 与 `set_menu_theme`，不新增窗口 |
| `prefers-color-scheme` | 系统能力 | 跟随系统 | WebView2/WKWebView/WebKitGTK 均支持；缺失时回退 light |
| 现有 `UiColorPicker` | 组件 | 取色交互 | 直接复用，不重复实现色环 |

### 6.2 风险登记

| 编号 | 风险 | 概率 | 影响 | 应对方案 | 责任人 |
|---|---|---|---|---|---|
| R1 | 自定义变量与 Tailwind 令牌冲突，部分工具类失效 | 中 | 高 | 仅覆盖既有变量名；P2 用样张页逐项验证；不改 `@theme` | 前端架构 |
| R2 | 启动首帧闪烁（先默认色后自定义色） | 高 | 中 | localStorage 运行快照 + 插件同步注入；主窗口首帧后才 show | 前端 A |
| R3 | 跨窗口不同步或各窗口变体不一致 | 中 | 高 | KV 唯一事实源 + `theme:changed` 广播 + 快照版本号校验 | 前端 A |
| R4 | 系统明暗切换时原生标题栏/托盘菜单不跟随 | 中 | 中 | 监听 `matchMedia`，复用 `setTheme`/`set_menu_theme`，菜单重建 | 桌面端 |
| R5 | 导入恶意/损坏 JSON 导致崩溃或污染 | 低 | 高 | 白名单校验、体积/数量限制、原型污染防护、原子写入 | 桌面端 |
| R6 | 用户配出低对比度主题，影响可读性 | 高 | 中 | 编辑时实时对比度徽标 + 一键修正；预设全部通过 AA | 前端 B |
| R7 | 切换性能不达标（重排/长任务） | 低 | 中 | 只改变量、rAF 批处理、不做逐元素样式操作；P4 性能门禁 | 前端 A |
| R8 | 旧版本/旧配置不兼容 | 中 | 中 | 新增键命名空间；未知字段忽略；缺失字段补默认；保留旧 `color_scheme` | 前端 A |
| R9 | 主题数据不进入现有备份，换机丢失 | 中 | 低 | 提供模板导出/导入；文档明确说明 | 产品 |
| R10 | 设置页内嵌面板导致 `SettingMain.vue` 体积/渲染回归 | 中 | 中 | 面板拆分为独立组件；折叠时懒渲染；回归设置页全部交互 | 前端 B |

## 7. 质量门禁与验收标准

### 7.1 功能验收

| 模块 | 验收项 | 判定 |
|---|---|---|
| 自定义主题色 | 基础 8 令牌可编辑、实时预览、保存生效 | 全部通过 |
| 多方案管理 | 新建/复制/重命名/删除/启用/搜索 | 全部通过，至少保留 1 套 |
| 系统兼容 | 浅/深变体跟随系统自动切换 | 切换 ≤500ms，所有窗口一致 |
| 模板 | 6 套预设一键应用；单套/全部导出；导入预览与确认 | 全部通过 |
| 持久化 | 重启、升级、跨窗口保持 | 全部通过 |
| 回退 | 切回内置主题无变量残留；异常主题自动回退 | 全部通过 |
| 原主题保留 | 跟随系统/琥珀/浅色/深色四档的取值、视觉、快捷键循环不变 | 与升级前逐项对比一致 |

### 7.2 兼容性矩阵

| 平台 | 渲染引擎 | 浅色 | 深色 | 系统切换 | 导入导出 | 结论要求 |
|---|---|---|---|---|---|---|
| Windows 10/11 | WebView2 | 必测 | 必测 | 必测 | 必测 | 通过 |
| macOS 12+ | WKWebView | 必测 | 必测 | 必测 | 必测 | 通过 |
| Linux | WebKitGTK | 必测 | 必测 | 必测 | 必测 | 通过 |
| Web 预览（开发） | Chromium/Firefox | 必测 | 必测 | 必测 | 回退路径 | 通过 |

### 7.3 性能预算

| 指标 | 预算 | 测量方法 |
|---|---|---|
| 单次主题切换端到端 | P95 ≤50ms | `performance.now()` 前后打点，100 次采样 |
| 变量注入任务 | ≤8ms | Performance 面板 Long Task |
| 启动主题恢复 | ≤30ms | 冷启动首帧时间对比 |
| 内存 | 100 次切换后增长 ≤5MB | 内存快照对比 |
| 主题列表加载 | 50 套 ≤100ms | KV 读取 + 解析计时 |

### 7.4 无障碍标准

- 正文/主文字与背景对比度 ≥4.5:1（WCAG 2.1 AA）。
- 非文字关键元素（焦点环、图标、边框）≥3:1。
- 不依赖颜色单独传达状态（保留图标/文本）。
- 焦点可见，`prefers-reduced-motion` 下无强制动画。
- 预设模板全部通过自动对比度审计；用户主题不达标时给出非阻断警告与修正建议。

## 8. 交付物清单

| 阶段 | 交付物 | 存放位置 |
|---|---|---|
| P1 | 需求边界、令牌清单、验收用例 | `.docs/theme-customization-plan.md` 及评审记录 |
| P2 | ADR、Schema v1、PoC 结论 | `.docs/theme-customization-plan.md` 附录 / 评审记录 |
| P3 | 主题引擎、管理 UI、模板、i18n、单测 | `app/src/theme/`、`app/composables/useTheme.ts`、`app/components/theme/`、`SettingMain.vue` 内嵌入口 |
| P4 | 兼容/性能/无障碍/回归报告 | `.docs/` 测试报告 |
| P5 | 安装包、CHANGELOG、功能文档 | 构建产物、`CHANGELOG.md`、`.docs/features/settings.md` |

## 9. 里程碑与决策点

| 里程碑 | 时间 | 决策内容 | 不通过的处理 |
|---|---|---|---|
| Gate 1 范围/技术冻结 | 11-23 ~ 11-25 | 令牌范围、注入方案、存储方案、导入导出方案 | 回到 P1/P2 修订，不进入编码 |
| Gate 2 质量门禁 | 12-14 | 兼容/性能/无障碍/回归是否达标 | 缺陷修复后复测，延期发布 |
| Gate 3 发布验收 | 12-16 | 安装、升级、回滚是否通过 | 回滚版本，问题归档后重排 |

## 10. 待确认事项（需评审拍板）

1. ~~主题管理入口形态~~：已确认采用设置页内嵌面板（通用设置 → 外观分组内折叠展开），不新增独立窗口与 capabilities 配置。
2. 高级令牌是否首版即开放（推荐开放但默认折叠）。
3. 内置预设数量与命名（建议 6 套：琥珀、石墨、Darcula、森林、深海、玫瑰）。
4. 自定义模式是否支持「强制浅色/强制深色」变体策略（建议支持，默认跟随系统）。
5. 发布渠道与时间窗口（按 CI 现状与版本节奏确认）。
