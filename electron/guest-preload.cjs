// Runs in the guest's isolated world (contextIsolation + sandbox). The page
// cannot reach this context, so it cannot hook form capture or read IPC
// payloads. Credentials never travel through the page's main world.
const { ipcRenderer } = require('electron');

let captureBound = false;
/** Last payload handed to the browser, so one login cannot prompt twice. */
let lastReport = '';

function isTextualField(field) {
  const type = (field.getAttribute('type') || 'text').toLowerCase();
  return ['text', 'email', 'tel'].includes(type) && !field.disabled && !field.readOnly;
}

function findUsernameField(fields, passwordField) {
  return fields.find((field) => {
    if (!isTextualField(field)) return false;
    const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
    return autocomplete === 'username' || autocomplete === 'email';
  }) || fields.find((field) => isTextualField(field)
    && Boolean(field.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING));
}

/**
 * `sendToHost` only reaches a <webview> host. Luma draws pages with native
 * WebContentsView instances that have no host element, so the message was
 * dropped and no site could ever offer to save a password. A plain `send`
 * arrives on the webContents' `ipc-message` event, which is what main listens
 * for.
 */
function reportCredentials(username, password) {
  if (!password) return;
  const key = `${username}\u0000${password}`;
  if (key === lastReport) return;
  lastReport = key;
  ipcRenderer.send('luma:password-captured', { username, password });
}

function credentialsOf(form) {
  try {
    const passwordField = form.querySelector('input[type="password"]');
    if (!passwordField || !passwordField.value) return null;
    const fields = Array.from(form.querySelectorAll('input'));
    const usernameField = findUsernameField(fields, passwordField);
    return {
      username: usernameField ? String(usernameField.value || '') : '',
      password: String(passwordField.value || ''),
    };
  } catch {
    // A malformed form must never break the page's own login flow.
    return null;
  }
}

function reportForm(form) {
  const found = credentialsOf(form);
  if (found) reportCredentials(found.username, found.password);
}

/**
 * Sites that log in over XHR never submit a form (Bilibili is one), so a
 * successful login looked like nothing happened. Watch the password field
 * itself and report a short moment after the user stops typing.
 */
const pendingTyped = new Map();

function scheduleTypedReport(passwordField) {
  const previous = pendingTyped.get(passwordField);
  if (previous) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    pendingTyped.delete(passwordField);
    if (!passwordField.isConnected || !passwordField.value) return;
    const scope = passwordField.form || document;
    const fields = Array.from(scope.querySelectorAll('input'));
    const usernameField = findUsernameField(fields, passwordField);
    const username = usernameField ? String(usernameField.value || '') : '';
    // A single character is more likely a mis-click than a password.
    if (passwordField.value.length < 4 && !username) return;
    reportCredentials(username, String(passwordField.value));
  }, 1200);
  pendingTyped.set(passwordField, timer);
}

function installCapture() {
  if (captureBound) return;
  captureBound = true;
  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) reportForm(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
    if (!target) return;
    const form = target.form || target.closest('form');
    if (form) reportForm(form);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    if (event.target.type !== 'password' || !event.target.form) return;
    const form = event.target.form;
    window.setTimeout(() => reportForm(form), 250);
  }, true);
  document.addEventListener('input', (event) => {
    const field = event.target;
    if (field instanceof HTMLInputElement && field.type === 'password') scheduleTypedReport(field);
  }, true);
  // Leaving the page right after typing still counts as a login attempt.
  window.addEventListener('pagehide', () => {
    for (const field of pendingTyped.keys()) {
      if (field.isConnected && field.value) {
        const form = field.form || document;
        const fields = Array.from(form.querySelectorAll('input'));
        const usernameField = findUsernameField(fields, field);
        reportCredentials(usernameField ? String(usernameField.value || '') : '', String(field.value));
      }
    }
  });
}

/** Writes through the prototype setter so page overrides cannot see the value. */
function writeValue(field, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(field, value);
  else field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Nearest username input before the password box, preferring its own group. */
function usernameFieldFor(passwordField) {
  if (!passwordField) return null;
  const container = passwordField.parentElement;
  if (container) {
    const local = findUsernameField(Array.from(container.querySelectorAll('input')), passwordField);
    if (local) return local;
  }
  const scope = passwordField.form || document;
  return findUsernameField(Array.from(scope.querySelectorAll('input')), passwordField);
}

/**
 * Fills the login form the anchor field belongs to. `replace` is true when the
 * user picked an account from the dropdown; the automatic autofill path leaves
 * whatever the page already put in the fields alone.
 */
function fillInto(anchor, payload, replace) {
  if (!payload || typeof payload.password !== 'string') return false;
  const scope = (anchor && anchor.form) || document;
  const passwordField = anchor && anchor.type === 'password'
    ? anchor
    : scope.querySelector('input[type="password"]:not([disabled])');
  const usernameField = anchor && isTextualField(anchor) && anchor !== passwordField
    ? anchor
    : usernameFieldFor(passwordField);
  if (!passwordField && !usernameField) return false;
  const canWrite = (field) => field && !field.disabled && !field.readOnly && (replace || !field.value);
  if (usernameField && canWrite(usernameField) && typeof payload.username === 'string') {
    writeValue(usernameField, payload.username);
  }
  const password = passwordField && canWrite(passwordField) ? passwordField : null;
  if (password) writeValue(password, payload.password);
  // Keep the caret where the user left it; jumping to the password box would
  // also pop the dropdown open again right after they picked an account.
  const focusTarget = anchor && anchor.isConnected ? anchor : (password || usernameField);
  focusTarget.focus();
  return true;
}

function fillCredentials(payload) {
  // The toolbar's own autofill is not a click on a field, so it must not be
  // mistaken for one and open the dropdown.
  suppressOpenUntil = Date.now() + 500;
  return fillInto(null, payload, false);
}

ipcRenderer.on('luma:autofill', (_event, payload) => {
  try {
    fillCredentials(payload);
  } catch {
    // Autofill is best effort; the page keeps working.
  }
});

/* ------------------------------------------------------------------------- *
 * Saved-login dropdown
 *
 * Clicking a login field lists the accounts saved for this origin. Only the
 * account name is rendered, and it lives in a closed shadow root, so page
 * scripts cannot read the list. The password is fetched when a row is picked
 * and written straight into the inputs — it never enters page-visible DOM.
 * ------------------------------------------------------------------------- */

const PANEL_ROW_LIMIT = 5;
const PANEL_STYLE = `
  .panel {
    position: fixed;
    z-index: 2147483647;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 4px;
    border: 1px solid rgba(18, 21, 38, .12);
    border-radius: 10px;
    background: #fff;
    color: #1e2133;
    box-shadow: 0 12px 32px rgba(18, 21, 38, .18);
    font: 13px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 6px;
    color: #9096a8;
    font-size: 10px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover, .row[data-active="1"] { background: #f1f2f8; }
  .avatar {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #e7e8f2;
    color: #5a5f75;
    font-size: 10px;
    font-weight: 700;
  }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name[data-empty="1"] { color: #a8adbd; }
`;

let panelHost = null;
let panelRoot = null;
let panelField = null;
let panelItems = [];
let panelSelected = -1;
let suggestCache = { origin: '', at: 0, items: [] };
let openTimer = 0;
let positionFrame = 0;
/** A programmatic fill must not read as a click on a login field. */
let suppressOpenUntil = 0;

function loginFieldType(field) {
  return String(field.type || field.getAttribute('type') || 'text').toLowerCase();
}

/** A login field is a password box, or a text box sitting next to one. */
function isLoginField(field) {
  if (!(field instanceof HTMLInputElement) || field.disabled || field.readOnly) return false;
  const type = loginFieldType(field);
  if (type === 'password') return true;
  if (type !== 'text' && type !== 'email' && type !== 'tel') return false;
  const autocomplete = (field.getAttribute('autocomplete') || '').toLowerCase();
  if (autocomplete === 'one-time-code') return false;
  const hasPassword = (node) => Boolean(node && node.querySelector('input[type="password"]'));
  // Login markup is often a bare <div>, not a <form>, so look at the closest
  // two wrappers too — but never at the whole page, or every search box on a
  // site with a hidden login dialog would pop the list open.
  if (field.form) return hasPassword(field.form);
  let node = field.parentElement;
  for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
    if (hasPassword(node)) return true;
  }
  return false;
}

async function suggestionsFor() {
  const now = Date.now();
  if (suggestCache.origin === location.origin && now - suggestCache.at < 5000) return suggestCache.items;
  const result = await ipcRenderer.invoke('passwords:suggest').catch(() => []);
  const items = Array.isArray(result)
    ? result.filter((entry) => entry && typeof entry.id === 'string')
    : [];
  suggestCache = { origin: location.origin, at: now, items };
  return items;
}

function closePanel() {
  panelField = null;
  panelItems = [];
  panelSelected = -1;
  if (panelHost) panelHost.remove();
  panelHost = null;
  panelRoot = null;
}

function positionPanel(field) {
  if (!panelRoot || !field || !field.isConnected) return;
  const rect = field.getBoundingClientRect();
  if (rect.width < 2 && rect.height < 2) {
    closePanel();
    return;
  }
  const width = Math.round(Math.max(196, Math.min(340, rect.width || 220)));
  panelRoot.style.width = `${width}px`;
  const height = panelRoot.getBoundingClientRect().height;
  const left = Math.round(Math.min(rect.left, Math.max(8, window.innerWidth - width - 8)));
  const below = rect.bottom + 4;
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 4);
  panelRoot.style.left = `${Math.max(8, left)}px`;
  panelRoot.style.top = `${Math.round(top)}px`;
}

function schedulePosition() {
  if (!panelField) return;
  window.cancelAnimationFrame(positionFrame);
  positionFrame = window.requestAnimationFrame(() => positionPanel(panelField));
}

function highlight() {
  if (!panelRoot) return;
  for (const row of panelRoot.querySelectorAll('.row')) {
    row.dataset.active = Number(row.dataset.index) === panelSelected ? '1' : '0';
  }
}

async function choose(entry) {
  const field = panelField;
  closePanel();
  // Filling focuses the inputs; that must not be read as a fresh click and
  // reopen the very list the user just picked from.
  suppressOpenUntil = Date.now() + 400;
  const secrets = await ipcRenderer.invoke('passwords:fill-entry', entry.id).catch(() => null);
  if (!secrets || typeof secrets.password !== 'string') return;
  try {
    fillInto(field && field.isConnected ? field : null, secrets, true);
  } catch {
    // A page that rewrites the form mid-fill must not break its own login.
  }
}

function ensurePanel() {
  if (panelHost && panelHost.isConnected) return true;
  const host = document.createElement('div');
  host.setAttribute('data-luma-autofill', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PANEL_STYLE);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    // No constructable stylesheets: fall back to a style element.
    const style = document.createElement('style');
    style.textContent = PANEL_STYLE;
    shadow.appendChild(style);
  }
  const root = document.createElement('div');
  root.className = 'panel';
  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  panelHost = host;
  panelRoot = root;
  // A press inside the panel must not blur the field before the click lands.
  root.addEventListener('mousedown', (event) => event.preventDefault(), true);
  return true;
}

function renderPanel(field, items) {
  if (!ensurePanel() || !panelRoot) return;
  panelField = field;
  panelItems = items.slice(0, PANEL_ROW_LIMIT);
  panelSelected = -1;
  panelRoot.textContent = '';
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = '已保存的登录信息';
  panelRoot.appendChild(head);
  panelItems.forEach((entry, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    row.dataset.index = String(index);
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    const name = document.createElement('span');
    name.className = 'name';
    const username = typeof entry.username === 'string' ? entry.username : '';
    avatar.textContent = (username.trim().charAt(0) || '?').toUpperCase();
    if (username) name.textContent = username;
    else {
      name.textContent = '此网站保存的密码';
      name.dataset.empty = '1';
    }
    row.append(avatar, name);
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void choose(entry);
    });
    panelRoot.appendChild(row);
  });
  positionPanel(field);
  highlight();
}

async function openFor(field) {
  if (!field.isConnected || Date.now() < suppressOpenUntil) return;
  if (panelField === field && panelHost && panelHost.isConnected) return;
  const items = await suggestionsFor();
  if (!field.isConnected) return;
  if (!items.length) {
    if (panelField === field) closePanel();
    return;
  }
  renderPanel(field, items);
}

function scheduleOpen(field) {
  window.clearTimeout(openTimer);
  openTimer = window.setTimeout(() => { void openFor(field); }, 0);
}

// `pointerdown` covers the second click on an already focused field, where no
// focus event fires; `focusin` covers keyboard navigation into the field.
document.addEventListener('pointerdown', (event) => {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (panelHost && path.includes(panelHost)) return;
  const target = event.target;
  const field = target instanceof HTMLInputElement && isLoginField(target) ? target : null;
  closePanel();
  if (field) scheduleOpen(field);
}, true);

document.addEventListener('focusin', (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || !isLoginField(field)) return;
  scheduleOpen(field);
}, true);

document.addEventListener('keydown', (event) => {
  if (!panelHost || !panelField) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!panelItems.length) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    panelSelected = (panelSelected + step + panelItems.length) % panelItems.length;
    highlight();
    return;
  }
  if (event.key === 'Enter' && panelSelected >= 0) {
    event.preventDefault();
    event.stopPropagation();
    void choose(panelItems[panelSelected]);
    return;
  }
  if (event.key === 'Escape') {
    event.stopPropagation();
    closePanel();
  }
}, true);

window.addEventListener('scroll', schedulePosition, true);
window.addEventListener('resize', schedulePosition);
window.addEventListener('pagehide', closePanel);

/**
 * Userscripts run in the page's main world, where there is no ipcRenderer.
 * They post a message for the two things that cannot be done from there:
 * opening a tab and cross-origin requests.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data && event.data.__lumaUserScript;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'open' && typeof message.url === 'string') {
    ipcRenderer.send('userscripts:open', message.url);
    return;
  }
  if (message.type === 'xhr' && typeof message.id === 'string') {
    const details = message.details || {};
    void ipcRenderer.invoke('userscripts:request', {
      method: details.method,
      url: details.url,
      headers: details.headers,
      data: details.data,
    }).then((reply) => {
      window.postMessage({ __lumaUserScriptReply: { id: message.id, ...reply } }, '*');
    }).catch((error) => {
      window.postMessage({
        __lumaUserScriptReply: { id: message.id, error: error instanceof Error ? error.message : 'request failed' },
      }, '*');
    });
  }
});

installCapture();
// A popover mirrored above the page stops covering it, so a click that lands on
// the page must dismiss it the way an outside click did before.
document.addEventListener('pointerdown', () => {
  ipcRenderer.send('page:pointerdown');
}, true);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installCapture, { once: true });
}
