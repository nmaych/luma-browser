const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Native user-script support.
 *
 * Electron implements content scripts, runtime messaging and storage for
 * extensions, but not `chrome.userScripts`. Tampermonkey 5 is Manifest V3 and
 * injects every userscript through that API, so it loads and then silently does
 * nothing. Luma therefore runs `.user.js` files itself: metadata parsing,
 * @match/@include matching, and a GM_* subset are handled here; the wrapper is
 * evaluated in the page's main world by the page manager.
 */

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_SCRIPTS = 200;
const STATE_FILE = 'userscripts.json';
const HEADER = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;

function cleanText(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

/** Reads `// @key value` pairs out of the metadata block. */
function parseMetadata(code) {
  const block = HEADER.exec(code);
  const meta = {
    name: '',
    namespace: '',
    version: '',
    description: '',
    matches: [],
    includes: [],
    excludes: [],
    runAt: 'document-idle',
    grants: [],
    noframes: false,
  };
  if (!block) return meta;
  for (const line of block[1].split(/\r?\n/)) {
    const match = /^\s*\/\/\s*@([\w:-]+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (!value) continue;
    if (key === 'name') meta.name = cleanText(value, 120);
    else if (key === 'namespace') meta.namespace = cleanText(value, 200);
    else if (key === 'version') meta.version = cleanText(value, 40);
    else if (key === 'description') meta.description = cleanText(value, 400);
    else if (key === 'match') meta.matches.push(cleanText(value, 300));
    else if (key === 'include') meta.includes.push(cleanText(value, 300));
    else if (key === 'exclude') meta.excludes.push(cleanText(value, 300));
    else if (key === 'run-at') meta.runAt = cleanText(value, 40);
    else if (key === 'grant') meta.grants.push(cleanText(value, 60));
    else if (key === 'noframes') meta.noframes = true;
  }
  return meta;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chrome match patterns: `<scheme>://<host><path>` where each part may use `*`.
 * The path is a prefix when it ends with `*`, otherwise it must match exactly.
 */
function matchPatternToRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  if (pattern === '<all_urls>') return /^(?:https?|file|ftp):\/\//i;
  const split = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)?$/i.exec(pattern);
  if (!split) return null;
  const scheme = split[1] === '*' ? 'https?' : split[1].toLowerCase();
  const host = split[2];
  const pathPart = split[3] ?? '/';
  if (scheme === 'file') return /^file:\/\//i;

  let hostSource;
  if (host === '*') hostSource = '[^/]+';
  else if (host.startsWith('*.')) hostSource = `(?:[^/]+\\.)?${escapeRegex(host.slice(2))}`;
  else hostSource = escapeRegex(host);
  // Chrome match patterns have no port component: `http://host/*` must match
  // `http://host:8080/...` as well, so the port is always optional here.
  hostSource += '(?::\\d+)?';

  const pathSource = pathPart.endsWith('*')
    ? `${escapeRegex(pathPart.slice(0, -1))}.*`
    : `${escapeRegex(pathPart)}$`;
  try {
    return new RegExp(`^${scheme}://${hostSource}${pathSource}`, 'i');
  } catch {
    return null;
  }
}

/** `@include` accepts globs and `/regex/` literals. */
function includeToRegExp(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i');
    } catch {
      return null;
    }
  }
  const source = escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    return null;
  }
}

function matchesUrl(meta, url) {
  if (typeof url !== 'string' || !/^(https?|file|ftp):/i.test(url)) return false;
  const excluded = meta.excludes.some((pattern) => {
    const re = includeToRegExp(pattern) ?? matchPatternToRegExp(pattern);
    return Boolean(re && re.test(url));
  });
  if (excluded) return false;
  const included = meta.includes.some((pattern) => {
    const re = includeToRegExp(pattern) ?? matchPatternToRegExp(pattern);
    return Boolean(re && re.test(url));
  });
  if (included) return true;
  return meta.matches.some((pattern) => {
    const re = matchPatternToRegExp(pattern);
    return Boolean(re && re.test(url));
  });
}

function readMetadata(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
    const code = fs.readFileSync(filePath, 'utf8');
    return { code, meta: parseMetadata(code), stat };
  } catch {
    return null;
  }
}

/**
 * Wraps the userscript so a broken script cannot break the wrapper, and so the
 * GM_* subset works without an extension runtime. Values live in the page's
 * `localStorage`, keyed by script id, which keeps GM_getValue synchronous.
 */
function buildWrapper({ id, name, version, code }) {
  return `(() => {
  const SCRIPT_ID = ${JSON.stringify(id)};
  const INFO = ${JSON.stringify({ name, version })};
  if (window.__lumaUserscripts && window.__lumaUserscripts.has(SCRIPT_ID)) return;
  const started = window.__lumaUserscripts || new Set();
  Object.defineProperty(window, '__lumaUserscripts', { value: started, configurable: true });
  started.add(SCRIPT_ID);

  const storePrefix = '__luma_gm__' + SCRIPT_ID + '__';
  const encodeKey = (key) => storePrefix + String(key);

  const bridge = (payload) => window.postMessage({ __lumaUserScript: payload }, '*');
  const pendingXhr = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const reply = event.data && event.data.__lumaUserScriptReply;
    if (!reply || !pendingXhr.has(reply.id)) return;
    const details = pendingXhr.get(reply.id);
    pendingXhr.delete(reply.id);
    if (reply.error) {
      if (typeof details.onerror === 'function') details.onerror({ error: reply.error, status: 0 });
      return;
    }
    const payload = {
      finalUrl: reply.url,
      readyState: 4,
      status: reply.status,
      statusText: reply.statusText,
      responseHeaders: reply.headers,
      responseText: reply.text,
      response: reply.text,
    };
    if (typeof details.onload === 'function') details.onload(payload);
  });

  const GM = {
    info: {
      script: { name: INFO.name, version: INFO.version, namespace: '', description: '' },
      scriptHandler: 'Luma Browser',
      version: '1.0',
      scriptMetaStr: '',
      grant: [],
    },
    setValue(key, value) {
      try { localStorage.setItem(encodeKey(key), JSON.stringify({ v: value })); } catch {}
    },
    getValue(key, fallback) {
      try {
        const raw = localStorage.getItem(encodeKey(key));
        if (raw === null) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && 'v' in parsed ? parsed.v : fallback;
      } catch { return fallback; }
    },
    deleteValue(key) { try { localStorage.removeItem(encodeKey(key)); } catch {} },
    listValues() {
      const values = [];
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index) || '';
          if (key.startsWith(storePrefix)) values.push(key.slice(storePrefix.length));
        }
      } catch {}
      return values;
    },
    addStyle(css) {
      const style = document.createElement('style');
      style.textContent = String(css);
      (document.head || document.documentElement).appendChild(style);
      return style;
    },
    log(...args) { console.log('[userscript:' + SCRIPT_ID + ']', ...args); },
    openInTab(url) { bridge({ type: 'open', url: String(url) }); },
    setClipboard(text) {
      try { void navigator.clipboard.writeText(String(text)); } catch {}
    },
    registerMenuCommand: () => 0,
    unregisterMenuCommand: () => {},
    notification(text) {
      try {
        if (typeof Notification === 'function' && Notification.permission === 'granted') {
          new Notification(INFO.name, { body: String(text) });
        }
      } catch {}
    },
    xmlHttpRequest(details) {
      const id = SCRIPT_ID + ':' + Math.random().toString(36).slice(2);
      pendingXhr.set(id, details || {});
      const request = details || {};
      bridge({
        type: 'xhr',
        id,
        details: {
          method: request.method || 'GET',
          url: String(request.url || ''),
          headers: request.headers || {},
          data: typeof request.data === 'string' ? request.data.slice(0, 1_000_000) : null,
        },
      });
      return { abort() { pendingXhr.delete(id); } };
    },
  };

  const names = {
    GM: 'GM', GM_info: 'info', GM_setValue: 'setValue', GM_getValue: 'getValue',
    GM_deleteValue: 'deleteValue', GM_listValues: 'listValues', GM_addStyle: 'addStyle',
    GM_log: 'log', GM_openInTab: 'openInTab', GM_setClipboard: 'setClipboard',
    GM_registerMenuCommand: 'registerMenuCommand', GM_unregisterMenuCommand: 'unregisterMenuCommand',
    GM_notification: 'notification', GM_xmlhttpRequest: 'xmlHttpRequest',
    GM_xmlhttpRequestSync: 'xmlHttpRequest',
  };
  for (const [globalName, member] of Object.entries(names)) {
    try {
      Object.defineProperty(window, globalName, {
        value: typeof GM[member] === 'function' ? GM[member].bind(GM) : GM[member],
        configurable: true,
        writable: true,
      });
    } catch {}
  }
  try { Object.defineProperty(window, 'unsafeWindow', { value: window, configurable: true }); } catch {}

  try {
    (0, eval)(${JSON.stringify(code)});
  } catch (error) {
    console.error('[userscript:' + SCRIPT_ID + '] failed', error);
  }
})();`;
}

function createUserscriptManager({ directory, log = () => {}, onChange = () => {} }) {
  /** @type {Array<{ id: string, file: string, meta: any, code: string, enabled: boolean, updatedAt: number }>} */
  let scripts = [];
  let state = { schema: 1, enabled: {} };

  const statePath = path.join(directory, STATE_FILE);

  function ensureDirectory() {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      log(`[userscripts] cannot create ${directory}: ${error instanceof Error ? error.message : error}`);
    }
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const enabled = parsed && typeof parsed.enabled === 'object' && parsed.enabled ? parsed.enabled : {};
      const clean = {};
      for (const [key, value] of Object.entries(enabled)) {
        if (typeof key === 'string' && typeof value === 'boolean') clean[key] = value;
      }
      return { schema: 1, enabled: clean };
    } catch {
      return { schema: 1, enabled: {} };
    }
  }

  function writeState() {
    try {
      ensureDirectory();
      const temp = `${statePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, statePath);
    } catch (error) {
      log(`[userscripts] cannot persist state: ${error instanceof Error ? error.message : error}`);
    }
  }

  function scan() {
    ensureDirectory();
    state = readState();
    scripts = [];
    let names = [];
    try {
      names = fs.readdirSync(directory).filter((name) => /\.user\.js$/i.test(name));
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (scripts.length >= MAX_SCRIPTS) break;
      const file = path.join(directory, name);
      const parsed = readMetadata(file);
      if (!parsed) continue;
      const id = name.replace(/\.user\.js$/i, '');
      scripts.push({
        id,
        file,
        meta: parsed.meta,
        code: parsed.code,
        enabled: state.enabled[id] !== false,
        updatedAt: Math.round(parsed.stat.mtimeMs),
      });
    }
    notify();
  }

  function notify() {
    try {
      onChange(list());
    } catch {
      // A closed settings window must not break the manager.
    }
  }

  function toPublic(entry) {
    return {
      id: entry.id,
      name: entry.meta.name || entry.id,
      version: entry.meta.version,
      description: entry.meta.description,
      matches: entry.meta.matches.slice(0, 12),
      includes: entry.meta.includes.slice(0, 12),
      runAt: entry.meta.runAt,
      grants: entry.meta.grants,
      enabled: entry.enabled,
      size: entry.code.length,
      updatedAt: entry.updatedAt,
    };
  }

  function list() {
    return scripts.map(toPublic).sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Wrappers for every enabled script that matches this URL, in run-at order. */
  function injectionsFor(url) {
    const order = { 'document-start': 0, 'document-body': 1, 'document-end': 2, 'document-idle': 3 };
    return scripts
      .filter((entry) => entry.enabled && matchesUrl(entry.meta, url))
      .sort((left, right) => (order[left.meta.runAt] ?? 3) - (order[right.meta.runAt] ?? 3))
      .map((entry) => ({
        id: entry.id,
        code: buildWrapper({ id: entry.id, name: entry.meta.name || entry.id, version: entry.meta.version, code: entry.code }),
      }));
  }

  function install(sourcePath) {
    const source = typeof sourcePath === 'string' ? sourcePath : '';
    if (!source) return { ok: false, error: '没有选择脚本文件' };
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      return { ok: false, error: '文件不存在或无法读取' };
    }
    if (!stat.isFile()) return { ok: false, error: '请选择一个 .user.js 文件' };
    if (stat.size > MAX_SCRIPT_BYTES) return { ok: false, error: '脚本超过 2 MB，已拒绝加载' };
    if (!/\.(user\.)?js$/i.test(source)) return { ok: false, error: '只支持 .user.js 脚本' };

    let code;
    try {
      code = fs.readFileSync(source, 'utf8');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法读取脚本' };
    }
    const meta = parseMetadata(code);
    if (!meta.name) return { ok: false, error: '脚本缺少 ==UserScript== 元数据块或 @name' };
    if (meta.matches.length === 0 && meta.includes.length === 0) {
      return { ok: false, error: '脚本没有 @match 或 @include，加载后不会在任何页面运行' };
    }

    ensureDirectory();
    const slug = cleanText(meta.name, 60).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'script';
    const digest = crypto.createHash('sha1').update(`${meta.name}@${meta.version}@${code.length}`).digest('hex').slice(0, 6);
    const fileName = `${slug}-${digest}.user.js`;
    const target = path.join(directory, fileName);
    try {
      fs.writeFileSync(target, code, 'utf8');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法写入脚本目录' };
    }
    const id = fileName.replace(/\.user\.js$/i, '');
    state.enabled[id] = true;
    writeState();
    scan();
    return { ok: true, list: list() };
  }

  function setEnabled(id, enabled) {
    if (!scripts.some((entry) => entry.id === id)) return { ok: false, error: '脚本不存在', list: list() };
    state.enabled[id] = Boolean(enabled);
    writeState();
    scan();
    return { ok: true, list: list() };
  }

  function remove(id) {
    const entry = scripts.find((item) => item.id === id);
    if (!entry) return { ok: false, error: '脚本不存在', list: list() };
    try {
      fs.rmSync(entry.file, { force: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法删除脚本', list: list() };
    }
    delete state.enabled[id];
    writeState();
    scan();
    return { ok: true, list: list() };
  }

  return {
    list,
    scan,
    install,
    setEnabled,
    remove,
    injectionsFor,
    get directory() {
      return directory;
    },
    get count() {
      return scripts.length;
    },
  };
}

module.exports = {
  createUserscriptManager,
  parseMetadata,
  matchPatternToRegExp,
  matchesUrl,
  buildWrapper,
  MAX_SCRIPT_BYTES,
};
