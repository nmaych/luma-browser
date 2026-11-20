interface LumaDownloadRecord {
  id: string;
  filename: string;
  url: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  speed: number;
  startedAt: number;
  incognito: boolean;
  paused: boolean;
  /** Whether the interrupted transfer can continue from the partial file. */
  resumable?: boolean;
}

interface LumaPageViewEvent {
  tabId: string;
  type: string;
  payload: unknown;
}

interface LumaPageViewInfo {
  webContentsId: number;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}

interface LumaInitialTab {
  id: string;
  title: string;
  entries: { url: string; title: string; visitedAt: number }[];
  historyIndex: number;
  viewUrl?: string;
  favicon?: string;
}

interface LumaAppVersions {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
}

type LumaUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface LumaUpdateLine {
  id: string;
  label: string;
}

interface LumaUpdatePrefs {
  autoDownload: boolean;
  applyOnQuit: boolean;
}

interface LumaUpdatePending {
  version: string;
  file: string;
  size: number;
  sha256: string | null;
  downloadedAt: number;
}

interface LumaUpdateState {
  status: LumaUpdateStatus;
  currentVersion: string;
  version: string | null;
  percent: number;
  transferred: number;
  total: number;
  error: string | null;
  releaseUrl: string;
  line: string | null;
  lines: LumaUpdateLine[];
  prefs: LumaUpdatePrefs;
  pending: LumaUpdatePending | null;
  lastCheckedAt: number | null;
  updateDir: string;
  logPath: string;
}

/** System memory sample sent when the machine is running low (Chrome Memory Saver style). */
interface LumaMemoryPressure {
  available: number;
  total: number;
  ratio: number;
}

interface LumaExtensionToolbar {
  title: string;
  icon: string | null;
  popup: string | null;
}

interface LumaExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifestVersion: number;
  permissions: string[];
  hostPermissions: string[];
  matches: string[];
  hasAction: boolean;
  hasBackground: boolean;
  enabled: boolean;
  loaded: boolean;
  error: string | null;
  toolbar: LumaExtensionToolbar | null;
}

interface LumaExtensionResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  list: LumaExtension[];
}

interface LumaAppPaths {  install: string;
  userData: string;
  update: string;
  log: string;
  isolated: boolean;
}

interface LumaAdblockState {
  enabled: boolean;
  disabledSites: string[];
  blockedTotal: number;
  engine: 'ghostery' | 'builtin';
  ruleCount: number;
  lastUpdated: number | null;
  updating: boolean;
  error: string | null;
  sources: { id: string; label: string }[];
}

interface LumaPasswordMeta {
  id: string;
  origin: string;
  host: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface LumaPasswordEntry {
  id: string;
  username: string;
  password: string;
}

interface LumaPasswordAccount {
  id: string;
  username: string;
}

interface LumaPasswordStatus {
  available: boolean;
  readOnly: boolean;
  error: string | null;
  recovered: boolean;
}

interface LumaPasswordMutation {
  ok: boolean;
  reason?: string;
  entries: LumaPasswordMeta[];
}

interface LumaPasswordCapture {
  origin: string;
  host: string;
  username: string;
  password: string;
  webContentsId: number;
}

interface LumaTranslationResult {
  ok: boolean;
  translations: string[];
  error?: string;
}

interface LumaDownloadDirectoryInfo {
  directory: string;
  isDefault: boolean;
}

interface LumaBookmarkFileResult {
  canceled: boolean;
  failed?: boolean;
  filePath?: string;
  content?: string;
}

interface LumaDevtoolsBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type LumaPermissionCategory =
  | 'camera'
  | 'microphone'
  | 'notifications'
  | 'geolocation'
  | 'clipboard'
  | 'fullscreen'
  | 'pointerLock';

type LumaPermissionPolicy = 'ask' | 'allow' | 'deny';

interface LumaPermissionOverview {
  defaults: Record<LumaPermissionCategory, LumaPermissionPolicy>;
  sites: { origin: string; permissions: Partial<Record<LumaPermissionCategory, LumaPermissionPolicy>> }[];
}

interface LumaPermissionRequest {
  id: number;
  origin: string;
  host: string;
  categories: LumaPermissionCategory[];
  title: string;
}

interface LumaDesktopApi {
  isDesktop: boolean;
  isIncognito: boolean;
  windowKind: 'main' | 'tearoff';
  initialTab: LumaInitialTab | null;
  initialTabs: LumaInitialTab[];
  initialActiveId: string | null;
  platform: string;
  getAppVersions: () => Promise<LumaAppVersions>;
  getUpdateState: () => Promise<LumaUpdateState | null>;
  checkForUpdates: () => Promise<LumaUpdateState | null>;
  downloadUpdate: (line?: string) => Promise<LumaUpdateState | null>;
  installUpdate: () => Promise<boolean>;
  getUpdatePrefs: () => Promise<LumaUpdatePrefs | null>;
  setUpdatePrefs: (patch: Partial<LumaUpdatePrefs>) => Promise<LumaUpdateState | null>;
  getAppPaths: () => Promise<LumaAppPaths | null>;
  listExtensions: () => Promise<LumaExtension[]>;
  installExtension: (sourcePath?: string) => Promise<LumaExtensionResult>;
  setExtensionEnabled: (id: string, enabled: boolean) => Promise<LumaExtensionResult>;
  reloadExtension: (id: string) => Promise<LumaExtensionResult>;
  removeExtension: (id: string) => Promise<LumaExtensionResult>;
  openExtensionsFolder: () => Promise<boolean>;
  openExtensionPopup: (
    id: string,
    anchor: { x: number; y: number; width: number; height: number },
  ) => Promise<{ ok: boolean; error?: string; closed?: boolean; opened?: boolean }>;
  closeExtensionPopup: () => Promise<boolean>;
  onExtensionsChanged: (callback: (list: LumaExtension[]) => void) => () => void;
  onUpdateState: (callback: (state: LumaUpdateState) => void) => () => void;
  onMemoryPressure: (callback: (info: LumaMemoryPressure) => void) => () => void;
  openIncognito: () => void;
  openDownloads: () => void;
  tearOffTab: (tab: LumaInitialTab, point?: { screenX: number; screenY: number }) => Promise<boolean>;
  splitTabs: (
    tabs: LumaInitialTab[],
    activeId: string,
    bounds?: { x: number; y: number; width: number; height: number },
  ) => Promise<number | false>;
  moveWindow: (position: { x: number; y: number }) => Promise<boolean>;
  beginTabDrag: (payload: {
    tab: LumaInitialTab;
    point: { screenX: number; screenY: number };
    offset: { x: number; y: number };
    size: { width: number; height: number };
  }) => Promise<boolean>;
  updateTabDrag: (point: { screenX: number; screenY: number }) => Promise<boolean>;
  showTabPreview: (payload: {
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    host: string;
    thumbnail?: string;
    favicon?: string;
    theme?: { surface?: string; border?: string; text?: string; muted?: string; soft?: string };
  }) => Promise<boolean>;
  hideTabPreview: () => Promise<boolean>;
  onTabDragStarted: (callback: (payload: { tabId: string; title?: string }) => void) => () => void;
  onTabDragMerged: (callback: (payload: { tabId: string; title?: string }) => void) => () => void;
  endTabDrag: (payload?: { point?: { screenX: number; screenY: number } }) => Promise<{
    merged: boolean;
    returned: boolean;
    ignored?: boolean;
    windowId?: number;
  }>;
  mergeTab: (
    tab: LumaInitialTab,
    point?: { screenX: number; screenY: number },
  ) => Promise<{ merged: boolean }>;
  onAdoptTab: (callback: (tab: LumaInitialTab) => void) => () => void;
  capturePage: (
    targetId: number,
    options?: {
      mode?: 'save' | 'copy';
      fullPage?: boolean;
      suggestedName?: string;
      /** Selection in CSS pixels relative to the webview. */
      region?: { x: number; y: number; width: number; height: number };
      /** Webview size in CSS pixels, used to scale the crop. */
      viewport?: { width: number; height: number };
    },
  ) => Promise<{
    ok: boolean;
    copied?: boolean;
    canceled?: boolean;
    filePath?: string;
    reason?: string;
    size?: { width: number; height: number };
  }>;
  fetchFavicon: (url: string) => Promise<string | null>;
  getCursorPoint: () => Promise<{ x: number; y: number }>;
  getWindowId: () => Promise<number>;
  pageView: {
    ensure: (tabId: string, url?: string, incognito?: boolean) => Promise<LumaPageViewInfo | null>;
    attach: (tabId: string, bounds: { x: number; y: number; width: number; height: number }, incognito?: boolean) => Promise<boolean>;
    move: (
      tabId: string,
      windowId: number,
      bounds: { x: number; y: number; width: number; height: number },
      incognito?: boolean,
    ) => Promise<boolean>;
    detach: (tabId: string, incognito?: boolean) => Promise<boolean>;
    setBounds: (tabId: string, bounds: { x: number; y: number; width: number; height: number }, incognito?: boolean) => Promise<boolean>;
    setVisible: (tabId: string, visible: boolean, incognito?: boolean) => Promise<boolean>;
    info: (tabId: string, incognito?: boolean) => Promise<LumaPageViewInfo | null>;
    command: (tabId: string, name: string, args?: unknown[], incognito?: boolean) => Promise<unknown>;
    destroy: (tabId: string, incognito?: boolean) => Promise<boolean>;
  };
  /** Mirrors an open HTML popover above the native page so the page is never covered. */
  overlay: {
    show: (payload: {
      id: string;
      rect: { x: number; y: number; width: number; height: number };
      html: string;
      css?: string;
      theme?: string;
    }) => void;
    hide: (id?: string) => void;
    onClick: (callback: (steps: number[]) => void) => () => void;
    onOutside: (callback: () => void) => () => void;
  };
  onPageEvent: (callback: (event: LumaPageViewEvent) => void) => () => void;
  configureShortcuts: (
    shortcuts: Record<string, string>,
    bossKey: string,
    options?: { downloadsAskWhere?: boolean },
  ) => Promise<{ bossKeyRegistered: boolean }>;
  listDownloads: () => Promise<LumaDownloadRecord[]>;
  cancelDownload: (id: string) => Promise<boolean>;
  pauseDownload: (id: string) => Promise<boolean>;
  resumeDownload: (id: string) => Promise<boolean>;
  resumeInterruptedDownload: (id: string) => Promise<boolean>;
  removeDownload: (id: string) => Promise<boolean>;
  deleteDownloadFile: (id: string) => Promise<boolean>;
  clearDownloads: () => Promise<boolean>;
  openDownload: (id: string) => Promise<boolean>;
  showDownloadInFolder: (id: string) => Promise<boolean>;
  getDownloadDirectory: () => Promise<LumaDownloadDirectoryInfo>;
  chooseDownloadDirectory: () => Promise<LumaDownloadDirectoryInfo>;
  resetDownloadDirectory: () => Promise<LumaDownloadDirectoryInfo>;
  saveUrl: (webContentsId: number, url: string) => Promise<boolean>;
  importBookmarks: () => Promise<LumaBookmarkFileResult>;
  exportBookmarks: (content: string, suggestedName: string) => Promise<LumaBookmarkFileResult>;
  minimize: () => void;
  focusUi: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  toggleFullscreen: () => Promise<boolean>;
  printPage: (targetId: number) => Promise<{ success: boolean; reason: string }>;
  savePagePdf: (targetId: number, suggestedName: string) => Promise<{ canceled: boolean; failed?: boolean; filePath?: string }>;
  openDevTools: (targetId: number, bounds: LumaDevtoolsBounds) => Promise<boolean>;
  resizeDevTools: (targetId: number, bounds: LumaDevtoolsBounds) => Promise<boolean>;
  setDevToolsVisible: (targetId: number, visible: boolean) => Promise<boolean>;
  closeDevTools: (targetId: number) => Promise<boolean>;
  getPermissions: () => Promise<LumaPermissionOverview>;
  setPermissionDefault: (category: LumaPermissionCategory, policy: LumaPermissionPolicy) => Promise<LumaPermissionOverview | null>;
  setSitePermission: (origin: string, category: LumaPermissionCategory, policy: LumaPermissionPolicy | null) => Promise<LumaPermissionOverview | null>;
  removeSitePermission: (origin: string) => Promise<LumaPermissionOverview | null>;
  clearSitePermissions: () => Promise<LumaPermissionOverview>;
  respondPermission: (requestId: number, decision: 'allow' | 'deny' | 'always') => Promise<boolean>;
  openExternal: (url: string) => Promise<boolean>;
  writeClipboard: (text: string) => Promise<void>;
  readClipboard: () => Promise<string>;
  clearSiteData: () => Promise<boolean>;
  getSiteData: () => Promise<LumaSiteDataOverview>;
  clearSiteDataForDomain: (domain: string) => Promise<boolean>;
  clearCache: () => Promise<boolean>;
  clearCookies: () => Promise<boolean>;
  getAdblockState: () => Promise<LumaAdblockState>;
  setAdblockEnabled: (enabled: boolean) => Promise<LumaAdblockState>;
  setAdblockSite: (host: string, disabled: boolean) => Promise<LumaAdblockState>;
  updateAdblock: () => Promise<LumaAdblockState>;
  translatePage: (texts: string[], target: string) => Promise<LumaTranslationResult>;
  getPasswordStatus: () => Promise<LumaPasswordStatus>;
  listPasswords: () => Promise<LumaPasswordMeta[]>;
  savePassword: (
    origin: string,
    username: string,
    password: string,
  ) => Promise<{ ok: boolean; reason?: string; entries?: LumaPasswordMeta[] }>;
  deletePassword: (id: string) => Promise<LumaPasswordMutation>;
  clearPasswords: () => Promise<LumaPasswordMutation>;
  revealPassword: (id: string) => Promise<LumaPasswordEntry | null>;
  getPasswordsForOrigin: (origin: string) => Promise<LumaPasswordAccount[]>;
  autofillTab: (webContentsId: number, entryId?: string) => Promise<boolean>;
  hasPasswordCredential: (origin: string, username: string, password: string) => Promise<boolean>;
  onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  onOpenInNewTab: (callback: (url: string) => void) => () => void;
  onShortcut: (callback: (command: string) => void) => () => void;
  onPageContextMenu: (callback: (info: PageContextMenuInfo) => void) => () => void;
  onDownloadsChanged: (callback: (items: LumaDownloadRecord[]) => void) => () => void;
  onPermissionRequest: (callback: (request: LumaPermissionRequest) => void) => () => void;
  onAdblockBlocked: (callback: (info: { webContentsId: number; host: string; count: number }) => void) => () => void;
  onRenderGone: (callback: (info: { webContentsId: number; reason: string; exitCode?: number }) => void) => () => void;
  onUnresponsive: (callback: (info: { webContentsId: number }) => void) => () => void;
}

interface LumaSiteDataOverview {
  cacheBytes: number;
  cookieCount: number;
  sites: { domain: string; cookieCount: number; secure: boolean }[];
}

interface PageContextMenuInfo {
  webContentsId: number;
  x: number;
  y: number;
  clientX: number | null;
  clientY: number | null;
  selectionText: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  isEditable: boolean;
  editFlags: {
    canCopy: boolean;
    canCut: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

interface Window {
  lumaDesktop?: LumaDesktopApi;
}
