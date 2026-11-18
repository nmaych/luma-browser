const fs = require('node:fs');

/**
 * Settings persistence for the main process.
 *
 * Chrome keeps a single `Local State`/`Preferences` pair next to the profile;
 * Luma keeps one JSON document per concern. This module owns the shape
 * validation and the debounced write so callers only mutate the object they get
 * back and call `save()`.
 */

const SITE_HOST = /^[a-z0-9.-]{1,253}$/i;

/**
 * Reads the settings document, falling back to `defaults` for anything missing
 * or malformed. Unknown keys are dropped instead of being written back, so a
 * downgrade cannot leave the file in a shape the old build misreads.
 */
function loadSettings(filePath, defaults, shortcutKeys = []) {
  const next = {
    ...defaults,
    adblock: { ...defaults.adblock, disabledSites: [] },
    shortcuts: { ...(defaults.shortcuts ?? {}) },
  };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // First run or an unreadable profile: defaults apply.
  }
  if (!parsed || typeof parsed !== 'object') return next;

  if (parsed.adblock && typeof parsed.adblock === 'object') {
    next.adblock.enabled = parsed.adblock.enabled !== false;
    if (Array.isArray(parsed.adblock.disabledSites)) {
      next.adblock.disabledSites = parsed.adblock.disabledSites.filter(
        (site) => typeof site === 'string' && SITE_HOST.test(site),
      );
    }
  }
  if (typeof parsed.bossKey === 'string' && parsed.bossKey.length <= 64) next.bossKey = parsed.bossKey;
  if (parsed.shortcuts && typeof parsed.shortcuts === 'object') {
    for (const action of shortcutKeys) {
      const value = parsed.shortcuts[action];
      if (typeof value === 'string' && value.length <= 64) next.shortcuts[action] = value;
    }
  }
  next.blockedTotal = Number.isFinite(parsed.blockedTotal)
    ? Math.max(0, Math.floor(parsed.blockedTotal))
    : 0;
  return next;
}

/**
 * Debounced writer. Window moves and ad-block counters mutate the state object
 * many times per second; the file is rewritten 200 ms after the last change.
 */
function createSettingsWriter(filePath, readState, delay = 200) {
  let timer = null;
  return function save() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.writeFileSync(filePath, JSON.stringify(readState(), null, 2), 'utf8');
      } catch {
        // A read-only profile keeps settings in memory for this session.
      }
    }, delay);
  };
}

module.exports = { createSettingsWriter, loadSettings };
