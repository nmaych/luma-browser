const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Unpacked extension support.
 *
 * Electron exposes a subset of the Chrome extensions platform: content scripts,
 * background service workers, runtime messaging and storage all work, but there
 * is no toolbar action surface and no `declarativeNetRequest`. Luma therefore
 * ships a manager for *unpacked* extensions — the user picks a folder, Luma
 * copies it into its own `Extensions` directory and loads it on every boot
 * (Electron requires a call to `loadExtension` after each launch).
 */

const MANIFEST_FILE = 'manifest.json';
const STATE_FILE = 'extensions.json';
const MAX_EXTENSION_BYTES = 100 * 1024 * 1024;
const SKIPPED_NAMES = new Set(['.git', '.svn', 'node_modules/.cache']);
const STATE_SCHEMA = 1;

/** Text that ends up in the settings list is clamped and stripped of NULs. */
function cleanText(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

function readManifest(directory) {
  const manifestPath = path.join(directory, MANIFEST_FILE);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    return { ok: false, error: '目录里没有 manifest.json' };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'manifest.json 不是合法的 JSON' };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'manifest.json 内容格式不正确' };
  }
  return { ok: true, manifest };
}

/** Returns a human-readable reason when the manifest cannot be loaded. */
function validateManifest(manifest) {
  const version = Number(manifest.manifest_version);
  if (version !== 2 && version !== 3) {
    return { ok: false, error: `不支持的 manifest_version：${String(manifest.manifest_version)}` };
  }
  const name = cleanText(manifest.name, 120);
  if (!name) return { ok: false, error: 'manifest 缺少 name' };
  const appVersion = cleanText(manifest.version, 32);
  if (!appVersion) return { ok: false, error: 'manifest 缺少 version' };

  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const hasBackground = Boolean(manifest.background?.service_worker || manifest.background?.scripts);
  const hasAction = Boolean(manifest.action || manifest.browser_action || manifest.page_action);
  if (contentScripts.length === 0 && !hasBackground && !hasAction) {
    return { ok: false, error: '扩展没有任何内容脚本、后台脚本或界面，加载后不会产生效果' };
  }
  return { ok: true };
}

const ICON_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Picks the largest declared icon up to 64 px; Chrome prefers 32 for toolbars. */
function pickIconEntry(icon) {
  if (typeof icon === 'string') return icon;
  if (!icon || typeof icon !== 'object') return null;
  const entries = Object.entries(icon)
    .map(([size, file]) => ({ size: Number(size), file }))
    .filter((entry) => Number.isFinite(entry.size) && typeof entry.file === 'string')
    .sort((left, right) => left.size - right.size);
  if (entries.length === 0) return null;
  const preferred = entries.find((entry) => entry.size >= 32) ?? entries[entries.length - 1];
  return preferred.file;
}

/**
 * The browser UI cannot request `chrome-extension://` assets, so the icon is
 * read from disk and handed to the renderer as a data URL.
 */
function readActionIcon(directory, icon) {
  const relative = pickIconEntry(icon);
  if (!relative) return null;
  const target = path.resolve(directory, relative);
  // A manifest must not be able to point outside its own directory.
  if (!target.startsWith(path.resolve(directory) + path.sep)) return null;
  try {
    const bytes = fs.readFileSync(target);
    if (bytes.length > 256 * 1024) return null;
    const mime = ICON_MIME[path.extname(target).toLowerCase()] ?? 'image/png';
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

/** Toolbar metadata: popup path, title and icon data URL. */
function describeAction(manifest, directory) {
  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  if (!action || typeof action !== 'object') return null;
  const popup = typeof action.default_popup === 'string' ? action.default_popup.trim() : '';
  const title = cleanText(action.default_title, 120) || cleanText(manifest.name, 120);
  return {
    title,
    popup: popup && !popup.includes('..') ? popup.replace(/^\/+/, '') : '',
    icon: readActionIcon(directory, action.default_icon) ?? null,
  };
}

/** Flattens a manifest into the fields the settings list renders. */
function summarizeManifest(manifest, directory = '') {
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const matches = new Set();
  for (const entry of contentScripts) {
    if (Array.isArray(entry?.matches)) {
      for (const pattern of entry.matches) {
        if (typeof pattern === 'string') matches.add(cleanText(pattern, 120));
      }
    }
  }
  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter((item) => typeof item === 'string').map((item) => cleanText(item, 60))
    : [];
  const hostPermissions = Array.isArray(manifest.host_permissions)
    ? manifest.host_permissions.filter((item) => typeof item === 'string').map((item) => cleanText(item, 120))
    : [];
  const version = Number(manifest.manifest_version);
  return {
    name: cleanText(manifest.name, 120),
    version: cleanText(manifest.version, 32),
    description: cleanText(manifest.description, 400),
    manifestVersion: version === 2 ? 2 : 3,
    permissions,
    hostPermissions,
    matches: [...matches].slice(0, 12),
    hasAction: Boolean(manifest.action || manifest.browser_action || manifest.page_action),
    hasBackground: Boolean(manifest.background?.service_worker || manifest.background?.scripts),
    directory,
  };
}

/** Folder-safe identifier: readable prefix plus a short digest for uniqueness. */
function folderNameFor(manifest, sourceDir) {
  const slug = cleanText(manifest.name, 60)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'extension';
  const digest = crypto.createHash('sha1').update(`${manifest.name}@${manifest.version}:${sourceDir}`).digest('hex');
  return `${slug.slice(0, 40)}-${digest.slice(0, 8)}`;
}

function directorySize(directory) {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      try {
        total += fs.statSync(target).size;
      } catch {
        // A file that disappeared mid-walk only affects the reported size.
      }
      if (total > MAX_EXTENSION_BYTES) return total;
    }
  }
  return total;
}

/** Copies an extension, skipping VCS metadata and symlinks that could escape. */
function copyExtension(from, to) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      if (SKIPPED_NAMES.has(name)) return false;
      try {
        return !fs.lstatSync(entry).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

function createExtensionManager({ directory, session, log = () => {}, onChange = () => {} }) {
  /** @type {Map<string, any>} */
  const entries = new Map();
  /** @type {{ schema: number, enabled: Record<string, boolean> }} */
  let state = { schema: STATE_SCHEMA, enabled: {} };

  const statePath = path.join(directory, STATE_FILE);

  function ensureDirectory() {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      log(`[extensions] cannot create ${directory}: ${error instanceof Error ? error.message : error}`);
    }
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const enabled = parsed?.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {};
      const clean = {};
      for (const [key, value] of Object.entries(enabled)) {
        if (typeof key === 'string' && typeof value === 'boolean') clean[key] = value;
      }
      return { schema: STATE_SCHEMA, enabled: clean };
    } catch {
      return { schema: STATE_SCHEMA, enabled: {} };
    }
  }

  function writeState() {
    try {
      ensureDirectory();
      const temp = `${statePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, statePath);
    } catch (error) {
      log(`[extensions] cannot persist state: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Reads every installed folder; the folder name is the stable id. */
  function scan() {
    ensureDirectory();
    entries.clear();
    let names = [];
    try {
      names = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }
    for (const name of names) {
      const extensionDir = path.join(directory, name);
      const parsed = readManifest(extensionDir);
      if (!parsed.ok) {
        entries.set(name, {
          id: name,
          directory: extensionDir,
          summary: null,
          enabled: false,
          loaded: null,
          error: parsed.error,
        });
        continue;
      }
      const validation = validateManifest(parsed.manifest);
      const enabled = state.enabled[name] !== false;
      entries.set(name, {
        id: name,
        directory: extensionDir,
        action: describeAction(parsed.manifest, extensionDir),
        summary: summarizeManifest(parsed.manifest, extensionDir),
        enabled,
        loaded: null,
        error: validation.ok ? null : validation.error,
      });
    }
  }

  async function loadEntry(entry) {
    if (!entry.summary) return;
    try {
      const loaded = await session.loadExtension(entry.directory, { allowFileAccess: true });
      entry.loaded = { id: loaded.id, name: loaded.name, version: loaded.version };
      entry.error = null;
      log(`[extensions] loaded ${entry.summary.name}@${entry.summary.version} (${loaded.id})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.loaded = null;
      entry.error = message;
      log(`[extensions] failed to load ${entry.id}: ${message}`);
    }
  }

  function unloadEntry(entry) {
    const id = entry.loaded?.id;
    if (!id) return;
    try {
      session.removeExtension(id);
    } catch (error) {
      log(`[extensions] cannot unload ${id}: ${error instanceof Error ? error.message : error}`);
    }
    entry.loaded = null;
  }

  function toPublic(entry) {
    return {
      id: entry.id,
      name: entry.summary?.name ?? entry.id,
      version: entry.summary?.version ?? '',
      description: entry.summary?.description ?? '',
      manifestVersion: entry.summary?.manifestVersion ?? 0,
      permissions: entry.summary?.permissions ?? [],
      hostPermissions: entry.summary?.hostPermissions ?? [],
      matches: entry.summary?.matches ?? [],
      hasAction: entry.summary?.hasAction ?? false,
      toolbar: entry.action && entry.loaded
        ? {
          title: entry.action.title,
          icon: entry.action.icon,
          popup: entry.action.popup ? `chrome-extension://${entry.loaded.id}/${entry.action.popup}` : null,
        }
        : null,
      hasBackground: entry.summary?.hasBackground ?? false,
      enabled: entry.enabled,
      loaded: Boolean(entry.loaded),
      error: entry.error,
    };
  }

  function list() {
    return [...entries.values()].map(toPublic).sort((left, right) => left.name.localeCompare(right.name));
  }

  async function loadAll() {
    state = readState();
    scan();
    notify();
    for (const entry of entries.values()) {
      if (entry.enabled && entry.summary && !entry.error) await loadEntry(entry);
    }
  }

  function notify() {
    try {
      onChange(list());
    } catch {
      // A closed window must not break extension management.
    }
  }

  async function install(sourceDirectory) {
    const source = typeof sourceDirectory === 'string' ? sourceDirectory : '';
    if (!source) return { ok: false, error: '没有选择扩展目录' };
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      return { ok: false, error: '目录不存在或无法访问' };
    }
    if (!stat.isDirectory()) return { ok: false, error: '请选择一个包含 manifest.json 的目录' };

    const parsed = readManifest(source);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const validation = validateManifest(parsed.manifest);
    if (!validation.ok) return { ok: false, error: validation.error };

    const size = directorySize(source);
    if (size > MAX_EXTENSION_BYTES) {
      return { ok: false, error: `扩展体积超过上限（${Math.round(size / 1024 / 1024)} MB > 100 MB）` };
    }

    const id = folderNameFor(parsed.manifest, source);
    const target = path.join(directory, id);
    if (fs.existsSync(target)) {
      return { ok: false, error: '同名同版本的扩展已经安装，请先移除再重新加载' };
    }

    try {
      ensureDirectory();
      // Copy into a staging folder first so a failed copy never leaves a
      // half-installed extension that would be loaded on the next boot.
      const staging = path.join(directory, `.staging-${id}`);
      fs.rmSync(staging, { recursive: true, force: true });
      copyExtension(source, staging);
      fs.renameSync(staging, target);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '复制扩展失败' };
    }

    state.enabled[id] = true;
    writeState();
    scan();
    const entry = entries.get(id);
    if (entry) await loadEntry(entry);
    notify();
    return { ok: true, extension: entry ? toPublic(entry) : null, list: list() };
  }

  async function setEnabled(id, enabled) {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: '扩展不存在', list: list() };
    state.enabled[id] = Boolean(enabled);
    writeState();
    entry.enabled = Boolean(enabled);
    if (enabled) await loadEntry(entry);
    else unloadEntry(entry);
    notify();
    return { ok: true, list: list() };
  }

  async function reload(id) {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: '扩展不存在', list: list() };
    unloadEntry(entry);
    await loadEntry(entry);
    notify();
    return { ok: true, list: list() };
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return { ok: false, error: '扩展不存在', list: list() };
    unloadEntry(entry);
    try {
      fs.rmSync(entry.directory, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法删除扩展目录', list: list() };
    }
    delete state.enabled[id];
    writeState();
    entries.delete(id);
    notify();
    return { ok: true, list: list() };
  }

  return {
    list,
    loadAll,
    install,
    setEnabled,
    reload,
    remove,
    get directory() {
      return directory;
    },
  };
}

module.exports = {
  createExtensionManager,
  describeAction,
  summarizeManifest,
  validateManifest,
  readManifest,
  MAX_EXTENSION_BYTES,
};
