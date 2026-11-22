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

function fillCredentials(payload) {
  if (!payload || typeof payload.password !== 'string') return false;
  const passwordField = document.querySelector('input[type="password"]:not([disabled])');
  if (!passwordField) return false;
  const form = passwordField.form || document;
  const fields = Array.from(form.querySelectorAll('input'));
  const usernameField = findUsernameField(fields, passwordField);
  const setValue = (field, value) => {
    // The isolated world owns this prototype; page overrides cannot intercept.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (usernameField && typeof payload.username === 'string' && payload.username && !usernameField.value) {
    setValue(usernameField, payload.username);
  }
  if (!passwordField.value) setValue(passwordField, payload.password);
  passwordField.focus();
  return true;
}

ipcRenderer.on('luma:autofill', (_event, payload) => {
  try {
    fillCredentials(payload);
  } catch {
    // Autofill is best effort; the page keeps working.
  }
});

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
