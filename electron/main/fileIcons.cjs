const fs = require('node:fs');
const path = require('node:path');
const peIcon = require('./peIcon.cjs');

/**
 * Icons for finished downloads.
 *
 * The list used to draw every row from a fixed extension table, so two `.exe`
 * files looked identical even though each one ships its own artwork. Here we
 * ask the platform for the icon the file actually carries (on Windows
 * `app.getFileIcon` reads the embedded icon, on macOS it reads the resource
 * fork) and only fall back to the extension table in the renderer when that
 * fails. Images additionally get a thumbnail, because the shell reports the
 * associated photo viewer for every one of them.
 *
 * Windows answers `app.getFileIcon` with its generic "application" artwork for
 * every executable, so PE resources are read directly first; the shell stays as
 * the fallback for formats we cannot parse.
 */

const THUMBNAIL_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico',
]);

/** Decoding a 60 MB raw photo to draw a 44 px square is not worth it. */
const THUMBNAIL_MAX_BYTES = 24 * 1024 * 1024;

/** Rendered at 44 px; 96 px stays sharp on 2x displays. */
const THUMBNAIL_EDGE = 96;

const CACHE_LIMIT = 256;

const cache = new Map();

function extensionOf(target) {
  const name = String(target || '');
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when the file's own pixels beat the shell's generic viewer icon. */
function prefersThumbnail(target) {
  return THUMBNAIL_EXTENSIONS.has(extensionOf(target));
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // Refresh insertion order so the Map doubles as an LRU list.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/** Drops a cached icon, e.g. after the file behind it was deleted. */
function forgetFileIcon(target) {
  if (typeof target !== 'string' || !target) return;
  cache.delete(path.normalize(target));
}

function scaleToFit(width, height, edge) {
  const scale = Math.min(edge / width, edge / height, 1);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function thumbnailFrom(nativeImage, target) {
  const image = nativeImage.createFromPath(target);
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  if (!size.width || !size.height) return null;
  const fitted = scaleToFit(size.width, size.height, THUMBNAIL_EDGE);
  const resized = fitted.width === size.width && fitted.height === size.height
    ? image
    : image.resize({ ...fitted, quality: 'good' });
  const dataUrl = resized.toDataURL();
  return dataUrl && dataUrl.length > 32 ? { dataUrl, kind: 'thumbnail' } : null;
}

async function shellIconFor(app, target) {
  try {
    const image = await app.getFileIcon(target, { size: 'large' });
    if (!image || image.isEmpty()) return null;
    const dataUrl = image.toDataURL();
    return dataUrl && dataUrl.length > 32 ? { dataUrl, kind: 'shell' } : null;
  } catch {
    return null;
  }
}

/**
 * The artwork an executable carries in its own resources. Windows reports a
 * generic application icon through the shell, so an installer's real logo has
 * to be read from the PE image instead.
 */
function embeddedIconFrom(nativeImage, target) {
  if (!peIcon.PE_EXTENSIONS.has(extensionOf(target))) return null;
  let image = null;
  try {
    const found = peIcon.iconFromFile(target);
    if (!found) return null;
    if (found.kind === 'png') {
      image = nativeImage.createFromBuffer(found.data);
    } else {
      const decoded = peIcon.dibToBgra(found.data);
      if (!decoded) return null;
      image = nativeImage.createFromBitmap(decoded.bitmap, { width: decoded.width, height: decoded.height });
    }
  } catch {
    return null;
  }
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  if (!size.width || !size.height) return null;
  const fitted = scaleToFit(size.width, size.height, THUMBNAIL_EDGE);
  const resized = fitted.width === size.width && fitted.height === size.height
    ? image
    : image.resize({ ...fitted, quality: 'best' });
  const dataUrl = resized.toDataURL();
  return dataUrl && dataUrl.length > 32 ? { dataUrl, kind: 'shell' } : null;
}

async function buildIcon(target, stat) {
  // Required lazily so the pure helpers above stay usable outside Electron.
  const { app, nativeImage } = require('electron');
  if (stat.size > 0 && stat.size <= THUMBNAIL_MAX_BYTES && prefersThumbnail(target)) {
    const thumbnail = thumbnailFrom(nativeImage, target);
    if (thumbnail) return thumbnail;
  }
  const embedded = embeddedIconFrom(nativeImage, target);
  if (embedded) return embedded;
  return shellIconFor(app, target);
}

/**
 * Resolves the icon the file itself carries.
 * @returns {Promise<{dataUrl: string, kind: 'thumbnail' | 'shell'} | null>}
 */
async function fileIconFor(target) {
  if (typeof target !== 'string' || !target || !path.isAbsolute(target)) return null;
  const key = path.normalize(target);
  let stat;
  try {
    stat = await fs.promises.stat(key);
  } catch {
    cache.delete(key);
    return null;
  }
  if (!stat.isFile()) return null;

  const stamp = `${stat.size}:${Math.round(stat.mtimeMs)}`;
  const cached = cacheGet(key);
  if (cached) {
    if (cached.stamp === stamp) return cached.icon;
    cache.delete(key);
  }

  let icon = null;
  try {
    icon = await buildIcon(key, stat);
  } catch {
    icon = null;
  }
  // Failures are cached too: a file the OS refuses to describe would otherwise
  // be retried on every progress tick.
  cacheSet(key, { stamp, icon });
  return icon;
}

module.exports = {
  extensionOf,
  prefersThumbnail,
  forgetFileIcon,
  fileIconFor,
  THUMBNAIL_EDGE,
  THUMBNAIL_MAX_BYTES,
};
