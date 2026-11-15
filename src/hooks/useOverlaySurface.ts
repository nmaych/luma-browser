import { useEffect, useRef, type RefObject } from 'react';
import { useNativePageVisible } from './useNativePageVisible';

let cachedCss: string | null = null;
let cachedCssSize = '';
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
  // The mirror view is only as large as the popover, so the document's own
  // media queries would see a tiny viewport and apply rules the real window
  // never uses (e.g. taller mobile menu rows). Only keep the queries that match
  // the actual window, inlined so they no longer depend on the mirror size.
  const size = `${window.innerWidth}x${window.innerHeight}`;
  if (cachedCss !== null && cachedCssSize === size) return cachedCss;
  const parts: string[] = [];
  const pushRules = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.media.mediaText).matches) pushRules(rule.cssRules);
        continue;
      }
      parts.push(rule.cssText);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      pushRules(sheet.cssRules);
    } catch {
      // A stylesheet from another origin cannot be read; the rest still apply.
    }
  }
  cachedCss = parts.join('\n');
  cachedCssSize = size;
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
    // Styles are resent when the window size changes, because the media queries
    // inlined into the mirror depend on it.
    let cssSize = '';
    const push = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      // offsetWidth/offsetHeight ignore the entrance transform. Reading the
      // scaled rect would mirror the popover at its mid-animation size, which
      // leaves the real popover peeking out behind it (a doubled edge) and adds
      // a scrollbar once the view is smaller than its content.
      const width = root.offsetWidth || Math.round(rect.width);
      const height = root.offsetHeight || Math.round(rect.height);
      if (width < 1 || height < 1) return;
      const size = `${window.innerWidth}x${window.innerHeight}`;
      api.show({
        id,
        rect: {
          x: Math.round(rect.left + (rect.width - width) / 2),
          y: Math.round(rect.top + (rect.height - height) / 2),
          width,
          height,
        },
        html: root.outerHTML,
        css: size === cssSize ? undefined : appStyles(),
        theme: document.documentElement.dataset.theme || 'light',
      });
      cssSize = size;
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
    // A transform-only animation does not resize the element, so neither
    // observer fires when it settles at its final position.
    root.addEventListener('animationend', schedule);
    const settleTimer = window.setTimeout(schedule, 320);
    return () => {
      surfaceCount -= 1;
      if (frame) window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      observer.disconnect();
      resize.disconnect();
      root.removeEventListener('animationend', schedule);
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
