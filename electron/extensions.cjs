const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

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
const SKIPPED_NAMES = new Set(['.git', '.svn', 'node_modules/.cache', '_metadata']);
const CRX_MAGIC = 0x34327243; // 'Cr24' little-endian
const STATE_SCHEMA = 1;

/** Text that ends up in the settings list is clamped and stripped of NULs. */
function cleanText(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

/**
 * Chrome extensions localise their manifest through `__MSG_key__` tokens that
 * are resolved against `_locales/<locale>/messages.json`. Electron does not do
 * that for us, so an extension would otherwise be listed as `__MSG_extName__`.
 */
function readLocaleMessages(directory, locale) {
  if (!locale || typeof locale !== 'string' || locale.includes('..')) return null;
  try {
    const raw = fs.readFileSync(path.join(directory, '_locales', locale, 'messages.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function localeTable(directory, manifest) {
  const fallback = typeof manifest.default_locale === 'string' ? manifest.default_locale : 'en';
  return [
    readLocaleMessages(directory, 'zh_CN'),
    readLocaleMessages(directory, fallback),
    readLocaleMessages(directory, 'en'),
  ].filter(Boolean);
}

function resolveMessage(value, tables) {
  if (typeof value !== 'string' || !value.includes('__MSG_')) return value;
  return value.replace(/__MSG_([A-Za-z0-9_@.]+)__/g, (match, key) => {
    for (const table of tables) {
      const entry = table[key] || table[key.toLowerCase()];
      if (entry && typeof entry.message === 'string' && entry.message) return entry.message;
    }
    return match;
  });
}

/**
 * APIs an extension may ask for that this Electron build does not provide.
 * Keeping the list explicit lets the manager explain *why* an extension loads
 * but does not work, instead of showing a green "已加载" badge and nothing else.
 */
const LIMITED_APIS = {
  cookies: 'chrome.cookies',
  webNavigation: 'chrome.webNavigation',
  contextMenus: 'chrome.contextMenus',
  notifications: 'chrome.notifications',
  downloads: 'chrome.downloads',
  userScripts: 'chrome.userScripts',
  declarativeContent: 'chrome.declarativeContent',
  browsingData: 'chrome.browsingData',
  bookmarks: 'chrome.bookmarks',
  history: 'chrome.history',
  sessions: 'chrome.sessions',
  debugger: 'chrome.debugger',
  webRequestBlocking: 'MV3 的 webRequestBlocking',
};

/** Human-readable gaps for the settings list; empty when nothing is missing. */
function describeCompatibility(manifest) {
  const permissions = [
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
  ].filter((item) => typeof item === 'string');
  const missing = [];
  for (const permission of permissions) {
    const label = LIMITED_APIS[permission];
    if (label && !missing.includes(label)) missing.push(label);
  }
  const notes = [];
  const version = Number(manifest.manifest_version);
  if (missing.includes('chrome.userScripts')) {
    notes.push('依赖 chrome.userScripts 注入用户脚本，当前内核不提供该 API，脚本会被跳过（扩展管理界面仍可打开）');
  }
  if (version === 3 && permissions.includes('webRequestBlocking')) {
    notes.push('Manifest V3 不再允许 webRequestBlocking，请求拦截可能退化为 declarativeNetRequest');
  }
  if (permissions.includes('tabs')) {
    notes.push('chrome.tabs 仅有查询/更新能力，扩展无法自行创建标签页');
  }
  if (manifest.background?.service_worker) {
    notes.push('后台 Service Worker 可以运行，但 chrome.windows 不可用');
  }
  return { limited: missing.length > 0, missing, notes };
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
  const tables = localeTable(directory, manifest);
  const popup = typeof action.default_popup === 'string' ? action.default_popup.trim() : '';
  const title = cleanText(resolveMessage(action.default_title, tables), 120)
    || cleanText(resolveMessage(manifest.name, tables), 120);
  return {
    title,
    popup: popup && !popup.includes('..') ? popup.replace(/^\/+/, '') : '',
    icon: readActionIcon(directory, action.default_icon) ?? null,
  };
}

/** The page an extension can be opened on: options first, then the popup. */
function optionsPageOf(manifest) {
  const candidates = [
    manifest.options_ui?.page,
    manifest.options_page,
    manifest.action?.default_popup,
    manifest.browser_action?.default_popup,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() && !candidate.includes('..')) {
      return candidate.trim().replace(/^\/+/, '');
    }
  }
  return '';
}

/** Flattens a manifest into the fields the settings list renders. */
function summarizeManifest(manifest, directory = '') {
  const tables = directory ? localeTable(directory, manifest) : [];
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
    name: cleanText(resolveMessage(manifest.name, tables), 120),
    version: cleanText(manifest.version, 32),
    description: cleanText(resolveMessage(manifest.description, tables), 400),
    manifestVersion: version === 2 ? 2 : 3,
    permissions,
    hostPermissions,
    matches: [...matches].slice(0, 12),
    hasAction: Boolean(manifest.action || manifest.browser_action || manifest.page_action),
    hasBackground: Boolean(manifest.background?.service_worker || manifest.background?.scripts),
    page: optionsPageOf(manifest),
    compat: describeCompatibility(manifest),
    directory,
  };
}

/** Folder-safe identifier: readable prefix plus a short digest for uniqueness. */
function folderNameFor(manifest) {
  const slug = cleanText(manifest.name, 60)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'extension';
  // Identity is name + version only: the same extension must land in the same
  // folder whether it came from a directory or a .crx.
  const digest = crypto.createHash('sha1').update(`${manifest.name}@${manifest.version}`).digest('hex');
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

/**
 * Splits a CRX container into its ZIP payload.
 * CRX2 stores two length-prefixed blobs (public key, signature); CRX3 stores a
 * single protobuf header.
 */
function crxPayload(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return { ok: false, error: '无法读取文件' };
  }
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== CRX_MAGIC) {
    return { ok: false, error: '这不是有效的 .crx 文件' };
  }
  const version = buffer.readUInt32LE(4);
  let offset;
  if (version === 2) {
    offset = 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12);
  } else if (version === 3) {
    offset = 12 + buffer.readUInt32LE(8);
  } else {
    return { ok: false, error: `不支持的 CRX 版本：${version}` };
  }
  if (!Number.isFinite(offset) || offset <= 0 || offset >= buffer.length) {
    return { ok: false, error: '.crx 头部已损坏' };
  }
  return { ok: true, zip: buffer.subarray(offset) };
}

/** Extracts a ZIP payload, refusing entries that would escape the target. */
function extractZipTo(zipBuffer, target) {
  const root = path.resolve(target);
  fs.mkdirSync(root, { recursive: true });
  let zip;
  try {
    // Copy the slice: adm-zip reads the underlying ArrayBuffer when given a
    // Buffer view, which breaks when the payload starts mid-buffer.
    zip = new AdmZip(Buffer.from(zipBuffer));
  } catch {
    return { ok: false, error: '扩展包已损坏' };
  }
  for (const entry of zip.getEntries()) {
    if (entry.entryName.startsWith('_metadata/')) continue;
    const resolved = path.resolve(root, entry.entryName);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, error: '扩展包包含非法路径' };
    }
    if (entry.isDirectory) {
      fs.mkdirSync(resolved, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
  }
  return { ok: true };
}

/** Some packs wrap everything in a single top-level folder. */
function findExtensionRoot(directory) {
  if (fs.existsSync(path.join(directory, MANIFEST_FILE))) return directory;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return directory;
  }
  if (entries.length !== 1) return directory;
  const nested = path.join(directory, entries[0].name);
  return fs.existsSync(path.join(nested, MANIFEST_FILE)) ? nested : directory;
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
      page: entry.summary?.page ?? '',
      compat: entry.summary?.compat ?? { limited: false, missing: [], notes: [] },
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

  /** The page an extension can be opened on, plus the URL to load it from. */
  function pageFor(id, page) {
    const entry = entries.get(id);
    if (!entry || !entry.loaded) return null;
    const relative = typeof page === 'string' && page.trim() && !page.includes('..')
      ? page.trim().replace(/^\/+/, '')
      : entry.summary?.page;
    if (!relative) return null;
    return `chrome-extension://${entry.loaded.id}/${relative}`;
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

    // The folder name is derived from the visible name, so `__MSG_*__` tokens
    // are resolved first: an extension should not appear as `msg-extname-…`.
    const resolvedName = String(resolveMessage(parsed.manifest.name, localeTable(source, parsed.manifest)) || parsed.manifest.name);
    const id = folderNameFor({ ...parsed.manifest, name: resolvedName });
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

  /**
   * Installs a `.crx` package: CRX is a ZIP with a signed header, so the archive
   * is unwrapped into a temp folder and then follows the directory install path.
   */
  async function installCrx(filePath) {
    const payload = crxPayload(typeof filePath === 'string' ? filePath : '');
    if (!payload.ok) return { ok: false, error: payload.error };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luma-crx-'));
    try {
      const unpacked = path.join(workDir, 'unpacked');
      const extracted = extractZipTo(payload.zip, unpacked);
      if (!extracted.ok) return { ok: false, error: extracted.error };
      const root = findExtensionRoot(unpacked);
      const outcome = await install(root);
      return { ...outcome, list: list() };
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // A locked temp folder is harmless and cleaned up by the OS later.
      }
    }
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
    installCrx,
    setEnabled,
    reload,
    remove,
    pageFor,
    get directory() {
      return directory;
    },
  };
}

module.exports = {
  createExtensionManager,
  crxPayload,
  describeAction,
  describeCompatibility,
  summarizeManifest,
  validateManifest,
  readManifest,
  MAX_EXTENSION_BYTES,
};
