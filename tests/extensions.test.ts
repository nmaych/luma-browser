import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExtensionManager, validateManifest } = require('../electron/extensions.cjs');

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(directory);
  return directory;
};

/** Writes a minimal unpacked extension and returns its directory. */
const makeExtension = (manifest: Record<string, unknown>, files: Record<string, string> = {}) => {
  const directory = tempDir('luma-ext-src-');
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), content, 'utf8');
  }
  return directory;
};

const MV3 = {
  manifest_version: 3,
  name: 'Probe Extension',
  version: '1.0.0',
  description: 'probe',
  permissions: ['storage'],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
  background: { service_worker: 'bg.js' },
  action: { default_title: 'probe' },
};

const createSession = () => ({
  loadExtension: vi.fn(async (directory: string) => ({ id: `electron-${path.basename(directory)}`, name: 'Probe', version: '1.0.0' })),
  removeExtension: vi.fn(),
});

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('validateManifest', () => {
  it('accepts an MV3 extension with content scripts', () => {
    expect(validateManifest(MV3)).toEqual({ ok: true });
  });

  it('rejects an unsupported manifest version', () => {
    expect(validateManifest({ ...MV3, manifest_version: 1 }).ok).toBe(false);
  });

  it('rejects a manifest without name or version', () => {
    expect(validateManifest({ manifest_version: 3, version: '1.0' }).ok).toBe(false);
    expect(validateManifest({ manifest_version: 3, name: 'X' }).ok).toBe(false);
  });

  it('rejects an extension that would do nothing', () => {
    const result = validateManifest({ manifest_version: 3, name: 'Empty', version: '1.0.0' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('内容脚本');
  });
});

describe('extension manager', () => {
  it('copies an unpacked extension into its own directory and loads it', async () => {
    const root = tempDir('luma-ext-root-');
    const session = createSession();
    const manager = createExtensionManager({ directory: root, session });
    const source = makeExtension(MV3, { 'content.js': 'void 0;', 'bg.js': 'void 0;' });

    const result = await manager.install(source);
    expect(result.ok).toBe(true);
    expect(session.loadExtension).toHaveBeenCalledTimes(1);

    const installed = manager.list();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      name: 'Probe Extension',
      version: '1.0.0',
      manifestVersion: 3,
      enabled: true,
      loaded: true,
      hasBackground: true,
      hasAction: true,
    });
    // The source folder stays untouched; Luma works from its own copy.
    expect(existsSync(path.join(source, 'manifest.json'))).toBe(true);
    expect(readdirSync(root).some((name) => name !== 'extensions.json')).toBe(true);
  });

  it('refuses a directory without manifest.json and a duplicate install', async () => {
    const root = tempDir('luma-ext-root-');
    const manager = createExtensionManager({ directory: root, session: createSession() });
    expect((await manager.install(tempDir('luma-empty-'))).ok).toBe(false);

    const source = makeExtension(MV3);
    expect((await manager.install(source)).ok).toBe(true);
    const again = await manager.install(source);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已经安装');
  });

  it('remembers the enabled flag across restarts', async () => {
    const root = tempDir('luma-ext-root-');
    const session = createSession();
    const manager = createExtensionManager({ directory: root, session });
    await manager.install(makeExtension(MV3));

    const id = manager.list()[0].id;
    await manager.setEnabled(id, false);
    expect(session.removeExtension).toHaveBeenCalledTimes(1);

    const revivedSession = createSession();
    const revived = createExtensionManager({ directory: root, session: revivedSession });
    await revived.loadAll();
    expect(revived.list()[0].enabled).toBe(false);
    expect(revivedSession.loadExtension).not.toHaveBeenCalled();
  });

  it('loads every enabled extension on boot and isolates broken ones', async () => {
    const root = tempDir('luma-ext-root-');
    const first = createExtensionManager({ directory: root, session: createSession() });
    await first.install(makeExtension(MV3));

    // A folder that lost its manifest must not stop the others from loading.
    mkdirSync(path.join(root, 'broken-ext'));
    writeFileSync(path.join(root, 'broken-ext', 'manifest.json'), '{ not json');

    const session = createSession();
    const manager = createExtensionManager({ directory: root, session });
    await manager.loadAll();
    const list = manager.list();
    expect(session.loadExtension).toHaveBeenCalledTimes(1);
    expect(list.find((item: { name: string }) => item.name === 'broken-ext')?.error).toContain('JSON');
  });

  it('removes the copied directory and its state entry', async () => {
    const root = tempDir('luma-ext-root-');
    const manager = createExtensionManager({ directory: root, session: createSession() });
    await manager.install(makeExtension(MV3));
    const id = manager.list()[0].id;

    expect(manager.remove(id).ok).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(existsSync(path.join(root, id))).toBe(false);

    const revived = createExtensionManager({ directory: root, session: createSession() });
    await revived.loadAll();
    expect(revived.list()).toHaveLength(0);
  });
});
