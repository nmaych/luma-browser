import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, Home, SlidersHorizontal, Sparkles } from 'lucide-react';
import { QUICK_LINKS } from '../data/defaults';
import { getAllSearchEngines, getSearchEngine } from '../data/searchEngines';
import type { CustomSearchEngine, SearchEngine } from '../types';
import { formatFullDate, formatTime } from '../utils/date';
import { Logo } from '../components/common/Logo';
import { SearchEngineMark } from '../components/common/SearchEngineMark';
import { useInputContextMenu } from '../hooks/useInputContextMenu';

interface NewTabPageProps {
  searchEngine: SearchEngine;
  customSearchEngines?: CustomSearchEngine[];
  onSearchEngineChange: (engine: SearchEngine) => void;
  onNavigate: (input: string) => void;
  onOpenHome: () => void;
  onCustomize: () => void;
}

function greeting(hour: number): string {
  if (hour < 5) return '夜深了，慢慢来';
  if (hour < 11) return '早上好，今天想做点什么？';
  if (hour < 14) return '中午好，稍作休息';
  if (hour < 18) return '下午好，保持专注';
  return '晚上好，收个尾吧';
}

export function NewTabPage(props: NewTabPageProps) {
  const [query, setQuery] = useState('');
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
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) {
      props.onNavigate(query);
      setQuery('');
    }
  };

  return (
    <div className="newtab-page page-scroll">
      <main className="newtab-container">
        <div className="newtab-brand"><Logo size={30} withWordmark /><span><Sparkles size={12} /> {formatFullDate(now.getTime())}</span></div>

        <section className="newtab-hero">
          <p className="newtab-eyebrow">新标签页 · {greeting(now.getHours())}</p>
          <h1 aria-label="新标签页">{formatTime(now.getTime())}</h1>
          <p className="newtab-date">{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now)}</p>
          <form className={`home-search newtab-search home-search--${engine.color}`} onSubmit={submit} role="search">
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

        <section className="newtab-links" aria-label="常用网站">
          {QUICK_LINKS.map((link) => (
            <button className="quick-link" type="button" key={link.url} onClick={() => props.onNavigate(link.url)}>
              <span className={`quick-link__icon quick-link__icon--${link.color}`}>{link.mark}</span>
              <span>{link.title}</span>
            </button>
          ))}
        </section>

        <footer className="newtab-footer">
          <button type="button" onClick={props.onOpenHome}><Home size={14} /> 打开主页</button>
          <button type="button" onClick={props.onCustomize}><SlidersHorizontal size={14} /> 自定义主页</button>
        </footer>
      </main>
    </div>
  );
}
