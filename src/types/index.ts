export type InternalPage = 'home' | 'newtab' | 'bookmarks' | 'history' | 'settings';
export type ThemePreference = 'light' | 'dark' | 'system';
export type BuiltInSearchEngine = 'baidu' | 'google' | 'bing';
export type SearchEngine = BuiltInSearchEngine | `custom:${string}`;
export type PanelName = 'bookmarks' | 'history' | null;

export interface CustomSearchEngine {
  id: `custom:${string}`;
  name: string;
  urlTemplate: string;
  createdAt: number;
}

export interface TabEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export type BrowserErrorType = 'offline' | 'invalid-url' | 'load-failed';

export interface BrowserError {
  type: BrowserErrorType;
  title: string;
  message: string;
}

export interface BrowserTab {
  id: string;
  entries: TabEntry[];
  historyIndex: number;
  isLoading: boolean;
  progress: number;
  error: BrowserError | null;
  loadKey: number;
  /** URL currently requested from the native webview. Kept separate from live history sync. */
  viewUrl?: string;
  favicon?: string;
  isAudible?: boolean;
  isMuted?: boolean;
  isDesktopWeb?: boolean;
  /** The native guest was discarded to reclaim memory; activating the tab reloads it. */
  isSleeping?: boolean;
  /** Pinned tabs stay at the left, shrink to their icon and survive a restart. */
  pinned?: boolean;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
  folderId?: string;
  favicon?: string;
  /** Position among top-level bookmarks and folders; falls back to createdAt. */
  order?: number;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  createdAt: number;
  /** Position among top-level bookmarks and folders; falls back to createdAt. */
  order?: number;
}

export interface HistoryItem {
  id: string;
  title: string;
  url: string;
  visitedAt: number;
  favicon?: string;
}

export interface SiteDataSite {
  domain: string;
  cookieCount: number;
  secure: boolean;
}

export interface SiteDataOverview {
  cacheBytes: number;
  cookieCount: number;
  sites: SiteDataSite[];
}

export type PermissionCategory =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'geolocation'
  | 'clipboard'
  | 'fullscreen'
  | 'pointerLock';

export type PermissionPolicy = 'ask' | 'allow' | 'deny';

export interface PermissionSite {
  origin: string;
  permissions: Partial<Record<PermissionCategory, PermissionPolicy>>;
}

export interface PermissionOverview {
  defaults: Record<PermissionCategory, PermissionPolicy>;
  sites: PermissionSite[];
}

export interface PermissionPromptRequest {
  id: number;
  origin: string;
  host: string;
  categories: PermissionCategory[];
  title: string;
}

/** Right-side address bar buttons the user can hide from settings. */
export type AddressBarButton =
  | 'reader'
  | 'translate'
  | 'screenshot'
  | 'adblock'
  | 'passwords'
  | 'bookmarks'
  | 'history'
  | 'downloads'
  | 'extensions'
  | 'settings';

export type TranslationProvider = 'auto' | 'deepl' | 'google' | 'mymemory';

export interface Preferences {
  theme: ThemePreference;
  searchEngine: SearchEngine;
  customSearchEngines: CustomSearchEngine[];
  showBookmarksBar: boolean;
  reduceMotion: boolean;
  /** URL opened by the home button; `luma://home` uses the built-in page. */
  homePage: string;
  /** What the first window shows: the previous session or a fresh new tab. */
  startupBehavior: 'continue' | 'new-tab';
  /** Ask for a folder before each download; off saves straight to the download folder. */
  downloadsAskWhere: boolean;
  /** Record visited pages in history; off keeps existing entries but stops adding. */
  rememberHistory: boolean;
  doubleClickClosesTab: boolean;
  rightClickClosesTab: boolean;
  showTabPreviews: boolean;
  showAddressSuggestions: boolean;
  scrollTabsToSwitch: boolean;
  /** Default font size for web pages, in pixels. */
  webFontSize: number;
  /** CSS font-family applied to web pages; empty keeps the site's own fonts. */
  webFontFamily: string;
  /** Page zoom percentage (50–200). */
  webZoom: number;
  /** Discard idle background guests to free memory. */
  tabSleepEnabled: boolean;
  /** Minutes a background tab stays idle before it is put to sleep. */
  tabSleepDelayMinutes: number;
  /** Maximum number of simultaneously resident guests; 0 means unlimited. */
  maxResidentTabs: number;
  /** User acknowledged that page text is sent to a third-party translator. */
  translationConsent: boolean;
  /** Action id → accelerator, e.g. `{ 'new-tab': 'Ctrl+T' }`. */
  shortcuts: Record<string, string>;
  /** Global shortcut that hides or restores every Luma window. */
  bossKey: string;
  autoFillEnabled: boolean;
  passwordSavingEnabled: boolean;
  /** Target language for the built-in page translator. */
  translationTarget: string;
  /** Which translation backend to prefer; `auto` tries DeepL, Google, MyMemory. */
  translationProvider: TranslationProvider;
  /** Optional DeepL API key (free keys end with `:fx`); empty disables DeepL. */
  translationApiKey: string;
  /** Visibility of each address-bar action; missing entries fall back to visible. */
  addressBarButtons: Record<AddressBarButton, boolean>;
}

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  tone: 'success' | 'error' | 'info';
}

export interface ParsedInput {
  ok: boolean;
  url: string;
  title: string;
  isExternal: boolean;
  /** The input was not a URL, so the address bar offers a search instead. */
  isSearch?: boolean;
  message?: string;
}
