import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  EyeOff,
  FileDown,
  FileX2,
  FolderOpen,
  Pause,
  Play,
  Trash2,
  X,
} from 'lucide-react';

type DownloadFilter = 'all' | 'active' | 'finished';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function stateLabel(item: LumaDownloadRecord): string {
  if (item.state === 'completed') return '已完成';
  if (item.state === 'cancelled') return '已取消';
  if (item.state === 'interrupted') return item.resumable ? '已中断 · 可继续' : '下载失败';
  return item.paused ? '已暂停' : '正在下载';
}

export function DownloadsPage() {
  const desktop = window.lumaDesktop;
  const [items, setItems] = useState<LumaDownloadRecord[]>([]);
  const [filter, setFilter] = useState<DownloadFilter>('all');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    document.title = '下载内容 · Luma';
  }, []);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void desktop.listDownloads().then((list) => {
      if (active) setItems(list);
    }).catch(() => undefined);
    const unsubscribe = desktop.onDownloadsChanged((list) => {
      if (active) setItems(list);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [desktop]);

  const activeCount = items.filter((item) => item.state === 'progressing').length;
  const finishedCount = items.filter((item) => item.state !== 'progressing').length;
  const visible = useMemo(() => {
    if (filter === 'active') return items.filter((item) => item.state === 'progressing');
    if (filter === 'finished') return items.filter((item) => item.state !== 'progressing');
    return items;
  }, [filter, items]);

  const run = useCallback(async (action: () => Promise<boolean>, failure: string) => {
    try {
      const ok = await action();
      setMessage(ok ? null : failure);
    } catch {
      setMessage(failure);
    }
    if (desktop) {
      void desktop.listDownloads().then(setItems).catch(() => undefined);
    }
  }, [desktop]);

  const openFile = (item: LumaDownloadRecord) => {
    void run(() => desktop!.openDownload(item.id), '无法打开文件，请检查文件是否已被移动');
  };

  const showInFolder = (item: LumaDownloadRecord) => {
    if (desktop) desktop.showDownloadInFolder(item.id);
  };

  return (
    <div className="downloads-app">
      <header className="downloads-header">
        <div className="downloads-header__title">
          <span className="downloads-header__icon"><ArrowDownToLine size={22} /></span>
          <div>
            <h1>下载内容</h1>
            <p>{activeCount > 0 ? `${activeCount} 项正在下载` : '管理这台设备上的下载文件'}</p>
          </div>
        </div>
        <button
          type="button"
          className="downloads-clear"
          disabled={finishedCount === 0}
          onClick={() => void run(() => desktop!.clearDownloads(), '清除下载记录失败')}
        >
          <Trash2 size={15} />清除已完成
        </button>
      </header>

      <div className="downloads-toolbar" role="tablist" aria-label="下载筛选">
        {([
          ['all', '全部', items.length],
          ['active', '下载中', activeCount],
          ['finished', '已完成', finishedCount],
        ] as const).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? 'is-active' : ''}
            onClick={() => setFilter(id)}
          >
            {label}<span>{count}</span>
          </button>
        ))}
      </div>

      {message && (
        <div className="downloads-message" role="status">
          <AlertTriangle size={15} />{message}
          <button type="button" aria-label="关闭提示" onClick={() => setMessage(null)}><X size={13} /></button>
        </div>
      )}

      <main className="downloads-list">
        {visible.length === 0 ? (
          <div className="downloads-empty">
            <span><DownloadEmptyIcon /></span>
            <h2>{items.length === 0 ? '还没有下载内容' : '这里暂时没有内容'}</h2>
            <p>{items.length === 0 ? '从网页下载的文件会出现在这里，并保存在你的下载文件夹中。' : '切换筛选条件查看其他下载。'}</p>
          </div>
        ) : visible.map((item) => {
          const percent = item.totalBytes > 0
            ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
            : 0;
          return (
            <article className={`download-item is-${item.state}`} key={item.id}>
              <span className={`download-item__icon ${item.state === 'completed' ? 'is-done' : ''}`}>
                {item.state === 'completed'
                  ? <CheckCircle2 size={20} />
                  : item.state === 'interrupted'
                    ? <AlertTriangle size={20} />
                    : <FileDown size={20} />}
              </span>
              <div className="download-item__body">
                <div className="download-item__title">
                  <strong title={item.filename}>{item.filename}</strong>
                  {item.incognito && <span className="download-item__tag"><EyeOff size={10} />无痕</span>}
                  <span className="download-item__state">{stateLabel(item)}</span>
                </div>
                <div className="download-item__meta">
                  <span>{hostOf(item.url)}</span>
                  <i>·</i>
                  <span>{formatDate(item.startedAt)}</span>
                  <i>·</i>
                  <span>
                    {item.state === 'completed'
                      ? formatBytes(item.receivedBytes || item.totalBytes)
                      : `${formatBytes(item.receivedBytes)} / ${item.totalBytes > 0 ? formatBytes(item.totalBytes) : '未知大小'}`}
                  </span>
                  {item.state === 'progressing' && !item.paused && item.speed > 0 && (
                    <>
                      <i>·</i>
                      <span className="download-item__speed">{formatSpeed(item.speed)}</span>
                    </>
                  )}
                </div>
                {item.state === 'progressing' && (
                  <div className="download-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: item.totalBytes > 0 ? `${percent}%` : '35%' }} className={item.totalBytes > 0 ? '' : 'is-indeterminate'} />
                  </div>
                )}
                {item.savePath && (
                  <p className="download-item__path" title={item.savePath}>{item.savePath}</p>
                )}
              </div>
              <div className="download-item__actions">
                {item.state === 'progressing' && (
                  <>
                    <button
                      type="button"
                      className="download-action"
                      aria-label={item.paused ? '继续下载' : '暂停下载'}
                      title={item.paused ? '继续' : '暂停'}
                      onClick={() => void run(
                        () => (item.paused ? desktop!.resumeDownload(item.id) : desktop!.pauseDownload(item.id)),
                        item.paused ? '无法继续下载' : '无法暂停下载',
                      )}
                    >
                      {item.paused ? <Play size={16} /> : <Pause size={16} />}
                    </button>
                    <button
                      type="button"
                      className="download-action"
                      aria-label="取消下载"
                      title="取消"
                      onClick={() => void run(() => desktop!.cancelDownload(item.id), '无法取消下载')}
                    >
                      <X size={16} />
                    </button>
                  </>
                )}
                {item.state === 'interrupted' && item.resumable && (
                  <button
                    type="button"
                    className="download-action download-action--primary"
                    aria-label={`继续下载 ${item.filename}`}
                    title="从已下载的部分继续"
                    onClick={() => void run(() => desktop!.resumeInterruptedDownload(item.id), '无法继续下载，文件可能已被移动')}
                  >
                    <Play size={16} />
                  </button>
                )}
                {item.state === 'completed' && (
                  <>
                    <button type="button" className="download-action download-action--primary" aria-label={`打开 ${item.filename}`} title="打开" onClick={() => openFile(item)}>
                      <Play size={15} />
                    </button>
                    <button type="button" className="download-action" aria-label="在文件夹中显示" title="在文件夹中显示" onClick={() => showInFolder(item)}>
                      <FolderOpen size={16} />
                    </button>
                  </>
                )}
                {item.savePath && item.state !== 'progressing' && (
                  <button
                    type="button"
                    className="download-action download-action--danger"
                    aria-label={`删除 ${item.filename} 及其本地文件`}
                    title="删除本地文件"
                    onClick={() => void run(() => desktop!.deleteDownloadFile(item.id), '无法删除本地文件')}
                  >
                    <FileX2 size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="download-action download-action--danger"
                  aria-label={`移除 ${item.filename} 的记录`}
                  title="移除记录"
                  onClick={() => void run(() => desktop!.removeDownload(item.id), '移除下载记录失败')}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          );
        })}
      </main>
    </div>
  );
}

function DownloadEmptyIcon() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden="true">
      <rect x="7" y="9" width="40" height="36" rx="9" stroke="currentColor" strokeWidth="2" opacity=".35" />
      <path d="M27 18v13m0 0 5.5-5.5M27 31l-5.5-5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 37h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}
