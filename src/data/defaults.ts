import type { Bookmark, BrowserTab, Preferences } from '../types';
import { INTERNAL_ROUTES } from '../utils/url';
import { createId } from '../utils/storage';
import { defaultShortcuts } from './shortcuts';

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'light',
  searchEngine: 'baidu',
  customSearchEngines: [],
  showBookmarksBar: true,
  reduceMotion: false,
  homePage: INTERNAL_ROUTES.home,
  startupBehavior: 'continue',
  downloadsAskWhere: true,
  rememberHistory: true,
  doubleClickClosesTab: true,
  rightClickClosesTab: false,
  showTabPreviews: true,
  showAddressSuggestions: true,
  scrollTabsToSwitch: true,
  webFontSize: 16,
  webFontFamily: '',
  webZoom: 100,
  tabSleepEnabled: true,
  tabSleepDelayMinutes: 30,
  maxResidentTabs: 8,
  translationConsent: false,
  shortcuts: defaultShortcuts(),
  bossKey: 'Ctrl+Shift+L',
  autoFillEnabled: true,
  passwordSavingEnabled: true,
  translationTarget: 'zh-CN',
  translationProvider: 'auto',
  translationApiKey: '',
  addressBarButtons: {
    reader: true,
    translate: true,
    screenshot: true,
    adblock: true,
    passwords: true,
    bookmarks: true,
    history: true,
    downloads: true,
    extensions: true,
    settings: true,
  },
};

export function createNewTab(url = INTERNAL_ROUTES.newtab, title = '新标签页'): BrowserTab {
  return {
    id: createId('tab'),
    entries: [{ url, title, visitedAt: Date.now() }],
    historyIndex: 0,
    isLoading: false,
    progress: 0,
    error: null,
    loadKey: 0,
  };
}

export const DEFAULT_BOOKMARKS: Bookmark[] = [
  {
    id: 'bookmark-mdn',
    title: 'MDN Web Docs',
    url: 'https://developer.mozilla.org/zh-CN/',
    createdAt: Date.now(),
  },
  {
    id: 'bookmark-github',
    title: 'GitHub',
    url: 'https://github.com/',
    createdAt: Date.now() - 1000,
  },
  {
    id: 'bookmark-luma',
    title: 'Luma 偏好设置',
    url: INTERNAL_ROUTES.settings,
    createdAt: Date.now() - 2000,
  },
];

export const QUICK_LINKS = [
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/zh-CN/', color: 'violet', mark: 'M' },
  { title: 'GitHub', url: 'https://github.com/', color: 'charcoal', mark: 'G' },
  { title: 'Figma', url: 'https://www.figma.com/', color: 'coral', mark: 'F' },
  { title: '哔哩哔哩', url: 'https://www.bilibili.com/', color: 'pink', mark: 'B' },
  { title: '少数派', url: 'https://sspai.com/', color: 'red', mark: 'S' },
  { title: 'Example', url: 'https://example.com/', color: 'sage', mark: 'E' },
] as const;
