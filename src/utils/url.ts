import { getSearchUrl } from '../data/searchEngines';
import type { CustomSearchEngine, InternalPage, ParsedInput, SearchEngine } from '../types';

export const INTERNAL_ROUTES: Record<InternalPage, string> = {
  home: 'luma://home',
  newtab: 'luma://newtab',
  bookmarks: 'luma://bookmarks',
  history: 'luma://history',
  settings: 'luma://settings',
};

export const INTERNAL_TITLES: Record<InternalPage, string> = {
  home: '主页',
  newtab: '新标签页',
  bookmarks: '书签',
  history: '历史记录',
  settings: '设置',
};

export function getInternalPage(url: string): InternalPage | null {
  const match = url.match(/^luma:\/\/(home|newtab|bookmarks|history|settings)\/?$/);
  return match ? (match[1] as InternalPage) : null;
}

export function isExternalUrl(url: string): boolean {
  return /^(https?|file):\/\//i.test(url);
}

export function isFileUrl(url: string): boolean {
  return /^file:\/\//i.test(url);
}

export function getHost(url: string): string {
  if (isFileUrl(url)) return '本地文件';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Converts Windows, POSIX and file:// input into a file URL; returns null for other text. */
export function toFileUrl(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;

  if (/^file:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      return url.protocol === 'file:' ? url.href : null;
    } catch {
      return null;
    }
  }

  const isWindowsPath = /^[a-zA-Z]:[\\/]/.test(input);
  const isUncPath = /^\\\\[^\\]+\\/.test(input);
  const isPosixPath = /^\/(?!\/)/.test(input);
  if (!isWindowsPath && !isUncPath && !isPosixPath) return null;

  const normalized = input.replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (isUncPath) return `file://${encoded.slice(2)}`;
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

function fileTitle(url: string): string {
  const pathPart = decodeURIComponent(url.replace(/^file:\/\/[^/]*/i, ''));
  const name = pathPart.split('/').filter(Boolean).pop();
  return name || '本地文件';
}

export function getFaviconLetter(url: string): string {
  const host = getHost(url);
  return host.charAt(0).toUpperCase() || 'L';
}

/** Best-effort icon URL for sites without a captured favicon. */
export function getDefaultFavicon(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return undefined;
  }
}

function looksLikeDomain(value: string): boolean {
  return (
    /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(value) ||
    /^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)
  );
}

/** Matches mainstream browser omnibox behavior: URLs navigate, other text searches. */
export function parseBrowserInput(
  rawInput: string,
  engine: SearchEngine = 'baidu',
  customEngines: CustomSearchEngine[] = [],
): ParsedInput {
  const input = rawInput.trim();
  if (!input) {
    return {
      ok: false,
      url: '',
      title: '',
      isExternal: false,
      message: '请输入网址或搜索内容',
    };
  }

  if (getInternalPage(input)) {
    const page = getInternalPage(input)!;
    return {
      ok: true,
      url: INTERNAL_ROUTES[page],
      title: INTERNAL_TITLES[page],
      isExternal: false,
    };
  }

  const fileUrl = toFileUrl(input);
  if (fileUrl) {
    return {
      ok: true,
      url: fileUrl,
      title: fileTitle(fileUrl),
      isExternal: true,
    };
  }

  // A port suffix (localhost:3000) is not a protocol, despite the colon.
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !looksLikeDomain(input);
  const candidate = hasScheme ? input : looksLikeDomain(input) ? `https://${input}` : null;

  if (candidate) {
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || /\s/.test(input)) {
        throw new Error('Unsupported URL');
      }
      return {
        ok: true,
        url: url.href,
        title: getHost(url.href),
        isExternal: true,
      };
    } catch {
      return {
        ok: false,
        url: '',
        title: '',
        isExternal: false,
        message: '这个地址似乎不正确，请检查后重试',
      };
    }
  }

  if (hasScheme) {
    return {
      ok: false,
      url: '',
      title: '',
      isExternal: false,
      message: '暂不支持此协议，请使用 http 或 https 地址',
    };
  }

  return {
    ok: true,
    url: getSearchUrl(engine, input, customEngines),
    title: `${input} - 搜索`,
    isExternal: true,
  };
}

export function displayUrl(url: string): string {
  if (url === INTERNAL_ROUTES.home || url === INTERNAL_ROUTES.newtab) return '';
  if (isFileUrl(url)) {
    const raw = decodeURIComponent(url.replace(/^file:\/\//i, ''));
    return /^\/[a-zA-Z]:\//.test(raw) ? raw.slice(1) : raw;
  }
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}
