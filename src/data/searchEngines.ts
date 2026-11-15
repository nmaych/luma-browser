import type { BuiltInSearchEngine, CustomSearchEngine, SearchEngine } from '../types';

export interface SearchEngineOption {
  id: SearchEngine;
  name: string;
  domain: string;
  mark: string;
  color: 'baidu' | 'google' | 'bing' | 'custom';
  placeholder: string;
  urlTemplate: string;
  isCustom?: boolean;
}

const URL_TEMPLATES: Record<BuiltInSearchEngine, string> = {
  baidu: 'https://www.baidu.com/s?wd=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
};

export const SEARCH_ENGINES: SearchEngineOption[] = [
  {
    id: 'baidu',
    name: '百度',
    domain: 'baidu.com',
    mark: '百',
    color: 'baidu',
    placeholder: '在百度中搜索，或输入网址',
    urlTemplate: URL_TEMPLATES.baidu,
  },
  {
    id: 'google',
    name: '谷歌',
    domain: 'google.com',
    mark: 'G',
    color: 'google',
    placeholder: '在 Google 中搜索，或输入网址',
    urlTemplate: URL_TEMPLATES.google,
  },
  {
    id: 'bing',
    name: 'Bing',
    domain: 'bing.com',
    mark: 'b',
    color: 'bing',
    placeholder: '在 Bing 中搜索，或输入网址',
    urlTemplate: URL_TEMPLATES.bing,
  },
];

function getDomain(template: string): string {
  try {
    return new URL(template.replace('%s', '')).hostname.replace(/^www\./, '');
  } catch {
    return '自定义搜索';
  }
}

function customToOption(engine: CustomSearchEngine): SearchEngineOption {
  return {
    id: engine.id as SearchEngine,
    name: engine.name,
    domain: getDomain(engine.urlTemplate),
    mark: engine.name.trim().charAt(0).toUpperCase() || 'S',
    color: 'custom',
    placeholder: `在${engine.name}中搜索，或输入网址`,
    urlTemplate: engine.urlTemplate,
    isCustom: true,
  };
}

export function getAllSearchEngines(customEngines: CustomSearchEngine[] = []): SearchEngineOption[] {
  return [...SEARCH_ENGINES, ...customEngines.map(customToOption)];
}

export function getSearchEngine(id: SearchEngine, customEngines: CustomSearchEngine[] = []): SearchEngineOption {
  return getAllSearchEngines(customEngines).find((engine) => engine.id === id) ?? SEARCH_ENGINES[0];
}

export function getSearchUrl(id: SearchEngine, query: string, customEngines: CustomSearchEngine[] = []): string {
  const option = getSearchEngine(id, customEngines);
  return option.urlTemplate.split('%s').join(encodeURIComponent(query));
}

export function isKnownSearchEngine(
  value: unknown,
  customEngines: CustomSearchEngine[] = [],
): value is SearchEngine {
  return typeof value === 'string' && getAllSearchEngines(customEngines).some((engine) => engine.id === value);
}

export function validateSearchEngineTemplate(template: string): string | null {
  const trimmed = template.trim();
  if (!trimmed.includes('%s')) return '搜索地址必须包含 %s 作为关键词占位符';
  try {
    const parsed = new URL(trimmed.replace('%s', 'luma browser'));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '只支持 HTTP 或 HTTPS 搜索地址';
    return null;
  } catch {
    return '请输入有效的搜索地址';
  }
}

export function sanitizeCustomEngines(value: unknown): CustomSearchEngine[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CustomSearchEngine => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<CustomSearchEngine>;
    return (
      typeof candidate.id === 'string' &&
      candidate.id.startsWith('custom:') &&
      typeof candidate.name === 'string' &&
      candidate.name.trim().length > 0 &&
      typeof candidate.urlTemplate === 'string' &&
      validateSearchEngineTemplate(candidate.urlTemplate) === null
    );
  }).map((engine) => ({
    id: engine.id as CustomSearchEngine['id'],
    name: engine.name.trim().slice(0, 30),
    urlTemplate: engine.urlTemplate.trim(),
    createdAt: Number(engine.createdAt) || Date.now(),
  }));
}
