import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrowserTab } from '../../types';
import { NativePageHandle, type PageHandle, type PageRect } from '../../app/pageHandle';

interface PageHostLayerProps {
  tabs: BrowserTab[];
  activeTabId: string;
  incognito: boolean;
  /** The active tab shows a real web page (false for internal luma:// pages). */
  visible: boolean;
  /** An HTML overlay (menu, panel, dialog) covers the page area. */
  covered: boolean;
  /** Visible pages need this much empty space at the top, e.g. for the find bar. */
  insetTop?: number;
  /** Docked developer tools need room on the right. */
  insetRight?: number;
  /** A tab whose page is temporarily owned by a drag window. */
  suspendedTabId?: string | null;
  /**
   * Changes when the chrome is shown or hidden (fullscreen). The native view
   * has to be re-measured in the same commit as that layout change; relying on
   * the resize observer alone left it covering the toolbar now and then.
   */
  layoutToken?: string;
  pageZoom: number;
  pageFontSize: number;
  pageFontFamily: string;
  onHandle: (tabId: string, handle: PageHandle | null) => void;
  onReady?: (tabId: string) => void;
  onNavigationState?: (tabId: string, canGoBack: boolean, canGoForward: boolean) => void;
}

const EMPTY_RECT: PageRect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };

/**
 * Resolves once the frame can be painted in the same tick it is inserted.
 * Without this the still frame is still being decoded when the native page
 * steps aside, which shows up as a flash of white on heavy pages.
 */
function decodeFrame(data: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = data;
    if (typeof image.decode === 'function') {
      image.decode().then(() => resolve(true)).catch(() => resolve(false));
    }
  });
}

function clampRect(element: HTMLElement | null, insetTop: number, insetRight: number): PageRect {
  if (!element) return EMPTY_RECT;
  const rect = element.getBoundingClientRect();
  const top = rect.top + insetTop;
  const height = Math.max(1, rect.height - insetTop);
  const width = Math.max(1, rect.width - insetRight);
  return {
    left: Math.round(rect.left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
    right: Math.round(rect.left + width),
    bottom: Math.round(top + height),
    x: Math.round(rect.left),
    y: Math.round(top),
  };
}

function fontStylesheet(size: number, family: string): string {
  const fontSize = Math.min(28, Math.max(10, Math.round(size) || 16));
  const safeFamily = family.replace(/[^\w\s,'"-]/g, '').trim();
  return `html, body { font-size: ${fontSize}px !important;${safeFamily ? ` font-family: ${safeFamily} !important;` : ''} }`;
}

/**
 * Owns the native page surface. The renderer only reports a rectangle; the main
 * process positions the WebContentsView, which is why a page can be handed to
 * another window without a reload.
 */
export function PageHostLayer({
  tabs,
  activeTabId,
  incognito,
  visible,
  covered,
  insetTop = 0,
  insetRight = 0,
  suspendedTabId = null,
  layoutToken = '',
  pageZoom,
  pageFontSize,
  pageFontFamily,
  onHandle,
  onReady,
  onNavigationState,
}: PageHostLayerProps) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const handles = useRef(new Map<string, NativePageHandle>());
  const loadedUrls = useRef(new Map<string, string>());
  const [snapshot, setSnapshot] = useState<{ tabId: string; data: string } | null>(null);
  const lastFrame = useRef(new Map<string, string>());
  // The page is only moved aside once the still frame is in the document, so
  // opening a menu never shows an empty page area for a frame.
  const [parked, setParked] = useState(false);
  const onHandleRef = useRef(onHandle);
  onHandleRef.current = onHandle;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onNavigationStateRef = useRef(onNavigationState);
  onNavigationStateRef.current = onNavigationState;

  const liveTabs = useMemo(
    () => tabs.filter((tab) => Boolean(tab.viewUrl) && !tab.isSleeping),
    [tabs],
  );

  const measure = useCallback(
    () => clampRect(areaRef.current, insetTop, insetRight),
    [insetRight, insetTop],
  );

  /** Pushes the page's real history state to the toolbar buttons. */
  const reportNavigation = useCallback((tabId: string, handle: NativePageHandle) => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) return;
    void bridge.info(tabId, incognito).then((info) => {
      if (!info) return;
      handle.applyInfo(info);
      onNavigationStateRef.current?.(tabId, Boolean(info.canGoBack), Boolean(info.canGoForward));
    }).catch(() => undefined);
  }, [incognito]);

  const appearance = useMemo(
    () => ({ zoom: Math.min(2, Math.max(0.5, pageZoom / 100)), fontCss: fontStylesheet(pageFontSize, pageFontFamily) }),
    [pageFontFamily, pageFontSize, pageZoom],
  );

  /** Creates or reuses the native page for a tab, then loads the requested URL. */
  const syncPage = useCallback((tab: BrowserTab, rect: PageRect) => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge || !tab.viewUrl) return;
    let handle = handles.current.get(tab.id);
    if (!handle) {
      handle = new NativePageHandle(tab.id, incognito);
      handles.current.set(tab.id, handle);
      onHandleRef.current(tab.id, handle);
    }
    handle.setRect(rect);
    const url = tab.viewUrl;
    if (loadedUrls.current.get(tab.id) === url) return;
    loadedUrls.current.set(tab.id, url);
    // ensure() only loads when the view is new or shows a different URL, so a
    // tab that arrives from another window keeps its page state.
    void bridge.ensure(tab.id, url, incognito).then((info) => {
      handle?.applyInfo(info);
      if (handle) reportNavigation(tab.id, handle);
      void bridge.command(tab.id, 'setAppearance', [appearance], incognito);
    }).catch(() => undefined);
  }, [appearance, incognito, reportNavigation]);

  /** Applies geometry and visibility for every tab. */
  const layout = useCallback(() => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) return;
    const rect = measure();
    const liveIds = new Set(liveTabs.map((tab) => tab.id));
    for (const tab of liveTabs) {
      // The drag window owns this page until the drag ends.
      if (tab.id === suspendedTabId) continue;
      syncPage(tab, rect);
      void bridge.setBounds(tab.id, rect, incognito);
      const hiddenByOverlay = tab.id === activeTabId && visible && parked;
      const shown = tab.id === activeTabId && visible && !parked;
      if (hiddenByOverlay) {
        // Parking the view off-screen keeps the window's hover state intact,
        // which setVisible(false) would reset (closing hover previews).
        void bridge.setVisible(tab.id, true, incognito);
        void bridge.attach(
          tab.id,
          { x: -rect.width - 40, y: rect.y, width: rect.width, height: rect.height },
          incognito,
        );
      } else {
        void bridge.setVisible(tab.id, shown, incognito);
        if (shown) void bridge.attach(tab.id, rect, incognito);
      }
    }
    for (const tabId of [...handles.current.keys()]) {
      if (liveIds.has(tabId) || tabId === suspendedTabId) continue;
      handles.current.delete(tabId);
      loadedUrls.current.delete(tabId);
      onHandleRef.current(tabId, null);
      void bridge.destroy(tabId, incognito);
    }
  }, [activeTabId, incognito, layoutToken, liveTabs, measure, parked, suspendedTabId, syncPage, visible]);

  useEffect(() => {
    layout();
  }, [layout]);

  // Keep the native views aligned with the window while it is resized.
  useEffect(() => {
    const element = areaRef.current;
    if (!element) return undefined;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => layout());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [layout]);

  // Per-tab mute state lives in the app model; mirror it onto the native page.
  const muteSignature = liveTabs.map((tab) => `${tab.id}:${tab.isMuted ? 1 : 0}`).join(',');
  useEffect(() => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) return;
    for (const tab of liveTabs) {
      void bridge.command(tab.id, 'setAudioMuted', [Boolean(tab.isMuted)], incognito);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incognito, muteSignature]);

  // Keep the user's zoom and font preferences on every page, including new ones.
  useEffect(() => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) return;
    for (const tab of liveTabs) {
      void bridge.command(tab.id, 'setAppearance', [appearance], incognito);
    }
  }, [appearance, incognito, liveTabs]);

  // A still frame stands in for the page while a panel or dialog covers it.
  // Popovers no longer come through here: they are mirrored above the page.
  useEffect(() => {
    if (!covered || !visible) {
      // Put the real page back first, then drop the still frame.
      setParked(false);
      const frame = window.requestAnimationFrame(() => setSnapshot(null));
      return () => window.cancelAnimationFrame(frame);
    }
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) {
      setParked(true);
      return undefined;
    }
    let active = true;
    /** Waits two frames: one for React to commit, one for the paint. */
    const parkAfterPaint = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (active) setParked(true);
        });
      });
    };
    const capture = async (): Promise<string | null> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const data = await bridge
          .command(activeTabId, 'captureSnapshot', [], incognito)
          .catch(() => null);
        if (typeof data === 'string' && data.startsWith('data:image/')) return data;
        if (!active) return null;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return null;
    };
    void capture().then(async (data) => {
      if (!active) return;
      if (!data) {
        // Never leave a blank area: reuse the last good frame when the page
        // refuses to be captured (video, protected content, busy renderer).
        const cached = lastFrame.current.get(activeTabId);
        if (cached) setSnapshot({ tabId: activeTabId, data: cached });
        parkAfterPaint();
        return;
      }
      const decoded = await decodeFrame(data);
      if (!active) return;
      lastFrame.current.set(activeTabId, data);
      setSnapshot({ tabId: activeTabId, data });
      if (!decoded) {
        // A broken frame is worse than a brief re-paint; keep the page visible.
        setSnapshot(null);
        return;
      }
      parkAfterPaint();
    });
    return () => {
      active = false;
    };
  }, [activeTabId, covered, incognito, visible]);

  // Page events are addressed to a tab id; forward the ones the app cares about.
  useEffect(() => {
    const desktop = window.lumaDesktop;
    if (!desktop?.onPageEvent) return undefined;
    return desktop.onPageEvent(({ tabId, type }) => {
      const handle = handles.current.get(tabId);
      if (!handle) return;
      if (type === 'ready') onReadyRef.current?.(tabId);
      if (type === 'stop' || type === 'navigate' || type === 'ready') {
        reportNavigation(tabId, handle);
      }
    });
  }, [incognito, reportNavigation]);

  // Closing the window must not leave pages running in the background.
  useEffect(() => () => {
    const bridge = window.lumaDesktop?.pageView;
    if (!bridge) return;
    for (const tabId of handles.current.keys()) void bridge.destroy(tabId, incognito);
    handles.current.clear();
  }, [incognito]);

  return (
    <div className="page-host-layer" ref={areaRef} aria-hidden="true">
      {snapshot && (
        <img
          className="page-host-layer__snapshot"
          src={snapshot.data}
          alt=""
          draggable={false}
          decoding="sync"
        />
      )}
    </div>
  );
}
