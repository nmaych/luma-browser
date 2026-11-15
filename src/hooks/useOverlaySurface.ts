import { useEffect, useRef, type RefObject } from 'react';
import { useNativePageVisible } from './useNativePageVisible';

let cachedCss: string | null = null;
let surfaceCount = 0;

/**
 * True while a popover is mirrored above the page. Focus then belongs to the
 * mirror view, so the address bar must not treat that blur as "user clicked
 * away"; the mirror reports its own dismissal instead.
 */
export function isOverlaySurfaceActive() {
  return surfaceCount > 0;
}

/** All app stylesheets as one string, so the mirrored DOM looks identical. */
function appStyles(): string {
  if (cachedCss !== null) return cachedCss;
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) parts.push(rule.cssText);
    } catch {
      // A stylesheet from another origin cannot be read; the rest still apply.
    }
  }
  cachedCss = parts.join('\n');
  return cachedCss;
}

/**
 * Mirrors an open popover into the transparent view above the native page.
 * The React tree stays the source of truth: the mirror only paints the DOM and
 * reports clicks as element paths, which are replayed on the real elements.
 */
export function useOverlaySurface(rootRef: RefObject<HTMLElement | null>, active: boolean) {
  const nativePage = useNativePageVisible();
  const idRef = useRef(`overlay-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const api = window.lumaDesktop?.overlay;
    const root = rootRef.current;
    if (!api || !active || !nativePage || !root) return undefined;
    const id = idRef.current;
    let frame = 0;
    let first = true;
    const push = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      api.show({
        id,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        html: root.outerHTML,
        css: first ? appStyles() : undefined,
        theme: document.documentElement.dataset.theme || 'light',
      });
      first = false;
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(push);
    };
    surfaceCount += 1;
    push();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(root);
    window.addEventListener('resize', schedule);
    return () => {
      surfaceCount -= 1;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener('resize', schedule);
      api.hide(id);
    };
  }, [active, nativePage, rootRef]);

  useEffect(() => {
    const api = window.lumaDesktop?.overlay;
    if (!api) return undefined;
    return api.onClick((steps) => {
      let node: Element | null = rootRef.current;
      for (const index of steps) {
        node = node?.children[index] ?? null;
        if (!node) return;
      }
      if (node instanceof HTMLElement) node.click();
    });
  }, [rootRef]);
}
