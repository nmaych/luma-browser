import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  installerFileName,
  isNewerVersion,
  legacyInstallerFileName,
  parseVersion,
} = require('../electron/versioning.cjs');

describe('update artifact naming', () => {
  it('names installers after product, version and architecture', () => {
    expect(installerFileName('1.14.0')).toBe('Luma-Browser-Setup-1.14.0-x64.exe');
    expect(installerFileName('1.14.0', 'arm64')).toBe('Luma-Browser-Setup-1.14.0-arm64.exe');
  });

  it('keeps the pre-1.14 name reachable for older installs', () => {
    expect(legacyInstallerFileName('1.13.0')).toBe('Luma-Browser-Setup-1.13.0.exe');
  });

  it('strips characters that are invalid in a file name', () => {
    expect(installerFileName('1.14.0-beta+2')).toBe('Luma-Browser-Setup-1.14.02-x64.exe');
  });
});

describe('version comparison', () => {
  it('accepts an optional v prefix', () => {
    expect(parseVersion('v1.14.0')).toEqual([1, 14, 0]);
    expect(parseVersion('nope')).toBeNull();
  });

  it('compares numerically instead of lexically', () => {
    expect(isNewerVersion('1.14.0', '1.13.9')).toBe(true);
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(false);
    expect(isNewerVersion('1.14.0', '1.14.0')).toBe(false);
  });

  it('treats unparsable versions as not newer', () => {
    expect(isNewerVersion('latest', '1.14.0')).toBe(false);
    expect(isNewerVersion('1.14.0', undefined)).toBe(false);
  });
});
