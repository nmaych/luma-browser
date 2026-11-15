const { app, BrowserWindow, clipboard, ClipboardItem, crashReporter, dialog, globalShortcut, ipcMain, nativeImage, net, screen, session, shell, WebContentsView, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { shouldBlock, hostnameOf, AdblockManager, ruleCount: legacyAdblockRuleCount } = require('./adblock.cjs');
const passwordVault = require('./passwords.cjs');
const { createPageViewManager } = require('./pageViews.cjs');
const { createUpdater } = require('./updater.cjs');

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
};

const DEFAULT_APP_SETTINGS = {
  adblock: { enabled: true, disabledSites: [] },
  bossKey: 'Ctrl+Shift+L',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  blockedTotal: 0,
};

// A second process sharing the same userData would race on passwords.json,
// settings and download records. Keep exactly one instance per profile.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
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
/** @type {string | null} */
let registeredBossKey = null;
/** @type {NodeJS.Timeout | null} */
let persistDownloadsTimer = null;
/** @type {Map<string, any>} */
const pendingInitialTabs = new Map();
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
  const next = {
    ...DEFAULT_APP_SETTINGS,
    adblock: { ...DEFAULT_APP_SETTINGS.adblock, disabledSites: [] },
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
  try {
    const parsed = JSON.parse(fs.readFileSync(appSettingsPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      if (parsed.adblock && typeof parsed.adblock === 'object') {
        next.adblock.enabled = parsed.adblock.enabled !== false;
        if (Array.isArray(parsed.adblock.disabledSites)) {
          next.adblock.disabledSites = parsed.adblock.disabledSites.filter(
            (site) => typeof site === 'string' && /^[a-z0-9.-]{1,253}$/i.test(site),
          );
        }
      }
      if (typeof parsed.bossKey === 'string' && parsed.bossKey.length <= 64) next.bossKey = parsed.bossKey;
      if (parsed.shortcuts && typeof parsed.shortcuts === 'object') {
        for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
          const value = parsed.shortcuts[action];
          if (typeof value === 'string' && value.length <= 64) next.shortcuts[action] = value;
        }
      }
      next.blockedTotal = Number.isFinite(parsed.blockedTotal) ? Math.max(0, Math.floor(parsed.blockedTotal)) : 0;
    }
  } catch {
    // First run: defaults apply.
  }
  appSettings = next;
  return next;
}

let saveSettingsTimer = null;
function saveAppSettings() {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    try {
      fs.writeFileSync(appSettingsPath(), JSON.stringify(appSettings, null, 2), 'utf8');
    } catch {
      // A read-only profile keeps settings in memory for this session.
    }
  }, 200);
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
  if (!siteHost || appSettings.adblock.disabledSites.includes(siteHost)) return;
  const payload = adblockManager.cosmetics(url);
  if (!payload?.styles) return;
  contents.insertCSS(payload.styles)
    .then((key) => {
      if (contents.isDestroyed()) return;
      cosmeticCssKeys.set(contents.id, key);
    })
    .catch(() => undefined);
}

function applyCosmeticFiltersToAll() {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.getType() === 'webview') applyCosmeticFilters(contents);
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
      if (!siteHost || appSettings.adblock.disabledSites.includes(siteHost)) return callback({ cancel: false });
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

function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null;
  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  const parsed = { key: key.toLowerCase(), control: false, shift: false, alt: false, meta: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') parsed.control = true;
    else if (lower === 'shift') parsed.shift = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (['meta', 'cmd', 'command', 'super', 'win'].includes(lower)) parsed.meta = true;
    else return null;
  }
  return parsed;
}

function normalizeInputKey(key) {
  const value = String(key || '').toLowerCase();
  if (value === ' ' || value === 'spacebar' || value === 'space') return 'space';
  return value;
}

function matchAccelerator(input, accelerator) {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  if (normalizeInputKey(input.key) !== parsed.key) return false;
  return Boolean(input.control) === parsed.control
    && Boolean(input.meta) === parsed.meta
    && Boolean(input.shift) === parsed.shift
    && Boolean(input.alt) === parsed.alt;
}

function shortcutActionForInput(input) {
  for (const [action, accelerator] of Object.entries(appSettings.shortcuts || {})) {
    if (matchAccelerator(input, accelerator)) return action;
  }
  // F5 keeps working as a reload alias even though bindings are customizable.
  if (normalizeInputKey(input.key) === 'f5' && !input.control && !input.alt && !input.meta && !input.shift) {
    return 'reload';
  }
  return null;
}

function toggleBossMode() {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) return;
  const visible = windows.filter((win) => win.isVisible() && !win.isMinimized());
  if (visible.length > 0) {
    for (const win of windows) win.hide();
    return;
  }
  for (const win of windows) {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  windows[windows.length - 1].focus();
}

function registerBossKey(accelerator) {
  if (registeredBossKey) {
    try {
      globalShortcut.unregister(registeredBossKey);
    } catch {
      // The accelerator may already be released.
    }
    registeredBossKey = null;
  }
  if (typeof accelerator !== 'string' || !accelerator.trim()) return false;
  try {
    const registered = globalShortcut.register(accelerator, toggleBossMode);
    if (registered) registeredBossKey = accelerator;
    return registered;
  } catch {
    return false;
  }
}

const TRANSLATION_TARGETS = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru']);

async function fetchJson(url, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Luma/1.0',
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

let googleTranslationBlockedUntil = 0;

async function translateChunk(text, target) {
  if (Date.now() < googleTranslationBlockedUntil) throw new Error('google unavailable');
  const endpoint = 'https://translate.googleapis.com/translate_a/single'
    + `?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson(endpoint, 5_000).catch((error) => {
    // Remember the outage briefly so later chunks go straight to the fallback.
    googleTranslationBlockedUntil = Date.now() + 10 * 60_000;
    throw error;
  });
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const translated = segments
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('');
  if (!translated.trim()) throw new Error('empty translation');
  return translated;
}

/** Rough script-based source detection for the MyMemory fallback. */
function detectSourceLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  return 'en';
}

function splitForTranslation(text, limit = 450) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const index = cut > limit * 0.4 ? cut + 1 : limit;
    parts.push(rest.slice(0, index));
    rest = rest.slice(index);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * MyMemory is used when the Google endpoint is unreachable (for example on
 * mainland networks). It has no auto-detect, so the source script is guessed.
 */
function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

async function translateWithMyMemory(text, target) {
  const source = detectSourceLanguage(text);
  if (source === target) return text;
  const pieces = splitForTranslation(text);
  const results = [];
  for (const piece of pieces) {
    const endpoint = 'https://api.mymemory.translated.net/get'
      + `?q=${encodeURIComponent(piece)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const data = await fetchJson(endpoint, 15_000);
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== 'string' || !translated.trim()) throw new Error('empty translation');
    if (/INVALID SOURCE LANGUAGE|QUERY LENGTH LIMIT|MYMEMORY WARNING/i.test(translated)) {
      throw new Error('translation rejected');
    }
    results.push(decodeHtmlEntities(translated));
  }
  return results.join(' ');
}

async function translateTexts(texts, target) {
  const cleanTarget = TRANSLATION_TARGETS.has(target) ? target : 'zh-CN';
  const cleanTexts = texts
    .filter((text) => typeof text === 'string' && text.trim())
    .map((text) => text.slice(0, 4000))
    .slice(0, 80);
  if (cleanTexts.length === 0) return { ok: true, translations: [] };

  const chunks = [];
  let current = [];
  let currentLength = 0;
  for (const text of cleanTexts) {
    if (current.length > 0 && (current.length >= 6 || currentLength + text.length > 1400)) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(text);
    currentLength += text.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  const translations = [];
  let lastError = '';
  for (const chunk of chunks) {
    let translatedLines = null;
    try {
      const result = await translateChunk(chunk.join('\n'), cleanTarget);
      const lines = result.split('\n');
      if (lines.length === chunk.length) translatedLines = lines;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (translatedLines) {
      translations.push(...translatedLines);
      continue;
    }
    // Primary endpoint unavailable: fall back in parallel so long pages finish quickly.
    const fallback = await Promise.all(chunk.map(async (text) => {
      try {
        return await translateWithMyMemory(text, cleanTarget);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return text;
      }
    }));
    translations.push(...fallback);
  }
  const source = detectSourceLanguage(cleanTexts.join(' '));
  const succeeded = translations.some((text, index) => text !== cleanTexts[index]);
  if (!succeeded) {
    return {
      ok: false,
      error: source === cleanTarget ? 'same-language' : (lastError || 'translation unavailable'),
      translations: [],
    };
  }
  return { ok: true, translations };
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const bounds = parsed.bounds;
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y)
    ) {
      return null;
    }
    return { bounds, maximized: parsed.maximized === true };
  } catch {
    return null;
  }
}

/** Accepts {screenX,screenY} or {x,y} and returns both spellings. */
function normalizeScreenPoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.screenX ?? value.x);
  const y = Number(value.screenY ?? value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, screenX: x, screenY: y };
}

function normalizeExternalBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    x,
    y,
    width: Math.max(380, Math.min(4000, width)),
    height: Math.max(500, Math.min(4000, height)),
  };
}

function normalizeWindowBounds(bounds) {
  if (!bounds) return null;
  const width = Math.max(DEFAULT_WINDOW_BOUNDS.minWidth, Math.round(bounds.width));
  const height = Math.max(DEFAULT_WINDOW_BOUNDS.minHeight, Math.round(bounds.height));
  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x < area.x + area.width - 80 &&
      x + width > area.x + 80 &&
      y < area.y + area.height - 40 &&
      y + height > area.y + 40
    );
  });
  return visible ? { x, y, width, height } : null;
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds();
    const maximized = mainWindow.isMaximized();
    fs.writeFileSync(windowStatePath(), JSON.stringify({ bounds, maximized }), 'utf8');
  } catch {
    // A read-only profile must not break window controls.
  }
}

function scheduleSaveWindowState() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveWindowState, 250);
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
  const savedState = incognito || isSecondaryWindow ? null : readWindowState();
  const savedBounds = incognito || isSecondaryWindow ? null : normalizeWindowBounds(savedState?.bounds);
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
    if (mainWindow === win) mainWindow = null;
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

function broadcastDownloads() {
  const snapshot = downloadSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('downloads:changed', snapshot);
  }
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
  return path.join(path.dirname(app.getPath('exe')), 'LumaDownload');
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
    .slice(0, 120);
  try {
    fs.writeFileSync(downloadsStorePath(), JSON.stringify(records, null, 2), 'utf8');
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
  // Chromium preallocates the destination file, so the on-disk size can equal
  // the total size while only part of the payload has arrived. The record's
  // receivedBytes is the authoritative resume offset; trim the sparse tail.
  let start = record.receivedBytes > 0 ? record.receivedBytes : fileSize;
  if (fileSize > 0 && start > fileSize) start = fileSize;
  if (fileSize > start) {
    try {
      fs.truncateSync(record.savePath, start);
    } catch {
      // A locked file still resumes from the recorded offset.
    }
  }
  if (record.totalBytes > 0 && start > 0 && start >= record.totalBytes) {
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
  entry.record = {
    ...record,
    state: 'progressing',
    paused: false,
    speed: 0,
    receivedBytes: start,
    resumable: true,
  };

  request.on('response', (response) => {
    if (entry.request !== request) return;
    const status = response.statusCode;
    let stream = null;
    if (status === 200) {
      start = 0;
      entry.record = { ...entry.record, receivedBytes: 0 };
      stream = fs.createWriteStream(record.savePath);
    } else if (status === 206) {
      stream = fs.createWriteStream(record.savePath, { flags: 'a' });
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
      const speed = Math.max(0, Math.round((received - entry.sample.bytes) / elapsed));
      entry.sample = { bytes: received, time: now };
      entry.record = { ...entry.record, receivedBytes: received, speed };
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
        broadcastDownloads();
      }
    });
    response.on('end', () => {
      if (entry.request !== request) return;
      stream.end(() => {
        if (entry.request !== request) return;
        settleCustomDownload(entry, 'completed');
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
    const record = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      savePath: item.getSavePath() || '',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      speed: 0,
      startedAt: Date.now(),
      incognito,
      paused: false,
      resumable: item.canResume(),
    };
    downloads.set(id, { record, item, sample: { bytes: 0, time: Date.now() } });

    const update = () => {
      const entry = downloads.get(id);
      if (!entry) return;
      const state = item.getState();
      const receivedBytes = item.getReceivedBytes();
      const now = Date.now();
      const elapsed = Math.max(0.001, (now - entry.sample.time) / 1000);
      const speed = state === 'progressing'
        ? Math.max(0, Math.round((receivedBytes - entry.sample.bytes) / elapsed))
        : 0;
      entry.sample = { bytes: receivedBytes, time: now };
      entry.record = {
        ...entry.record,
        savePath: item.getSavePath() || entry.record.savePath,
        receivedBytes,
        totalBytes: item.getTotalBytes(),
        speed,
        paused: item.isPaused(),
        resumable: item.canResume(),
        state: state === 'progressing' ? 'progressing' : state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted',
      };
      broadcastDownloads();
      schedulePersistDownloads();
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  downloadsWindow.setMenuBarVisibility(false);
  downloadsWindow.on('closed', () => {
    downloadsWindow = null;
  });
  if (isDevelopment) {
    void downloadsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}/?downloads=1`);
  } else {
    void downloadsWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query: { downloads: '1' } });
  }
  return downloadsWindow;
}

function attachPageFeatures(contents, { native = false } = {}) {
  if (!contents || contents.isDestroyed()) return;
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
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeHttpUrl(url) || (isFileUrl(url) && isFileUrl(contents.getURL()))) {
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
  contents.on('dom-ready', () => applyCosmeticFilters(contents));
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
    const action = shortcutActionForInput(input);
    if (!action) return;
    event.preventDefault();
    hostContentsOf(contents)?.send('browser:shortcut', action);
  });
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
  });
  if (!isDevelopment) {
    // Checking after the first paint keeps startup fast and offline-safe.
    startupUpdateTimer = setTimeout(() => {
      void updateManager?.check({ autoDownload: true });
    }, 8_000);
  }
  adblockManager = new AdblockManager({
    userDataDir: app.getPath('userData'),
    fetchImpl: (url, init) => net.fetch(url, init),
    onUpdate: () => applyCosmeticFiltersToAll(),
  });
  browserSession = session.fromPartition(APP_PARTITION);
  incognitoSession = session.fromPartition(INCOGNITO_PARTITION);
  for (const targetSession of [browserSession, incognitoSession]) {
    // Remove Electron's product token so standards-compliant sites receive a normal Chrome UA.
    targetSession.setUserAgent(
      targetSession.getUserAgent().replace(/\sElectron\/[\d.]+/i, '').replace(/Luma Browser\/[\d.]+/i, ''),
    );
    // Luma asks before granting camera, microphone, geolocation or notification access.
    targetSession.setPermissionRequestHandler(handlePermissionRequest);
    targetSession.setPermissionCheckHandler(handlePermissionCheck);
    attachDownloadHandling(targetSession, targetSession === incognitoSession);
    attachAdBlocking(targetSession);
  }
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
      const devtoolsHost = devtoolsHostContents.get(contents.id);
      const manager = hostContentsOf(contents) ?? devtoolsHost?.window.webContents ?? contents;
      const hostWindow = BrowserWindow.fromWebContents(manager);
      if (input.key === 'F11') {
        event.preventDefault();
        hostWindow?.setFullScreen(!hostWindow.isFullScreen());
      } else if (input.key === 'Escape' && hostWindow?.isFullScreen()) {
        event.preventDefault();
        hostWindow.setFullScreen(false);
      }
    });

    if (contents.getType() !== 'webview') return;
    attachPageFeatures(contents, { native: false });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.on('window:toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
    if (win === mainWindow) {
      const restored = normalizeWindowBounds(readWindowState()?.bounds);
      if (restored) win.setBounds(restored);
    }
  } else {
    win.maximize();
  }
});
ipcMain.handle('window:cursor-point', () => screen.getCursorScreenPoint());
ipcMain.handle('window:id', (event) => BrowserWindow.fromWebContents(event.sender)?.id ?? 0);
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
  // The pointer stays over the tab it grabbed, exactly like a real window would.
  // Offsets are measured against the content area, so a window border can never
  // shift the page under the cursor.
  const offsetX = Math.max(0, Math.min(pageWidth - 24, Math.round(cursor.x - sourceContent.x)));
  const offsetY = Math.max(0, Math.min(TAB_BAR_HEIGHT - 1, Math.round(cursor.y - sourceContent.y)));
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
  if (!payload || typeof payload !== 'object') return { bossKeyRegistered: Boolean(registeredBossKey) };
  if (typeof payload.bossKey === 'string' && payload.bossKey.length <= 64) {
    appSettings.bossKey = payload.bossKey;
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
  const registered = appSettings.bossKey !== registeredBossKey
    ? registerBossKey(appSettings.bossKey)
    : Boolean(registeredBossKey);
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
  const cleanHost = host.toLowerCase();
  const sites = new Set(appSettings.adblock.disabledSites);
  if (disabled) sites.add(cleanHost);
  else sites.delete(cleanHost);
  appSettings.adblock.disabledSites = [...sites];
  saveAppSettings();
  return adblockOverview();
});

ipcMain.handle('page:translate', (_event, texts, target) => {
  if (!Array.isArray(texts)) return { ok: false, error: 'invalid-texts', translations: [] };
  return translateTexts(texts, typeof target === 'string' ? target : 'zh-CN');
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

function broadcastUpdateState(snapshot) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updates:state', snapshot);
  }
}

ipcMain.handle('updates:state', () => updateManager?.getState() ?? null);
ipcMain.handle('updates:check', () => {
  // The download can take minutes; report the state immediately and let
  // progress arrive through 'updates:state'.
  void updateManager?.check({ autoDownload: true })?.catch(() => undefined);
  return updateManager?.getState() ?? null;
});
ipcMain.handle('updates:download', () => updateManager?.download() ?? null);
ipcMain.handle('updates:install', () => updateManager?.install() ?? false);

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
ipcMain.handle('window:toggle-fullscreen', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
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
ipcMain.handle('browser:clear-site-data', async () => {
  if (!browserSession) return false;
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (adblockUpdateTimer) clearInterval(adblockUpdateTimer);
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer);
  persistDownloadsNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
