import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clock3, Copy, ExternalLink, Search, Trash2, X } from 'lucide-react';
import type { HistoryItem } from '../types';
import { formatHistoryDate, formatTime } from '../utils/date';
import { displayUrl, getHost } from '../utils/url';
import { ContextMenu, type ContextMenuEntry } from '../components/common/ContextMenu';
import { EmptyState } from '../components/common/EmptyState';
import { IconButton } from '../components/common/IconButton';
import { Modal } from '../components/common/Modal';
import { SiteIcon } from '../components/common/SiteIcon';

interface HistoryPageProps {
  history: HistoryItem[];
  onNavigate: (url: string) => void;
  onRemove: (id: string) => void;
  onRemoveMany: (ids: string[]) => void;
  onClear: () => void;
  onOpenInNewTab: (url: string) => void;
  onCopyLink: (url: string) => void;
}

interface HistoryMenuState {
  item: HistoryItem;
  x: number;
  y: number;
}

type HistoryRange = 'all' | 'today' | 'week' | 'month';

const DAY = 86_400_000;
const RANGES: Array<{ id: HistoryRange; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: 'week', label: '近 7 天' },
  { id: 'month', label: '近 30 天' },
];

const startOfToday = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

export function HistoryPage({ history, onNavigate, onRemove, onRemoveMany, onClear, onOpenInNewTab, onCopyLink }: HistoryPageProps) {
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<HistoryRange>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [contextMenu, setContextMenu] = useState<HistoryMenuState | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);

  const stats = useMemo(() => {
    const todayStart = startOfToday();
    const weekStart = todayStart - 6 * DAY;
    const sites = new Set<string>();
    let today = 0;
    let week = 0;
    history.forEach((item) => {
      if (item.visitedAt >= todayStart) today += 1;
      if (item.visitedAt >= weekStart) week += 1;
      sites.add(getHost(item.url));
    });
    return { today, week, sites: sites.size };
  }, [history]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const cutoff = range === 'all'
      ? 0
      : range === 'today'
        ? startOfToday()
        : startOfToday() - (range === 'week' ? 6 : 29) * DAY;
    return history.filter((item) => item.visitedAt >= cutoff && `${item.title} ${item.url}`.toLowerCase().includes(keyword));
  }, [history, query, range]);

  const filteredIds = useMemo(() => filtered.map((item) => item.id), [filtered]);
  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));
  const hasFilter = query.trim().length > 0 || range !== 'all';

  useEffect(() => {
    const valid = new Set(history.map((item) => item.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [history]);

  useEffect(() => {
    if (history.length === 0) setSelectMode(false);
  }, [history.length]);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(filteredIds));
  };

  const resetFilters = () => {
    setQuery('');
    setRange('all');
  };

  const deleteSelected = () => {
    onRemoveMany([...selected]);
    setSelected(new Set());
    setSelectMode(false);
    setConfirmBulk(false);
  };

  const menuItems: ContextMenuEntry[] = contextMenu ? [
    { id: 'open', label: '打开此页面', icon: <ArrowUpRight />, onSelect: () => onNavigate(contextMenu.item.url) },
    { id: 'open-tab', label: '在新标签页中打开', icon: <ExternalLink />, onSelect: () => onOpenInNewTab(contextMenu.item.url) },
    { id: 'copy', label: '复制链接地址', icon: <Copy />, onSelect: () => onCopyLink(contextMenu.item.url) },
    { id: 'separator', separator: true },
    { id: 'delete', label: '从历史记录中删除', icon: <Trash2 />, danger: true, onSelect: () => onRemove(contextMenu.item.id) },
  ] : [];

  const groups = useMemo(() => {
    const result = new Map<string, HistoryItem[]>();
    filtered.forEach((item) => {
      const date = formatHistoryDate(item.visitedAt);
      result.set(date, [...(result.get(date) ?? []), item]);
    });
    return [...result.entries()];
  }, [filtered]);

  const emptyTitle = query.trim()
    ? '没有找到相关记录'
    : range !== 'all'
      ? '这个时间范围内没有记录'
      : '还没有浏览足迹';
  const emptyDescription = query.trim()
    ? '试试其他关键词，或清空搜索查看全部。'
    : range !== 'all'
      ? '换一个时间范围，或查看全部记录。'
      : '访问外部网页后，记录会按日期整齐地显示在这里。';

  return (
    <div className="library-page history-page page-scroll">
      <main className="library-container library-container--narrow">
        <header className="library-hero">
          <div className="library-hero__icon library-hero__icon--mint"><Clock3 size={28} /></div>
          <div><p>回看每一步足迹</p><h1>历史记录</h1><span>仅保存在当前设备，你始终拥有控制权。</span></div>
          <div className="library-hero__actions">
            <button className="secondary-button" type="button" disabled={history.length === 0} onClick={() => { setSelectMode((mode) => !mode); setSelected(new Set()); }}>{selectMode ? '完成' : '批量清理'}</button>
            <button className="secondary-button danger-text" type="button" disabled={history.length === 0} onClick={() => setConfirmClear(true)}><Trash2 size={17} /> 清空记录</button>
          </div>
        </header>

        <div className="history-stats">
          <div className="history-stat"><span>全部记录</span><strong>{history.length}</strong></div>
          <div className="history-stat history-stat--accent"><span>今天</span><strong>{stats.today}</strong></div>
          <div className="history-stat"><span>近 7 天</span><strong>{stats.week}</strong></div>
          <div className="history-stat"><span>访问站点</span><strong>{stats.sites}</strong></div>
        </div>

        <div className="library-toolbar history-toolbar">
          <label className="library-search">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或网址" aria-label="搜索历史记录" />
            {query && (
              <button className="library-search__clear" type="button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14} /></button>
            )}
          </label>
          <div className="history-ranges" role="group" aria-label="筛选时间范围">
            {RANGES.map((option) => (
              <button
                key={option.id}
                type="button"
                className={range === option.id ? 'is-active' : ''}
                aria-pressed={range === option.id}
                onClick={() => setRange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="history-toolbar__count">{hasFilter ? `${filtered.length} / ${history.length} 条` : `${history.length} 条记录`}</span>
        </div>

        {selectMode && (
          <div className="history-bulk-bar" role="region" aria-label="批量清理历史记录">
            <label><input type="checkbox" checked={allSelected} onChange={toggleAll} /> 全选当前结果</label>
            <span>已选择 {selected.size} 条</span>
            <button className="danger-button" type="button" disabled={selected.size === 0} onClick={() => setConfirmBulk(true)}><Trash2 size={15} /> 删除所选</button>
          </div>
        )}

        {groups.length > 0 ? groups.map(([date, items]) => (
          <section className="history-group" key={date}>
            <h2>{date}<span>{items.length}</span></h2>
            <div className="history-list">
              {items.map((item) => (
                <article
                  className={`history-item ${selected.has(item.id) ? 'is-selected' : ''}`}
                  key={item.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ item, x: event.clientX, y: event.clientY });
                  }}
                >
                  {selectMode && (
                    <input
                      className="history-select"
                      type="checkbox"
                      aria-label={`选择 ${item.title}`}
                      checked={selected.has(item.id)}
                      onChange={() => toggleSelected(item.id)}
                    />
                  )}
                  <time className="history-item__time" dateTime={new Date(item.visitedAt).toISOString()}>{formatTime(item.visitedAt)}</time>
                  <button type="button" className="history-item__open" onClick={() => (selectMode ? toggleSelected(item.id) : onNavigate(item.url))}>
                    <SiteIcon url={item.url} favicon={item.favicon} />
                    <span className="history-item__meta">
                      <strong>{item.title || displayUrl(item.url)}</strong>
                      <small>{displayUrl(item.url)}</small>
                    </span>
                  </button>
                  <div className="history-item__actions">
                    <IconButton size="small" label={`在新标签页打开 ${item.title}`} onClick={() => onOpenInNewTab(item.url)}><ExternalLink size={15} /></IconButton>
                    <IconButton size="small" label={`删除 ${item.title} 的记录`} onClick={() => onRemove(item.id)}><Trash2 size={15} /></IconButton>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )) : (
          <EmptyState
            icon={hasFilter ? <Search /> : <Clock3 />}
            title={emptyTitle}
            description={emptyDescription}
            action={hasFilter ? <button className="secondary-button" type="button" onClick={resetFilters}>清除筛选</button> : undefined}
          />
        )}
      </main>
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={menuItems} label="历史记录选项" onClose={() => setContextMenu(null)} />
      )}
      {confirmClear && (
        <Modal
          title="清空全部浏览记录？"
          description="此操作只会删除历史记录，不会影响书签和打开的标签页。"
          onClose={() => setConfirmClear(false)}
          footer={<><button className="secondary-button" type="button" onClick={() => setConfirmClear(false)}>取消</button><button className="danger-button" type="button" onClick={() => { onClear(); setConfirmClear(false); }}>确认清空</button></>}
        >
          <div className="confirmation-illustration"><Trash2 size={28} /></div>
        </Modal>
      )}
      {confirmBulk && (
        <Modal
          title={`删除所选的 ${selected.size} 条记录？`}
          description="只会删除选中的历史记录，书签和打开的标签页不会受到影响。"
          onClose={() => setConfirmBulk(false)}
          footer={<><button className="secondary-button" type="button" onClick={() => setConfirmBulk(false)}>取消</button><button className="danger-button" type="button" onClick={deleteSelected}>删除所选</button></>}
        >
          <div className="confirmation-illustration"><Trash2 size={28} /></div>
        </Modal>
      )}
    </div>
  );
}
