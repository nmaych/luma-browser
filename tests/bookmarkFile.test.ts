import { describe, expect, it } from 'vitest';
import { parseBookmarksHtml, serializeBookmarksHtml } from '../src/utils/bookmarkFile';
import type { Bookmark, BookmarkFolder } from '../src/types';

const imported = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<DL><p>
    <DT><A HREF="https://example.com/">Example</A>
    <DT><H3>资料</H3>
    <DL><p>
        <DT><A HREF="https://example.com/docs">文档</A>
        <DT><A HREF="file:///C:/notes/index.html">本地笔记</A>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">危险链接</A>
</DL><p>`;

describe('parseBookmarksHtml', () => {
  it('reads bookmarks, folders and rejects unsafe protocols', () => {
    const result = parseBookmarksHtml(imported);
    expect(result.folders).toEqual(['资料']);
    expect(result.bookmarks.map((item) => item.title)).toEqual(['Example', '文档', '本地笔记']);
    expect(result.bookmarks[0].folder).toBeUndefined();
    expect(result.bookmarks[1].folder).toBe('资料');
    expect(result.bookmarks[2].url).toBe('file:///C:/notes/index.html');
  });

  it('deduplicates escaped URLs', () => {
    const result = parseBookmarksHtml(
      '<DL><p><DT><A HREF="https://example.com/?a=1&amp;b=2">One</A><DT><A HREF="https://example.com/?a=1&amp;b=2">Two</A></DL><p>',
    );
    expect(result.bookmarks).toHaveLength(1);
    expect(result.bookmarks[0].url).toBe('https://example.com/?a=1&b=2');
  });
});

describe('serializeBookmarksHtml', () => {
  it('writes root bookmarks and folder blocks that can be imported again', () => {
    const folder: BookmarkFolder = { id: 'folder-1', name: '资料', createdAt: 1 };
    const bookmarks: Bookmark[] = [
      { id: 'a', title: 'Example', url: 'https://example.com/', createdAt: 1 },
      { id: 'b', title: '文档', url: 'https://example.com/docs', createdAt: 1, folderId: folder.id },
      { id: 'c', title: '孤立', url: 'https://example.com/lost', createdAt: 1, folderId: 'missing' },
    ];
    const html = serializeBookmarksHtml(bookmarks, [folder]);
    expect(html).toContain('NETSCAPE-Bookmark-file-1');
    expect(html).toContain('<H3 ADD_DATE="0">资料</H3>');

    const result = parseBookmarksHtml(html);
    expect(result.bookmarks).toHaveLength(3);
    expect(result.bookmarks.find((item) => item.title === '文档')?.folder).toBe('资料');
    expect(result.folders).toEqual(['资料']);
  });
});
