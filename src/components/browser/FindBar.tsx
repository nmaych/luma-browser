import { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';

interface FindBarProps {
  query: string;
  matches: number;
  activeMatch: number;
  onChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function FindBar({ query, matches, activeMatch, onChange, onNext, onPrevious, onClose }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="find-bar" role="search" aria-label="在页面中查找">
      <span className="find-bar__icon"><Search size={15} /></span>
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="在页面中查找"
        aria-label="查找内容"
        spellCheck={false}
      />
      <span className="find-bar__count" aria-live="polite">
        {query ? (matches > 0 ? `${activeMatch}/${matches}` : '无结果') : ''}
      </span>
      <button type="button" aria-label="上一个匹配" title="上一个 (Shift+Enter)" disabled={!query || matches === 0} onClick={onPrevious}>
        <ChevronUp size={15} />
      </button>
      <button type="button" aria-label="下一个匹配" title="下一个 (Enter)" disabled={!query || matches === 0} onClick={onNext}>
        <ChevronDown size={15} />
      </button>
      <button type="button" aria-label="关闭查找" title="关闭 (Esc)" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}
