<div align="center">

# S1d3 Board

**A tray-resident productivity panel — clipboard, todos, notes and stats, one shortcut away**

[English](./README.md) · [简体中文](./README.zh-CN.md)

<br/>

![Tauri](https://img.shields.io/badge/Tauri-2.x-FFC131?style=flat-square&logo=tauri&logoColor=black)
![Nuxt](https://img.shields.io/badge/Nuxt-4.x-00DC82?style=flat-square&logo=nuxt&logoColor=white)
![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2021-000000?style=flat-square&logo=rust&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)

![License](https://img.shields.io/badge/License-Apache_2.0-D22128?style=flat-square)
![Version](https://img.shields.io/badge/Version-0.3.0-2ea44f?style=flat-square)
![Status](https://img.shields.io/badge/Status-active_development-2ea043?style=flat-square)

</div>

## 🤔 Why S1d3 Board

The most frequent things you do on a computer are often the most trivial — and the most over-served by tools:

- **One app per habit**: clipboard history, todos and notes each demand their own window, their own shortcut and their own data format
- **Heavy tools for light tasks**: jotting down one line shouldn't mean launching a full application and giving it a slice of your screen
- **Some data shouldn't leave the machine**: copied text, todos and notes are deeply personal — local beats cloud for these
- **A resident tool must not slow the machine down**: anything that runs all day has to stay lean — the backend is written in Rust for better performance and a lower memory footprint

S1d3 Board isn't *another* productivity app. It gathers these small, frequent chores into **one panel that answers on demand**: `Ctrl+I` to summon, `Esc` to dismiss — it gets out of the way the moment you're done.

## 💡 What it is

A **tray-resident productivity panel** for the desktop.

It isn't a window you keep open all day. It stays in the tray until a global shortcut brings it up:

- **Tray-resident + global shortcut**: `Ctrl+I` from anywhere, auto-hides on focus loss, single-instance (relaunching just focuses the running window)
- **Borderless / transparent window**: feels like a native panel rather than another application
- **Local-first**: everything lives in a local SQLite file — no account, no cloud
- **Trim it to fit**: tabs can be reordered and toggled off, so only the modules you actually use remain

## 🖼️ Screenshots

| Clipboard | Todos |
|:---:|:---:|
| ![Clipboard](.docs/images/clips.png) | ![Todos](.docs/images/todos.png) |
| **Notes** | **Pinned clips** |
| ![Notes](.docs/images/notes.png) | ![Pinned clips](.docs/images/pinned.png) |
| **Statistics** | **App usage** |
| ![Statistics](.docs/images/stats.png) | ![App usage](.docs/images/app_usage.png) |

## 🎯 Core features

| Module | What it solves | Key capabilities |
|---|---|---|
| 📋 **Clipboard** | Copied things vanish | Text & images captured automatically, full-text search, favorites, one-key paste, image viewer |
| 📌 **Pinned** | Re-finding the same snippets | Pin frequent items, paste directly with `Ctrl+1 ~ Ctrl+0` |
| ✅ **Todo** | Things living in your head | Priority, category, due date, smart/custom recurring reminders |
| 🗒️ **Notes** | Nowhere to put stray thoughts | Multi-color masonry notes, `Ctrl+N` to create, `Ctrl+Enter` to save |
| 📊 **Statistics** | Not knowing where time goes | Multi-dimensional usage data, range switching, fun facts & persona tags |
| ⏱️ **App usage** | Which apps eat your day | Per-app foreground time, active/idle split, donut chart (off by default) |
| 🧠 **Smart clipboard** | Copied content deserves processing | Rule-based tokenizing, AI processing (OpenAI-compatible / Anthropic), templates, bubble windows, open API |
| ⚙️ **Settings** | Tools should adapt to you | Shortcut recording & conflict detection, theme, language, popup position, navigation |

Across every module: a **global shortcut system** (fully customizable), a **bilingual UI** (can follow the system), **multi-window collaboration** (hover tooltip / image viewer / delete confirm) and **streaming lists** that stay smooth at any data size.

Key capabilities by module:

### 📋 Clipboard
- **Automatic capture**: copied text and images are stored on the fly; the oldest entries are evicted past the configured limit
- **Full-text search**: keyword filtering with golden highlighting on matches
- **Favorites**: `Ctrl+L` to star / unstar
- **One-key paste**: `Enter` pastes the selection; `Ctrl+Shift+1 ~ Ctrl+Shift+0` pastes the top 10 globally
- **Dedicated viewers**: a hover tooltip shows full content (original indentation preserved); an image viewer supports zoom / rotate / switching

### 📌 Pinned
- Pin frequently used clips as fast-paste items, shown in a masonry layout
- `Ctrl+U` adds the current selection, `Ctrl+1 ~ Ctrl+0` pastes the top 10 directly
- **Arrow-key navigation**: `↑↓←→` picks the geometrically nearest item, `Delete` removes it (inline confirm)

### ✅ Todo
- Create / edit / delete with priority (low / medium / high) and categories
- **Due dates**: unified warm-toned date & time picker
- **Recurring reminders**: smart or custom alarm rules with due notifications

### 🗒️ Notes
- Multi-color notes (blue / yellow / pink / green / purple / orange) in a masonry layout
- **Double-click / Ctrl+Enter** to edit, `Ctrl+Enter` to save, `Ctrl+N` to create
- Inline delete confirmation with instant toast feedback

### 📊 Statistics
- **Multi-dimensional data**: clips / images / pastes / todos / notes / favorites / usage time / shortcuts / tab visits
- **Time range**: a shared `RangeBar` (day / week / month / year / custom), reused by App usage
- **Trends & distribution**: key metric cards, tab visit distribution, active hours, daily trend chart
- **Fun facts**: typing volume, top copier, longest streak, time conversions
- **User persona**: habit tags generated live, plus a personal title with score breakdown

### ⏱️ App usage
- **Foreground tracking**: Rust watches the foreground window, settles in 30s segments and aggregates per app
- **Totals & ranking**: total / active / idle cards, a time-descending ranking (with app icons) and a donut chart
- **Range switching**: shares the `RangeBar` with Statistics (day / week / month / year / custom)
- **Privacy first**: off by default — nothing is counted until you turn it on (Windows / macOS / Linux)

### 🧠 Smart clipboard

Copied text can be **parsed into segments** through a configurable pipeline, then consumed by bubble windows or external tools:

- **Processing modes**: off / rule-based / AI — a single switch in settings
- **Tokenizing rules**: separator or regex patterns (capture groups become segments), priority-ordered; parsing never drops content (falls back to the raw text)
- **AI processing**: OpenAI-compatible and Anthropic native providers, proxied through the Rust side (CSP untouched, API key never exposed to the webview); a connection test button lives in the API settings group
- **Templates**: `{content}` / `{segN}` / `{date}` / `{time}` placeholders plus `{ai:instruction}` for on-the-fly AI processing
- **Bubble window**: global hotkey (default `Ctrl+B`) summons a segment list — `↑↓` select, `Enter` paste, `Esc` close; any segment can be **pinned** into its own always-on-top mini bubble
- **Open API**: a localhost-only HTTP/SSE endpoint (port configurable, optional token) pushes `copy` events to external popups or a custom "dynamic island" window

### ⌨️ Global shortcuts
- Every shortcut is **recordable, toggleable and resettable**, individually or per group
- **Conflict detection**: conflicts are checked on save and a failed registration rolls back; scopes are `global` (system-wide) / `local` (window-level)
- The full default keymap is viewable and editable in-app under **Settings → Shortcuts**

### ⚙️ Settings
- **Theme**: follow system / amber (warm) / light / dark — the tray and child windows follow along
- **Language**: follow system / 中文 / English
- **Popup position**: at cursor / last position / centered on the cursor's screen
- **Toggles**: launch at login, max clipboard entries, hover tooltip, search highlight, smart reminders, app-usage tracking
- **Shortcuts**: record / toggle / reset (individually or per group)
- **Navigation**: tab order (long-press drag or move up/down) and visibility — Clipboard and Settings are locked
- **Data**: clear the database, with a **5-second undo window**

### 🌐 Languages (i18n)
- **Chinese / English**, with a **follow system / 中文 / English** mode
- **Display-layer translation**: built-in defaults (categories, priorities, time buckets, persona tags) follow the UI language; names you customize always stay as typed
- **Full coverage**: statistics, settings, context menus, confirm dialogs and toasts all share one catalogue — switching syncs across windows

### 🪟 Windows & tray
- **Tray-resident**: borderless / transparent main window; the close button hides to the tray, `Ctrl+I` summons it and it auto-hides on focus loss
- **Multi-window**: hover tooltip / image viewer / delete confirm are separate windows communicating via events
- **Single instance**: relaunching focuses the running window instead of spawning a new one
- **Production hardening**: packaged builds disable the context menu and debug shortcuts; dev builds keep full debugging

### ✨ Other details
- Each tab remembers its scroll position; switching tabs focuses the search box automatically
- Shared components: date picker (DatePicker), dropdown (UiDropdown — auto-clamps and flips at viewport edges), hover bubble (v-tip)
- Tabs can be long-press dragged or moved up/down; order and visibility persist

## 🧱 Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri 2](https://tauri.app) |
| Frontend | [Nuxt 4](https://nuxt.com) + [Vue 3](https://vuejs.org) |
| Styling | [Tailwind CSS 3](https://tailwindcss.com) |
| Database | SQLite ([@tauri-apps/plugin-sql](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql)) |
| System | global shortcuts, clipboard read/write, notifications, window control, tray, autostart, single instance, external links |
| Data collection | Rust foreground-app watcher (per-platform for Windows / macOS / Linux, 30s segments) |
| Internationalization | lightweight in-house i18n + TOML catalogues (no third-party i18n dependency) |
| Languages | TypeScript (frontend) + Rust (Tauri shell) |

## 🚀 Getting started

### Prerequisites
- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://www.rust-lang.org) (required to build Tauri 2)
- Platform-specific dependencies — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

### Run from source

```bash
# 1. Clone the repository
git clone https://github.com/s0uths1d3/s1d3_board.git
cd s1d3_board

# 2. Install dependencies
npm install

# 3. Launch the desktop app
npm run tauri:dev
```

- `tauri:dev` starts the frontend dev server (port 12321) first, then compiles and opens the desktop window
- **The first launch compiles Rust dependencies and takes a while**; later runs reuse the cache
- Dev builds keep the context menu and debug shortcuts such as `F5` / `F12` (disabled after packaging)

> The database, clipboard watcher, tray, global shortcuts and app-usage tracking all depend on the Tauri runtime — launch via `tauri:dev`; a plain browser preview can't use any of them.

### Dev ports

| Side | Port | Configured in |
|---|---|---|
| Frontend (Nuxt dev server) | `12321` | `package.json` dev script (`nuxt dev --port 12321`) |
| Backend (Tauri dev variable) | `12921` | `.env` (`TAURI_DEV_PORT`) |
| Tauri devUrl (points at frontend) | `http://localhost:12321` | `src-tauri/tauri.conf.json` |

The frontend port is set explicitly by the dev script (Nuxt 4's CLI owns the port) and must match `devUrl`, otherwise dev mode can't connect.

### Build for production

```bash
npm run tauri:build
```

Output lands in `src-tauri/target/release/bundle/`; you can also run `src-tauri/target/release/s1d3_board.exe` (Windows) directly to verify release behavior.

For a build with debug symbols (troubleshooting): `npm run tauri build -- --debug`, output in `src-tauri/target/debug/`.

## 📁 Project layout

```
├── app/                     # Frontend (Nuxt/Vue)
│   ├── app.vue              # Root component (window focus/visibility, global state)
│   ├── assets/
│   │   ├── css/             # Global styles (Tailwind + animations + shared tooltip)
│   │   ├── lang/            # Language catalogues (zh-cn.toml / en-us.toml)
│   │   ├── icon/            # App icons
│   │   └── svg/             # Inline icon assets
│   ├── components/
│   │   ├── appusage/        # App usage page
│   │   ├── common/          # Shared components (DatePicker, DeleteConfirm)
│   │   ├── mainpage/        # Clipboard UI (TitleBar / ContextMenu / HighlightText)
│   │   ├── note/            # Notes
│   │   ├── pinned/          # Pinned clips
│   │   ├── setting/         # Settings (SettingMain / ShortcutRow / SettingInput)
│   │   ├── statistics/      # Statistics (StatsPage / RangeBar / LazySection)
│   │   ├── todo/            # Todos (incl. ReminderPicker)
│   │   └── ui/              # Primitives (UiDropdown / UiSegmented / UiToggleSwitch / UiColorPicker)
│   ├── composables/         # Composables (tabs & nav, i18n, theme, popup position, infinite list, ...)
│   ├── i18n/                # i18n entry (messages.ts, loaded from assets/lang)
│   ├── pages/               # Routes (index main window / tooltip hover / viewer image)
│   ├── plugins/             # Nuxt plugins (tray init, v-tip, i18n, theme, production behavior)
│   ├── src/
│   │   ├── commands/        # Command pattern
│   │   │   ├── global/      # Global shortcut commands
│   │   │   ├── local/       # Local shortcut commands
│   │   │   └── shortcuts/   # Registration / conflict detection / persistence
│   │   ├── db/              # SQLite data access (dbService)
│   │   ├── statistics/      # Statistics service (statsService / userTags)
│   │   ├── todo/            # Todo domain logic
│   │   └── entities.ts      # Entity types
│   └── utils/               # Utilities (dates, TOML parsing, shortcut formatting, focus navigation)
├── public/                  # Static assets
├── server/                  # Nuxt server
├── src-tauri/               # Tauri shell (Rust)
│   └── src/app_usage/       # Foreground app tracking (windows / macos / linux / unsupported)
├── nuxt.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## ⚙️ Architecture

- **Command pattern**: shortcuts map to `Command` objects with global / local scopes to avoid collisions
- **Event decoupling**: shortcut commands dispatch business events via `window.dispatchEvent`; pages listen and react
- **Geometric nearest-neighbor navigation**: arrow keys pick the visually nearest item, working for grids and masonry layouts
- **Streaming rendering**: clipboard / pinned / notes / todo lists page in on demand (`LIMIT/OFFSET`) and append on scroll; statistics sections render progressively
- **Batched statistics writes**: counters accumulate in memory, flush through throttled UPSERTs and force-flush on exit (no data loss)
- **App usage pipeline**: Rust accumulates foreground time in 30s segments (nothing is collected while the toggle is off); the frontend pulls deltas into the `app_usage` table and the page aggregates by range
- **Multi-window collaboration**: the main window and the tooltip / image viewer / delete confirm windows communicate over Tauri events (show, hide, hover, activate); theme and language changes broadcast to every window
- **Settings persistence**: lightweight settings live in a `settings` key-value table (`getKeyValue/setKeyValue`); text inputs debounce before writing and flush on unmount
- **Display-layer translation**: the database stores raw values only; built-in data (categories / priorities / buckets) is mapped at render time, while user-authored data is kept verbatim
- **Shared components**: DatePicker, UiDropdown and the v-tip bubble keep styling consistent everywhere

## 📄 License

Released under the **Apache License 2.0** — see [LICENSE](./LICENSE).

```
Copyright 2026 S1d3

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
