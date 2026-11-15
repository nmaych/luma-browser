const { WebContentsView, session } = require('electron');

/**
 * Owns one WebContentsView per tab. Unlike <webview> guests, these native views
 * can be detached from one window and attached to another without reloading the
 * page, which is what the tab tear-off flow needs.
 *
 * The renderer only supplies a tab id and a rectangle; every page operation is
 * routed through this manager so the view can move between windows freely.
 */
function createPageViewManager({ partition, preloadPath, onEvent, onCreated }) {
  /** @type {Map<string, { view: Electron.WebContentsView, host: Electron.BrowserWindow | null, tabId: string }>} */
  const entries = new Map();
  /** webContents id -> tab id, so main can route page-scoped events. */
  const contentsToTab = new Map();

  const emit = (tabId, type, payload) => {
    const entry = entries.get(tabId);
    const host = entry?.host;
    if (!host || host.isDestroyed() || host.webContents.isDestroyed()) return;
    host.webContents.send('page-view:event', { tabId, type, payload });
    if (onEvent) onEvent(tabId, type, payload);
  };

  /**
   * Zoom and font overrides are re-applied after every navigation, so a page
   * that reloads in a new window keeps the user's reading preferences.
   */
  const applyAppearance = (tabId) => {
    const entry = entries.get(tabId);
    if (!entry) return;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return;
    const appearance = entry.appearance ?? {};
    if (Number.isFinite(appearance.zoom) && appearance.zoom > 0) {
      try {
        wc.setZoomFactor(appearance.zoom);
      } catch {
        // A page without a document may reject zoom changes.
      }
    }
    if (entry.cssKey) {
      void wc.removeInsertedCSS(entry.cssKey).catch(() => undefined);
      entry.cssKey = null;
    }
    if (appearance.fontCss) {
      void wc.insertCSS(appearance.fontCss).then((key) => {
        entry.cssKey = key;
      }).catch(() => undefined);
    }
  };

  const applyBounds = (view, bounds) => {
    const x = Math.round(Number(bounds?.x));
    const y = Math.round(Number(bounds?.y));
    const width = Math.round(Number(bounds?.width));
    const height = Math.round(Number(bounds?.height));
    if (![x, y, width, height].every(Number.isFinite)) return;
    view.setBounds({
      // x/y may be negative: that is how a page is parked while an HTML overlay
      // covers it without losing the window's hover state.
      x,
      y,
      width: Math.max(1, width),
      height: Math.max(1, height),
    });
  };

  const wireEvents = (tabId, view) => {
    const wc = view.webContents;
    const forward = (type, mapper) => {
      wc.on(type, (...args) => {
        try {
          emit(tabId, type, mapper ? mapper(...args) : null);
        } catch {
          // A destroyed page must not break the manager.
        }
      });
    };

    wc.on('did-start-loading', () => emit(tabId, 'start', null));
    wc.on('did-stop-loading', () => emit(tabId, 'stop', null));
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame) emit(tabId, 'start-navigation', { url: details.url, isSameDocument: details.isSameDocument });
    });
    wc.on('did-navigate', (_event, url) => emit(tabId, 'navigate', { url, isSameDocument: false }));
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) emit(tabId, 'navigate', { url, isSameDocument: true });
    });
    wc.on('page-title-updated', (_event, title) => {
      if (title) emit(tabId, 'title', { title });
    });
    wc.on('page-favicon-updated', (_event, favicons) => {
      const favicon = Array.isArray(favicons) ? favicons.filter((icon) => icon && icon !== 'data:,').at(-1) : null;
      emit(tabId, 'favicon', { favicon: favicon ?? '' });
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      // A canceled navigation is not an error.
      if (errorCode === -3) return;
      // A navigation that was superseded (fast typing, a link that replaced the
      // load) reports a failure for a URL the tab no longer shows. Treating it
      // as an error would replace a perfectly good page with the error screen.
      const current = wc.getURL();
      if (validatedURL && current && validatedURL !== current) return;
      emit(tabId, 'fail', { errorCode, errorDescription, url: validatedURL });
    });
    wc.on('dom-ready', () => {
      applyAppearance(tabId);
      emit(tabId, 'ready', null);
    });
    wc.on('media-started-playing', () => emit(tabId, 'audio', { audible: true }));
    wc.on('media-paused', () => emit(tabId, 'audio', { audible: false }));
    wc.on('found-in-page', (_event, result) => {
      emit(tabId, 'found-in-page', {
        matches: Number(result?.matches) || 0,
        activeMatchOrdinal: Number(result?.activeMatchOrdinal) || 0,
      });
    });
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') emit(tabId, 'gone', { reason: details.reason, exitCode: details.exitCode });
    });
    wc.on('context-menu', (_event, params) => emit(tabId, 'context-menu', params));
    wc.setWindowOpenHandler(({ url }) => {
      emit(tabId, 'new-window', { url });
      return { action: 'deny' };
    });
    wc.on('ipc-message', (_event, channel, ...args) => {
      if (channel === 'luma:password-captured') emit(tabId, 'password', args[0] ?? null);
    });
    forward('did-change-theme-color', (event, color) => ({ color }));
  };

  function ensure(tabId, url) {
    let entry = entries.get(tabId);
    if (entry) {
      // Reusing a live view must not reload it: that is what keeps a torn-off
      // tab running when it arrives in another window.
      const current = entry.view.webContents.isDestroyed() ? '' : entry.view.webContents.getURL();
      if (url && current !== url) void entry.view.webContents.loadURL(url).catch(() => undefined);
      return entry;
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    // Main wires navigation guards, ad blocking and shortcuts per page.
    if (onCreated) {
      try {
        onCreated(view.webContents);
      } catch (error) {
        // A feature hook must never prevent the page from loading.
        if (process.env.LUMA_DEBUG) console.error('[luma] page feature hook failed', error);
      }
    }
    entry = { view, host: null, tabId };
    entries.set(tabId, entry);
    contentsToTab.set(view.webContents.id, tabId);
    wireEvents(tabId, view);
    if (url) void view.webContents.loadURL(url).catch(() => emit(tabId, 'fail', { errorCode: -2, errorDescription: '加载失败', url }));
    return entry;
  }

  function attach(tabId, win, bounds) {
    const entry = ensure(tabId);
    if (!win || win.isDestroyed()) return false;
    if (entry.host && entry.host !== win && !entry.host.isDestroyed()) {
      try {
        entry.host.contentView.removeChildView(entry.view);
      } catch {
        // The old window may already be gone.
      }
    }
    if (entry.host !== win) {
      win.contentView.addChildView(entry.view);
      entry.host = win;
    }
    applyBounds(entry.view, bounds);
    entry.visible = true;
    entry.view.setVisible(true);
    return true;
  }

  function detach(tabId) {
    const entry = entries.get(tabId);
    if (!entry?.host) return false;
    try {
      entry.host.contentView.removeChildView(entry.view);
    } catch {
      // Ignore a window that is being torn down.
    }
    entry.host = null;
    return true;
  }

  function detachHost(win) {
    for (const entry of entries.values()) {
      if (entry.host === win) detach(entry.tabId);
    }
  }

  function setBounds(tabId, bounds) {
    const entry = entries.get(tabId);
    if (!entry) return false;
    applyBounds(entry.view, bounds);
    return true;
  }

  function setVisible(tabId, visible) {
    const entry = entries.get(tabId);
    if (!entry) return false;
    entry.visible = Boolean(visible);
    entry.view.setVisible(Boolean(visible));
    return true;
  }

  function destroy(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return false;
    detach(tabId);
    try {
      const id = entry.view.webContents.id;
      contentsToTab.delete(id);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    } catch {
      // Already destroyed.
    }
    entries.delete(tabId);
    return true;
  }

  /** True when the given window is the current host of a page. */
  function hostedBy(tabId, win) {
    const entry = entries.get(tabId);
    return Boolean(entry && entry.host && entry.host === win);
  }

  /** Destroys every page still owned by a window that is going away. */
  function destroyHosted(win) {
    for (const [tabId, entry] of [...entries.entries()]) {
      if (entry.host === win) destroy(tabId);
    }
  }

  /** Resolves the window that currently hosts a page, used to route page events. */
  function hostWindowFor(contentsId) {
    const tabId = contentsToTab.get(contentsId);
    if (!tabId) return null;
    const entry = entries.get(tabId);
    if (!entry?.host || entry.host.isDestroyed()) return null;
    return entry.host;
  }

  function tabIdFor(contentsId) {
    return contentsToTab.get(contentsId) ?? null;
  }

  function destroyAll() {
    for (const tabId of [...entries.keys()]) destroy(tabId);
  }

  function info(tabId) {
    const entry = entries.get(tabId);
    if (!entry) return null;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null;
    return {
      webContentsId: wc.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      audible: wc.isCurrentlyAudible(),
      visible: Boolean(entry.visible),
      bounds: entry.view.getBounds(),
    };
  }

  async function command(tabId, name, args = []) {
    const entry = entries.get(tabId);
    if (!entry) return null;
    const wc = entry.view.webContents;
    if (wc.isDestroyed()) return null;
    const history = wc.navigationHistory;
    switch (name) {
      case 'load': return wc.loadURL(String(args[0] || ''));
      case 'back': if (history.canGoBack()) history.goBack(); return true;
      case 'forward': if (history.canGoForward()) history.goForward(); return true;
      case 'goBack': if (history.canGoBack()) history.goBack(); return true;
      case 'goForward': if (history.canGoForward()) history.goForward(); return true;
      case 'reload': wc.reload(); return true;
      case 'stop': wc.stop(); return true;
      case 'focus': wc.focus(); return true;
      case 'executeJavaScript': return wc.executeJavaScript(String(args[0] || ''), Boolean(args[1]));
      case 'insertCSS': return wc.insertCSS(String(args[0] || ''));
      case 'removeInsertedCSS': return wc.removeInsertedCSS(String(args[0] || ''));
      case 'findInPage': return wc.findInPage(String(args[0] || ''), args[1] || {});
      case 'stopFindInPage': wc.stopFindInPage(args[0] || 'clearSelection'); return true;
      case 'setZoomFactor': wc.setZoomFactor(Number(args[0]) || 1); return true;
      case 'setAudioMuted': wc.setAudioMuted(Boolean(args[0])); return true;
      case 'setBackgroundColor': entry.view.setBackgroundColor(String(args[0] || '#ffffff')); return true;
      case 'setAppearance': {
        const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
        entry.appearance = {
          zoom: Number(payload.zoom) || 1,
          fontCss: typeof payload.fontCss === 'string' ? payload.fontCss : '',
        };
        applyAppearance(tabId);
        return true;
      }
      case 'captureSnapshot': {
        // A frame keeps the page visible while an HTML overlay covers it. The
        // live preview asks for JPEG: at several frames per second the PNG data
        // URL would cost far more to encode and decode.
        const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
        const image = await wc.capturePage();
        if (!image || image.isEmpty()) return null;
        const size = image.getSize();
        const scale = Math.min(1, 1600 / Math.max(1, size.width));
        const scaled = scale < 1
          ? image.resize({ width: Math.round(size.width * scale), quality: 'good' })
          : image;
        if (options.jpeg) {
          const quality = Math.min(100, Math.max(20, Math.round(Number(options.quality) || 60)));
          return `data:image/jpeg;base64,${scaled.toJPEG(quality).toString('base64')}`;
        }
        return scaled.toDataURL();
      }
      case 'edit': {
        const action = String(args[0] || '');
        if (action === 'copy') wc.copy();
        else if (action === 'cut') wc.cut();
        else if (action === 'paste') wc.paste();
        else if (action === 'selectAll') wc.selectAll();
        else if (action === 'undo') wc.undo();
        else if (action === 'redo') wc.redo();
        else return false;
        return true;
      }
      case 'capturePage': {
        const image = await wc.capturePage();
        return image && !image.isEmpty() ? image.toDataURL() : null;
      }
      case 'setDevTools': {
        if (args[0]) entry.view.webContents.openDevTools({ mode: 'detach' });
        else entry.view.webContents.closeDevTools();
        return true;
      }
      default: return null;
    }
  }

  return {
    ensure,
    attach,
    detach,
    detachHost,
    setBounds,
    setVisible,
    destroy,
    destroyAll,
    info,
    command,
    hostWindowFor,
    hostedBy,
    destroyHosted,
    tabIdFor,
    get webContents() {
      return [...entries.entries()].map(([tabId, entry]) => ({ tabId, webContents: entry.view.webContents }));
    },
  };
}

module.exports = { createPageViewManager };
