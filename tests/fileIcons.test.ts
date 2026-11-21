// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { extensionOf, prefersThumbnail, fileIconFor, forgetFileIcon } = require('../electron/main/fileIcons.cjs');

describe('fileIcons extension handling', () => {
  it('reads the extension from either path separator and ignores dotfiles', () => {
    expect(extensionOf('C:\\Users\\me\\Downloads\\Setup.EXE')).toBe('exe');
    expect(extensionOf('/home/me/report.tar.gz')).toBe('gz');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionOf('')).toBe('');
  });

  it('only treats decodable images as thumbnails', () => {
    expect(prefersThumbnail('photo.JPG')).toBe(true);
    expect(prefersThumbnail('shot.png')).toBe(true);
    expect(prefersThumbnail('favicon.ico')).toBe(true);
    // SVG needs a renderer, so the shell icon is the better answer there.
    expect(prefersThumbnail('logo.svg')).toBe(false);
    expect(prefersThumbnail('setup.exe')).toBe(false);
    expect(prefersThumbnail('doc.pdf')).toBe(false);
  });
});

describe('fileIconFor', () => {
  it('skips paths the renderer should never have sent', async () => {
    expect(await fileIconFor('')).toBeNull();
    expect(await fileIconFor('relative/file.png')).toBeNull();
    expect(await fileIconFor(42)).toBeNull();
  });

  it('returns null instead of throwing for missing files and directories', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'luma-icon-'));
    try {
      expect(await fileIconFor(path.join(directory, 'gone.exe'))).toBeNull();
      expect(await fileIconFor(directory)).toBeNull();
      mkdirSync(path.join(directory, 'nested'));
      expect(await fileIconFor(path.join(directory, 'nested'))).toBeNull();
      forgetFileIcon(path.join(directory, 'gone.exe'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
