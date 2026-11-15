import { readStorage, writeStorage } from './storage';

/**
 * Site icons are downloaded once and kept as data URLs. Bookmarks then render
 * from local storage instead of hitting the network on every visit.
 */
const CACHE_KEY = 'luma.favicon-cache.v1';
const MAX_ENTRIES = 240;
const MAX_TOTAL_CHARS = 2_200_000;
const MAX_ICON_CHARS = 420_000;

interface FaviconCacheEntry {
  icon: string;
  savedAt: number;
}

type FaviconCacheMap = Record<string, FaviconCacheEntry>;

const pending = new Map<string, Promise<string | undefined>>();
let memoryCache: FaviconCacheMap | null = null;

export function faviconOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function sanitizeCache(value: unknown): FaviconCacheMap {
  if (!value || typeof value !== 'object') return {};
  const next: FaviconCacheMap = {};
  for (const [origin, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!origin || entry === null || typeof entry !== 'object') continue;
    const icon = (entry as FaviconCacheEntry).icon;
    if (typeof icon !== 'string' || !icon.startsWith('data:image/') || icon.length > MAX_ICON_CHARS) continue;
    const savedAt = Number((entry as FaviconCacheEntry).savedAt);
    next[origin] = { icon, savedAt: Number.isFinite(savedAt) ? savedAt : Date.now() };
  }
  return next;
}

function cache(): FaviconCacheMap {
  if (!memoryCache) memoryCache = sanitizeCache(readStorage(CACHE_KEY, {}));
  return memoryCache;
}

function persist(map: FaviconCacheMap): void {
  if (window.lumaDesktop?.isIncognito) return;
  const entries = Object.entries(map).sort((left, right) => right[1].savedAt - left[1].savedAt);
  const next: FaviconCacheMap = {};
  let total = 0;
  for (const [origin, entry] of entries) {
    if (Object.keys(next).length >= MAX_ENTRIES) break;
    if (total + entry.icon.length > MAX_TOTAL_CHARS) break;
    next[origin] = entry;
    total += entry.icon.length;
  }
  memoryCache = next;
  writeStorage(CACHE_KEY, next);
}

export function getCachedFavicon(url?: string): string | undefined {
  const origin = url ? faviconOrigin(url) : null;
  if (!origin) return undefined;
  return cache()[origin]?.icon;
}

/** Stores an already-resolved icon (usually straight from the live page). */
export function rememberFavicon(url: string, icon?: string | null): boolean {
  const origin = faviconOrigin(url);
  if (!origin || !icon || !icon.startsWith('data:image/') || icon.length > MAX_ICON_CHARS) return false;
  const map = cache();
  if (map[origin]?.icon === icon) return false;
  map[origin] = { icon, savedAt: Date.now() };
  persist(map);
  return true;
}

/** Turns an http(s) icon into a data URL. Desktop goes through the main process. */
async function downloadIcon(iconUrl: string): Promise<string | undefined> {
  if (!/^https?:\/\//i.test(iconUrl)) return undefined;
  const desktop = window.lumaDesktop;
  if (desktop?.isDesktop && desktop.fetchFavicon) {
    const icon = await desktop.fetchFavicon(iconUrl).catch(() => null);
    return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : undefined;
  }
  // Browser preview: only same-origin icons can be read without CORS.
  try {
    const response = await fetch(iconUrl, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > MAX_ICON_CHARS * 0.75 || blob.size === 0) return undefined;
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/**
 * Resolves an icon for a page and remembers it. Resolves in-flight requests per
 * origin so several bookmarks on one site only trigger a single download.
 */
export async function resolveFavicon(url: string, candidate?: string): Promise<string | undefined> {
  const origin = faviconOrigin(url);
  if (!origin) return undefined;
  const cached = cache()[origin]?.icon;
  if (cached) return cached;
  const running = pending.get(origin);
  if (running) return running;

  const task = (async () => {
    const sources = [candidate, `${origin}/favicon.ico`]
      .filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value))
      .filter((value, index, list) => list.indexOf(value) === index);
    for (const source of sources) {
      const icon = await downloadIcon(source);
      if (icon) {
        rememberFavicon(url, icon);
        return icon;
      }
    }
    return undefined;
  })();

  pending.set(origin, task);
  try {
    return await task;
  } finally {
    pending.delete(origin);
  }
}
