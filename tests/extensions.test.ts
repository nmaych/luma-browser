// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExtensionManager, describeAction, validateManifest } = require('../electron/extensions.cjs');

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

describe('toolbar action metadata', () => {
  it('turns a declared icon into a data URL and keeps the popup path', () => {
    const directory = tempDir('luma-ext-icon-');
    mkdirSync(path.join(directory, 'icons'));
    // 1x1 transparent PNG
    writeFileSync(path.join(directory, 'icons', 'icon.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      ...MV3,
      action: { default_title: 'Probe', default_popup: 'popup.html', default_icon: { 16: 'icons/icon.png', 32: 'icons/icon.png' } },
    }));

    const action = describeAction(require(path.join(directory, 'manifest.json')), directory);
    expect(action).toMatchObject({ title: 'Probe', popup: 'popup.html' });
    expect(action.icon).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses an icon that escapes the extension directory', () => {
    const directory = tempDir('luma-ext-icon-');
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      ...MV3,
      action: { default_icon: '../../secret.png' },
    }));
    const action = describeAction(require(path.join(directory, 'manifest.json')), directory);
    expect(action.icon).toBeNull();
  });

  it('falls back to the extension name when no title is set', () => {
    const directory = tempDir('luma-ext-icon-');
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      ...MV3,
      action: { default_popup: '/popup.html' },
    }));
    const action = describeAction(require(path.join(directory, 'manifest.json')), directory);
    expect(action.title).toBe('Probe Extension');
    // Leading slashes are normalized so the chrome-extension:// URL stays valid.
    expect(action.popup).toBe('popup.html');
  });
});

/** Minimal CRC32 for the hand-built ZIP below. */
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();
const crc32 = (buffer: Buffer) => {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
};

/**
 * Builds a stored (uncompressed) ZIP by hand. adm-zip under the jsdom test
 * environment produces archives its own reader cannot open, and the parser only
 * needs to prove it reads a standard ZIP payload.
 */
const storedZip = (files: Record<string, string>) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
};

/** Wraps a ZIP payload in a CRX3 header so the parser can be exercised offline. */
const makeCrx = (files: Record<string, string>) => {
  const zipBuffer = storedZip(files);
  const header = Buffer.from('crx3-header');
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32LE(0x34327243, 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zipBuffer]);
};

describe('crx packages', () => {
  it('unpacks a .crx and installs the extension', async () => {
    const root = tempDir('luma-crx-root-');
    const session = createSession();
    const manager = createExtensionManager({ directory: root, session });
    const file = path.join(tempDir('luma-crx-src-'), 'probe.crx');
    writeFileSync(file, makeCrx({
      'manifest.json': JSON.stringify(MV3),
      'content.js': 'void 0;',
      'bg.js': 'void 0;',
      '_metadata/verified_contents.json': '{}',
    }));

    const result = await manager.installCrx(file);
    expect(result.ok).toBe(true);
    expect(session.loadExtension).toHaveBeenCalledTimes(1);
    const installed = manager.list();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ name: 'Probe Extension', version: '1.0.0', loaded: true });
    // Chrome metadata is not copied into the managed folder.
    expect(existsSync(path.join(root, installed[0].id, '_metadata'))).toBe(false);
  });

  it('rejects a file that is not a crx container', async () => {
    const manager = createExtensionManager({ directory: tempDir('luma-crx-root-'), session: createSession() });
    const file = path.join(tempDir('luma-crx-src-'), 'not.crx');
    writeFileSync(file, 'just text');
    const result = await manager.installCrx(file);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('crx');
  });

  it('refuses zip entries that escape the target folder', async () => {
    const manager = createExtensionManager({ directory: tempDir('luma-crx-root-'), session: createSession() });
    const file = path.join(tempDir('luma-crx-src-'), 'evil.crx');
    writeFileSync(file, makeCrx({
      'manifest.json': JSON.stringify(MV3),
      '../escape.txt': 'nope',
    }));
    const result = await manager.installCrx(file);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('非法路径');
  });
});
