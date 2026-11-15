import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { Bookmark, BookmarkFolder } from '../types';
import { displayUrl } from '../utils/url';
import { ContextMenu, type ContextMenuEntry } from '../components/common/ContextMenu';
import { EmptyState } from '../components/common/EmptyState';
import { IconButton } from '../components/common/IconButton';
import { Modal } from '../components/common/Modal';
import { SiteIcon } from '../components/common/SiteIcon';

type FolderFilter = 'all' | 'uncategorized' | string;

interface BookmarksPageProps {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  onNavigate: (url: string) => void;
  onAdd: (folderId?: string) => void;
  onRemove: (id: string) => void;
  onOpenInNewTab: (url: string) => void;
  onCopyLink: (url: string) => void;
  onAddFolder: (name: string) => string | null;
  onRenameFolder: (id: string, name: string) => boolean;
  onRemoveFolder: (id: string) => void;
  onMoveBookmark: (bookmarkId: string, folderId?: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onReorderRoot: (
    sourceKind: 'bookmark' | 'folder',
    sourceId: string,
    targetKind: 'bookmark' | 'folder' | null,
    targetId: string | null,
    position: 'before' | 'after' | 'end',
  ) => void;
  onImport?: () => void;
  onExport?: () => void;
}

type DragItem = { kind: 'bookmark' | 'folder'; id: string };

interface BookmarkMenuState {
  bookmark: Bookmark;
  x: number;
  y: number;
}

interface FolderMenuState {
  folder: BookmarkFolder;
  x: number;
  y: number;
}

interface FolderDialogState {
  mode: 'create' | 'rename';
  folder?: BookmarkFolder;
}

export function BookmarksPage(props: BookmarksPageProps) {
  const [query, setQuery] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<FolderFilter>('all');
  const [contextMenu, setContextMenu] = useState<BookmarkMenuState | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderError, setFolderError] = useState('');
  const [folderToDelete, setFolderToDelete] = useState<BookmarkFolder | null>(null);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dropEdge, setDropEdge] = useState<'before' | 'after' | 'inside' | 'end' | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const folderMap = useMemo(
    () => new Map(props.folders.map((folder) => [folder.id, folder])),
    [props.folders],
  );
  const countInFolder = (folderId?: string) =>
    props.bookmarks.filter((bookmark) => (bookmark.folderId ?? undefined) === folderId).length;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return props.bookmarks.filter((bookmark) => {
      const inFolder =
        selectedFolder === 'all' ||
        (selectedFolder === 'uncategorized'
          ? !bookmark.folderId || !folderMap.has(bookmark.folderId)
          : bookmark.folderId === selectedFolder);
      return inFolder && `${bookmark.title} ${bookmark.url}`.toLowerCase().includes(keyword);
    });
  }, [selectedFolder, folderMap, props.bookmarks, query]);

  const rootBookmarks = useMemo(
    () => filtered.filter((bookmark) => !bookmark.folderId || !folderMap.has(bookmark.folderId)),
    [filtered, folderMap],
  );
  const visibleFolders = useMemo(() => {
    if (selectedFolder === 'uncategorized') return [];
    const source = selectedFolder === 'all'
      ? props.folders
      : props.folders.filter((folder) => folder.id === selectedFolder);
    if (!query.trim()) return source;
    return source.filter((folder) => filtered.some((bookmark) => bookmark.folderId === folder.id));
  }, [filtered, props.folders, query, selectedFolder]);
  const rootNodes = useMemo(() => {
    const nodes = [
      ...rootBookmarks.map((bookmark) => ({
        kind: 'bookmark' as const,
        id: bookmark.id,
        order: bookmark.order ?? bookmark.createdAt,
        bookmark,
      })),
      ...visibleFolders.map((folder) => ({
        kind: 'folder' as const,
        id: folder.id,
        order: folder.order ?? folder.createdAt,
        folder,
      })),
    ];
    return nodes.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }, [rootBookmarks, visibleFolders]);
  const showTree = rootNodes.length > 0;
  const bookmarksIn = (folderId: string) => filtered.filter((bookmark) => bookmark.folderId === folderId);

  const isExpanded = (folderId: string) => !collapsed.has(folderId);
  const toggleFolder = (folderId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };
  const expandFolder = (folderId: string) => {
    setCollapsed((current) => {
      if (!current.has(folderId)) return current;
      const next = new Set(current);
      next.delete(folderId);
      return next;
    });
  };

  const startDrag = (event: DragEvent, item: DragItem) => {
    setDragItem(item);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    event.dataTransfer.setData('application/x-luma-bookmark-item', item.kind);
  };
  const finishDrag = () => {
    setDragItem(null);
    setDropKey(null);
    setDropEdge(null);
  };
  const edgeAt = (event: DragEvent, threshold = 0.5): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    return (event.clientY - rect.top) / Math.max(rect.height, 1) < threshold ? 'before' : 'after';
  };
  const folderZoneAt = (event: DragEvent): 'before' | 'inside' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (ratio < 0.3) return 'before';
    if (ratio > 0.7) return 'after';
    return 'inside';
  };
  const dragOver = (event: DragEvent, key: string, allowed: boolean) => {
    if (!dragItem || !allowed) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropKey(key);
    setDropEdge(null);
  };
  const dropOnBookmark = (event: DragEvent, target: Bookmark) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragItem;
    finishDrag();
    if (source?.kind !== 'bookmark' || source.id === target.id) return;
    const sourceBookmark = props.bookmarks.find((bookmark) => bookmark.id === source.id);
    if ((sourceBookmark?.folderId ?? undefined) !== (target.folderId ?? undefined)) {
      props.onMoveBookmark(source.id, target.folderId);
    }
    props.onReorder(source.id, target.id);
  };
  const dropOnRootBookmark = (event: DragEvent, target: Bookmark) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragItem;
    const position = edgeAt(event);
    finishDrag();
    if (!source || source.id === target.id) return;
    props.onReorderRoot(source.kind, source.id, 'bookmark', target.id, position);
  };
  const dropOnFolder = (event: DragEvent, folder: BookmarkFolder) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragItem;
    const zone = source?.kind === 'bookmark' ? folderZoneAt(event) : edgeAt(event);
    finishDrag();
    if (!source || source.id === folder.id) return;
    if (source.kind === 'bookmark' && zone === 'inside') {
      props.onMoveBookmark(source.id, folder.id);
      return;
    }
    props.onReorderRoot(source.kind, source.id, 'folder', folder.id, zone === 'after' ? 'after' : 'before');
  };
  const dropOnEnd = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragItem;
    finishDrag();
    if (source) props.onReorderRoot(source.kind, source.id, null, null, 'end');
  };

  const selectionTitle =
    selectedFolder === 'all'
      ? '全部书签'
      : selectedFolder === 'uncategorized'
        ? '未分类'
        : folderMap.get(selectedFolder)?.name ?? '书签';

  const openFolderDialog = (mode: 'create' | 'rename', folder?: BookmarkFolder) => {
    setFolderName(folder?.name ?? '');
    setFolderError('');
    setFolderDialog({ mode, folder });
  };

  const submitFolder = (event: FormEvent) => {
    event.preventDefault();
    if (!folderName.trim()) {
      setFolderError('请输入文件夹名称');
      return;
    }
    if (folderDialog?.mode === 'create') {
      const id = props.onAddFolder(folderName);
      if (id) {
        setSelectedFolder(id);
        setFolderDialog(null);
      } else {
        setFolderError('名称不能为空，且不能与已有文件夹重复');
      }
    } else if (folderDialog?.folder) {
      if (props.onRenameFolder(folderDialog.folder.id, folderName)) setFolderDialog(null);
      else setFolderError('名称不能为空，且不能与其他文件夹重复');
    }
  };

  const deleteFolder = () => {
    if (!folderToDelete) return;
    props.onRemoveFolder(folderToDelete.id);
    if (selectedFolder === folderToDelete.id) setSelectedFolder('all');
    setFolderToDelete(null);
  };

  const bookmarkMenuItems: ContextMenuEntry[] = contextMenu ? [
    { id: 'open-tab', label: '在新标签页中打开', icon: <ExternalLink />, onSelect: () => props.onOpenInNewTab(contextMenu.bookmark.url) },
    { id: 'copy', label: '复制链接地址', icon: <Copy />, onSelect: () => props.onCopyLink(contextMenu.bookmark.url) },
    { id: 'separator', separator: true },
    { id: 'delete', label: '删除书签', icon: <Trash2 />, danger: true, onSelect: () => props.onRemove(contextMenu.bookmark.id) },
  ] : [];

  const folderMenuItems: ContextMenuEntry[] = folderMenu ? [
    { id: 'rename', label: '重命名文件夹', icon: <FolderOpen />, onSelect: () => openFolderDialog('rename', folderMenu.folder) },
    { id: 'delete', label: '删除文件夹', icon: <Trash2 />, danger: true, onSelect: () => setFolderToDelete(folderMenu.folder) },
  ] : [];

  const renderBookmark = (bookmark: Bookmark, scope: 'root' | 'folder') => {
    const isRoot = scope === 'root';
    const key = `${isRoot ? 'root-bookmark' : 'bookmark'}-${bookmark.id}`;
    const dropClass = dropKey === key
      ? dropEdge === 'before' ? 'is-drop-before' : dropEdge === 'after' ? 'is-drop-after' : 'is-drop-target'
      : '';
    return (
      <div
        role="treeitem"
        key={bookmark.id}
        draggable
        className={`bookmark-tree__row bookmark-tree__row--link ${isRoot ? 'bookmark-tree__row--root-link' : ''} ${dragItem?.kind === 'bookmark' && dragItem.id === bookmark.id ? 'is-dragging' : ''} ${dropClass}`}
        onClick={() => props.onOpenInNewTab(bookmark.url)}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ bookmark, x: event.clientX, y: event.clientY });
        }}
        onDragStart={(event) => startDrag(event, { kind: 'bookmark', id: bookmark.id })}
        onDragEnd={finishDrag}
        onDragOver={(event) => isRoot
          ? dragOver(event, key, Boolean(dragItem) && dragItem?.id !== bookmark.id)
          : dragOver(event, key, dragItem?.kind === 'bookmark' && dragItem.id !== bookmark.id)}
        onDragLeave={() => setDropKey((current) => (current === key ? null : current))}
        onDrop={(event) => (isRoot ? dropOnRootBookmark(event, bookmark) : dropOnBookmark(event, bookmark))}
        title={bookmark.url}
      >
        <SiteIcon url={bookmark.url} size="small" favicon={bookmark.favicon} />
        <span className="bookmark-tree__title">{bookmark.title}</span>
        <span className="bookmark-tree__url">{displayUrl(bookmark.url)}</span>
        <ArrowUpRight size={14} className="bookmark-tree__open" />
        <IconButton
          size="small"
          className="bookmark-tree__delete"
          label={`删除 ${bookmark.title}`}
          onClick={(event) => { event.stopPropagation(); props.onRemove(bookmark.id); }}
        >
          <Trash2 size={14} />
        </IconButton>
      </div>
    );
  };

  const renderFolder = (folder: BookmarkFolder) => {
    const expanded = isExpanded(folder.id);
    const items = bookmarksIn(folder.id);
    const key = `folder-${folder.id}`;
    const dropClass = dropKey === key
      ? dropEdge === 'before' ? 'is-drop-before' : dropEdge === 'after' ? 'is-drop-after' : 'is-drop-target'
      : '';
    return (
      <div className="bookmark-tree__folder" role="treeitem" aria-expanded={expanded} key={folder.id}>
        <div
          draggable
          className={`bookmark-tree__row bookmark-tree__row--folder ${dragItem?.kind === 'folder' && dragItem.id === folder.id ? 'is-dragging' : ''} ${dropClass}`}
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setFolderMenu({ folder, x: event.clientX, y: event.clientY });
          }}
          onDragStart={(event) => startDrag(event, { kind: 'folder', id: folder.id })}
          onDragEnd={finishDrag}
          onDragOver={(event) => {
            if (!dragItem || dragItem.id === folder.id) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropKey(key);
            setDropEdge(dragItem.kind === 'bookmark' ? folderZoneAt(event) : edgeAt(event));
          }}
          onDragEnter={() => expandFolder(folder.id)}
          onDragLeave={() => setDropKey((current) => (current === key ? null : current))}
          onDrop={(event) => dropOnFolder(event, folder)}
          title={`${folder.name}（${items.length} 个书签）`}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Folder size={16} className="bookmark-tree__folder-icon" />
          <span className="bookmark-tree__title">{folder.name}</span>
          <em>{items.length}</em>
          <IconButton
            size="small"
            className="bookmark-tree__more"
            label={`管理文件夹 ${folder.name}`}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setFolderMenu({ folder, x: rect.right - 190, y: rect.bottom + 4 });
            }}
          >
            <MoreHorizontal size={15} />
          </IconButton>
        </div>
        {expanded && (
          <div className="bookmark-tree__children" role="group">
            {items.map((bookmark) => renderBookmark(bookmark, 'folder'))}
            {items.length === 0 && <p className="bookmark-tree__empty">拖入书签即可放进这个文件夹</p>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="library-page page-scroll">
      <main className="library-container">
        <header className="library-hero">
          <div className="library-hero__icon"><BookOpen size={28} /></div>
          <div><p>你的个人收藏夹</p><h1>书签</h1><span>{props.bookmarks.length} 个书签，整理在 {props.folders.length} 个文件夹中。</span></div>
          <div className="library-hero__actions">
            {props.onImport && <button className="secondary-button" type="button" onClick={props.onImport}><Upload size={16} /> 导入书签</button>}
            {props.onExport && <button className="secondary-button" type="button" onClick={props.onExport}><Download size={16} /> 导出书签</button>}
            <button className="primary-button" type="button" onClick={() => props.onAdd(selectedFolder !== 'all' && selectedFolder !== 'uncategorized' ? selectedFolder : undefined)}><Plus size={18} /> 添加书签</button>
          </div>
        </header>

        <div className="bookmark-manager">
          <aside className="bookmark-folder-panel" aria-label="书签文件夹">
            <header><span>文件夹</span><IconButton size="small" label="新建文件夹" onClick={() => openFolderDialog('create')}><FolderPlus size={16} /></IconButton></header>
            <div className="folder-list">
              <div className={`folder-row ${selectedFolder === 'all' ? 'is-active' : ''}`}>
                <button type="button" onClick={() => setSelectedFolder('all')}><BookOpen size={16} /><span>全部书签</span><em>{props.bookmarks.length}</em></button>
              </div>
              <div className={`folder-row ${selectedFolder === 'uncategorized' ? 'is-active' : ''}`}>
                <button type="button" onClick={() => setSelectedFolder('uncategorized')}><Inbox size={16} /><span>未分类</span><em>{countInFolder(undefined)}</em></button>
              </div>
              <div className="folder-section-label">我的文件夹</div>
              {props.folders.map((folder) => (
                <div
                  className={`folder-row folder-row--custom ${selectedFolder === folder.id ? 'is-active' : ''}`}
                  key={folder.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setFolderMenu({ folder, x: event.clientX, y: event.clientY });
                  }}
                >
                  <button type="button" onClick={() => setSelectedFolder(folder.id)}>
                    <Folder size={16} /><span>{folder.name}</span><em>{countInFolder(folder.id)}</em>
                  </button>
                  <IconButton
                    className="folder-row__more"
                    size="small"
                    label={`管理文件夹 ${folder.name}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setFolderMenu({ folder, x: rect.right - 190, y: rect.bottom + 4 });
                    }}
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                </div>
              ))}
              {props.folders.length === 0 && (
                <button className="folder-empty-action" type="button" onClick={() => openFolderDialog('create')}>
                  <FolderPlus size={15} /> 创建第一个文件夹
                </button>
              )}
            </div>
          </aside>

          <section className="bookmark-content">
            <div className="bookmark-content__toolbar">
              <div><h2>{selectionTitle}</h2><span>{query ? `${filtered.length} 个搜索结果` : `${filtered.length} 个书签`}</span></div>
              <label className="library-search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书签名称或网址" /></label>
            </div>

            {showTree ? (
              <div className="bookmark-tree" role="tree" aria-label="书签树">
                {rootNodes.map((node) => node.kind === 'folder'
                  ? renderFolder(node.folder)
                  : renderBookmark(node.bookmark, 'root'))}
                {dragItem && (
                  <div
                    className={`bookmark-tree__drop-end ${dropKey === 'end' ? 'is-drop-target' : ''}`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = 'move';
                      setDropKey('end');
                      setDropEdge('end');
                    }}
                    onDragLeave={() => setDropKey((current) => (current === 'end' ? null : current))}
                    onDrop={dropOnEnd}
                  >
                    拖到这里放到末尾
                  </div>
                )}
              </div>
            ) : (
              <EmptyState
                icon={query ? <Search /> : <FolderOpen />}
                title={query ? '没有找到匹配的书签' : selectedFolder === 'all' ? '收藏你的第一个页面' : '这个文件夹还是空的'}
                description={query ? '换个关键词试试，或清空搜索查看当前文件夹。' : '看到喜欢的页面，点击地址栏旁的星标即可收藏。'}
                action={query
                  ? <button className="secondary-button" type="button" onClick={() => setQuery('')}>清空搜索</button>
                  : <button className="primary-button" type="button" onClick={() => props.onAdd(selectedFolder !== 'all' && selectedFolder !== 'uncategorized' ? selectedFolder : undefined)}><Plus size={17} /> 添加书签</button>}
              />
            )}
          </section>
        </div>
      </main>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={bookmarkMenuItems} label="书签选项" onClose={() => setContextMenu(null)} />
      )}
      {folderMenu && (
        <ContextMenu x={folderMenu.x} y={folderMenu.y} items={folderMenuItems} label="文件夹选项" onClose={() => setFolderMenu(null)} />
      )}

      {folderDialog && (
        <Modal
          title={folderDialog.mode === 'create' ? '新建书签文件夹' : '重命名文件夹'}
          description={folderDialog.mode === 'create' ? '用文件夹把工作、学习和灵感分开整理。' : '修改文件夹名称不会影响其中的书签。'}
          onClose={() => setFolderDialog(null)}
          footer={<><button className="secondary-button" type="button" onClick={() => setFolderDialog(null)}>取消</button><button className="primary-button" type="submit" form="folder-form" disabled={!folderName.trim()}>{folderDialog.mode === 'create' ? '创建文件夹' : '保存名称'}</button></>}
        >
          <form id="folder-form" className="bookmark-form" onSubmit={submitFolder}>
            <label><span>文件夹名称</span><input autoFocus value={folderName} onChange={(event) => { setFolderName(event.target.value); setFolderError(''); }} placeholder="例如：工作资料" maxLength={40} /></label>
            {folderError && <p className="form-error" role="alert">{folderError}</p>}
          </form>
        </Modal>
      )}

      {folderToDelete && (
        <Modal
          title={`删除文件夹「${folderToDelete.name}」？`}
          description={`文件夹中的 ${countInFolder(folderToDelete.id)} 个书签会移到“未分类”，不会被删除。`}
          onClose={() => setFolderToDelete(null)}
          footer={<><button className="secondary-button" type="button" onClick={() => setFolderToDelete(null)}>取消</button><button className="danger-button" type="button" onClick={deleteFolder}>删除文件夹</button></>}
        >
          <div className="confirmation-illustration"><Trash2 size={28} /></div>
        </Modal>
      )}
    </div>
  );
}
