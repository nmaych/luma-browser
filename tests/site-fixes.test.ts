// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { siteFixesFor, siteStylesFor, skipsRuleListCosmetics } = require('../electron/main/site-fixes.cjs');

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

  it('treats the empty ad slot tile as no content, not just narrow slides', () => {
    const [fix] = siteFixesFor('https://www.bilibili.com/');
    // The site fills the unsold slot with a 76px eva.png; the slide keeps its
    // full width, so width alone can never detect it.
    expect(fix.script).toContain('eva\\.png');
    expect(fix.script).toContain('naturalWidth < 200');
    expect(fix.script).toContain("state === 'placeholder'");
    expect(fix.script).toContain('setInterval(check, 150)');
  });
});

describe('site styles', () => {
  it('hides the site\'s own blocked-content plate inside the carousel', () => {
    const css = siteStylesFor('https://www.bilibili.com/');
    // The network rules do block the ad payload, so the site paints its own
    // "blocked by an extension" plate over the banner. Hide it.
    expect(css).toContain('.vui_carousel .extension-tips-v2');
    expect(css).toContain('display: none !important');
  });

  it('hides the unsold carousel slide instead of letting it park there', () => {
    const css = siteStylesFor('https://www.bilibili.com/');
    expect(css).toContain('img[src$="/eva.png"]');
    expect(css).toContain('div.vui_carousel__slide');
  });

  it('no longer needs specificity hacks over the filter lists', () => {
    const css = siteStylesFor('https://www.bilibili.com/');
    // The lists are skipped on this host, so patching their selectors is moot.
    expect(css).not.toContain('luma-grid-keep');
    expect(css).not.toContain('bili-video-card__info');
  });

  it('keeps the carousel patch off other hosts and non-http documents', () => {
    for (const url of ['https://example.com/', 'https://notbilibili.com/', 'file:///D:/dist/index.html', '']) {
      expect(siteStylesFor(url)).toBe('');
    }
  });

  it('accepts subdomains the same way the scripts do', () => {
    expect(siteStylesFor('https://m.bilibili.com/index')).toContain('extension-tips-v2');
  });
});

describe('rule list cosmetics', () => {
  it('skips bilibili so the feed lays out the way the site intends', () => {
    // The lists gut ad cards (inner card hidden, info and cover link teleported
    // to left:-3000px, empty cell deleted). Every patch of that ended in a
    // full-size empty box, so this host keeps network blocking only.
    for (const url of ['https://www.bilibili.com/', 'https://bilibili.com/video/BV1', 'https://m.bilibili.com/']) {
      expect(skipsRuleListCosmetics(url)).toBe(true);
    }
  });

  it('leaves every other host on the normal path', () => {
    for (const url of ['https://example.com/', 'https://notbilibili.com/', 'https://bilibili.com.example.test/', 'about:blank', '']) {
      expect(skipsRuleListCosmetics(url)).toBe(false);
    }
  });
});
