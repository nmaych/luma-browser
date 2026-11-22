// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { siteFixesFor } = require('../electron/main/site-fixes.cjs');

describe('site fixes', () => {
  it('matches bilibili hosts and their subdomains', () => {
    for (const url of ['https://www.bilibili.com/', 'https://bilibili.com/video/BV1', 'https://m.bilibili.com/index']) {
      const fixes = siteFixesFor(url);
      expect(fixes.map((fix: { id: string }) => fix.id)).toEqual(['bilibili-carousel']);
      expect(fixes[0].script).toContain('vui_carousel');
    }
  });

  it('does not leak the patch to lookalike hosts', () => {
    for (const url of [
      'https://bilibili.com.example.test/',
      'https://notbilibili.com/',
      'https://example.com/?next=bilibili.com',
    ]) {
      expect(siteFixesFor(url)).toEqual([]);
    }
  });

  it('ignores non-http documents and malformed input', () => {
    expect(siteFixesFor('file:///D:/dist/index.html')).toEqual([]);
    expect(siteFixesFor('about:blank')).toEqual([]);
    expect(siteFixesFor('')).toEqual([]);
    expect(siteFixesFor(undefined as unknown as string)).toEqual([]);
  });

  it('returns a self-guarding script that only runs once per document', () => {
    const [fix] = siteFixesFor('https://www.bilibili.com/');
    expect(fix.script).toContain('window.__lumaCarouselFix');
    expect(fix.script.trim().startsWith('(function ()')).toBe(true);
  });
});
