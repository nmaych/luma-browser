import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  Copy,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Bookmark, BookmarkFolder } from '../../types';
import { ContextMenu, type ContextMenuEntry } from '../common/ContextMenu';
import { SiteIcon } from '../common/SiteIcon';
import { useOverlaySurface } from '../../hooks/useOverlaySurface';

interface BookmarksBarProps {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  onNavigate: (url: string) => void;
  onOpenInNewTab: (url: string) => void;
  onCopyLink: (url: string) => void;
  onManage: () => void;
  onAdd: (folderId?: string) => void;
  onRemove: (id: string) => void;
  onMoveBookmark: (bookmarkId: string, folderId?: string) => void;
  onRemoveFolder: (id: string) => void;
  onReorderRoot: (
    sourceKind: 'bookmark' | 'folder',
    sourceId: string,
    targetKind: 'bookmark' | 'folder' | null,
    targetId: string | null,
    position: 'before' | 'after' | 'end',
  ) => void;
}

type BarMenu =
  | { kind: 'bookmark'; bookmark: Bookmark; x: number; y: number }
  | { kind: 'folder'; folder: BookmarkFolder; x: number; y: number }
  | { kind: 'bar'; x: number; y: number };

interface FolderMenuState {
  folder: BookmarkFolder;
  x: number;
  y: number;
}

interface OverflowMenuState {
  x: number;
  y: number;
}

type DragItem = { kind: 'bookmark' | 'folder'; id: string };

type BarItem =
  | { kind: 'bookmark'; bookmark: Bookmark; sortKey: number }
  | { kind: 'folder'; folder: BookmarkFolder; sortKey: number };

const FOLDER_MENU_WIDTH = 286;
const OVERFLOW_MENU_WIDTH = 288;
const ITEM_GAP = 2;
// Width of the "more" button plus its gap, reserved when the row overflows.
const MORE_RESERVE = 32;

const itemKey = (item: BarItem) => (item.kind === 'bookmark' ? `bookmark-${item.bookmark.id}` : `folder-${item.folder.id}`);

export function BookmarksBar(props: BookmarksBarProps) {
  const [menu, setMenu] = useState<BarMenu | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  /** A double click sends two clicks; the second must not close what the first opened. */
  const lastFolderOpen = useRef<{ id: string; at: number } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<OverflowMenuState | null>(null);
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(Number.POSITIVE_INFINITY);
  const itemsRef = useRef<HTMLDivElement | null>(null);
  const folderMenuRef = useRef<HTMLDivElement | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const merged = useMemo<BarItem[]>(() => {
    const folderIds = new Set(props.folders.map((folder) => folder.id));
    const nodes: BarItem[] = [
      ...props.bookmarks
        .filter((bookmark) => !bookmark.folderId || !folderIds.has(bookmark.folderId))
        .map((bookmark) => ({ kind: 'bookmark' as const, bookmark, sortKey: bookmark.order ?? bookmark.createdAt })),
      ...props.folders.map((folder) => ({ kind: 'folder' as const, folder, sortKey: folder.order ?? folder.createdAt })),
    ];
    return nodes.sort((left, right) => left.sortKey - right.sortKey || itemKey(left).localeCompare(itemKey(right)));
  }, [props.bookmarks, props.folders]);

  const byOrder = (left: { id: string; order?: number; createdAt: number }, right: { id: string; order?: number; createdAt: number }) =>
    (left.order ?? left.createdAt) - (right.order ?? right.createdAt) || left.id.localeCompare(right.id);
  const bookmarksIn = (folderId: string) => props.bookmarks.filter((bookmark) => bookmark.folderId === folderId).sort(byOrder);

  const shownCount = Math.min(visibleCount, merged.length);
  const hiddenItems = merged.slice(shownCount);
  const hasOverflow = hiddenItems.length > 0;

  // Both dropdowns hang over the page area, which is a native view painted
  // above the DOM. Mirroring them keeps them visible instead of being covered.
  useOverlaySurface(folderMenuRef, Boolean(folderMenu));
  useOverlaySurface(overflowMenuRef, Boolean(overflowMenu && hasOverflow));

  useLayoutEffect(() => {
    const container = itemsRef.current;
    if (!container) return undefined;
    const measure = () => {
      const available = container.clientWidth;
      if (available <= 0) return;
      const widths = merged.map((item) => itemRefs.current.get(itemKey(item))?.offsetWidth ?? 0);
      if (widths.some((width) => width <= 0)) return;
      const total = widths.reduce((sum, width) => sum + width, 0) + ITEM_GAP * Math.max(merged.length - 1, 0);
      let count = merged.length;
      if (total > available) {
        const limit = available - MORE_RESERVE;
        let used = 0;
        count = 0;
        for (let index = 0; index < widths.length; index += 1) {
          const next = used + widths[index] + (index > 0 ? ITEM_GAP : 0);
          if (next > limit) break;
          used = next;
          count = index + 1;
        }
      }
      setVisibleCount((current) => (current === count ? current : count));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [merged]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenu(null);
      setFolderMenu(null);
      setOverflowMenu(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const openMenu = (event: MouseEvent, value: BarMenu) => {
    event.preventDefault();
    event.stopPropagation();
    setFolderMenu(null);
    setOverflowMenu(null);
    setMenu(value);
  };

  const openFolder = (event: MouseEvent, folder: BookmarkFolder) => {
    event.preventDefault();
    event.stopPropagation();
    // React may run the updater after the event is dispatched, when currentTarget is null.
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.left, window.innerWidth - FOLDER_MENU_WIDTH - 8));
    const now = Date.now();
    setMenu(null);
    setOverflowMenu(null);
    setFolderMenu((current) => {
      if (current?.folder.id === folder.id) {
        const recent = lastFolderOpen.current;
        // Double-clicking a folder used to open and immediately close its menu.
        if (recent && recent.id === folder.id && now - recent.at < 500) return current;
        lastFolderOpen.current = null;
        return null;
      }
      lastFolderOpen.current = { id: folder.id, at: now };
      return { folder, x, y: rect.bottom + 5 };
    });
  };

  const openOverflow = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.right - OVERFLOW_MENU_WIDTH, window.innerWidth - OVERFLOW_MENU_WIDTH - 8));
    setMenu(null);
    setFolderMenu(null);
    setExpandedFolder(null);
    setOverflowMenu((current) => (current ? null : { x, y: rect.bottom + 5 }));
  };

  const finishDrag = () => {
    setDragging(null);
    setDropTarget(null);
  };

  const handleDragStart = (event: DragEvent, item: DragItem) => {
    setMenu(null);
    setFolderMenu(null);
    setOverflowMenu(null);
    setDragging(item);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.setData('application/x-luma-item', item.kind);
  };

  const dragOver = (event: DragEvent, key: string, allowed: boolean) => {
    if (!dragging || !allowed) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(key);
  };

  const menuItems: ContextMenuEntry[] = (() => {
    if (!menu) return [];
    if (menu.kind === 'bookmark') {
      const bookmark = menu.bookmark;
      return [
        { id: 'open-tab', label: '在新标签页中打开', icon: <ExternalLink />, onSelect: () => props.onOpenInNewTab(bookmark.url) },
        { id: 'copy', label: '复制链接地址', icon: <Copy />, onSelect: () => props.onCopyLink(bookmark.url) },
        { id: 'separator-move', separator: true },
        ...props.folders
          .filter((folder) => folder.id !== bookmark.folderId)
          .map((folder) => ({
            id: `move-${folder.id}`,
            label: `移至「${folder.name}」`,
            icon: <Folder />,
            onSelect: () => props.onMoveBookmark(bookmark.id, folder.id),
          })),
        ...(bookmark.folderId
          ? [{ id: 'move-none', label: '移至未分类', icon: <Inbox />, onSelect: () => props.onMoveBookmark(bookmark.id) }]
          : []),
        { id: 'separator-delete', separator: true },
        { id: 'remove', label: '删除书签', icon: <Trash2 />, danger: true, onSelect: () => props.onRemove(bookmark.id) },
      ];
    }
    if (menu.kind === 'folder') {
      return [
        { id: 'add-to-folder', label: '添加书签到文件夹', icon: <FolderPlus />, onSelect: () => props.onAdd(menu.folder.id) },
        { id: 'open-folder', label: '打开书签管理器', icon: <FolderOpen />, onSelect: props.onManage },
        { id: 'separator-folder', separator: true },
        { id: 'remove-folder', label: `删除文件夹「${menu.folder.name}」`, icon: <Trash2 />, danger: true, onSelect: () => props.onRemoveFolder(menu.folder.id) },
      ];
    }
    return [
      { id: 'add-bookmark', label: '添加书签', icon: <Plus />, onSelect: () => props.onAdd() },
      { id: 'manage-bookmarks', label: '打开书签管理器', icon: <FolderOpen />, onSelect: props.onManage },
    ];
  })();

  const folderMenuBookmarks = folderMenu ? bookmarksIn(folderMenu.folder.id) : [];

  const renderBookmark = (bookmark: Bookmark, hidden: boolean) => {
    const key = `bookmark-${bookmark.id}`;
    return (
      <button
        type="button"
        key={key}
        ref={(node) => {
          if (node) itemRefs.current.set(key, node);
          else itemRefs.current.delete(key);
        }}
        draggable={!hidden}
        className={`${dragging?.kind === 'bookmark' && dragging.id === bookmark.id ? 'is-dragging' : ''} ${dropTarget === key ? 'is-drop-target' : ''} ${hidden ? 'is-overflow-hidden' : ''}`}
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : undefined}
        onClick={() => props.onOpenInNewTab(bookmark.url)}
        onContextMenu={(event) => openMenu(event, { kind: 'bookmark', bookmark, x: event.clientX, y: event.clientY })}
        onDragStart={(event) => handleDragStart(event, { kind: 'bookmark', id: bookmark.id })}
        onDragOver={(event) => dragOver(event, key, Boolean(dragging) && dragging?.id !== bookmark.id)}
        onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (dragging && dragging.id !== bookmark.id) {
            props.onReorderRoot(dragging.kind, dragging.id, 'bookmark', bookmark.id, 'before');
          }
          finishDrag();
        }}
        onDragEnd={finishDrag}
        title={bookmark.url}
      >
        <SiteIcon url={bookmark.url} size="small" favicon={bookmark.favicon} />
        <span>{bookmark.title}</span>
      </button>
    );
  };

  const renderFolder = (folder: BookmarkFolder, hidden: boolean) => {
    const key = `folder-${folder.id}`;
    const count = props.bookmarks.filter((bookmark) => bookmark.folderId === folder.id).length;
    return (
      <button
        type="button"
        key={key}
        ref={(node) => {
          if (node) itemRefs.current.set(key, node);
          else itemRefs.current.delete(key);
        }}
        draggable={!hidden}
        className={`bookmarks-bar__folder ${dragging?.kind === 'folder' && dragging.id === folder.id ? 'is-dragging' : ''} ${dropTarget === key ? 'is-drop-target' : ''} ${folderMenu?.folder.id === folder.id ? 'is-open' : ''} ${hidden ? 'is-overflow-hidden' : ''}`}
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : undefined}
        onClick={(event) => openFolder(event, folder)}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onContextMenu={(event) => {
          setFolderMenu(null);
          openMenu(event, { kind: 'folder', folder, x: event.clientX, y: event.clientY });
        }}
        onDragStart={(event) => handleDragStart(event, { kind: 'folder', id: folder.id })}
        onDragOver={(event) => dragOver(event, key, Boolean(dragging) && dragging?.id !== folder.id)}
        onDragLeave={() => setDropTarget((current) => (current === key ? null : current))}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (dragging?.kind === 'bookmark') props.onMoveBookmark(dragging.id, folder.id);
          else if (dragging?.kind === 'folder' && dragging.id !== folder.id) {
            props.onReorderRoot('folder', dragging.id, 'folder', folder.id, 'before');
          }
          finishDrag();
        }}
        onDragEnd={finishDrag}
        aria-expanded={folderMenu?.folder.id === folder.id}
        title={`文件夹：${folder.name}（${count} 个书签）`}
      >
        <Folder size={14} />
        <span>{folder.name}</span>
        {count > 0 && <em>{count}</em>}
      </button>
    );
  };

  return (
    <div
      className="bookmarks-bar"
      onContextMenu={(event) => openMenu(event, { kind: 'bar', x: event.clientX, y: event.clientY })}
    >
      <span className="bookmarks-bar__label"><FolderOpen size={15} />书签栏</span>
      <div className="bookmarks-bar__items" ref={itemsRef}>
        {merged.slice(0, shownCount).map((item) => (item.kind === 'bookmark' ? renderBookmark(item.bookmark, false) : renderFolder(item.folder, false)))}
        {hasOverflow && (
          <button
            type="button"
            className={`bookmarks-bar__more ${dropTarget === 'more' ? 'is-drop-target' : ''}`}
            aria-label={`展开隐藏的书签（${hiddenItems.length}）`}
            aria-expanded={Boolean(overflowMenu)}
            title={`还有 ${hiddenItems.length} 项，点击展开`}
            onClick={openOverflow}
            onDragOver={(event) => dragOver(event, 'more', Boolean(dragging))}
            onDragLeave={() => setDropTarget((current) => (current === 'more' ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (dragging) props.onReorderRoot(dragging.kind, dragging.id, null, null, 'end');
              finishDrag();
            }}
          >
            <ChevronDown size={15} />
            <span>{hiddenItems.length}</span>
          </button>
        )}
        {hiddenItems.map((item) => (item.kind === 'bookmark' ? renderBookmark(item.bookmark, true) : renderFolder(item.folder, true)))}
        {dragging && !hasOverflow && merged.length > 1 && (
          <span
            className={`bookmarks-bar__drop-end ${dropTarget === 'end' ? 'is-drop-target' : ''}`}
            aria-hidden="true"
            onDragOver={(event) => dragOver(event, 'end', true)}
            onDragLeave={() => setDropTarget((current) => (current === 'end' ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (dragging) props.onReorderRoot(dragging.kind, dragging.id, null, null, 'end');
              finishDrag();
            }}
          />
        )}
        {merged.length === 0 && (
          <span className="bookmarks-bar__empty">收藏的页面会显示在这里</span>
        )}
      </div>
      <button className="bookmarks-bar__add" type="button" onClick={() => props.onAdd()} aria-label="添加书签" title="添加书签"><Plus size={15} /></button>
      <button className="bookmarks-bar__all" type="button" onClick={props.onManage}>
        全部书签 <ChevronsRight size={14} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          label={menu.kind === 'bookmark' ? '书签栏书签选项' : menu.kind === 'folder' ? '书签栏文件夹选项' : '书签栏选项'}
          onClose={() => setMenu(null)}
        />
      )}
      {folderMenu && createPortal(
        <>
          <button
            className="popover-dismiss"
            type="button"
            aria-label="关闭文件夹"
            onClick={() => {
              // The second click of a double-click lands on this overlay; it
              // must not close the menu the first click just opened.
              const recent = lastFolderOpen.current;
              if (recent && Date.now() - recent.at < 500) return;
              lastFolderOpen.current = null;
              setFolderMenu(null);
            }}
          />
          <div
            className="bookmarks-folder-menu popover"
            role="menu"
            aria-label={`文件夹 ${folderMenu.folder.name}`}
            ref={folderMenuRef}
            style={{ position: 'fixed', left: folderMenu.x, top: folderMenu.y, width: FOLDER_MENU_WIDTH }}
          >
            <div className="bookmarks-folder-menu__header">
              <span><Folder size={14} />{folderMenu.folder.name}</span>
              <small>{folderMenuBookmarks.length} 个书签</small>
            </div>
            <div className="bookmarks-folder-menu__list">
              {folderMenuBookmarks.map((bookmark) => (
                <button
                  type="button"
                  role="menuitem"
                  key={bookmark.id}
                  data-menu-item={`folder-open-${bookmark.id}`}
                  onClick={() => { setFolderMenu(null); props.onOpenInNewTab(bookmark.url); }}
                  title={bookmark.url}
                >
                  <SiteIcon url={bookmark.url} size="small" favicon={bookmark.favicon} />
                  <span className="bookmarks-folder-menu__title">{bookmark.title}</span>
                </button>
              ))}
              {folderMenuBookmarks.length === 0 && (
                <p className="bookmarks-folder-menu__empty">这个文件夹还是空的</p>
              )}
            </div>
            <div className="bookmarks-folder-menu__footer">
              <button type="button" data-menu-item="folder-add" onClick={() => { const folderId = folderMenu.folder.id; setFolderMenu(null); props.onAdd(folderId); }}>
                <Plus size={14} /> 添加书签
              </button>
              <button type="button" data-menu-item="folder-manage" onClick={() => { setFolderMenu(null); props.onManage(); }}>
                <FolderOpen size={14} /> 管理文件夹
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}
      {overflowMenu && hasOverflow && createPortal(
        <>
          <button className="popover-dismiss" type="button" aria-label="关闭更多书签" onClick={() => setOverflowMenu(null)} />
          <div
            className="bookmarks-overflow popover"
            role="menu"
            aria-label="更多书签"
            ref={overflowMenuRef}
            style={{ position: 'fixed', left: overflowMenu.x, top: overflowMenu.y, width: OVERFLOW_MENU_WIDTH }}
          >
            <div className="bookmarks-overflow__header">
              <span><ChevronDown size={14} />更多书签</span>
              <small>{hiddenItems.length} 项</small>
            </div>
            <div className="bookmarks-overflow__list">
              {hiddenItems.map((item) => {
                if (item.kind === 'bookmark') {
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={`overflow-${item.bookmark.id}`}
                      className="bookmarks-overflow__row"
                      title={item.bookmark.url}
                      data-menu-item={`overflow-open-${item.bookmark.id}`}
                      onClick={() => { setOverflowMenu(null); props.onOpenInNewTab(item.bookmark.url); }}
                    >
                      <SiteIcon url={item.bookmark.url} size="small" favicon={item.bookmark.favicon} />
                      <span className="bookmarks-overflow__title">{item.bookmark.title}</span>
                    </button>
                  );
                }
                const folder = item.folder;
                const children = bookmarksIn(folder.id);
                const expanded = expandedFolder === folder.id;
                return (
                  <div className="bookmarks-overflow__group" key={`overflow-${folder.id}`}>
                    <button
                      type="button"
                      role="menuitem"
                      className="bookmarks-overflow__row"
                      aria-expanded={expanded}
                      title={`文件夹：${folder.name}（${children.length} 个书签）`}
                      data-menu-item={`overflow-folder-${folder.id}`}
                      onClick={() => setExpandedFolder((current) => (current === folder.id ? null : folder.id))}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <Folder size={14} />
                      <span className="bookmarks-overflow__title">{folder.name}</span>
                      <em>{children.length}</em>
                    </button>
                    {expanded && (
                      <div className="bookmarks-overflow__children">
                        {children.map((bookmark) => (
                          <button
                            type="button"
                            key={bookmark.id}
                            title={bookmark.url}
                            onClick={() => { setOverflowMenu(null); props.onOpenInNewTab(bookmark.url); }}
                          >
                            <SiteIcon url={bookmark.url} size="small" favicon={bookmark.favicon} />
                            <span className="bookmarks-overflow__title">{bookmark.title}</span>
                          </button>
                        ))}
                        {children.length === 0 && <p className="bookmarks-overflow__empty">这个文件夹还是空的</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="bookmarks-overflow__footer">
              <button type="button" onClick={() => { setOverflowMenu(null); props.onManage(); }}>
                <FolderOpen size={14} /> 打开书签管理器
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
