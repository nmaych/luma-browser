import { useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, Clock3, Copy, ExternalLink, Search, Trash2, X } from 'lucide-react';
import type { Bookmark, HistoryItem, PanelName } from '../../types';
import { displayUrl } from '../../utils/url';
import { formatTime } from '../../utils/date';
import { ContextMenu, type ContextMenuEntry } from '../common/ContextMenu';
import { EmptyState } from '../common/EmptyState';
import { IconButton } from '../common/IconButton';
import { SiteIcon } from '../common/SiteIcon';

interface SidePanelProps {
  panel: PanelName;
  bookmarks: Bookmark[];
  history: HistoryItem[];
  onClose: () => void;
  onNavigate: (url: string) => void;
  onRemoveBookmark: (id: string) => void;
  onRemoveHistory: (id: string) => void;
  onOpenAll: (page: 'bookmarks' | 'history') => void;
  onOpenInNewTab: (url: string) => void;
  onCopyLink: (url: string) => void;
}

interface PanelContextMenu {
  item: Bookmark | HistoryItem;
  x: number;
  y: number;
}

export function SidePanel(props: SidePanelProps) {
  const [query, setQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<PanelContextMenu | null>(null);
  const isBookmarks = props.panel === 'bookmarks';
  const items = useMemo(() => {
    const source: (Bookmark | HistoryItem)[] = isBookmarks ? props.bookmarks : props.history;
    const normalized = query.trim().toLowerCase();
    if (!normalized) return source;
    return source.filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(normalized));
  }, [isBookmarks, props.bookmarks, props.history, query]);
  const menuItems: ContextMenuEntry[] = contextMenu ? [
    { id: 'open', label: '打开', icon: <ArrowUpRight />, onSelect: () => props.onNavigate(contextMenu.item.url) },
    { id: 'new-tab', label: '在新标签页中打开', icon: <ExternalLink />, onSelect: () => props.onOpenInNewTab(contextMenu.item.url) },
    { id: 'copy', label: '复制链接地址', icon: <Copy />, onSelect: () => props.onCopyLink(contextMenu.item.url) },
    { id: 'separator', separator: true },
    {
      id: 'remove',
      label: isBookmarks ? '删除书签' : '删除记录',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => isBookmarks ? props.onRemoveBookmark(contextMenu.item.id) : props.onRemoveHistory(contextMenu.item.id),
    },
  ] : [];

  if (!props.panel) return null;

  return (
    <aside className="side-panel" aria-label={isBookmarks ? '书签侧边栏' : '历史记录侧边栏'}>
      <header className="side-panel__header">
        <div className="side-panel__title">
          {isBookmarks ? <BookOpen size={19} /> : <Clock3 size={19} />}
          <h2>{isBookmarks ? '书签' : '历史记录'}</h2>
          <span>{items.length}</span>
        </div>
        <IconButton label="关闭侧边栏" onClick={props.onClose}><X size={19} /></IconButton>
      </header>
      <label className="panel-search">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isBookmarks ? '搜索书签' : '搜索历史记录'} />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={14} /></button>}
      </label>
      <div className="side-panel__list">
        {items.map((item) => (
          <div
            className="panel-list-item"
            key={item.id}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({ item, x: event.clientX, y: event.clientY });
            }}
          >
            <button type="button" className="panel-list-item__open" onClick={() => (isBookmarks ? props.onOpenInNewTab(item.url) : props.onNavigate(item.url))}>
              <SiteIcon url={item.url} size="small" favicon={item.favicon} />
              <span><strong>{item.title}</strong><small>{displayUrl(item.url)}</small></span>
            </button>
            {'visitedAt' in item && <time>{formatTime(item.visitedAt)}</time>}
            <IconButton
              size="small"
              label={isBookmarks ? `删除书签 ${item.title}` : `删除记录 ${item.title}`}
              onClick={() => isBookmarks ? props.onRemoveBookmark(item.id) : props.onRemoveHistory(item.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {items.length === 0 && (
          <EmptyState
            compact
            icon={isBookmarks ? <BookOpen /> : <Clock3 />}
            title={query ? '没有找到匹配内容' : isBookmarks ? '还没有书签' : '暂无浏览记录'}
            description={query ? '试试其他关键词或检查拼写' : isBookmarks ? '点击地址栏右侧的星标收藏页面' : '访问外部网页后会显示在这里'}
          />
        )}
      </div>
      <footer className="side-panel__footer">
        <button type="button" onClick={() => props.onOpenAll(isBookmarks ? 'bookmarks' : 'history')}>
          <ExternalLink size={15} /> {isBookmarks ? '打开书签管理器' : '查看完整历史记录'}
        </button>
      </footer>
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={menuItems} label={isBookmarks ? '书签选项' : '历史记录选项'} onClose={() => setContextMenu(null)} />
      )}
    </aside>
  );
}
