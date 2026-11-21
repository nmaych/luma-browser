import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Camera, Clock3, Download, History, Home, KeyRound, Languages, LockKeyhole, Newspaper, RotateCw, Search, Settings2, ShieldCheck, ShieldOff, Star, TriangleAlert, X } from 'lucide-react';
import type { BrowserTab, CustomSearchEngine, HistoryItem, SearchEngine, TabEntry } from '../../types';
import { displayUrl, getHost, getInternalPage, isExternalUrl, parseBrowserInput } from '../../utils/url';
import { getSearchEngine } from '../../data/searchEngines';
import { formatHistoryDate, formatTime } from '../../utils/date';
import { IconButton } from '../common/IconButton';
import { SiteIcon } from '../common/SiteIcon';
import { useInputContextMenu } from '../../hooks/useInputContextMenu';
import { useOverlaySurface, isOverlaySurfaceActive } from '../../hooks/useOverlaySurface';
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

/** One row of the address dropdown: what Enter would do, or a place already visited. */
interface AddressSuggestion {
  /** Stable identity for the overlay mirror, which replays clicks by this id. */
  id: string;
  url: string;
  title: string;
  isSearch: boolean;
  hint: string;
  favicon?: string;
}

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
  /** Enabled extensions with a toolbar action; icons live in the address bar. */
  extensionActions?: { id: string; name: string; icon: string | null }[];
  onOpenExtension?: (
    id: string,
    anchor: { x: number; y: number; width: number; height: number },
  ) => void;
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
  onPictureInPicture?: () => void;
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
  const draft = address.trim();
  const draftTarget = useMemo(
    () => (draft ? parseBrowserInput(draft, props.searchEngine, props.customSearchEngines) : null),
    [draft, props.searchEngine, props.customSearchEngines],
  );
  const engineName = useMemo(
    () => getSearchEngine(props.searchEngine, props.customSearchEngines ?? []).name,
    [props.searchEngine, props.customSearchEngines],
  );
  // The first row states what Enter will do, so typing "a" no longer looks like
  // a dead end; matching history follows it.
  const suggestions = useMemo<AddressSuggestion[]>(() => {
    if (!draft) return [];
    const rows: AddressSuggestion[] = [];
    if (draftTarget?.ok) {
      rows.push({
        id: 'draft',
        url: draftTarget.url,
        title: draftTarget.isSearch ? draft : draftTarget.title,
        isSearch: Boolean(draftTarget.isSearch),
        hint: draftTarget.isSearch ? `使用 ${engineName}` : '回车打开',
      });
    }
    if (!props.showSuggestions) return rows;
    const keyword = draft.toLowerCase();
    const seen = new Set<string>(rows.map((row) => row.url));
    for (const item of props.recentPages ?? []) {
      if (rows.length > 6) break;
      if (!isExternalUrl(item.url) || seen.has(item.url)) continue;
      if (!`${item.title} ${item.url}`.toLowerCase().includes(keyword)) continue;
      seen.add(item.url);
      rows.push({
        id: `history:${item.url}`,
        url: item.url,
        title: item.title,
        isSearch: false,
        hint: displayUrl(item.url),
        favicon: item.favicon,
      });
    }
    return rows;
  }, [draft, draftTarget, engineName, props.recentPages, props.showSuggestions]);
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
  const menuRootRef = useRef<HTMLDivElement | null>(null);
  const suggestionsRef = useRef<HTMLDivElement | null>(null);
  const recentRootRef = useRef<HTMLDivElement | null>(null);
  const shieldRootRef = useRef<HTMLDivElement | null>(null);
  const screenshotRootRef = useRef<HTMLDivElement | null>(null);
  const passwordsRootRef = useRef<HTMLDivElement | null>(null);
  // Every popover except the translation panel is mirrored above the page, so
  // the page no longer has to step aside and lose its sharpness.
  useOverlaySurface(menuRootRef, menuOpen);
  useOverlaySurface(suggestionsRef, suggestionsOpen);
  useOverlaySurface(recentRootRef, recentOpen);
  useOverlaySurface(shieldRootRef, shieldOpen);
  useOverlaySurface(screenshotRootRef, screenshotOpen);
  useOverlaySurface(passwordsRootRef, passwordsOpen);
  useEffect(() => {
    // The translation panel holds a <select>, which cannot be driven from the
    // mirror, so it keeps using the parked-page fallback.
    props.onMenuOpenChange?.(translateOpen);
  }, [translateOpen]);
  const closePopovers = () => {
    setMenuOpen(false);
    setRecentOpen(false);
    setShieldOpen(false);
    setTranslateOpen(false);
    setScreenshotOpen(false);
    setPasswordsOpen(false);
    setIsFocused(false);
    setActiveSuggestion(-1);
  };
  useEffect(() => {
    const overlay = window.lumaDesktop?.overlay;
    if (!overlay) return undefined;
    return overlay.onOutside(closePopovers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The page is live underneath, so Escape has to be handled in the renderer.
  useEffect(() => {
    if (!anyPopoverOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closePopovers();
      (document.activeElement as HTMLElement | null)?.blur();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setIsFocused(false);
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
                <div ref={recentRootRef} className="recent-menu popover" role="menu" aria-label="最近打开">
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
          {isExternal && !(isFocused && draftTarget?.isSearch) ? (
            <span
              className="address-bar__security address-bar__security--site"
              title={props.entry.url.startsWith('https:') ? '连接安全' : '不安全连接（未加密）'}
            >
              <SiteIcon url={props.entry.url} favicon={props.tab.favicon} size="small" />
              <span className={`address-bar__lock ${props.entry.url.startsWith('https:') ? 'is-secure' : 'is-insecure'}`} aria-hidden="true">
                {props.entry.url.startsWith('https:') ? <LockKeyhole size={9} /> : <TriangleAlert size={9} />}
              </span>
            </span>
          ) : (
            <span className="address-bar__security" aria-hidden="true">
              <Search size={isFocused ? 15 : 17} />
            </span>
          )}
          <input
            id="browser-address"
            aria-label="地址和搜索栏"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              setIsFocused(true);
              // Editing needs the scheme, and it is also the only way to notice
              // that the page is plain http.
              setAddress(isExternal ? props.entry.url : displayUrl(props.entry.url));
              event.target.select();
            }}
            onBlur={(event) => {
              // A focus move into the mirrored popover reports no related
              // target; the mirror itself dismisses the dropdown, so keep it
              // mounted until the replayed click has run on the real DOM.
              if (!event.relatedTarget && isOverlaySurfaceActive()) return;
              setIsFocused(false);
              setActiveSuggestion(-1);
              setAddress(displayUrl(props.entry.url));
            }}
            onContextMenu={openInputMenu}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setActiveSuggestion(-1);
                setAddress(displayUrl(props.entry.url));
                setIsFocused(false);
                event.currentTarget.blur();
              } else if (event.key === 'Enter' && event.altKey) {
                // Alt+Enter opens the same target in a new tab, like Chrome.
                event.preventDefault();
                const target = suggestionsOpen && activeSuggestion >= 0
                  ? suggestions[activeSuggestion].url
                  : draftTarget?.ok ? draftTarget.url : '';
                if (target) props.onOpenInNewTab(target);
                setIsFocused(false);
                setActiveSuggestion(-1);
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
            <div ref={suggestionsRef} className="address-suggestions" id="address-suggestions" role="listbox" aria-label="地址栏输入历史">
              {suggestions.map((item, index) => (
                <button
                  type="button"
                  role="option"
                  id={`address-suggestion-${index}`}
                  data-menu-item={`address-${item.id}`}
                  aria-selected={index === activeSuggestion}
                  key={item.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveSuggestion(index)}
                  onClick={() => go(item.url)}
                >
                  {item.isSearch
                    ? <span className="address-suggestions__lead"><Search size={14} /></span>
                    : <SiteIcon url={item.url} size="small" favicon={item.favicon} />}
                  <span className="address-suggestions__text">
                    <strong>{item.isSearch ? `搜索“${item.title}”` : item.title}</strong>
                    <small>{item.hint}</small>
                  </span>
                  {item.isSearch ? <span className="address-suggestions__hint">回车</span> : <Clock3 size={13} />}
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
                  <div ref={screenshotRootRef} className="nav-popover popover nav-popover--screenshot" role="dialog" aria-label="网页截图">
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
                <div ref={shieldRootRef} className="nav-popover popover" role="dialog" aria-label="广告与跟踪拦截">
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
                  <div ref={passwordsRootRef} className="nav-popover popover" role="dialog" aria-label="已保存的登录信息">
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
          {props.extensionActions && props.extensionActions.length > 0 && (
            <div className="extension-actions" role="group" aria-label="扩展">
              {props.extensionActions.map((extension) => (
                <button
                  key={extension.id}
                  type="button"
                  className="extension-action"
                  title={extension.name}
                  aria-label={`扩展 ${extension.name}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    props.onOpenExtension?.(extension.id, {
                      x: Math.round(window.screenX + rect.left),
                      y: Math.round(window.screenY + rect.top),
                      width: Math.round(rect.width),
                      height: Math.round(rect.height),
                    });
                  }}
                >
                  {extension.icon
                    ? <img src={extension.icon} alt="" width={16} height={16} />
                    : <span className="extension-action__fallback">{extension.name.slice(0, 1).toUpperCase()}</span>}
                </button>
              ))}
            </div>
          )}
          <IconButton label="设置" active={page === 'settings'} onClick={props.onSettings}><Settings2 size={18} /></IconButton>
        </div>
        <BrowserMenu
          rootRef={menuRootRef}
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
          onPictureInPicture={props.onPictureInPicture}
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
