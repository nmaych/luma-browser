const { BrowserWindow, globalShortcut } = require('electron');

/**
 * Keyboard shortcut plumbing: accelerator parsing for the renderer's settings
 * recorder, matching of native key events, and the global "boss key".
 */

let registeredBossKey = null;

function parseAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null;
  const parts = accelerator.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop();
  const parsed = { key: key.toLowerCase(), control: false, shift: false, alt: false, meta: false };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') parsed.control = true;
    else if (lower === 'shift') parsed.shift = true;
    else if (lower === 'alt' || lower === 'option') parsed.alt = true;
    else if (['meta', 'cmd', 'command', 'super', 'win'].includes(lower)) parsed.meta = true;
    else return null;
  }
  return parsed;
}

function normalizeInputKey(key) {
  const value = String(key || '').toLowerCase();
  if (value === ' ' || value === 'spacebar' || value === 'space') return 'space';
  return value;
}

function matchAccelerator(input, accelerator) {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  if (normalizeInputKey(input.key) !== parsed.key) return false;
  return Boolean(input.control) === parsed.control
    && Boolean(input.meta) === parsed.meta
    && Boolean(input.shift) === parsed.shift
    && Boolean(input.alt) === parsed.alt;
}

function shortcutActionForInput(input, shortcuts = {}) {
  for (const [action, accelerator] of Object.entries(shortcuts)) {
    if (matchAccelerator(input, accelerator)) return action;
  }
  // F5 keeps working as a reload alias even though bindings are customizable.
  if (normalizeInputKey(input.key) === 'f5' && !input.control && !input.alt && !input.meta && !input.shift) {
    return 'reload';
  }
  // Layouts disagree about which key produces "+": accept the shifted forms of
  // the zoom bindings so Ctrl++ and Ctrl+_ behave like Ctrl+= and Ctrl+-.
  if (input.control && !input.alt && !input.meta) {
    const key = normalizeInputKey(input.key);
    if ((key === '=' || key === '+') && shortcuts['zoom-in']) return 'zoom-in';
    if ((key === '-' || key === '_') && shortcuts['zoom-out']) return 'zoom-out';
    if (key === '0' && shortcuts['zoom-reset']) return 'zoom-reset';
  }
  return null;
}

function toggleBossMode() {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  if (windows.length === 0) return;
  const visible = windows.filter((win) => win.isVisible() && !win.isMinimized());
  if (visible.length > 0) {
    for (const win of windows) win.hide();
    return;
  }
  for (const win of windows) {
    if (win.isMinimized()) win.restore();
    win.show();
  }
  windows[windows.length - 1].focus();
}

function registerBossKey(accelerator) {
  if (registeredBossKey) {
    try {
      globalShortcut.unregister(registeredBossKey);
    } catch {
      // The accelerator may already be released.
    }
    registeredBossKey = null;
  }
  if (typeof accelerator !== 'string' || !accelerator.trim()) return false;
  try {
    const registered = globalShortcut.register(accelerator, toggleBossMode);
    if (registered) registeredBossKey = accelerator;
    return registered;
  } catch {
    return false;
  }
}

module.exports = {
  matchAccelerator,
  parseAccelerator,
  normalizeInputKey,
  registerBossKey,
  shortcutActionForInput,
  currentBossKey: () => registeredBossKey,
  toggleBossMode,
};
