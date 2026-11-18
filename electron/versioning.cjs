/**
 * Version helpers shared by the updater and its tests. Keeping them free of any
 * Electron import means they can be exercised outside a running app.
 */

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(value ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(remote, local) {
  const next = parseVersion(remote);
  const current = parseVersion(local);
  if (!next || !current) return false;
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return next[index] > current[index];
  }
  return false;
}

/** Installers are named `<product>-Setup-<version>-<arch>.exe`, as browsers do. */
function installerFileName(version, arch = 'x64') {
  const safeVersion = String(version).replace(/[^\d.]/g, '') || 'latest';
  return `Luma-Browser-Setup-${safeVersion}-${arch}.exe`;
}

// Releases before 1.14 shipped `Luma-Browser-Setup-<version>.exe` without the
// architecture suffix; the updater probes both names.
function legacyInstallerFileName(version) {
  const safeVersion = String(version).replace(/[^\d.]/g, '') || 'latest';
  return `Luma-Browser-Setup-${safeVersion}.exe`;
}

module.exports = { installerFileName, isNewerVersion, legacyInstallerFileName, parseVersion };
