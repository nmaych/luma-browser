// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { siteKey, hostMatchesSite, sitesIncludeHost } = require('../electron/main/siteMatch.cjs');

describe('site matching', () => {
  it('treats www and the bare domain as one site', () => {
    expect(siteKey('www.bilibili.com')).toBe('bilibili.com');
    expect(siteKey('WWW.Example.COM')).toBe('example.com');
    expect(hostMatchesSite('www.bilibili.com', 'bilibili.com')).toBe(true);
    expect(hostMatchesSite('bilibili.com', 'www.bilibili.com')).toBe(true);
  });

  it('covers the subdomains a page actually loads from', () => {
    for (const host of ['api.bilibili.com', 'passport.bilibili.com', 's1.bilibili.com']) {
      expect(sitesIncludeHost(['bilibili.com'], host)).toBe(true);
    }
  });

  it('does not widen a subdomain switch to its parent', () => {
    expect(hostMatchesSite('www.bilibili.com', 's1.hdslb.com')).toBe(false);
    expect(hostMatchesSite('bilibili.com', 's1.hdslb.com')).toBe(false);
  });

  it('rejects lookalike hosts and empty input', () => {
    expect(hostMatchesSite('bilibili.com.example.test', 'bilibili.com')).toBe(false);
    expect(hostMatchesSite('notbilibili.com', 'bilibili.com')).toBe(false);
    expect(hostMatchesSite('', 'bilibili.com')).toBe(false);
    expect(hostMatchesSite('bilibili.com', '')).toBe(false);
    expect(sitesIncludeHost(undefined, 'bilibili.com')).toBe(false);
    expect(sitesIncludeHost([], 'bilibili.com')).toBe(false);
  });
});
