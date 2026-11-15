import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkPlus,
  Camera,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Minus,
  Moon,
  MousePointer2,
  Plus,
  Printer,
  RefreshCw,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  TextCursorInput,
  Type,
  X,
} from 'lucide-react';
import { BookmarksBar } from '../components/browser/BookmarksBar';
import { ContextMenu, type ContextMenuEntry } from '../components/common/ContextMenu';
import { Modal } from '../components/common/Modal';
import { PageHostLayer } from '../components/browser/PageHostLayer';
import type { PageHandle } from './pageHandle';
import { EmbeddedDevTools } from '../components/browser/EmbeddedDevTools';
import { FindBar } from '../components/browser/FindBar';
import { MobileNavigation } from '../components/browser/MobileNavigation';
import { NavigationBar } from '../components/browser/NavigationBar';
import { TabOverview } from '../components/browser/TabOverview';
import { TabStrip } from '../components/browser/TabStrip';
import { AddBookmarkDialog } from '../components/panels/AddBookmarkDialog';
import { SidePanel } from '../components/panels/SidePanel';
import { ToastStack } from '../components/panels/ToastStack';
import { BookmarksPage } from '../pages/BookmarksPage';
import { ErrorPage } from '../pages/ErrorPage';
import { ExternalPage } from '../pages/ExternalPage';
import { HistoryPage } from '../pages/HistoryPage';
import { HomePage } from '../pages/HomePage';
import { NewTabPage } from '../pages/NewTabPage';
import { SettingsPage } from '../pages/SettingsPage';
import type { BrowserError, BrowserTab, PermissionPromptRequest, TabEntry } from '../types';
import { parseBookmarksHtml, serializeBookmarksHtml } from '../utils/bookmarkFile';
import {
  READER_EXTRACT_SCRIPT,
  TRANSLATION_EXTRACT_SCRIPT,
  TRANSLATION_RESTORE_SCRIPT,
  buildTranslationApplyScript,
  sanitizeReaderHtml,
  type ReaderArticle,
  type ReaderExtractionResult,
} from '../utils/reader';
import { matchShortcutEvent } from '../utils/shortcuts';
import { readStorage, writeStorage } from '../utils/storage';
import { INTERNAL_ROUTES, getHost, getInternalPage, isExternalUrl } from '../utils/url';
import { useBrowser } from './useBrowser';

interface NativeNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

interface PageContextState extends PageContextMenuInfo {
  tabId: string;
  menuX: number;
  menuY: number;
}

const PERMISSION_LABELS: Record<string, string> = {
  camera: '摄像头',
  microphone: '麦克风',
  notifications: '通知',
  geolocation: '位置信息',
  clipboard: '剪贴板读取',
  fullscreen: '全屏',
  pointerLock: '指针锁定',
};

function toInitialTab(tab: BrowserTab): LumaInitialTab {
  const entry = tab.entries[tab.historyIndex];
  return {
    id: tab.id,
    title: entry.title,
    entries: tab.entries,
    historyIndex: tab.historyIndex,
    viewUrl: tab.viewUrl,
    favicon: tab.favicon,
  };
}

type ReaderFontFamily = 'serif' | 'sans' | 'kai';

const READER_FONTS: { id: ReaderFontFamily; label: string; stack: string }[] = [
  { id: 'serif', label: '书刊宋体', stack: '"Songti SC", "SimSun", Georgia, serif' },
  { id: 'sans', label: '现代黑体', stack: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif' },
  { id: 'kai', label: '温润楷体', stack: '"Kaiti SC", "KaiTi", "STKaiti", serif' },
];

const READER_PREF_KEY = 'luma.reader-appearance.v1';

function loadReaderAppearance(): {
  fontSize: number;
  lineHeight: number;
  fontFamily: ReaderFontFamily;
  theme: 'light' | 'sepia' | 'dark';
} {
  const saved = readStorage<Partial<{
    fontSize: number;
    lineHeight: number;
    fontFamily: ReaderFontFamily;
    theme: 'light' | 'sepia' | 'dark';
  }>>(READER_PREF_KEY, {});
  return {
    fontSize: Math.min(32, Math.max(14, Number(saved.fontSize) || 18)),
    lineHeight: Math.min(2.4, Math.max(1.4, Number(saved.lineHeight) || 1.85)),
    fontFamily: READER_FONTS.some((font) => font.id === saved.fontFamily) ? saved.fontFamily! : 'serif',
    theme: ['light', 'sepia', 'dark'].includes(saved.theme ?? '') ? saved.theme! : 'light',
  };
}

function createNetworkError(errorCode: number, description: string): BrowserError {
  if (errorCode === -106 || errorCode === -105) {
    return {
      type: 'offline',
      title: '无法连接到网络',
      message: '请检查网络连接或域名是否正确。你的标签页和书签已安全保留。',
    };
  }
  if (errorCode === -118) {
    return {
      type: 'load-failed',
      title: '网页响应超时',
      message: '服务器长时间没有响应，请稍后重新加载。',
    };
  }
  return {
    type: 'load-failed',
    title: '无法打开这个网页',
    message: description
      ? `连接失败：${description}。请检查地址或稍后重试。`
      : '网站可能暂时不可用，请检查地址或稍后重试。',
  };
}

export function App() {
  const [bookmarkDialog, setBookmarkDialog] = useState({ open: false, url: '', title: '', folderId: '' });
  const requestBookmark = useCallback((entry: TabEntry) => {
    setBookmarkDialog({ open: true, url: entry.url, title: entry.title, folderId: '' });
  }, []);
  const browser = useBrowser({ onRequestBookmark: requestBookmark });
  const desktop = window.lumaDesktop;
  const isDesktop = Boolean(desktop?.isDesktop);
  const isIncognito = Boolean(desktop?.isIncognito);
  const [tabOverviewOpen, setTabOverviewOpen] = useState(false);
  const [tabPreviews, setTabPreviews] = useState<Record<string, { url: string; data: string }>>({});
  const [nativeNavigation, setNativeNavigation] = useState<Record<string, NativeNavigationState>>({});
  const [pageContext, setPageContext] = useState<PageContextState | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsWidth, setDevtoolsWidth] = useState(0);
  const [tabOverlayOpen, setTabOverlayOpen] = useState(false);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const pendingTabDrag = useRef<Promise<unknown> | null>(null);
  const [navMenuOpen, setNavMenuOpen] = useState(false);
  const [permissionRequests, setPermissionRequests] = useState<PermissionPromptRequest[]>([]);
  const [dropTarget, setDropTarget] = useState<'tab' | 'page' | null>(null);
  const [downloads, setDownloads] = useState<LumaDownloadRecord[]>([]);
  const [reader, setReader] = useState<{ article: ReaderArticle | null; loading: boolean } | null>(null);
  const readerAppearance = useRef(loadReaderAppearance()).current;
  const [readerFontSize, setReaderFontSize] = useState(readerAppearance.fontSize);
  const [readerLineHeight, setReaderLineHeight] = useState(readerAppearance.lineHeight);
  const [readerFontFamily, setReaderFontFamily] = useState<ReaderFontFamily>(readerAppearance.fontFamily);
  const [readerTheme, setReaderTheme] = useState<'light' | 'sepia' | 'dark'>(readerAppearance.theme);
  const [readerSettingsOpen, setReaderSettingsOpen] = useState(false);
  const pendingReaderNavigation = useRef<{ tabId: string; url: string } | null>(null);
  const readerUrlTransition = useRef<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translated, setTranslated] = useState(false);
  const [translationConsentOpen, setTranslationConsentOpen] = useState(false);
  const [adblock, setAdblock] = useState<LumaAdblockState | null>(null);
  const [blockedByTab, setBlockedByTab] = useState<Record<string, number>>({});
  const [passwordStatus, setPasswordStatus] = useState<LumaPasswordStatus | null>(null);
  const [passwordEntries, setPasswordEntries] = useState<LumaPasswordAccount[]>([]);
  const [passwordPrompt, setPasswordPrompt] = useState<LumaPasswordCapture | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findResult, setFindResult] = useState({ matches: 0, activeMatchOrdinal: 0 });
  const [regionCapture, setRegionCapture] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [regionRect, setRegionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const regionStart = useRef<{ x: number; y: number } | null>(null);
  const warnedBossKey = useRef<string | null>(null);
  const knownDownloads = useRef<Set<string> | null>(null);
  const webviews = useRef(new Map<string, PageHandle>());
  const tabDropHandled = useRef(false);
  const tabDragActive = useRef(false);
  const internalPage = getInternalPage(browser.activeEntry.url);
  const isExternalPage = !internalPage && isExternalUrl(browser.activeEntry.url);
  const showDesktopWeb = isDesktop && isExternalPage && !browser.activeTab.error;
  // Pages are native views that always sit above the HTML layer. Any overlay
  // that has to appear over the page swaps in a still frame and hides the view.
  const pageCovered = Boolean(
    navMenuOpen
    || browser.activePanel
    || pageContext
    || tabOverviewOpen
    || bookmarkDialog.open
    || translationConsentOpen
    || passwordPrompt
    || permissionRequests.length > 0
    || regionCapture
    || reader !== null
    || tabOverlayOpen,
  );
  // Menus open for a moment; the page under them should keep moving so it does
  // not look frozen. Dialogs and panels can sit on one still frame.
  const livePageOverlay = Boolean(navMenuOpen || pageContext || tabOverlayOpen);
  const activeNativeNav = nativeNavigation[browser.activeTabId];
  const activeHost = getHost(browser.activeEntry.url).toLowerCase();
  const activeReaderFont = READER_FONTS.find((font) => font.id === readerFontFamily) ?? READER_FONTS[0];
  const adblockSiteDisabled = Boolean(activeHost && adblock?.disabledSites.includes(activeHost));
  const blockedCount = blockedByTab[browser.activeTabId] ?? 0;

  useEffect(() => {
    document.title = `${browser.activeEntry.title} · Luma${isIncognito ? ' · 无痕模式' : ''}`;
    document.documentElement.dataset.reduceMotion = String(browser.preferences.reduceMotion);
    document.documentElement.dataset.incognito = String(isIncognito);
  }, [browser.activeEntry.title, browser.preferences.reduceMotion, isIncognito]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void desktop.isMaximized().then((maximized) => {
      if (active) setIsMaximized(maximized);
    });
    const unsubscribe = desktop.onMaximizedChange(setIsMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    const apply = (items: LumaDownloadRecord[]) => {
      if (!active) return;
      if (knownDownloads.current) {
        const fresh = items.find((item) => !knownDownloads.current?.has(item.id));
        if (fresh) browser.showToast({ tone: 'info', title: '开始下载', description: fresh.filename });
      }
      knownDownloads.current = new Set(items.map((item) => item.id));
      setDownloads(items);
    };
    void desktop.listDownloads().then(apply).catch(() => undefined);
    const unsubscribe = desktop.onDownloadsChanged(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [browser.showToast, desktop]);

  const activeOrigin = useMemo(() => {
    try {
      const parsed = new URL(browser.activeEntry.url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
    } catch {
      return null;
    }
  }, [browser.activeEntry.url]);

  const refreshPasswords = useCallback(async () => {
    if (!desktop || !activeOrigin || isIncognito) {
      setPasswordEntries([]);
      return;
    }
    try {
      setPasswordEntries(await desktop.getPasswordsForOrigin(activeOrigin));
    } catch {
      setPasswordEntries([]);
    }
  }, [activeOrigin, desktop, isIncognito]);

  useEffect(() => {
    void refreshPasswords();
  }, [refreshPasswords]);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void desktop.getAdblockState().then((state) => {
      if (active) setAdblock(state);
    }).catch(() => undefined);
    void desktop.getPasswordStatus().then((status) => {
      if (!active) return;
      setPasswordStatus(status);
    }).catch(() => undefined);
    const unsubscribeBlocked = desktop.onAdblockBlocked((info) => {
      let ownerTabId: string | null = null;
      for (const [tabId, view] of webviews.current.entries()) {
        try {
          if (view.getWebContentsId() === info.webContentsId) {
            ownerTabId = tabId;
            break;
          }
        } catch {
          // The guest may be detaching.
        }
      }
      if (!ownerTabId) return;
      setBlockedByTab((current) => ({ ...current, [ownerTabId as string]: info.count }));
    });
    return () => {
      active = false;
      unsubscribeBlocked();
    };
  }, [desktop]);

  // The page is a native view, so its context menu arrives from the main
  // process with the cursor position and the media/link under the pointer.
  useEffect(() => {
    if (!desktop?.onPageContextMenu) return undefined;
    const tabForContents = (contentsId: number): string | null => {
      for (const [tabId, view] of webviews.current.entries()) {
        try {
          if (view.getWebContentsId() === contentsId) return tabId;
        } catch {
          // The page may be detaching.
        }
      }
      return null;
    };
    return desktop.onPageContextMenu((info) => {
      const tabId = tabForContents(info.webContentsId);
      if (!tabId) return;
      const host = document.querySelector('.page-host-layer')?.getBoundingClientRect();
      const menuX = typeof info.clientX === 'number' ? info.clientX : (host ? host.left + info.x : info.x);
      const menuY = typeof info.clientY === 'number' ? info.clientY : (host ? host.top + info.y : info.y);
      setPageContext({ ...info, tabId, menuX, menuY });
    });
  }, [desktop]);

  useEffect(() => {
    if (!desktop?.onRenderGone) return undefined;
    const tabForContents = (contentsId: number): string | null => {
      for (const [tabId, view] of webviews.current.entries()) {
        try {
          if (view.getWebContentsId() === contentsId) return tabId;
        } catch {
          // The guest may already be detaching.
        }
      }
      return null;
    };
    const unsubscribeGone = desktop.onRenderGone((info) => {
      const tabId = tabForContents(info.webContentsId);
      if (!tabId) return;
      browser.reportError(tabId, {
        type: 'load-failed',
        title: '页面进程已崩溃',
        message: `这个标签页的渲染进程已退出（${info.reason}）。点击“重新加载”即可恢复，其他标签页不受影响。`,
      });
      browser.showToast({ tone: 'error', title: '页面进程已崩溃', description: '点击页面上的重新加载按钮即可恢复。' });
    });
    const unsubscribeUnresponsive = desktop.onUnresponsive((info) => {
      const tabId = tabForContents(info.webContentsId);
      if (!tabId) return;
      browser.showToast({ tone: 'info', title: '页面响应缓慢', description: '可以稍等片刻，或重新加载这个标签页。' });
    });
    return () => {
      unsubscribeGone();
      unsubscribeUnresponsive();
    };
  }, [browser.reportError, browser.showToast, desktop]);

  useEffect(() => {
    if (!desktop?.configureShortcuts) return undefined;
    let active = true;
    void desktop.configureShortcuts(browser.preferences.shortcuts, browser.preferences.bossKey).then((result) => {
      if (!active) return;
      if (result.bossKeyRegistered) {
        warnedBossKey.current = null;
        return;
      }
      if (browser.preferences.bossKey && warnedBossKey.current !== browser.preferences.bossKey) {
        warnedBossKey.current = browser.preferences.bossKey;
        browser.showToast({
          tone: 'error',
          title: '老板键注册失败',
          description: '这个全局快捷键可能已被其他程序占用，请在设置中更换。',
        });
      }
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [desktop, browser.preferences.shortcuts, browser.preferences.bossKey, browser.showToast]);

  useEffect(() => {
    setReader(null);
    setReaderSettingsOpen(false);
    setTranslated(false);
    pendingReaderNavigation.current = null;
    readerUrlTransition.current = null;
  }, [browser.activeTabId]);

  useEffect(() => {
    const ourReaderNavigation = readerUrlTransition.current === browser.activeEntry.url;
    if (ourReaderNavigation) readerUrlTransition.current = null;
    if (!ourReaderNavigation && !pendingReaderNavigation.current) setReader(null);
    setTranslated(false);
  }, [browser.activeEntry.url]);

  useEffect(() => {
    writeStorage(READER_PREF_KEY, {
      fontSize: readerFontSize,
      lineHeight: readerLineHeight,
      fontFamily: readerFontFamily,
      theme: readerTheme,
    });
  }, [readerFontFamily, readerFontSize, readerLineHeight, readerTheme]);

  const extractReaderFromView = useCallback(async (view: PageHandle, tabId: string, notify = true) => {
    const tab = browser.tabs.find((item) => item.id === tabId);
    const entry = tab?.entries[tab.historyIndex];
    try {
      const result = await view.executeJavaScript<ReaderExtractionResult>(READER_EXTRACT_SCRIPT, true);
      if (!result?.ok || !result.content) {
        setReader(null);
        if (notify) {
          browser.showToast({ tone: 'info', title: '无法进入阅读模式', description: '这个页面没有找到足够的正文内容。' });
        }
        return false;
      }
      setReader({
        article: {
          title: result.title || entry?.title || '',
          byline: result.byline || '',
          site: result.site || getHost(entry?.url || ''),
          url: result.url || entry?.url || '',
          content: sanitizeReaderHtml(result.content),
          textLength: result.textLength || 0,
          prevUrl: result.prevUrl,
          nextUrl: result.nextUrl,
        },
        loading: false,
      });
      return true;
    } catch {
      setReader(null);
      if (notify) {
        browser.showToast({ tone: 'error', title: '无法提取正文', description: '请等待页面加载完成后再试。' });
      }
      return false;
    }
  }, [browser.showToast, browser.tabs]);

  const toggleReader = useCallback(async () => {
    if (reader) {
      setReader(null);
      setReaderSettingsOpen(false);
      return;
    }
    const view = webviews.current.get(browser.activeTabId);
    if (!view || !showDesktopWeb) {
      browser.showToast({ tone: 'info', title: '阅读模式仅适用于普通网页' });
      return;
    }
    setReader({ article: null, loading: true });
    await extractReaderFromView(view, browser.activeTabId);
  }, [browser.activeTabId, browser.showToast, extractReaderFromView, reader, showDesktopWeb]);

  const openReaderChapter = useCallback((url?: string) => {
    if (!url) return;
    pendingReaderNavigation.current = { tabId: browser.activeTabId, url };
    readerUrlTransition.current = url;
    setReader({ article: null, loading: true });
    browser.navigate(url);
  }, [browser.activeTabId, browser.navigate]);

  const translatePage = useCallback(async (force = false) => {
    if (!desktop) return;
    if (!force && !browser.preferences.translationConsent) {
      setTranslationConsentOpen(true);
      return;
    }
    const view = webviews.current.get(browser.activeTabId);
    if (!view || !showDesktopWeb) {
      browser.showToast({ tone: 'info', title: '当前页面无法翻译' });
      return;
    }
    if (translating) return;
    setTranslating(true);
    try {
      const extracted = await view.executeJavaScript<{ ok: boolean; texts: string[] }>(TRANSLATION_EXTRACT_SCRIPT, true);
      if (!extracted?.ok || !extracted.texts?.length) {
        browser.showToast({ tone: 'info', title: '没有找到可翻译的文字' });
        return;
      }
      const result = await desktop.translatePage(extracted.texts, browser.preferences.translationTarget);
      if (!result.ok || result.translations.length === 0) {
        browser.showToast({
          tone: 'error',
          title: '网页翻译失败',
          description: result.error === 'same-language'
            ? '这个页面的语言已经是目标语言，无需翻译。'
            : result.error
              ? `翻译服务不可用（${result.error}）`
              : '请检查网络连接后重试。',
        });
        return;
      }
      await view.executeJavaScript(buildTranslationApplyScript(result.translations), true);
      setTranslated(true);
      browser.showToast({
        tone: 'success',
        title: '网页已翻译',
        description: `已翻译 ${Math.min(extracted.texts.length, result.translations.length)} 段文字，可随时恢复原文。`,
      });
    } catch {
      browser.showToast({ tone: 'error', title: '网页翻译失败' });
    } finally {
      setTranslating(false);
    }
  }, [browser.activeTabId, browser.preferences.translationConsent, browser.preferences.translationTarget, browser.showToast, desktop, showDesktopWeb, translating]);

  const restoreTranslation = useCallback(async () => {
    const view = webviews.current.get(browser.activeTabId);
    if (view) {
      try {
        await view.executeJavaScript(TRANSLATION_RESTORE_SCRIPT, true);
      } catch {
        // The page may have navigated away.
      }
    }
    setTranslated(false);
    browser.showToast({ tone: 'success', title: '已恢复原文' });
  }, [browser.activeTabId, browser.showToast]);

  const toggleAdblockSite = useCallback(async () => {
    if (!desktop || !activeHost) return;
    try {
      const next = await desktop.setAdblockSite(activeHost, !adblockSiteDisabled);
      setAdblock(next);
      browser.showToast({
        tone: 'success',
        title: adblockSiteDisabled ? `已对 ${activeHost} 启用拦截` : `已暂停 ${activeHost} 的拦截`,
        description: '页面会重新加载以应用设置。',
      });
      webviews.current.get(browser.activeTabId)?.reload();
    } catch {
      browser.showToast({ tone: 'error', title: '无法更新拦截设置' });
    }
  }, [activeHost, adblockSiteDisabled, browser.activeTabId, browser.showToast, desktop]);

  const openFind = useCallback(() => {
    if (!showDesktopWeb) return;
    setFindOpen(true);
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.find-bar input');
      input?.focus();
      input?.select();
    }, 0);
  }, [showDesktopWeb]);

  const closeFind = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    try {
      view?.stopFindInPage('clearSelection');
    } catch {
      // The guest may already be gone.
    }
    setFindOpen(false);
    setFindQuery('');
    setFindResult({ matches: 0, activeMatchOrdinal: 0 });
  }, [browser.activeTabId]);

  const runFind = useCallback((query: string, forward = true, findNext = false) => {
    const view = webviews.current.get(browser.activeTabId);
    if (!view || !showDesktopWeb) return;
    if (!query) {
      try {
        view.stopFindInPage('clearSelection');
      } catch {
        // Ignore a detached guest.
      }
      setFindResult({ matches: 0, activeMatchOrdinal: 0 });
      return;
    }
    try {
      view.findInPage(query, { forward, findNext });
    } catch {
      // Ignore a detached guest.
    }
  }, [browser.activeTabId, showDesktopWeb]);

  useEffect(() => {
    if (!findOpen) return undefined;
    const timer = window.setTimeout(() => runFind(findQuery, true, false), 140);
    return () => window.clearTimeout(timer);
  }, [findOpen, findQuery, runFind]);

  useEffect(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindResult({ matches: 0, activeMatchOrdinal: 0 });
  }, [browser.activeTabId, browser.activeEntry.url]);

  const handleFoundInPage = useCallback((tabId: string, result: { matches: number; activeMatchOrdinal: number }) => {
    if (tabId !== browser.activeTabId) return;
    setFindResult(result);
  }, [browser.activeTabId]);

  const fillPassword = useCallback(async (entry: LumaPasswordAccount) => {
    const view = webviews.current.get(browser.activeTabId);
    if (!view || !desktop) return;
    try {
      const filled = await desktop.autofillTab(view.getWebContentsId(), entry.id);
      browser.showToast({
        tone: filled ? 'success' : 'info',
        title: filled ? '已填充登录信息' : '没有找到登录表单',
        description: filled ? '检查无误后手动提交即可。' : '请打开网站的登录页面后再试。',
      });
    } catch {
      browser.showToast({ tone: 'error', title: '无法填充登录信息' });
    }
  }, [browser.activeTabId, browser.showToast, desktop]);

  const handlePasswordCaptured = useCallback((tabId: string, payload: { username: string; password: string }) => {
    if (!desktop || isIncognito) return;
    if (!browser.preferences.passwordSavingEnabled) return;
    if (!passwordStatus?.available || passwordStatus.readOnly) return;
    const tab = browser.tabs.find((item) => item.id === tabId);
    const entry = tab?.entries[tab.historyIndex];
    if (!entry) return;
    let origin: string | null = null;
    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') origin = parsed.origin;
    } catch {
      origin = null;
    }
    if (!origin) return;
    void desktop.hasPasswordCredential(origin, payload.username, payload.password).then((exists) => {
      if (exists) return;
      setPasswordPrompt({
        origin,
        host: new URL(origin).host,
        username: payload.username,
        password: payload.password,
        webContentsId: 0,
      });
    }).catch(() => undefined);
  }, [browser.preferences.passwordSavingEnabled, browser.tabs, desktop, isIncognito, passwordStatus?.available, passwordStatus?.readOnly]);

  const saveCapturedPassword = useCallback(async () => {
    if (!desktop || !passwordPrompt) return;
    setSavingPassword(true);
    try {
      const result = await desktop.savePassword(passwordPrompt.origin, passwordPrompt.username, passwordPrompt.password);
      if (result.ok) {
        setPasswordPrompt(null);
        browser.showToast({ tone: 'success', title: '登录信息已加密保存', description: passwordPrompt.host });
        void refreshPasswords();
      } else {
        browser.showToast({
          tone: 'error',
          title: '无法保存登录信息',
          description: result.reason === 'unavailable'
            ? '系统安全存储当前不可用。'
            : result.reason === 'read-only'
              ? '密码库处于只读保护状态，请检查设置中的提示。'
              : '请稍后重试。',
        });
      }
    } catch {
      browser.showToast({ tone: 'error', title: '无法保存登录信息' });
    } finally {
      setSavingPassword(false);
    }
  }, [browser.showToast, desktop, passwordPrompt, refreshPasswords]);

  const handleWebReady = useCallback(async (tabId: string) => {
    const view = webviews.current.get(tabId);
    const tab = browser.tabs.find((item) => item.id === tabId);
    if (!view || !tab) return;
    const pendingReader = pendingReaderNavigation.current;
    if (pendingReader?.tabId === tabId) {
      pendingReaderNavigation.current = null;
      void extractReaderFromView(view, tabId);
    }
    if (isIncognito) return;
    const entry = tab.entries[tab.historyIndex];
    let origin: string | null = null;
    try {
      const parsed = new URL(entry.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') origin = parsed.origin;
    } catch {
      origin = null;
    }
    if (!origin) return;
    if (browser.preferences.autoFillEnabled && desktop) {
      try {
        // The main process resolves credentials for this guest's origin and
        // hands them to the isolated preload; the page world never sees them.
        await desktop.autofillTab(view.getWebContentsId());
      } catch {
        // Autofill is best effort.
      }
    }
  }, [browser.preferences.autoFillEnabled, browser.tabs, desktop, extractReaderFromView, isIncognito]);

  /** The hover card is its own window, so the page never has to move aside. */
  const hideTabPreview = useCallback(() => {
    void desktop?.hideTabPreview?.();
  }, [desktop]);

  const showTabPreview = useCallback((preview: {
    tabId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    host: string;
    thumbnail?: string;
    favicon?: string;
  }) => {
    if (!desktop?.showTabPreview) return;
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string) => styles.getPropertyValue(name).trim() || undefined;
    void desktop.showTabPreview({
      ...preview,
      theme: {
        surface: read('--surface-raised'),
        border: read('--border'),
        text: read('--text'),
        muted: read('--text-muted'),
        soft: read('--surface-soft'),
      },
    });
  }, [desktop]);

  /**
   * A tab drag begins: main creates the window right away. It only becomes
   * visible once the pointer leaves the tab bar, so nothing waits for release.
   */
  const startTabDrag = useCallback((tabId: string, point: {
    screenX: number;
    screenY: number;
    offsetX?: number;
    offsetY?: number;
  }) => {
    if (!desktop?.beginTabDrag) return;
    hideTabPreview();
    const tab = browser.tabs.find((item) => item.id === tabId);
    const host = document.querySelector('.page-host-layer')?.getBoundingClientRect();
    if (!tab || !host) return;
    const pending = desktop.beginTabDrag({
      tab: toInitialTab(tab),
      point: { screenX: point.screenX, screenY: point.screenY },
      // The pointer keeps holding the tab it grabbed, inside the drag window.
      offset: {
        x: Math.round(point.offsetX ?? 0),
        y: Math.round(point.offsetY ?? 0),
      },
      size: { width: Math.round(host.width), height: Math.round(host.height) },
    }).catch(() => false);
    pendingTabDrag.current = pending;
  }, [browser.tabs, desktop, hideTabPreview]);

  /** Reports the pointer while the drag is still over HTML, so it can follow. */
  const moveTabDrag = useCallback((_tabId: string, point: { screenX: number; screenY: number }) => {
    void desktop?.updateTabDrag?.(point);
  }, [desktop]);

  /** Ends the drag: main keeps the window, merges it, or puts the tab back. */
  const finishTabDrag = useCallback(async (
    tabId: string,
    point?: { screenX?: number; screenY?: number },
  ) => {
    if (!desktop?.endTabDrag) return;
    // The drag can end before the window finished adopting the page.
    await pendingTabDrag.current?.catch(() => undefined);
    pendingTabDrag.current = null;
    const dropPoint = typeof point?.screenX === 'number' && typeof point?.screenY === 'number'
      ? { screenX: point.screenX, screenY: point.screenY }
      : undefined;
    const result = await desktop.endTabDrag({ point: dropPoint }).catch(() => null);
    setDraggingTabId(null);
    if (!result || result.ignored) return;
    if (result.returned) {
      // Put the tab back where it was, including as the active tab.
      browser.setActiveTabId(tabId);
      return;
    }
    if (browser.tabs.length === 1) {
      desktop.close();
      return;
    }
    browser.closeTab(tabId);
    browser.showToast({
      tone: 'success',
      title: result.merged ? '标签页已合并到其他窗口' : '标签页已移到新窗口',
    });
  }, [browser, desktop]);

  const registerWebview = useCallback((tabId: string, view: PageHandle | null) => {
    if (view) webviews.current.set(tabId, view);
    else webviews.current.delete(tabId);
  }, []);

  const handleNavigationState = useCallback(
    (tabId: string, canGoBack: boolean, canGoForward: boolean) => {
      setNativeNavigation((current) => {
        const previous = current[tabId];
        if (previous?.canGoBack === canGoBack && previous.canGoForward === canGoForward) return current;
        return { ...current, [tabId]: { canGoBack, canGoForward } };
      });
    },
    [],
  );

  const handleWebFail = useCallback(
    (tabId: string, errorCode: number, description: string) => {
      // ERR_ABORTED is what a canceled navigation reports; it is not an error.
      if (errorCode === -3) return;
      browser.reportError(tabId, createNetworkError(errorCode, description));
    },
    [browser.reportError],
  );

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      browser.showToast({ tone: 'success', title: '已复制到剪贴板' });
    } catch {
      browser.showToast({ tone: 'error', title: '无法复制到剪贴板' });
    }
  }, [browser.showToast]);

  const importBookmarksFile = useCallback(async () => {
    if (!desktop) return;
    try {
      const result = await desktop.importBookmarks();
      if (result.canceled || !result.content) return;
      const data = parseBookmarksHtml(result.content);
      if (data.bookmarks.length === 0) {
        browser.showToast({ tone: 'info', title: '没有找到可导入的书签' });
        return;
      }
      const summary = browser.importBookmarkData(data);
      browser.showToast({
        tone: 'success',
        title: `已导入 ${summary.added} 个书签`,
        description: summary.skipped > 0 ? `跳过 ${summary.skipped} 个重复项` : undefined,
      });
    } catch {
      browser.showToast({ tone: 'error', title: '导入书签失败' });
    }
  }, [browser.importBookmarkData, browser.showToast, desktop]);

  const exportBookmarksFile = useCallback(async () => {
    if (!desktop) return;
    try {
      const html = serializeBookmarksHtml(browser.bookmarks, browser.bookmarkFolders);
      const result = await desktop.exportBookmarks(html, 'luma-bookmarks.html');
      if (result.canceled) return;
      browser.showToast({ tone: 'success', title: '书签已导出', description: result.filePath });
    } catch {
      browser.showToast({ tone: 'error', title: '导出书签失败' });
    }
  }, [browser.bookmarkFolders, browser.bookmarks, browser.showToast, desktop]);

  // Native page events arrive on one channel; map them to the same handlers the
  // <webview> layer used to call directly.
  useEffect(() => {
    const bridge = window.lumaDesktop;
    if (!bridge?.onPageEvent) return undefined;
    return bridge.onPageEvent(({ tabId, type, payload }) => {
      const data = (payload ?? {}) as Record<string, unknown>;
      switch (type) {
        case 'start':
          browser.startWebLoading(tabId);
          break;
        case 'stop':
          browser.finishWebLoading(tabId);
          break;
        case 'start-navigation':
          if (!data.isSameDocument) browser.syncWebFavicon(tabId, '');
          break;
        case 'navigate': {
          const url = typeof data.url === 'string' ? data.url : '';
          if (!data.isSameDocument) browser.syncWebFavicon(tabId, '');
          if (url) browser.syncWebPage(tabId, url);
          break;
        }
        case 'title': {
          const title = typeof data.title === 'string' ? data.title : '';
          if (title) browser.syncWebTitle(tabId, title);
          break;
        }
        case 'favicon': {
          const favicon = typeof data.favicon === 'string' ? data.favicon : '';
          if (favicon) browser.syncWebFavicon(tabId, favicon);
          break;
        }
        case 'fail': {
          // A superseded navigation reports a failure for a page the tab no
          // longer shows; showing the error screen then would hide a good page.
          const failedUrl = String(data.url || '');
          const live = browser.tabs.find((tab) => tab.id === tabId);
          const liveUrl = live?.entries[live.historyIndex]?.url ?? '';
          if (failedUrl && liveUrl && failedUrl !== liveUrl) break;
          handleWebFail(
            tabId,
            Number(data.errorCode) || 0,
            String(data.errorDescription || ''),
          );
          break;
        }
        case 'ready':
          void handleWebReady(tabId);
          break;
        case 'audio':
          browser.setTabAudible(tabId, Boolean(data.audible));
          break;
        case 'found-in-page':
          handleFoundInPage(tabId, {
            matches: Number(data.matches) || 0,
            activeMatchOrdinal: Number(data.activeMatchOrdinal) || 0,
          });
          break;
        case 'new-window': {
          const url = typeof data.url === 'string' ? data.url : '';
          if (url) browser.newTab(url);
          break;
        }
        case 'password': {
          if (typeof data.password !== 'string' || !data.password) break;
          handlePasswordCaptured(tabId, {
            username: typeof data.username === 'string' ? data.username : '',
            password: data.password,
          });
          break;
        }
        default:
          break;
      }
    });
  }, [
    browser.finishWebLoading,
    browser.newTab,
    browser.setTabAudible,
    browser.startWebLoading,
    browser.syncWebFavicon,
    browser.syncWebPage,
    browser.syncWebTitle,
    browser.tabs,
    handleFoundInPage,
    handlePasswordCaptured,
    handleWebFail,
    handleWebReady,
  ]);

  useEffect(() => {
    const handle = () => hideTabPreview();
    window.addEventListener('blur', handle);
    document.addEventListener('visibilitychange', handle);
    return () => {
      window.removeEventListener('blur', handle);
      document.removeEventListener('visibilitychange', handle);
    };
  }, [hideTabPreview]);

  // Main reports when the drag window takes the page, so this window can show
  // the tab that stays behind instead of an empty page area.
  useEffect(() => {
    const desktopApi = window.lumaDesktop;
    if (!desktopApi?.onTabDragStarted) return undefined;
    return desktopApi.onTabDragStarted(({ tabId }) => {
      setDraggingTabId(tabId);
      const list = browser.tabs;
      if (list.length < 2) return;
      const index = list.findIndex((item) => item.id === tabId);
      const neighbour = list[index + 1] ?? list[index - 1] ?? null;
      if (neighbour) browser.setActiveTabId(neighbour.id);
    });
  }, [browser.setActiveTabId, browser.tabs]);

  // Entering another window's tab bar merges immediately, before the button is
  // released. Main hands the live page over; this window drops its copy.
  useEffect(() => {
    const desktopApi = window.lumaDesktop;
    if (!desktopApi?.onTabDragMerged) return undefined;
    return desktopApi.onTabDragMerged(({ tabId }) => {
      setDraggingTabId(null);
      if (browser.tabs.length <= 1) {
        desktopApi.close();
        return;
      }
      browser.closeTab(tabId);
      browser.showToast({ tone: 'success', title: '标签页已合并到其他窗口' });
    });
  }, [browser.closeTab, browser.showToast, browser.tabs.length]);

  const printActivePage = useCallback(async () => {
    const view = webviews.current.get(browser.activeTabId);
    if (!desktop || !view || !showDesktopWeb) return;
    try {
      const result = await desktop.printPage(view.getWebContentsId());
      if (!result.success) {
        browser.showToast({ tone: 'info', title: '未打印页面', description: result.reason });
      }
    } catch {
      browser.showToast({ tone: 'error', title: '无法打印页面' });
    }
  }, [browser.activeTabId, browser.showToast, desktop, showDesktopWeb]);

  const saveActivePagePdf = useCallback(async () => {
    const view = webviews.current.get(browser.activeTabId);
    if (!desktop || !view || !showDesktopWeb) return;
    const safeTitle = (browser.activeEntry.title || 'page').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    try {
      const result = await desktop.savePagePdf(view.getWebContentsId(), `${safeTitle}.pdf`);
      if (result.canceled && !result.failed) return;
      if (result.failed) {
        browser.showToast({ tone: 'error', title: '无法另存为 PDF' });
        return;
      }
      browser.showToast({ tone: 'success', title: 'PDF 已保存', description: result.filePath });
    } catch {
      browser.showToast({ tone: 'error', title: '无法另存为 PDF' });
    }
  }, [browser.activeEntry.title, browser.activeTabId, browser.showToast, desktop, showDesktopWeb]);

  const cancelRegionCapture = useCallback(() => {
    regionStart.current = null;
    setRegionRect(null);
    setRegionCapture(null);
  }, []);

  const startRegionCapture = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    if (!desktop || !view || !showDesktopWeb) {
      browser.showToast({ tone: 'info', title: '框选截图仅适用于普通网页' });
      return;
    }
    if (reader?.article) {
      browser.showToast({ tone: 'info', title: '请先退出阅读模式再框选截图' });
      return;
    }
    const rect = view.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) {
      browser.showToast({ tone: 'info', title: '页面区域过小，暂时无法框选' });
      return;
    }
    regionStart.current = null;
    setRegionRect(null);
    setRegionCapture({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }, [browser.activeTabId, browser.showToast, desktop, reader, showDesktopWeb]);

  const captureScreenshot = useCallback(async (
    options: {
      mode?: 'save' | 'copy';
      fullPage?: boolean;
      selectRegion?: boolean;
      region?: { x: number; y: number; width: number; height: number };
      viewport?: { width: number; height: number };
    } = {},
  ) => {
    if (options.selectRegion) {
      startRegionCapture();
      return;
    }
    const view = webviews.current.get(browser.activeTabId);
    if (!desktop || !view || !showDesktopWeb) {
      browser.showToast({ tone: 'info', title: '截图仅适用于普通网页' });
      return;
    }
    const mode = options.mode === 'copy' ? 'copy' : 'save';
    const safeTitle = (browser.activeEntry.title || '网页')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
    try {
      const result = await desktop.capturePage(view.getWebContentsId(), {
        mode,
        fullPage: Boolean(options.fullPage),
        region: options.region,
        viewport: options.viewport,
        suggestedName: mode === 'save' ? `${safeTitle || '网页'}-截图` : undefined,
      });
      if (!result.ok) {
        browser.showToast({ tone: 'error', title: '截图失败', description: result.reason });
        return;
      }
      if (result.canceled) return;
      if (result.copied) {
        browser.showToast({ tone: 'success', title: '截图已复制到剪贴板' });
        return;
      }
      if (result.filePath) {
        browser.showToast({ tone: 'success', title: '截图已保存', description: result.filePath });
      }
    } catch {
      browser.showToast({ tone: 'error', title: '截图失败' });
    }
  }, [browser.activeEntry.title, browser.activeTabId, browser.showToast, desktop, showDesktopWeb, startRegionCapture]);

  const handleRegionPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!regionCapture || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = Math.min(regionCapture.width, Math.max(0, event.clientX - regionCapture.left));
    const y = Math.min(regionCapture.height, Math.max(0, event.clientY - regionCapture.top));
    regionStart.current = { x, y };
    setRegionRect({ x, y, width: 0, height: 0 });
  };

  const handleRegionPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = regionStart.current;
    if (!start || !regionCapture) return;
    const x = Math.min(regionCapture.width, Math.max(0, event.clientX - regionCapture.left));
    const y = Math.min(regionCapture.height, Math.max(0, event.clientY - regionCapture.top));
    setRegionRect({
      x: Math.min(start.x, x),
      y: Math.min(start.y, y),
      width: Math.abs(x - start.x),
      height: Math.abs(y - start.y),
    });
  };

  const handleRegionPointerUp = () => {
    if (!regionStart.current) return;
    regionStart.current = null;
    setRegionRect((current) => (current && current.width >= 10 && current.height >= 10 ? current : null));
  };

  const finishRegionCapture = async (mode: 'save' | 'copy') => {
    if (!regionCapture || !regionRect) return;
    const region = { ...regionRect };
    const viewport = { width: regionCapture.width, height: regionCapture.height };
    cancelRegionCapture();
    await captureScreenshot({ mode, region, viewport });
  };

  useEffect(() => {
    if (!regionCapture) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelRegionCapture();
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [cancelRegionCapture, regionCapture]);

  useEffect(() => {
    cancelRegionCapture();
  }, [browser.activeEntry.url, browser.activeTabId, cancelRegionCapture]);

  const handleRefresh = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    // A crashed guest cannot reload itself; bumping loadKey remounts the URL.
    if (isDesktop && isExternalPage && view && !browser.activeTab.error) {
      browser.beginWebReload(browser.activeTabId);
      view.reload();
      return;
    }
    browser.refresh();
  }, [
    browser.activeTab.error,
    browser.activeTabId,
    browser.beginWebReload,
    browser.refresh,
    isDesktop,
    isExternalPage,
  ]);

  const handleStop = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    if (view) {
      try {
        view.stop();
      } catch {
        // The guest may already be tearing down.
      }
    }
    browser.finishWebLoading(browser.activeTabId);
  }, [browser.activeTabId, browser.finishWebLoading]);

  const handleBack = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    if (showDesktopWeb && view?.canGoBack()) {
      view.goBack();
      return;
    }
    browser.goBack();
  }, [browser.activeTabId, browser.goBack, showDesktopWeb]);

  const handleForward = useCallback(() => {
    const view = webviews.current.get(browser.activeTabId);
    if (showDesktopWeb && view?.canGoForward()) {
      view.goForward();
      return;
    }
    browser.goForward();
  }, [browser.activeTabId, browser.goForward, showDesktopWeb]);

  const toggleFullscreen = useCallback(() => {
    void desktop?.toggleFullscreen();
  }, [desktop]);

  const toggleDevTools = useCallback(() => {
    if (!desktop || !isExternalPage) return;
    setDevtoolsOpen((open) => !open);
  }, [desktop, isExternalPage]);

  useEffect(() => {
    if (!isDesktop) return undefined;
    const handleAppShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcuts = browser.preferences.shortcuts;
      let action: string | null = null;
      for (const candidate of Object.keys(shortcuts)) {
        if (matchShortcutEvent(event, shortcuts[candidate])) {
          action = candidate;
          break;
        }
      }
      if (!action) return;
      if (action === 'downloads') {
        event.preventDefault();
        desktop?.openDownloads();
      } else if (action === 'new-incognito') {
        event.preventDefault();
        desktop?.openIncognito();
      } else if (action === 'reader') {
        event.preventDefault();
        void toggleReader();
      } else if (action === 'translate') {
        event.preventDefault();
        void translatePage();
      } else if (action === 'find') {
        event.preventDefault();
        openFind();
      } else if (action === 'print') {
        event.preventDefault();
        void printActivePage();
      } else if (action === 'screenshot') {
        event.preventDefault();
        void captureScreenshot();
      }
    };
    window.addEventListener('keydown', handleAppShortcut);
    return () => window.removeEventListener('keydown', handleAppShortcut);
  }, [browser.preferences.shortcuts, captureScreenshot, desktop, isDesktop, openFind, printActivePage, toggleReader, translatePage]);

  useEffect(() => {
    if (!desktop?.onPermissionRequest) return undefined;
    return desktop.onPermissionRequest((request) => {
      setPermissionRequests((current) => [...current, request]);
    });
  }, [desktop]);

  const respondToPermission = useCallback((decision: 'allow' | 'deny' | 'always') => {
    const request = permissionRequests[0];
    if (!request || !desktop) return;
    void desktop.respondPermission(request.id, decision);
    setPermissionRequests((current) => current.slice(1));
  }, [desktop, permissionRequests]);

  useEffect(() => {
    setDevtoolsOpen(false);
  }, [browser.activeTabId, showDesktopWeb]);

  const canGoBack = browser.activeTab.historyIndex > 0 || Boolean(showDesktopWeb && activeNativeNav?.canGoBack);
  const canGoForward =
    browser.activeTab.historyIndex < browser.activeTab.entries.length - 1 ||
    Boolean(showDesktopWeb && activeNativeNav?.canGoForward);

  useEffect(() => {
    if (!desktop) return undefined;
    return desktop.onOpenInNewTab((url) => browser.newTab(url));
  }, [browser.newTab, desktop]);

  useEffect(() => {
    if (!desktop?.onAdoptTab) return undefined;
    return desktop.onAdoptTab((tab) => {
      browser.adoptTab(tab);
      browser.showToast({ tone: 'success', title: '已接收标签页', description: tab.title });
    });
  }, [browser.adoptTab, browser.showToast, desktop]);

  useEffect(() => {
    if (!desktop) return undefined;
    return desktop.onShortcut((command) => {
      if (command === 'new-tab') browser.newTab();
      else if (command === 'reopen-tab') browser.reopenClosedTab();
      else if (command === 'close-tab') browser.closeTab(browser.activeTabId);
      else if (command === 'focus-address') document.getElementById('browser-address')?.focus();
      else if (command === 'reload') handleRefresh();
      else if (command === 'bookmark') browser.toggleBookmark();
      else if (command === 'history') browser.openInternalPage('history');
      else if (command === 'new-incognito') desktop.openIncognito();
      else if (command === 'downloads') desktop.openDownloads();
      else if (command === 'toggle-bookmarks') {
        browser.updatePreferences({ showBookmarksBar: !browser.preferences.showBookmarksBar });
      } else if (command === 'back') handleBack();
      else if (command === 'forward') handleForward();
      else if (command === 'devtools') toggleDevTools();
      else if (command === 'reader') void toggleReader();
      else if (command === 'translate') void translatePage();
      else if (command === 'find') openFind();
      else if (command === 'print') void printActivePage();
      else if (command === 'screenshot') void captureScreenshot();
      else if (command === 'sleep-tabs') browser.sleepBackgroundTabs();
    });
  }, [browser, captureScreenshot, desktop, handleBack, handleForward, handleRefresh, openFind, printActivePage, toggleDevTools, toggleReader, translatePage]);

  useEffect(() => {
    if (!isDesktop) return undefined;
    const handleNativeArrowKeys = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopImmediatePropagation();
        handleBack();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        handleForward();
      }
    };
    window.addEventListener('keydown', handleNativeArrowKeys, true);
    return () => window.removeEventListener('keydown', handleNativeArrowKeys, true);
  }, [handleBack, handleForward, isDesktop]);

  useEffect(() => {
    if (!isDesktop) return undefined;
    const handleFunctionKeys = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault();
        toggleFullscreen();
      } else if (browser.preferences.shortcuts.devtools && matchShortcutEvent(event, browser.preferences.shortcuts.devtools)) {
        event.preventDefault();
        toggleDevTools();
      }
    };
    window.addEventListener('keydown', handleFunctionKeys, true);
    return () => window.removeEventListener('keydown', handleFunctionKeys, true);
  }, [browser.preferences.shortcuts.devtools, isDesktop, toggleDevTools, toggleFullscreen]);

  const openBookmarkDialog = (prefill = false, folderId = '') => {
    const canPrefill = prefill && !getInternalPage(browser.activeEntry.url);
    setBookmarkDialog({
      open: true,
      url: canPrefill ? browser.activeEntry.url : '',
      title: canPrefill ? browser.activeEntry.title : '',
      folderId,
    });
  };

  const captureTabPreview = useCallback((tabId: string, force = false) => {
    const tab = browser.tabs.find((item) => item.id === tabId);
    const entry = tab?.entries[tab.historyIndex];
    const view = webviews.current.get(tabId);
    if (!entry || !isExternalUrl(entry.url) || !view) return;
    const cached = tabPreviews[tabId];
    if (!force && cached?.url === entry.url) return;
    void view.capturePage()
      .then((data) => {
        if (!data) return;
        setTabPreviews((current) => ({ ...current, [tabId]: { url: entry.url, data } }));
      })
      .catch(() => {
        // Background pages may not expose a frame until they are shown again.
      });
  }, [browser.tabs, tabPreviews]);

  const openTabOverview = () => {
    setTabOverviewOpen(true);
    for (const tabId of webviews.current.keys()) captureTabPreview(tabId, true);
  };

  const tabPreviewData = useMemo(() => {
    const previews: Record<string, string> = {};
    for (const tab of browser.tabs) {
      const entry = tab.entries[tab.historyIndex];
      const preview = tabPreviews[tab.id];
      if (preview && preview.url === entry.url) previews[tab.id] = preview.data;
    }
    return previews;
  }, [browser.tabs, tabPreviews]);

  const duplicateTab = (id: string) => {
    const tab = browser.tabs.find((item) => item.id === id);
    const entry = tab?.entries[tab.historyIndex];
    if (entry) browser.newTab(entry.url);
  };

  const reloadTab = (id: string) => {
    const tab = browser.tabs.find((item) => item.id === id);
    const entry = tab?.entries[tab.historyIndex];
    if (!tab || !entry) return;
    const view = webviews.current.get(id);
    if (view && isExternalUrl(entry.url)) {
      browser.beginWebReload(id);
      view.reload();
    } else if (id === browser.activeTabId) {
      handleRefresh();
    } else {
      browser.setActiveTabId(id);
    }
  };

  const bookmarkTab = (id: string) => {
    const tab = browser.tabs.find((item) => item.id === id);
    const entry = tab?.entries[tab.historyIndex];
    if (entry && !getInternalPage(entry.url)) requestBookmark(entry);
  };

  const draggedText = (dataTransfer: DataTransfer, read: boolean): string | null => {
    if (dataTransfer.types.includes('application/x-luma-item')) return null;
    if (!read) {
      return dataTransfer.types.includes('text/uri-list') || dataTransfer.types.includes('text/plain') || dataTransfer.types.includes('text/html')
        ? ''
        : null;
    }
    const uriList = dataTransfer.getData('text/uri-list');
    if (uriList) {
      const uri = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
      if (uri) return uri;
    }
    const text = dataTransfer.getData('text/plain').trim();
    if (text) return text;
    const html = dataTransfer.getData('text/html');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const href = doc.querySelector('a[href]')?.getAttribute('href') ?? doc.querySelector('img[src]')?.getAttribute('src');
      if (href) return href;
    }
    return null;
  };

  const handleAppDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/x-luma-item')) {
      if ((event.target as Element).closest('.browser-tabbar')) return;
      event.preventDefault();
      if (tabDragActive.current) {
        // Like other browsers, dropping a tab over the page does nothing.
        event.dataTransfer.dropEffect = 'none';
        setDropTarget(null);
      } else {
        // Bookmark and folder drags still need a drop-allowed zone.
        event.dataTransfer.dropEffect = 'move';
      }
      return;
    }
    const value = draggedText(event.dataTransfer, false);
    if (value === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const overTabs = Boolean((event.target as Element).closest('.browser-tabbar'));
    setDropTarget(overTabs ? 'tab' : 'page');
  };

  const handleAppDrop = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('application/x-luma-item')) {
      if (!tabDragActive.current) return;
      const overTabs = Boolean((event.target as Element).closest('.browser-tabbar'));
      setDropTarget(null);
      if (!overTabs) {
        // Keep the tab where it is; tearing off happens only outside the window.
        event.preventDefault();
      }
      return;
    }
    const value = draggedText(event.dataTransfer, true);
    const overTabs = Boolean((event.target as Element).closest('.browser-tabbar'));
    setDropTarget(null);
    if (!value) return;
    event.preventDefault();
    if (overTabs) browser.newTab(value);
    else browser.navigate(value);
  };

  const clearSiteData = useCallback(async () => {
    if (!desktop) return false;
    try {
      const cleared = await desktop.clearSiteData();
      browser.showToast({
        tone: cleared ? 'success' : 'error',
        title: cleared ? '网站数据已清除' : '清除失败',
        description: cleared ? 'Cookie、网站存储和缓存已清理' : '当前环境无法访问浏览器数据',
      });
      return cleared;
    } catch {
      browser.showToast({ tone: 'error', title: '清除网站数据失败' });
      return false;
    }
  }, [browser.showToast, desktop]);

  const getSiteData = useCallback(async () => {
    if (!desktop) return null;
    try {
      return await desktop.getSiteData();
    } catch {
      browser.showToast({ tone: 'error', title: '无法读取网站数据' });
      return null;
    }
  }, [browser.showToast, desktop]);

  const clearSiteDataForDomain = useCallback(async (domain: string) => {
    if (!desktop) return false;
    try {
      const cleared = await desktop.clearSiteDataForDomain(domain);
      browser.showToast({
        tone: cleared ? 'success' : 'error',
        title: cleared ? `已清除 ${domain} 的网站数据` : '清除网站数据失败',
        description: cleared ? '该站点的 Cookie 与存储已被删除' : undefined,
      });
      return cleared;
    } catch {
      browser.showToast({ tone: 'error', title: '清除网站数据失败' });
      return false;
    }
  }, [browser.showToast, desktop]);

  const clearCache = useCallback(async () => {
    if (!desktop) return false;
    try {
      const cleared = await desktop.clearCache();
      browser.showToast({
        tone: cleared ? 'success' : 'error',
        title: cleared ? '网页缓存已清除' : '清除缓存失败',
      });
      return cleared;
    } catch {
      browser.showToast({ tone: 'error', title: '清除缓存失败' });
      return false;
    }
  }, [browser.showToast, desktop]);

  const pageMenuItems: ContextMenuEntry[] = (() => {
    if (!pageContext) return [];
    const view = webviews.current.get(pageContext.tabId);
    const items: ContextMenuEntry[] = [
      { id: 'page-back', label: '后退', icon: <ArrowLeft />, disabled: !canGoBack, onSelect: handleBack },
      { id: 'page-forward', label: '前进', icon: <ArrowRight />, disabled: !canGoForward, onSelect: handleForward },
      { id: 'page-reload', label: '重新加载', icon: <RefreshCw />, shortcut: 'Ctrl+R', onSelect: handleRefresh },
      { id: 'page-print', label: '打印…', icon: <Printer />, shortcut: 'Ctrl+P', onSelect: () => void printActivePage() },
      { id: 'page-save-pdf', label: '另存为 PDF…', icon: <FileDown />, onSelect: () => void saveActivePagePdf() },
      { id: 'page-capture', label: '保存网页截图…', icon: <Camera />, shortcut: 'Ctrl+Shift+X', onSelect: () => void captureScreenshot() },
      { id: 'page-capture-region', label: '截取选定区域…', icon: <Camera />, onSelect: () => void captureScreenshot({ selectRegion: true }) },
      { id: 'page-capture-full', label: '截取整个页面…', icon: <Camera />, onSelect: () => void captureScreenshot({ fullPage: true }) },
      { id: 'page-capture-copy', label: '复制截图到剪贴板', icon: <Copy />, onSelect: () => void captureScreenshot({ mode: 'copy' }) },
      { id: 'page-separator-1', separator: true },
    ];

    if (pageContext.mediaType === 'image' && pageContext.srcURL) {
      items.push(
        {
          id: 'open-image-tab',
          label: '在新标签页中打开图片',
          icon: <ImageIcon />,
          onSelect: () => browser.newTab(pageContext.srcURL),
        },
        {
          id: 'save-image',
          label: '图片另存为…',
          icon: <Download />,
          onSelect: () => {
            void desktop?.saveUrl(pageContext.webContentsId, pageContext.srcURL).then((started) => {
              if (!started) browser.showToast({ tone: 'error', title: '无法保存这张图片' });
            });
          },
        },
        {
          id: 'copy-image-url',
          label: '复制图片地址',
          icon: <Link2 />,
          onSelect: () => void copyText(pageContext.srcURL),
        },
        { id: 'page-separator-image', separator: true },
      );
    }

    if (pageContext.linkURL.startsWith('http')) {
      items.push(
        {
          id: 'open-link-tab',
          label: '在新标签页中打开链接',
          icon: <ExternalLink />,
          onSelect: () => browser.newTab(pageContext.linkURL),
        },
        {
          id: 'copy-link',
          label: '复制链接地址',
          icon: <Link2 />,
          onSelect: () => void copyText(pageContext.linkURL),
        },
        { id: 'page-separator-2', separator: true },
      );
    }

    if (pageContext.isEditable) {
      items.push(
        {
          id: 'cut',
          label: '剪切',
          icon: <Scissors />,
          shortcut: 'Ctrl+X',
          disabled: !pageContext.editFlags.canCut,
          onSelect: () => { view?.cut(); browser.showToast({ tone: 'success', title: '已剪切' }); },
        },
        {
          id: 'copy-text',
          label: '复制',
          icon: <Copy />,
          shortcut: 'Ctrl+C',
          disabled: !pageContext.editFlags.canCopy,
          onSelect: () => { view?.copy(); browser.showToast({ tone: 'success', title: '已复制' }); },
        },
        {
          id: 'paste',
          label: '粘贴',
          icon: <TextCursorInput />,
          shortcut: 'Ctrl+V',
          disabled: !pageContext.editFlags.canPaste,
          onSelect: () => view?.paste(),
        },
        { id: 'page-separator-3', separator: true },
      );
    } else if (pageContext.selectionText) {
      items.push(
        {
          id: 'copy-selection',
          label: '复制选中文字',
          icon: <Copy />,
          shortcut: 'Ctrl+C',
          onSelect: () => { view?.copy(); browser.showToast({ tone: 'success', title: '已复制选中文字' }); },
        },
        { id: 'page-separator-3', separator: true },
      );
    }

    items.push(
      {
        id: 'select-all',
        label: '全选',
        icon: <MousePointer2 />,
        shortcut: 'Ctrl+A',
        disabled: pageContext.isEditable && !pageContext.editFlags.canSelectAll,
        onSelect: () => view?.selectAll(),
      },
      { id: 'page-separator-4', separator: true },
      {
        id: 'bookmark-page',
        label: browser.isBookmarked ? '移除此页书签' : '为此页添加书签',
        icon: <BookmarkPlus />,
        shortcut: 'Ctrl+D',
        onSelect: browser.toggleBookmark,
      },
      {
        id: 'copy-page-url',
        label: '复制页面地址',
        icon: <Link2 />,
        onSelect: () => void copyText(browser.activeEntry.url),
      },
      {
        id: 'open-system',
        label: '在系统浏览器中打开',
        icon: <ExternalLink />,
        onSelect: () => void desktop?.openExternal(browser.activeEntry.url),
      },
    );
    return items;
  })();

  const renderPage = () => {
    if (browser.activeTab.error) {
      return (
        <ErrorPage
          error={browser.activeTab.error}
          url={browser.activeEntry.url}
          canGoBack={canGoBack}
          onRetry={handleRefresh}
          onBack={handleBack}
          onHome={browser.goHome}
        />
      );
    }

    if (internalPage === 'home') {
      return (
        <HomePage
          history={browser.history}
          tabCount={browser.tabs.length}
          bookmarkCount={browser.bookmarks.length}
          searchEngine={browser.preferences.searchEngine}
          customSearchEngines={browser.preferences.customSearchEngines}
          onSearchEngineChange={(searchEngine) => browser.updatePreferences({ searchEngine })}
          onNavigate={browser.navigate}
          onOpenInNewTab={browser.newTab}
          onHistory={() => browser.openInternalPage('history')}
          onBookmarks={() => browser.openInternalPage('bookmarks')}
          onCustomize={() => browser.openInternalPage('settings')}
        />
      );
    }
    if (internalPage === 'newtab') {
      return (
        <NewTabPage
          searchEngine={browser.preferences.searchEngine}
          customSearchEngines={browser.preferences.customSearchEngines}
          onSearchEngineChange={(searchEngine) => browser.updatePreferences({ searchEngine })}
          onNavigate={browser.navigate}
          onOpenHome={browser.goHome}
          onCustomize={() => browser.openInternalPage('settings')}
        />
      );
    }
    if (internalPage === 'bookmarks') {
      return <BookmarksPage
        bookmarks={browser.bookmarks}
        folders={browser.bookmarkFolders}
        onNavigate={browser.navigate}
        onAdd={(folderId) => openBookmarkDialog(false, folderId)}
        onRemove={browser.removeBookmark}
        onOpenInNewTab={browser.newTab}
        onCopyLink={(url) => void copyText(url)}
        onAddFolder={browser.addBookmarkFolder}
        onRenameFolder={browser.renameBookmarkFolder}
        onRemoveFolder={browser.removeBookmarkFolder}
        onMoveBookmark={browser.moveBookmark}
        onReorder={browser.reorderBookmarks}
        onReorderRoot={browser.reorderRootItem}
        onImport={desktop ? () => void importBookmarksFile() : undefined}
        onExport={desktop ? () => void exportBookmarksFile() : undefined}
      />;
    }
    if (internalPage === 'history') {
      return <HistoryPage history={browser.history} onNavigate={browser.navigate} onRemove={browser.removeHistory} onRemoveMany={browser.removeHistoryMany} onClear={browser.clearHistory} onOpenInNewTab={browser.newTab} onCopyLink={(url) => void copyText(url)} />;
    }
    if (internalPage === 'settings') {
      return (
        <SettingsPage
          preferences={browser.preferences}
          history={browser.history}
          historyCount={browser.history.length}
          bookmarkCount={browser.bookmarks.length}
          folderCount={browser.bookmarkFolders.length}
          tabCount={browser.tabs.length}
          onUpdate={browser.updatePreferences}
          onReset={browser.resetData}
          onAddSearchEngine={browser.addCustomSearchEngine}
          onRemoveSearchEngine={browser.removeCustomSearchEngine}
          onClearSiteData={clearSiteData}
          onGetSiteData={getSiteData}
          onClearSiteDataForDomain={clearSiteDataForDomain}
          onClearCache={clearCache}
          onSleepBackgroundTabs={browser.sleepBackgroundTabs}
        />
      );
    }
    if (isDesktop) return null;
    return (
      <ExternalPage
        tab={browser.activeTab}
        url={browser.activeEntry.url}
        onLoaded={() => browser.finishLoading(browser.activeTab.id)}
        onFailed={() => browser.reportError(browser.activeTab.id, {
          type: 'load-failed',
          title: '无法打开这个网页',
          message: '网站可能暂时不可用，或拒绝了嵌入预览。你可以重试，或使用系统浏览器打开。',
        })}
      />
    );
  };

  return (
    <div
      className={`browser-app ${isDesktop ? 'is-desktop' : ''} ${isIncognito ? 'is-incognito' : ''} ${dropTarget ? `is-drop-${dropTarget}` : ''}`}
      onDragOver={handleAppDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
      }}
      onDrop={handleAppDrop}
    >
      <header className={`browser-chrome ${isDesktop ? 'is-window-draggable' : ''}`} aria-label="浏览器界面">
        <TabStrip
          tabs={browser.tabs}
          activeTabId={browser.activeTabId}
          onSelect={browser.setActiveTabId}
          onClose={browser.closeTab}
          onNew={() => browser.newTab()}
          onCloseOthers={browser.closeOtherTabs}
          onCloseRight={browser.closeTabsToRight}
          onReopen={browser.reopenClosedTab}
          onDuplicate={duplicateTab}
          onCopyUrl={(url) => void copyText(url)}
          onReorder={browser.reorderTabs}
          onReloadTab={reloadTab}
          onBookmarkTab={bookmarkTab}
          onToggleMute={browser.toggleTabMute}
          onSleepTab={browser.sleepTab}
          onTearOffStart={(tabId, point) => startTabDrag(tabId, point)}
          onTearOffMove={(tabId, point) => moveTabDrag(tabId, point)}
          onTearOffEnd={(tabId, point) => void finishTabDrag(tabId, point)}
          onOverlayChange={setTabOverlayOpen}
          onShowPreview={desktop ? showTabPreview : undefined}
          onHidePreview={desktop ? hideTabPreview : undefined}
          dropHandledRef={tabDropHandled}
          onDragStateChange={(id) => {
            tabDragActive.current = Boolean(id);
            setDropTarget(null);
          }}
          onOverview={openTabOverview}
          previews={tabPreviewData}
          showPreviews={browser.preferences.showTabPreviews}
          onPreviewRequest={captureTabPreview}
          doubleClickCloses={browser.preferences.doubleClickClosesTab}
          rightClickCloses={browser.preferences.rightClickClosesTab}
          scrollSwitches={browser.preferences.scrollTabsToSwitch}
          isIncognito={isIncognito}
          onOpenSettings={() => browser.openInternalPage('settings')}
          isDesktop={isDesktop}
          isMaximized={isMaximized}
          onMinimize={() => desktop?.minimize()}
          onToggleMaximize={() => desktop?.toggleMaximize()}
          onCloseWindow={() => desktop?.close()}
        />
        <NavigationBar
          tab={browser.activeTab}
          entry={browser.activeEntry}
          isBookmarked={browser.isBookmarked}
          isOnline={browser.isOnline}
          canReopen={browser.hasClosedTab}
          recentPages={browser.history}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          showSuggestions={browser.preferences.showAddressSuggestions}
          downloadCount={downloads.filter((item) => item.state === 'progressing').length}
          searchEngine={browser.preferences.searchEngine}
          customSearchEngines={browser.preferences.customSearchEngines}
          onSearchEngineChange={(searchEngine) => browser.updatePreferences({ searchEngine })}
          onBack={handleBack}
          onForward={handleForward}
          onRefresh={handleRefresh}
          onStop={handleStop}
          onHome={browser.goHome}
          onNavigate={browser.navigate}
          onOpenInNewTab={browser.newTab}
          onToggleBookmark={browser.toggleBookmark}
          onBookmarks={() => browser.openInternalPage('bookmarks')}
          onHistory={() => browser.openInternalPage('history')}
          onSettings={() => browser.openInternalPage('settings')}
          onNewTab={() => browser.newTab()}
          onReopen={browser.reopenClosedTab}
          onDownloads={isDesktop ? () => desktop?.openDownloads() : undefined}
          onIncognito={isDesktop ? () => desktop?.openIncognito() : undefined}
          onFullscreen={isDesktop ? toggleFullscreen : undefined}
          onDevTools={isDesktop && isExternalPage ? toggleDevTools : undefined}
          onPrint={isDesktop && isExternalPage ? () => void printActivePage() : undefined}
          onSavePdf={isDesktop && isExternalPage ? () => void saveActivePagePdf() : undefined}
          onMenuOpenChange={setNavMenuOpen}
          readerActive={Boolean(reader?.article)}
          onToggleReader={isDesktop ? () => void toggleReader() : undefined}
          onScreenshot={isDesktop ? (options) => void captureScreenshot(options) : undefined}
          translated={translated}
          translating={translating}
          translationTarget={browser.preferences.translationTarget}
          onTranslationTargetChange={(translationTarget) => browser.updatePreferences({ translationTarget })}
          onTranslatePage={() => void translatePage()}
          onRestoreTranslation={() => void restoreTranslation()}
          adblockEnabled={Boolean(adblock?.enabled)}
          adblockSiteDisabled={adblockSiteDisabled}
          blockedCount={blockedCount}
          onToggleAdblockSite={() => void toggleAdblockSite()}
          onOpenAdblockSettings={() => browser.openInternalPage('settings')}
          passwordEntries={passwordEntries}
          onFillPassword={(entry) => void fillPassword(entry)}
          onManagePasswords={() => browser.openInternalPage('settings')}
        />
        {browser.preferences.showBookmarksBar && (
          <BookmarksBar
            bookmarks={browser.bookmarks}
            folders={browser.bookmarkFolders}
            onNavigate={browser.navigate}
            onOpenInNewTab={browser.newTab}
            onCopyLink={(url) => void copyText(url)}
            onManage={() => browser.openInternalPage('bookmarks')}
            onAdd={(folderId) => openBookmarkDialog(false, folderId)}
            onRemove={browser.removeBookmark}
            onMoveBookmark={browser.moveBookmark}
            onRemoveFolder={browser.removeBookmarkFolder}
            onReorderRoot={browser.reorderRootItem}
          />
        )}
      </header>

      <div className={`browser-content ${browser.activePanel ? 'has-panel' : ''}`}>
        <main className="web-content" aria-label="网页内容区域">
          {renderPage()}
          {isDesktop && (
            <PageHostLayer
              tabs={browser.tabs}
              activeTabId={browser.activeTabId}
              incognito={isIncognito}
              visible={showDesktopWeb}
              covered={pageCovered}
              livePreview={livePageOverlay}
              insetTop={findOpen ? 52 : 0}
              insetRight={devtoolsOpen && showDesktopWeb ? devtoolsWidth + 6 : 0}
              suspendedTabId={draggingTabId}
              pageZoom={browser.preferences.webZoom}
              pageFontSize={browser.preferences.webFontSize}
              pageFontFamily={browser.preferences.webFontFamily}
              onHandle={registerWebview}
              onNavigationState={handleNavigationState}
              onReady={handleWebReady}
            />
          )}
          {reader && (
            <div
              className={`reader-view reader-view--${readerTheme}`}
              role="document"
              aria-label="阅读模式"
              style={{
                '--reader-font-size': `${readerFontSize}px`,
                '--reader-line-height': String(readerLineHeight),
                '--reader-font-family': activeReaderFont.stack,
              } as CSSProperties}
            >
              <div className="reader-toolbar">
                <button type="button" className="reader-toolbar__exit" onClick={() => { setReader(null); setReaderSettingsOpen(false); }}>
                  <ArrowLeft size={16} />退出阅读模式
                </button>
                <div className="reader-toolbar__tools">
                  <span className="reader-toolbar__group" aria-label="字号">
                    <button type="button" aria-label="减小字号" disabled={readerFontSize <= 14} onClick={() => setReaderFontSize((size) => Math.max(14, size - 1))}><Minus size={15} /></button>
                    <Type size={15} />
                    <button type="button" aria-label="增大字号" disabled={readerFontSize >= 32} onClick={() => setReaderFontSize((size) => Math.min(32, size + 1))}><Plus size={15} /></button>
                  </span>
                  <span className="reader-toolbar__group" aria-label="阅读主题">
                    <button type="button" className={readerTheme === 'light' ? 'is-active' : ''} aria-label="浅色主题" onClick={() => setReaderTheme('light')}><Sun size={15} /></button>
                    <button type="button" className={readerTheme === 'sepia' ? 'is-active' : ''} aria-label="护眼主题" onClick={() => setReaderTheme('sepia')}><span className="reader-sepia-dot" /></button>
                    <button type="button" className={readerTheme === 'dark' ? 'is-active' : ''} aria-label="深色主题" onClick={() => setReaderTheme('dark')}><Moon size={15} /></button>
                  </span>
                  <div className="reader-settings-anchor">
                    <button
                      type="button"
                      className={readerSettingsOpen ? 'is-active' : ''}
                      aria-label="阅读字体设置"
                      aria-expanded={readerSettingsOpen}
                      onClick={() => setReaderSettingsOpen((open) => !open)}
                    >
                      <SlidersHorizontal size={15} />字体
                    </button>
                    {readerSettingsOpen && (
                      <div className="reader-settings" role="dialog" aria-label="阅读字体设置">
                        <div className="reader-settings__header">
                          <div><strong>阅读排版</strong><span>设置会保留到下次阅读</span></div>
                          <button type="button" aria-label="关闭阅读设置" onClick={() => setReaderSettingsOpen(false)}><X size={15} /></button>
                        </div>
                        <label className="reader-settings__select">
                          <span>字体</span>
                          <select value={readerFontFamily} onChange={(event) => setReaderFontFamily(event.target.value as ReaderFontFamily)}>
                            {READER_FONTS.map((font) => <option value={font.id} key={font.id}>{font.label}</option>)}
                          </select>
                        </label>
                        <label className="reader-settings__range">
                          <span>字号 <output>{readerFontSize}px</output></span>
                          <input aria-label="阅读字号" type="range" min="14" max="32" step="1" value={readerFontSize} onChange={(event) => setReaderFontSize(Number(event.target.value))} />
                        </label>
                        <label className="reader-settings__range">
                          <span>行距 <output>{readerLineHeight.toFixed(1)}</output></span>
                          <input aria-label="阅读行距" type="range" min="1.4" max="2.4" step="0.1" value={readerLineHeight} onChange={(event) => setReaderLineHeight(Number(event.target.value))} />
                        </label>
                        <p className="reader-settings__preview" style={{ fontFamily: activeReaderFont.stack }}>读书是一件安静而自由的事。</p>
                      </div>
                    )}
                  </div>
                  {reader.article && (
                    <button type="button" className="reader-toolbar__external" aria-label="在系统浏览器中打开" onClick={() => void desktop?.openExternal(reader.article!.url)}>
                      <ExternalLink size={15} />
                    </button>
                  )}
                </div>
              </div>
              {reader.loading ? (
                <div className="reader-loading" role="status"><span className="tab-spinner" />正在提取正文…</div>
              ) : reader.article && (
                <article className="reader-article">
                  <header>
                    <p className="reader-article__site">{reader.article.site}</p>
                    <h1>{reader.article.title}</h1>
                    {reader.article.byline && <p className="reader-article__byline">{reader.article.byline}</p>}
                  </header>
                  <div
                    className="reader-article__body"
                    onClick={(event) => {
                      const anchor = (event.target as Element).closest('a[href]');
                      if (!anchor) return;
                      const href = anchor.getAttribute('href');
                      if (!href) return;
                      event.preventDefault();
                      let target = href;
                      try {
                        target = new URL(href, reader.article!.url).toString();
                      } catch {
                        return;
                      }
                      if (!/^https?:/i.test(target)) return;
                      openReaderChapter(target);
                    }}
                    dangerouslySetInnerHTML={{ __html: reader.article.content }}
                  />
                  <footer className="reader-article__footer">
                    <span>已进入阅读模式 · 约 {Math.max(1, Math.round(reader.article.textLength / 400))} 分钟阅读</span>
                  </footer>
                  {(reader.article.prevUrl || reader.article.nextUrl) && (
                    <nav className="reader-chapter-nav" aria-label="章节导航">
                      <button type="button" disabled={!reader.article.prevUrl} onClick={() => openReaderChapter(reader.article?.prevUrl)}>
                        <ChevronLeft size={17} /><span>上一章</span>
                      </button>
                      <button type="button" disabled={!reader.article.nextUrl} onClick={() => openReaderChapter(reader.article?.nextUrl)}>
                        <span>下一章</span><ChevronRight size={17} />
                      </button>
                    </nav>
                  )}
                </article>
              )}
            </div>
          )}
          {findOpen && showDesktopWeb && (
            <FindBar
              query={findQuery}
              matches={findResult.matches}
              activeMatch={findResult.activeMatchOrdinal}
              onChange={setFindQuery}
              onNext={() => runFind(findQuery, true, true)}
              onPrevious={() => runFind(findQuery, false, true)}
              onClose={closeFind}
            />
          )}
          <span className="sr-only" aria-live="polite">{browser.activeTab.isLoading ? `正在加载 ${browser.activeEntry.title}` : `${browser.activeEntry.title} 加载完成`}</span>
        </main>
        {regionCapture && (
          <div
            className="region-capture"
            style={{
              left: regionCapture.left,
              top: regionCapture.top,
              width: regionCapture.width,
              height: regionCapture.height,
            }}
            role="dialog"
            aria-label="选择截图区域"
            onPointerDown={handleRegionPointerDown}
            onPointerMove={handleRegionPointerMove}
            onPointerUp={handleRegionPointerUp}
            onPointerCancel={cancelRegionCapture}
          >
            {regionRect && regionRect.width > 0 && regionRect.height > 0 ? (
              <>
                <div
                  className="region-capture__box"
                  style={{
                    left: regionRect.x,
                    top: regionRect.y,
                    width: regionRect.width,
                    height: regionRect.height,
                  }}
                >
                  <span className="region-capture__size">
                    {Math.round(regionRect.width)} × {Math.round(regionRect.height)}
                  </span>
                </div>
                {regionRect.width >= 10 && regionRect.height >= 10 && (
                  <div
                    className="region-capture__actions"
                    style={{
                      left: Math.max(8, Math.min(regionRect.x + regionRect.width - 206, regionCapture.width - 214)),
                      top: regionRect.y + regionRect.height + 40 > regionCapture.height
                        ? Math.max(8, regionRect.y - 46)
                        : regionRect.y + regionRect.height + 10,
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <button type="button" className="primary-button" onClick={() => void finishRegionCapture('save')}>
                      保存
                    </button>
                    <button type="button" className="secondary-button" onClick={() => void finishRegionCapture('copy')}>
                      复制
                    </button>
                    <button type="button" className="region-capture__cancel" onClick={cancelRegionCapture}>
                      取消
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="region-capture__hint">
                <Camera size={15} />
                <span>拖动鼠标框选截图区域</span>
                <kbd>Esc 取消</kbd>
              </div>
            )}
          </div>
        )}
        {isDesktop && desktop && devtoolsOpen && showDesktopWeb && (() => {
          const targetView = webviews.current.get(browser.activeTabId);
          return targetView ? (
            <EmbeddedDevTools
              key={browser.activeTabId}
              target={targetView}
              visible={!browser.activePanel && !navMenuOpen && permissionRequests.length === 0}
              onClose={() => setDevtoolsOpen(false)}
              openDevTools={desktop.openDevTools}
              resizeDevTools={desktop.resizeDevTools}
              setDevToolsVisible={desktop.setDevToolsVisible}
              closeDevTools={desktop.closeDevTools}
              onWidthChange={setDevtoolsWidth}
            />
          ) : null;
        })()}
        <SidePanel
          key={browser.activePanel ?? 'closed'}
          panel={browser.activePanel}
          bookmarks={browser.bookmarks}
          history={browser.history}
          onClose={() => browser.setActivePanel(null)}
          onNavigate={browser.navigate}
          onRemoveBookmark={browser.removeBookmark}
          onRemoveHistory={browser.removeHistory}
          onOpenAll={(page) => page === 'history' ? browser.openInternalPage('history') : browser.navigate(INTERNAL_ROUTES[page])}
          onOpenInNewTab={browser.newTab}
          onCopyLink={(url) => void copyText(url)}
        />
      </div>

      <MobileNavigation
        canBack={canGoBack}
        canForward={canGoForward}
        isLoading={browser.activeTab.isLoading}
        tabCount={browser.tabs.length}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onStop={handleStop}
        onHome={browser.goHome}
        onTabs={openTabOverview}
      />

      {tabOverviewOpen && (
        <TabOverview
          tabs={browser.tabs}
          activeTabId={browser.activeTabId}
          previews={tabPreviewData}
          onSelect={browser.setActiveTabId}
          onClose={browser.closeTab}
          onNew={() => browser.newTab()}
          onDismiss={() => setTabOverviewOpen(false)}
        />
      )}
      {bookmarkDialog.open && <AddBookmarkDialog initialUrl={bookmarkDialog.url} initialTitle={bookmarkDialog.title} initialFolderId={bookmarkDialog.folderId} folders={browser.bookmarkFolders} onAddFolder={browser.addBookmarkFolder} onAdd={browser.addBookmark} onClose={() => setBookmarkDialog((current) => ({ ...current, open: false }))} />}
      {pageContext && (
        <ContextMenu
          x={pageContext.menuX}
          y={pageContext.menuY}
          items={pageMenuItems}
          label="网页选项"
          onClose={() => setPageContext(null)}
        />
      )}
      {dropTarget && (
        <div className="drag-drop-hint" role="status">
          {dropTarget === 'tab'
            ? '松开以在新标签页中打开'
            : '松开以打开链接，或将文字作为搜索'}
        </div>
      )}
      {translationConsentOpen && (
        <Modal
          title="翻译会把页面文字发送给第三方"
          description="整页翻译会把提取出的正文发送到 Google Translate 或 MyMemory 进行翻译。Luma 不会发送 Cookie、密码或登录状态，但页面内容本身会离开本机。"
          onClose={() => setTranslationConsentOpen(false)}
          footer={<>
            <button className="secondary-button" type="button" onClick={() => setTranslationConsentOpen(false)}>取消</button>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setTranslationConsentOpen(false);
                browser.updatePreferences({ translationConsent: true });
                void translatePage(true);
              }}
            >
              同意并继续
            </button>
          </>}
        >
          <p className="home-url-hint">你可以随时在“设置 → 通用 → 翻译与隐私”中关闭此授权。</p>
        </Modal>
      )}
      {passwordPrompt && (
        <Modal
          title={`保存 ${passwordPrompt.host} 的登录信息？`}
          description="密码会使用系统安全存储加密后保存在本机，只在访问该网站时自动填充。"
          onClose={() => setPasswordPrompt(null)}
          footer={<>
            <button className="secondary-button" type="button" onClick={() => setPasswordPrompt(null)}>不保存</button>
            <button className="primary-button" type="button" disabled={savingPassword} onClick={() => void saveCapturedPassword()}>
              <KeyRound size={16} />{savingPassword ? '正在保存…' : '保存密码'}
            </button>
          </>}
        >
          <div className="password-save-card">
            <div><span>网站</span><strong>{passwordPrompt.host}</strong></div>
            <div><span>用户名</span><strong>{passwordPrompt.username || '（未填写）'}</strong></div>
            <div><span>密码</span><strong>{'•'.repeat(Math.min(18, Math.max(6, passwordPrompt.password.length)))}</strong></div>
          </div>
          <p className="password-save-hint">如果这不是你刚才提交的登录表单，请选择“不保存”。</p>
        </Modal>
      )}
      {permissionRequests.length > 0 && (() => {
        const request = permissionRequests[0];
        return (
          <Modal
            title={`允许 ${request.host} 使用这些权限？`}
            description={request.title ? `${request.title} 正在请求访问你的设备。` : '网站正在请求访问你的设备。'}
            onClose={() => respondToPermission('deny')}
            footer={<><button className="secondary-button" type="button" onClick={() => respondToPermission('deny')}>拒绝</button><button className="secondary-button" type="button" onClick={() => respondToPermission('always')}>始终允许</button><button className="primary-button" type="button" onClick={() => respondToPermission('allow')}>允许</button></>}
          >
            <div className="permission-prompt">
              <div className="permission-prompt__site">
                <span><ShieldCheck size={20} /></span>
                <div><strong>{request.host}</strong><small>{request.origin}</small></div>
              </div>
              <ul className="permission-prompt__list">
                {request.categories.map((category) => <li key={category}>{PERMISSION_LABELS[category] ?? category}</li>)}
              </ul>
              <p className="permission-prompt__hint">允许一次只对本次访问有效；“始终允许”会记住这个网站的选择。你可以在“设置 → 权限管理”中随时更改。</p>
            </div>
          </Modal>
        );
      })()}
      <ToastStack toasts={browser.toasts} onDismiss={browser.dismissToast} />
    </div>
  );
}
