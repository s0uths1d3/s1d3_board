/**
 * 设置分组静态定义（SettingMain 与全局搜索面板共用）：
 * GlobalSearch 据此构建设置项索引供 Ctrl+P 搜索，命中后跳转设置页并写入搜索词
 * 定位到具体选项——清单单一来源，两处结果天然一致。
 */

export interface SettingItem {
  label: string;
  value: string | string[];
  type: 'input' | 'select' | 'checkbox' | 'action';
  /** 搜索结果专用：命中项的来源分组标题（正常渲染时无此字段，用于结果列表显示归属） */
  groupTitle?: string;
}

/** 子分组：顶层分组内的分节卡片（标题 + 该节设置项），控制左侧分类数量 */
export interface SettingChildGroup {
  title: string;
  items: SettingItem[];
}

export interface SettingGroup {
  title: string;
  type: string;
  items: SettingItem[];
  /** 子分组（有则渲染为多张分节卡片，items 直挂方式仅剩类型兼容默认值） */
  children?: SettingChildGroup[];
}

export const settings: SettingGroup[] = [
  {
    title: 'setting.categories.shortcuts',
    type: 'shortcut',
    items: [],
  },
  {
    title: 'setting.categories.nav',
    type: 'nav',
    items: [],
  },
  {
    // 剪贴板：存储上限 / 悬浮预览 / 隐私与安全 三个子分组
    title: 'setting.categories.clipboard',
    type: 'general',
    items: [],
    children: [
      {
        title: 'setting.subgroups.clipboard_general',
        items: [
          { label: 'setting.general.clipboard_limit', value: '', type: 'input' },
          { label: 'setting.general.image_limit', value: '', type: 'input' },
          { label: 'setting.general.clip_retention', value: '', type: 'select' },
          { label: 'setting.general.popup_position', value: '', type: 'select' },
        ],
      },
      {
        title: 'setting.subgroups.preview',
        items: [
          { label: 'setting.general.tooltip_window', value: '', type: 'checkbox' },
          { label: 'setting.general.tooltip_wrap', value: '', type: 'checkbox' },
          { label: 'setting.general.paste_restore_clipboard', value: '', type: 'checkbox' },
        ],
      },
      {
        title: 'setting.subgroups.privacy',
        items: [
          { label: 'setting.general.privacy_pause', value: '', type: 'checkbox' },
          { label: 'setting.general.sensitive_filter', value: '', type: 'checkbox' },
          { label: 'setting.general.ignored_apps', value: '', type: 'action' },
        ],
      },
    ],
  },
  {
    // 灵动岛：显示效果子组 + 灵动岛 API 与 Webhook 配置卡片（模板尾部按 title 挂载）
    title: 'setting.categories.island',
    type: 'island',
    items: [],
    children: [
      {
        title: 'setting.subgroups.island_display',
        items: [
          { label: 'setting.general.island_hint', value: '', type: 'checkbox' },
          { label: 'setting.general.island_delay', value: '', type: 'input' },
          { label: 'setting.general.island_duration', value: '', type: 'input' },
        ],
      },
    ],
  },
  {
    // 智能与 AI：智能剪贴板专属块在前（模板按 type==='smart' 渲染），AI 分析子组卡片在后
    title: 'setting.categories.smart',
    type: 'smart',
    items: [],
    children: [
      {
        title: 'setting.subgroups.ai',
        items: [
          { label: 'setting.general.ai_provider', value: '', type: 'select' },
          { label: 'setting.general.ai_base_url', value: '', type: 'input' },
          { label: 'setting.general.ai_model', value: '', type: 'input' },
          { label: 'setting.general.ai_test', value: '', type: 'action' },
          { label: 'setting.general.api_key', value: '', type: 'input' },
          { label: 'setting.general.ai_analysis_max', value: '', type: 'input' },
        ],
      },
    ],
  },
  {
    // 通用：应用 / 外观与语言 / 待办与提醒 / 数据管理 四个子组
    title: 'setting.categories.general',
    type: 'general',
    items: [],
    children: [
      {
        title: 'setting.subgroups.app',
        items: [
          { label: 'setting.general.launch_at_startup', value: '', type: 'checkbox' },
          { label: 'setting.general.auto_hide', value: '', type: 'checkbox' },
          { label: 'setting.general.app_usage_tracking', value: '', type: 'checkbox' },
          { label: 'setting.general.replay_onboarding', value: '', type: 'action' },
        ],
      },
      {
        title: 'setting.subgroups.appearance',
        items: [
          { label: 'setting.general.color_scheme', value: '', type: 'select' },
          { label: 'setting.general.locale', value: '', type: 'select' },
          { label: 'setting.general.mask_blur', value: '', type: 'input' },
        ],
      },
      {
        title: 'setting.subgroups.todo_notify',
        items: [
          { label: 'setting.general.smart_reminder', value: '', type: 'checkbox' },
          { label: 'setting.general.todo_system_notify', value: '', type: 'checkbox' },
        ],
      },
      {
        title: 'setting.subgroups.data',
        items: [
          { label: 'setting.general.clear_database', value: '', type: 'action' },
          { label: 'setting.general.export_data', value: '', type: 'action' },
          { label: 'setting.general.import_data', value: '', type: 'action' },
          { label: 'setting.general.auto_backup_restore', value: '', type: 'action' },
        ],
      },
    ],
  },
  {
    title: 'setting.categories.about',
    type: 'about',
    items: [],
  }
];
