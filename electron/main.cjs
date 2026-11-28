const { app, BrowserWindow, clipboard, ClipboardItem, crashReporter, dialog, globalShortcut, ipcMain, nativeImage, net, powerSaveBlocker, screen, session, shell, WebContentsView, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { shouldBlock, hostnameOf, AdblockManager, ruleCount: legacyAdblockRuleCount } = require('./adblock.cjs');
const passwordVault = require('./passwords.cjs');
const { createPageViewManager } = require('./pageViews.cjs');
const { createUpdater } = require('./updater.cjs');
const { configureUserData } = require('./appPaths.cjs');
const { createSettingsWriter, loadSettings } = require('./main/settings.cjs');
const { configureSession } = require('./main/sessionPolicy.cjs');
const { createExtensionManager } = require('./extensions.cjs');
const { createUserscriptManager } = require('./main/userscripts.cjs');
const { siteFixesFor, siteStylesFor, skipsRuleListCosmetics } = require('./main/site-fixes.cjs');
const { pipButtonScriptFor } = require('./main/pip-button.cjs');
const { registerBossKey, shortcutActionForInput, currentBossKey } = require('./main/shortcuts.cjs');
const defaultBrowser = require('./main/defaultBrowser.cjs');
const fileIcons = require('./main/fileIcons.cjs');
const { translateTexts } = require('./main/translate.cjs');
const { hostMatchesSite, siteKey, sitesIncludeHost } = require('./main/siteMatch.cjs');
const { planResume } = require('./main/downloadResume.cjs');
const {
  normalizeExternalBounds,
  normalizeScreenPoint,
  normalizeWindowBounds,
  readWindowState,
  writeWindowState,
} = require('./main/windowState.cjs');
const overlaySurface = require('./overlaySurface.cjs');

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const APP_PARTITION = 'persist:luma-browser';
const INCOGNITO_PARTITION = 'luma-incognito';
const DEFAULT_WINDOW_BOUNDS = { width: 1440, height: 900, minWidth: 380, minHeight: 500 };

// Shortcut defaults mirror src/data/shortcuts.ts so guests keep working before
// the renderer has synced the user's custom bindings.
const DEFAULT_SHORTCUTS = {
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

const DEFAULT_APP_SETTINGS = {
  adblock: { enabled: true, disabledSites: [] },
  bossKey: 'Ctrl+Shift+L',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  blockedTotal: 0,
  /** Mirrors the renderer preference: false saves downloads without a dialog. */
  downloadsAskWhere: true,
};

// Chromium's HTTP cache is unbounded by default, which lets a profile grow into
// the gigabytes. Chrome keeps it around 320 MB; 256 MB is the same order of
// magnitude and still caches a working set of sites.
app.commandLine.appendSwitch('disk-cache-size', String(256 * 1024 * 1024));
// Web pages get the two Chromium features that make repeat navigation feel
// instant: the back/forward cache keeps a visited page alive instead of
// reloading it, and the code cache spares re-parsing a site's JavaScript on
// every visit. Both are off in an embedded Chromium unless asked for.
app.commandLine.appendSwitch('enable-features', 'BackForwardCache,ParallelDownloading');
// Chromium's renderer sandbox for every process, including the UI renderer.
// Page views already opt in per view; enabling it app-wide closes the gap.
app.enableSandbox();

// Chrome keeps program files and profile data in separate trees; Luma follows
// the same split so an upgrade never rewrites the profile. Resolved before the
// single-instance lock because that lock lives inside userData.
const appPaths = configureUserData(app, { log: (line) => console.log(line) });
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Memory pressure sampling, modelled on Chrome's Memory Saver: the browser
// polls system memory and asks the UI to discard idle tabs instead of letting
// the OS swap the whole machine to a crawl.
const MEMORY_PRESSURE_INTERVAL_MS = 60 * 1000;
const MEMORY_PRESSURE_RATIO = 0.12;
const MEMORY_PRESSURE_COOLDOWN_MS = 5 * 60 * 1000;

// A second process sharing the same userData would race on passwords.json,
// settings and download records. Keep exactly one instance per profile.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const urls = launchUrls(argv);
    // The download manager is a utility window: focusing it instead of opening
    // a browser window leaves the user stuck on the download list with no way
    // back to the tabs. Any real browser window (including a torn-off one) is
    // preferred; only when none is left does a new one get created.
    const browserWindow = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((candidate) => (
        !candidate.isDestroyed() && candidate !== downloadsWindow && appWindows.has(candidate)
      ));
    if (!browserWindow) {
      queuedLaunchUrls.push(...urls);
      createWindow();
      return;
    }
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.show();
    browserWindow.focus();
    openLaunchUrls(urls, browserWindow);
  });
}

/** Links handed to us by the OS when Luma is the default browser. */
function launchUrls(argv) {
  const urls = [];
  for (const argument of Array.isArray(argv) ? argv : []) {
    if (typeof argument !== 'string') continue;
    const value = argument.trim();
    if (/^(https?|file):\/\//i.test(value)) urls.push(value);
  }
  return urls;
}

/**
 * The renderer owns the tab list, so a URL is a message rather than a
 * navigation. Anything that arrives before the UI is ready is queued.
 */
function openLaunchUrls(urls, win = mainWindow) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const target = win && !win.isDestroyed() ? win : mainWindow;
  if (!target || target.isDestroyed()) {
    queuedLaunchUrls.push(...urls);
    return;
  }
  const send = () => {
    for (const url of urls) target.webContents.send('window:open-url', url);
  };
  if (target.webContents.isLoadingMainFrame()) {
    queuedLaunchUrls.push(...urls);
    return;
  }
  send();
}

function flushQueuedLaunchUrls() {
  if (queuedLaunchUrls.length === 0) return;
  const pending = queuedLaunchUrls.splice(0, queuedLaunchUrls.length);
  openLaunchUrls(pending);
}

const DEV_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' ws: http://127.0.0.1:* http://localhost:*; media-src 'self' https: http:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

function applyAppCspHeaders() {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!isDevelopment || !devUrl) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!details.url.startsWith(devUrl)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DEV_CSP],
      },
    });
  });
}

/** @type {BrowserWindow | null} */
let mainWindow = null;

// Every Luma window, so a tab can be handed from one window to another.
// The value records whether the window uses the incognito partition.
const appWindows = new Map();

// Height of the custom tab bar (src/styles/browser.css). A tab is only merged
// when it is released over another window's tab bar, never over its page.
const TAB_BAR_HEIGHT = 40;
// Height of the address/toolbar row below the tab bar.
const NAV_BAR_HEIGHT = 46;

// Native page views are the migration target for tabs: one WebContentsView per
// tab, movable between windows without reloading. The React UI still uses
// <webview> until the page API and overlay layers are migrated.
const pageViewManagers = new Map();

function pageViewsFor(incognito) {
  const key = incognito ? 'incognito' : 'app';
  if (!pageViewManagers.has(key)) {
    pageViewManagers.set(key, createPageViewManager({
      partition: incognito ? INCOGNITO_PARTITION : APP_PARTITION,
      preloadPath: path.join(__dirname, 'guest-preload.cjs'),
      onCreated: (contents) => attachPageFeatures(contents, { native: true }),
    }));
  }
  return pageViewManagers.get(key);
}

// Popovers are mirrored above the page by a transparent view. The renderer
// reports geometry; clicks in the page mean the user clicked away.
overlaySurface.wireIpc(ipcMain, BrowserWindow);

/** Finds the Luma window that hosts a page webContents, native view or guest. */
function windowForPageContents(contents) {
  if (!contents || contents.isDestroyed()) return null;
  for (const manager of pageViewManagers.values()) {
    const win = manager.hostWindowFor(contents.id);
    if (win && !win.isDestroyed()) return win;
  }
  const host = contents.hostWebContents;
  if (host && !host.isDestroyed()) return BrowserWindow.fromWebContents(host);
  return null;
}

ipcMain.on('page:pointerdown', (event) => {
  const win = windowForPageContents(event.sender);
  if (win) overlaySurface.dismissForPageClick(win);
});

/** Only safe http(s) and local file pages may be shown inside a page view. */
function sanitizePageUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  return isSafeHttpUrl(raw) || isFileUrl(raw) ? raw : null;
}

/** True for a native WebContentsView that this app created for a tab. */
function isNativePageContents(contents) {
  if (!contents || contents.isDestroyed()) return false;
  for (const manager of pageViewManagers.values()) {
    if (manager.tabIdFor(contents.id)) return true;
  }
  return false;
}

/** Both page backends: <webview> guests and native page views. */
function isPageContents(contents) {
  if (!contents || contents.isDestroyed()) return false;
  return contents.getType() === 'webview' || isNativePageContents(contents);
}

/** Resolves the window webContents that owns a page, for <webview> and native views alike. */
function hostContentsOf(contents) {
  if (!contents || contents.isDestroyed()) return null;
  const direct = contents.hostWebContents;
  if (direct && !direct.isDestroyed()) return direct;
  for (const manager of pageViewManagers.values()) {
    const win = manager.hostWindowFor(contents.id);
    if (win && !win.isDestroyed()) return win.webContents;
  }
  return null;
}

/**
 * Finds the Luma window whose tab bar contains a screen point. The tab bar is
 * measured from the content area, because a frameless window's outer bounds
 * can include an invisible border that would shift the hit area.
 */
function appTabBarAtPoint(point, exclude, incognito, alsoExclude = null) {
  if (!point) return null;
  // Callers pass both renderer points ({ screenX, screenY }) and OS cursor
  // points ({ x, y }); reading only one shape hit every window at once.
  const x = Number(point.screenX ?? point.x);
  const y = Number(point.screenY ?? point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const matches = [];
  for (const [win, meta] of appWindows) {
    if (win.isDestroyed() || win === exclude || win === alsoExclude) continue;
    if (Boolean(meta.incognito) !== Boolean(incognito)) continue;
    const bounds = win.getContentBounds();
    if (x < bounds.x || x > bounds.x + bounds.width) continue;
    // Only the tab bar counts as a merge target; the page area creates a window.
    if (y < bounds.y || y > bounds.y + TAB_BAR_HEIGHT) continue;
    matches.push(win);
  }
  if (matches.length === 0) return null;
  return matches.find((win) => win.isFocused() && !win.isMinimized())
    || matches.find((win) => !win.isMinimized())
    || matches[matches.length - 1];
}
/** @type {Electron.Session | null} */
let browserSession = null;
/** @type {Electron.Session | null} */
let incognitoSession = null;
/** @type {BrowserWindow | null} */
let downloadsWindow = null;
/** @type {NodeJS.Timeout | null} */
let saveBoundsTimer = null;
/** @type {Map<string, { record: any; item: Electron.DownloadItem }>} */
const downloads = new Map();
let downloadCounter = 0;

/** @type {Map<number, { view: Electron.WebContentsView; window: Electron.BrowserWindow }>} */
const devtoolsViews = new Map();
/** @type {Map<number, { window: Electron.BrowserWindow; targetId: number }>} */
const devtoolsHostContents = new Map();

const PERMISSION_CATEGORIES = ['camera', 'microphone', 'notifications', 'geolocation', 'clipboard', 'fullscreen', 'pointerLock'];
const PERMISSION_POLICIES = ['ask', 'allow', 'deny'];
const DEFAULT_PERMISSION_RULES = {
  camera: 'ask',
  microphone: 'ask',
  notifications: 'ask',
  geolocation: 'ask',
  clipboard: 'ask',
  fullscreen: 'allow',
  pointerLock: 'ask',
};
/** @type {{ defaults: Record<string, string>; sites: Record<string, Record<string, string>> } | null} */
let permissionState = null;
let permissionRequestCounter = 0;
/** @type {Map<number, { callback: (allowed: boolean) => void; origin: string; categories: string[]; contentsId: number; timer: NodeJS.Timeout }>} */
const pendingPermissionRequests = new Map();

/** @type {typeof DEFAULT_APP_SETTINGS} */
let appSettings = { ...DEFAULT_APP_SETTINGS, adblock: { ...DEFAULT_APP_SETTINGS.adblock } };
/** @type {Map<number, number>} blocked request count per guest webContents */
const blockedCounts = new Map();
/** @type {Map<number, NodeJS.Timeout>} */
const blockedBroadcastTimers = new Map();
/** @type {NodeJS.Timeout | null} */
let persistDownloadsTimer = null;
/** @type {NodeJS.Timeout | null} */
let broadcastDownloadsTimer = null;
/**
 * Keeps Windows from suspending the machine while bytes are still moving.
 * Started with the first active transfer and stopped with the last one.
 * @type {number | null}
 */
let downloadPowerBlockerId = null;
/** Contents currently in an HTML (video / presentation) fullscreen. */
const htmlFullscreenContents = new Set();
/** Last payload written to disk, so progress ticks do not rewrite the file. */
let lastPersistedDownloads = '';
/** @type {Map<string, any>} */
const pendingInitialTabs = new Map();
/** URLs handed to the app by the OS before the renderer could open them. */
const queuedLaunchUrls = [];
/** @type {import('./adblock.cjs').AdblockManager | null} */
let adblockManager = null;
/** @type {Map<number, string>} inserted cosmetic CSS key per guest */
const cosmeticCssKeys = new Map();
/** @type {NodeJS.Timeout | null} */
let adblockUpdateTimer = null;
let lastRendererCrashAt = 0;
/** @type {ReturnType<typeof createUpdater> | null} */
let updateManager = null;
let startupUpdateTimer = null;
let updateCheckTimer = null;
let memoryPressureTimer = null;
let lastMemoryPressureAt = 0;
/** @type {ReturnType<typeof createExtensionManager> | null} */
let extensionManager = null;
/** @type {ReturnType<typeof createUserscriptManager> | null} */
let userscriptManager = null;
/** Extensions follow the profile: an isolated --user-data-dir gets its own set. */
let extensionsDirectory = null;
/** Floating host window for `chrome.action.default_popup`. */
let extensionPopupWindow = null;
let extensionPopupOwner = null;
/** The single window hosting an extension's own dashboard/options page. */
let extensionPageWindow = null;

function isFileUrl(url) {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isAllowedContentUrl(url) {
  // Guests may only load http(s), local files, or the blank start page.
  return isSafeHttpUrl(url) || isFileUrl(url) || url === 'about:blank' || url.startsWith('devtools://');
}

function appSettingsPath() {
  return path.join(app.getPath('userData'), 'luma-settings.json');
}

function loadAppSettings() {
  appSettings = loadSettings(appSettingsPath(), DEFAULT_APP_SETTINGS, Object.keys(DEFAULT_SHORTCUTS));
  return appSettings;
}

const saveAppSettings = createSettingsWriter(appSettingsPath, () => appSettings);

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  writeWindowState(windowStatePath(), mainWindow.getNormalBounds(), mainWindow.isMaximized());
}

function scheduleSaveWindowState() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveWindowState, 250);
}

function adblockOverview() {
  const engine = adblockManager?.status() ?? {
    engine: 'builtin',
    ruleCount: legacyAdblockRuleCount,
    lastUpdated: null,
    updating: false,
    error: null,
    sources: [],
  };
  return {
    enabled: appSettings.adblock.enabled,
    disabledSites: [...appSettings.adblock.disabledSites],
    blockedTotal: appSettings.blockedTotal,
    ...engine,
  };
}

function requestSiteUrl(details) {
  const contents = Number.isInteger(details.webContentsId) ? webContents.fromId(details.webContentsId) : null;
  const topUrl = contents && !contents.isDestroyed() ? contents.getURL() : '';
  if (topUrl && isSafeHttpUrl(topUrl)) return topUrl;
  return details.referrer || '';
}

function requestSiteHost(details) {
  return hostnameOf(requestSiteUrl(details)) || null;
}

function applyCosmeticFilters(contents) {
  if (contents.isDestroyed()) return;
  // Always drop the previous document's rules first. Otherwise a disabled site
  // or a page without matching rules would keep hiding elements from the last
  // page loaded in this guest.
  const previous = cosmeticCssKeys.get(contents.id);
  if (previous) {
    cosmeticCssKeys.delete(contents.id);
    contents.removeInsertedCSS(previous).catch(() => undefined);
  }
  if (!adblockManager || !appSettings.adblock.enabled) return;
  const url = contents.getURL();
  if (!isSafeHttpUrl(url)) return;
  const siteHost = hostnameOf(url);
  if (!siteHost || sitesIncludeHost(appSettings.adblock.disabledSites, siteHost)) return;
  // Site patches go last so their higher specificity beats the rule lists.
  // Some hosts opt out of the lists entirely: there the cosmetics only ever
  // mangle the layout (see COSMETIC_EXEMPT in site-fixes.cjs).
  const listStyles = skipsRuleListCosmetics(url) ? '' : adblockManager.cosmetics(url)?.styles;
  const css = [listStyles, siteStylesFor(url)].filter(Boolean).join('\n');
  if (!css) return;
  contents.insertCSS(css)
    .then((key) => {
      if (contents.isDestroyed()) return;
      cosmeticCssKeys.set(contents.id, key);
    })
    .catch((error) => {
      // A stylesheet Chromium refuses to parse must not take the page down,
      // but swallowing the reason made a silent no-op impossible to spot.
      console.error('[cosmetic] insert failed:', error && error.message ? error.message : error);
    });
}

function applyCosmeticFiltersToAll() {
  // Native WebContentsView pages report a type other than 'webview', so visit
  // every contents and let applyCosmeticFilters skip non-http documents.
  for (const contents of webContents.getAllWebContents()) applyCosmeticFilters(contents);
}

/**
 * Applies a per-site ad-block change to the pages that are already open, so the
 * switch takes effect on the spot instead of waiting for a reload. Turning
 * blocking off also drops the badge counter: a stale "已拦截 99+" is exactly
 * what makes the site look like it is still being blocked.
 */
function refreshAdblockForHost(host) {
  const trimmed = String(host || '').toLowerCase();
  if (!trimmed) return;
  const disabled = sitesIncludeHost(appSettings.adblock.disabledSites, trimmed);
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const url = contents.getURL();
    // The page host carries its `www.` (and may be a subdomain of the site the
    // switch was flipped on), so this has to be a site match, not equality.
    if (!url || !hostMatchesSite(hostnameOf(url), trimmed)) continue;
    if (disabled) {
      const key = cosmeticCssKeys.get(contents.id);
      cosmeticCssKeys.delete(contents.id);
      if (key) contents.removeInsertedCSS(key).catch(() => undefined);
      blockedCounts.set(contents.id, 0);
      hostContentsOf(contents)?.send('adblock:blocked', {
        webContentsId: contents.id,
        host: trimmed,
        count: 0,
      });
    } else {
      applyCosmeticFilters(contents);
    }
  }
}

function clearAllCosmeticFilters() {
  for (const [contentsId, key] of cosmeticCssKeys) {
    const contents = webContents.fromId(contentsId);
    if (contents && !contents.isDestroyed()) contents.removeInsertedCSS(key).catch(() => undefined);
  }
  cosmeticCssKeys.clear();
}

function noteBlockedRequest(details, siteHost) {
  const id = details.webContentsId;
  appSettings.blockedTotal += 1;
  saveAppSettings();
  // Requests from service workers or other non-guest contexts have no id;
  // broadcasting to them would call webContents.fromId(undefined) and crash.
  if (!Number.isInteger(id)) return;
  const count = (blockedCounts.get(id) || 0) + 1;
  blockedCounts.set(id, count);
  if (blockedBroadcastTimers.has(id)) return;
  blockedBroadcastTimers.set(id, setTimeout(() => {
    blockedBroadcastTimers.delete(id);
    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) return;
    hostContentsOf(contents)?.send('adblock:blocked', {
      webContentsId: id,
      host: siteHost,
      count: blockedCounts.get(id) || 0,
    });
  }, 400));
}

function attachAdBlocking(targetSession) {
  targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      if (!appSettings.adblock.enabled) return callback({ cancel: false });
      if (details.resourceType === 'mainFrame') return callback({ cancel: false });
      const siteHost = requestSiteHost(details);
      if (!siteHost || sitesIncludeHost(appSettings.adblock.disabledSites, siteHost)) return callback({ cancel: false });
      const siteUrl = requestSiteUrl(details);
      const result = adblockManager
        ? adblockManager.match({
            url: details.url,
            sourceUrl: siteUrl,
            type: details.resourceType,
            siteHost,
          })
        : { block: shouldBlock(details.url, siteHost, details.resourceType), redirect: null };
      if (!result.block) return callback({ cancel: false });
      noteBlockedRequest(details, siteHost);
      return result.redirect
        ? callback({ redirectURL: result.redirect })
        : callback({ cancel: true });
    } catch {
      return callback({ cancel: false });
    }
  });
}

function safeOrigin(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function permissionsPath() {
  return path.join(app.getPath('userData'), 'permissions.json');
}

function normalizePermissionPolicy(value) {
  return PERMISSION_POLICIES.includes(value) ? value : null;
}

function loadPermissionState() {
  if (permissionState) return permissionState;
  const state = { defaults: { ...DEFAULT_PERMISSION_RULES }, sites: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.defaults && typeof parsed.defaults === 'object') {
        for (const category of PERMISSION_CATEGORIES) {
          const policy = normalizePermissionPolicy(parsed.defaults[category]);
          if (policy) state.defaults[category] = policy;
        }
      }
      if (parsed.sites && typeof parsed.sites === 'object') {
        for (const [origin, rules] of Object.entries(parsed.sites)) {
          if (!safeOrigin(origin) || !rules || typeof rules !== 'object') continue;
          const normalized = {};
          for (const category of PERMISSION_CATEGORIES) {
            const policy = normalizePermissionPolicy(rules[category]);
            if (policy) normalized[category] = policy;
          }
          if (Object.keys(normalized).length > 0) state.sites[origin] = normalized;
        }
      }
    }
  } catch {
    // First run or an unreadable file: fall back to the secure defaults.
  }
  permissionState = state;
  return state;
}

function savePermissionState() {
  if (!permissionState) return;
  try {
    fs.writeFileSync(permissionsPath(), JSON.stringify(permissionState, null, 2), 'utf8');
  } catch {
    // A read-only profile must not break permission handling.
  }
}

function permissionOverview() {
  const state = loadPermissionState();
  return {
    defaults: { ...state.defaults },
    sites: Object.entries(state.sites)
      .map(([origin, permissions]) => ({ origin, permissions: { ...permissions } }))
      .sort((left, right) => left.origin.localeCompare(right.origin)),
  };
}

function sitePermissionPolicy(origin, category) {
  const state = loadPermissionState();
  return state.sites[origin]?.[category] ?? state.defaults[category] ?? 'deny';
}

function permissionCategories(permission, details) {
  switch (permission) {
    case 'media': {
      const types = Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0
        ? details.mediaTypes
        : details?.mediaType
          ? [details.mediaType]
          : ['audio', 'video'];
      const categories = [];
      if (types.includes('video')) categories.push('camera');
      if (types.includes('audio')) categories.push('microphone');
      return categories;
    }
    case 'notifications':
      return ['notifications'];
    case 'geolocation':
      return ['geolocation'];
    case 'clipboard-read':
      return ['clipboard'];
    case 'fullscreen':
      return ['fullscreen'];
    case 'pointerLock':
      return ['pointerLock'];
    default:
      return null;
  }
}

function requestPermissionFromUser(contents, origin, categories, callback) {
  const host = hostContentsOf(contents);
  if (!host || host.isDestroyed()) {
    callback(false);
    return;
  }
  if (pendingPermissionRequests.size >= 8) {
    callback(false);
    return;
  }
  const requestId = ++permissionRequestCounter;
  const timer = setTimeout(() => {
    const pending = pendingPermissionRequests.get(requestId);
    if (!pending) return;
    pendingPermissionRequests.delete(requestId);
    pending.callback(false);
  }, 45_000);
  pendingPermissionRequests.set(requestId, { callback, origin, categories, contentsId: contents.id, timer });
  host.send('permissions:request', {
    id: requestId,
    origin,
    host: new URL(origin).host,
    categories,
    title: contents.getTitle(),
  });
}

function handlePermissionRequest(contents, permission, callback, details) {
  if (permission === 'clipboard-sanitized-write' || permission === 'openExternal') {
    callback(true);
    return;
  }
  const origin = safeOrigin(details?.requestingUrl || contents.getURL());
  const categories = permissionCategories(permission, details);
  if (!origin || !categories || categories.length === 0) {
    callback(false);
    return;
  }
  if (contents.session === incognitoSession) {
    // Incognito sessions never persist decisions; sensitive requests stay denied.
    callback(false);
    return;
  }
  const policies = categories.map((category) => sitePermissionPolicy(origin, category));
  if (policies.includes('deny')) {
    callback(false);
    return;
  }
  const pending = categories.filter((_, index) => policies[index] === 'ask');
  if (pending.length === 0) {
    callback(true);
    return;
  }
  requestPermissionFromUser(contents, origin, pending, callback);
}

function handlePermissionCheck(contents, permission, requestingOrigin, details) {
  if (permission === 'clipboard-sanitized-write' || permission === 'openExternal') return true;
  const origin = safeOrigin(requestingOrigin || contents.getURL());
  const categories = permissionCategories(permission, details);
  if (!origin || !categories || categories.length === 0) return false;
  return categories.every((category) => sitePermissionPolicy(origin, category) === 'allow');
}

function normalizeDevtoolsBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = Math.round(Number(bounds.x));
  const y = Math.round(Number(bounds.y));
  const width = Math.round(Number(bounds.width));
  const height = Math.round(Number(bounds.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 60 || height < 60) return null;
  return { x, y, width, height };
}

function destroyDevtoolsView(targetId) {
  const entry = devtoolsViews.get(targetId);
  if (!entry) return;
  devtoolsViews.delete(targetId);
  devtoolsHostContents.delete(entry.view.webContents.id);
  const target = webContents.fromId(targetId);
  if (target && !target.isDestroyed() && target.isDevToolsOpened()) {
    try {
      target.closeDevTools();
    } catch {
      // The guest may already be tearing down.
    }
  }
  try {
    entry.window.contentView.removeChildView(entry.view);
  } catch {
    // The window may already be gone.
  }
  try {
    entry.view.webContents.close();
  } catch {
    // Already destroyed.
  }
}

function createWindow({
  incognito = false,
  initialTab = null,
  initialTabs = null,
  initialActiveId = null,
  placement = null,
  bounds = null,
  deferShow = false,
} = {}) {
  const tabs = Array.isArray(initialTabs) && initialTabs.length > 0
    ? initialTabs
    : (initialTab ? [initialTab] : []);
  const isSecondaryWindow = tabs.length > 0;
  const savedState = incognito || isSecondaryWindow ? null : readWindowState(windowStatePath());
  const savedBounds = incognito || isSecondaryWindow ? null : normalizeWindowBounds(savedState?.bounds, DEFAULT_WINDOW_BOUNDS);
  const windowArguments = [];
  if (incognito) windowArguments.push('--luma-incognito');
  let windowInitialKey = null;
  if (isSecondaryWindow) {
    windowInitialKey = crypto.randomUUID();
    pendingInitialTabs.set(windowInitialKey, {
      tabs,
      activeId: tabs.some((tab) => tab.id === initialActiveId) ? initialActiveId : tabs[0].id,
    });
    // A preload may run twice (initial empty document, then the real page), so
    // the payload is reused instead of deleted on first read.
    setTimeout(() => pendingInitialTabs.delete(windowInitialKey), 120_000);
    windowArguments.push('--luma-window=tearoff');
    windowArguments.push(`--luma-window-key=${windowInitialKey}`);
  }
  let tearOffBounds = null;
  if (isSecondaryWindow) {
    const explicit = normalizeExternalBounds(bounds);
    if (explicit) {
      tearOffBounds = explicit;
    } else {
      const source = placement && Number.isFinite(placement.screenX) && Number.isFinite(placement.screenY)
        ? placement
        : screen.getCursorScreenPoint();
      const anchor = {
        x: Math.round(source.x ?? source.screenX),
        y: Math.round(source.y ?? source.screenY),
      };
      // The new window's top-left corner is exactly where the tab was released.
      // It may extend beyond the display on purpose, so no clamping happens here.
      tearOffBounds = {
        width: 1220,
        height: 860,
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
      };
    }
  }
  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_BOUNDS,
    ...(savedBounds ?? {}),
    ...(tearOffBounds ?? {}),
    width: tearOffBounds?.width ?? (isSecondaryWindow ? 1220 : (savedBounds?.width ?? DEFAULT_WINDOW_BOUNDS.width)),
    height: tearOffBounds?.height ?? (isSecondaryWindow ? 860 : (savedBounds?.height ?? DEFAULT_WINDOW_BOUNDS.height)),
    show: false,
    frame: false,
    backgroundColor: '#eeeef3',
    title: incognito
      ? 'Luma Browser · 无痕模式'
      : isSecondaryWindow
        ? `${(tabs.find((tab) => tab.id === initialActiveId) ?? tabs[0])?.title || 'Luma'} · Luma`
        : 'Luma Browser',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true,
      additionalArguments: windowArguments,
    },
  });

  if (!incognito && !isSecondaryWindow) mainWindow = win;
  appWindows.set(win, { incognito });
  win.on('closed', () => {
    appWindows.delete(win);
    for (const session of [...tabDragSessions.values()]) {
      if (session.sourceId !== win.id) continue;
      stopTabDragSession(session);
      if (!session.follower.isDestroyed()) session.follower.close();
    }
    if (windowInitialKey) pendingInitialTabs.delete(windowInitialKey);
    for (const manager of pageViewManagers.values()) manager.destroyHosted(win);
  });
  win.setMenuBarVisibility(false);

  /**
   * Fullscreen is a page mode, not a window mode: the renderer hides the tab
   * strip and the toolbar so the web page itself fills the screen. It has to
   * know when the window really changed, which only these events report — the
   * IPC call returns before Windows finishes the transition. The window also
   * re-reports the settled state shortly after, because a toggle during the
   * transition can swallow the event and leave the chrome hidden for good.
   */
  const fullscreenTimers = [];
  /**
   * `isFullScreen()` can lag behind the geometry on Windows: after leaving
   * fullscreen the flag sometimes stays true for a moment (or, with a
   * frameless window, for good), which left the toolbar hidden over a normal
   * window. Fullscreen only counts when the window really covers its display.
   */
  const isWindowFullscreen = () => {
    if (win.isDestroyed() || !win.isFullScreen()) return false;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds).bounds;
    return bounds.width >= display.width - 2 && bounds.height >= display.height - 2;
  };
  const reportFullscreen = () => {
    if (win.isDestroyed()) return;
    win.webContents.send('window:fullscreen', isWindowFullscreen());
  };
  const syncFullscreen = () => {
    reportFullscreen();
    for (const timer of fullscreenTimers) clearTimeout(timer);
    fullscreenTimers.length = 0;
    fullscreenTimers.push(setTimeout(reportFullscreen, 320), setTimeout(reportFullscreen, 1100));
  };
  win.on('enter-full-screen', syncFullscreen);
  win.on('leave-full-screen', syncFullscreen);
  let resizeReportTimer = null;
  win.on('resize', () => {
    // Geometry settles after the event; one debounced report catches a window
    // that came back to its normal size while the renderer still hides the
    // chrome, even if both fullscreen transitions were missed.
    if (resizeReportTimer) clearTimeout(resizeReportTimer);
    resizeReportTimer = setTimeout(() => {
      resizeReportTimer = null;
      if (!win.isDestroyed() && !isWindowFullscreen()) reportFullscreen();
    }, 160);
  });
  win.on('closed', () => {
    for (const timer of fullscreenTimers) clearTimeout(timer);
    fullscreenTimers.length = 0;
    if (resizeReportTimer) clearTimeout(resizeReportTimer);
  });

  // Web pages may only use http(s) or local files. System pages are never exposed to guests.
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAllowedContentUrl(params.src)) {
      event.preventDefault();
      return;
    }
    // The page may not choose its own preload. Luma injects a minimal, sandboxed
    // preload that lives in the isolated world for password capture/autofill.
    webPreferences.preload = path.join(__dirname, 'guest-preload.cjs');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    params.partition = incognito ? INCOGNITO_PARTITION : APP_PARTITION;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    if (now - lastRendererCrashAt < 15_000) {
      dialog.showErrorBox('Luma 界面进程反复崩溃', '请关闭并重新启动 Luma Browser。已保存的标签页和书签不会丢失。');
      return;
    }
    lastRendererCrashAt = now;
    win.webContents.reload();
  });
  win.on('unresponsive', () => {
    win.webContents.send('browser:unresponsive', { webContentsId: win.webContents.id, scope: 'window' });
  });

  win.on('maximize', () => win.webContents.send('window:maximized', true));
  win.on('unmaximize', () => win.webContents.send('window:maximized', false));
  if (!incognito && !isSecondaryWindow) {
    win.on('resize', scheduleSaveWindowState);
    win.on('move', scheduleSaveWindowState);
    win.on('maximize', scheduleSaveWindowState);
    win.on('unmaximize', scheduleSaveWindowState);
    win.on('close', saveWindowState);
  }
  win.once('ready-to-show', () => {
    // Restore the maximized state before the first paint to avoid a resize flash.
    if (!incognito && !isSecondaryWindow && savedState?.maximized) win.maximize();
    // A drag hands the window over itself once the chrome is painted.
    if (!deferShow) win.show();
  });

  win.on('closed', () => {
    for (const [targetId, entry] of [...devtoolsViews]) {
      if (entry.window === win) destroyDevtoolsView(targetId);
    }
    if (mainWindow === win) {
      mainWindow = null;
      // A lone download manager must not keep the process alive: it has no way
      // back to the tabs, and relaunches used to focus it instead of opening
      // the browser. Active transfers keep the app running so they finish.
      if (downloadsWindow && !downloadsWindow.isDestroyed() && activeDownloadCount() === 0) {
        downloadsWindow.close();
      }
    }
  });

  if (isDevelopment) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  return win;
}

function downloadSnapshot() {
  return [...downloads.values()]
    .map((entry) => entry.record)
    .sort((left, right) => right.startedAt - left.startedAt);
}

function activeDownloadCount() {
  let count = 0;
  for (const entry of downloads.values()) {
    if (entry.record.state === 'progressing' && !entry.record.paused) count += 1;
  }
  return count;
}

/**
 * A long download used to stop the moment the machine idled into sleep, and the
 * transfer then resumed from a stale offset. `prevent-app-suspension` keeps the
 * system awake while still letting the display turn off, which is what a
 * background download needs.
 */
function syncDownloadPowerBlocker() {
  const active = activeDownloadCount() > 0;
  const started = downloadPowerBlockerId !== null && powerSaveBlocker.isStarted(downloadPowerBlockerId);
  if (active && !started) {
    downloadPowerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!active && downloadPowerBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(downloadPowerBlockerId)) powerSaveBlocker.stop(downloadPowerBlockerId);
    } catch {
      // The blocker may already be gone after a crash.
    }
    downloadPowerBlockerId = null;
  }
}

function broadcastDownloads() {
  if (broadcastDownloadsTimer) {
    clearTimeout(broadcastDownloadsTimer);
    broadcastDownloadsTimer = null;
  }
  const snapshot = downloadSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('downloads:changed', snapshot);
  }
  syncDownloadPowerBlocker();
}

/**
 * Coalesces bursts (several downloads finishing together, or a progress tick
 * per chunk) into one IPC message per frame or so.
 */
function scheduleBroadcastDownloads() {
  if (broadcastDownloadsTimer) return;
  broadcastDownloadsTimer = setTimeout(() => {
    broadcastDownloadsTimer = null;
    broadcastDownloads();
  }, 120);
}

function uniqueDownloadPath(directory, filename) {
  const safeName = path.basename(String(filename || 'download')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'download';
  const extension = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - extension.length) || 'download';
  let candidate = path.join(directory, safeName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

function defaultDownloadDirectory() {
  // Downloads land next to the application folder (one level up), which keeps
  // them beside the portable build instead of buried in the install directory.
  if (!app.isPackaged) return app.getPath('downloads');
  const exeDir = path.dirname(app.getPath('exe'));
  const parent = path.dirname(exeDir);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    return parent;
  } catch {
    // A read-only install location (e.g. Program Files) falls back to Downloads.
    return app.getPath('downloads');
  }
}

function downloadSettingsPath() {
  return path.join(app.getPath('userData'), 'download-settings.json');
}

function downloadDirectoryInfo() {
  try {
    const parsed = JSON.parse(fs.readFileSync(downloadSettingsPath(), 'utf8'));
    if (parsed && typeof parsed.directory === 'string' && path.isAbsolute(parsed.directory)) {
      return { directory: path.normalize(parsed.directory), isDefault: false };
    }
  } catch {
    // No saved preference yet.
  }
  return { directory: defaultDownloadDirectory(), isDefault: true };
}

function writeDownloadDirectory(directory) {
  try {
    if (directory) {
      fs.writeFileSync(downloadSettingsPath(), JSON.stringify({ directory }), 'utf8');
    } else {
      fs.rmSync(downloadSettingsPath(), { force: true });
    }
  } catch {
    // A read-only profile keeps using the previous location.
  }
}

function downloadsStorePath() {
  return path.join(app.getPath('userData'), 'downloads.json');
}

function persistDownloadsNow() {
  if (persistDownloadsTimer) {
    clearTimeout(persistDownloadsTimer);
    persistDownloadsTimer = null;
  }
  const records = [...downloads.values()]
    .map((entry) => entry.record)
    .filter((record) => !record.incognito)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 120)
    // Live rates and byte offsets are rebuilt on the next tick, so they do not
    // belong in the store: persisting them would rewrite the file constantly.
    .map(({ speed, etaSeconds, updatedAt, ...rest }) => rest);
  let payload;
  try {
    payload = JSON.stringify(records);
  } catch {
    return;
  }
  // Progress-only updates would otherwise rewrite the same file every second.
  if (payload === lastPersistedDownloads) return;
  lastPersistedDownloads = payload;
  try {
    fs.writeFileSync(downloadsStorePath(), payload, 'utf8');
  } catch {
    // A read-only profile keeps the list in memory.
  }
}

function schedulePersistDownloads() {
  if (persistDownloadsTimer) clearTimeout(persistDownloadsTimer);
  persistDownloadsTimer = setTimeout(persistDownloadsNow, 500);
}

function loadPersistedDownloads() {
  let records = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(downloadsStorePath(), 'utf8'));
    if (Array.isArray(parsed)) records = parsed;
  } catch {
    return;
  }
  for (const record of records.slice(0, 120)) {
    if (!record || typeof record.id !== 'string' || typeof record.url !== 'string') continue;
    if (downloads.has(record.id)) continue;
    const state = record.state === 'completed'
      ? 'completed'
      : record.state === 'cancelled'
        ? 'cancelled'
        : 'interrupted';
    downloads.set(record.id, {
      record: {
        ...record,
        state,
        speed: 0,
        paused: false,
        resumable: state !== 'completed' && typeof record.savePath === 'string' && path.isAbsolute(record.savePath),
      },
    });
  }
}

function closeCustomStream(entry) {
  if (!entry.stream) return;
  try {
    entry.stream.end();
  } catch {
    // The stream may already be closed.
  }
  entry.stream = null;
}

function settleCustomDownload(entry, state) {
  const record = entry.record;
  entry.request = null;
  closeCustomStream(entry);
  entry.record = {
    ...record,
    state,
    speed: 0,
    paused: false,
    resumable: state !== 'completed' && Boolean(record.savePath),
  };
  broadcastDownloads();
  schedulePersistDownloads();
}

/**
 * Resumes an interrupted download with a Range request, appending to the
 * partial file on disk. Falls back to a full download when the server does not
 * honour range requests.
 */
function startResumableDownload(entry) {
  const record = entry.record;
  if (!record.savePath || !path.isAbsolute(record.savePath)) return false;
  if (!isSafeHttpUrl(record.url)) return false;
  let fileSize = 0;
  try {
    if (fs.existsSync(record.savePath)) fileSize = fs.statSync(record.savePath).size;
  } catch {
    fileSize = 0;
  }
  // The bytes on disk decide where a resume may start. Chromium preallocates
  // the destination, so the file can be larger than what actually arrived;
  // and a cancelled download removes the partial file entirely, in which case
  // the recorded offset points past the end of nothing.
  const plan = planResume({
    recordedBytes: record.receivedBytes,
    fileSize,
    totalBytes: record.totalBytes,
  });
  // `start` is adjusted again once the server answers (200 resets it to zero),
  // so it cannot be a constant.
  let start = plan.start;
  const complete = plan.complete;
  if (fileSize > start) {
    try {
      fs.truncateSync(record.savePath, start);
    } catch {
      // A locked file still resumes from the offset we can read.
    }
  }
  if (complete) {
    entry.record = { ...record, state: 'completed', paused: false, speed: 0, receivedBytes: start, resumable: false };
    broadcastDownloads();
    schedulePersistDownloads();
    return true;
  }
  try {
    fs.mkdirSync(path.dirname(record.savePath), { recursive: true });
  } catch {
    return false;
  }

  const targetSession = record.incognito ? incognitoSession : browserSession;
  const request = net.request({ url: record.url, method: 'GET', redirect: 'follow', session: targetSession });
  if (start > 0) request.setHeader('Range', `bytes=${start}-`);
  try {
    request.setHeader('User-Agent', targetSession.getUserAgent());
  } catch {
    // A custom UA is optional.
  }

  entry.custom = true;
  entry.request = request;
  entry.pausedRequested = false;
  entry.cancelled = false;
  entry.sample = { bytes: start, time: Date.now() };
  entry.average = 0;
  entry.lastBroadcast = 0;
  entry.record = {
    ...record,
    state: 'progressing',
    paused: false,
    speed: 0,
    etaSeconds: null,
    updatedAt: Date.now(),
    receivedBytes: start,
    resumable: true,
  };

  request.on('response', (response) => {
    if (entry.request !== request) return;
    const status = response.statusCode;
    let stream = null;
    if (status === 200) {
      // The server ignored the Range header; start the file over.
      start = 0;
      entry.record = { ...entry.record, receivedBytes: 0 };
      stream = fs.createWriteStream(record.savePath, { flags: 'w' });
    } else if (status === 206) {
      const range = String(response.headers['content-range'] || '');
      const match = /^bytes\s+(\d+)-/i.exec(range);
      const rangeStart = match ? Number(match[1]) : start;
      if (start > 0 && Number.isFinite(rangeStart) && rangeStart !== start) {
        // Resumed at a different offset than requested: appending there would
        // interleave two positions in one file, so restart cleanly.
        start = 0;
        entry.record = { ...entry.record, receivedBytes: 0 };
        stream = fs.createWriteStream(record.savePath, { flags: 'w' });
      } else {
        // Explicit offset instead of append: a preallocated (sparse) file can
        // be larger than the payload, and appending would write past the gap.
        stream = fs.createWriteStream(record.savePath, { flags: start > 0 ? 'r+' : 'w', start });
      }
    } else if (status === 416) {
      // "Range not satisfiable": the recorded offset no longer matches the
      // file (or the file is already complete). Retry once from zero.
      if (entry.request === request) entry.request = null;
      try {
        request.abort();
      } catch {
        // Already finished.
      }
      if (start > 0 && !entry.rangeFallback) {
        entry.rangeFallback = true;
        try {
          fs.truncateSync(record.savePath, 0);
        } catch {
          // A locked file is simply downloaded again over the top.
        }
        entry.record = { ...entry.record, receivedBytes: 0 };
        setTimeout(() => {
          if (downloads.get(record.id) === entry) startResumableDownload(entry);
        }, 0);
        return;
      }
      settleCustomDownload(entry, 'interrupted');
      return;
    } else {
      settleCustomDownload(entry, 'interrupted');
      try {
        request.abort();
      } catch {
        // Already finished.
      }
      return;
    }
    entry.stream = stream;
    stream.on('error', () => {
      if (entry.request === request) settleCustomDownload(entry, 'interrupted');
    });
    const length = Number(response.headers['content-length']);
    if (Number.isFinite(length) && length > 0) {
      entry.record = { ...entry.record, totalBytes: start + length };
    }

    response.on('data', (chunk) => {
      if (entry.request !== request) return;
      let writable = true;
      try {
        writable = stream.write(chunk);
      } catch {
        return;
      }
      const received = entry.record.receivedBytes + chunk.length;
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - entry.sample.time) / 1000);
      const instant = Math.max(0, (received - entry.sample.bytes) / elapsed);
      entry.average = entry.average > 0 ? entry.average * 0.62 + instant * 0.38 : instant;
      entry.sample = { bytes: received, time: now };
      const speed = Math.round(entry.average);
      const total = entry.record.totalBytes;
      entry.record = {
        ...entry.record,
        receivedBytes: received,
        speed,
        etaSeconds: speed > 0 && total > received ? Math.ceil((total - received) / speed) : null,
        updatedAt: now,
      };
      if (!writable && typeof response.pause === 'function') {
        response.pause();
        stream.once('drain', () => {
          try {
            response.resume();
          } catch {
            // The response may have ended while waiting for the disk.
          }
        });
      }
      // Throttle UI updates; a fast transfer would otherwise flood IPC.
      if (now - (entry.lastBroadcast || 0) > 250) {
        entry.lastBroadcast = now;
        scheduleBroadcastDownloads();
      }
    });
    response.on('end', () => {
      if (entry.request !== request) return;
      stream.end(() => {
        if (entry.request !== request) return;
        const total = entry.record.totalBytes;
        const received = entry.record.receivedBytes;
        // A proxy or a dropped mobile link can close the body early and still
        // fire 'end'. Calling that complete produced a truncated file that
        // looked finished and could not be resumed.
        const short = total > 0 && received < total;
        if (short) entry.record = { ...entry.record, totalBytes: total };
        settleCustomDownload(entry, short ? 'interrupted' : 'completed');
      });
    });
    response.on('aborted', () => {
      if (entry.request === request) settleCustomDownload(entry, 'interrupted');
    });
    response.on('error', () => {
      if (entry.request === request) settleCustomDownload(entry, 'interrupted');
    });
  });

  request.on('error', () => {
    if (entry.request !== request) return;
    settleCustomDownload(entry, entry.pausedRequested ? 'progressing' : 'interrupted');
    if (entry.pausedRequested) entry.record = { ...entry.record, paused: true };
  });
  request.on('abort', () => {
    if (entry.request !== request) return;
    settleCustomDownload(entry, entry.pausedRequested ? 'progressing' : 'interrupted');
    if (entry.pausedRequested) entry.record = { ...entry.record, paused: true };
  });
  request.end();
  broadcastDownloads();
  return true;
}

function pauseCustomDownload(entry) {
  entry.pausedRequested = true;
  const request = entry.request;
  entry.request = null;
  closeCustomStream(entry);
  try {
    request?.abort();
  } catch {
    // Already closed.
  }
  entry.record = { ...entry.record, state: 'progressing', paused: true, speed: 0 };
  broadcastDownloads();
  schedulePersistDownloads();
}

function cancelCustomDownload(entry) {
  entry.cancelled = true;
  const request = entry.request;
  entry.request = null;
  closeCustomStream(entry);
  try {
    request?.abort();
  } catch {
    // Already closed.
  }
  entry.record = { ...entry.record, state: 'cancelled', paused: false, speed: 0 };
  broadcastDownloads();
  schedulePersistDownloads();
}

function attachDownloadHandling(targetSession, incognito) {
  targetSession.on('will-download', (_event, item) => {
    const filename = item.getFilename() || 'download';
    // Automation and managed deployments can pre-approve a folder; users otherwise pick a path.
    const autoSaveDirectory = process.env.LUMA_DOWNLOAD_DIR;
    if (autoSaveDirectory) {
      try {
        fs.mkdirSync(autoSaveDirectory, { recursive: true });
        if (!item.getSavePath()) item.setSavePath(uniqueDownloadPath(autoSaveDirectory, filename));
      } catch {
        // Fall back to the interactive save dialog.
      }
    }
    if (!item.getSavePath() && appSettings.downloadsAskWhere === false) {
      // "Don't ask" means save straight into the configured folder.
      const directory = downloadDirectoryInfo().directory;
      try {
        fs.mkdirSync(directory, { recursive: true });
        item.setSavePath(uniqueDownloadPath(directory, filename));
      } catch {
        // Fall back to the interactive dialog below.
      }
    }
    if (!item.getSavePath()) {
      const directory = downloadDirectoryInfo().directory;
      try {
        fs.mkdirSync(directory, { recursive: true });
      } catch {
        // The dialog still lets the user choose another existing folder.
      }
      try {
        item.setSaveDialogOptions({
          title: '保存文件',
          buttonLabel: '保存',
          defaultPath: uniqueDownloadPath(directory, filename),
        });
      } catch {
        // Electron's default save dialog remains available.
      }
    }
    const id = `download-${Date.now()}-${++downloadCounter}`;
    const startedAt = Date.now();
    const record = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      savePath: item.getSavePath() || '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      speed: 0,
      etaSeconds: null,
      updatedAt: startedAt,
      startedAt,
      incognito,
      paused: false,
      resumable: item.canResume(),
    };
    downloads.set(id, {
      record,
      item,
      sample: { bytes: 0, time: startedAt },
      // Transfer events arrive dozens of times per second on a fast link, so
      // the UI is fed at a fixed cadence instead of once per chunk.
      lastBroadcast: 0,
      lastPersist: startedAt,
      average: 0,
    });

    const update = () => {
      const entry = downloads.get(id);
      if (!entry) return;
      const state = item.getState();
      const receivedBytes = item.getReceivedBytes();
      const totalBytes = item.getTotalBytes();
      const paused = item.isPaused();
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - entry.sample.time) / 1000);
      const delta = receivedBytes - entry.sample.bytes;
      const instant = state === 'progressing' && !paused ? Math.max(0, delta / elapsed) : 0;
      // A single interval can be wildly off (one bursty chunk); an exponential
      // average gives a rate that neither jumps nor lags behind for a minute.
      if (instant > 0) {
        entry.average = entry.average > 0 ? entry.average * 0.62 + instant * 0.38 : instant;
      } else {
        entry.average = 0;
      }
      entry.sample = { bytes: receivedBytes, time: now };
      const speed = Math.round(entry.average);
      const remaining = totalBytes > receivedBytes ? totalBytes - receivedBytes : 0;
      entry.record = {
        ...entry.record,
        savePath: item.getSavePath() || entry.record.savePath,
        receivedBytes,
        totalBytes,
        speed,
        etaSeconds: speed > 0 && remaining > 0 ? Math.ceil(remaining / speed) : null,
        updatedAt: now,
        paused,
        resumable: item.canResume(),
        state: state === 'progressing' ? 'progressing' : state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
      };
      // State changes are worth reporting immediately; progress is throttled.
      const stateChanged = state !== 'progressing' || paused !== (entry.lastPaused ?? false);
      entry.lastPaused = paused;
      if (stateChanged || now - entry.lastBroadcast >= 300) {
        entry.lastBroadcast = now;
        if (stateChanged) broadcastDownloads();
        else scheduleBroadcastDownloads();
      }
      // Progress ticks only rewrite the store every few seconds; the finished
      // state is always flushed.
      if (stateChanged || now - entry.lastPersist >= 4000) {
        entry.lastPersist = now;
        schedulePersistDownloads();
      }
    };

    item.on('updated', update);
    item.once('done', update);
    broadcastDownloads();
    schedulePersistDownloads();

    // Keep the list compact; active downloads are always retained.
    const finished = [...downloads.values()].filter((entry) => entry.record.state !== 'progressing');
    if (finished.length > 100) {
      finished
        .sort((left, right) => left.record.startedAt - right.record.startedAt)
        .slice(0, finished.length - 100)
        .forEach((entry) => downloads.delete(entry.record.id));
    }
  });
}

function openDownloadsWindow() {
  if (downloadsWindow && !downloadsWindow.isDestroyed()) {
    downloadsWindow.show();
    downloadsWindow.focus();
    return downloadsWindow;
  }
  downloadsWindow = new BrowserWindow({
    width: 790,
    height: 630,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#eeeef3',
    title: '下载内容 · Luma',
    autoHideMenuBar: true,
    // The manager is its own window and used to appear as an empty white
    // frame while the bundle booted; show it once the first paint is ready.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  downloadsWindow.setMenuBarVisibility(false);
  downloadsWindow.once('ready-to-show', () => {
    if (downloadsWindow && !downloadsWindow.isDestroyed()) downloadsWindow.show();
  });
  downloadsWindow.on('closed', () => {
    downloadsWindow = null;
  });
  if (isDevelopment) {
    void downloadsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/?downloads=1`);
  } else {
    void downloadsWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { downloads: '1' } });
  }
  // A slow first paint must not leave the window invisible forever.
  const showTimer = setTimeout(() => {
    if (downloadsWindow && !downloadsWindow.isDestroyed() && !downloadsWindow.isVisible()) downloadsWindow.show();
  }, 1500);
  downloadsWindow.once('closed', () => clearTimeout(showTimer));
  return downloadsWindow;
}

/**
 * Runs every enabled userscript that matches the page's URL. The wrapper is
 * evaluated in the page's main world, which is where userscripts expect to be;
 * errors inside a script are caught by the wrapper itself.
 */
function injectUserscripts(contents) {
  const manager = userscriptManager;
  if (!manager || !manager.count || contents.isDestroyed()) return;
  // Incognito keeps no profile data, and a userscript that persists GM values
  // would write to the page's local storage there; skip it like extensions.
  if (incognitoSession && contents.session === incognitoSession) return;
  const url = contents.getURL();
  if (!url || !/^https?:/i.test(url)) return;
  for (const script of manager.injectionsFor(url)) {
    void contents.executeJavaScript(script.code, false).catch((error) => {
      console.error(`[userscripts] injection failed for ${script.id}:`, error);
    });
  }
}

/**
 * Applies per-site compatibility patches. These are not user scripts: they ship
 * with the browser, run once per document, and compensate for layout defects on
 * specific sites that would otherwise look like a bug in Luma.
 */
function injectSiteFixes(contents) {
  if (contents.isDestroyed()) return;
  const url = contents.getURL();
  if (!url) return;
  for (const fix of siteFixesFor(url)) {
    void contents.executeJavaScript(fix.script, false).catch((error) => {
      console.error(`[site-fix] ${fix.id} failed:`, error);
    });
  }
}

/** Paints the in-video "mini window" button; see main/pip-button.cjs. */
function injectPipButton(contents) {
  if (contents.isDestroyed()) return;
  const script = pipButtonScriptFor(contents.getURL());
  if (!script) return;
  void contents.executeJavaScript(script, false).catch((error) => {
    console.error('[pip-button] injection failed:', error);
  });
}

function attachPageFeatures(contents, { native = false } = {}) {
  if (!contents || contents.isDestroyed()) return;
  // A video or presentation can own the screen on its own. F11 has to release
  // that fullscreen first, otherwise the window leaves fullscreen while the
  // page keeps covering the desktop.
  contents.on('enter-html-full-screen', () => htmlFullscreenContents.add(contents.id));
  contents.on('leave-html-full-screen', () => htmlFullscreenContents.delete(contents.id));
  // A navigation replaces the document, and the browser drops its fullscreen
  // with it; clearing here keeps the F11 path from believing in a stale one.
  contents.on('did-navigate', () => htmlFullscreenContents.delete(contents.id));
  contents.once('destroyed', () => htmlFullscreenContents.delete(contents.id));
  if (!native) {
    contents.once('destroyed', () => {
      destroyDevtoolsView(contents.id);
      blockedCounts.delete(contents.id);
      cosmeticCssKeys.delete(contents.id);
      const timer = blockedBroadcastTimers.get(contents.id);
      if (timer) clearTimeout(timer);
      blockedBroadcastTimers.delete(contents.id);
      for (const [requestId, pending] of pendingPermissionRequests) {
        if (pending.contentsId !== contents.id) continue;
        clearTimeout(pending.timer);
        pendingPermissionRequests.delete(requestId);
        pending.callback(false);
      }
    });
  }


  // Native views install their own handler in pageViews.cjs.
  if (!native) {
    contents.setWindowOpenHandler(({ url }) => {      if (isSafeHttpUrl(url) || (isFileUrl(url) && isFileUrl(contents.getURL()))) {
        hostContentsOf(contents)?.send('browser:new-window', url);
      }
      return { action: 'deny' };
    });
  }

  contents.on('will-navigate', (event, url) => {
    const fromLocalFile = isFileUrl(contents.getURL());
    if (!isAllowedContentUrl(url) || (isFileUrl(url) && !fromLocalFile)) event.preventDefault();
  });

  contents.on('will-redirect', (event, url) => {
    const fromLocalFile = isFileUrl(contents.getURL());
    if (!isAllowedContentUrl(url) || (isFileUrl(url) && !fromLocalFile)) event.preventDefault();
  });

  // Cosmetic rules are applied after the document exists. The CSS is
  // inserted by the browser, so page scripts cannot remove or hook it.
  contents.on('dom-ready', () => {
    applyCosmeticFilters(contents);
    injectUserscripts(contents);
    injectSiteFixes(contents);
    injectPipButton(contents);
  });
  contents.on('render-process-gone', (_event, details) => {
    hostContentsOf(contents)?.send('browser:render-gone', {
      webContentsId: contents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  contents.on('unresponsive', () => {
    hostContentsOf(contents)?.send('browser:unresponsive', { webContentsId: contents.id });
  });

  // A new document starts with a clean blocked-request counter.
  contents.on('did-navigate', () => {
    blockedCounts.set(contents.id, 0);
    hostContentsOf(contents)?.send('adblock:blocked', {
      webContentsId: contents.id,
      host: hostnameOf(contents.getURL()),
      count: 0,
    });
  });

  // Render a custom browser context menu above the native WebView.
  contents.on('context-menu', (_event, params) => {
    // DevTools has its own menus; don't route them into the page menu.
    if (contents.getURL().startsWith('devtools://')) return;
    const hostContents = hostContentsOf(contents);
    const hostWindow = hostContents ? BrowserWindow.fromWebContents(hostContents) : null;
    const cursor = screen.getCursorScreenPoint();
    const contentBounds = hostWindow?.getContentBounds();
    hostContentsOf(contents)?.send('browser:page-context-menu', {
      webContentsId: contents.id,
      x: params.x,
      y: params.y,
      // Screen cursor coordinates are DIPs and stay exact even with display scaling.
      clientX: contentBounds ? cursor.x - contentBounds.x : null,
      clientY: contentBounds ? cursor.y - contentBounds.y : null,
      selectionText: (params.selectionText || '').slice(0, 500),
      linkURL: params.linkURL || '',
      srcURL: params.srcURL || '',
      mediaType: params.mediaType || 'none',
      isEditable: Boolean(params.isEditable),
      editFlags: {
        canCopy: Boolean(params.editFlags?.canCopy),
        canCut: Boolean(params.editFlags?.canCut),
        canPaste: Boolean(params.editFlags?.canPaste),
        canSelectAll: Boolean(params.editFlags?.canSelectAll),
      },
    });
  });

  // Keep browser-level shortcuts working while keyboard focus is inside the guest page.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    // DevTools keeps its own keyboard handling.
    if (contents.getURL().startsWith('devtools://')) return;
    const action = shortcutActionForInput(input, appSettings.shortcuts);
    if (!action) return;
    event.preventDefault();
    hostContentsOf(contents)?.send('browser:shortcut', action);
  });
}

/**
 * Free-memory watchdog. Renderers decide what to discard, because the tab list
 * and the user's "sleep background tabs" preference live there; the main process
 * only supplies the signal and the numbers.
 */
function sampleMemoryPressure() {
  let info = null;
  try {
    info = process.getSystemMemoryInfo();
  } catch {
    return;
  }
  const total = Number(info?.total) || 0;
  const available = Number(info?.available ?? info?.free) || 0;
  if (total <= 0) return;
  const ratio = available / total;
  if (ratio > MEMORY_PRESSURE_RATIO) return;
  const now = Date.now();
  if (now - lastMemoryPressureAt < MEMORY_PRESSURE_COOLDOWN_MS) return;
  lastMemoryPressureAt = now;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:memory-pressure', {
        available,
        total,
        ratio: Math.round(ratio * 1000) / 1000,
      });
    }
  }
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId('com.luma.browser');
  try {
    crashReporter.start({ uploadToServer: false, compress: true, productName: 'Luma Browser', companyName: 'Luma Browser' });
  } catch {
    // Crash reporting is best effort.
  }
  app.on('child-process-gone', (_event, details) => {
    console.error('[crash] child process gone:', details.type, details.reason, details.exitCode);
  });
  applyAppCspHeaders();
  loadAppSettings();
  registerBossKey(appSettings.bossKey);
  updateManager = createUpdater({
    currentVersion: app.getVersion(),
    onState: broadcastUpdateState,
    paths: appPaths,
  });
  if (!isDevelopment) {
    // Checking after the first paint keeps startup fast and offline-safe.
    // Browsers poll their update service in the background instead of checking
    // once at launch, so the same check repeats every four hours.
    const backgroundCheck = () => {
      const prefs = updateManager?.getState().prefs;
      void updateManager?.check({ autoDownload: prefs?.autoDownload !== false });
    };
    startupUpdateTimer = setTimeout(backgroundCheck, 8_000);
    updateCheckTimer = setInterval(backgroundCheck, UPDATE_CHECK_INTERVAL_MS);
  }
  adblockManager = new AdblockManager({
    userDataDir: app.getPath('userData'),
    fetchImpl: (url, init) => net.fetch(url, init),
    onUpdate: () => applyCosmeticFiltersToAll(),
  });
  browserSession = session.fromPartition(APP_PARTITION);
  incognitoSession = session.fromPartition(INCOGNITO_PARTITION);
  // A profile that silently lands in another directory looks exactly like
  // "every site forgot my login". Record where the cookie store really is, and
  // shout once when it is not the profile this build intends to use.
  try {
    const storagePath = typeof browserSession.getStoragePath === 'function'
      ? browserSession.getStoragePath()
      : '';
    if (storagePath) {
      const expected = path.resolve(app.getPath('userData')).toLowerCase();
      const actual = path.resolve(storagePath).toLowerCase();
      if (!actual.startsWith(expected)) {
        console.error('[paths] cookie store is outside the profile:', storagePath);
        appendAppLog(`[paths] storage mismatch: ${storagePath} (expected under ${expected})`);
      }
    }
  } catch {
    // A diagnostic must never keep the browser from starting.
  }
  for (const targetSession of [browserSession, incognitoSession]) {
    configureSession(targetSession, {
      // Luma asks before granting camera, microphone, geolocation or notifications.
      onPermissionRequest: handlePermissionRequest,
      onPermissionCheck: handlePermissionCheck,
      // Blocked requests never reach the download handler.
      onRequest: attachAdBlocking,
      onDownload: (target) => attachDownloadHandling(target, target === incognitoSession),
    });
  }
  // Unpacked extensions live under User Data-adjacent `Extensions`; Electron
  // requires loadExtension on every boot, so the manager re-loads them here and
  // reports failures in the settings list instead of failing silently.
  extensionsDirectory = appPaths.overridden
    ? path.join(app.getPath('userData'), 'Extensions')
    : appPaths.extensions;
  extensionManager = createExtensionManager({
    directory: extensionsDirectory,
    session: browserSession,
    log: (line) => console.log(line),
    onChange: (list) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('extensions:changed', list);
      }
    },
  });
  void extensionManager.loadAll().catch((error) => {
    console.error('[extensions] load failed:', error);
  });
  // Electron has no chrome.userScripts, so Tampermonkey's MV3 scripts never
  // run. Luma injects .user.js files itself; the manager only parses and
  // matches, injection happens per document in attachPageFeatures.
  userscriptManager = createUserscriptManager({
    directory: path.join(app.getPath('userData'), 'Userscripts'),
    log: (line) => console.log(line),
    onChange: (list) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('userscripts:changed', list);
      }
    },
  });
  userscriptManager.scan();
  loadPersistedDownloads();
  // Loading the cached engine is cheap; a stale/missing cache refreshes in the
  // background so the first window opens immediately.
  setTimeout(async () => {
    await adblockManager?.load();
    applyCosmeticFiltersToAll();
  }, 1200);
  adblockUpdateTimer = setInterval(() => {
    void adblockManager?.update(false);
  }, 6 * 60 * 60 * 1000);
  memoryPressureTimer = setInterval(sampleMemoryPressure, MEMORY_PRESSURE_INTERVAL_MS);

  /**
 * Wires the browser-level behaviour shared by <webview> guests and native page
 * views: navigation guards, ad-block bookkeeping, the custom context menu,
 * crash reporting and keyboard shortcuts. Native views are created inside
 * pageViews.cjs, so main calls this explicitly for them.
 */

app.on('web-contents-created', (_event, contents) => {
    // Window-level shortcuts work for the chrome and for focused guest pages.
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // Holding F11 repeats keydown dozens of times a second; each repeat used
      // to flip the window again, so a slightly long press ended half-way
      // between the two modes (chrome hidden but window not fullscreen, or the
      // reverse).
      if (input.isAutoRepeat) return;
      const devtoolsHost = devtoolsHostContents.get(contents.id);
      const manager = hostContentsOf(contents) ?? devtoolsHost?.window.webContents ?? contents;
      const hostWindow = BrowserWindow.fromWebContents(manager);
      if (input.key === 'F11') {
        event.preventDefault();
        // Release a page-owned fullscreen (video, slide deck) before touching
        // the window; otherwise the desktop stays covered by the page after
        // F11 "exited fullscreen".
        const owned = htmlFullscreenContents.has(contents.id)
          ? contents
          : [...htmlFullscreenContents]
            .map((id) => webContents.fromId(id))
            .find((item) => item && !item.isDestroyed() && hostContentsOf(item) === manager);
        if (owned) {
          // Ask the page rather than trusting the cached flag: a fullscreen
          // that ended without its event (navigation, a player closing itself)
          // would otherwise make F11 a no-op forever, leaving the user stuck
          // in window fullscreen with no toolbar.
          void owned
            .executeJavaScript('Boolean(document.fullscreenElement)', true)
            .then((isPageFullscreen) => {
              if (isPageFullscreen) return owned.executeJavaScript('document.exitFullscreen()', true);
              htmlFullscreenContents.delete(owned.id);
              if (hostWindow && !hostWindow.isDestroyed()) toggleWindowFullscreen(hostWindow);
              return null;
            })
            .catch(() => {
              htmlFullscreenContents.delete(owned.id);
              if (hostWindow && !hostWindow.isDestroyed()) toggleWindowFullscreen(hostWindow);
            });
          return;
        }
        if (hostWindow) toggleWindowFullscreen(hostWindow);
      } else if (input.key === 'Escape' && hostWindow?.isFullScreen()) {
        event.preventDefault();
        toggleWindowFullscreen(hostWindow);
      }
      // The docked DevTools is a separate webContents: while it holds focus the
      // chrome renderer never sees the key, so F12 could open the panel but
      // never close it. Route the binding back to the window that owns it.
      if (devtoolsHost && !manager.isDestroyed()
        && shortcutActionForInput(input, appSettings.shortcuts) === 'devtools') {
        event.preventDefault();
        manager.send('browser:shortcut', 'devtools');
      }
    });

    if (contents.getType() !== 'webview') return;
    attachPageFeatures(contents, { native: false });
  });

  // Links the OS launched us with (Luma being the default browser) wait for
  // the renderer to say it is ready to receive them.
  queuedLaunchUrls.push(...launchUrls(process.argv));
  createWindow();

  app.on('activate', () => {
    // Utility windows (downloads) keep the app alive after the browser window
    // closes; activating the app must bring a browser window back, never focus
    // the download list on its own.
    const existing = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((candidate) => (
        !candidate.isDestroyed() && candidate !== downloadsWindow && appWindows.has(candidate)
      ));
    if (existing) {
      existing.show();
      existing.focus();
      return;
    }
    createWindow();
  });
});

// The UI reports readiness once its tab store is mounted, so a launch URL is
// opened as a real tab instead of being dropped on the floor.
ipcMain.on('window:ui-ready', () => {
  flushQueuedLaunchUrls();
});

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
    if (win === mainWindow) {
      const restored = normalizeWindowBounds(readWindowState(windowStatePath())?.bounds, DEFAULT_WINDOW_BOUNDS);
      if (restored) win.setBounds(restored);
    }
  } else {
    win.maximize();
  }
});
ipcMain.handle('window:cursor-point', () => screen.getCursorScreenPoint());
ipcMain.handle('window:id', (event) => BrowserWindow.fromWebContents(event.sender)?.id ?? 0);
// A context menu opened on the page leaves keyboard focus in the page view, so
// Escape and friends never reach the chrome. Hand focus back to the renderer.
ipcMain.on('window:focus-ui', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.webContents.focus();
});
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());
ipcMain.on('window:open-incognito', () => createWindow({ incognito: true }));
ipcMain.on('window:open-downloads', () => openDownloadsWindow());
ipcMain.on('window:initial-tab', (event, key) => {
  event.returnValue = typeof key === 'string' ? pendingInitialTabs.get(key) ?? null : null;
});

function sanitizeInitialTab(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const entries = Array.isArray(payload.entries)
    ? payload.entries.slice(0, 50).map((entry) => {
        if (!entry || typeof entry.url !== 'string') return null;
        const url = entry.url;
        const isInternal = /^luma:\/\/(home|newtab|bookmarks|history|settings)$/.test(url);
        if (!isInternal && !isAllowedContentUrl(url)) return null;
        return {
          url,
          title: typeof entry.title === 'string' ? entry.title.slice(0, 300) : url,
          visitedAt: Number.isFinite(entry.visitedAt) ? entry.visitedAt : Date.now(),
        };
      }).filter(Boolean)
    : [];
  if (entries.length === 0) return null;
  const historyIndex = Number.isInteger(payload.historyIndex)
    ? Math.min(Math.max(0, payload.historyIndex), entries.length - 1)
    : entries.length - 1;
  return {
    id: typeof payload.id === 'string' && payload.id.length <= 80 ? payload.id : `tab-${crypto.randomUUID()}`,
    title: typeof payload.title === 'string' ? payload.title.slice(0, 300) : entries[historyIndex].title,
    entries,
    historyIndex,
    viewUrl: isSafeHttpUrl(entries[historyIndex].url) || isFileUrl(entries[historyIndex].url)
      ? entries[historyIndex].url
      : undefined,
    // A data URL keeps the site icon after the tab leaves its window.
    favicon: typeof payload.favicon === 'string'
      && /^(data:image\/|https?:\/\/)/i.test(payload.favicon)
      && payload.favicon.length <= 500_000
      ? payload.favicon
      : undefined,
  };
}

ipcMain.handle('window:tear-off-tab', (_event, payload, placement) => {
  const initialTab = sanitizeInitialTab(payload);
  if (!initialTab) return false;
  const point = normalizeScreenPoint(placement);
  createWindow({ initialTab, placement: point });
  return true;
});

/** Opens the remaining tabs of a split window, preserving their order. */
ipcMain.handle('window:split-tabs', (event, payload) => {
  const tabs = Array.isArray(payload?.tabs)
    ? payload.tabs.slice(0, 100).map(sanitizeInitialTab).filter(Boolean)
    : [];
  if (tabs.length === 0) return false;
  const activeId = tabs.some((tab) => tab.id === payload?.activeId) ? payload.activeId : tabs[0].id;
  // Main owns the exact window geometry; the renderer's outer bounds include
  // the shadow and would grow the new window by a few pixels.
  const source = BrowserWindow.fromWebContents(event.sender);
  const bounds = normalizeExternalBounds(payload?.bounds) ?? (source ? source.getBounds() : null);
  const created = createWindow({ initialTabs: tabs, initialActiveId: activeId, bounds });
  if (!created) return false;
  // The window that keeps the remaining tabs stays as it is; the torn page gets
  // a normal window at the drop point, exactly like other browsers.
  // Hand the running pages over instead of letting the new window load them:
  // this is what makes a tear-off behave like a real browser tab.
  if (source) {
    const manager = pageViewsFor(Boolean(appWindows.get(source)?.incognito));
    const area = created.getContentBounds();
    for (const tab of tabs) {
      if (!manager.hostedBy(tab.id, source)) continue;
      markTabHandoff(tab.id, created);
      manager.attach(tab.id, created, {
        x: 0,
        y: TAB_BAR_HEIGHT + NAV_BAR_HEIGHT,
        width: area.width,
        height: Math.max(1, area.height - TAB_BAR_HEIGHT - NAV_BAR_HEIGHT),
      });
    }
  }
  return created.id;
});

/** Moves the sender window itself, used when a tab is torn out without reloading it. */
/**
 * A tab dragged out of the tab bar hands its live page to a frameless window
 * that follows the cursor. The user drags the real page, not a screenshot; on
 * release the window turns into a normal browser window (or merges back).
 */
const tabDragSessions = new Map();

// A tab handed to another window is briefly protected from the source
// renderer. React may still re-render once after the drop and would otherwise
// pull the live page back (and then destroy it), leaving the target blank.
const tabHandoffs = new Map();

function markTabHandoff(tabId, win) {
  if (!tabId || !win || win.isDestroyed()) return;
  const previous = tabHandoffs.get(tabId);
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => tabHandoffs.delete(tabId), 15_000);
  tabHandoffs.set(tabId, { windowId: win.id, timer });
}

function clearTabHandoff(tabId, win) {
  const entry = tabHandoffs.get(tabId);
  if (!entry || !win || entry.windowId !== win.id) return;
  clearTimeout(entry.timer);
  tabHandoffs.delete(tabId);
}

/** True when the source window must not touch a tab that now belongs elsewhere. */
function tabHandoffBlocks(tabId, win) {
  const entry = tabHandoffs.get(tabId);
  if (!entry) return false;
  if (win && entry.windowId === win.id) return false;
  return true;
}

// Drops that were already resolved while the pointer was moving still send a
// final dragend. Remember them so the release does not close the tab twice.
const settledTabDrops = new Map();

function rememberSettledTabDrop(sourceId, tabId) {
  const key = `${sourceId}:${tabId}`;
  settledTabDrops.set(key, Date.now());
  setTimeout(() => settledTabDrops.delete(key), 5_000);
}

function forgetSettledTabDrop(sourceId, tabId) {
  settledTabDrops.delete(`${sourceId}:${tabId}`);
}

function stopTabDragSession(session) {
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  tabDragSessions.delete(session.id);
}

// Tab hover previews are small HTML cards. They used to be rendered inside the
// window, which forced the native page to step aside (and flash); they now live
// in their own transparent window above everything.
let tabPreviewWindow = null;
const tabPreviewOwners = new WeakSet();

function escapeHtmlText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function tabPreviewHtml(payload) {
  const thumbnail = typeof payload?.thumbnail === 'string' && payload.thumbnail.startsWith('data:image/')
    ? payload.thumbnail
    : '';
  const favicon = typeof payload?.favicon === 'string'
    && /^(data:image\/|https?:\/\/)/i.test(payload.favicon)
    ? payload.favicon
    : '';
  const theme = payload?.theme && typeof payload.theme === 'object' ? payload.theme : {};
  const surface = escapeHtmlText(theme.surface || '#ffffff');
  const border = escapeHtmlText(theme.border || 'rgba(24,24,48,.12)');
  const text = escapeHtmlText(theme.text || '#2f3142');
  const muted = escapeHtmlText(theme.muted || '#7b7f94');
  const soft = escapeHtmlText(theme.soft || '#f1f1f8');
  const title = escapeHtmlText(payload?.title || 'Luma');
  const host = escapeHtmlText(payload?.host || '');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none}
.card{padding:7px;border:1px solid ${border};border-radius:14px;background:${surface};
box-shadow:0 12px 32px rgba(20,20,40,.18);box-sizing:border-box;height:100%}
.page{display:flex;flex-direction:column;align-items:center;justify-content:center;height:148px;
overflow:hidden;border-radius:9px;background:linear-gradient(145deg,${soft},${soft})}
.page img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
.host{color:${muted};font-size:10px}
.info{display:flex;align-items:center;gap:8px;padding:9px 5px 3px}
.info img{width:16px;height:16px;border-radius:4px;flex:none}
.info div{display:flex;flex-direction:column;min-width:0;gap:2px}
.info strong{color:${text};font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.info small{color:${muted};font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style></head><body><div class="card">
<div class="page">${thumbnail
    ? `<img src="${escapeHtmlText(thumbnail)}" alt="">`
    : `<span class="host">${host || 'Luma'}</span>`}</div>
<div class="info">${favicon ? `<img src="${escapeHtmlText(favicon)}" alt="">` : ''}
<div><strong>${title}</strong><small>${host}</small></div></div>
</div></body></html>`;
}

let tabPreviewCloseTimer = null;

function hideTabPreview({ dispose = false } = {}) {
  const preview = tabPreviewWindow;
  if (!preview || preview.isDestroyed()) return;
  if (preview.isVisible()) preview.hide();
  if (!dispose) return;
  // A hidden helper window would linger in the window list, so the card is torn
  // down as soon as it closes; the next hover builds a fresh one.
  if (tabPreviewCloseTimer) clearTimeout(tabPreviewCloseTimer);
  tabPreviewCloseTimer = null;
  if (tabPreviewWindow && !tabPreviewWindow.isDestroyed()) tabPreviewWindow.destroy();
  tabPreviewWindow = null;
}

ipcMain.handle('tab-preview:show', (event, payload) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return false;
  const width = Math.round(Number(payload?.width) || 264);
  const height = Math.round(Number(payload?.height) || 202);
  if (!tabPreviewWindow || tabPreviewWindow.isDestroyed()) {
    tabPreviewWindow = new BrowserWindow({
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    tabPreviewWindow.on('closed', () => { tabPreviewWindow = null; });
  }
  const preview = tabPreviewWindow;
  // The card is decoration: a hover that lingers after the pointer leaves the
  // tab must never swallow clicks meant for the window underneath.
  preview.setIgnoreMouseEvents(true);
  preview.setSize(width, height);
  const content = owner.getContentBounds();
  const x = Math.round(content.x + (Number(payload?.x) || 0));
  const y = Math.round(content.y + (Number(payload?.y) || 0));
  preview.setPosition(x, y);
  void preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tabPreviewHtml(payload))}`)
    .catch(() => undefined);
  if (tabPreviewCloseTimer) {
    clearTimeout(tabPreviewCloseTimer);
    tabPreviewCloseTimer = null;
  }
  if (!preview.isVisible()) preview.showInactive();
  else preview.moveTop();
  if (!tabPreviewOwners.has(owner)) {
    tabPreviewOwners.add(owner);
    // A stale card would float over the wrong place while the window moves.
    for (const name of ['move', 'resize', 'blur', 'minimize', 'hide']) {
      owner.on(name, () => hideTabPreview());
    }
    owner.on('closed', () => hideTabPreview({ dispose: true }));
  }
  return true;
});

ipcMain.handle('tab-preview:hide', () => {
  hideTabPreview({ dispose: true });
  return true;
});

/**
 * The chrome a dragged tab wears while it follows the cursor. It is a still
 * image: only the page inside is live, which is what keeps the drag cheap.
 */
function dragChromeHtml(title) {
  const safeTitle = String(title || 'Luma')
    .replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
    .slice(0, 60);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#f4f4fa;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none}
.bar{height:40px;background:#e9e9f3;display:flex;align-items:flex-end;padding:0 8px;box-sizing:border-box}
.tab{height:30px;max-width:240px;display:flex;align-items:center;gap:7px;padding:0 11px;
border-radius:9px 9px 0 0;background:#fff;color:#2f3142;font-size:12px;white-space:nowrap;
overflow:hidden;text-overflow:ellipsis;box-shadow:0 -1px 2px rgba(20,20,40,.06)}
.dot{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.35;flex:none}
.tool{height:46px;background:#fbfbfe;border-bottom:1px solid #e6e6ef;display:flex;
align-items:center;gap:8px;padding:0 12px;box-sizing:border-box}
.pill{flex:1;height:26px;border-radius:13px;background:#f1f1f8}
.icon{width:22px;height:22px;border-radius:11px;background:#f1f1f8;flex:none}
</style></head><body>
<div class="bar"><div class="tab"><span class="dot"></span>${safeTitle}</div></div>
<div class="tool"><span class="icon"></span><span class="pill"></span><span class="icon"></span></div>
</body></html>`;
}

/** The drag session that currently owns a tab's live page, if any. */
function dragSessionForTab(tabId) {
  for (const session of tabDragSessions.values()) {
    if (session.revealed && session.tab.id === tabId) return session;
  }
  return null;
}

/**
 * Completes a merge while the pointer is still down. The page is handed to the
 * target immediately, and the source renderer is told to forget the tab so the
 * release that follows does not try to handle it again.
 */
function completeTabMerge(session, target) {
  const { source, follower, tab, incognito } = session;
  stopTabDragSession(session);
  if (source) rememberSettledTabDrop(source.id, tab.id);
  const manager = pageViewsFor(incognito);
  markTabHandoff(tab.id, target);
  manager.attach(tab.id, target);
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  target.webContents.send('window:adopt-tab', tab);
  if (source && !source.isDestroyed()) {
    source.webContents.send('tab-drag:merged', { tabId: tab.id, title: tab.title });
  }
  if (!follower.isDestroyed()) follower.close();
}

/**
 * A tab drag starts as soon as the pointer moves: the window exists right away
 * and only becomes visible once the pointer leaves the tab bar, so tearing out
 * never waits for the button release.
 */
ipcMain.handle('window:begin-tab-drag', (event, payload) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || source.isDestroyed()) return false;
  const tab = sanitizeInitialTab(payload?.tab);
  if (!tab) return false;
  // The OS cursor is authoritative. Renderer screen coordinates can disagree
  // with the frameless window's real origin, which is what made the follower
  // land slightly left of the pointer.
  const cursor = screen.getCursorScreenPoint();
  const sourceContent = source.getContentBounds();
  const pageWidth = Math.max(240, Math.min(3840, Math.round(Number(payload?.size?.width) || 900)));
  const pageHeight = Math.max(200, Math.min(2160, Math.round(Number(payload?.size?.height) || 640)));
  const chrome = TAB_BAR_HEIGHT + NAV_BAR_HEIGHT;
  // The pointer stays over the point where the tab was grabbed, exactly like a
  // real window would. The renderer reports that mousedown point; deriving it
  // from the cursor at dragstart would make the window trail the pointer by
  // however far it moved before the drag began.
  const grabX = Number(payload?.offset?.x);
  const grabY = Number(payload?.offset?.y);
  const originX = Number.isFinite(grabX) ? grabX : cursor.x - sourceContent.x;
  const originY = Number.isFinite(grabY) ? grabY : cursor.y - sourceContent.y;
  const offsetX = Math.max(0, Math.min(pageWidth - 24, Math.round(originX)));
  const offsetY = Math.max(0, Math.min(TAB_BAR_HEIGHT - 1, Math.round(originY)));
  const incognito = Boolean(appWindows.get(source)?.incognito);

  let follower = null;
  try {
    follower = new BrowserWindow({
      width: pageWidth,
      height: pageHeight + chrome,
      x: Math.round(cursor.x - offsetX),
      y: Math.round(cursor.y - offsetY),
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: true,
      backgroundColor: '#f4f4fa',
      webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
  } catch {
    return false;
  }
  follower.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(dragChromeHtml(tab.title))}`)
    .catch(() => undefined);

  const session = {
    id: follower.id,
    follower,
    source,
    tab,
    incognito,
    sourceId: source.id,
    offsetX,
    offsetY,
    // A frameless window's outer bounds can be a few pixels away from the
    // content; positioning the follower by bounds would reintroduce the drift.
    frameX: 0,
    frameY: 0,
    pageWidth,
    pageHeight,
    revealed: false,
    timer: null,
  };
  try {
    const fb = follower.getBounds();
    const fc = follower.getContentBounds();
    session.frameX = fb.x - fc.x;
    session.frameY = fb.y - fc.y;
  } catch {
    // Older platforms report identical bounds; no correction is needed.
  }

  /** Places the follower so the grabbed content point stays under the cursor. */
  const positionAt = (cursor) => {
    if (follower.isDestroyed()) return;
    follower.setPosition(
      Math.round(cursor.x - offsetX + session.frameX),
      Math.round(cursor.y - offsetY + session.frameY),
    );
  };
  positionAt(cursor);

  /** Hands the live page to the follower and shows it under the cursor. */
  const reveal = (at) => {
    if (session.revealed) return;
    session.revealed = true;
    const manager = pageViewsFor(incognito);
    manager.ensure(tab.id);
    manager.attach(tab.id, follower, {
      x: 0,
      y: chrome,
      width: pageWidth,
      height: pageHeight,
    });
    positionAt(at);
    if (!follower.isVisible()) follower.showInactive();
    if (!source.isDestroyed()) {
      source.webContents.send('tab-drag:started', { tabId: tab.id, title: tab.title });
    }
  };

  session.timer = setInterval(() => {
    if (follower.isDestroyed()) {
      stopTabDragSession(session);
      return;
    }
    const at = screen.getCursorScreenPoint();
    if (session.revealed) {
      positionAt(at);
      // Chrome merges as soon as the pointer enters another window's tab bar;
      // the button does not have to be released first.
      const target = appTabBarAtPoint(at, follower, incognito, source);
      if (target) completeTabMerge(session, target);
      return;
    }
    // The page swallows DOM drag events, so leaving the tab bar is detected here.
    const bounds = source.isDestroyed() ? null : source.getContentBounds();
    const stillInTabBar = bounds
      && at.x >= bounds.x
      && at.x <= bounds.x + bounds.width
      && at.y >= bounds.y
      && at.y <= bounds.y + TAB_BAR_HEIGHT;
    if (stillInTabBar) return;
    reveal(at);
  }, 16);

  tabDragSessions.set(follower.id, session);
  follower.on('closed', () => stopTabDragSession(session));
  return true;
});

/** The renderer reports pointer movement; the OS cursor drives the actual position. */
ipcMain.handle('window:update-tab-drag', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  const session = [...tabDragSessions.values()].find((item) => item.sourceId === source?.id);
  if (!session) return false;
  return true;
});

ipcMain.handle('window:end-tab-drag', (event) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  const session = [...tabDragSessions.values()].find((item) => item.sourceId === source?.id);
  if (!session) {
    // The drop was already resolved while the pointer was over another tab bar;
    // its final dragend must not close the tab a second time.
    return { merged: false, returned: false, ignored: true };
  }
  stopTabDragSession(session);

  const { follower, tab, incognito } = session;
  const manager = pageViewsFor(incognito);
  const point = screen.getCursorScreenPoint();

  // Nothing was torn out (a plain reorder), so the window simply disappears.
  if (!session.revealed) {
    if (!follower.isDestroyed()) follower.close();
    return { merged: false, returned: true };
  }

  // Releasing over the window the tab came from just puts it back.
  if (source && !source.isDestroyed() && appTabBarAtPoint(point, follower, incognito) === source) {
    manager.attach(tab.id, source);
    if (!follower.isDestroyed()) follower.close();
    return { merged: false, returned: true };
  }

  const target = appTabBarAtPoint(point, follower, incognito, source);
  if (target) {
    // The timer normally merges on entry; this is the release-path fallback.
    if (source) forgetSettledTabDrop(source.id, tab.id);
    markTabHandoff(tab.id, target);
    manager.attach(tab.id, target);
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send('window:adopt-tab', tab);
    if (!follower.isDestroyed()) follower.close();
    return { merged: true, returned: false };
  }

  // The new window lands exactly where the follower was: same offset from the
  // pointer, so the page does not move by a single pixel.
  const bounds = {
    x: Math.round(point.x - session.offsetX + session.frameX),
    y: Math.round(point.y - session.offsetY + session.frameY),
    width: session.pageWidth,
    height: session.pageHeight + TAB_BAR_HEIGHT + NAV_BAR_HEIGHT,
  };
  const created = createWindow({
    incognito,
    initialTabs: [tab],
    initialActiveId: tab.id,
    bounds,
    deferShow: true,
  });
  if (!created) {
    if (!follower.isDestroyed()) follower.close();
    return { merged: false, returned: false };
  }
  markTabHandoff(tab.id, created);
  manager.attach(tab.id, created, {
    x: 0,
    y: TAB_BAR_HEIGHT + NAV_BAR_HEIGHT,
    width: bounds.width,
    height: Math.max(1, bounds.height - TAB_BAR_HEIGHT - NAV_BAR_HEIGHT),
  });
  created.once('ready-to-show', () => {
    if (created.isDestroyed()) return;
    created.show();
    created.focus();
    if (!follower.isDestroyed()) follower.close();
  });
  return { merged: false, returned: false, windowId: created.id };
});

ipcMain.handle('window:move-to', (event, target) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !target) return false;
  const x = Math.round(Number(target.x));
  const y = Math.round(Number(target.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  try {
    // Keep the window size (and maximized/full-screen state on the other window)
    // so the tear-off looks like a new window rather than a resize.
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setPosition(x, y);
    win.focus();
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('page:picture-in-picture', async (_event, tabId, incognito) => {
  const manager = pageViewsFor(Boolean(incognito));
  const entry = manager.webContents.find((item) => item.tabId === tabId);
  if (!entry) return { ok: false, error: '这个标签页还没有加载页面' };
  const contents = entry.webContents;
  // Video players are often in a frame (embedded players, some news sites), and
  // a frame is invisible from the top document. Run the probe in each frame.
  const PIP_PROBE = `(async () => {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return { state: 'closed' };
    }
    if (document.pictureInPictureEnabled === false) return { state: 'unsupported' };
    const videos = [...document.querySelectorAll('video')]
      .filter((video) => !video.disablePictureInPicture && (video.currentSrc || video.src))
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight));
    if (videos.length === 0) return { state: 'no-video' };
    let lastError = '';
    for (const video of videos.slice(0, 6)) {
      try {
        await video.requestPictureInPicture();
        return { state: 'opened' };
      } catch (error) {
        lastError = (error && (error.name + ': ' + error.message)) || String(error);
      }
    }
    return { state: 'failed', error: lastError };
  })()`;

  const frames = [];
  try {
    const main = contents.mainFrame;
    frames.push(main);
    for (const frame of main.framesInSubtree ?? []) {
      if (frame !== main) frames.push(frame);
    }
  } catch {
    // A page without a live frame tree has nothing to show.
  }

  let lastError = '';
  for (const frame of frames) {
    try {
      const result = await frame.executeJavaScript(PIP_PROBE, true);
      if (!result) continue;
      if (result.state === 'opened' || result.state === 'closed' || result.state === 'unsupported') {
        return { ok: true, ...result };
      }
      if (result.state === 'failed') lastError = result.error || lastError;
    } catch {
      // A detached or sandboxed frame cannot be scripted; try the next one.
    }
  }
  if (lastError) return { ok: false, error: lastError };
  return { ok: true, state: 'no-video' };
});

ipcMain.handle('page-view:ensure', (event, tabId, url, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const flagged = Boolean(incognito) || Boolean(win && appWindows.get(win)?.incognito);
  const manager = pageViewsFor(flagged);
  const safeUrl = sanitizePageUrl(url);
  manager.ensure(tabId, safeUrl || undefined);
  return manager.info(tabId);
});

ipcMain.handle('page-view:attach', (event, tabId, bounds, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  // While a tab is being dragged, its page belongs to the drag window; the
  // source window must not pull it back while React still catches up.
  const session = dragSessionForTab(tabId);
  if (session && session.sourceId === win.id) return false;
  if (tabHandoffBlocks(tabId, win)) return false;
  const flagged = Boolean(incognito) || Boolean(appWindows.get(win)?.incognito);
  const attached = pageViewsFor(flagged).attach(tabId, win, bounds);
  if (attached) clearTabHandoff(tabId, win);
  return attached;
});

ipcMain.handle('page-view:move', (_event, tabId, targetWindowId, bounds, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const target = BrowserWindow.fromId(targetWindowId);
  if (!target || target.isDestroyed()) return false;
  return pageViewsFor(Boolean(incognito)).attach(tabId, target, bounds);
});

ipcMain.handle('page-view:detach', (event, tabId, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (tabHandoffBlocks(tabId, win)) return false;
  return pageViewsFor(Boolean(incognito)).detach(tabId);
});

ipcMain.handle('page-view:bounds', (event, tabId, bounds, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  const session = dragSessionForTab(tabId);
  if (session && win && session.sourceId === win.id) return false;
  if (tabHandoffBlocks(tabId, win)) return false;
  return pageViewsFor(Boolean(incognito)).setBounds(tabId, bounds);
});

ipcMain.handle('page-view:visible', (event, tabId, visible, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  const session = dragSessionForTab(tabId);
  if (session && win && session.sourceId === win.id) return false;
  if (tabHandoffBlocks(tabId, win)) return false;
  return pageViewsFor(Boolean(incognito)).setVisible(tabId, visible);
});

ipcMain.handle('page-view:info', (_event, tabId, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return null;
  return pageViewsFor(Boolean(incognito)).info(tabId);
});

ipcMain.handle('page-view:command', (_event, tabId, name, args, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return null;
  return pageViewsFor(Boolean(incognito)).command(tabId, String(name || ''), Array.isArray(args) ? args : []);
});

ipcMain.handle('page-view:destroy', (event, tabId, incognito) => {
  if (typeof tabId !== 'string' || !tabId) return false;
  const manager = pageViewsFor(Boolean(incognito));
  const win = BrowserWindow.fromWebContents(event.sender);
  if (tabHandoffBlocks(tabId, win)) return false;
  const info = manager.info(tabId);
  const host = info ? manager.hostWindowFor(info.webContentsId) : null;
  // A tab that was merged into (or split out to) another window is no longer
  // owned here; destroying it would kill the page the other window now shows.
  if (win && host && host !== win) return false;
  return manager.destroy(tabId);
});


/**
 * Hands a tab back to whichever Luma window sits under the drop point.
 * Returns { merged: false } when the release point is not over another window,
 * so the renderer can fall back to tearing off a new window.
 */
ipcMain.handle('window:merge-tab', (event, payload, placement) => {
  const source = BrowserWindow.fromWebContents(event.sender);
  if (!source || source.isDestroyed()) return { merged: false };
  const initialTab = sanitizeInitialTab(payload);
  if (!initialTab) return { merged: false };
  const point = normalizeScreenPoint(placement) || screen.getCursorScreenPoint();
  const target = appTabBarAtPoint(point, source, Boolean(appWindows.get(source)?.incognito));
  if (!target) return { merged: false };
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  // Move the running page first, so the target window adopts a live view
  // instead of loading the URL again.
  const manager = pageViewsFor(Boolean(appWindows.get(source)?.incognito));
  if (manager.hostedBy(initialTab.id, source)) {
    markTabHandoff(initialTab.id, target);
    manager.attach(initialTab.id, target);
  }
  target.webContents.send('window:adopt-tab', initialTab);
  return { merged: true };
});

ipcMain.handle('settings:configure', (_event, payload) => {
  if (!payload || typeof payload !== 'object') return { bossKeyRegistered: Boolean(currentBossKey()) };
  if (typeof payload.bossKey === 'string' && payload.bossKey.length <= 64) {
    appSettings.bossKey = payload.bossKey;
  }
  if (typeof payload.downloadsAskWhere === 'boolean') {
    appSettings.downloadsAskWhere = payload.downloadsAskWhere;
  }
  if (payload.shortcuts && typeof payload.shortcuts === 'object') {
    const next = { ...DEFAULT_SHORTCUTS };
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      const value = payload.shortcuts[action];
      if (typeof value === 'string' && value.length <= 64) next[action] = value;
    }
    appSettings.shortcuts = next;
  }
  saveAppSettings();
  const registered = appSettings.bossKey !== currentBossKey()
    ? registerBossKey(appSettings.bossKey)
    : Boolean(currentBossKey());
  return { bossKeyRegistered: registered };
});

ipcMain.handle('adblock:state', () => adblockOverview());
ipcMain.handle('adblock:update', async () => {
  if (adblockManager) await adblockManager.update(true);
  applyCosmeticFiltersToAll();
  return adblockOverview();
});
ipcMain.handle('adblock:set-enabled', (_event, enabled) => {
  appSettings.adblock.enabled = Boolean(enabled);
  saveAppSettings();
  if (!appSettings.adblock.enabled) clearAllCosmeticFilters();
  return adblockOverview();
});
ipcMain.handle('adblock:set-site', (_event, host, disabled) => {
  if (typeof host !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(host)) return adblockOverview();
  // One canonical entry per site: `www.` is presentation, not identity.
  const cleanHost = siteKey(host);
  if (!cleanHost) return adblockOverview();
  const sites = appSettings.adblock.disabledSites.filter((site) => siteKey(site) !== cleanHost);
  if (disabled) sites.push(cleanHost);
  appSettings.adblock.disabledSites = sites;
  saveAppSettings();
  refreshAdblockForHost(cleanHost);
  return adblockOverview();
});

ipcMain.handle('page:translate', (_event, texts, target, provider, apiKey) => {
  if (!Array.isArray(texts)) return { ok: false, error: 'invalid-texts', translations: [] };
  return translateTexts(
    texts,
    typeof target === 'string' ? target : 'zh-CN',
    typeof provider === 'string' ? provider : 'auto',
    typeof apiKey === 'string' ? apiKey : '',
  );
});

ipcMain.handle('passwords:status', () => ({
  ...passwordVault.status(),
}));
ipcMain.handle('passwords:list', () => passwordVault.listEntries());
ipcMain.handle('passwords:save', (_event, origin, username, password) => (
  passwordVault.saveEntry({ origin, username, password })
));
ipcMain.handle('passwords:delete', (_event, id) => (
  typeof id === 'string' ? passwordVault.removeEntry(id) : { ok: false, entries: passwordVault.listEntries() }
));
ipcMain.handle('passwords:clear', () => passwordVault.clearEntries());
ipcMain.handle('passwords:reveal', (_event, id) => (
  typeof id === 'string' ? passwordVault.revealEntry(id) : null
));
ipcMain.handle('passwords:list-for-origin', (_event, origin) => (
  typeof origin === 'string' ? passwordVault.listForOrigin(origin) : []
));
ipcMain.handle('passwords:has-credential', (_event, origin, username, password) => (
  passwordVault.hasEntry({ origin, username, password })
));
// Autofill is resolved in the main process for the guest's current origin and
// sent straight to the isolated preload; plaintext never enters the page world.
ipcMain.handle('passwords:autofill-tab', (_event, webContentsId, entryId) => {
  if (!Number.isInteger(webContentsId)) return false;
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed() || !isPageContents(contents)) return false;
  const origin = safeOrigin(contents.getURL());
  if (!origin) return false;
  const entries = passwordVault.entriesForOrigin(origin);
  const entry = typeof entryId === 'string'
    ? entries.find((item) => item.id === entryId)
    : entries[0];
  if (!entry) return false;
  contents.send('luma:autofill', { username: entry.username, password: entry.password });
  return true;
});

/**
 * Origin of the frame that sent an IPC message. Autofill never trusts an origin
 * supplied by the caller: the dropdown asks "what is saved for this page" and
 * the main process answers for the frame's own URL.
 */
function senderOrigin(event) {
  try {
    return safeOrigin(event.senderFrame?.url || event.sender.getURL());
  } catch {
    return null;
  }
}

// Fills the dropdown the guest preload shows above a focused login field. Only
// account names travel: the password is fetched when a row is picked, so it is
// never rendered into page-visible DOM.
ipcMain.handle('passwords:suggest', (event) => {
  const origin = senderOrigin(event);
  if (!origin) return [];
  return passwordVault.listForOrigin(origin).map((entry) => ({ id: entry.id, username: entry.username }));
});

ipcMain.handle('passwords:fill-entry', (event, entryId) => {
  const origin = senderOrigin(event);
  if (!origin || typeof entryId !== 'string') return null;
  const entry = passwordVault.revealEntry(entryId);
  if (!entry || entry.origin !== origin) return null;
  return { username: entry.username, password: entry.password };
});

function broadcastUpdateState(snapshot) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updates:state', snapshot);
  }
}

ipcMain.handle('updates:state', () => updateManager?.getState() ?? null);
ipcMain.handle('updates:check', () => {
  // Checking never starts the download: the settings page shows a download
  // button (with a choice of routes) once a newer version is known.
  void updateManager?.check({ autoDownload: false })?.catch(() => undefined);
  return updateManager?.getState() ?? null;
});
ipcMain.handle('updates:download', (_event, line) => updateManager?.download(line) ?? null);
ipcMain.handle('updates:install', () => updateManager?.install() ?? false);
ipcMain.handle('updates:prefs', () => updateManager?.getState().prefs ?? { autoDownload: true, applyOnQuit: true });
ipcMain.handle('updates:set-prefs', (_event, patch) => updateManager?.setPrefs(patch) ?? null);
// Chrome exposes chrome://version; the settings page shows the same three roots
// so a user can find the profile, the update cache and the program directory.
/**
 * Opens an extension's own page (dashboard, options, popup) in a normal window.
 *
 * Extension pages have to keep the `chrome-extension://` origin to reach their
 * `chrome.*` APIs, so they cannot be rendered as a Luma tab. A dedicated window
 * is the closest a Chromium embedder can get, and it keeps dashboards such as
 * Tampermonkey's reachable even when the toolbar popup is limited.
 */
async function openExtensionPage(extensionId, page) {
  if (!extensionManager) return { ok: false, error: '扩展管理器尚未就绪' };
  const url = extensionManager.pageFor(extensionId, page);
  if (!url) return { ok: false, error: '这个扩展没有可以打开的页面' };
  if (extensionPageWindow && !extensionPageWindow.isDestroyed()) {
    extensionPageWindow.destroy();
    extensionPageWindow = null;
  }
  const entry = extensionManager.list().find((item) => item.id === extensionId);
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 520,
    minHeight: 420,
    backgroundColor: '#ffffff',
    title: entry ? `${entry.name} · Luma` : '扩展 · Luma',
    autoHideMenuBar: true,
    webPreferences: {
      session: browserSession,
      // The shim has to patch the page's own `chrome` object, which only works
      // without isolation; node stays off and the page keeps its own origin.
      preload: path.join(__dirname, 'extension-preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  extensionPageWindow = win;
  win.setMenuBarVisibility(false);
  win.once('closed', () => {
    if (extensionPageWindow === win) extensionPageWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isSafeHttpUrl(target) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:open-url', target);
      mainWindow.show();
      mainWindow.focus();
    } else if (target.startsWith('chrome-extension://')) {
      void win.loadURL(target);
    }
    return { action: 'deny' };
  });
  // The page must be allowed to be who it is: no navigation away from the
  // extension origin, or the privilege would be handed to a web page.
  win.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith('chrome-extension://')) return;
    event.preventDefault();
    if (isSafeHttpUrl(target)) mainWindow?.webContents.send('window:open-url', target);
  });
  await win.loadURL(url).catch(() => undefined);
  return { ok: true, url };
}

function closeExtensionPopup() {
  if (!extensionPopupWindow) return false;
  const win = extensionPopupWindow;
  extensionPopupWindow = null;
  extensionPopupOwner = null;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    // Already gone.
  }
  return true;
}

/**
 * Hosts an extension popup in its own frameless window.
 *
 * A popup has to run as an extension page (`chrome-extension://…`) so its
 * `chrome.*` calls work, which rules out rendering it inside the React UI. A
 * child window positioned under the toolbar icon keeps the extension origin
 * intact and cannot be covered by the native page view.
 */
async function openExtensionPopup(extensionId, anchor) {
  if (!extensionManager) return { ok: false, error: '扩展管理器尚未就绪' };
  const entry = extensionManager.list().find((item) => item.id === extensionId);
  if (!entry) return { ok: false, error: '扩展不存在' };
  const popupUrl = entry.toolbar?.popup;
  if (!popupUrl) return { ok: false, error: '这个扩展没有弹窗界面' };
  if (extensionPopupWindow && extensionPopupOwner === extensionId) {
    closeExtensionPopup();
    return { ok: true, closed: true };
  }
  closeExtensionPopup();

  const point = normalizeScreenPoint(anchor);
  const width = 420;
  const height = 520;
  const display = screen.getDisplayNearestPoint(point ?? screen.getCursorScreenPoint());
  const area = display.workArea;
  const anchorHeight = Number(anchor?.height) || 30;
  const desiredX = Math.round(Math.min(
    Math.max(area.x + 8, (point?.x ?? area.x) - 10),
    area.x + area.width - width - 8,
  ));
  const desiredY = Math.round(Math.min(
    Math.max(area.y + 8, (point?.y ?? area.y) + anchorHeight + 8),
    area.y + area.height - height - 8,
  ));

  const win = new BrowserWindow({
    x: desiredX,
    y: desiredY,
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    parent: mainWindow ?? undefined,
    title: entry.name,
    webPreferences: {
      session: browserSession,
      // Same shim as the dashboard: a popup button that wants a tab can ask for
      // one instead of throwing.
      preload: path.join(__dirname, 'extension-preload.cjs'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  extensionPopupWindow = win;
  extensionPopupOwner = extensionId;

  let ready = false;
  // Extension popups often link to their own pages (options, help). Those open
  // in a normal tab instead of being silently blocked.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('chrome-extension://')) {
      // An extension page must keep its own origin, so it gets a real window.
      openExtensionPage(extensionId, url.replace(/^chrome-extension:\/\/[^/]+\//, ''));
      return { action: 'deny' };
    }
    if (isSafeHttpUrl(url) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:open-url', url);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return { action: 'deny' };
  });
  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        const size = await win.webContents.executeJavaScript(`(() => {
          // Chrome sizes a popup to its content; body's rect is the closest
          // equivalent, because scrollHeight of a short page equals the viewport.
          const root = document.documentElement;
          const body = document.body;
          const rect = body?.getBoundingClientRect();
          return {
            w: Math.ceil(rect?.width || body?.scrollWidth || root?.scrollWidth || 0),
            h: Math.ceil(rect?.height || body?.scrollHeight || root?.scrollHeight || 0),
          };
        })()`, true);
        const nextWidth = Math.min(760, Math.max(220, Number(size?.w) || width));
        const nextHeight = Math.min(620, Math.max(120, Number(size?.h) || height));
        const clampedX = Math.min(desiredX, area.x + area.width - nextWidth - 8);
        const clampedY = Math.min(desiredY, area.y + area.height - nextHeight - 8);
        win.setBounds({ x: Math.round(clampedX), y: Math.round(clampedY), width: nextWidth, height: nextHeight });
      } catch {
        // Keep the default size when the popup cannot be measured.
      }
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      // Ignore the blur that fires while the window is still being focused.
      setTimeout(() => { ready = true; }, 250);
    })();
  });
  win.webContents.on('did-fail-load', () => closeExtensionPopup());
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      closeExtensionPopup();
    }
  });
  win.on('blur', () => {
    if (ready) closeExtensionPopup();
  });
  win.on('closed', () => {
    if (extensionPopupWindow === win) {
      extensionPopupWindow = null;
      extensionPopupOwner = null;
    }
  });

  try {
    await win.loadURL(popupUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    closeExtensionPopup();
    return { ok: false, error: `弹窗加载失败：${message}` };
  }
  return { ok: true, opened: true };
}

ipcMain.handle('extensions:list', () => extensionManager?.list() ?? []);
ipcMain.handle('userscripts:list', () => userscriptManager?.list() ?? []);
ipcMain.handle('userscripts:install', async (event, sourcePath) => {
  if (!userscriptManager) return { ok: false, error: '用户脚本管理器尚未就绪', list: [] };
  let source = typeof sourcePath === 'string' && sourcePath ? sourcePath : '';
  if (!source) {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择用户脚本（.user.js）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '用户脚本', extensions: ['js'] }],
      buttonLabel: '安装脚本',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true, list: userscriptManager.list() };
    }
    let installed = 0;
    let lastError = '';
    for (const file of result.filePaths) {
      const outcome = userscriptManager.install(file);
      if (outcome.ok) installed += 1;
      else lastError = outcome.error || lastError;
    }
    return {
      ok: installed > 0,
      installed,
      error: installed === 0 ? lastError : '',
      list: userscriptManager.list(),
    };
  }
  const outcome = userscriptManager.install(source);
  return { ...outcome, list: userscriptManager.list() };
});
ipcMain.handle('userscripts:set-enabled', (_event, id, enabled) => (
  userscriptManager?.setEnabled(id, enabled) ?? { ok: false, list: [] }
));
ipcMain.handle('userscripts:remove', (_event, id) => (
  userscriptManager?.remove(id) ?? { ok: false, list: [] }
));
ipcMain.handle('userscripts:reload', () => {
  userscriptManager?.scan();
  return { ok: true, list: userscriptManager?.list() ?? [] };
});
ipcMain.handle('userscripts:open-folder', async () => {
  const directory = userscriptManager?.directory;
  if (!directory) return false;
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    // shell.openPath reports the failure below.
  }
  const error = await shell.openPath(directory);
  return !error;
});
// GM_xmlhttpRequest from a userscript: the page posts to the preload, the
// preload asks here, and the reply goes back the same way. Only http(s).
ipcMain.handle('userscripts:request', async (_event, details) => {
  const url = typeof details?.url === 'string' ? details.url : '';
  if (!/^https?:\/\//i.test(url)) return { error: 'only http(s) URLs are allowed' };
  const method = typeof details?.method === 'string' ? details.method.toUpperCase() : 'GET';
  const headers = {};
  if (details?.headers && typeof details.headers === 'object') {
    for (const [key, value] of Object.entries(details.headers)) {
      if (typeof key === 'string' && typeof value === 'string' && key.length < 100 && !/[\r\n]/.test(key + value)) {
        headers[key] = value;
      }
    }
  }
  try {
    const response = await net.fetch(url, {
      method,
      headers,
      body: typeof details?.data === 'string' ? details.data : undefined,
    });
    const text = (await response.text()).slice(0, 5 * 1024 * 1024);
    const replyHeaders = [...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\r\n');
    return { status: response.status, statusText: response.statusText, headers: replyHeaders, text, url: response.url };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'request failed' };
  }
});
ipcMain.on('userscripts:open', (event, url) => {
  if (typeof url !== 'string' || !isSafeHttpUrl(url)) return;
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  win?.webContents.send('browser:new-window', url);
});
ipcMain.handle('extensions:install', async (event, sourcePath) => {
  if (!extensionManager) return { ok: false, error: '扩展管理器尚未就绪', list: [] };
  let source = typeof sourcePath === 'string' && sourcePath ? sourcePath : '';
  if (!source) {
    // Picking the folder is the user's explicit consent to run third-party code.
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择已解压的扩展目录（含 manifest.json）',
      properties: ['openDirectory'],
      buttonLabel: '加载扩展',
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true, list: extensionManager.list() };
    source = result.filePaths[0];
  }
  const outcome = await extensionManager.install(source);
  return { ...outcome, list: extensionManager.list() };
});
ipcMain.handle('extensions:install-crx', async (event, sourcePath) => {
  if (!extensionManager) return { ok: false, error: '扩展管理器尚未就绪', list: [] };
  let source = typeof sourcePath === 'string' && sourcePath ? sourcePath : '';
  if (!source) {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '选择扩展安装包（.crx）',
      properties: ['openFile'],
      filters: [{ name: 'Chrome 扩展', extensions: ['crx'] }],
      buttonLabel: '安装',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true, list: extensionManager.list() };
    }
    source = result.filePaths[0];
  }
  const outcome = await extensionManager.installCrx(source);
  return { ...outcome, list: extensionManager.list() };
});
ipcMain.handle('extensions:set-enabled', (_event, id, enabled) => (
  extensionManager ? extensionManager.setEnabled(id, enabled) : { ok: false, list: [] }
));
ipcMain.handle('extensions:reload', (_event, id) => (
  extensionManager ? extensionManager.reload(id) : { ok: false, list: [] }
));
ipcMain.handle('extensions:remove', (_event, id) => (
  extensionManager ? extensionManager.remove(id) : { ok: false, list: [] }
));
ipcMain.handle('extensions:popup', (_event, id, anchor) => openExtensionPopup(id, anchor));
ipcMain.handle('extensions:open-page', (_event, id, page) => openExtensionPage(id, page));
// `chrome.tabs.create` / `chrome.windows.create` from an extension page. Only an
// extension frame may call it, and only http(s) or its own extension pages may
// be opened, so a compromised page cannot steer the browser elsewhere.
ipcMain.handle('extensions:open-url', async (event, payload) => {
  const url = typeof payload?.url === 'string' ? payload.url.trim() : '';
  if (!url || url.length > 8192) return { ok: false, error: '地址无效' };
  const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
  if (!senderUrl.startsWith('chrome-extension://')) return { ok: false, error: '不可信来源' };
  if (url.startsWith('chrome-extension://')) {
    const match = url.match(/^chrome-extension:\/\/([^/]+)\/?(.*)$/);
    if (!match) return { ok: false, error: '地址无效' };
    const page = match[2] ? `${match[2]}${url.includes('#') ? url.slice(url.indexOf('#')) : ''}` : '';
    const opened = await openExtensionPage(match[1], page || 'options.html');
    return opened.ok ? { ok: true, url: opened.url } : { ok: false, error: opened.error };
  }
  if (!isSafeHttpUrl(url)) return { ok: false, error: '只允许打开网页地址' };
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不可用' };
  // The renderer owns tabs, so it opens the tab; the window is raised here
  // because a popup that closes should not leave the browser in the background.
  mainWindow.webContents.send('window:open-url', url);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return { ok: true, url };
});
ipcMain.handle('extensions:close-popup', () => closeExtensionPopup());
ipcMain.handle('extensions:open-folder', async () => {
  const target = extensionsDirectory ?? appPaths.extensions;
  try {
    fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('app:paths', () => ({
  install: app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath(),
  userData: app.getPath('userData'),
  update: appPaths.update,
  log: appPaths.log,
  isolated: appPaths.overridden,
}));

ipcMain.handle('default-browser:status', () => defaultBrowser.status());
ipcMain.handle('default-browser:register', () => defaultBrowser.register());

ipcMain.handle('app:versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron ?? '',
  chrome: process.versions.chrome ?? '',
  node: process.versions.node ?? '',
  v8: process.versions.v8 ?? '',
  platform: process.platform,
  arch: process.arch,
}));

ipcMain.handle('window:is-maximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);

/**
 * Bounds to put back after leaving fullscreen. A frameless window occasionally
 * keeps the screen-sized geometry once Windows hands control back, which looks
 * like "F11 did not really exit". Remembering the pre-fullscreen rectangle lets
 * the window return to where it was.
 * @type {WeakMap<Electron.BrowserWindow, Electron.Rectangle | null>}
 */
const fullscreenRestoreBounds = new WeakMap();

function toggleWindowFullscreen(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    const restore = fullscreenRestoreBounds.get(win) ?? null;
    fullscreenRestoreBounds.delete(win);
    if (restore) {
      setTimeout(() => {
        if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
        const current = win.getBounds();
        const display = screen.getDisplayMatching(current).bounds;
        const coversScreen = current.width >= display.width - 2 && current.height >= display.height - 2;
        if (coversScreen) win.setBounds(restore);
      }, 450);
    }
    return false;
  }
  fullscreenRestoreBounds.set(win, win.isMaximized() ? null : win.getBounds());
  win.setFullScreen(true);
  return true;
}

ipcMain.handle('window:toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return toggleWindowFullscreen(win);
});
function guestContentsFromId(targetId) {
  if (!Number.isInteger(targetId)) return null;
  const contents = webContents.fromId(targetId);
  if (!contents || contents.isDestroyed() || !isPageContents(contents)) return null;
  return contents;
}

ipcMain.handle('page:print', (event, targetId) => new Promise((resolve) => {
  const target = guestContentsFromId(targetId);
  if (!target) {
    resolve({ success: false, reason: '页面不可用' });
    return;
  }
  try {
    target.print({ silent: false, printBackground: true }, (success, failureReason) => {
      resolve({ success, reason: success ? '' : (failureReason || '打印已取消') });
    });
  } catch (error) {
    resolve({ success: false, reason: error instanceof Error ? error.message : '打印失败' });
  }
}));

ipcMain.handle('page:save-pdf', async (event, targetId, suggestedName) => {
  const target = guestContentsFromId(targetId);
  if (!target) return { canceled: true, failed: true };
  const win = BrowserWindow.fromWebContents(event.sender);
  const rawName = typeof suggestedName === 'string'
    ? suggestedName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 90)
    : '';
  const safeName = rawName
    ? (/[.]pdf$/i.test(rawName) ? rawName : `${rawName}.pdf`)
    : 'luma-page.pdf';
  const options = {
    title: '另存为 PDF',
    buttonLabel: '保存',
    defaultPath: path.join(app.getPath('documents'), safeName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    const data = await target.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: true,
    });
    fs.writeFileSync(result.filePath, data);
    return { canceled: false, filePath: result.filePath };
  } catch (error) {
    console.error('[print] printToPDF failed:', error);
    return { canceled: true, failed: true };
  }
});

function captureTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Captures the whole scrollable page through CDP; returns null when unavailable. */
async function captureFullPage(target) {
  const debuggerApi = target.debugger;
  let attachedHere = false;
  try {
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedHere = true;
    }
    const metrics = await debuggerApi.sendCommand('Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize;
    if (!size) return null;
    const width = Math.min(8000, Math.max(1, Math.ceil(size.width)));
    const height = Math.min(12000, Math.max(1, Math.ceil(size.height)));
    // Very long pages are captured at a reduced scale to keep the PNG in memory bounds.
    const scale = Math.min(1, Math.sqrt(30_000_000 / (width * height)));
    const shot = await debuggerApi.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale },
    });
    if (!shot || typeof shot.data !== 'string') return null;
    return Buffer.from(shot.data, 'base64');
  } catch {
    return null;
  } finally {
    if (attachedHere) {
      try {
        debuggerApi.detach();
      } catch {
        // The guest may have navigated away while capturing.
      }
    }
  }
}

function normalizeCaptureRegion(region) {
  if (!region || typeof region !== 'object') return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if (width < 4 || height < 4) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height };
}

/** Captures the guest viewport, retrying while a freshly loaded page settles. */
async function captureViewport(target) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const image = await target.capturePage();
      if (image && !image.isEmpty()) return image;
      lastError = 'empty image';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  console.error('[capture] viewport capture failed:', lastError);
  return null;
}

/** Fallback viewport capture through CDP, used when capturePage fails. */
async function captureViewportViaCdp(target) {
  const debuggerApi = target.debugger;
  let attachedHere = false;
  try {
    if (!debuggerApi.isAttached()) {
      debuggerApi.attach('1.3');
      attachedHere = true;
    }
    const shot = await debuggerApi.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (!shot || typeof shot.data !== 'string') return null;
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  } finally {
    if (attachedHere) {
      try {
        debuggerApi.detach();
      } catch {
        // The guest may have navigated away while capturing.
      }
    }
  }
}

function nativeImageSize(image) {
  const size = image.getSize();
  if (Array.isArray(size)) return { width: Number(size[0]), height: Number(size[1]) };
  return { width: Number(size.width), height: Number(size.height) };
}

/** Crops a viewport screenshot using the selection expressed in CSS pixels. */
function cropToRegion(image, region, viewport) {
  if (!region || !viewport) return image;
  const { width: imageWidth, height: imageHeight } = nativeImageSize(image);
  const viewWidth = Number(viewport.width);
  const viewHeight = Number(viewport.height);
  if (!(viewWidth > 0) || !(viewHeight > 0)) return image;
  const scaleX = imageWidth / viewWidth;
  const scaleY = imageHeight / viewHeight;
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(region.x * scaleX)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(region.y * scaleY)));
  const width = Math.max(1, Math.min(imageWidth - x, Math.round(region.width * scaleX)));
  const height = Math.max(1, Math.min(imageHeight - y, Math.round(region.height * scaleY)));
  try {
    return image.crop({ x, y, width, height });
  } catch {
    return image;
  }
}

ipcMain.handle('page:capture', async (event, targetId, options) => {
  const target = guestContentsFromId(targetId);
  if (!target) return { ok: false, reason: '页面暂不可用，请稍后再试' };
  const mode = options && options.mode === 'copy' ? 'copy' : 'save';
  const fullPage = Boolean(options && options.fullPage);
  const region = normalizeCaptureRegion(options && options.region);
  let image = null;
  let png = fullPage ? await captureFullPage(target) : null;
  if (!png) {
    image = await captureViewport(target) || await captureViewportViaCdp(target);
    if (image && region) image = cropToRegion(image, region, options && options.viewport);
    if (image) png = image.toPNG();
  }
  if (!png) return { ok: false, reason: '无法截取这个页面' };
  const imageSize = image ? nativeImageSize(image) : null;

  if (mode === 'copy') {
    try {
      if (typeof clipboard.writeImage === 'function') {
        clipboard.writeImage(nativeImage.createFromBuffer(png));
      } else if (typeof ClipboardItem === 'function') {
        // Electron 45 uses the W3C-style clipboard: items are written atomically.
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      } else {
        return { ok: false, reason: '当前系统不支持复制图片' };
      }
    } catch {
      return { ok: false, reason: '无法写入剪贴板' };
    }
    return { ok: true, copied: true, size: imageSize ?? undefined };
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const rawName = typeof options?.suggestedName === 'string'
    ? options.suggestedName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80)
    : '';
  const safeName = rawName
    ? (/[.]png$/i.test(rawName) ? rawName : `${rawName}.png`)
    : `Luma-截图-${captureTimestamp()}.png`;
  const dialogOptions = {
    title: '保存网页截图',
    buttonLabel: '保存',
    defaultPath: path.join(app.getPath('pictures'), safeName),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
  if (result.canceled || !result.filePath) return { ok: true, canceled: true };
  try {
    fs.writeFileSync(result.filePath, png);
    return { ok: true, filePath: result.filePath };
  } catch (error) {
    console.error('[capture] write failed:', error);
    return { ok: false, reason: '无法写入截图文件' };
  }
});

/** Fetches a site icon once and keeps it as a data URL for the cache. */
const faviconCache = new Map();

ipcMain.handle('favicon:fetch', async (_event, iconUrl) => {
  const raw = typeof iconUrl === 'string' ? iconUrl.trim() : '';
  if (!/^https?:\/\//i.test(raw) || raw.length > 2048) return null;
  if (faviconCache.has(raw)) return faviconCache.get(raw);
  try {
    const ses = session.fromPartition(APP_PARTITION);
    const response = await ses.fetch(raw, {
      signal: AbortSignal.timeout(7000),
      headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
    });
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 256 * 1024) return null;
    const mime = contentType.startsWith('image/')
      ? contentType
      : /\.svgz?($|\?)/i.test(raw) ? 'image/svg+xml' : 'image/x-icon';
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    if (faviconCache.size > 300) faviconCache.clear();
    faviconCache.set(raw, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
});

ipcMain.handle('browser:open-devtools', (event, targetId, bounds) => {
  if (!Number.isInteger(targetId)) return false;
  const target = webContents.fromId(targetId);
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed() || !isPageContents(target)) return false;
  if (!win || win.isDestroyed()) return false;
  let entry = devtoolsViews.get(targetId);
  if (!entry) {
    const partition = target.session === incognitoSession ? INCOGNITO_PARTITION : APP_PARTITION;
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, partition },
    });
    view.setBackgroundColor('#ffffff');
    win.contentView.addChildView(view);
    entry = { view, window: win };
    devtoolsViews.set(targetId, entry);
    devtoolsHostContents.set(view.webContents.id, { window: win, targetId });
    // DevTools renders into this native view; docked mode is not supported for webview guests.
    target.setDevToolsWebContents(view.webContents);
  }
  const normalized = normalizeDevtoolsBounds(bounds);
  if (normalized) entry.view.setBounds(normalized);
  entry.view.setVisible(true);
  if (!target.isDevToolsOpened()) target.openDevTools({ mode: 'detach' });
  return true;
});
ipcMain.handle('browser:resize-devtools', (_event, targetId, bounds) => {
  if (!Number.isInteger(targetId)) return false;
  const entry = devtoolsViews.get(targetId);
  const normalized = normalizeDevtoolsBounds(bounds);
  if (!entry || !normalized) return false;
  entry.view.setBounds(normalized);
  return true;
});
ipcMain.handle('browser:set-devtools-visible', (_event, targetId, visible) => {
  if (!Number.isInteger(targetId)) return false;
  const entry = devtoolsViews.get(targetId);
  if (!entry) return false;
  entry.view.setVisible(Boolean(visible));
  return true;
});
ipcMain.handle('browser:close-devtools', (_event, targetId) => {
  if (!Number.isInteger(targetId)) return false;
  destroyDevtoolsView(targetId);
  return true;
});
ipcMain.handle('permissions:overview', () => permissionOverview());
ipcMain.handle('permissions:set-default', (_event, category, policy) => {
  if (!PERMISSION_CATEGORIES.includes(category)) return null;
  const normalized = normalizePermissionPolicy(policy);
  if (!normalized) return null;
  const state = loadPermissionState();
  state.defaults[category] = normalized;
  savePermissionState();
  return permissionOverview();
});
ipcMain.handle('permissions:set-site', (_event, origin, category, policy) => {
  if (!safeOrigin(origin) || !PERMISSION_CATEGORIES.includes(category)) return null;
  const state = loadPermissionState();
  if (policy === null) {
    const rules = state.sites[origin];
    if (rules) {
      delete rules[category];
      if (Object.keys(rules).length === 0) delete state.sites[origin];
    }
  } else {
    const normalized = normalizePermissionPolicy(policy);
    if (!normalized) return null;
    state.sites[origin] = { ...(state.sites[origin] ?? {}), [category]: normalized };
  }
  savePermissionState();
  return permissionOverview();
});
ipcMain.handle('permissions:remove-site', (_event, origin) => {
  if (!safeOrigin(origin)) return null;
  const state = loadPermissionState();
  delete state.sites[origin];
  savePermissionState();
  return permissionOverview();
});
ipcMain.handle('permissions:clear-sites', () => {
  const state = loadPermissionState();
  state.sites = {};
  savePermissionState();
  return permissionOverview();
});
ipcMain.handle('permissions:respond', (_event, requestId, decision) => {
  if (!Number.isInteger(requestId)) return false;
  const pending = pendingPermissionRequests.get(requestId);
  if (!pending) return false;
  pendingPermissionRequests.delete(requestId);
  clearTimeout(pending.timer);
  const allowed = decision === 'allow' || decision === 'always';
  if (decision === 'always') {
    const state = loadPermissionState();
    const rules = { ...(state.sites[pending.origin] ?? {}) };
    for (const category of pending.categories) rules[category] = 'allow';
    state.sites[pending.origin] = rules;
    savePermissionState();
  }
  pending.callback(allowed);
  return true;
});
ipcMain.handle('clipboard:write', (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text.slice(0, 100_000));
});
ipcMain.handle('clipboard:read', async () => {
  // Electron's clipboard getters resolve asynchronously in recent versions.
  const text = await clipboard.readText();
  return typeof text === 'string' ? text.slice(0, 100_000) : '';
});
/**
 * Site data can only be deleted on purpose, but "on purpose" is one click away
 * and costs every login the profile holds. Before a profile-wide wipe the
 * cookie store is copied aside, and every wipe leaves a line in the update log,
 * so a lost sign-in can be traced instead of guessed at.
 */
const COOKIE_BACKUP_KEEP = 5;

function cookieStorePath() {
  return path.join(app.getPath('userData'), 'Partitions', 'luma-browser', 'Network', 'Cookies');
}

function pruneCookieBackups(directory) {
  try {
    const files = fs.readdirSync(directory)
      .filter((name) => name.startsWith('cookies-') && name.endsWith('.db'))
      .sort()
      .reverse();
    for (const name of files.slice(COOKIE_BACKUP_KEEP)) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  } catch {
    // Pruning is housekeeping; a full directory must not block the wipe.
  }
}

function backupCookieStore(reason) {
  const source = cookieStorePath();
  if (!fs.existsSync(source)) return null;
  try {
    const directory = path.join(app.getPath('userData'), 'profile-backups');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const target = path.join(directory, `cookies-${stamp}-${reason}.db`);
    fs.copyFileSync(source, target);
    pruneCookieBackups(directory);
    return target;
  } catch {
    return null;
  }
}

/** One line per notable app event, in the file the updater already writes. */
function appendAppLog(entry) {
  try {
    fs.appendFileSync(appPaths.log, `${new Date().toISOString()} ${entry}\n`, 'utf8');
  } catch {
    // The log lives next to the installers; a read-only install has no log.
  }
}

function logPrivacyAction(message) {
  appendAppLog(`[privacy] ${message}`);
}

ipcMain.handle('browser:clear-site-data', async () => {
  if (!browserSession) return false;
  await browserSession.cookies.flushStore().catch(() => undefined);
  backupCookieStore('clear-site-data');
  logPrivacyAction('cleared all site data (cookies, storage, cache)');
  await browserSession.clearStorageData();
  await browserSession.clearCache();
  return true;
});
ipcMain.handle('browser:site-data-overview', async () => {
  if (!browserSession) return { cacheBytes: 0, cookieCount: 0, sites: [] };
  const [cookies, cacheBytes] = await Promise.all([
    browserSession.cookies.get({}),
    browserSession.getCacheSize(),
  ]);
  const sites = new Map();
  for (const cookie of cookies) {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!domain) continue;
    const entry = sites.get(domain) || { domain, cookieCount: 0, secure: true };
    entry.cookieCount += 1;
    entry.secure = entry.secure && Boolean(cookie.secure);
    sites.set(domain, entry);
  }
  return {
    cacheBytes: Number(cacheBytes) || 0,
    cookieCount: cookies.length,
    sites: [...sites.values()].sort((left, right) => right.cookieCount - left.cookieCount),
  };
});
ipcMain.handle('browser:clear-site-data-for-domain', async (_event, domain) => {
  if (!browserSession || typeof domain !== 'string') return false;
  const cleanDomain = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(cleanDomain) || cleanDomain.length > 253) return false;
  try {
    const cookies = (await browserSession.cookies.get({})).filter(
      (cookie) => String(cookie.domain || '').replace(/^\./, '').toLowerCase() === cleanDomain,
    );
    await Promise.all(cookies.map((cookie) => {
      const protocol = cookie.secure ? 'https' : 'http';
      const host = String(cookie.domain || cleanDomain).replace(/^\./, '');
      return browserSession.cookies
        .remove(`${protocol}://${host}${cookie.path || '/'}`, cookie.name)
        .catch(() => undefined);
    }));
    for (const origin of [`https://${cleanDomain}`, `http://${cleanDomain}`]) {
      await browserSession.clearStorageData({ origin }).catch(() => undefined);
    }
    logPrivacyAction(`cleared site data for ${cleanDomain}`);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('browser:clear-cache', async () => {
  if (!browserSession) return false;
  await browserSession.clearCache();
  return true;
});
ipcMain.handle('browser:clear-cookies', async () => {
  if (!browserSession) return false;
  await browserSession.cookies.flushStore().catch(() => undefined);
  backupCookieStore('clear-cookies');
  logPrivacyAction('cleared all cookies');
  await browserSession.clearStorageData({ storages: ['cookies'] });
  return true;
});
ipcMain.handle('downloads:list', () => downloadSnapshot());
ipcMain.handle('downloads:cancel', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry || entry.record.state !== 'progressing') return false;
  if (entry.custom) {
    cancelCustomDownload(entry);
    return true;
  }
  entry.item.cancel();
  return true;
});
ipcMain.handle('downloads:pause', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry || entry.record.state !== 'progressing') return false;
  if (entry.custom) {
    if (entry.record.paused) return false;
    pauseCustomDownload(entry);
    return true;
  }
  if (entry.item.isPaused()) return false;
  entry.item.pause();
  return true;
});
ipcMain.handle('downloads:resume', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry || entry.record.state !== 'progressing') return false;
  if (entry.custom) {
    if (!entry.record.paused) return false;
    return startResumableDownload(entry);
  }
  if (!entry.item.isPaused()) return false;
  entry.item.resume();
  return true;
});
ipcMain.handle('downloads:resume-interrupted', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry || entry.record.state !== 'interrupted') return false;
  if (!entry.record.savePath || !isSafeHttpUrl(entry.record.url)) return false;
  return startResumableDownload(entry);
});
ipcMain.handle('downloads:remove', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry) return false;
  if (entry.record.state === 'progressing') {
    if (entry.custom) cancelCustomDownload(entry);
    else entry.item.cancel();
  }
  downloads.delete(id);
  broadcastDownloads();
  schedulePersistDownloads();
  return true;
});
ipcMain.handle('downloads:clear', () => {
  for (const [id, entry] of downloads) {
    if (entry.record.state !== 'progressing') downloads.delete(id);
  }
  broadcastDownloads();
  schedulePersistDownloads();
  return true;
});
ipcMain.handle('downloads:delete-file', async (event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry || entry.record.state === 'progressing') return false;
  const savePath = entry.record.savePath;
  if (!savePath || !path.isAbsolute(savePath)) return false;
  const win = BrowserWindow.fromWebContents(event.sender);
  const message = `确定要删除本地文件「${entry.record.filename}」吗？此操作无法撤销。`;
  const options = {
    type: 'warning',
    buttons: ['取消', '删除文件'],
    defaultId: 0,
    cancelId: 0,
    message: '删除已下载的文件',
    detail: message,
    noLink: true,
  };
  const confirmation = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  if (confirmation.response !== 1) return false;
  try {
    if (fs.existsSync(savePath)) fs.rmSync(savePath, { force: true });
  } catch {
    return false;
  }
  fileIcons.forgetFileIcon(savePath);
  downloads.delete(id);
  broadcastDownloads();
  schedulePersistDownloads();
  return true;
});
ipcMain.handle('downloads:open', async (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry?.record.savePath || entry.record.state !== 'completed') return false;
  const error = await shell.openPath(entry.record.savePath);
  return !error;
});
ipcMain.handle('downloads:show-in-folder', (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  if (!entry?.record.savePath) return false;
  shell.showItemInFolder(entry.record.savePath);
  return true;
});
// The renderer only passes an id, so a page cannot ask us to read arbitrary
// paths off disk; a download still in flight has no complete file to describe.
ipcMain.handle('downloads:icon', async (_event, id) => {
  const entry = typeof id === 'string' ? downloads.get(id) : undefined;
  const savePath = entry?.record.savePath;
  if (!savePath || entry.record.state === 'progressing') return null;
  if (!path.isAbsolute(savePath)) return null;
  return fileIcons.fileIconFor(savePath);
});
ipcMain.handle('downloads:get-directory', () => downloadDirectoryInfo());
ipcMain.handle('downloads:choose-directory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: '选择下载文件夹',
    buttonLabel: '选择文件夹',
    defaultPath: downloadDirectoryInfo().directory,
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return downloadDirectoryInfo();
  const directory = path.normalize(result.filePaths[0]);
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return downloadDirectoryInfo();
  }
  writeDownloadDirectory(directory);
  return { directory, isDefault: false };
});
ipcMain.handle('downloads:reset-directory', () => {
  writeDownloadDirectory(null);
  return downloadDirectoryInfo();
});
ipcMain.handle('downloads:save-url', (_event, webContentsId, url) => {
  if (!Number.isInteger(webContentsId) || typeof url !== 'string') return false;
  const contents = webContents.fromId(webContentsId);
  if (!contents || !isPageContents(contents)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && !(parsed.protocol === 'data:' && url.startsWith('data:image/'))) {
    return false;
  }
  contents.downloadURL(url);
  return true;
});

ipcMain.handle('bookmarks:import-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: '导入书签',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [
      { name: '书签 HTML', extensions: ['html', 'htm'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    const content = fs.readFileSync(result.filePaths[0], 'utf8').slice(0, 20_000_000);
    return { canceled: false, filePath: result.filePaths[0], content };
  } catch {
    return { canceled: true, failed: true };
  }
});
ipcMain.handle('bookmarks:export-file', async (event, content, suggestedName) => {
  if (typeof content !== 'string' || !content.trim()) return { canceled: true };
  const safeName = typeof suggestedName === 'string' && /^[\w\-. ]+\.html?$/i.test(suggestedName)
    ? suggestedName
    : 'luma-bookmarks.html';
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: '导出书签',
    buttonLabel: '导出',
    defaultPath: path.join(app.getPath('documents'), safeName),
    filters: [{ name: '书签 HTML', extensions: ['html', 'htm'] }],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { canceled: false, filePath: result.filePath };
  } catch {
    return { canceled: true, failed: true };
  }
});

ipcMain.handle('shell:open-external', (_event, url) => {
  if (isSafeHttpUrl(url)) return shell.openExternal(url);
  return false;
});

// Cookies are held in memory and only written out when the network service
// shuts down cleanly. An update closes the app from the outside (the NSIS
// installer waits for the process), so a session that ended with a sign-in
// could be lost and every site asked for its password again. Flushing first,
// with a hard timeout so a stuck profile can never block quitting.
let cookiesFlushed = false;
app.on('before-quit', (event) => {
  if (cookiesFlushed || !browserSession) return;
  cookiesFlushed = true;
  event.preventDefault();
  let finished = false;
  let timer;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    app.quit();
  };
  timer = setTimeout(finish, 1500);
  Promise.allSettled([
    browserSession.cookies.flushStore(),
    browserSession.flushStorageData(),
    incognitoSession ? incognitoSession.cookies.flushStore() : Promise.resolve(),
  ]).then(finish, finish);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (adblockUpdateTimer) clearInterval(adblockUpdateTimer);
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (memoryPressureTimer) clearInterval(memoryPressureTimer);
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer);
  // Deferred update, the same trade-off Sogou's QBDelayUpdate makes: a package
  // that finished downloading is installed once the last window is gone, so no
  // file in the program directory is still locked by a running process.
  extensionPopupWindow ? closeExtensionPopup() : undefined;
  updateManager?.installOnQuit();
  persistDownloadsNow();
  if (downloadPowerBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(downloadPowerBlockerId)) powerSaveBlocker.stop(downloadPowerBlockerId);
    } catch {
      // Already released.
    }
    downloadPowerBlockerId = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
