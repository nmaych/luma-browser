import { useEffect, useState } from 'react';

const iconCache = new Map<string, LumaFileIcon | null>();
const inflight = new Map<string, Promise<LumaFileIcon | null>>();

function loadIcon(id: string): Promise<LumaFileIcon | null> {
  const running = inflight.get(id);
  if (running) return running;
  const request = (async () => {
    try {
      const result = (await window.lumaDesktop?.getDownloadIcon?.(id)) ?? null;
      iconCache.set(id, result);
      return result;
    } catch {
      // A transient failure stays uncached so the next mount can retry.
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, request);
  return request;
}

/**
 * The icon a finished download carries (its own artwork or, for images, a
 * thumbnail of the file). Returns null when the platform cannot describe it,
 * in which case callers fall back to the extension-based icon.
 */
export function useFileIcon(id: string, enabled: boolean): LumaFileIcon | null {
  const [icon, setIcon] = useState<LumaFileIcon | null>(() => (enabled ? iconCache.get(id) ?? null : null));

  useEffect(() => {
    if (!enabled) {
      setIcon(null);
      return undefined;
    }
    const cached = iconCache.get(id);
    if (cached !== undefined) {
      setIcon(cached);
      return undefined;
    }
    setIcon(null);
    let alive = true;
    void loadIcon(id).then((value) => {
      if (alive) setIcon(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled, id]);

  return icon;
}

/** Test seam: forgets everything, so cases do not see each other's icons. */
export function clearFileIconCache(): void {
  iconCache.clear();
  inflight.clear();
}
