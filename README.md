# S1d3 Board

一个基于 **Tauri 2 + Nuxt 4 + Vue 3 + Tailwind CSS** 的桌面效率工具，为剪贴板、待办、便签、统计等日常高频操作提供系统托盘内快捷访问。

## ✨ 功能特性

### 剪贴板管理（clip）
- **实时剪贴板监听**：复制的内容自动入库，支持文本与图片（base64）
- **全文搜索**：关键词过滤 + 匹配文本金色高亮
- **收藏夹**：一键收藏/取消收藏重要内容
- **粘贴命令**：选中后按 `Enter` 或 `Ctrl+数字` 直接模拟粘贴到光标处
- **悬停提示窗口**：独立 tooltip 窗口展示截断内容的完整信息
- **删除确认**：删除前弹出独立确认窗口，支持 `Enter`/`Esc`/`←→` 键盘操作
- **存储上限**：可配置「剪贴板最大存储数量」，超出自动淘汰最旧记录

### 常用剪贴板（pinned）
- 将常用内容**置顶固定**为可快速粘贴的常用项，瀑布流布局展示
- `Ctrl+U` 快速把当前选中项添加为常用剪贴
- `Ctrl+1 ~ Ctrl+0` 前 10 项快捷粘贴
- **方向键导航**：`↑↓←→` 几何最近邻选中，`Delete` 删除（内联确认框）

### 待办事项（todo）
- 创建/编辑/删除待办，支持优先级（低/中/高）与分类
- 完成状态切换，列表流式加载
- **截止日期**：统一暖色主题日期时间选择器

### 便签（note）
- 多色便签（蓝/黄/粉/绿/紫/橙），瀑布流布局
- **双击 / Ctrl+Enter** 进入编辑，**Ctrl+Enter** 保存，`Ctrl+N` 新建
- 删除带内联确认框 + 即时 toast 反馈
- 流式分批渲染 + 滚动加载，大数据量不卡顿

### 统计（statistics）
- **多维使用数据**：剪贴/图片/粘贴/待办/便签/收藏/使用时长/快捷键/Tab 访问
- **时间范围**：日/周/月/年/自定义，左右箭头切换上一阶段/下一阶段
- **核心指标卡片 + Tab 访问分布 + 活跃时段**
- **趣味数据**：打字量（复制字符总量）、复制之王、最长连续使用、时长换算
- **每日趋势图**：逐日柱状，超一季自动按月降采样
- **用户画像标签**：实时生成使用习惯标签（按类别分组）
- **专属大标签**：唯一专属称号 + 评分明细
- 统计模块有**解锁门槛**（活跃 ≥ 7 天 且 粘贴 ≥ 1000 次），满足后出现在标题栏
- 流式加载：区块随滚动渐进渲染，首屏更轻

### 全局快捷键系统
- 所有快捷键可在设置页**录制、修改、启停、重置**
- 关键默认键位：
  | 快捷键 | 功能 |
  |---|---|
  | `Ctrl+I` | 显示/隐藏主窗口 |
  | `Ctrl+← / Ctrl+→` | 切换标签页 |
  | `Ctrl+U` | 添加选中项为常用剪贴 |
  | `Ctrl+1 ~ Ctrl+0` | 常用剪贴前 10 项快捷粘贴 |
  | `Ctrl+Enter` | 保存便签 |
  | `Ctrl+N` | 新建便签 |
  | 方向键 | 页面内几何最近邻导航选中项 |
  | `Delete` / `Backspace` | 删除选中项（带确认） |
- 修饰键**精确匹配**，`Ctrl+←/→` 切标签拥有最高优先级

### 设置（setting）
- **开机自启**（Tauri autostart 插件，无需管理员权限）
- 剪贴板最大存储数量
- 快捷键自定义、**提示窗口开关**、配色
- 各分类切换带丝滑过渡动画

### 其他
- 各标签页**独立保存滚动位置**
- 切换标签自动聚焦剪贴板搜索框
- 统一暖色主题**日期选择器**（DatePicker）与**悬停提示气泡**（v-tip）
- 窗口无边框 / 透明，托盘常驻

## 🧱 技术栈

| 层级 | 技术 |
|---|---|
| 桌面容器 | [Tauri 2](https://tauri.app) |
| 前端框架 | [Nuxt 4](https://nuxt.com) + [Vue 3](https://vuejs.org) |
| 样式 | [Tailwind CSS 3](https://tailwindcss.com) |
| 数据库 | SQLite（[@tauri-apps/plugin-sql](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql)） |
| 系统能力 | 全局快捷键、剪贴板 API、通知、窗口控制、开机自启、文件系统 |
| 语言 | TypeScript（前端）+ Rust（Tauri 壳） |

## 🚀 快速开始

### 环境要求
- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://www.rust-lang.org)（Tauri 2 构建需要）
- 各平台系统依赖（参考 [Tauri 环境准备](https://tauri.app/start/prerequisites/)）

### 安装依赖

```bash
npm install
```

### 启动前端（仅 Web 预览）

```bash
npm run dev
```

### 启动桌面应用（开发模式）

```bash
npm run tauri:dev
```

### 构建生产包

```bash
npm run tauri:build
```

产物输出在 `src-tauri/target/release/bundle/`。

## 📁 目录结构

```
├── app/                    # 前端（Nuxt/Vue）
│   ├── assets/css/         # 全局样式（Tailwind + 动画 + 统一提示气泡）
│   ├── components/         # 页面组件
│   │   ├── common/         # 通用组件（DatePicker 日期选择器）
│   │   ├── mainpage/       # 剪贴板主界面
│   │   ├── note/           # 便签
│   │   ├── pinned/         # 常用剪贴板
│   │   ├── setting/        # 设置
│   │   ├── statistics/     # 统计页（StatsPage / LazySection 流式区块）
│   │   └── todo/           # 待办
│   ├── composables/        # 组合式函数（标签状态等）
│   ├── pages/              # 路由页面
│   ├── plugins/            # Vue 插件（v-tip 全局指令等）
│   └── src/
│       ├── commands/       # 命令模式
│       │   ├── global/     # 全局快捷键命令
│       │   ├── local/      # 局部快捷键命令
│       │   └── shortcuts/  # 快捷键注册/管理
│       ├── db/             # SQLite 数据访问
│       ├── statistics/     # 统计服务（statsService / userTags / mockData）
│       ├── utils/          # 工具函数（v-tip 指令、几何导航等）
│       ├── clip.ts
│       └── Entities.ts     # 数据实体类型
├── public/                 # 静态资源
├── server/                 # Nuxt server
├── src-tauri/              # Tauri 壳（Rust，含 SQL migration）
├── nuxt.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## ⚙️ 架构说明

- **命令模式**：快捷键统一映射到 `Command`，全局/局部作用域区分，避免冲突
- **事件解耦**：快捷键命令通过 `window.dispatchEvent` 派发业务事件，页面监听处理
- **几何最近邻导航**：方向键选中基于元素视觉坐标计算最近项，适配网格/瀑布流
- **流式渲染**：便签/待办/统计采用分批渲染 + `IntersectionObserver` 滚动加载
- **统计写入合并**：统计埋点先入内存累加器，节流批量 UPSERT，退出时强制落库（数据零丢失）
- **统一组件**：DatePicker 日期选择器、v-tip 悬停提示，全站样式一致

## 📄 开源协议

本项目基于 **Apache License 2.0** 开源，详见 [LICENSE](./LICENSE)。

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
