# 设置（setting）

> 工具适配人的中枢：分组式设置页 + 快捷键录制与冲突检测 + 配色/语言/窗口行为 + 数据管理。

> 由代码审查整理于 2026-10

## 功能总览

| 功能 | 说明 | 入口 / 快捷键 |
|---|---|---|
| 分组导航 | 六大分组：快捷键设置 / 导航栏设置 / 剪贴板设置（常规·悬浮预览·隐私与安全三子组）/ 灵动岛设置 / 智能与 AI / 通用设置（应用·外观与语言·待办与提醒·数据管理四子组）/ 关于；子分组渲染为分节卡片 | 左侧分类清单 |
| 设置搜索 | 跨分组搜索，右侧直接列出命中项（可经「前往分组」落到具体分组）；分组静态清单单一来源 `settingGroups.ts`，与全局搜索面板共用 | 设置页搜索框 / `Ctrl+P` |
| 快捷键管理 | 逐项录制（按下新键，Esc 取消）/ 启停 / 重置（仅修改过的项显示重置钮）；全局组与局部组 + 两组数字粘贴折叠组（一键开启/关闭/还原）；冲突检测、注册失败标红与回滚 | 设置 → 快捷键设置 |
| 配色主题 | 跟随系统（默认）/ 琥珀 / 浅色 / 深色；托盘菜单与全部子窗口同步换肤，窗口原生主题跟随 | 设置 → 通用设置 → 外观 |
| 语言 | 跟随系统 / 中文 / English；切换后跨窗口同步刷新 | 设置 → 通用设置 → 外观 |
| 蒙版模糊度 | 全局面板蒙层背景模糊强度（0-1，默认 1；0 回归纯半透明黑） | 设置 → 通用设置 → 外观 |
| 节日彩蛋 | 节日限时主题总开关（默认开），控制灵动岛换装与主窗口点缀 | 设置 → 通用设置 → 外观 |
| 窗口弹出位置 | 光标处 / 上次打开位置（默认）/ 光标所在屏幕居中；失焦隐藏前自动记录窗口位置 | 设置 → 剪贴板设置 → 常规 |
| 失焦自动隐藏 | 主窗口失焦自动隐藏（默认开，置顶时自动豁免） | 设置 → 通用设置 → 应用 |
| 开机自启 | tauri autostart 插件（写当前用户注册表，系统级设置不存数据库）；开发模式不支持并清理误注册 | 设置 → 通用设置 → 应用 |
| 应用时长记录 | 与应用时长页共用的采集总开关（默认关） | 设置 → 通用设置 → 应用 |
| 回放引导 | 重新播放新手引导 | 设置 → 通用设置 → 应用 |
| 历史保留时间 | 永久（默认）/ 7 / 30 / 90 / 365 天，变更即清理过期条目（含图片文件），有清理数量反馈 | 设置 → 剪贴板设置 → 常规 |
| 剪贴板上限 | 最大存储数量（超限淘汰最旧非收藏项，收藏豁免）、图片上限 | 设置 → 剪贴板设置 → 常规 |
| 悬浮预览 | 悬停提示开关、自动换行开关、粘贴后恢复原剪贴板 | 设置 → 剪贴板设置 → 悬浮预览 |
| 隐私与安全 | 隐私模式（暂停记录，与托盘菜单共用）、敏感内容防护、忽略的应用（黑名单） | 设置 → 剪贴板设置 → 隐私与安全 |
| 忽略的应用 | 黑名单应用中的复制不落库、不弹岛；面板默认列出已记录的来源应用（按条数排序），也支持手动输入进程名（含运行中进程建议） | 设置 → 剪贴板设置 → 隐私与安全 |
| 待办提醒开关 | 智能提醒（提前 30/10/5 分钟 + 自定义提醒，默认开）与待办系统通知（默认开）两个独立开关 | 设置 → 通用设置 → 待办与提醒 |
| 灵动岛参数 | 岛显示总开关、出现延迟（默认 0ms，钳制 0-10000ms）与停留时长（默认 1800ms，钳制 600-60000ms），非法输入回退默认值 | 设置 → 灵动岛设置 |
| 导航配置 | 标签页顺序（长按拖拽或上下移）与启停；剪贴板与设置强制保留（锁定不可禁用） | 设置 → 导航栏设置 |
| 数据管理 | 清空数据库（3 分钟撤回）、导出 JSON、导入 JSON、自动备份恢复 | 设置 → 通用设置 → 数据管理 |

## 关键行为

### 快捷键录制与冲突检测
全部快捷键定义在 `InitShortcuts.ts` 的 `DEFAULT_SHORTCUTS`（id/defaultKey/scope/command/title），启动时从数据库恢复用户自定义键位与启用状态（仅覆盖存在的项，缺省保持默认）。录制保存走 `updateShortcutKey`，校验链：

- 修饰键校验：切换标签页/保存便签/新建便签必须含 Ctrl/Cmd/Alt/Shift（防止无修饰方向键/回车/字母占用导致「单按左右键就切标签」等默认组合失效）。
- 冲突检测：`findShortcutConflict` 修饰键别名 Ctrl/Control/Command/CommandOrControl 归一化比较，避免跨写法冲突漏检。
- 重注册：注册失败（新键被系统/其他程序占用）回滚原键并重新注册，不把「死键」持久化。

分组操作：折叠数字粘贴组一键开启/关闭/还原（`setShortcutGroupEnabled`/`resetShortcutGroup`，一次重注册 + 批量持久化）；全部重置可按 scope 只重置全局或局部。`cycle_color_scheme` 默认不绑定（defaultKey 为空）。见 `app/src/commands/shortcuts/InitShortcuts.ts:360`（findShortcutConflict 352、resetShortcut 400、toggleShortcutEnabled 423、分组批量 440/461、resetAllShortcuts 489）。

### 快捷键持久化与失败提示
- 键位 upsert 到 `shortcut_binding` 表、启用状态存 settings KV（`shortcut_enabled_<id>`）。
- 启动/重注册后仍失败的项落入 `failedShortcutIds`（设置页对应行标红），启动期失败另弹灵动岛通知（否则全局键静默失效无从知晓）；失败集随每次重注册整体重算，改键/重置成功后自动清除标红态。
- 历史残留全局热键（页面 reload 后 JS 侧清单丢失）在启动时按「默认 global ∪ 当前配置 global ∪ 数据库记录过的全部键」统一注销清理。
- 默认不绑定的快捷键会忽略并清理数据库里的旧默认值（升级兼容）。

见 `app/src/commands/shortcuts/InitShortcuts.ts:239`（initShortcuts 264、persistAllShortcuts 253）。

### 配色主题
- 四模式 `system/default/light/dark`，实际渲染色经 `resolvedScheme` 解析（system 按系统深浅：深色→dark、浅色→琥珀）；`<html data-scheme>` 属性选择器整体换肤。
- 双写持久化：localStorage 镜像（首帧前同步恢复，消除启动快切）+ settings KV（异步读为准校正）。
- 切换广播 `scheme:changed` 同步 tooltip/viewer 等子窗口实时跟随。
- 同时驱动 Rust 原生托盘菜单深浅色（Windows SetPreferredAppMode，菜单需重建才生效）与各窗口原生主题（标题栏/原生控件；跟随系统模式传 null 恢复系统跟随）。
- 快速切换命令 `cycle_color_scheme` 循环四模式（默认未绑定键，用户可自行录制）。

见 `app/composables/useColorScheme.ts:64`（setColorScheme 124、cycleColorScheme 139）。

### 语言（i18n）
- 语言模式持久化到 settings KV（`app_locale`，默认 system）；system 模式按 `navigator.language` 探测（zh* → zh-cn，其余 → en-us）。
- 切换后 emit `locale:changed` 广播，子窗口跟随并 `location.reload` 重挂读取新语言包（不用 reloadNuxtApp，避免依赖 Nuxt 内部 HMR）。
- 显示层翻译：数据库只存原始值，默认数据（分类/优先级/时段/画像标签）渲染时按语言映射，用户自定义名称保留原文。

见 `app/composables/useI18n.ts:110`、`app/i18n/messages.ts:21`。

### 数据导入导出
- 导出 6 张数据表（clipboard/note/todo/pinned_clip/daily_stat/app_usage）为自包含 JSON（默认文件名 `s1de-board-backup-<日期>.json`）。
- 图片条目的 `imgfile:` 引用解析为原图 dataUrl 写进包（换机无需携带图片目录；解析失败保留原引用，导入端兜底）。
- 配置类（settings KV/快捷键绑定，可能含 API key 等敏感配置）与可再生数据（island_history/app_icons）不参与备份。
- 导入为替换式恢复：版本守卫（仅接受当前版本，旧/新版本明确报错走「导入失败」提示）→ dataUrl 先落盘重建 `imgfile:` 引用（sha256 内容寻址，同内容得到与导出前一致的文件名）→ 清空 6 表 → 按行自有列集整批写入（容纳 schema 演进新列）。

见 `app/src/core/db/repositories/dataTransferRepository.ts:38`（exportData 65、importData 83）、`app/components/setting/SettingMain.vue:1377`。

### 清空与 3 分钟撤回
- 清空前把 clipboard/note/todo/daily_stat/app_usage 整表复制到 `clear_backup_*`，保留 settings/shortcut_binding/pinned_clip，重置自增主键。
- 撤回窗口 3 分钟（原 5 秒过短且误触即丢，已改；mm:ss 倒计时显示；状态模块级单例，切走再切回仍可撤回）。
- 窗口内 `undoClearDatabase` 合并恢复：clipboard 自增 id 整体偏移到现有 MAX(id) 之后 + OR IGNORE 保窗口期新条目（内容不丢仅不合并历史计数）；其余表 OR REPLACE 备份行胜出。
- 超时/重启/连续清空 `finalizeClear` 丢弃备份并清理孤儿图片文件（只删当前 clipboard 表未再引用的，防 undo 后重新复制的同图被误删）。
- 上次会话遗留的备份在启动迁移中清理；另有「图片过期清理」独立的 5 秒撤回窗口（只删条目行，文件待窗口结束才删）。

见 `app/src/core/db/repositories/backupRepository.ts:13`（clearDatabase 56、undo 72、finalize 98）、`app/components/setting/SettingMain.vue:1276`（413 保留天数、548 图片清理）。

### 自动备份
- 每日首次启动自动快照（KV `auto_backup_last_date` 同日幂等，失败仅记日志次日再试），与手动导出同一数据包（6 表、图片内联自包含）。
- 经 Rust 命令 `write_auto_backup` 写入 `app_data/backups/`（文件名白名单校验、原子写、当日重启动覆盖同名文件），写后按文件名倒序保留最近 7 份。
- 设置页「自动备份恢复」列出快照（倒序新→旧，每次展开重新拉取）→ 两步确认后 `readAutoBackup` → `importData` 替换式导入。

见 `app/src/backup/autoBackup.ts:31`（KEEP_COUNT 20）、`app/components/setting/SettingMain.vue:1438`。

### 导航配置
- 标签页顺序与启停持久化到 settings KV（JSON `{order, disabled}`）。
- 设置 Tab 归一固定最末，剪贴板与设置锁定不可禁用；恢复的「最后访问 Tab」若已被禁用则回退默认剪贴板；新增 Tab 自动追加到末尾（order 合并兜底）。
- 排序交互复用 `useLongPressReorder`（长按拖拽 + 上下移按钮）。

见 `app/composables/useTabs.ts:39`（setTabEnabled 150）、`app/components/setting/SettingMain.vue:1704`。

### 灵动岛参数与持久化模式
- 出现延迟（`island_delay_ms`，默认 0 即显，钳制 0-10000ms）与停留时长（`island_duration_ms`，默认 1800ms，钳制 600-60000ms）：文本输入即校验，非法/越界回退默认值。
- 设置项文本输入统一防抖落库、卸载前强制写入；开关类设置经 `createBooleanSetting` 共享状态源（设置页/业务逻辑/托盘同一份 ref）。
- 灵动岛 API 与 Webhook 配置卡片按分组 title 挂载在灵动岛分组尾部。

见 `app/composables/useCopyIsland.ts:49`（钳制 52-57）、`app/components/setting/SettingMain.vue:186`、`app/composables/useBooleanSetting.ts`。

## 边界与限制

- 设置分组清单（`settingGroups.ts`）是设置页渲染与全局搜索索引的单一来源，两处结果天然一致。
- 快捷键冲突检测跨写法归一化（Ctrl/Control/Command/CommandOrControl 等价），保存时校验而非注册后补救；完整默认键位可在应用内「设置 → 快捷键」查看与修改。
- 全局快捷键（Ctrl+I / Ctrl+1~0 / Ctrl+Shift+1~0）系统级生效；局部快捷键仅主窗口聚焦时响应。
- 数据包版本守卫：导入不接受非当前版本文件（明确报错）。
- 自动备份仅保留 7 份、每日一份（同日覆盖）；恢复为替换式（覆盖当前 6 表），两步确认防误操作。
- 开机自启为系统级设置（注册表/启动项），不随「清空数据库」重置；开发模式注册的是 target/debug 二进制（启动时检测并清理）。
- 历史保留时间到期条目在启动与设置变更时清理；清空数据库不动常用剪贴板（单条删除走各自入口）。
- 敏感配置（API key）存 settings KV 不参与导出备份。

## 深读文档

- [数据库设计](../database.md)（settings KV 表、`shortcut_binding` 表与清空撤回时序图）
- [灵动岛 API](../island-api.md)（设置页中灵动岛 API 与 Webhook 配置项）
- [彩蛋说明](../easter-eggs.md)（节日彩蛋总开关与跨窗口同步机制）
