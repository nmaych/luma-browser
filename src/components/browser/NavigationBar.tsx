import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Camera, Clock3, Download, History, Home, KeyRound, Languages, LockKeyhole, Newspaper, RotateCw, Search, Settings2, ShieldCheck, ShieldOff, Star, X } from 'lucide-react';
import type { BrowserTab, CustomSearchEngine, HistoryItem, SearchEngine, TabEntry } from '../../types';
import { displayUrl, getHost, getInternalPage, isExternalUrl } from '../../utils/url';
import { formatHistoryDate, formatTime } from '../../utils/date';
import { IconButton } from '../common/IconButton';
import { SiteIcon } from '../common/SiteIcon';
import { useInputContextMenu } from '../../hooks/useInputContextMenu';
import { BrowserMenu } from './BrowserMenu';

const TRANSLATION_TARGETS = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'ru', label: 'Русский' },
];

interface NavigationBarProps {
  tab: BrowserTab;
  entry: TabEntry;
  isBookmarked: boolean;
  isOnline: boolean;
  canReopen: boolean;
  recentPages?: HistoryItem[];
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onHome: () => void;
  onNavigate: (input: string) => void;
  onOpenInNewTab: (url: string) => void;
  onToggleBookmark: () => void;
  onBookmarks: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onNewTab: () => void;
  onReopen: () => void;
  onDownloads?: () => void;
  onIncognito?: () => void;
  onFullscreen?: () => void;
  onDevTools?: () => void;
  onPrint?: () => void;
  onSavePdf?: () => void;
  downloadCount?: number;
  canGoBack?: boolean;
  canGoForward?: boolean;
  showSuggestions?: boolean;
  searchEngine: SearchEngine;
  customSearchEngines?: CustomSearchEngine[];
  onSearchEngineChange: (engine: SearchEngine) => void;
  onMenuOpenChange?: (open: boolean) => void;
  readerActive?: boolean;
  onToggleReader?: () => void;
  onScreenshot?: (options: { mode: 'save' | 'copy'; fullPage: boolean; selectRegion?: boolean }) => void;
  translated?: boolean;
  translating?: boolean;
  translationTarget: string;
  onTranslationTargetChange: (target: string) => void;
  onTranslatePage: () => void;
  onRestoreTranslation: () => void;
  adblockEnabled: boolean;
  adblockSiteDisabled: boolean;
  blockedCount: number;
  onToggleAdblockSite: () => void;
  onOpenAdblockSettings: () => void;
  passwordEntries: LumaPasswordAccount[];
  onFillPassword: (entry: LumaPasswordAccount) => void;
  onManagePasswords: () => void;
}

export function NavigationBar(props: NavigationBarProps) {
  const [address, setAddress] = useState(displayUrl(props.entry.url));
  const [isFocused, setIsFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [passwordsOpen, setPasswordsOpen] = useState(false);
  const page = getInternalPage(props.entry.url);
  const isExternal = isExternalUrl(props.entry.url);
  const adblockActive = props.adblockEnabled && !props.adblockSiteDisabled;
  const recentPages = (props.recentPages ?? []).slice(0, 8);

  // The page is a native view above the HTML layer, so any popover has to make
  // the page step aside while it is open.
  const suggestions = useMemo(() => {
    const keyword = address.trim().toLowerCase();
    if (!props.showSuggestions || !keyword) return [];
    const seen = new Set<string>();
    return (props.recentPages ?? []).filter((item) => {
      if (!isExternalUrl(item.url) || seen.has(item.url)) return false;
      seen.add(item.url);
      return `${item.title} ${item.url}`.toLowerCase().includes(keyword);
    }).slice(0, 6);
  }, [address, props.recentPages, props.showSuggestions]);
  const suggestionsOpen = isFocused && suggestions.length > 0;

  useEffect(() => {
    setActiveSuggestion(-1);
  }, [address, props.entry.url, props.showSuggestions]);
  const { onContextMenu: openInputMenu, inputContextMenu, inputContextMenuOpen } = useInputContextMenu({
    value: address,
    onChange: setAddress,
    onGo: (value) => {
      if (value.trim()) props.onNavigate(value);
    },
    label: '地址栏选项',
  });
  const anyPopoverOpen = menuOpen
    || recentOpen
    || shieldOpen
    || translateOpen
    || screenshotOpen
    || passwordsOpen
    || suggestionsOpen
    || inputContextMenuOpen;
  useEffect(() => {
    props.onMenuOpenChange?.(anyPopoverOpen);
  }, [anyPopoverOpen]);
  // The native page keeps keyboard focus while it is parked, so Escape would
  // never reach these popovers without an explicit handler here.
  useEffect(() => {
    if (!anyPopoverOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      setRecentOpen(false);
      setShieldOpen(false);
      setTranslateOpen(false);
      setScreenshotOpen(false);
      setPasswordsOpen(false);
      setIsFocused(false);
      setActiveSuggestion(-1);
      (document.activeElement as HTMLElement | null)?.blur();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [anyPopoverOpen]);

  useEffect(() => {
    setAddress(displayUrl(props.entry.url));
    setShieldOpen(false);
    setTranslateOpen(false);
    setScreenshotOpen(false);
    setPasswordsOpen(false);
  }, [props.entry.url, props.tab.id]);

  const go = (value: string) => {
    if (value.trim()) props.onNavigate(value);
    setActiveSuggestion(-1);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (suggestionsOpen && activeSuggestion >= 0) {
      go(suggestions[activeSuggestion].url);
      return;
    }
    go(address);
  };

  return (
    <>
      <div className="navigation-bar">
        <div className="navigation-controls desktop-navigation">
          <IconButton label="后退 (Alt+←)" onClick={props.onBack} disabled={!(props.canGoBack ?? props.tab.historyIndex > 0)}>
            <ArrowLeft size={19} />
          </IconButton>
          <IconButton label="前进 (Alt+→)" onClick={props.onForward} disabled={!(props.canGoForward ?? props.tab.historyIndex < props.tab.entries.length - 1)}>
            <ArrowRight size={19} />
          </IconButton>
          <IconButton
            label={props.tab.isLoading ? '停止加载' : '刷新 (Ctrl+R)'}
            onClick={props.tab.isLoading ? props.onStop : props.onRefresh}
          >
            {props.tab.isLoading ? <X size={17} /> : <RotateCw size={18} />}
          </IconButton>
          <IconButton label="主页" onClick={props.onHome}>
            <Home size={18} />
          </IconButton>
          <div className="recent-menu-anchor">
            <IconButton label="最近打开" active={recentOpen} onClick={() => setRecentOpen((open) => !open)}>
              <History size={18} />
            </IconButton>
            {recentOpen && (
              <>
                <button className="popover-dismiss" type="button" aria-label="关闭最近打开" onClick={() => setRecentOpen(false)} />
                <div className="recent-menu popover" role="menu" aria-label="最近打开">
                  <div className="recent-menu__header">最近打开</div>
                  {recentPages.length > 0 ? recentPages.map((item) => (
                    <button
                      type="button"
                      role="menuitem"
                      className="recent-menu__item"
                      key={item.id}
                      onClick={() => {
                        setRecentOpen(false);
                        props.onOpenInNewTab(item.url);
                      }}
                    >
                      <SiteIcon url={item.url} size="small" favicon={item.favicon} />
                      <span className="recent-menu__text">
                        <strong>{item.title}</strong>
                        <small>{getHost(item.url)} · {formatHistoryDate(item.visitedAt)} {formatTime(item.visitedAt)}</small>
                      </span>
                    </button>
                  )) : (
                    <p className="recent-menu__empty">还没有最近打开的网页</p>
                  )}
                  <button
                    type="button"
                    className="recent-menu__all"
                    onClick={() => {
                      setRecentOpen(false);
                      props.onHistory();
                    }}
                  >
                    <Clock3 size={15} /> 查看全部历史记录
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <form className={`address-bar ${isFocused ? 'is-focused' : ''}`} onSubmit={submit} role="search">
          <span className="address-bar__security" aria-hidden="true">
            {page || !props.entry.url.startsWith('https:') ? <Search size={17} /> : <LockKeyhole size={15} />}
          </span>
          <input
            id="browser-address"
            aria-label="地址和搜索栏"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => { setIsFocused(true); event.target.select(); }}
            onBlur={() => { setIsFocused(false); setActiveSuggestion(-1); }}
            onContextMenu={openInputMenu}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setActiveSuggestion(-1);
                setAddress(displayUrl(props.entry.url));
                setIsFocused(false);
                event.currentTarget.blur();
              } else if (suggestionsOpen && event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveSuggestion((current) => (current + 1) % suggestions.length);
              } else if (suggestionsOpen && event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveSuggestion((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
              }
            }}
            placeholder="搜索或输入网址"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-autocomplete="list"
            aria-expanded={suggestionsOpen}
            aria-controls={suggestionsOpen ? 'address-suggestions' : undefined}
            aria-activedescendant={suggestionsOpen && activeSuggestion >= 0 ? `address-suggestion-${activeSuggestion}` : undefined}
          />
          {address && isFocused && (
            <button className="address-clear" type="button" aria-label="清空地址" onMouseDown={(event) => event.preventDefault()} onClick={() => setAddress('')}>
              <X size={15} />
            </button>
          )}
          <IconButton
            className="bookmark-button"
            size="small"
            label={props.isBookmarked ? '移除此页书签 (Ctrl+D)' : '为此页添加书签 (Ctrl+D)'}
            active={props.isBookmarked}
            onClick={props.onToggleBookmark}
          >
            <Star size={18} fill={props.isBookmarked ? 'currentColor' : 'none'} />
          </IconButton>
          {suggestionsOpen && (
            <div className="address-suggestions" id="address-suggestions" role="listbox" aria-label="地址栏输入历史">
              {suggestions.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  id={`address-suggestion-${index}`}
                  aria-selected={index === activeSuggestion}
                  key={`${item.url}-${index}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSuggestion(index)}
                  onClick={() => go(item.url)}
                >
                  <SiteIcon url={item.url} size="small" favicon={item.favicon} />
                  <span className="address-suggestions__text">
                    <strong>{item.title}</strong>
                    <small>{displayUrl(item.url)}</small>
                  </span>
                  <Clock3 size={13} />
                </button>
              ))}
            </div>
          )}
        </form>

        <div className="navigation-actions desktop-navigation">
          {props.onToggleReader && (
            <IconButton
              label={props.readerActive ? '退出阅读模式' : '阅读模式 (Ctrl+Shift+R)'}
              active={props.readerActive}
              disabled={!isExternal}
              onClick={props.onToggleReader}
            >
              <Newspaper size={18} />
            </IconButton>
          )}
          <div className="nav-popover-anchor">
            <IconButton
              label="网页翻译 (Ctrl+Shift+Y)"
              active={translateOpen || props.translated}
              disabled={!isExternal}
              onClick={() => setTranslateOpen((open) => !open)}
            >
              <Languages size={18} className={props.translating ? 'is-spinning' : ''} />
            </IconButton>
            {translateOpen && (
              <>
                <button className="popover-dismiss" type="button" aria-label="关闭翻译菜单" onClick={() => setTranslateOpen(false)} />
                <div className="nav-popover popover" role="dialog" aria-label="网页翻译">
                  <div className="nav-popover__title">网页翻译</div>
                  <label className="nav-popover__field">
                    <span>目标语言</span>
                    <select
                      className="settings-select"
                      aria-label="翻译目标语言"
                      value={props.translationTarget}
                      onChange={(event) => props.onTranslationTargetChange(event.target.value)}
                    >
                      {TRANSLATION_TARGETS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <div className="nav-popover__actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={props.translating}
                      onClick={() => { setTranslateOpen(false); props.onTranslatePage(); }}
                    >
                      {props.translating ? '正在翻译…' : '翻译此页'}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!props.translated}
                      onClick={() => { setTranslateOpen(false); props.onRestoreTranslation(); }}
                    >
                      恢复原文
                    </button>
                  </div>
                  <p className="nav-popover__hint">仅替换文字内容，保留页面排版、按钮和链接；可随时恢复原文。</p>
                </div>
              </>
            )}
          </div>
          {props.onScreenshot && (
            <div className="nav-popover-anchor">
              <IconButton
                label="网页截图 (Ctrl+Shift+X)"
                active={screenshotOpen}
                disabled={!isExternal}
                onClick={() => setScreenshotOpen((open) => !open)}
              >
                <Camera size={18} />
              </IconButton>
              {screenshotOpen && (
                <>
                  <button className="popover-dismiss" type="button" aria-label="关闭截图菜单" onClick={() => setScreenshotOpen(false)} />
                  <div className="nav-popover popover nav-popover--screenshot" role="dialog" aria-label="网页截图">
                    <div className="nav-popover__title">网页截图</div>
                    <button
                      type="button"
                      className="nav-popover__primary"
                      onClick={() => {
                        setScreenshotOpen(false);
                        props.onScreenshot?.({ mode: 'save', fullPage: false });
                      }}
                    >
                      保存可见区域
                    </button>
                    <button
                      type="button"
                      className="nav-popover__row"
                      onClick={() => {
                        setScreenshotOpen(false);
                        props.onScreenshot?.({ mode: 'save', fullPage: false, selectRegion: true });
                      }}
                    >
                      <span>选择区域</span>
                      <span>框选</span>
                    </button>
                    <button
                      type="button"
                      className="nav-popover__row"
                      onClick={() => {
                        setScreenshotOpen(false);
                        props.onScreenshot?.({ mode: 'save', fullPage: true });
                      }}
                    >
                      <span>截取整个页面</span>
                      <span>长截图</span>
                    </button>
                    <button
                      type="button"
                      className="nav-popover__row"
                      onClick={() => {
                        setScreenshotOpen(false);
                        props.onScreenshot?.({ mode: 'copy', fullPage: false });
                      }}
                    >
                      <span>复制到剪贴板</span>
                      <span>PNG</span>
                    </button>
                    <p className="nav-popover__hint">截图默认保存到图片目录，也可以直接粘贴到聊天或文档中。</p>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="nav-popover-anchor">
            <IconButton
              label={adblockActive ? `广告与跟踪拦截已开启${props.blockedCount ? `（已拦截 ${props.blockedCount} 项）` : ''}` : '广告与跟踪拦截已关闭'}
              active={shieldOpen || props.blockedCount > 0}
              disabled={!isExternal}
              onClick={() => setShieldOpen((open) => !open)}
            >
              {adblockActive ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}
              {props.blockedCount > 0 && (
                <span className="shield-badge">{props.blockedCount > 99 ? '99+' : props.blockedCount}</span>
              )}
            </IconButton>
            {shieldOpen && (
              <>
                <button className="popover-dismiss" type="button" aria-label="关闭拦截菜单" onClick={() => setShieldOpen(false)} />
                <div className="nav-popover popover" role="dialog" aria-label="广告与跟踪拦截">
                  <div className="nav-popover__title">广告与跟踪拦截</div>
                  <p className="nav-popover__status">
                    {props.adblockEnabled ? '全局拦截已开启' : '全局拦截已关闭'}
                    <em>{props.blockedCount ? `本页已拦截 ${props.blockedCount} 项` : '本页暂未拦截请求'}</em>
                  </p>
                  <button type="button" className="nav-popover__row" onClick={props.onToggleAdblockSite}>
                    <span>对此网站启用拦截</span>
                    <span className={`mini-switch ${adblockActive ? 'is-on' : ''}`} aria-hidden="true"><i /></span>
                  </button>
                  <button type="button" className="nav-popover__link" onClick={() => { setShieldOpen(false); props.onOpenAdblockSettings(); }}>
                    <Settings2 size={14} />拦截设置与白名单
                  </button>
                </div>
              </>
            )}
          </div>
          {props.passwordEntries.length > 0 && (
            <div className="nav-popover-anchor">
              <IconButton
                label={`填充已保存的密码（${props.passwordEntries.length}）`}
                active={passwordsOpen}
                onClick={() => setPasswordsOpen((open) => !open)}
              >
                <KeyRound size={18} />
              </IconButton>
              {passwordsOpen && (
                <>
                  <button className="popover-dismiss" type="button" aria-label="关闭密码菜单" onClick={() => setPasswordsOpen(false)} />
                  <div className="nav-popover popover" role="dialog" aria-label="已保存的登录信息">
                    <div className="nav-popover__title">填充登录信息</div>
                    {props.passwordEntries.map((entry) => (
                      <button
                        type="button"
                        className="nav-popover__password"
                        key={entry.id}
                        onClick={() => { setPasswordsOpen(false); props.onFillPassword(entry); }}
                      >
                        <KeyRound size={14} />
                        <span>{entry.username || '未保存用户名'}</span>
                      </button>
                    ))}
                    <button type="button" className="nav-popover__link" onClick={() => { setPasswordsOpen(false); props.onManagePasswords(); }}>
                      <Settings2 size={14} />管理密码
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <IconButton label="书签" active={page === 'bookmarks'} onClick={props.onBookmarks}><BookOpen size={18} /></IconButton>
          <IconButton label="历史记录" active={page === 'history'} onClick={props.onHistory}><Clock3 size={18} /></IconButton>
          {props.onDownloads && (
            <IconButton
              className="download-button"
              label={props.downloadCount ? `下载内容（${props.downloadCount} 项进行中）` : '下载内容 (Ctrl+J)'}
              onClick={props.onDownloads}
            >
              <Download size={18} />
              {Boolean(props.downloadCount) && <span className="download-button__badge">{props.downloadCount}</span>}
            </IconButton>
          )}
          <IconButton label="设置" active={page === 'settings'} onClick={props.onSettings}><Settings2 size={18} /></IconButton>
        </div>
        <BrowserMenu
          open={menuOpen}
          isOnline={props.isOnline}
          canReopen={props.canReopen}
          searchEngine={props.searchEngine}
          customSearchEngines={props.customSearchEngines}
          onSearchEngineChange={props.onSearchEngineChange}
          onToggle={() => setMenuOpen((open) => !open)}
          onClose={() => setMenuOpen(false)}
          onNewTab={props.onNewTab}
          onReopen={props.onReopen}
          onBookmarks={props.onBookmarks}
          onHistory={props.onHistory}
          onBookmark={props.onToggleBookmark}
          onDownloads={props.onDownloads}
          onIncognito={props.onIncognito}
          onFullscreen={props.onFullscreen}
          onDevTools={props.onDevTools}
          onPrint={props.onPrint}
          onSavePdf={props.onSavePdf}
          onScreenshot={props.onScreenshot ? () => props.onScreenshot?.({ mode: 'save', fullPage: false }) : undefined}
          downloadCount={props.downloadCount}
          onSettings={props.onSettings}
        />
      </div>
      {props.tab.isLoading && (
        <div className="loading-track" role="progressbar" aria-label="页面加载进度" aria-valuenow={props.tab.progress} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${props.tab.progress}%` }} />
        </div>
      )}
      {inputContextMenu}
    </>
  );
}
