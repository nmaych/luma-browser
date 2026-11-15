// Runs in the guest's isolated world (contextIsolation + sandbox). The page
// cannot reach this context, so it cannot hook form capture or read IPC
// payloads. Credentials never travel through the page's main world.
const { ipcRenderer } = require('electron');

let captureBound = false;

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

function reportForm(form) {
  try {
    const passwordField = form.querySelector('input[type="password"]');
    if (!passwordField || !passwordField.value) return;
    const fields = Array.from(form.querySelectorAll('input'));
    const usernameField = findUsernameField(fields, passwordField);
    ipcRenderer.sendToHost('luma:password-captured', {
      username: usernameField ? String(usernameField.value || '') : '',
      password: String(passwordField.value || ''),
    });
  } catch {
    // A malformed form must never break the page's own login flow.
  }
}

function installCapture() {
  if (captureBound) return;
  captureBound = true;
  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) reportForm(event.target);
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"]') : null;
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

installCapture();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installCapture, { once: true });
}
