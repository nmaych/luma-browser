const { app, net } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { installerFileName, isNewerVersion, legacyInstallerFileName, parseVersion } = require('./versioning.cjs');

const REPO = 'nmaych/luma-browser';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// The public releases page lists published releases only (drafts stay hidden)
// and is not subject to the REST API's unauthenticated rate limit, which
// answers 403 once the shared IP has spent its hourly quota.
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
// Releases are the only trusted source; a compromised redirect should never be
// able to point the installer somewhere else.
const ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
];
// Downloads can stall on networks where github.com is unreachable. The mirror
// only ever proxies the official asset URL and its output is checked against
// the SHA256 GitHub publishes for that asset.
const MIRROR_PREFIX = 'https://gh-proxy.com/';
const DOWNLOAD_LINES = [
  { id: 'github', label: 'GitHub 直连' },
  { id: 'mirror', label: '镜像加速' },
];
const STORE_FILE = 'update.json';
const PREVIOUS_DIR = 'previous';
const LOG_LIMIT_BYTES = 512 * 1024;
const DEFAULT_PREFS = { autoDownload: true, applyOnQuit: true };

function isTrustedDownloadUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function createUpdater({ currentVersion, onState, paths }) {
  const updateDir = paths?.update ?? path.join(app.getPath('userData'), 'updates');
  const packagesDir = paths?.packages ?? path.join(updateDir, 'packages');
  const previousDir = path.join(packagesDir, PREVIOUS_DIR);
  const logPath = paths?.log ?? path.join(updateDir, 'update.log');
  const storePath = path.join(updateDir, STORE_FILE);

  let state = {
    status: 'idle',
    currentVersion,
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    error: null,
    releaseUrl: `https://github.com/${REPO}/releases`,
    line: null,
    lines: [],
    prefs: { ...DEFAULT_PREFS },
    pending: null,
    lastCheckedAt: null,
    updateDir,
    logPath,
  };
  /** @type {string | null} */
  let installerPath = null;
  /** @type {{ version: string, url: string, size: number, notes: string, releaseUrl: string } | null} */
  let latestRelease = null;
  let downloadRequest = null;
  let checking = false;
  let downloading = false;
  // Guards the quit path: an immediate install already spawned the installer,
  // and a second silent run during `will-quit` would race it.
  let installerLaunched = false;
  /**
   * The user asked to install now. The installer is started from `will-quit`
   * instead of straight away: quitting first lets the renderer flush tabs and
   * history, while the NSIS silent install kills a still-running app outright.
   */
  let installRequested = false;

  /** @type {{ lastCheckedAt: number, prefs: typeof DEFAULT_PREFS, pending: any, previous: any }} */
  let store = {
    lastCheckedAt: 0,
    prefs: { ...DEFAULT_PREFS },
    pending: null,
    previous: null,
  };

  const publish = (patch = {}) => {
    state = { ...state, ...patch };
    try {
      onState?.({ ...state });
    } catch {
      // A closed window must not break the updater.
    }
    return { ...state };
  };

  const userAgent = `Luma-Browser/${currentVersion}`;

  /**
   * Chrome keeps a plain-text update log next to its downloaded packages; it is
   * the only way to explain an update that silently did nothing.
   */
  function log(message) {
    try {
      fs.mkdirSync(updateDir, { recursive: true });
      try {
        if (fs.statSync(logPath).size > LOG_LIMIT_BYTES) fs.renameSync(logPath, `${logPath}.1`);
      } catch {
        // No log yet.
      }
      fs.appendFileSync(logPath, `${new Date().toISOString()} [${currentVersion}] ${message}\n`, 'utf8');
    } catch {
      // Logging is best effort and must never break an update.
    }
  }

  function normalizePending(value) {
    if (!value || typeof value !== 'object') return null;
    const version = String(value.version ?? '').trim();
    if (!parseVersion(version)) return null;
    const file = typeof value.file === 'string' ? value.file : '';
    if (!file) return null;
    return {
      version,
      file,
      size: Number(value.size) || 0,
      sha256: typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : null,
      downloadedAt: Number(value.downloadedAt) || 0,
    };
  }

  function readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid store');
      const prefs = parsed.prefs && typeof parsed.prefs === 'object' ? parsed.prefs : {};
      return {
        lastCheckedAt: Number(parsed.lastCheckedAt) || 0,
        prefs: {
          autoDownload: prefs.autoDownload !== false,
          applyOnQuit: prefs.applyOnQuit !== false,
        },
        pending: normalizePending(parsed.pending),
        previous: normalizePending(parsed.previous),
      };
    } catch {
      return { lastCheckedAt: 0, prefs: { ...DEFAULT_PREFS }, pending: null, previous: null };
    }
  }

  function writeStore() {
    try {
      fs.mkdirSync(updateDir, { recursive: true });
      const temp = `${storePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ schema: 1, ...store }, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, storePath);
    } catch (error) {
      log(`cannot persist update state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function removeFile(target) {
    try {
      if (target && fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // A locked file is retried on the next launch.
    }
  }

  /**
   * Startup reconciliation, the equivalent of Chrome's "Last Version" check:
   * a pending installer for a version that is already running is deleted, so a
   * failed or interrupted update never re-installs the same build forever.
   */
  function reconcile() {
    store = readStore();
    state = { ...state, prefs: { ...store.prefs }, lastCheckedAt: store.lastCheckedAt || null };
    if (store.pending) {
      const alreadyApplied = !isNewerVersion(store.pending.version, currentVersion);
      if (alreadyApplied || !fs.existsSync(store.pending.file)) {
        removeFile(store.pending.file);
        if (alreadyApplied) log(`pending ${store.pending.version} is already applied`);
        store.pending = null;
        writeStore();
      }
    }
    if (store.previous && !fs.existsSync(store.previous.file)) store.previous = null;
    if (store.pending && isNewerVersion(store.pending.version, currentVersion)) {
      // A package downloaded in a previous session keeps the “restart and
      // install” affordance instead of looking like nothing happened.
      installerPath = store.pending.file;
      publish({
        status: 'downloaded',
        version: store.pending.version,
        percent: 100,
        transferred: store.pending.size,
        total: store.pending.size,
        pending: store.pending,
        prefs: { ...store.prefs },
        lastCheckedAt: store.lastCheckedAt || null,
      });
      return;
    }
    publish({ pending: store.pending, prefs: { ...store.prefs }, lastCheckedAt: store.lastCheckedAt || null });
  }

  function prunePackages(keepPaths) {
    try {
      for (const entry of fs.readdirSync(packagesDir)) {
        const target = path.join(packagesDir, entry);
        if (entry === PREVIOUS_DIR) continue;
        if (keepPaths.includes(target)) continue;
        removeFile(target);
      }
    } catch {
      // Nothing downloaded yet.
    }
  }

  /** Resolves the latest release from the HTML releases page. */
  async function releaseFromPage() {
    const response = await net.fetch(RELEASES_PAGE, {
      headers: { Accept: 'text/html', 'User-Agent': userAgent },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    // Releases are listed newest first, so the first tag link is the latest.
    const match = /\/releases\/tag\/([^"'?#/]+)/.exec(html);
    if (!match) return { release: null, fallback: false };
    const tag = decodeURIComponent(match[1]);
    const version = tag.replace(/^v/i, '');
    if (!parseVersion(version)) return { release: null, fallback: true };
    // Releases before 1.14 shipped `Luma-Browser-Setup-<version>.exe`; probe both
    // names so an older install can still reach the newest package.
    const names = [installerFileName(version), legacyInstallerFileName(version)];
    for (const name of names) {
      const url = `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${name}`;
      if (!isTrustedDownloadUrl(url)) continue;
      const head = await net.fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': userAgent },
      });
      if (!head.ok) continue;
      return {
        release: {
          version,
          url,
          name,
          size: Number(head.headers.get('content-length')) || 0,
          notes: '',
          releaseUrl: `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`,
        },
        fallback: false,
      };
    }
    return { release: null, fallback: true };
  }

  /** Fallback for a changed download name: the REST API lists the assets. */
  async function releaseFromApi() {
    const response = await net.fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': userAgent,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    if (!release || release.draft || release.prerelease) return null;
    const version = String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
    if (!parseVersion(version)) return null;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((item) => /^Luma-?Browser-Setup-.*\.exe$/i.test(item?.name || ''))
      ?? assets.find((item) => /\.exe$/i.test(item?.name || ''));
    if (!asset || !isTrustedDownloadUrl(asset.browser_download_url)) return null;
    return {
      version,
      url: asset.browser_download_url,
      name: asset.name,
      size: Number(asset.size) || 0,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : state.releaseUrl,
    };
  }

  async function fetchLatestRelease() {
    try {
      const result = await releaseFromPage();
      if (result.release) return result.release;
      if (!result.fallback) return null;
    } catch {
      // A blocked or renamed page falls through to the REST API.
    }
    return releaseFromApi();
  }

  function installerFileFor(version) {
    return path.join(packagesDir, installerFileName(version));
  }

  /** SHA256 GitHub publishes for the release asset, used to vet mirror copies. */
  async function assetDigest(version) {
    try {
      const response = await net.fetch(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': userAgent,
        },
      });
      if (!response.ok) return null;
      const release = await response.json();
      const tag = String(release?.tag_name || release?.name || '').replace(/^v/i, '').trim();
      if (tag !== version) return null;
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((item) => /^Luma-?Browser-Setup-.*\.exe$/i.test(item?.name || ''));
      const digest = String(asset?.digest || '');
      return /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7).toLowerCase() : null;
    } catch {
      return null;
    }
  }

  async function startDownload(release, lineId = 'github') {
    if (downloading) return { ...state };
    const line = DOWNLOAD_LINES.some((item) => item.id === lineId) ? lineId : 'github';
    if (!isTrustedDownloadUrl(release.url)) {
      return publish({ status: 'error', error: '下载地址不受信任' });
    }
    let expectedDigest = null;
    let url = release.url;
    if (line === 'mirror') {
      expectedDigest = await assetDigest(release.version);
      if (!expectedDigest) {
        return publish({ status: 'error', error: '无法获取安装包校验值，请改用 GitHub 直连' });
      }
      url = `${MIRROR_PREFIX}${release.url}`;
    }
    downloading = true;
    installerPath = installerFileFor(release.version);
    log(`downloading ${release.version} via ${line} -> ${installerPath}`);
    publish({
      status: 'downloading',
      version: release.version,
      releaseUrl: release.releaseUrl,
      line,
      lines: DOWNLOAD_LINES,
      percent: 0,
      transferred: 0,
      total: release.size,
      error: null,
    });

    return new Promise((resolve) => {
      let settled = false;
      const finish = (patch) => {
        if (settled) return;
        settled = true;
        downloading = false;
        downloadRequest = null;
        resolve(publish(patch));
      };

      let request;
      try {
        fs.mkdirSync(packagesDir, { recursive: true });
        request = net.request({ url, method: 'GET', redirect: 'follow' });
      } catch (error) {
        log(`download failed: ${error instanceof Error ? error.message : String(error)}`);
        finish({ status: 'error', error: error instanceof Error ? error.message : 'download failed' });
        return;
      }
      downloadRequest = request;

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log(`download rejected: HTTP ${response.statusCode}`);
          finish({ status: 'error', error: `HTTP ${response.statusCode}` });
          try {
            request.abort();
          } catch {
            // Already closed.
          }
          return;
        }
        const total = Number(response.headers['content-length']) || release.size || 0;
        let transferred = 0;
        let lastBroadcast = 0;
        const hasher = crypto.createHash('sha256');
        const file = fs.createWriteStream(installerPath);
        file.on('error', (error) => {
          finish({ status: 'error', error: error.message });
          try {
            request.abort();
          } catch {
            // Already closed.
          }
        });
        response.on('data', (chunk) => {
          try {
            file.write(chunk);
          } catch {
            return;
          }
          hasher.update(chunk);
          transferred += chunk.length;
          const now = Date.now();
          if (now - lastBroadcast > 300) {
            lastBroadcast = now;
            publish({
              status: 'downloading',
              transferred,
              total,
              percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
            });
          }
        });
        response.on('end', () => {
          file.end(() => {
            if (!installerPath || !fs.existsSync(installerPath)) {
              finish({ status: 'error', error: 'download incomplete' });
              return;
            }
            const digest = hasher.digest('hex');
            if (expectedDigest && digest !== expectedDigest) {
              removeFile(installerPath);
              log(`digest mismatch for ${release.version}; package deleted`);
              finish({ status: 'error', error: '安装包校验失败，文件已删除，请更换线路重试' });
              return;
            }
            // Keep exactly one previous package: that is the rollback target if
            // the new build misbehaves, mirroring how Chrome retains its last
            // working version directory.
            if (store.pending && store.pending.file !== installerPath) {
              try {
                fs.mkdirSync(previousDir, { recursive: true });
                const rollback = path.join(previousDir, path.basename(store.pending.file));
                fs.renameSync(store.pending.file, rollback);
                store.previous = { ...store.pending, file: rollback };
              } catch {
                // A missing previous package only costs rollback, not the update.
              }
            }
            store.pending = {
              version: release.version,
              file: installerPath,
              size: fs.statSync(installerPath).size,
              sha256: digest,
              downloadedAt: Date.now(),
            };
            writeStore();
            prunePackages([installerPath]);
            log(`downloaded ${release.version} (${digest.slice(0, 12)}…)`);
            finish({
              status: 'downloaded',
              percent: 100,
              transferred: total || transferred,
              total: total || transferred,
              error: null,
              pending: store.pending,
            });
          });
        });
        response.on('aborted', () => finish({ status: 'error', error: 'download aborted' }));
        response.on('error', (error) => finish({ status: 'error', error: error.message }));
      });
      request.on('error', (error) => finish({ status: 'error', error: error.message }));
      request.end();
    });
  }

  async function check({ autoDownload = false } = {}) {
    if (!app.isPackaged) {
      return publish({ status: 'error', error: '仅安装版支持自动更新' });
    }
    if (checking || downloading) return { ...state };
    checking = true;
    publish({ status: 'checking', error: null, percent: 0 });
    try {
      const release = await fetchLatestRelease();
      store.lastCheckedAt = Date.now();
      writeStore();
      if (!release) {
        // GitHub answered but has no published release; the installed build is
        // already the newest one that can be distributed.
        latestRelease = null;
        log('check: no published release');
        return publish({ status: 'not-available', version: null, lines: [], line: null, error: null, lastCheckedAt: store.lastCheckedAt });
      }
      if (!isNewerVersion(release.version, currentVersion)) {
        latestRelease = null;
        log(`check: up to date (${currentVersion})`);
        return publish({
          status: 'not-available',
          version: release.version,
          releaseUrl: release.releaseUrl,
          lines: [],
          line: null,
          error: null,
          lastCheckedAt: store.lastCheckedAt,
        });
      }
      latestRelease = release;
      log(`check: ${release.version} available`);
      publish({
        status: 'available',
        version: release.version,
        releaseUrl: release.releaseUrl,
        total: release.size,
        percent: 0,
        lines: DOWNLOAD_LINES,
        line: null,
        error: null,
        lastCheckedAt: store.lastCheckedAt,
      });
      if (autoDownload) return await startDownload(release);
      return { ...state };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`check failed: ${message}`);
      const friendly = message === 'fetch failed'
        ? '更新服务器连接失败'
        : /^HTTP 403\b/.test(message)
          ? '更新服务器繁忙，请稍后再试'
          : message;
      return publish({ status: 'error', error: friendly });
    } finally {
      checking = false;
    }
  }

  function download(line = 'github') {
    if (downloading) return Promise.resolve({ ...state });
    if (state.status === 'downloaded') return Promise.resolve({ ...state });
    const lineId = DOWNLOAD_LINES.some((item) => item.id === line) ? line : 'github';
    if (!state.version) return check({ autoDownload: false });
    if (latestRelease && latestRelease.version === state.version) {
      return startDownload(latestRelease, lineId);
    }
    return fetchLatestRelease()
      .then((release) => {
        if (!release) return publish({ status: 'error', error: '未找到可下载的安装包' });
        latestRelease = release;
        return startDownload(release, lineId);
      })
      .catch((error) => publish({ status: 'error', error: error?.message || '下载失败' }));
  }

  function launchInstaller({ relaunch }) {
    // electron-builder's installer relaunches the app after a silent install
    // when it is started with --force-run, so the window comes back by itself
    // once the files are replaced.
    const args = relaunch ? ['/S', '--force-run'] : ['/S'];
    // A silent install otherwise uses the installer's default per-user folder.
    // Users who picked another drive (or run a copied build) would keep the old
    // files and only gain a second copy under %LOCALAPPDATA%, which looks like
    // a failed install. NSIS reads /D as the rest of the command line and does
    // not accept a quoted value, so the arguments are passed verbatim and /D
    // comes last.
    const installDir = app.isPackaged ? path.dirname(app.getPath('exe')) : '';
    if (installDir) args.push(`/D=${installDir}`);
    const child = spawn(installerPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: Boolean(installDir),
    });
    child.unref();
    installerLaunched = true;
  }

  function install() {
    if (!app.isPackaged || state.status !== 'downloaded') return false;
    if (!installerPath || !fs.existsSync(installerPath)) {
      publish({ status: 'error', error: '安装包已被删除，请重新下载' });
      return false;
    }
    log(`installing ${state.version} after quitting`);
    installRequested = true;
    // Leave through the normal quit path so the profile is written before the
    // installer replaces the binaries.
    setTimeout(() => app.quit(), 150);
    return true;
  }

  /**
   * Sogou's QBDelayUpdate applies a downloaded build when the browser closes.
   * Doing the same here means the 118 MB package is fetched in the background
   * and the swap happens while no Luma process holds the locked binaries.
   */
  function installOnQuit() {
    if (!app.isPackaged || installerLaunched) return false;
    if (installRequested) {
      installRequested = false;
      try {
        log(`installing ${state.version} now`);
        launchInstaller({ relaunch: true });
        return true;
      } catch (error) {
        log(`install failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
    const pending = store.pending;
    if (!pending || !store.prefs.applyOnQuit) return false;
    if (!isNewerVersion(pending.version, currentVersion)) return false;
    if (!fs.existsSync(pending.file)) return false;
    installerPath = pending.file;
    try {
      log(`installing ${pending.version} on quit`);
      launchInstaller({ relaunch: false });
      return true;
    } catch (error) {
      log(`deferred install failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  function setPrefs(patch) {
    const next = { ...store.prefs };
    if (patch && typeof patch.autoDownload === 'boolean') next.autoDownload = patch.autoDownload;
    if (patch && typeof patch.applyOnQuit === 'boolean') next.applyOnQuit = patch.applyOnQuit;
    if (next.autoDownload === store.prefs.autoDownload && next.applyOnQuit === store.prefs.applyOnQuit) {
      return { ...state };
    }
    store.prefs = next;
    writeStore();
    log(`preferences autoDownload=${next.autoDownload} applyOnQuit=${next.applyOnQuit}`);
    publish({ prefs: { ...next } });
    // Turning background downloads on while a newer build is already known
    // should start the download without waiting for the next check.
    if (next.autoDownload && state.status === 'available' && latestRelease) {
      void startDownload(latestRelease);
    }
    return { ...state };
  }

  function getState() {
    return { ...state };
  }

  reconcile();

  return { check, download, install, installOnQuit, setPrefs, getState, reconcile };
}

module.exports = { createUpdater, installerFileName };
