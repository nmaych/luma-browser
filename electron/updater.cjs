const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = 'nmaych/luma-browser';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// Releases are the only trusted source; a compromised redirect should never be
// able to point the installer somewhere else.
const ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
];

function isTrustedDownloadUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

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

function createUpdater({ currentVersion, onState }) {
  let state = {
    status: 'idle',
    currentVersion,
    version: null,
    percent: 0,
    transferred: 0,
    total: 0,
    error: null,
    releaseUrl: `https://github.com/${REPO}/releases`,
  };
  /** @type {string | null} */
  let installerPath = null;
  let downloadRequest = null;
  let checking = false;
  let downloading = false;

  const publish = (patch = {}) => {
    state = { ...state, ...patch };
    try {
      onState?.({ ...state });
    } catch {
      // A closed window must not break the updater.
    }
    return { ...state };
  };

  async function fetchLatestRelease() {
    const response = await net.fetch(RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Luma-Browser/${currentVersion}`,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const release = await response.json();
    if (!release || release.draft || release.prerelease) return null;
    const version = String(release.tag_name || release.name || '').replace(/^v/i, '').trim();
    if (!parseVersion(version)) return null;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((item) => /^Luma-Browser-Setup-.*\.exe$/i.test(item?.name || ''))
      ?? assets.find((item) => /\.exe$/i.test(item?.name || ''));
    if (!asset || !isTrustedDownloadUrl(asset.browser_download_url)) return null;
    return {
      version,
      url: asset.browser_download_url,
      size: Number(asset.size) || 0,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : state.releaseUrl,
    };
  }

  function installerFileFor(version) {
    const safeVersion = String(version).replace(/[^\d.]/g, '') || 'latest';
    return path.join(app.getPath('temp'), `Luma-Browser-Setup-${safeVersion}.exe`);
  }

  function startDownload(release) {
    if (downloading) return Promise.resolve({ ...state });
    downloading = true;
    installerPath = installerFileFor(release.version);
    publish({
      status: 'downloading',
      version: release.version,
      releaseUrl: release.releaseUrl,
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
        fs.mkdirSync(path.dirname(installerPath), { recursive: true });
        request = net.request({ url: release.url, method: 'GET', redirect: 'follow' });
      } catch (error) {
        finish({ status: 'error', error: error instanceof Error ? error.message : 'download failed' });
        return;
      }
      downloadRequest = request;

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
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
            finish({
              status: 'downloaded',
              percent: 100,
              transferred: total || transferred,
              total: total || transferred,
              error: null,
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

  async function check({ autoDownload = true } = {}) {
    if (!app.isPackaged) {
      return publish({ status: 'error', error: '仅安装版支持自动更新' });
    }
    if (checking || downloading) return { ...state };
    checking = true;
    publish({ status: 'checking', error: null, percent: 0 });
    try {
      const release = await fetchLatestRelease();
      if (!release) {
        return publish({ status: 'error', error: '无法读取更新信息' });
      }
      if (!isNewerVersion(release.version, currentVersion)) {
        return publish({ status: 'not-available', version: release.version, releaseUrl: release.releaseUrl, error: null });
      }
      publish({
        status: 'available',
        version: release.version,
        releaseUrl: release.releaseUrl,
        total: release.size,
        percent: 0,
        error: null,
      });
      if (autoDownload) return startDownload(release);
      return { ...state };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return publish({ status: 'error', error: message === 'fetch failed' ? '更新服务器连接失败' : message });
    } finally {
      checking = false;
    }
  }

  function download() {
    if (downloading) return Promise.resolve({ ...state });
    if (state.status === 'downloaded') return Promise.resolve({ ...state });
    if (!state.version) return check({ autoDownload: true });
    return fetchLatestRelease()
      .then((release) => (release ? startDownload(release) : publish({ status: 'error', error: '未找到可下载的安装包' })))
      .catch((error) => publish({ status: 'error', error: error?.message || '下载失败' }));
  }

  function install() {
    if (!app.isPackaged || state.status !== 'downloaded') return false;
    if (!installerPath || !fs.existsSync(installerPath)) {
      publish({ status: 'error', error: '安装包已被删除，请重新下载' });
      return false;
    }
    try {
      // The NSIS installer waits for running copies of the app; quitting after
      // handing it off lets it replace the files without a stuck window.
      const child = spawn(installerPath, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (error) {
      publish({ status: 'error', error: error instanceof Error ? error.message : '无法启动安装程序' });
      return false;
    }
    setTimeout(() => app.quit(), 600);
    return true;
  }

  function getState() {
    return { ...state };
  }

  return { check, download, install, getState };
}

module.exports = { createUpdater };