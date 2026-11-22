import { describe, expect, it } from 'vitest';
import { displayUrl, getInternalPage, hostMatchesSite, parseBrowserInput, sitesIncludeHost } from '../src/utils/url';

describe('parseBrowserInput', () => {
  it('adds HTTPS to a domain', () => {
    const result = parseBrowserInput('example.com/docs');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('https://example.com/docs');
    expect(result.isExternal).toBe(true);
  });

  it('recognizes localhost and internal pages', () => {
    expect(parseBrowserInput('localhost:3000').url).toBe('https://localhost:3000/');
    expect(parseBrowserInput('luma://bookmarks').title).toBe('书签');
    expect(getInternalPage('luma://settings')).toBe('settings');
  });

  it('turns plain text into a search URL', () => {
    const result = parseBrowserInput('现代浏览器 设计');
    expect(result.url).toBe('https://www.baidu.com/s?wd=%E7%8E%B0%E4%BB%A3%E6%B5%8F%E8%A7%88%E5%99%A8%20%E8%AE%BE%E8%AE%A1');
    expect(parseBrowserInput('browser', 'google').url).toBe('https://www.google.com/search?q=browser');
    expect(parseBrowserInput('browser', 'bing').url).toBe('https://www.bing.com/search?q=browser');
  });

  it('supports custom search engine templates', () => {
    const custom = [{
      id: 'custom:docs' as const,
      name: '文档搜索',
      urlTemplate: 'https://docs.example.com/search?q=%s&lang=zh',
      createdAt: Date.now(),
    }];
    const result = parseBrowserInput('react hooks', 'custom:docs', custom);
    expect(result.url).toBe('https://docs.example.com/search?q=react%20hooks&lang=zh');
  });

  it('converts local file paths into file URLs', () => {
    const windowsPath = parseBrowserInput('C:\\Users\\Luma\\文档\\index.html');
    expect(windowsPath.ok).toBe(true);
    expect(windowsPath.url).toBe('file:///C:/Users/Luma/%E6%96%87%E6%A1%A3/index.html');
    expect(windowsPath.title).toBe('index.html');
    expect(windowsPath.isExternal).toBe(true);
    expect(parseBrowserInput('/home/luma/notes.md').url).toBe('file:///home/luma/notes.md');
    const direct = parseBrowserInput('file:///C:/Users/Luma/report%20final.pdf');
    expect(direct.url).toBe('file:///C:/Users/Luma/report%20final.pdf');
    expect(direct.title).toBe('report final.pdf');
    expect(displayUrl('file:///C:/Users/Luma/index.html')).toBe('C:/Users/Luma/index.html');
  });

  it('rejects empty, malformed and unsafe addresses', () => {
    expect(parseBrowserInput('').ok).toBe(false);
    expect(parseBrowserInput('http://').ok).toBe(false);
    expect(parseBrowserInput('javascript:alert(1)').ok).toBe(false);
    expect(parseBrowserInput('ftp://example.com').ok).toBe(false);
  });

  it('matches a paused site through www and its subdomains', () => {
    expect(hostMatchesSite('www.bilibili.com', 'bilibili.com')).toBe(true);
    expect(hostMatchesSite('api.bilibili.com', 'bilibili.com')).toBe(true);
    expect(hostMatchesSite('bilibili.com.example.test', 'bilibili.com')).toBe(false);
    expect(sitesIncludeHost(['bilibili.com'], 'm.bilibili.com')).toBe(true);
    expect(sitesIncludeHost(['bilibili.com'], 'example.com')).toBe(false);
  });

  it('keeps the home omnibox empty and simplifies external URLs', () => {
    expect(displayUrl('luma://home')).toBe('');
    expect(displayUrl('https://example.com/')).toBe('example.com');
  });
});
