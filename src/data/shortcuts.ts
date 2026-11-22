export type ShortcutAction =
  | 'new-tab'
  | 'new-incognito'
  | 'close-tab'
  | 'reopen-tab'
  | 'focus-address'
  | 'reload'
  | 'back'
  | 'forward'
  | 'find'
  | 'print'
  | 'bookmark'
  | 'history'
  | 'downloads'
  | 'toggle-bookmarks'
  | 'devtools'
  | 'reader'
  | 'translate'
  | 'screenshot'
  | 'sleep-tabs'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface ShortcutItem {
  action: ShortcutAction;
  label: string;
  description?: string;
}

export interface ShortcutGroup {
  title: string;
  description: string;
  items: ShortcutItem[];
}

/** Default bindings; the same values are mirrored in electron/main.cjs. */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  'new-tab': 'Ctrl+T',
  'new-incognito': 'Ctrl+Shift+N',
  'close-tab': 'Ctrl+W',
  'reopen-tab': 'Ctrl+Shift+T',
  'focus-address': 'Ctrl+L',
  reload: 'Ctrl+R',
  back: 'Alt+ArrowLeft',
  forward: 'Alt+ArrowRight',
  find: 'Ctrl+F',
  print: 'Ctrl+P',
  bookmark: 'Ctrl+D',
  history: 'Ctrl+H',
  downloads: 'Ctrl+J',
  'toggle-bookmarks': 'Ctrl+Shift+B',
  devtools: 'F12',
  reader: 'Ctrl+Shift+R',
  translate: 'Ctrl+Shift+Y',
  screenshot: 'Ctrl+Shift+X',
  'sleep-tabs': 'Ctrl+Shift+S',
  'zoom-in': 'Ctrl+=',
  'zoom-out': 'Ctrl+-',
  'zoom-reset': 'Ctrl+0',
};

export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  'new-tab': '新建标签页',
  'new-incognito': '新建无痕窗口',
  'close-tab': '关闭当前标签页',
  'reopen-tab': '恢复关闭的标签页',
  'focus-address': '聚焦地址栏',
  reload: '刷新当前页面',
  back: '后退',
  forward: '前进',
  find: '在页面中查找',
  print: '打印 / 另存为 PDF',
  bookmark: '添加或移除书签',
  history: '打开历史记录',
  downloads: '打开下载内容',
  'toggle-bookmarks': '显示或隐藏书签栏',
  devtools: '开发者工具',
  reader: '阅读模式',
  translate: '网页翻译',
  screenshot: '网页截图',
  'sleep-tabs': '立即休眠后台标签页',
  'zoom-in': '放大网页',
  'zoom-out': '缩小网页',
  'zoom-reset': '恢复 100%',
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '标签页',
    description: '快速管理当前窗口中的页面与后台内存。',
    items: [
      { action: 'new-tab', label: '新建标签页' },
      { action: 'new-incognito', label: '新建无痕窗口' },
      { action: 'close-tab', label: '关闭当前标签页' },
      { action: 'reopen-tab', label: '恢复关闭的标签页' },
      { action: 'sleep-tabs', label: '立即休眠后台标签页' },
    ],
  },
  {
    title: '页面导航',
    description: '地址栏与网页浏览常用操作。',
    items: [
      { action: 'focus-address', label: '聚焦地址栏' },
      { action: 'reload', label: '刷新当前页面' },
      { action: 'back', label: '后退' },
      { action: 'forward', label: '前进' },
      { action: 'find', label: '在页面中查找' },
      { action: 'zoom-in', label: '放大网页' },
      { action: 'zoom-out', label: '缩小网页' },
      { action: 'zoom-reset', label: '恢复 100%' },
      { action: 'print', label: '打印 / 另存为 PDF' },
    ],
  },
  {
    title: '阅读与工具',
    description: '阅读模式、翻译与开发者工具。',
    items: [
      { action: 'reader', label: '切换阅读模式' },
      { action: 'translate', label: '翻译当前网页' },
      { action: 'screenshot', label: '保存当前网页截图' },
      { action: 'devtools', label: '开发者工具' },
    ],
  },
  {
    title: '浏览工具',
    description: '书签、历史记录与界面控制。',
    items: [
      { action: 'bookmark', label: '添加或移除书签' },
      { action: 'history', label: '在新标签页打开历史记录' },
      { action: 'downloads', label: '打开下载内容' },
      { action: 'toggle-bookmarks', label: '显示或隐藏书签栏' },
    ],
  },
];

export function defaultShortcuts(): Record<string, string> {
  return { ...DEFAULT_SHORTCUTS };
}

/** Keeps only known actions with usable accelerator strings. */
export function sanitizeShortcuts(value: unknown): Record<string, string> {
  const next = defaultShortcuts();
  if (!value || typeof value !== 'object') return next;
  for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
    const candidate = (value as Record<string, unknown>)[action];
    if (typeof candidate === 'string' && candidate.trim() && candidate.length <= 64) {
      next[action] = candidate.trim();
    }
  }
  return next;
}
