import { getSearchEngine } from '../../data/searchEngines';
import type { CustomSearchEngine, SearchEngine } from '../../types';

interface SearchEngineMarkProps {
  engine: SearchEngine;
  customEngines?: CustomSearchEngine[];
  size?: 'small' | 'medium' | 'large';
  withName?: boolean;
}

export function SearchEngineMark({ engine, customEngines = [], size = 'medium', withName = false }: SearchEngineMarkProps) {
  const option = getSearchEngine(engine, customEngines);
  return (
    <span className={`engine-mark engine-mark--${option.color} engine-mark--${size}`}>
      <span className="engine-mark__letter">{option.mark}</span>
      {withName && <span className="engine-mark__name">{option.name}</span>}
    </span>
  );
}
