export interface ReaderArticle {
  title: string;
  byline: string;
  site: string;
  url: string;
  content: string;
  textLength: number;
  prevUrl?: string;
  nextUrl?: string;
}

export interface ReaderExtractionResult {
  ok: boolean;
  title?: string;
  byline?: string;
  site?: string;
  url?: string;
  content?: string;
  textLength?: number;
  prevUrl?: string;
  nextUrl?: string;
  reason?: string;
}

function extractArticleInPage() {
  // Inlined because this function is serialized and executed inside the page.
  const noiseSelector = 'script,style,noscript,iframe,form,button,input,select,textarea,nav,aside,footer,header,video,audio,svg,canvas,object,embed,[aria-hidden="true"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],.ad,.ads,.advert,.adsbygoogle,.share,.sharing,.social,.comment,.comments,.sidebar,.related,.newsletter,.cookie,.popup,.modal,.breadcrumb,.breadcrumbs,.crumbs,.bookinfo,.book-info,.article-info,.readtip,.read-tips,.tips,.notice,.bdsub,.bottem,.button2,[id="center_tip"],#center_tip';
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'FORM', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'VIDEO', 'AUDIO']);

  const textOf = (element: Element) =>
    (element instanceof HTMLElement && typeof element.innerText === 'string'
      ? element.innerText
      : element.textContent) || '';

  const scoreElement = (element: Element) => {
    const text = textOf(element).trim();
    if (text.length < 80) return 0;
    const paragraphs = element.querySelectorAll('p').length;
    let linkLength = 0;
    for (const anchor of element.querySelectorAll('a')) linkLength += textOf(anchor).trim().length;
    const linkDensity = linkLength / Math.max(1, text.length);
    const headingBonus = element.querySelectorAll('h1,h2,h3').length * 12;
    return text.length * (1 - Math.min(0.85, linkDensity)) + paragraphs * 28 + headingBonus;
  };

  let best: Element | null = null;
  let bestScore = 0;
  // Novel and CMS templates expose stable article containers; prefer them over a larger wrapper
  // that also contains breadcrumbs, book metadata and toolbars.
  const prioritySelectors = '#content,#chaptercontent,#chapter-content,.yuedu_zhengwen,.chapter-content,.article-content,.read-content,.entry-content,.post-content,[itemprop="articleBody"]';
  for (const element of [...document.querySelectorAll(prioritySelectors)]) {
    const score = scoreElement(element);
    if (score > bestScore && textOf(element).trim().length > 300) {
      bestScore = score;
      best = element;
    }
  }
  const hasPriorityArticle = Boolean(best);
  if (!hasPriorityArticle) {
    const preferred = [...document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"]')];
    for (const element of preferred) {
      const score = scoreElement(element) * 1.25;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
    const candidates = [...document.querySelectorAll('div, section')].slice(0, 900);
    for (const element of candidates) {
      if (skipTags.has(element.tagName)) continue;
      const score = scoreElement(element);
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }
  }
  if (!best || bestScore < 80) {
    return { ok: false, reason: 'no-article' };
  }

  const clone = best.cloneNode(true) as Element;
  clone.querySelectorAll(noiseSelector).forEach((node) => node.remove());
  clone.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name === 'href' && !/^\s*(javascript|vbscript|data):/i.test(attribute.value)) continue;
      if (name === 'src' && /^\s*(https?:|data:image\/)/i.test(attribute.value)) continue;
      if (name === 'colspan' || name === 'rowspan') continue;
      element.removeAttribute(attribute.name);
    }
  });
  clone.querySelectorAll('a[href]').forEach((anchor) => {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noreferrer');
  });

  const heading = document.querySelector('h1');
  const metaTitle = document.querySelector('meta[property="og:title"]');
  const metaAuthor = document.querySelector('meta[name="author"]');
  const metaSite = document.querySelector('meta[property="og:site_name"]');
  const title = (heading ? textOf(heading) : '') || metaTitle?.getAttribute('content') || document.title || '';
  const authorElement = document.querySelector('[rel="author"], .author, .byline');
  const byline = metaAuthor?.getAttribute('content')
    || (authorElement ? textOf(authorElement).slice(0, 80) : '');

  const normalizeLink = (value: string | null) => {
    if (!value) return '';
    try {
      const parsed = new URL(value, location.href);
      if (!/^https?:$/i.test(parsed.protocol) || parsed.href === location.href) return '';
      return parsed.href;
    } catch {
      return '';
    }
  };
  const anchorLabel = (anchor: Element) => (anchor.textContent || '').replace(/\s+/g, ' ').trim();
  const anchorMeta = (anchor: Element) =>
    `${anchor.id || ''} ${anchor.className || ''} ${anchor.getAttribute('rel') || ''} ${anchor.getAttribute('title') || ''} ${anchor.getAttribute('aria-label') || ''}`.toLowerCase();
  const nextPattern = /下一[章节頁页篇回]|下章|下回|下一页|next\s*(?:chapter|page)/i;
  const prevPattern = /上一[章节頁页篇回]|上章|上回|上一页|prev(?:ious)?\s*(?:chapter|page)/i;
  let prevUrl = '';
  let nextUrl = '';
  const anchors = [...document.querySelectorAll('a[href]')];
  for (const anchor of anchors) {
    const href = normalizeLink(anchor.getAttribute('href'));
    if (!href) continue;
    const label = anchorLabel(anchor);
    const meta = anchorMeta(anchor);
    if (!nextUrl && (nextPattern.test(label) || /(^|[\s_-])(next|nextpage|next-chapter|next_chapter)([\s_-]|$)/i.test(meta))) {
      nextUrl = href;
    }
    if (!prevUrl && (prevPattern.test(label) || /(^|[\s_-])(prev|previous|prevpage|prev-chapter|prev_chapter)([\s_-]|$)/i.test(meta))) {
      prevUrl = href;
    }
    if (nextUrl && prevUrl) break;
  }
  if (!nextUrl) {
    nextUrl = normalizeLink(document.querySelector('link[rel~="next"]')?.getAttribute('href') ?? null);
  }
  if (!prevUrl) {
    prevUrl = normalizeLink(document.querySelector('link[rel~="prev"]')?.getAttribute('href') ?? null);
  }

  // The reader header already shows the title; drop the duplicated heading.
  const cloneHeading = clone.querySelector('h1');
  if (cloneHeading && textOf(cloneHeading).trim() === title.trim()) cloneHeading.remove();
  const content = clone.innerHTML;
  if (content.length > 900_000) return { ok: false, reason: 'too-large' };

  return {
    ok: true,
    title: title.trim().slice(0, 300),
    byline: byline.trim().slice(0, 120),
    site: metaSite?.getAttribute('content') || location.hostname,
    url: location.href,
    content,
    textLength: textOf(best).trim().length,
    prevUrl,
    nextUrl,
  };
}

export const READER_EXTRACT_SCRIPT = `(${extractArticleInPage.toString()})()`;

const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'EM', 'STRONG', 'B', 'I', 'U',
  'A', 'IMG', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
  'HR', 'BR', 'SUP', 'SUB', 'MARK', 'DL', 'DT', 'DD', 'ABBR', 'TIME', 'SMALL', 'CITE', 'Q',
]);

/** Removes scripts, styles, event handlers and unsafe URLs from extracted HTML. */
export function sanitizeReaderHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="reader-root">${html}</div>`, 'text/html');
  const root = doc.getElementById('reader-root');
  if (!root) return '';
  root.querySelectorAll('script,style,noscript,iframe,object,embed,form,input,button,select,textarea,link,meta').forEach((node) => node.remove());
  for (const element of [...root.querySelectorAll('*')]) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...[...element.childNodes]);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name === 'href' && !/^\s*(https?:|mailto:|#|\/|\.)/i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'src' && !/^\s*(https?:|data:image\/|\/|\.)/i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' || name === 'src' || name === 'colspan' || name === 'rowspan' || name === 'alt' || name === 'title' || name === 'target' || name === 'rel') {
        continue;
      }
      element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'A') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer');
    }
  }
  return root.innerHTML;
}

function extractTranslatableBlocks() {
  const scope = window as unknown as {
    __lumaTranslateNodes?: Text[];
    __lumaTranslateOriginal?: string[];
  };
  // Restore a previous translation first so switching target languages starts from the source text.
  if (Array.isArray(scope.__lumaTranslateNodes) && Array.isArray(scope.__lumaTranslateOriginal)) {
    scope.__lumaTranslateNodes.forEach((node, index) => {
      const original = scope.__lumaTranslateOriginal?.[index];
      if (node?.isConnected && typeof original === 'string') node.nodeValue = original;
    });
  }
  scope.__lumaTranslateNodes = [];
  scope.__lumaTranslateOriginal = [];

  const skipSelector = 'script,style,noscript,textarea,input,select,option,code,pre,kbd,samp,svg,canvas,[contenteditable="true"],[aria-hidden="true"]';
  const nodes: Text[] = [];
  const texts: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current && texts.length < 160) {
    const textNode = current as Text;
    const parent = textNode.parentElement;
    current = walker.nextNode();
    if (!parent || parent.closest(skipSelector)) continue;
    const text = (textNode.nodeValue || '').trim().replace(/\s+/g, ' ');
    if (text.length < 2 || text.length > 1500) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    nodes.push(textNode);
    texts.push(text);
  }
  scope.__lumaTranslateNodes = nodes;
  scope.__lumaTranslateOriginal = nodes.map((node) => node.nodeValue || '');
  return { ok: texts.length > 0, texts };
}

export const TRANSLATION_EXTRACT_SCRIPT = `(${extractTranslatableBlocks.toString()})()`;

export function buildTranslationApplyScript(translations: string[]): string {
  return `(() => {
    const nodes = window.__lumaTranslateNodes || [];
    const originals = window.__lumaTranslateOriginal || [];
    const values = ${JSON.stringify(translations)};
    let changed = 0;
    nodes.forEach((node, index) => {
      const original = originals[index];
      const text = values[index];
      if (!node || !node.isConnected || typeof text !== 'string' || !text.trim()) return;
      const leading = typeof original === 'string' ? (original.match(/^\\s*/) || [''])[0] : '';
      const trailing = typeof original === 'string' ? (original.match(/\\s*$/) || [''])[0] : '';
      node.nodeValue = leading + text.trim() + trailing;
      changed += 1;
    });
    return changed;
  })()`;
}

export const TRANSLATION_RESTORE_SCRIPT = `(() => {
  const nodes = window.__lumaTranslateNodes || [];
  const originals = window.__lumaTranslateOriginal || [];
  let changed = 0;
  nodes.forEach((node, index) => {
    const original = originals[index];
    if (!node || !node.isConnected || typeof original !== 'string') return;
    node.nodeValue = original;
    changed += 1;
  });
  window.__lumaTranslateNodes = [];
  window.__lumaTranslateOriginal = [];
  return changed;
})()`;
