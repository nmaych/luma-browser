import { beforeEach, describe, expect, it, vi } from 'vitest';

const CACHE_KEY = 'luma.favicon-cache.v1';

function stubDesktop(fetchFavicon: (url: string) => Promise<string | null>) {
  (window as unknown as { lumaDesktop?: unknown }).lumaDesktop = {
    isDesktop: true,
    isIncognito: false,
    fetchFavicon,
  };
}

describe('favicon cache', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    delete (window as unknown as { lumaDesktop?: unknown }).lumaDesktop;
  });

  it('downloads a site icon once and serves later lookups from storage', async () => {
    const fetchFavicon = vi.fn(async () => 'data:image/png;base64,AAAA');
    stubDesktop(fetchFavicon);
    const { resolveFavicon, getCachedFavicon } = await import('../src/utils/faviconCache');

    const first = await resolveFavicon('https://example.com/article');
    expect(first).toBe('data:image/png;base64,AAAA');
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    expect(fetchFavicon).toHaveBeenCalledWith('https://example.com/favicon.ico');

    expect(getCachedFavicon('https://example.com/another')).toBe(first);
    await expect(resolveFavicon('https://example.com/another')).resolves.toBe(first);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);

    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    expect(stored['https://example.com'].icon).toBe(first);
  });

  it('prefers the live page icon over the default path', async () => {
    const fetchFavicon = vi.fn(async () => 'data:image/png;base64,BBBB');
    stubDesktop(fetchFavicon);
    const { resolveFavicon } = await import('../src/utils/faviconCache');

    const icon = await resolveFavicon('https://news.example.com/post', 'https://cdn.example.com/icon.png');
    expect(icon).toBe('data:image/png;base64,BBBB');
    expect(fetchFavicon).toHaveBeenCalledWith('https://cdn.example.com/icon.png');
  });

  it('ignores internal pages and non-image responses', async () => {
    const fetchFavicon = vi.fn(async () => null);
    stubDesktop(fetchFavicon);
    const { resolveFavicon, getCachedFavicon, rememberFavicon } = await import('../src/utils/faviconCache');

    await expect(resolveFavicon('luma://bookmarks')).resolves.toBeUndefined();
    await expect(resolveFavicon('https://empty.example.com')).resolves.toBeUndefined();
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
    expect(getCachedFavicon('https://empty.example.com')).toBeUndefined();

    expect(rememberFavicon('https://example.com', 'https://example.com/favicon.ico')).toBe(false);
    expect(rememberFavicon('https://example.com', 'data:image/png;base64,CCCC')).toBe(true);
    expect(getCachedFavicon('https://example.com/page')).toBe('data:image/png;base64,CCCC');
  });

  it('deduplicates concurrent requests for one origin', async () => {
    const fetchFavicon = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'data:image/png;base64,DDDD';
    });
    stubDesktop(fetchFavicon);
    const { resolveFavicon } = await import('../src/utils/faviconCache');

    const results = await Promise.all([
      resolveFavicon('https://one.example.com/a'),
      resolveFavicon('https://one.example.com/b'),
      resolveFavicon('https://one.example.com/c'),
    ]);
    expect(results.every((icon) => icon === 'data:image/png;base64,DDDD')).toBe(true);
    expect(fetchFavicon).toHaveBeenCalledTimes(1);
  });

  it('reports cache age and can bypass the cache once for the startup check', async () => {
    const icons = ['data:image/png;base64,EEEE', 'data:image/png;base64,FFFF'];
    const fetchFavicon = vi.fn(async () => icons.shift() ?? 'data:image/png;base64,GGGG');
    stubDesktop(fetchFavicon);
    const { resolveFavicon, refreshFavicon, getFaviconAge, getCachedFavicon } = await import('../src/utils/faviconCache');

    expect(getFaviconAge('https://stale.example.com/page')).toBeNull();
    await resolveFavicon('https://stale.example.com/page');
    expect(getFaviconAge('https://stale.example.com/page')).toBeTypeOf('number');

    // resolve() keeps answering from the cache; refresh() asks the network again.
    await expect(resolveFavicon('https://stale.example.com/page')).resolves.toBe('data:image/png;base64,EEEE');
    await expect(refreshFavicon('https://stale.example.com/page')).resolves.toBe('data:image/png;base64,FFFF');
    expect(fetchFavicon).toHaveBeenCalledTimes(2);
    expect(getCachedFavicon('https://stale.example.com/page')).toBe('data:image/png;base64,FFFF');
  });
});
