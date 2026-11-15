import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, ChevronDown, Clock3, SlidersHorizontal, Sparkles, Target } from 'lucide-react';
import { QUICK_LINKS } from '../data/defaults';
import { getAllSearchEngines, getSearchEngine } from '../data/searchEngines';
import type { CustomSearchEngine, HistoryItem, SearchEngine } from '../types';
import { formatFullDate, formatTime } from '../utils/date';
import { getHost } from '../utils/url';
import { readStorage, writeStorage } from '../utils/storage';
import { Logo } from '../components/common/Logo';
import { SearchEngineMark } from '../components/common/SearchEngineMark';
import { SiteIcon } from '../components/common/SiteIcon';
import { useInputContextMenu } from '../hooks/useInputContextMenu';

interface HomePageProps {
  history: HistoryItem[];
  tabCount: number;
  bookmarkCount: number;
  searchEngine: SearchEngine;
  customSearchEngines?: CustomSearchEngine[];
  onSearchEngineChange: (engine: SearchEngine) => void;
  onNavigate: (input: string) => void;
  onOpenInNewTab: (url: string) => void;
  onHistory: () => void;
  onBookmarks: () => void;
  onCustomize: () => void;
}

export function HomePage(props: HomePageProps) {
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(() => readStorage('luma.daily-focus', ''));
  const [now, setNow] = useState(() => new Date());
  const engine = getSearchEngine(props.searchEngine, props.customSearchEngines);
  const { onContextMenu: openSearchMenu, inputContextMenu } = useInputContextMenu({
    value: query,
    onChange: setQuery,
    onGo: (value) => {
      if (value.trim()) {
        props.onNavigate(value);
        setQuery('');
      }
    },
    label: '搜索栏选项',
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => writeStorage('luma.daily-focus', focus), [focus]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) {
      props.onNavigate(query);
      setQuery('');
    }
  };

  return (
    <div className="home-page page-scroll">
      <div className="home-ambient home-ambient--one" />
      <div className="home-ambient home-ambient--two" />
      <main className="home-container">
        <section className="home-hero">
          <div className="home-logo-wrap">
            <Logo size={60} />
            <span className="home-logo-spark"><Sparkles size={16} /></span>
          </div>
          <p className="home-eyebrow">LUMA · 轻盈，自有方向</p>
          <h1>今天，想去哪里？</h1>
          <p className="home-subtitle">搜索网络，或从一个熟悉的地方继续。</p>
          <form className={`home-search home-search--${engine.color}`} onSubmit={submit} role="search">
            <label className="home-search__engine" title={`默认搜索引擎：${engine.name}`}>
              <SearchEngineMark engine={props.searchEngine} customEngines={props.customSearchEngines} size="small" />
              <span>{engine.name}</span>
              <ChevronDown size={13} />
              <select
                aria-label="选择默认搜索引擎"
                value={props.searchEngine}
                onChange={(event) => props.onSearchEngineChange(event.target.value as SearchEngine)}
              >
                {getAllSearchEngines(props.customSearchEngines).map((option) => (
                  <option value={option.id} key={option.id}>{option.name}</option>
                ))}
              </select>
            </label>
            <span className="home-search__divider" />
            <input
              aria-label="搜索网络或输入网址"
              placeholder={engine.placeholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onContextMenu={openSearchMenu}
              autoComplete="off"
            />
            <span className="search-enter-hint">Enter</span>
            <button type="submit" aria-label="开始搜索" disabled={!query.trim()}><ArrowRight size={20} /></button>
          </form>
          {inputContextMenu}
        </section>

        <section className="quick-links" aria-labelledby="quick-links-title">
          <div className="section-heading">
            <h2 id="quick-links-title">快捷访问</h2>
            <span>常用网站，一触即达</span>
          </div>
          <div className="quick-links-grid">
            {QUICK_LINKS.map((link) => (
              <button className="quick-link" type="button" key={link.url} onClick={() => props.onNavigate(link.url)}>
                <span className={`quick-link__icon quick-link__icon--${link.color}`}>{link.mark}</span>
                <span>{link.title}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="home-dashboard">
          <section className="recent-section">
            <div className="section-heading">
              <h2>继续浏览</h2>
              {props.history.length > 0 && <button type="button" onClick={props.onHistory}>全部记录 <ArrowRight size={14} /></button>}
            </div>
            {props.history.length > 0 ? (
              <div className="recent-list">
                {props.history.slice(0, 3).map((item) => (
                  <button className="recent-item" type="button" key={item.id} onClick={() => props.onOpenInNewTab(item.url)}>
                    <SiteIcon url={item.url} />
                    <span className="recent-item__text"><strong>{item.title}</strong><small>{getHost(item.url)}</small></span>
                    <time>{formatTime(item.visitedAt)}</time>
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="recent-empty">
                <div className="recent-empty__art"><Clock3 size={26} /><span /></div>
                <div><strong>这里还很安静</strong><p>你访问的网页会出现在这里，方便随时继续。</p></div>
                <button type="button" onClick={() => props.onNavigate('https://example.com/')}>试试示例网页 <ArrowRight size={14} /></button>
              </div>
            )}
          </section>

          <aside className="today-card">
            <div className="today-card__top">
              <div><span>今日概览</span><strong>{formatFullDate(now.getTime())}</strong></div>
              <span className="today-time">{formatTime(now.getTime())}</span>
            </div>
            <div className="today-stats">
              <button type="button" onClick={props.onBookmarks}><BookOpen size={16} /><span><strong>{props.bookmarkCount}</strong> 个书签</span></button>
              <div><span className="tiny-tab-icon" /><span><strong>{props.tabCount}</strong> 个标签</span></div>
            </div>
            <label className="focus-field">
              <span><Target size={15} /> 今日专注</span>
              <input value={focus} onChange={(event) => setFocus(event.target.value)} placeholder="写下一个小目标…" maxLength={60} />
            </label>
          </aside>
        </div>
        <footer className="home-footer">
          <span />
          有序浏览，专注当下
          <button className="home-customize" type="button" onClick={props.onCustomize}><SlidersHorizontal size={12} /> 自定义主页</button>
          <span />
        </footer>
      </main>
    </div>
  );
}
