const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Directory layout, modelled on what Chrome and SogouExplorer actually ship.
 *
 * Chrome 157 installs the binary into `Application/<version>/` and keeps every
 * byte of browser state under `%LOCALAPPDATA%\Google\Chrome\User Data`, with the
 * updater and its cache next to it in `%LOCALAPPDATA%\Google\Update`.
 * SogouExplorer does the same with `%LOCALAPPDATA%\SogouExplorer\...`.
 *
 * Luma therefore keeps two siblings under one vendor folder:
 *
 *   %LOCALAPPDATA%\Luma Browser\User Data\   profile, cookies, passwords
 *   %LOCALAPPDATA%\Luma Browser\Update\      downloaded installers + update.log
 *
 * The program files stay wherever the user installed the app, so upgrading never
 * touches the profile and a roaming profile never syncs a multi-gigabyte cache.
 */
const VENDOR_DIR = 'Luma Browser';
const USER_DATA_DIR = 'User Data';
const UPDATE_DIR = 'Update';
const PACKAGES_DIR = 'packages';
const EXTENSIONS_DIR = 'Extensions';
const UPDATE_LOG = 'update.log';
const LAYOUT_MARKER = 'layout.json';
const LAYOUT_SCHEMA = 2;

// Chrome-family rebuildable caches. Copying them would add hundreds of megabytes
// to the one-time migration for data the browser regenerates anyway.
const CACHE_DIRS = new Set([
  'cache',
  'code cache',
  'gpucache',
  'grshadercache',
  'shadercache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'gpupersistentcache',
  'crashpad',
  'browsermetrics',
  'component crx cache',
]);

function localAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function roamingAppDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function resolveAppPaths({ localAppData = localAppDataDir() } = {}) {
  const appRoot = path.join(localAppData, VENDOR_DIR);
  const update = path.join(appRoot, UPDATE_DIR);
  return {
    appRoot,
    userData: path.join(appRoot, USER_DATA_DIR),
    update,
    packages: path.join(update, PACKAGES_DIR),
    log: path.join(update, UPDATE_LOG),
    extensions: path.join(appRoot, EXTENSIONS_DIR),
    marker: path.join(appRoot, USER_DATA_DIR, LAYOUT_MARKER),
  };
}

function hasProfileContent(directory) {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function legacyProfileCandidates() {
  const roaming = roamingAppDataDir();
  // `Luma Browser` is the productName folder Electron used through 1.13.x; the
  // lower-cased package name covers unpackaged runs started with `npm start`.
  return [path.join(roaming, VENDOR_DIR), path.join(roaming, 'luma-browser')];
}

function writeLayoutMarker(target, migratedFrom) {
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, LAYOUT_MARKER),
      `${JSON.stringify({ schema: LAYOUT_SCHEMA, migratedFrom: migratedFrom ?? null, migratedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // The marker only prevents a second migration attempt; failing to write it
    // must not block startup.
  }
}

function shouldSkipEntry(root, entry) {
  const relative = path.relative(root, entry);
  if (!relative) return false;
  return relative
    .split(path.sep)
    .some((part) => CACHE_DIRS.has(part.toLowerCase()));
}

/**
 * Moves the pre-1.14 profile out of roaming AppData. A rename is instant because
 * both roots live on the same volume; the copy fallback exists for profiles that
 * span drives or hold locked files, and it leaves the original untouched.
 */
function migrateLegacyProfile(target, log = () => {}) {
  if (fs.existsSync(path.join(target, LAYOUT_MARKER))) {
    return { migrated: false, reason: 'already-migrated' };
  }
  const legacy = legacyProfileCandidates().find(
    (candidate) => candidate !== target && hasProfileContent(candidate),
  );
  if (!legacy) {
    writeLayoutMarker(target, null);
    return { migrated: false, reason: 'no-legacy' };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Windows cannot rename a directory onto an existing one, and an earlier
    // attempt may have left an empty shell behind.
    try {
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    } catch {
      // Target does not exist yet, which is the normal case.
    }
    fs.renameSync(legacy, target);
    writeLayoutMarker(target, legacy);
    log(`[paths] moved profile ${legacy} -> ${target}`);
    return { migrated: true, method: 'move', from: legacy };
  } catch (error) {
    const renameError = error instanceof Error ? error.message : String(error);
    try {
      fs.cpSync(legacy, target, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter: (entry) => !shouldSkipEntry(legacy, entry),
      });
      writeLayoutMarker(target, legacy);
      log(`[paths] copied profile ${legacy} -> ${target} (rename failed: ${renameError})`);
      return { migrated: true, method: 'copy', from: legacy };
    } catch (copyError) {
      const message = copyError instanceof Error ? copyError.message : String(copyError);
      log(`[paths] profile migration failed: ${message}`);
      return { migrated: false, reason: 'failed', error: message };
    }
  }
}

function ensureUpdateDirs(paths) {
  for (const directory of [paths.update, paths.packages, paths.extensions]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      // Read-only installs fall back to the temp directory in the updater.
    }
  }
}

/**
 * Points Electron at the Chrome-style profile directory. An explicit
 * `--user-data-dir` (tests, portable runs, `LUMA_USER_DATA_DIR`) always wins so a
 * caller can sandbox the profile completely.
 */
function configureUserData(app, { log = () => {}, localAppData } = {}) {
  const paths = resolveAppPaths(localAppData ? { localAppData } : undefined);
  const overridden = app.commandLine.hasSwitch('user-data-dir') || Boolean(process.env.LUMA_USER_DATA_DIR);
  if (overridden) {
    const userData = process.env.LUMA_USER_DATA_DIR || app.getPath('userData');
    if (process.env.LUMA_USER_DATA_DIR) app.setPath('userData', userData);
    ensureUpdateDirs(paths);
    return { ...paths, userData, overridden: true, migration: null };
  }
  try {
    fs.mkdirSync(paths.appRoot, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[paths] cannot create ${paths.appRoot}: ${message}`);
    ensureUpdateDirs(paths);
    return { ...paths, userData: app.getPath('userData'), overridden: false, migration: null };
  }
  // The profile directory must not exist yet: on Windows a rename onto an
  // existing directory fails, which would downgrade the move to a slow copy.
  const migration = migrateLegacyProfile(paths.userData, log);
  try {
    fs.mkdirSync(paths.userData, { recursive: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[paths] cannot create ${paths.userData}: ${message}`);
  }
  app.setPath('userData', paths.userData);
  ensureUpdateDirs(paths);
  return { ...paths, overridden: false, migration };
}

module.exports = {
  configureUserData,
  ensureUpdateDirs,
  localAppDataDir,
  migrateLegacyProfile,
  resolveAppPaths,
  LAYOUT_SCHEMA,
  UPDATE_LOG,
  USER_DATA_DIR,
  VENDOR_DIR,
  EXTENSIONS_DIR,
};
