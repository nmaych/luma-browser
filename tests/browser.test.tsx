import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowser } from '../src/app/useBrowser';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

describe('browser session', () => {
  it('keeps independent back and forward entries per tab', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    const firstTabId = result.current.activeTab.id;

    act(() => { result.current.navigate('example.com'); });
    expect(result.current.activeEntry.url).toBe('https://example.com/');
    expect(result.current.history).toHaveLength(1);

    act(() => { result.current.goBack(); });
    expect(result.current.activeEntry.url).toBe('luma://newtab');
    act(() => { result.current.goForward(); });
    expect(result.current.activeEntry.url).toBe('https://example.com/');

    act(() => { result.current.newTab(); });
    expect(result.current.activeTab.id).not.toBe(firstTabId);
    expect(result.current.activeEntry.url).toBe('luma://newtab');
    expect(result.current.activeTab.entries).toHaveLength(1);
    unmount();
  });

  it('closes the last tab by replacing it with a fresh home tab', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    const oldId = result.current.activeTab.id;
    act(() => { result.current.navigate('luma://settings'); });
    act(() => { result.current.closeTab(oldId); });
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.activeTab.id).not.toBe(oldId);
    expect(result.current.activeEntry.url).toBe('luma://newtab');
    expect(result.current.hasClosedTab).toBe(true);
    act(() => { result.current.reopenClosedTab(); });
    expect(result.current.activeEntry.url).toBe('luma://settings');
    unmount();
  });

  it('reorders tabs and closes tabs to the right', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    const firstId = result.current.activeTab.id;
    let secondId = '';
    let thirdId = '';
    act(() => { secondId = result.current.newTab(); });
    act(() => { thirdId = result.current.newTab(); });

    act(() => { result.current.reorderTabs(thirdId, firstId); });
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([thirdId, firstId, secondId]);

    act(() => { result.current.reorderTabs(thirdId, firstId, 'after'); });
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([firstId, thirdId, secondId]);

    act(() => { result.current.closeTabsToRight(firstId); });
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([firstId]);
    unmount();
  });

  it('migrates an unsupported saved search engine to Baidu', () => {
    localStorage.setItem('luma.preferences.v1', JSON.stringify({ searchEngine: 'duckduckgo' }));
    const { result, unmount } = renderHook(() => useBrowser());
    expect(result.current.preferences.searchEngine).toBe('baidu');
    unmount();
  });

  it('opens history in a dedicated tab and reuses it on repeat visits', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    act(() => { result.current.openInternalPage('history'); });
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeEntry.url).toBe('luma://history');
    const historyTabId = result.current.activeTab.id;
    act(() => { result.current.openInternalPage('history'); });
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTab.id).toBe(historyTabId);
    unmount();
  });

  it('creates bookmark folders and moves bookmarks between them', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    let folderId: string | null = null;
    act(() => { folderId = result.current.addBookmarkFolder('工作资料'); });
    expect(folderId).toBeTruthy();
    act(() => { result.current.addBookmark('示例网站', 'example.com', folderId ?? undefined); });
    const bookmark = result.current.bookmarks.find((item) => item.url === 'https://example.com/');
    expect(bookmark?.folderId).toBe(folderId);
    act(() => { result.current.moveBookmark(bookmark!.id, undefined); });
    expect(result.current.bookmarks.find((item) => item.id === bookmark!.id)?.folderId).toBeUndefined();
    act(() => { result.current.renameBookmarkFolder(folderId!, '工作'); });
    expect(result.current.bookmarkFolders.find((folder) => folder.id === folderId)?.name).toBe('工作');
    act(() => { result.current.removeBookmarkFolder(folderId!); });
    expect(result.current.bookmarkFolders).toHaveLength(0);
    unmount();
  });

  it('appends new bookmarks and reorders folders', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    let workId: string | null = null;
    let readId: string | null = null;
    act(() => { workId = result.current.addBookmarkFolder('工作'); });
    act(() => { readId = result.current.addBookmarkFolder('阅读'); });
    expect(result.current.bookmarkFolders.map((folder) => folder.id)).toEqual([workId, readId]);

    act(() => { result.current.addBookmark('新收藏', 'https://later.example.com', workId ?? undefined); });
    expect(result.current.bookmarks.at(-1)?.title).toBe('新收藏');
    expect(result.current.bookmarks.at(-1)?.folderId).toBe(workId);

    act(() => { result.current.reorderBookmarkFolders(readId!, workId!); });
    expect(result.current.bookmarkFolders.map((folder) => folder.id)).toEqual([readId, workId]);
    unmount();
  });

  it('uses the configured home page for the home button', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    act(() => { result.current.updatePreferences({ homePage: 'https://example.com/' }); });
    act(() => { result.current.goHome(); });
    expect(result.current.activeEntry.url).toBe('https://example.com/');

    act(() => { result.current.updatePreferences({ homePage: 'luma://home' }); });
    act(() => { result.current.goHome(); });
    expect(result.current.activeEntry.url).toBe('luma://home');
    unmount();
  });

  it('adds and removes bookmarks without duplicates', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    const initialCount = result.current.bookmarks.length;
    act(() => { result.current.navigate('luma://bookmarks'); });
    act(() => { result.current.toggleBookmark(); });
    expect(result.current.bookmarks).toHaveLength(initialCount + 1);
    expect(result.current.isBookmarked).toBe(true);
    expect(result.current.addBookmark('重复书签', 'luma://bookmarks')).toBe(false);
    expect(result.current.addBookmark('无效地址', '这不是网址')).toBe(false);
    expect(result.current.bookmarks).toHaveLength(initialCount + 1);
    act(() => { result.current.toggleBookmark(); });
    expect(result.current.isBookmarked).toBe(false);
    unmount();
  });

  it('does not navigate for invalid input and reports feedback', () => {
    const { result, unmount } = renderHook(() => useBrowser());
    let succeeded = true;
    act(() => { succeeded = result.current.navigate('http://'); });
    expect(succeeded).toBe(false);
    expect(result.current.activeEntry.url).toBe('luma://newtab');
    expect(result.current.toasts.at(-1)?.tone).toBe('error');
    unmount();
  });

  it('shows a useful offline error and preserves the target entry', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const { result, unmount } = renderHook(() => useBrowser());
    act(() => { result.current.navigate('example.com'); });
    expect(result.current.activeEntry.url).toBe('https://example.com/');
    expect(result.current.activeTab.error?.type).toBe('offline');
    expect(result.current.activeTab.isLoading).toBe(false);
    unmount();
  });
});
