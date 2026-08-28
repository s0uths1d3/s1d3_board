# UI 标准组件库

本目录是应用的标准组件库。**凡功能相似的界面模块，必须优先使用本组件库，禁止再手写同类结构的独立组件**；新需求先扩展本库的配置项，而不是另起炉灶。

- 组件通过 Nuxt 自动导入，模板中直接使用 `<UiXxx>`，无需 import。
- 所有组件遵循全局配色系统（CSS 变量令牌），切换配色自动跟随，组件内禁止写死颜色。
- 交互基线：键盘可达（Enter/Space/Escape）、无障碍属性齐全（role/aria-checked/aria-label）、`prefers-reduced-motion` 全局生效。

## UiDropdown — 下拉/弹出面板

统一下拉交互：点击触发器开/关（再次点击收起）、点击外部收起、Escape 收起、入场动画（check-pop）。

| Prop | 默认 | 说明 |
| --- | --- | --- |
| `v-model:open` | 内部自管 | 受控开关；需要在面板逻辑里主动收起时绑定 |
| `align` | `'start'` | 面板水平对齐：`start` / `center` / `end` |
| `direction` | `'down'` | `down` / `up` / `auto`（空间不足自动上翻，teleport 模式生效） |
| `teleport` | `false` | 面板 Teleport 到 body 并 fixed 定位；调用方有 overflow 裁切/层叠上下文限制时使用 |
| `match-trigger-width` | `false` | 面板宽度撑满触发器 |
| `panel-class` | `''` | 面板类：宽度/圆角/内边距，如 `glass-card menu w-32 rounded-2xl p-2` |
| `close-on-select` | `true` | 点击面板内容自动收起；带 `data-dd-keep-open` 的元素例外（删除按钮/输入框等交互中元素） |
| `disabled` | `false` | 禁用触发器 |

插槽：`#trigger="{ open, toggle }"`（触发器内容，勿在此绑定点击——组件已接管）、`#default="{ close, open }"`（面板内容）。

事件：`@select`（面板内点击）、`@open` / `@close`（如 DatePicker 展开时滚动到选中项）。

参考用法：待办筛选/排序（内联菜单）、分类选择器（teleport + 受控 open + 复杂面板）、时间选择（`@open` 滚动定位）。

> `DueTimeSelect`（截止时间选择器）是含日期/时间/快捷项的富选择器，属领域组件而非通用下拉，暂独立存在；若新增"选值弹层"需求一律用 UiDropdown。

## UiToggleSwitch — 胶囊开关

统一开关外观与无障碍（`role="switch"` + `aria-checked`）。

| Prop | 默认 | 说明 |
| --- | --- | --- |
| `v-model` | 必填 | 开关状态；状态在父级维护时用 `:model-value` + `@change` |
| `size` | `'md'` | `md` = h-6 w-11（表单行），`sm` = h-5 w-9（紧凑行内） |
| `disabled` | `false` | 禁用（轨道恒灰、不可点） |
| `tip-on` / `tip-off` / `disabled-tip` | — | 各状态悬停提示（禁用优先） |
| `label` | — | 无障碍标签 |

## UiSegmented — 分段选择

一组互斥选项的胶囊分段控件，选中项金色高亮。

| Prop | 默认 | 说明 |
| --- | --- | --- |
| `v-model` | 必填 | 选中值（string）；值域受限时用 `:model-value` + `@update:model-value` 内部收敛类型 |
| `options` | 必填 | `{ value, label, tip? }[]`，label 支持响应式动态内容 |
| `block` | `false` | 撑满整行、选项均分 |
| `size` | `'md'` | `md` 表单行 / `sm` 紧凑工具条 |
| `disabled` | `false` | 禁用整组 |

## 维护约定

1. **新增相似 UI**：先查本库；缺配置就在本组件上加 prop，不得复制一份改样式。
2. **改交互基线**（如外部点击收起、Escape）：只改本库一处，全部调用方自动生效。
3. **面板内交互元素**（输入框、删除按钮等点击不应收起面板的）：加 `data-dd-keep-open` 属性。
4. 组件库改动需过 `npm run build` 验证。
