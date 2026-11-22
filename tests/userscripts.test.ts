// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  parseMetadata,
  matchPatternToRegExp,
  matchesUrl,
  buildWrapper,
  createUserscriptManager,
} = require('../electron/main/userscripts.cjs');

const HEADER = `// ==UserScript==
// @name         Example helper
// @namespace    https://example.test
// @version      1.2.3
// @description  Adds a button
// @match        https://example.com/*
// @match        *://*.news.test/articles/*
// @include      https://docs.test/*
// @exclude      https://example.com/private*
// @run-at       document-start
// @grant        GM_setValue
// ==/UserScript==
console.log('hi');
`;

describe('userscript metadata', () => {
  it('reads the fields it needs and repeats for @match/@grant', () => {
    const meta = parseMetadata(HEADER);
    expect(meta.name).toBe('Example helper');
    expect(meta.version).toBe('1.2.3');
    expect(meta.runAt).toBe('document-start');
    expect(meta.matches).toEqual(['https://example.com/*', '*://*.news.test/articles/*']);
    expect(meta.includes).toEqual(['https://docs.test/*']);
    expect(meta.excludes).toEqual(['https://example.com/private*']);
    expect(meta.grants).toEqual(['GM_setValue']);
  });

  it('returns empty metadata when the block is missing', () => {
    const meta = parseMetadata('console.log(1)');
    expect(meta.name).toBe('');
    expect(meta.matches).toEqual([]);
  });
});

describe('userscript URL matching', () => {
  it('maps Chrome match patterns, including subdomain wildcards', () => {
    expect(matchPatternToRegExp('https://example.com/*').test('https://example.com/a/b')).toBe(true);
    expect(matchPatternToRegExp('https://example.com/*').test('https://other.com/')).toBe(false);
    expect(matchPatternToRegExp('*://*.news.test/articles/*').test('https://m.news.test/articles/1')).toBe(true);
    expect(matchPatternToRegExp('*://*.news.test/articles/*').test('https://news.test/articles/1')).toBe(true);
    expect(matchPatternToRegExp('<all_urls>').test('http://127.0.0.1:5173/')).toBe(true);
    // Ports are not part of a match pattern, so any port must still match.
    expect(matchPatternToRegExp('http://127.0.0.1/*').test('http://127.0.0.1:59992/login')).toBe(true);
  });

  it('honours @exclude before @match and accepts @include globs', () => {
    const meta = parseMetadata(HEADER);
    expect(matchesUrl(meta, 'https://example.com/page')).toBe(true);
    expect(matchesUrl(meta, 'https://example.com/private/settings')).toBe(false);
    expect(matchesUrl(meta, 'https://docs.test/guide')).toBe(true);
    expect(matchesUrl(meta, 'file:///c:/tmp/a.html')).toBe(false);
  });
});

describe('userscript wrapper', () => {
  it('keeps the script source intact and guards against double injection', () => {
    const code = `if (a) { console.log("it's \\"quoted\\""); }`;
    const wrapper = buildWrapper({ id: 'demo', name: 'Demo', version: '1', code });
    expect(wrapper).toContain('__lumaUserscripts');
    expect(wrapper).toContain(JSON.stringify(code));
    expect(wrapper).toContain('GM_xmlhttpRequest');
    expect(wrapper).toContain('GM_setValue');
  });
});

describe('userscript manager', () => {
  it('installs a .user.js, rejects scripts without match rules, and can disable one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'luma-userscripts-'));
    try {
      const manager = createUserscriptManager({ directory: path.join(root, 'scripts') });
      const source = path.join(root, 'helper.user.js');
      writeFileSync(source, HEADER, 'utf8');
      const installed = manager.install(source);
      expect(installed.ok).toBe(true);
      expect(installed.list).toHaveLength(1);
      const [script] = manager.list();
      expect(script.name).toBe('Example helper');
      expect(manager.injectionsFor('https://example.com/x')).toHaveLength(1);
      expect(manager.injectionsFor('https://unmatched.test/')).toHaveLength(0);

      manager.setEnabled(script.id, false);
      expect(manager.injectionsFor('https://example.com/x')).toHaveLength(0);

      const noMatch = path.join(root, 'empty.user.js');
      writeFileSync(noMatch, '// ==UserScript==\n// @name Broken\n// ==/UserScript==\n', 'utf8');
      const rejected = manager.install(noMatch);
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('@match');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
