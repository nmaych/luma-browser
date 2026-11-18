import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BOOKMARKS, DEFAULT_PREFERENCES, createNewTab } from '../data/defaults';
import { isKnownSearchEngine, sanitizeCustomEngines, validateSearchEngineTemplate } from '../data/searchEngines';
import { sanitizeShortcuts, type ShortcutAction } from '../data/shortcuts';
import type {
  Bookmark,
  BookmarkFolder,
  BrowserError,
  BrowserTab,
  CustomSearchEngine,
  HistoryItem,
  InternalPage,
  PanelName,
  Preferences,
  TabEntry,
  ToastMessage,
} from '../types';
import { createId, readStorage, writeStorage } from '../utils/storage';
import { getCachedFavicon, faviconOrigin, rememberFavicon, resolveFavicon } from '../utils/faviconCache';
import type { ImportedBookmarkData } from '../utils/bookmarkFile';
import { matchShortcutEvent } from '../utils/shortcuts';
import { INTERNAL_ROUTES, INTERNAL_TITLES, getDefaultFavicon, isExternalUrl, parseBrowserInput } from '../utils/url';

const HISTORY_LIMIT = 5000;

const STORAGE_KEYS = {
  tabs: 'luma.tabs.v1',
  activeTab: 'luma.active-tab.v1',
  bookmarks: 'luma.bookmarks.v1',
  bookmarkFolders: 'luma.bookmark-folders.v1',
  history: 'luma.history.v1',
  preferences: 'luma.preferences.v1',
};

const isIncognito = Boolean(window.lumaDesktop?.isIncognito);
const initialTabs = window.lumaDesktop?.windowKind === 'tearoff'
  ? window.lumaDesktop?.initialTabs ?? []
  : [];
const initialActiveId = window.lumaDesktop?.windowKind === 'tearoff'
  ? window.lumaDesktop?.initialActiveId ?? null
  : null;

// A desktop window keeps its tabs across app restarts; incognito, torn-off and
// browser preview windows keep their tabs for the lifetime of the window only.
const tabStorage = window.lumaDesktop?.isDesktop && !isIncognito && initialTabs.length === 0 ? localStorage : sessionStorage;

function createTabFromInitial(tab: LumaInitialTab): BrowserTab {
  const entries = tab.entries.length > 0
    ? tab.entries.map((entry) => ({ ...entry }))
    : [{ url: INTERNAL_ROUTES.newtab, title: '新标签页', visitedAt: Date.now() }];
  const historyIndex = Math.min(Math.max(0, tab.historyIndex), entries.length - 1);
  const entry = entries[historyIndex];
  return {
    id: tab.id || createId('tab'),
    entries,
    historyIndex,
    isLoading: false,
    progress: 0,
    error: null,
    loadKey: 0,
    viewUrl: isExternalUrl(entry.url) ? entry.url : undefined,
    ...(tab.favicon ? { favicon: tab.favicon } : {}),
  };
}

type PersistedTab = Pick<BrowserTab, 'id' | 'entries' | 'historyIndex' | 'loadKey' | 'viewUrl' | 'favicon' | 'isMuted'>;

function persistableTabs(tabs: BrowserTab[]): PersistedTab[] {
  return tabs.map((tab) => ({
    id: tab.id,
    entries: tab.entries,
    historyIndex: tab.historyIndex,
    loadKey: tab.loadKey,
    viewUrl: tab.viewUrl,
    favicon: tab.favicon,
    isMuted: tab.isMuted,
  }));
}

function loadTabs(): BrowserTab[] {
  if (initialTabs.length > 0) return initialTabs.map(createTabFromInitial);
  const saved = readStorage<BrowserTab[]>(STORAGE_KEYS.tabs, [], tabStorage);
  if (
    Array.isArray(saved) &&
    saved.length > 0 &&
    saved.every((tab) => tab.id && Array.isArray(tab.entries) && tab.entries.length > 0)
  ) {
    return saved.map((tab) => {
      const entry = tab.entries[tab.historyIndex] ?? tab.entries[0];
      return {
        ...tab,
        viewUrl: tab.viewUrl ?? (isExternalUrl(entry.url) ? entry.url : undefined),
        isLoading: false,
        progress: 0,
        error: null,
        isSleeping: false,
      };
    });
  }
  return [createNewTab()];
}

export interface UseBrowserOptions {
  /** Lets the UI ask for a folder before a new bookmark is saved. */
  onRequestBookmark?: (entry: TabEntry) => void;
}

export function useBrowser(options: UseBrowserOptions = {}) {
  const { onRequestBookmark } = options;
  const [tabs, setTabs] = useState<BrowserTab[]>(loadTabs);
  const [activeTabId, setActiveTabId] = useState(() => {
    if (initialTabs.length > 0) {
      return initialActiveId && initialTabs.some((tab) => tab.id === initialActiveId)
        ? initialActiveId
        : initialTabs[0].id;
    }
    const saved = readStorage<string>(STORAGE_KEYS.activeTab, '', tabStorage);
    return saved || '';
  });
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() =>
    readStorage(STORAGE_KEYS.bookmarks, DEFAULT_BOOKMARKS),
  );
  const [bookmarkFolders, setBookmarkFolders] = useState<BookmarkFolder[]>(() => {
    const saved = readStorage<BookmarkFolder[]>(STORAGE_KEYS.bookmarkFolders, []);
    if (!Array.isArray(saved)) return [];
    return saved.filter((folder) =>
      folder && typeof folder.id === 'string' && typeof folder.name === 'string' && folder.name.trim(),
    );
  });
  const [history, setHistory] = useState<HistoryItem[]>(() =>
    // Incognito windows never load or record the persistent browsing history.
    isIncognito ? [] : readStorage(STORAGE_KEYS.history, []),
  );
  const [preferences, setPreferences] = useState<Preferences>(() => {
    const saved = readStorage<Partial<Preferences>>(STORAGE_KEYS.preferences, {});
    const customSearchEngines = sanitizeCustomEngines(saved.customSearchEngines);
    return {
      ...DEFAULT_PREFERENCES,
      ...saved,
      customSearchEngines,
      shortcuts: sanitizeShortcuts(saved.shortcuts),
      bossKey: typeof saved.bossKey === 'string' && saved.bossKey.trim()
        ? saved.bossKey
        : DEFAULT_PREFERENCES.bossKey,
      tabSleepDelayMinutes: Number.isFinite(saved.tabSleepDelayMinutes)
        ? Math.min(240, Math.max(1, Number(saved.tabSleepDelayMinutes)))
        : DEFAULT_PREFERENCES.tabSleepDelayMinutes,
      maxResidentTabs: Number.isFinite(saved.maxResidentTabs)
        ? Math.min(20, Math.max(0, Math.round(Number(saved.maxResidentTabs))))
        : DEFAULT_PREFERENCES.maxResidentTabs,
      // Older builds may contain an unsupported engine; migrate gracefully to Baidu.
      searchEngine: isKnownSearchEngine(saved.searchEngine, customSearchEngines)
        ? saved.searchEngine
        : DEFAULT_PREFERENCES.searchEngine,
    };
  });
  const [activePanel, setActivePanel] = useState<PanelName>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [hasClosedTab, setHasClosedTab] = useState(false);
  const timers = useRef(new Map<string, number[]>());
  const lastClosedTab = useRef<{ tab: BrowserTab; index: number } | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const lastActivity = useRef(new Map<string, number>());
  const previousActiveTab = useRef(activeTabId);
  const bookmarksRef = useRef(bookmarks);
  bookmarksRef.current = bookmarks;
  const requestedFavicons = useRef(new Set<string>());

  const markTabActivity = useCallback((tabId: string) => {
    lastActivity.current.set(tabId, Date.now());
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId],
  );
  const activeEntry = activeTab.entries[activeTab.historyIndex];
  const isBookmarked = bookmarks.some((bookmark) => bookmark.url === activeEntry.url);

  const showToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = createId('toast');
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 3600);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /**
   * Fills bookmark icons from the local icon cache. Each site icon is fetched at
   * most once per profile, then rendered straight from storage on later visits.
   */
  const refreshBookmarkIcons = useCallback(async (items: Bookmark[]) => {
    if (isIncognito || !window.lumaDesktop?.isDesktop) return;
    const queue: Bookmark[] = [];
    for (const item of items) {
      if (item.favicon?.startsWith('data:')) continue;
      const origin = faviconOrigin(item.url);
      if (!origin || requestedFavicons.current.has(origin)) continue;
      requestedFavicons.current.add(origin);
      queue.push(item);
    }
    for (let index = 0; index < queue.length; index += 4) {
      const chunk = queue.slice(index, index + 4);
      const icons = await Promise.all(
        chunk.map((item) => resolveFavicon(item.url, item.favicon).catch(() => undefined)),
      );
      const resolved = new Map<string, string>();
      chunk.forEach((item, position) => {
        const icon = icons[position];
        if (icon) resolved.set(item.url, icon);
      });
      if (resolved.size === 0) continue;
      setBookmarks((current) => {
        let changed = false;
        const next = current.map((bookmark) => {
          const icon = resolved.get(bookmark.url);
          if (!icon || bookmark.favicon === icon) return bookmark;
          changed = true;
          return { ...bookmark, favicon: icon };
        });
        return changed ? next : current;
      });
    }
  }, []);

  useEffect(() => {
    void refreshBookmarkIcons(bookmarksRef.current);
  }, [refreshBookmarkIcons]);

  const clearLoadingTimers = useCallback((tabId: string) => {
    timers.current.get(tabId)?.forEach(window.clearTimeout);
    timers.current.delete(tabId);
  }, []);

  const finishLoading = useCallback(
    (tabId: string) => {
      clearLoadingTimers(tabId);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId ? { ...tab, isLoading: false, progress: 100, error: null } : tab,
        ),
      );
    },
    [clearLoadingTimers],
  );

  const reportError = useCallback(
    (tabId: string, error: BrowserError) => {
      clearLoadingTimers(tabId);
      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId ? { ...tab, isLoading: false, progress: 0, error } : tab,
        ),
      );
    },
    [clearLoadingTimers],
  );

  const startLoading = useCallback(
    (tabId: string, external: boolean) => {
      clearLoadingTimers(tabId);
      if (external && !navigator.onLine) {
        reportError(tabId, {
          type: 'offline',
          title: '当前似乎已离线',
          message: '检查网络连接后，点击重新加载。你的标签页和书签已安全保留。',
        });
        return;
      }

      setTabs((current) =>
        current.map((tab) =>
          tab.id === tabId ? { ...tab, isLoading: true, progress: 14, error: null } : tab,
        ),
      );
      const tabTimers = [
        window.setTimeout(() => {
          setTabs((current) =>
            current.map((tab) =>
              tab.id === tabId && tab.isLoading ? { ...tab, progress: 48 } : tab,
            ),
          );
        }, 120),
        window.setTimeout(() => {
          setTabs((current) =>
            current.map((tab) =>
              tab.id === tabId && tab.isLoading ? { ...tab, progress: 78 } : tab,
            ),
          );
        }, 280),
      ];
      if (!external) {
        tabTimers.push(window.setTimeout(() => finishLoading(tabId), 460));
      } else {
        tabTimers.push(
          window.setTimeout(() => {
            setTabs((current) =>
              current.map((tab) =>
                tab.id === tabId && tab.isLoading ? { ...tab, progress: 91 } : tab,
              ),
            );
          }, 1100),
        );
      }
      timers.current.set(tabId, tabTimers);
    },
    [clearLoadingTimers, finishLoading, reportError],
  );

  const navigate = useCallback(
    (input: string, tabId = activeTab.id) => {
      const parsed = parseBrowserInput(input, preferences.searchEngine, preferences.customSearchEngines);
      if (!parsed.ok) {
        showToast({
          tone: 'error',
          title: '无法打开这个地址',
          description: parsed.message,
        });
        return false;
      }

      const entry = { url: parsed.url, title: parsed.title, visitedAt: Date.now() };
      markTabActivity(tabId);
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== tabId) return tab;
          const entries = [...tab.entries.slice(0, tab.historyIndex + 1), entry];
          return {
            ...tab,
            entries,
            historyIndex: entries.length - 1,
            error: null,
            favicon: parsed.isExternal ? undefined : tab.favicon,
            viewUrl: parsed.isExternal ? parsed.url : tab.viewUrl,
            loadKey: parsed.isExternal ? tab.loadKey + 1 : tab.loadKey,
          };
        }),
      );
      if (parsed.isExternal && !isIncognito) {
        setHistory((current) => [
          { id: createId('history'), ...entry, favicon: getDefaultFavicon(parsed.url) },
          ...current,
        ].slice(0, HISTORY_LIMIT));
      }
      setActivePanel(null);
      startLoading(tabId, parsed.isExternal);
      return true;
    },
    [activeTab.id, markTabActivity, preferences.customSearchEngines, preferences.searchEngine, showToast, startLoading],
  );

  const newTab = useCallback(
    (url = INTERNAL_ROUTES.newtab) => {
      const tab = createNewTab();
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      setActivePanel(null);
      if (url !== INTERNAL_ROUTES.newtab) {
        window.setTimeout(() => navigate(url, tab.id), 0);
      }
      return tab.id;
    },
    [navigate],
  );

  /** Receives a tab handed over from another Luma window. */
  const adoptTab = useCallback((incoming: LumaInitialTab) => {
    const tab = createTabFromInitial(incoming);
    const id = tabsRef.current.some((item) => item.id === tab.id) ? createId('tab') : tab.id;
    const prepared = id === tab.id ? tab : { ...tab, id };
    setTabs((current) => [...current, prepared]);
    setActiveTabId(id);
    setActivePanel(null);
    markTabActivity(id);
    return id;
  }, [markTabActivity]);

  const openInternalPage = useCallback((page: InternalPage) => {    const url = INTERNAL_ROUTES[page];
    const existing = tabsRef.current.find((tab) => tab.entries[tab.historyIndex]?.url === url);
    if (existing) {
      setActiveTabId(existing.id);
      setActivePanel(null);
      return existing.id;
    }
    const tab = createNewTab(url, INTERNAL_TITLES[page]);
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setActivePanel(null);
    return tab.id;
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.id === tabId);
        if (index < 0) return current;
        lastClosedTab.current = { tab: current[index], index };
        setHasClosedTab(true);
        clearLoadingTimers(tabId);
        if (current.length === 1) {
          const replacement = createNewTab();
          setActiveTabId(replacement.id);
          return [replacement];
        }
        if (tabId === activeTabId) {
          const next = current[Math.min(index + 1, current.length - 1)];
          const previous = current[Math.max(0, index - 1)];
          setActiveTabId(index === current.length - 1 ? previous.id : next.id);
        }
        return current.filter((tab) => tab.id !== tabId);
      });
    },
    [activeTabId, clearLoadingTimers],
  );

  /** Removes tabs that were handed over to another window, without closing the window. */
  const detachTabs = useCallback((ids: string[]) => {
    const removing = new Set(ids);
    if (removing.size === 0) return;
    setTabs((current) => {
      const remaining = current.filter((tab) => !removing.has(tab.id));
      if (remaining.length === 0) return remaining;
      // The active tab may have been handed to another window; keep a neighbour.
      if (!remaining.some((tab) => tab.id === activeTabId)) {
        const index = current.findIndex((tab) => tab.id === activeTabId);
        const fallback = remaining[Math.min(Math.max(0, index), remaining.length - 1)];
        setActiveTabId(fallback.id);
      }
      return remaining;
    });
  }, [activeTabId]);

  const closeOtherTabs = useCallback((tabId: string) => {
    setTabs((current) => {
      const selected = current.find((tab) => tab.id === tabId);
      return selected ? [selected] : current;
    });
    setActiveTabId(tabId);
    showToast({ tone: 'success', title: '已关闭其他标签页' });
  }, [showToast]);

  const closeTabsToRight = useCallback((tabId: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.id === tabId);
    if (index < 0 || index === current.length - 1) return;
    const removed = current.slice(index + 1);
    removed.forEach((tab) => clearLoadingTimers(tab.id));
    lastClosedTab.current = { tab: removed[removed.length - 1], index: current.length - 1 };
    setHasClosedTab(true);
    if (removed.some((tab) => tab.id === activeTabId)) setActiveTabId(tabId);
    setTabs(currentTabs => currentTabs.slice(0, index + 1));
    showToast({ tone: 'success', title: `已关闭右侧 ${removed.length} 个标签页` });
  }, [activeTabId, clearLoadingTimers, showToast]);

  const reorderTabs = useCallback((sourceId: string, targetId: string, position: 'before' | 'after' = 'before') => {
    if (sourceId === targetId) return;
    setTabs((current) => {
      const sourceIndex = current.findIndex((tab) => tab.id === sourceId);
      const targetIndex = current.findIndex((tab) => tab.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const moved = current[sourceIndex];
      const next = current.filter((tab) => tab.id !== sourceId);
      const targetAfterRemoval = next.findIndex((tab) => tab.id === targetId);
      const insertIndex = Math.min(next.length, Math.max(0, targetAfterRemoval + (position === 'after' ? 1 : 0)));
      next.splice(insertIndex, 0, moved);
      return next;
    });
  }, []);

  const reopenClosedTab = useCallback(() => {
    const closed = lastClosedTab.current;
    if (!closed) {
      showToast({ tone: 'info', title: '没有可恢复的标签页' });
      return;
    }
    const restored = { ...closed.tab, isLoading: false, progress: 0, error: null };
    setTabs((current) => {
      const next = [...current];
      next.splice(Math.min(closed.index, current.length), 0, restored);
      return next;
    });
    setActiveTabId(restored.id);
    lastClosedTab.current = null;
    setHasClosedTab(false);
    showToast({ tone: 'success', title: '已恢复关闭的标签页' });
  }, [showToast]);

  const goBack = useCallback(() => {
    if (activeTab.historyIndex <= 0) return;
    const nextIndex = activeTab.historyIndex - 1;
    const target = activeTab.entries[nextIndex];
    const external = isExternalUrl(target.url);
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              historyIndex: nextIndex,
              error: null,
              ...(external ? { viewUrl: target.url, loadKey: tab.loadKey + 1, favicon: undefined } : {}),
            }
          : tab,
      ),
    );
    startLoading(activeTab.id, external);
  }, [activeTab, startLoading]);

  const goForward = useCallback(() => {
    if (activeTab.historyIndex >= activeTab.entries.length - 1) return;
    const nextIndex = activeTab.historyIndex + 1;
    const target = activeTab.entries[nextIndex];
    const external = isExternalUrl(target.url);
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTab.id
          ? {
              ...tab,
              historyIndex: nextIndex,
              error: null,
              ...(external ? { viewUrl: target.url, loadKey: tab.loadKey + 1, favicon: undefined } : {}),
            }
          : tab,
      ),
    );
    startLoading(activeTab.id, external);
  }, [activeTab, startLoading]);

  const refresh = useCallback(() => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== activeTab.id) return tab;
        const external = isExternalUrl(activeEntry.url);
        return {
          ...tab,
          isLoading: external ? tab.isLoading : false,
          loadKey: external ? tab.loadKey + 1 : tab.loadKey,
          error: null,
          ...(external ? { viewUrl: activeEntry.url, favicon: undefined } : {}),
        };
      }),
    );
    startLoading(activeTab.id, isExternalUrl(activeEntry.url));
  }, [activeEntry.url, activeTab.id, startLoading]);

  /** Prepares native reload feedback without creating a second navigation request. */
  const beginWebReload = useCallback((tabId: string) => {
    clearLoadingTimers(tabId);
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId ? { ...tab, isLoading: true, progress: 18, error: null } : tab,
      ),
    );
  }, [clearLoadingTimers]);

  const startWebLoading = useCallback((tabId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId ? { ...tab, isLoading: true, progress: Math.max(tab.progress, 28) } : tab,
      ),
    );
  }, []);

  const finishWebLoading = useCallback((tabId: string) => {
    clearLoadingTimers(tabId);
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId ? { ...tab, isLoading: false, progress: 100 } : tab,
      ),
    );
  }, [clearLoadingTimers]);

  const syncWebPage = useCallback((tabId: string, url: string) => {
    if (!isExternalUrl(url)) return;
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab) return;
    const currentEntry = tab.entries[tab.historyIndex];
    if (currentEntry.url === url) return;

    setTabs((current) =>
      current.map((item) => {
        if (item.id !== tabId) return item;
        const entry = item.entries[item.historyIndex];
        if (!isExternalUrl(entry.url)) return item;
        const entries = item.entries.map((candidate, index) =>
          index === item.historyIndex ? { ...candidate, url, visitedAt: Date.now() } : candidate,
        );
        return { ...item, entries };
      }),
    );
    if (!isIncognito) {
      setHistory((current) => [
        {
          id: createId('history'),
          title: url,
          url,
          visitedAt: Date.now(),
          favicon: tab.favicon || getDefaultFavicon(url),
        },
        ...current,
      ].slice(0, HISTORY_LIMIT));
    }
  }, []);

  const syncWebTitle = useCallback((tabId: string, title: string) => {
    const cleanTitle = title.trim() || '未命名页面';
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const entry = tab?.entries[tab.historyIndex];
    if (!tab || !entry || !isExternalUrl(entry.url)) return;

    setTabs((current) =>
      current.map((item) => {
        if (item.id !== tabId) return item;
        const entries = item.entries.map((candidate, index) =>
          index === item.historyIndex ? { ...candidate, title: cleanTitle } : candidate,
        );
        return { ...item, entries };
      }),
    );
    setHistory((items) =>
      items[0]?.url === entry.url
        ? [{ ...items[0], title: cleanTitle }, ...items.slice(1)]
        : items,
    );
  }, []);

  /** Copies the live page icon so tabs, bookmarks and history reflect the real site. */
  const syncWebFavicon = useCallback((tabId: string, favicon: string) => {
    const tab = tabsRef.current.find((item) => item.id === tabId);
    const entry = tab?.entries[tab.historyIndex];
    if (!tab || !entry || !isExternalUrl(entry.url)) return;
    const url = entry.url;
    const nextFavicon = favicon && favicon !== 'data:,' ? favicon : undefined;
    setTabs((current) =>
      current.map((item) => {
        if (item.id !== tabId) return item;
        return item.favicon === nextFavicon ? item : { ...item, favicon: nextFavicon };
      }),
    );
    if (!nextFavicon) return;
    const applyCachedIcon = (icon: string) => {
      setBookmarks((current) => {
        if (!current.some((bookmark) => bookmark.url === url && bookmark.favicon !== icon)) return current;
        return current.map((bookmark) => bookmark.url === url ? { ...bookmark, favicon: icon } : bookmark);
      });
      setHistory((current) => {
        if (!current.some((item) => item.url === url && item.favicon !== icon)) return current;
        return current.map((item) => item.url === url ? { ...item, favicon: icon } : item);
      });
    };
    if (nextFavicon.startsWith('data:')) {
      rememberFavicon(url, nextFavicon);
      applyCachedIcon(nextFavicon);
      return;
    }
    // Live icons arrive as URLs; keep a local copy so lists never refetch them.
    void resolveFavicon(url, nextFavicon)
      .then((icon) => {
        if (icon) applyCachedIcon(icon);
      })
      .catch(() => undefined);
  }, []);

  const goHome = useCallback(() => {
    const target = preferences.homePage?.trim();
    navigate(target || INTERNAL_ROUTES.home);
  }, [navigate, preferences.homePage]);

  const setTabAudible = useCallback((tabId: string, audible: boolean) => {
    if (audible) markTabActivity(tabId);
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        if (tab.id !== tabId || Boolean(tab.isAudible) === audible) return tab;
        changed = true;
        return { ...tab, isAudible: audible };
      });
      return changed ? next : current;
    });
  }, [markTabActivity]);

  const toggleTabMute = useCallback((tabId: string) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, isMuted: !tab.isMuted } : tab)),
    );
  }, []);

  const canSleepTab = useCallback((tab: BrowserTab) => {
    const entry = tab.entries[tab.historyIndex];
    return tab.id !== activeTabId
      && !tab.isSleeping
      && Boolean(tab.viewUrl)
      && isExternalUrl(entry.url)
      && !tab.isLoading
      && !tab.isAudible;
  }, [activeTabId]);

  const sleepTab = useCallback((tabId: string) => {
    setTabs((current) => current.map((tab) => (
      tab.id === tabId && canSleepTab(tab)
        ? { ...tab, isSleeping: true, isLoading: false, progress: 0 }
        : tab
    )));
  }, [canSleepTab]);

  const sleepBackgroundTabs = useCallback(() => {
    const candidates = tabsRef.current.filter(canSleepTab);
    if (candidates.length === 0) {
      showToast({ tone: 'info', title: '没有可休眠的后台标签页' });
      return;
    }
    const ids = new Set(candidates.map((tab) => tab.id));
    setTabs((current) => current.map((tab) => (
      ids.has(tab.id) ? { ...tab, isSleeping: true, isLoading: false, progress: 0 } : tab
    )));
    showToast({
      tone: 'success',
      title: `已休眠 ${ids.size} 个后台标签页`,
      description: '占用的内存已释放，点击标签页即可重新加载。',
    });
  }, [canSleepTab, showToast]);

  const wakeTab = useCallback((tabId: string) => {
    markTabActivity(tabId);
    setTabs((current) => current.map((tab) => (
      tab.id === tabId && tab.isSleeping
        ? {
            ...tab,
            isSleeping: false,
            isLoading: Boolean(tab.viewUrl),
            progress: 0,
            loadKey: tab.viewUrl ? tab.loadKey + 1 : tab.loadKey,
          }
        : tab
    )));
  }, [markTabActivity]);

  const toggleBookmark = useCallback(() => {
    const existing = bookmarks.find((bookmark) => bookmark.url === activeEntry.url);
    if (existing) {
      setBookmarks((current) => current.filter((bookmark) => bookmark.id !== existing.id));
      showToast({ tone: 'success', title: '已从书签中移除' });
      return;
    }
    if (activeEntry.url === INTERNAL_ROUTES.home || activeEntry.url === INTERNAL_ROUTES.newtab) {
      showToast({ tone: 'info', title: '新标签页无需添加书签' });
      return;
    }
    if (onRequestBookmark) {
      onRequestBookmark(activeEntry);
      return;
    }
    const liveFavicon = tabsRef.current.find((tab) => tab.id === activeTab.id)?.favicon;
    if (liveFavicon?.startsWith('data:')) rememberFavicon(activeEntry.url, liveFavicon);
    const bookmark: Bookmark = {
      id: createId('bookmark'),
      title: activeEntry.title,
      url: activeEntry.url,
      createdAt: Date.now(),
      favicon: getCachedFavicon(activeEntry.url)
        || (liveFavicon?.startsWith('data:') ? liveFavicon : undefined),
    };
    setBookmarks((current) => [...current, bookmark]);
    void refreshBookmarkIcons([bookmark]);
    showToast({ tone: 'success', title: '已添加到书签', description: activeEntry.title });
  }, [activeEntry, bookmarks, onRequestBookmark, refreshBookmarkIcons, showToast]);

  const addBookmark = useCallback(
    (title: string, url: string, folderId?: string) => {
      const parsed = parseBrowserInput(url, preferences.searchEngine, preferences.customSearchEngines);
      const isSearchQuery = parsed.isExternal && parsed.title === `${url.trim()} - 搜索`;
      if (!parsed.ok || !parsed.url || isSearchQuery) {
        showToast({
          tone: 'error',
          title: '书签地址无效',
          description: parsed.message ?? '请输入完整的网页地址，例如 example.com',
        });
        return false;
      }
      if (bookmarks.some((bookmark) => bookmark.url === parsed.url)) {
        showToast({ tone: 'info', title: '这个页面已经在书签中了' });
        return false;
      }
      const validFolderId = folderId && bookmarkFolders.some((folder) => folder.id === folderId)
        ? folderId
        : undefined;
      const openTab = tabsRef.current.find(
        (tab) => tab.entries[tab.historyIndex]?.url === parsed.url,
      );
      if (openTab?.favicon?.startsWith('data:')) rememberFavicon(parsed.url, openTab.favicon);
      const bookmark: Bookmark = {
        id: createId('bookmark'),
        title: title.trim() || parsed.title,
        url: parsed.url,
        createdAt: Date.now(),
        favicon: getCachedFavicon(parsed.url)
          || (openTab?.favicon?.startsWith('data:') ? openTab.favicon : undefined),
        ...(validFolderId ? { folderId: validFolderId } : {}),
      };
      setBookmarks((current) => [...current, bookmark]);
      void refreshBookmarkIcons([bookmark]);
      showToast({
        tone: 'success',
        title: '书签已添加',
        description: validFolderId
          ? `已保存到「${bookmarkFolders.find((folder) => folder.id === validFolderId)?.name}」`
          : undefined,
      });
      return true;
    },
    [bookmarkFolders, bookmarks, preferences.customSearchEngines, preferences.searchEngine, refreshBookmarkIcons, showToast],
  );

  const removeBookmark = useCallback((id: string) => {
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== id));
    showToast({ tone: 'success', title: '书签已删除' });
  }, [showToast]);

  const importBookmarkData = useCallback((data: ImportedBookmarkData) => {
    const folderIds = new Map(bookmarkFolders.map((folder) => [folder.name.toLowerCase(), folder.id]));
    const newFolders: BookmarkFolder[] = [];
    for (const name of data.folders) {
      const key = name.toLowerCase();
      if (folderIds.has(key)) continue;
      const folder: BookmarkFolder = { id: createId('folder'), name, createdAt: Date.now() };
      folderIds.set(key, folder.id);
      newFolders.push(folder);
    }

    const knownUrls = new Set(bookmarks.map((bookmark) => bookmark.url));
    const newBookmarks: Bookmark[] = [];
    let skipped = 0;
    for (const item of data.bookmarks) {
      if (knownUrls.has(item.url)) {
        skipped += 1;
        continue;
      }
      knownUrls.add(item.url);
      const folderId = item.folder ? folderIds.get(item.folder.toLowerCase()) : undefined;
      newBookmarks.push({
        id: createId('bookmark'),
        title: item.title || item.url,
        url: item.url,
        createdAt: Date.now(),
        favicon: getCachedFavicon(item.url),
        ...(folderId ? { folderId } : {}),
      });
    }

    if (newFolders.length) setBookmarkFolders((current) => [...current, ...newFolders]);
    if (newBookmarks.length) {
      setBookmarks((current) => [...current, ...newBookmarks]);
      void refreshBookmarkIcons(newBookmarks);
    }
    showToast({
      tone: newBookmarks.length ? 'success' : 'info',
      title: newBookmarks.length ? `已导入 ${newBookmarks.length} 个书签` : '没有新的书签可导入',
      description: [
        newFolders.length ? `新增 ${newFolders.length} 个文件夹` : '',
        skipped ? `跳过 ${skipped} 个重复书签` : '',
      ].filter(Boolean).join('，') || undefined,
    });
    return { added: newBookmarks.length, skipped, folders: newFolders.length };
  }, [bookmarkFolders, bookmarks, refreshBookmarkIcons, showToast]);

  const addBookmarkFolder = useCallback((name: string) => {
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) {
      showToast({ tone: 'error', title: '请输入文件夹名称' });
      return null;
    }
    if (bookmarkFolders.some((folder) => folder.name.toLowerCase() === cleanName.toLowerCase())) {
      showToast({ tone: 'info', title: '同名文件夹已存在' });
      return null;
    }
    const folder: BookmarkFolder = {
      id: createId('folder'),
      name: cleanName,
      createdAt: Date.now(),
    };
    setBookmarkFolders((current) => [...current, folder]);
    showToast({ tone: 'success', title: '文件夹已创建', description: cleanName });
    return folder.id;
  }, [bookmarkFolders, showToast]);

  const renameBookmarkFolder = useCallback((id: string, name: string) => {
    const cleanName = name.trim().slice(0, 40);
    if (!cleanName) {
      showToast({ tone: 'error', title: '请输入文件夹名称' });
      return false;
    }
    if (bookmarkFolders.some((folder) => folder.id !== id && folder.name.toLowerCase() === cleanName.toLowerCase())) {
      showToast({ tone: 'info', title: '同名文件夹已存在' });
      return false;
    }
    setBookmarkFolders((current) =>
      current.map((folder) => folder.id === id ? { ...folder, name: cleanName } : folder),
    );
    showToast({ tone: 'success', title: '文件夹已重命名' });
    return true;
  }, [bookmarkFolders, showToast]);

  const removeBookmarkFolder = useCallback((id: string) => {
    setBookmarkFolders((current) => current.filter((folder) => folder.id !== id));
    setBookmarks((current) =>
      current.map((bookmark) => {
        if (bookmark.folderId !== id) return bookmark;
        return { ...bookmark, folderId: undefined };
      }),
    );
    showToast({ tone: 'success', title: '文件夹已删除', description: '其中的书签已移至未分类' });
  }, [showToast]);

  const moveBookmark = useCallback((bookmarkId: string, folderId?: string) => {
    const validFolder = folderId && bookmarkFolders.some((folder) => folder.id === folderId)
      ? folderId
      : undefined;
    setBookmarks((current) =>
      current.map((bookmark) => {
        if (bookmark.id !== bookmarkId) return bookmark;
        if (!validFolder) {
          return { ...bookmark, folderId: undefined };
        }
        return { ...bookmark, folderId: validFolder };
      }),
    );
    showToast({ tone: 'success', title: validFolder ? '书签已移动' : '书签已移至未分类' });
  }, [bookmarkFolders, showToast]);

  const reorderBookmarks = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setBookmarks((current) => {
      const sourceIndex = current.findIndex((bookmark) => bookmark.id === sourceId);
      const targetIndex = current.findIndex((bookmark) => bookmark.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  const reorderBookmarkFolders = useCallback((sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    setBookmarkFolders((current) => {
      const sourceIndex = current.findIndex((folder) => folder.id === sourceId);
      const targetIndex = current.findIndex((folder) => folder.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);

  /** Reorders root bookmarks and folders as one list so they can interleave. */
  const reorderRootItem = useCallback((
    sourceKind: 'bookmark' | 'folder',
    sourceId: string,
    targetKind: 'bookmark' | 'folder' | null,
    targetId: string | null,
    position: 'before' | 'after' | 'end',
  ) => {
    const folderIds = new Set(bookmarkFolders.map((folder) => folder.id));
    const effectiveOrder = (item: { order?: number; createdAt?: number }) =>
      item.order ?? item.createdAt ?? 0;
    const rootBookmarks = bookmarks.filter(
      (bookmark) => !bookmark.folderId || !folderIds.has(bookmark.folderId),
    );
    const nodes: Array<{ kind: 'bookmark' | 'folder'; id: string; order: number }> = [
      ...rootBookmarks.map((bookmark) => ({
        kind: 'bookmark' as const,
        id: bookmark.id,
        order: effectiveOrder(bookmark),
      })),
      ...bookmarkFolders.map((folder) => ({
        kind: 'folder' as const,
        id: folder.id,
        order: effectiveOrder(folder),
      })),
    ].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));

    const sourceBookmark = sourceKind === 'bookmark'
      ? bookmarks.find((bookmark) => bookmark.id === sourceId)
      : undefined;
    if (sourceKind === 'bookmark' && !sourceBookmark) return;
    const sourceIndex = nodes.findIndex((node) => node.kind === sourceKind && node.id === sourceId);
    if (sourceKind === 'folder' && sourceIndex < 0) return;

    const moved = sourceIndex >= 0
      ? nodes.splice(sourceIndex, 1)[0]
      : { kind: sourceKind, id: sourceId, order: Number.MAX_SAFE_INTEGER };

    let insertIndex = nodes.length;
    if (position !== 'end') {
      const targetIndex = nodes.findIndex(
        (node) => node.kind === targetKind && node.id === targetId,
      );
      if (targetIndex < 0) return;
      insertIndex = position === 'after' ? targetIndex + 1 : targetIndex;
    }
    nodes.splice(insertIndex, 0, moved);

    const orderById = new Map(nodes.map((node, index) => [node.id, index]));
    setBookmarks((current) => current.map((bookmark) => {
      const isRoot = !bookmark.folderId || !folderIds.has(bookmark.folderId);
      const nextOrder = orderById.get(bookmark.id);
      if (sourceKind === 'bookmark' && bookmark.id === sourceId) {
        return { ...bookmark, folderId: undefined, order: nextOrder };
      }
      if (!isRoot || nextOrder === undefined) return bookmark;
      return { ...bookmark, order: nextOrder };
    }));
    setBookmarkFolders((current) => current.map((folder) => {
      const nextOrder = orderById.get(folder.id);
      return nextOrder === undefined ? folder : { ...folder, order: nextOrder };
    }));
  }, [bookmarkFolders, bookmarks]);

  const removeHistory = useCallback((id: string) => {
    setHistory((current) => current.filter((item) => item.id !== id));
  }, []);

  const removeHistoryMany = useCallback((ids: string[]) => {
    const removeIds = new Set(ids);
    setHistory((current) => current.filter((item) => !removeIds.has(item.id)));
    showToast({ tone: 'success', title: `已删除 ${removeIds.size} 条历史记录` });
  }, [showToast]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    showToast({ tone: 'success', title: '浏览历史已清空' });
  }, [showToast]);

  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => ({ ...current, ...patch }));
  }, []);

  const addCustomSearchEngine = useCallback((name: string, urlTemplate: string) => {
    const cleanName = name.trim();
    const cleanTemplate = urlTemplate.trim();
    const templateError = validateSearchEngineTemplate(cleanTemplate);
    if (!cleanName) {
      showToast({ tone: 'error', title: '请输入搜索引擎名称' });
      return false;
    }
    if (templateError) {
      showToast({ tone: 'error', title: '搜索地址格式不正确', description: templateError });
      return false;
    }
    if (preferences.customSearchEngines.some((engine) => engine.urlTemplate === cleanTemplate)) {
      showToast({ tone: 'info', title: '这个搜索引擎已经存在' });
      return false;
    }
    const engine: CustomSearchEngine = {
      id: `custom:${createId('engine')}`,
      name: cleanName.slice(0, 30),
      urlTemplate: cleanTemplate,
      createdAt: Date.now(),
    };
    setPreferences((current) => ({
      ...current,
      searchEngine: engine.id,
      customSearchEngines: [...current.customSearchEngines, engine],
    }));
    showToast({ tone: 'success', title: '搜索引擎已添加', description: `${engine.name} 已设为默认引擎` });
    return true;
  }, [preferences.customSearchEngines, showToast]);

  const removeCustomSearchEngine = useCallback((id: string) => {
    setPreferences((current) => ({
      ...current,
      searchEngine: current.searchEngine === id ? 'baidu' : current.searchEngine,
      customSearchEngines: current.customSearchEngines.filter((engine) => engine.id !== id),
    }));
    showToast({ tone: 'success', title: '自定义搜索引擎已删除' });
  }, [showToast]);

  const resetData = useCallback(() => {
    const tab = createNewTab();
    setTabs([tab]);
    setActiveTabId(tab.id);
    setBookmarks(DEFAULT_BOOKMARKS);
    setBookmarkFolders([]);
    setHistory([]);
    setPreferences(DEFAULT_PREFERENCES);
    setActivePanel(null);
    showToast({ tone: 'success', title: '已恢复默认状态' });
  }, [showToast]);

  useEffect(() => {
    if (activeTab.id !== activeTabId) setActiveTabId(activeTab.id);
  }, [activeTab.id, activeTabId]);

  // Persist in the background. Progress updates can fire several times per
  // second, so writing the whole tab tree synchronously each time would block
  // the UI once a few tabs are open.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeStorage(STORAGE_KEYS.tabs, persistableTabs(tabs), tabStorage);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [tabs]);
  useEffect(() => writeStorage(STORAGE_KEYS.activeTab, activeTab.id, tabStorage), [activeTab.id]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStorage(STORAGE_KEYS.bookmarks, bookmarks), 300);
    return () => window.clearTimeout(timer);
  }, [bookmarks]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStorage(STORAGE_KEYS.bookmarkFolders, bookmarkFolders), 300);
    return () => window.clearTimeout(timer);
  }, [bookmarkFolders]);
  useEffect(() => {
    if (isIncognito) return undefined;
    const timer = window.setTimeout(() => writeStorage(STORAGE_KEYS.history, history), 800);
    return () => window.clearTimeout(timer);
  }, [history]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStorage(STORAGE_KEYS.preferences, preferences), 300);
    return () => window.clearTimeout(timer);
  }, [preferences]);

  const persistSnapshot = useRef({ tabs, bookmarks, bookmarkFolders, history, preferences });
  persistSnapshot.current = { tabs, bookmarks, bookmarkFolders, history, preferences };
  useEffect(() => {
    const flush = () => {
      const snapshot = persistSnapshot.current;
      writeStorage(STORAGE_KEYS.tabs, persistableTabs(snapshot.tabs), tabStorage);
      writeStorage(STORAGE_KEYS.bookmarks, snapshot.bookmarks);
      writeStorage(STORAGE_KEYS.bookmarkFolders, snapshot.bookmarkFolders);
      if (!isIncognito) writeStorage(STORAGE_KEYS.history, snapshot.history);
      writeStorage(STORAGE_KEYS.preferences, snapshot.preferences);
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    applyTheme();
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [preferences.theme]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      showToast({ tone: 'error', title: '网络连接已断开', description: '内置页面和本地数据仍可使用' });
      if (isExternalUrl(activeEntry.url) && activeTab.isLoading) {
        reportError(activeTab.id, {
          type: 'offline',
          title: '网络连接已断开',
          message: '重新连接网络后再试，或返回上一个页面。',
        });
      }
    };
    const handleOnline = () => {
      setIsOnline(true);
      showToast({ tone: 'success', title: '网络已恢复', description: '现在可以重新加载页面' });
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [activeEntry.url, activeTab.id, activeTab.isLoading, reportError, showToast]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'F5' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        refresh();
        return;
      }
      // Ctrl+Tab / Ctrl+Shift+Tab (and Ctrl+PageDown/PageUp) cycle tabs. Every
      // mainstream browser keeps these fixed instead of exposing them as
      // rebindable shortcuts, so they bypass the preference table.
      if (
        event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp')
      ) {
        event.preventDefault();
        const list = tabsRef.current;
        if (list.length < 2) return;
        const index = list.findIndex((tab) => tab.id === activeTab.id);
        if (index < 0) return;
        const forward = event.key === 'Tab' ? !event.shiftKey : event.key === 'PageDown';
        const next = (index + (forward ? 1 : -1) + list.length) % list.length;
        setActiveTabId(list[next].id);
        return;
      }
      const shortcuts = preferences.shortcuts;
      let action: ShortcutAction | null = null;
      for (const candidate of Object.keys(shortcuts) as ShortcutAction[]) {
        if (matchShortcutEvent(event, shortcuts[candidate])) {
          action = candidate;
          break;
        }
      }
      if (!action) return;
      switch (action) {
        case 'new-tab': newTab(); break;
        case 'close-tab': closeTab(activeTab.id); break;
        case 'reopen-tab': reopenClosedTab(); break;
        case 'focus-address': document.getElementById('browser-address')?.focus(); break;
        case 'reload': refresh(); break;
        case 'bookmark': toggleBookmark(); break;
        case 'history': openInternalPage('history'); break;
        case 'toggle-bookmarks':
          updatePreferences({ showBookmarksBar: !preferences.showBookmarksBar });
          break;
        case 'back': goBack(); break;
        case 'forward': goForward(); break;
        case 'sleep-tabs': sleepBackgroundTabs(); break;
        // Window-level actions (downloads, incognito, devtools, reader, translate)
        // are handled by App so this listener never prevents them.
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [
    activeTab.id,
    closeTab,
    goBack,
    goForward,
    newTab,
    openInternalPage,
    preferences.shortcuts,
    preferences.showBookmarksBar,
    refresh,
    reopenClosedTab,
    sleepBackgroundTabs,
    toggleBookmark,
    updatePreferences,
  ]);

  useEffect(() => {
    const now = Date.now();
    tabsRef.current.forEach((tab) => lastActivity.current.set(tab.id, now));
  }, []);

  useEffect(() => {
    const now = Date.now();
    const previous = previousActiveTab.current;
    if (previous && previous !== activeTabId) lastActivity.current.set(previous, now);
    previousActiveTab.current = activeTabId;
    markTabActivity(activeTabId);
    const tab = tabsRef.current.find((item) => item.id === activeTabId);
    if (tab?.isSleeping) wakeTab(activeTabId);
  }, [activeTabId, markTabActivity, wakeTab]);

  useEffect(() => {
    const limit = preferences.maxResidentTabs;
    if (!limit || isIncognito) return;
    const residents = tabsRef.current.filter((tab) => (
      !tab.isSleeping
      && Boolean(tab.viewUrl)
      && isExternalUrl(tab.entries[tab.historyIndex]?.url ?? '')
    ));
    if (residents.length <= limit) return;
    const candidates = residents
      .filter(canSleepTab)
      .sort((left, right) => (lastActivity.current.get(left.id) ?? 0) - (lastActivity.current.get(right.id) ?? 0));
    const sleepCount = Math.min(candidates.length, residents.length - limit);
    if (sleepCount <= 0) return;
    const ids = new Set(candidates.slice(0, sleepCount).map((tab) => tab.id));
    setTabs((current) => current.map((tab) => (
      ids.has(tab.id) ? { ...tab, isSleeping: true, isLoading: false, progress: 0 } : tab
    )));
  }, [activeTabId, canSleepTab, preferences.maxResidentTabs, tabs]);

  useEffect(() => {
    if (!preferences.tabSleepEnabled || isIncognito) return undefined;
    const delay = Math.max(1, preferences.tabSleepDelayMinutes) * 60_000;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setTabs((current) => {
        let changed = false;
        const next = current.map((tab) => {
          if (tab.id === activeTabId || tab.isSleeping) return tab;
          const entry = tab.entries[tab.historyIndex];
          if (!tab.viewUrl || !isExternalUrl(entry.url) || tab.isLoading || tab.isAudible) return tab;
          const last = lastActivity.current.get(tab.id) ?? 0;
          if (now - last < delay) return tab;
          changed = true;
          return { ...tab, isSleeping: true, isLoading: false, progress: 0 };
        });
        return changed ? next : current;
      });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [activeTabId, preferences.tabSleepDelayMinutes, preferences.tabSleepEnabled]);

  useEffect(() => () => {
    timers.current.forEach((tabTimers) => tabTimers.forEach(window.clearTimeout));
  }, []);

  return {
    tabs,
    activeTab,
    activeEntry,
    activeTabId: activeTab.id,
    bookmarks,
    bookmarkFolders,
    history,
    preferences,
    activePanel,
    toasts,
    isOnline,
    isBookmarked,
    hasClosedTab,
    isIncognito,
    setActiveTabId,
    setActivePanel,
    navigate,
    newTab,
    adoptTab,
    openInternalPage,
    closeTab,
    detachTabs,
    closeOtherTabs,
    closeTabsToRight,
    reorderTabs,
    reopenClosedTab,
    goBack,
    goForward,
    refresh,
    beginWebReload,
    startWebLoading,
    finishWebLoading,
    syncWebPage,
    syncWebTitle,
    syncWebFavicon,
    setTabAudible,
    toggleTabMute,
    sleepTab,
    sleepBackgroundTabs,
    wakeTab,
    markTabActivity,
    goHome,
    finishLoading,
    reportError,
    toggleBookmark,
    addBookmark,
    removeBookmark,
    importBookmarkData,
    addBookmarkFolder,
    renameBookmarkFolder,
    removeBookmarkFolder,
    moveBookmark,
    reorderBookmarks,
    reorderBookmarkFolders,
    reorderRootItem,
    removeHistory,
    removeHistoryMany,
    clearHistory,
    updatePreferences,
    addCustomSearchEngine,
    removeCustomSearchEngine,
    resetData,
    dismissToast,
    showToast,
  };
}

export type BrowserController = ReturnType<typeof useBrowser>;
