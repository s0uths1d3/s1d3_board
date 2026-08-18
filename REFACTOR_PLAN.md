# 丝滑剪贴板体验 — 重构方案文档

> 目标体验：在其他窗口（有输入框）按下 `Ctrl/Cmd+I` → 弹出 clip 窗口 → 用 `↑`/`↓` 选择目标条目 → 按 `Enter` → 该条目的内容被粘贴到**之前那个窗口的输入框**，clip 窗口自动隐藏。

---

## 一、现状分析（基于当前代码）

### 1. 事件流现状

```
其他窗口输入框
    │ 用户按 Ctrl/Cmd+I（全局快捷键，Tauri global-shortcut）
    ▼
ToggleWindowCommand ──► win.show() + win.setFocus()
    │                       + window.focus() + 派发 'window-shown'
    ▼
clip 窗口显示，index.vue 监听 'window-shown' → 聚焦 <ul>
    │ 用户按 ↑/↓（本地快捷键，window 级 keydown）
    ▼
ArrowUp/DownTargetMovementCommand ──► 修改 selectedRowIndex + 滚动
    │ 用户按 Enter
    ▼
index.vue <ul @keydown="handleKeyDown">（⚠️ 焦点必须在 <ul> 上）
    │
    ├── increaseUseCount()
    ├── writeText(content)         ← 写入系统剪贴板
    ├── invoke('paste')            ← ⚠️ 先模拟粘贴（Rust sleep 300ms 后 Ctrl+V）
    └── getCurrentWindow().hide()  ← ⚠️ 后隐藏窗口
```

### 2. 现有代码的问题（痛点）

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| P1 | `index.vue` `<ul @keydown>` | Enter 粘贴绑定在 `<ul>` 元素上，**必须焦点在列表上才生效** | 焦点在别处时 Enter 无效，体验不稳定 |
| P2 | `index.vue handleKeyDown` | `invoke('paste')` 在 `hide()` **之前**执行；Rust 端 sleep 300ms 后模拟 Ctrl+V | 按键很可能落在 clip 窗口自身而非目标窗口 → **粘贴失败**（丝滑体验的核心 bug） |
| P3 | `TargetMovementCommand.ts` | 内部维护一套独立的 `data`/`filter` ref（第 5-9 行），与 `index.vue` 的 `data`/`filter` 是**两份** | 状态不同步 |
| P4 | `TargetMovementCommand.getSelectedRowId()` | 先 `fetchClipboardData()` 再**立刻**读旧 `data`，异步未完成 | 收藏/删除可能操作错误条目 |
| P5 | `ShortcutManager` local handler | 无 `e.repeat` 抑制、Enter 命中时未 `preventDefault` | 长按连发、Enter 可能触发输入框默认行为 |
| P6 | `index.vue` 仍在 `handleKeyDown` 里重复"写剪贴板+粘贴+隐藏"逻辑 | 与命令模式职责重复 | 逻辑分散、难维护 |

### 3. 当前已有基础（无需改动）

- ✅ 全局快捷键 `CommandOrControl+I` → `ToggleWindowCommand`（已修复：`win.isVisible()` 判断 + 显示后聚焦 webview）
- ✅ `lib.rs` `paste` 命令：跨平台（Windows/Linux `Ctrl+V`，macOS `Cmd+V`）
- ✅ 写剪贴板 `writeText()`（`tauri-plugin-clipboard-api`，跨平台 arboard）
- ✅ `index.vue` 监听 `window-shown` 聚焦列表
- ✅ capabilities 已含 `clipboard:*` 权限

---

## 二、重构方案

### 核心思路

把"Enter 粘贴"从 `index.vue` 的 `<ul>` 事件中**抽离为一条本地快捷键命令**（与 ↑/↓ 同级），并修正**时序**：

```
写剪贴板(writeText) → 隐藏窗口(hide) → 延迟(等焦点回目标窗口) → 模拟粘贴(invoke('paste'))
```

同时**收敛共享状态**：列表数据、过滤条件、选中索引统一到一个 store，消除 P3/P4。

### 文件改动清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 🆕 新建 | `app/src/commands/local/clipboardStore.ts` | 共享状态 store |
| ✏️ 重写 | `app/src/commands/local/TargetMovementCommand.ts` | 改为引用 store |
| 🆕 新建 | `app/src/commands/local/PasteCommand.ts` | Enter 粘贴命令（正确时序） |
| ✏️ 修改 | `app/src/commands/shortcuts/InitShortcuts.ts` | 注册 `Enter → PasteCommand` |
| ✏️ 修改 | `app/src/commands/shortcuts/ShortcutManager.ts` | `repeat` 抑制 + Enter `preventDefault` |
| ✏️ 修改 | `app/pages/index.vue` | 用 store 替换本地 data/filter，删除 handleKeyDown 里的粘贴逻辑 |
| ✏️ 修改 | `app/src/commands/local/FavoriteCommand.ts` | 改用 store 的 `getSelectedRowId`（修复 P4） |

> 说明：`clipboardStore.ts` 与 `TargetMovementCommand.ts` 同目录，`TargetMovementCommand` 作为"对外兼容层"继续导出 `selectedRowIndex/dataLength/selectRow/getSelectedRowIndex/getSelectedRowId`，**避免改动 index.vue 中大量 import**（最小侵入）。

### 详细设计

#### 1) `clipboardStore.ts`（新建）

```ts
import { ref, nextTick } from 'vue';
import type { ClipboardData } from '~/src/Entities';
import clipboardService from '~/src/db/dbService';

export const data = ref<ClipboardData[]>([]);
export const dataLength = ref(0);
export const selectedRowIndex = ref(0);
export const filter = ref({ favorite: 0, searchContent: '' });

/** 拉取数据并刷新列表，自动修正选中索引越界 */
export async function fetchData() {
  try {
    const result = await clipboardService.fetchClipboardData(filter);
    data.value = result;
    dataLength.value = data.value.length;
    if (selectedRowIndex.value >= data.value.length)
      selectedRowIndex.value = data.value.length - 1;
    if (selectedRowIndex.value < 0) selectedRowIndex.value = 0;
  } catch (err) { console.error(err); }
}

export function getSelectedRowIndex(): number { return selectedRowIndex.value; }
/** 直接读当前列表，无异步问题 */
export function getSelectedRowId(): number | undefined {
  return data.value[selectedRowIndex.value]?.id;
}
/** PasteCommand 使用 */
export function getSelectedContent(): string | undefined {
  return data.value[selectedRowIndex.value]?.content;
}
export function selectRow(index: number) {
  if (index >= 0 && index < dataLength.value) {
    selectedRowIndex.value = index;
    scrollToSelectedRow();
  }
}
async function scrollToSelectedRow() {
  await nextTick();
  const listElement = document.querySelector('#listElement');
  const listItems = listElement?.querySelectorAll('.list-row');
  listItems?.[selectedRowIndex.value]
    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
```

#### 2) `TargetMovementCommand.ts`（重写）

```ts
import type { Command } from '../Command';
import { dataLength, selectedRowIndex, selectRow,
         getSelectedRowIndex, getSelectedRowId } from './clipboardStore';

export class ArrowUpTargetMovementCommand implements Command {
  async execute(): Promise<void> {
    const newIndex = selectedRowIndex.value - 1;
    if (newIndex >= 0) {
      selectedRowIndex.value = newIndex;
      selectRow(newIndex);
    }
  }
}

export class ArrowDownTargetMovementCommand implements Command {
  async execute(): Promise<void> {
    const newIndex = selectedRowIndex.value + 1;
    if (newIndex < dataLength.value) {
      selectedRowIndex.value = newIndex;
      selectRow(newIndex);
    }
  }
}

// 兼容导出：避免改动 index.vue 里的大量 import
export { selectRow, getSelectedRowIndex, getSelectedRowId };
```

#### 3) `PasteCommand.ts`（新建）— 核心

```ts
import type { Command } from '../Command';
import { getSelectedContent, getSelectedRowIndex } from './clipboardStore';
import clipboardService from '~/src/db/dbService';
import { writeText } from 'tauri-plugin-clipboard-api';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri } from '~/src/utils/env';

export class PasteCommand implements Command {
  async execute(event?: { state: string }): Promise<void> {
    if (event?.state !== 'Pressed') return;
    const content = getSelectedContent();
    if (!content) return;

    await clipboardService.increaseUseCount(getSelectedRowIndex());

    // ① 写入系统剪贴板（跨平台）
    try {
      if (isTauri()) await writeText(content);
      else if (navigator.clipboard) await navigator.clipboard.writeText(content);
    } catch (err) { console.error('写入剪贴板失败:', err); }

    // ② 先隐藏窗口 → 焦点自动回到之前的目标窗口
    await getCurrentWindow().hide();

    // ③ 延迟一小段，等目标窗口获得焦点后再模拟 Ctrl/Cmd+V
    if (isTauri()) {
      setTimeout(async () => {
        try { await invoke('paste'); }
        catch (e) { console.error('模拟粘贴失败:', e); }
      }, 200);
    }
  }
}
```

#### 4) `InitShortcuts.ts`（修改）

在 `shortcuts` 数组的 ↑/↓ 之后新增：

```ts
{
  key: 'Enter',
  scope: 'local',
  command: pasteCommand,   // new PasteCommand()
  title: '粘贴选中项'
},
```

#### 5) `ShortcutManager.ts`（修改 local 分支）

```ts
const handler = async (e: KeyboardEvent) => {
  if (e.repeat) return;              // 长按不连发

  const key = config.key.toLowerCase();
  const pressedKey = e.key.toLowerCase();
  const ctrl = key.includes('ctrl') || key.includes('command');
  const alt = key.includes('alt');
  const shift = key.includes('shift');
  const modifierMatch =
    (!ctrl || e.ctrlKey || e.metaKey) &&
    (!alt || e.altKey) &&
    (!shift || e.shiftKey);
  const mainKey = key.split('+').pop()?.trim();
  const isMatch = pressedKey === mainKey && modifierMatch;

  if (isMatch) {
    e.preventDefault();       // 阻止输入框/默认行为
    e.stopPropagation();
    await config.command.execute({ state: 'Pressed' });
  } else if (pressedKey === 'arrowup' || pressedKey === 'arrowdown') {
    e.preventDefault();       // 防止页面随方向键滚动
  }
};
```

#### 6) `index.vue`（修改）

- **删除** `handleKeyDown` 中整个 Enter 分支（粘贴逻辑已迁至 `PasteCommand`），仅保留 `<ul @keydown="handleKeyDown">` 的空实现或直接移除绑定。
- `data`/`filter`/`selectedRowIndex` 改为从 `clipboardStore` 引入（或复用 `TargetMovementCommand` 的兼容导出，减少 import 改动）。
- `fetchData()` 改为调用 store 的 `fetchData()`（内部同步刷新 `dataLength`/修正索引）。
- 保留 `window-shown` 监听聚焦列表。
- `getCurrentWindow().hide()` / `writeText` / `invoke` 等 import 一并清理。

#### 7) `FavoriteCommand.ts`（修改）

```ts
import { getSelectedRowId } from './clipboardStore';  // 原 TargetMovementCommand
// 直接拿当前列表的选中 id，不再触发一次异步 fetch
const id = getSelectedRowId();
if (id === undefined) return;
const res = await clipboardService.fetchClipboardSingleData(id);
await this.favorite(id, res.is_favorite);
```

---

## 三、关键时序与原理

| 步骤 | 动作 | 原因 |
|------|------|------|
| 1 | `writeText(content)` | 先把内容放进系统剪贴板（clip 窗口自身隐藏前） |
| 2 | `hide()` | 隐藏 clip 窗口，操作系统把焦点交还给之前的窗口 |
| 3 | `setTimeout(200ms)` | 给目标窗口重新聚焦留出时间（Rust 端 `sleep(300ms)` 与之叠加更稳） |
| 4 | `invoke('paste')` | Rust 端 enigo 模拟 `Ctrl/Cmd+V`，此时焦点已在目标输入框 → 成功粘贴 |

> 若颠倒"隐藏"与"模拟粘贴"的顺序（即旧代码先 paste 后 hide），模拟按键会被发到 **clip 窗口自己**，导致粘贴无效——这是本次重构要修正的**核心 bug**。

---

## 四、兼容性与风险

- **跨平台**：写入用 `tauri-plugin-clipboard-api`（arboard）；粘贴用 `lib.rs` 三平台 `paste`（macOS `Cmd+V`）。Linux 需系统具备 X11/Wayland 剪贴板后端。
- **Web 预览（非 Tauri）**：`isTauri()` 守卫后走 `navigator.clipboard.writeText`，不模拟粘贴、不隐藏窗口，仅调试用。
- **enter 在其他场景**：`ShortcutManager` 只对**注册过的 key** 执行 `preventDefault`；Enter 注册后，在 clip 窗口内任意位置按 Enter 都会触发粘贴（符合预期）。
- **风险点**：`hide()` 后 setTimeout 的 200ms 是经验值；若目标窗口聚焦慢，可调大到 300ms。若仍粘贴失败，可改为 Rust 端在 `hide` 之后由窗口事件驱动粘贴（见"可选增强"）。

### 可选增强（本次不实现，记录备选）

- **更稳的粘贴方案**：由 Rust 端监听窗口 `hide` 事件后再执行 enigo 粘贴，省去 JS 侧 setTimeout 竞态。
- **行首自动聚焦搜索**：窗口弹出时聚焦搜索框而非列表，支持直接输入过滤。

---

## 五、验证清单

1. `npx nuxt dev` → 页面正常、无 TS 编译错误。
2. `cargo check` → Rust 侧无错误（paste 命令已跨平台）。
3. 桌面端 `tauri:dev` 实测：
   - [ ] 在其他窗口输入框中按 `Ctrl+I` → clip 窗口弹出且聚焦列表
   - [ ] `↑`/`↓` 高亮移动、自动滚动
   - [ ] `Enter` → clip 窗口隐藏，**内容已粘贴到原输入框**
   - [ ] 使用次数 +1
   - [ ] 搜索过滤后再 Enter，粘贴的是当前过滤列表的选中项
