// Password vault backed by Electron safeStorage. Both the username and the
// password are encrypted at rest; the file only contains ciphertext. Decrypted
// values never leave the main process except for an explicit autofill request
// from the browser UI for the exact origin that asked for it.
//
// Writes are atomic (tmp + fsync + rename) and keep a .bak of the last good
// vault. A corrupt vault never gets overwritten with an empty one: the vault
// switches to read-only mode and reports the problem to the UI instead.

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_ENTRIES = 300;
const MAX_USERNAME = 200;
const MAX_PASSWORD = 500;

let cachedVault = null;
let readOnly = false;
let loadError = null;
let recoveredFromBackup = false;
let skipBackupOnce = false;

function vaultPath() {
  return path.join(app.getPath('userData'), 'passwords.json');
}

function backupPath() {
  return `${vaultPath()}.bak`;
}

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function status() {
  // Ensure corruption/recovery is detected before the UI reads the flags.
  readVault();
  return {
    available: isAvailable(),
    readOnly,
    error: loadError,
    recovered: recoveredFromBackup,
  };
}

function normalizeOrigin(origin) {
  try {
    const parsed = new URL(String(origin));
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function emptyVault() {
  return { version: 1, entries: [] };
}

function normalizeVault(parsed) {
  if (!parsed || !Array.isArray(parsed.entries)) return null;
  const vault = emptyVault();
  vault.entries = parsed.entries.filter(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.origin === 'string' &&
      typeof entry.secret === 'string' &&
      normalizeOrigin(entry.origin),
  );
  return vault;
}

function readVault() {
  if (cachedVault) return cachedVault;
  const file = vaultPath();
  if (!fs.existsSync(file)) {
    cachedVault = emptyVault();
    return cachedVault;
  }
  try {
    const vault = normalizeVault(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!vault) throw new Error('invalid-vault');
    cachedVault = vault;
    return cachedVault;
  } catch (error) {
    console.error('[passwords] vault is unreadable:', error);
    try {
      const backup = normalizeVault(JSON.parse(fs.readFileSync(backupPath(), 'utf8')));
      if (backup) {
        cachedVault = backup;
        recoveredFromBackup = true;
        skipBackupOnce = true;
        loadError = 'recovered-from-backup';
        console.warn('[passwords] recovered vault from passwords.json.bak');
        return cachedVault;
      }
    } catch {
      // No usable backup either.
    }
    readOnly = true;
    loadError = 'vault-corrupt';
    cachedVault = emptyVault();
    return cachedVault;
  }
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
  try {
    if (!skipBackupOnce && fs.existsSync(file)) {
      const bakTmp = `${backupPath()}.tmp`;
      fs.copyFileSync(file, bakTmp);
      fs.renameSync(bakTmp, backupPath());
    }
  } catch {
    // A missing backup must not block the primary write.
  }
  fs.renameSync(tmp, file);
  skipBackupOnce = false;
}

function writeVault(vault) {
  if (readOnly) return false;
  try {
    atomicWrite(vaultPath(), JSON.stringify(vault, null, 2));
    cachedVault = vault;
    loadError = null;
    return true;
  } catch (error) {
    console.error('[passwords] failed to write vault:', error);
    loadError = 'write-failed';
    return false;
  }
}

function decryptEntry(entry) {
  if (!isAvailable()) return null;
  try {
    const payload = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed.password !== 'string') return null;
    return {
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

function metaOf(entry) {
  const payload = decryptEntry(entry);
  if (!payload) return null;
  return {
    id: entry.id,
    origin: entry.origin,
    host: new URL(entry.origin).host,
    username: payload.username,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastUsedAt: entry.lastUsedAt ?? null,
  };
}

function listEntries() {
  const vault = readVault();
  return vault.entries
    .map(metaOf)
    .filter(Boolean)
    .sort((left, right) => (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt));
}

function listForOrigin(origin) {
  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin) return [];
  const vault = readVault();
  return vault.entries
    .filter((entry) => entry.origin === cleanOrigin)
    .map(metaOf)
    .filter(Boolean)
    .map((entry) => ({ id: entry.id, username: entry.username }));
}

function entriesForOrigin(origin) {
  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin) return [];
  const vault = readVault();
  let touched = false;
  const results = [];
  for (const entry of vault.entries) {
    if (entry.origin !== cleanOrigin) continue;
    const payload = decryptEntry(entry);
    if (!payload) continue;
    results.push({ id: entry.id, username: payload.username, password: payload.password });
    // Autofill runs on every page load; avoid rewriting the vault each time.
    if (!entry.lastUsedAt || Date.now() - entry.lastUsedAt > 5 * 60_000) {
      entry.lastUsedAt = Date.now();
      touched = true;
    }
  }
  if (touched) writeVault(vault);
  return results;
}

function hasEntry({ origin, username, password }) {
  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin || typeof password !== 'string' || !password) return false;
  const vault = readVault();
  return vault.entries.some((entry) => {
    if (entry.origin !== cleanOrigin) return false;
    const payload = decryptEntry(entry);
    return Boolean(payload && payload.username === String(username ?? '') && payload.password === password);
  });
}

function saveEntry({ origin, username, password }) {
  const cleanOrigin = normalizeOrigin(origin);
  if (!cleanOrigin) return { ok: false, reason: 'invalid-origin' };
  if (!isAvailable()) return { ok: false, reason: 'unavailable' };
  if (readOnly) return { ok: false, reason: 'read-only' };
  const cleanUsername = String(username ?? '').slice(0, MAX_USERNAME);
  const cleanPassword = String(password ?? '').slice(0, MAX_PASSWORD);
  if (!cleanPassword) return { ok: false, reason: 'empty-password' };

  const vault = readVault();
  if (readOnly) return { ok: false, reason: 'read-only' };
  const now = Date.now();
  const secret = safeStorage.encryptString(
    JSON.stringify({ username: cleanUsername, password: cleanPassword }),
  ).toString('base64');
  const existing = vault.entries.find(
    (entry) => entry.origin === cleanOrigin && decryptEntry(entry)?.username === cleanUsername,
  );
  if (existing) {
    existing.secret = secret;
    existing.updatedAt = now;
    existing.lastUsedAt = now;
  } else {
    vault.entries.push({
      id: crypto.randomUUID(),
      origin: cleanOrigin,
      secret,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    });
    if (vault.entries.length > MAX_ENTRIES) {
      vault.entries.sort((left, right) => (left.lastUsedAt ?? left.updatedAt) - (right.lastUsedAt ?? right.updatedAt));
      vault.entries.splice(0, vault.entries.length - MAX_ENTRIES);
    }
  }
  if (!writeVault(vault)) return { ok: false, reason: loadError || 'write-failed' };
  return { ok: true, entries: listEntries() };
}

function revealEntry(id) {
  const vault = readVault();
  const entry = vault.entries.find((item) => item.id === id);
  if (!entry) return null;
  const payload = decryptEntry(entry);
  if (!payload) return null;
  return { id: entry.id, origin: entry.origin, ...payload };
}

function removeEntry(id) {
  if (readOnly) return { ok: false, reason: 'read-only', entries: listEntries() };
  const vault = readVault();
  if (readOnly) return { ok: false, reason: 'read-only', entries: listEntries() };
  const next = vault.entries.filter((entry) => entry.id !== id);
  if (next.length === vault.entries.length) return { ok: true, entries: listEntries() };
  if (!writeVault({ ...vault, entries: next })) {
    return { ok: false, reason: loadError || 'write-failed', entries: listEntries() };
  }
  return { ok: true, entries: listEntries() };
}

function clearEntries() {
  readVault();
  if (readOnly) return { ok: false, reason: 'read-only', entries: listEntries() };
  if (!writeVault(emptyVault())) {
    return { ok: false, reason: loadError || 'write-failed', entries: listEntries() };
  }
  return { ok: true, entries: [] };
}

module.exports = {
  isAvailable,
  status,
  listEntries,
  listForOrigin,
  entriesForOrigin,
  hasEntry,
  saveEntry,
  revealEntry,
  removeEntry,
  clearEntries,
};
