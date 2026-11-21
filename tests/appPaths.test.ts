import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  configureUserData,
  migrateLegacyProfile,
  resolveAppPaths,
} = require('../electron/appPaths.cjs');

const tempDirs: string[] = [];

const tempDir = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
};

const originalAppData = process.env.APPDATA;

beforeEach(() => {
  // `legacyProfileCandidates` reads APPDATA at call time, so tests can point the
  // legacy lookup at a scratch directory instead of the real roaming profile.
  process.env.APPDATA = tempDir('luma-roaming-');
});

afterEach(() => {
  process.env.APPDATA = originalAppData;
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('resolveAppPaths', () => {
  it('mirrors the Chrome layout: one vendor folder with User Data and Update siblings', () => {
    const localAppData = tempDir('luma-local-');
    const paths = resolveAppPaths({ localAppData });
    expect(paths.appRoot).toBe(path.join(localAppData, 'Luma Browser'));
    expect(paths.userData).toBe(path.join(localAppData, 'Luma Browser', 'User Data'));
    expect(paths.update).toBe(path.join(localAppData, 'Luma Browser', 'Update'));
    expect(paths.packages).toBe(path.join(localAppData, 'Luma Browser', 'Update', 'packages'));
    expect(paths.log).toBe(path.join(localAppData, 'Luma Browser', 'Update', 'update.log'));
  });
});

describe('migrateLegacyProfile', () => {
  it('moves a roaming profile into the local layout and marks it migrated', () => {
    const paths = resolveAppPaths({ localAppData: tempDir('luma-local-') });
    const legacy = path.join(process.env.APPDATA!, 'Luma Browser');
    mkdirSync(path.join(legacy, 'Partitions'), { recursive: true });
    writeFileSync(path.join(legacy, 'luma-settings.json'), '{"bossKey":"Ctrl+Shift+L"}');
    writeFileSync(path.join(legacy, 'Partitions', 'cookies'), 'cookie-bytes');

    const result = migrateLegacyProfile(paths.userData);
    expect(result).toMatchObject({ migrated: true, method: 'move' });
    expect(readdirSync(paths.userData)).toContain('luma-settings.json');
    expect(readdirSync(paths.userData)).toContain('layout.json');
    // The legacy tree is gone after a move, so the two roots can never diverge.
    expect(readdirSync(process.env.APPDATA!)).not.toContain('Luma Browser');
  });

  it('is idempotent once the marker exists', () => {
    const paths = resolveAppPaths({ localAppData: tempDir('luma-local-') });
    mkdirSync(paths.userData, { recursive: true });
    writeFileSync(path.join(paths.userData, 'layout.json'), '{"schema":2}');
    expect(migrateLegacyProfile(paths.userData)).toEqual({ migrated: false, reason: 'already-migrated' });
  });

  it('starts clean when no legacy profile exists', () => {
    const paths = resolveAppPaths({ localAppData: tempDir('luma-local-') });
    expect(migrateLegacyProfile(paths.userData)).toEqual({ migrated: false, reason: 'no-legacy' });
  });
});

describe('configureUserData', () => {
  it('switches Electron to the local profile directory', () => {
    const localAppData = tempDir('luma-local-');
    const legacy = path.join(process.env.APPDATA!, 'Luma Browser');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, 'luma-settings.json'), '{}');
    const app = {
      commandLine: { hasSwitch: () => false, appendSwitch: vi.fn() },
      getPath: () => path.join(process.env.APPDATA!, 'Luma Browser'),
      setPath: vi.fn(),
    };
    const result = configureUserData(app, { log: () => undefined, localAppData });
    expect(app.setPath).toHaveBeenCalledWith('userData', path.join(localAppData, 'Luma Browser', 'User Data'));
    // Chromium resolves its profile from the command line before `setPath`
    // applies, so both have to name the same directory.
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('user-data-dir', path.join(localAppData, 'Luma Browser', 'User Data'));
    expect(result.overridden).toBe(false);
    // Creating the profile directory before migrating would make Windows refuse
    // the rename and silently downgrade the move to a full copy.
    expect(result.migration).toMatchObject({ migrated: true, method: 'move' });
    expect(readdirSync(process.env.APPDATA!)).not.toContain('Luma Browser');
  });

  it('never overrides an explicit --user-data-dir', () => {
    const localAppData = tempDir('luma-local-');
    const app = {
      commandLine: { hasSwitch: (name: string) => name === 'user-data-dir' },
      getPath: () => path.join(os.tmpdir(), 'sandbox-profile'),
      setPath: vi.fn(),
    };
    const result = configureUserData(app, { log: () => undefined, localAppData });
    expect(result.overridden).toBe(true);
    expect(result.userData).toBe(path.join(os.tmpdir(), 'sandbox-profile'));
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
