import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Copy, EyeOff, Link2, Minus, Moon, PanelTopClose, PanelsTopLeft, Plus, RefreshCw, RotateCcw, Square, Star, Volume2, VolumeX, X } from 'lucide-react';
import type { BrowserTab } from '../../types';
import { displayUrl, getHost } from '../../utils/url';
import { ContextMenu, type ContextMenuEntry } from '../common/ContextMenu';
import { IconButton } from '../common/IconButton';
import { Logo } from '../common/Logo';
import { SiteIcon } from '../common/SiteIcon';

type TabDropPosition = 'before' | 'after';
interface TabTearOffPoint {
  /** Missing when the platform hid the drag coordinates; the app falls back to the cursor. */
  screenX?: number;
  screenY?: number;
  /** Where the tab sat inside the window, so the new window lands under the ghost. */
  offsetX?: number;
  offsetY?: number;
}

interface TabStripProps {
  tabs: BrowserTab[];
  activeTabId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
  onReopen: () => void;
  onDuplicate: (id: string) => void;
  onCopyUrl: (url: string) => void;
  onReorder: (sourceId: string, targetId: string, position?: TabDropPosition) => void;
  onReloadTab: (id: string) => void;
  onBookmarkTab: (id: string) => void;
  onToggleMute: (id: string) => void;
  onSleepTab?: (id: string) => void;
  onTearOff?: (id: string, point?: TabTearOffPoint) => void;
  /** A tab drag began: main creates the window that will follow the cursor. */
  onTearOffStart?: (id: string, point: Required<TabTearOffPoint>) => void;
  /** The pointer moved during a drag; main shows the window once it leaves the tab bar. */
  onTearOffMove?: (id: string, point: { screenX: number; screenY: number }) => void;
  /** The drag ended; main decides whether the page stays in a new window. */
  onTearOffEnd?: (id: string, point?: TabTearOffPoint) => void;
  onDragStateChange?: (id: string | null) => void;
  /** Hover previews and tab menus are HTML, so the page must step aside for them. */
  onOverlayChange?: (open: boolean) => void;
  /** Native hover preview: a card window above the page, so nothing has to move. */
  onShowPreview?: (preview: {
    tabId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    host: string;
    thumbnail?: string;
    favicon?: string;
  }) => void;
  onHidePreview?: () => void;
  dropHandledRef?: { current: boolean };
  onOverview: () => void;
  onOpenSettings: () => void;
  previews?: Record<string, string>;
  showPreviews?: boolean;
  onPreviewRequest?: (id: string) => void;
  doubleClickCloses?: boolean;
  rightClickCloses?: boolean;
  scrollSwitches?: boolean;
  isIncognito?: boolean;
  isDesktop?: boolean;
  isMaximized?: boolean;
  onMinimize?: () => void;
  onToggleMaximize?: () => void;
  onCloseWindow?: () => void;
}

interface TabContextMenu {
  id: string;
  x: number;
  y: number;
}

function RestoreWindowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="4.5" y="5.5" width="8.5" height="8.5" rx="1.2" />
      <path d="M6.6 3.5h4.2a1.7 1.7 0 0 1 1.7 1.7v4.2" />
    </svg>
  );
}

export function TabStrip(props: TabStripProps) {
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  // dragstart fires only after the pointer moved; the grab point is where the
  // button went down. Deriving it from the drag event makes the window lag
  // behind the cursor by the drag threshold.
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<TabDropPosition>('before');
  const [hoverPreview, setHoverPreview] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  // Payload of the card that is currently on screen (native preview window).
  const nativePreview = useRef<{
    tabId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    title: string;
    host: string;
    thumbnail?: string;
    favicon?: string;
  } | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);

  const currentEntry = (tab: BrowserTab) => tab.entries[tab.historyIndex];

  const clearHoverPreview = () => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    nativePreview.current = null;
    props.onHidePreview?.();
    setHoverPreview(null);
  };

  useEffect(() => clearHoverPreview, []);
  useEffect(() => {
    if (!props.showPreviews) clearHoverPreview();
  }, [props.showPreviews]);

  // Closing the hovered tab (its close button, Ctrl+W, or another action) never
  // fires mouseleave, so the preview card would stay on screen afterwards.
  useEffect(() => {
    const native = nativePreview.current;
    const stillOpen = props.tabs.some((tab) => tab.id === (hoverPreview?.tabId ?? native?.tabId));
    if ((hoverPreview || native) && !stillOpen) clearHoverPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tabs]);

  useEffect(() => {
    const current = nativePreview.current;
    if (!current || !props.onShowPreview) return;
    const image = props.previews?.[current.tabId];
    if (!image || image === current.thumbnail) return;
    current.thumbnail = image;
    props.onShowPreview({ ...current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.previews]);

  // Hover previews and the tab menu are HTML, but the native page is painted
  // above the HTML layer, so the app hides the page while they are open.
  // The tab context menu is mirrored above the page, so only the hover preview
  // still needs the page to step aside.
  const overlayOpen = Boolean(hoverPreview);
  useEffect(() => {
    props.onOverlayChange?.(overlayOpen);
  }, [overlayOpen]);

  useEffect(() => {
    const node = tabListRef.current;
    if (!node || !props.scrollSwitches) return undefined;
    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 2) return;
      const index = props.tabs.findIndex((tab) => tab.id === props.activeTabId);
      if (index < 0) return;
      event.preventDefault();
      clearHoverPreview();
      const direction = event.deltaY > 0 ? 1 : -1;
      const nextIndex = (index + direction + props.tabs.length) % props.tabs.length;
      props.onSelect(props.tabs[nextIndex].id);
    };
    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [props.activeTabId, props.onSelect, props.scrollSwitches, props.tabs]);

  useEffect(() => {
    const node = tabListRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(props.activeTabId)}"]`);
    if (!node) return;
    const reduceMotion = document.documentElement.dataset.reduceMotion === 'true';
    if (typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [props.activeTabId, props.tabs.length]);

  const scheduleHoverPreview = (event: MouseEvent<HTMLDivElement>, tab: BrowserTab) => {
    if (!props.showPreviews || draggingId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    clearHoverPreview();
    hoverTimer.current = window.setTimeout(() => {
      props.onPreviewRequest?.(tab.id);
      const width = 264;
      const x = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8));
      const y = rect.bottom + 8;
      if (props.onShowPreview) {
        // The card is its own window: the native page never moves, so no flash.
        const entry = currentEntry(tab);
        const payload = {
          tabId: tab.id,
          x,
          y,
          width,
          height: 202,
          title: entry.title || 'Luma',
          host: getHost(entry.url) || '',
          thumbnail: props.previews?.[tab.id],
          favicon: tab.favicon,
        };
        nativePreview.current = payload;
        props.onShowPreview(payload);
        return;
      }
      setHoverPreview({ tabId: tab.id, x, y });
    }, 420);
  };

  const openContextMenu = (event: MouseEvent, id: string) => {
    event.preventDefault();
    setContextMenu({ id, x: event.clientX, y: event.clientY });
  };

  const finishDrag = () => {
    draggingRef.current = false;
    setDraggingId(null);
    setDropTargetId(null);
    props.onDragStateChange?.(null);
  };

  /** Height of the tab bar in CSS pixels; must match .browser-tabbar. */
  const TAB_BAR_HEIGHT = 40;

  const handleDragStart = (event: DragEvent, id: string) => {
    setContextMenu(null);
    setHoverPreview(null);
    draggingRef.current = true;
    setDraggingId(id);
    setDropPosition('before');
    props.onDragStateChange?.(id);
    if (props.dropHandledRef) props.dropHandledRef.current = false;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    event.dataTransfer.setData('application/x-luma-item', 'tab');
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    dragOffset.current = {
      x: Math.round(origin?.x ?? event.clientX),
      y: Math.round(origin?.y ?? event.clientY),
    };
    // The window is created now, on press-and-move, not on release.
    props.onTearOffStart?.(id, {
      screenX: Math.round(window.screenX + event.clientX),
      screenY: Math.round(window.screenY + event.clientY),
      offsetX: dragOffset.current.x,
      offsetY: dragOffset.current.y,
    });
  };

  /**
   * Resolves the release point in screen coordinates. Chromium reports 0/0 for
   * drags that leave the window, so the OS cursor is used as a fallback.
   */
  const resolveDropPoint = async (event: DragEvent) => {
    const screenX = Number(event.screenX);
    const screenY = Number(event.screenY);
    if (Number.isFinite(screenX) && Number.isFinite(screenY) && (screenX !== 0 || screenY !== 0)) {
      return { screenX, screenY };
    }
    try {
      const cursor = await window.lumaDesktop?.getCursorPoint?.();
      if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
        return { screenX: cursor.x, screenY: cursor.y };
      }
    } catch {
      // Fall through to the event coordinates below.
    }
    return null;
  };

  /** Ends the drag; main decides whether the page stays in a new window. */
  const handleDragEnd = async (event: DragEvent, id: string) => {
    if (props.dropHandledRef) props.dropHandledRef.current = false;
    finishDrag();
    // Main owns the decision: it knows where the pointer is and whether the
    // drag window ever appeared.
    const point = await resolveDropPoint(event);
    props.onTearOffEnd?.(id, point ?? undefined);
  };

  const handleDrop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (props.dropHandledRef) props.dropHandledRef.current = true;
    if (draggingId && draggingId !== targetId) {
      props.onReorder(draggingId, targetId, dropPosition);
    }
    finishDrag();
  };

  const selectedTab = contextMenu ? props.tabs.find((tab) => tab.id === contextMenu.id) : null;
  const selectedIndex = contextMenu ? props.tabs.findIndex((tab) => tab.id === contextMenu.id) : -1;
  const selectedEntry = selectedTab ? currentEntry(selectedTab) : null;
  const canCloseRight = selectedIndex >= 0 && selectedIndex < props.tabs.length - 1;
  const menuItems: ContextMenuEntry[] = contextMenu && selectedEntry ? [
    {
      id: 'new-tab',
      label: '新建标签页',
      icon: <Plus />,
      shortcut: 'Ctrl+T',
      onSelect: props.onNew,
    },
    {
      id: 'duplicate',
      label: '复制标签页',
      icon: <Copy />,
      onSelect: () => props.onDuplicate(contextMenu.id),
    },
    {
      id: 'tear-off',
      label: '在新窗口中打开',
      icon: <PanelsTopLeft />,
      disabled: !props.onTearOff,
      onSelect: () => props.onTearOff?.(contextMenu.id),
    },
    {
      id: 'sleep',
      label: '休眠此标签页',
      icon: <Moon />,
      disabled: !props.onSleepTab || contextMenu.id === props.activeTabId || Boolean(selectedTab?.isSleeping),
      onSelect: () => props.onSleepTab?.(contextMenu.id),
    },
    {
      id: 'reload',
      label: '重新加载',
      icon: <RefreshCw />,
      shortcut: 'Ctrl+R',
      disabled: !selectedEntry.url.startsWith('http'),
      onSelect: () => props.onReloadTab(contextMenu.id),
    },
    ...(selectedEntry.url.startsWith('http')
      ? [{
          id: 'add-bookmark',
          label: '为此页添加书签',
          icon: <Star />,
          onSelect: () => props.onBookmarkTab(contextMenu.id),
        }]
      : []),
    ...(selectedEntry.url.startsWith('http')
      ? [{
          id: 'copy-url',
          label: '复制页面地址',
          icon: <Link2 />,
          onSelect: () => props.onCopyUrl(selectedEntry.url),
        }]
      : []),
    { id: 'separator-primary', separator: true },
    {
      id: 'close',
      label: '关闭标签页',
      icon: <X />,
      shortcut: 'Ctrl+W',
      onSelect: () => props.onClose(contextMenu.id),
    },
    {
      id: 'close-others',
      label: '关闭其他标签页',
      icon: <PanelTopClose />,
      disabled: props.tabs.length <= 1,
      onSelect: () => props.onCloseOthers(contextMenu.id),
    },
    {
      id: 'close-right',
      label: '关闭右侧标签页',
      icon: <PanelTopClose />,
      disabled: !canCloseRight,
      onSelect: () => props.onCloseRight(contextMenu.id),
    },
    { id: 'separator-secondary', separator: true },
    {
      id: 'reopen',
      label: '恢复关闭的标签页',
      icon: <RotateCcw />,
      shortcut: 'Ctrl+Shift+T',
      onSelect: props.onReopen,
    },
  ] : [];

  return (
    <div className="browser-tabbar">
      <div className="window-controls" aria-hidden="true">
        <span className="window-dot window-dot--red" />
        <span className="window-dot window-dot--yellow" />
        <span className="window-dot window-dot--green" />
      </div>
      <div className="tabbar-brand"><Logo size={26} /></div>
      {props.isIncognito && (
        <span className="incognito-badge" title="无痕模式：关闭窗口后会清除本次浏览记录">
          <EyeOff size={12} />无痕
        </span>
      )}
      <div
        className={`tab-list ${draggingId ? 'is-dragging-tabs' : ''} ${dropTargetId === '__tab-list-end__' ? 'is-drop-end' : ''}`}
        role="tablist"
        aria-label="打开的标签页"
        ref={tabListRef}
        onDragOver={(event) => {
          if (!draggingId) return;
          if ((event.target as Element).closest('.browser-tab')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTargetId('__tab-list-end__');
          setDropPosition('after');
        }}
        onDrop={(event) => {
          if (!draggingId) return;
          if ((event.target as Element).closest('.browser-tab')) return;
          event.preventDefault();
          event.stopPropagation();
          if (props.dropHandledRef) props.dropHandledRef.current = true;
          const last = props.tabs.at(-1);
          if (last && last.id !== draggingId) props.onReorder(draggingId, last.id, 'after');
          finishDrag();
        }}
      >
        {props.tabs.map((tab) => {
          const entry = currentEntry(tab);
          const active = tab.id === props.activeTabId;
          return (
            <div
              className={`browser-tab ${active ? 'is-active' : ''} ${tab.isSleeping ? 'is-sleeping' : ''} ${draggingId === tab.id ? 'is-dragging' : ''} ${dropTargetId === tab.id && draggingId !== tab.id ? `is-drop-target is-drop-${dropPosition}` : ''}`}
              key={tab.id}
              draggable
              data-tab-id={tab.id}
              onMouseEnter={(event) => scheduleHoverPreview(event, tab)}
              onMouseLeave={clearHoverPreview}
              onDoubleClick={(event) => {
                if (!props.doubleClickCloses) return;
                if ((event.target as Element).closest('.browser-tab__close, .browser-tab__audio')) return;
                clearHoverPreview();
                props.onClose(tab.id);
              }}
              onContextMenu={(event) => {
                if (props.rightClickCloses) {
                  event.preventDefault();
                  clearHoverPreview();
                  props.onClose(tab.id);
                  return;
                }
                clearHoverPreview();
                openContextMenu(event, tab.id);
              }}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                dragOrigin.current = { x: event.clientX, y: event.clientY };
              }}
              onDragStart={(event) => { clearHoverPreview(); handleDragStart(event, tab.id); }}
              onDrag={(event) => {
                // Once the pointer is below the tab bar the window takes over; main
                // also watches the OS cursor for the part of the drag that happens
                // over the native page, which swallows DOM drag events.
                if (event.clientY <= TAB_BAR_HEIGHT) return;
                props.onTearOffMove?.(tab.id, {
                  screenX: Math.round(window.screenX + event.clientX),
                  screenY: Math.round(window.screenY + event.clientY),
                });
              }}
              onDragOver={(event) => {
                if (!draggingId || draggingId === tab.id) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                setDropTargetId(tab.id);
                setDropPosition(event.clientX < rect.left + rect.width / 2 ? 'before' : 'after');
              }}
              onDragLeave={() => setDropTargetId((current) => current === tab.id ? null : current)}
              onDrop={(event) => handleDrop(event, tab.id)}
              onDragEnd={(event) => handleDragEnd(event, tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  clearHoverPreview();
                  props.onClose(tab.id);
                }
              }}
            >
              <button
                type="button"
                className="browser-tab__main"
                role="tab"
                aria-selected={active}
                onClick={() => props.onSelect(tab.id)}
                title={entry.title}
              >
                <span className="browser-tab__favicon">
                  {tab.isSleeping
                    ? <span className="browser-tab__sleep" title="已休眠，点击唤醒"><Moon size={13} /></span>
                    : tab.isLoading ? <span className="tab-spinner" /> : <SiteIcon url={entry.url} size="small" favicon={tab.favicon} />}
                </span>
                <span className="browser-tab__title">{entry.title}</span>
              </button>
              {(tab.isAudible || tab.isMuted) && (
                <button
                  type="button"
                  className={`browser-tab__audio ${tab.isMuted ? 'is-muted' : ''}`}
                  aria-label={tab.isMuted ? `取消静音 ${entry.title}` : `静音 ${entry.title}`}
                  title={tab.isMuted ? '取消静音' : '静音此标签页'}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleMute(tab.id);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                >
                  {tab.isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
              )}
              <IconButton
                className="browser-tab__close"
                size="small"
                label={`关闭 ${entry.title}`}
                onClick={() => { clearHoverPreview(); props.onClose(tab.id); }}
              >
                <X size={14} />
              </IconButton>
            </div>
          );
        })}
        <IconButton className="new-tab-button" label="新建标签页 (Ctrl+T)" onClick={props.onNew}>
          <Plus size={19} />
        </IconButton>
      </div>
      <IconButton className="tab-overview-button" label="管理所有标签页" onClick={props.onOverview}>
        <ChevronDown size={18} />
      </IconButton>
      <button className="profile-avatar" type="button" title="设置与个人资料" aria-label="设置与个人资料" onClick={props.onOpenSettings}>L</button>
      {props.isDesktop && (
        <>
          <div className="tabbar-drag-handle" aria-hidden="true" />
          <div className="native-window-actions" aria-label="窗口控制">
            <button type="button" aria-label="最小化窗口" title="最小化" onClick={props.onMinimize}><Minus size={16} /></button>
            <button type="button" aria-label={props.isMaximized ? '还原窗口' : '最大化窗口'} title={props.isMaximized ? '还原' : '最大化'} onClick={props.onToggleMaximize}>{props.isMaximized ? <RestoreWindowIcon /> : <Square size={13} />}</button>
            <button className="native-window-close" type="button" aria-label="关闭窗口" title="关闭" onClick={props.onCloseWindow}><X size={16} /></button>
          </div>
        </>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          label="标签页选项"
          onClose={() => setContextMenu(null)}
        />
      )}
      {hoverPreview && (() => {
        const tab = props.tabs.find((item) => item.id === hoverPreview.tabId);
        if (!tab) return null;
        const entry = currentEntry(tab);
        const image = props.previews?.[tab.id];
        return createPortal(
          <div
            className="tab-hover-preview"
            role="tooltip"
            aria-label={`${entry.title} 预览`}
            style={{ left: hoverPreview.x, top: hoverPreview.y }}
          >
            <div className={`tab-hover-preview__page ${image ? 'has-image' : ''}`}>
              {image
                ? <img src={image} alt="" />
                : <><SiteIcon url={entry.url} size="large" favicon={tab.favicon} /><small>{getHost(entry.url) || 'Luma'}</small></>}
            </div>
            <div className="tab-hover-preview__info">
              <SiteIcon url={entry.url} size="small" favicon={tab.favicon} />
              <span><strong>{entry.title}</strong><small>{displayUrl(entry.url) || 'Luma 内置页面'}</small></span>
            </div>
          </div>,
          document.body,
        );
      })()}
    </div>
  );
}
