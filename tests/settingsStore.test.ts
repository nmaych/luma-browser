import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSettings } = require('../electron/main/settings.cjs');

const DEFAULTS = {
  adblock: { enabled: true, disabledSites: [] },
  bossKey: 'Ctrl+Shift+L',
  shortcuts: { 'new-tab': 'Ctrl+T', reload: 'Ctrl+R' },
  blockedTotal: 0,
};

const dirs: string[] = [];
const tempFile = (contents?: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'luma-settings-'));
  dirs.push(directory);
  const file = path.join(directory, 'luma-settings.json');
  if (contents !== undefined) writeFileSync(file, contents, 'utf8');
  return file;
};

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('loadSettings', () => {
  it('falls back to defaults when the file is missing or corrupt', () => {
    expect(loadSettings(tempFile(), DEFAULTS, Object.keys(DEFAULTS.shortcuts))).toEqual(DEFAULTS);
    expect(loadSettings(tempFile('{not json'), DEFAULTS, Object.keys(DEFAULTS.shortcuts))).toEqual(DEFAULTS);
  });

  it('drops malformed site entries instead of trusting the file', () => {
    const file = tempFile(JSON.stringify({
      adblock: { enabled: false, disabledSites: ['example.com', 'javascript:alert(1)', 42] },
    }));
    const settings = loadSettings(file, DEFAULTS, Object.keys(DEFAULTS.shortcuts));
    expect(settings.adblock.enabled).toBe(false);
    expect(settings.adblock.disabledSites).toEqual(['example.com']);
  });

  it('ignores shortcut actions the current build does not know', () => {
    const file = tempFile(JSON.stringify({
      shortcuts: { 'new-tab': 'Alt+N', 'retired-action': 'Alt+X' },
      bossKey: 'Ctrl+Alt+H',
    }));
    const settings = loadSettings(file, DEFAULTS, Object.keys(DEFAULTS.shortcuts));
    expect(settings.shortcuts).toEqual({ 'new-tab': 'Alt+N', reload: 'Ctrl+R' });
    expect(settings.bossKey).toBe('Ctrl+Alt+H');
  });

  it('clamps the blocked counter to a non-negative integer', () => {
    expect(loadSettings(tempFile(JSON.stringify({ blockedTotal: -12 })), DEFAULTS, []).blockedTotal).toBe(0);
    expect(loadSettings(tempFile(JSON.stringify({ blockedTotal: 18.7 })), DEFAULTS, []).blockedTotal).toBe(18);
  });
});
