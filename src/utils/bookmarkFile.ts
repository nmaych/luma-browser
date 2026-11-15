import type { Bookmark, BookmarkFolder } from '../types';

export interface ImportedBookmark {
  title: string;
  url: string;
  folder?: string;
}

export interface ImportedBookmarkData {
  bookmarks: ImportedBookmark[];
  folders: string[];
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'luma:']);

function cleanFolderName(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function normalizeUrl(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Reads Netscape bookmark HTML as exported by Chrome, Edge, Firefox and Luma. */
export function parseBookmarksHtml(html: string): ImportedBookmarkData {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const folders: string[] = [];
  const seenFolders = new Set<string>();
  const addFolder = (name: string) => {
    const key = name.toLowerCase();
    if (!name || seenFolders.has(key)) return;
    seenFolders.add(key);
    folders.push(name);
  };

  for (const heading of doc.querySelectorAll('h3')) addFolder(cleanFolderName(heading.textContent));

  const bookmarks: ImportedBookmark[] = [];
  const seenUrls = new Set<string>();
  for (const link of doc.querySelectorAll('a[href]')) {
    const url = normalizeUrl(link.getAttribute('href'));
    if (!url || seenUrls.has(url)) continue;
    let folder = '';
    let node: Element | null = link.parentElement;
    while (node && node !== doc.body) {
      if (node.tagName === 'DT') {
        const heading = node.querySelector(':scope > h3');
        if (heading) {
          folder = cleanFolderName(heading.textContent);
          break;
        }
      }
      node = node.parentElement;
    }
    addFolder(folder);
    seenUrls.add(url);
    bookmarks.push({
      title: (link.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || url,
      url,
      ...(folder ? { folder } : {}),
    });
  }
  return { bookmarks, folders };
}

export function serializeBookmarksHtml(bookmarks: Bookmark[], folders: BookmarkFolder[]): string {
  const timestamp = (value: number) => Math.floor((Number.isFinite(value) ? value : Date.now()) / 1000);
  const folderIds = new Set(folders.map((folder) => folder.id));
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const writeLink = (bookmark: Bookmark) => {
    lines.push(`    <DT><A HREF="${escapeHtml(bookmark.url)}" ADD_DATE="${timestamp(bookmark.createdAt)}">${escapeHtml(bookmark.title)}</A>`);
  };

  for (const bookmark of bookmarks.filter((item) => !item.folderId || !folderIds.has(item.folderId))) {
    writeLink(bookmark);
  }
  for (const folder of folders) {
    lines.push(`    <DT><H3 ADD_DATE="${timestamp(folder.createdAt)}">${escapeHtml(folder.name)}</H3>`);
    lines.push('    <DL><p>');
    for (const bookmark of bookmarks.filter((item) => item.folderId === folder.id)) writeLink(bookmark);
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>');
  return `${lines.join('\n')}\n`;
}
