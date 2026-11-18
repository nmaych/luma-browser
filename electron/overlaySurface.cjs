const path = require('node:path');
const { WebContentsView } = require('electron');

/**
 * HTML popovers (menus, the address dropdown, context menus) normally cannot be
 * seen over a WebContentsView page: the native page is a sibling painted above
 * the React layer. Parking the page and showing a screenshot used to solve
 * that, but a screenshot is stale and a live stream of frames is expensive and
 * blurry. Instead the popover DOM is mirrored into a transparent view stacked
 * on top of the page, so the real page stays sharp and keeps running.
 */

// The view is padded so menu shadows are not clipped by its edge. The padding
// doubles as a click target that dismisses the popover.
const SHADOW = 24;

const BASE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8">
<style id="luma-surface-css"></style>
<style>
html, body, #luma-surface-root { margin: 0; padding: 0; overflow: hidden; -webkit-user-select: none; }
/* The app stylesheet paints a page background; on this transparent surface it
   would show up as a white frame around every popover. */
html, body, #luma-surface-root, :root { background: transparent !important; }
#luma-surface-root { position: absolute; }
#luma-surface-root > * {
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  right: auto !important;
  bottom: auto !important;
  width: 100% !important;
  max-height: 100% !important;
  margin: 0 !important;
  transform: none !important;
  animation: none !important;
}
</style>
</head>
<body>
<div id="luma-surface-root"></div>
<script>
(() => {
  const root = document.getElementById('luma-surface-root');
  const sheet = document.getElementById('luma-surface-css');
  window.lumaOverlay.onRender((data) => {
    if (!data) return;
    document.documentElement.dataset.theme = data.theme || 'light';
    if (typeof data.css === 'string') sheet.textContent = data.css;
    root.style.cssText = 'left:' + data.x + 'px;top:' + data.y + 'px;width:' + data.width + 'px;height:' + data.height + 'px';
    // Repainting identical markup would detach the node under a mousedown and
    // swallow the click, so only touch the DOM when something really changed.
    if (root.__html !== data.html) {
      root.__html = data.html;
      root.innerHTML = data.html || '';
    }
  });
  // The clone has the same element tree as the React popover, so a child-index
  // path from the popover root identifies the element whose handler must run.
  const pathOf = (node) => {
    const start = root.firstElementChild;
    if (!start) return null;
    const steps = [];
    let current = node;
    while (current && current !== start) {
      const parent = current.parentElement;
      if (!parent) return null;
      steps.unshift([...parent.children].indexOf(current));
      current = parent;
    }
    return current === start ? steps : null;
  };
  // Icon clicks land on <svg>/<path>, which carry no handler of their own;
  // resolve the nearest interactive ancestor inside the mirrored popover.
  const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [role="option"]';
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target === document.body || target === root) {
      window.lumaOverlay.onDismiss();
      return;
    }
    const hit = target.closest(INTERACTIVE);
    const clickTarget = hit && root.contains(hit) ? hit : target;
    const steps = pathOf(clickTarget);
    if (steps && steps.length > 0) window.lumaOverlay.onClick(steps);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    window.lumaOverlay.onKey('Escape');
  });
})();
</script>
</body>
</html>`;

/** @type {Map<Electron.BrowserWindow, { view: Electron.WebContentsView, visible: boolean, loaded: Promise<void> | null, activeId: string }>} */
const surfaces = new Map();
/** overlay webContents id -> owning window */
const owners = new Map();

function send(win, channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function createSurface(win) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const entry = { view, visible: false, loaded: null, activeId: '' };
  surfaces.set(win, entry);
  owners.set(view.webContents.id, win);
  win.contentView.addChildView(view);

  // Menus are transient; losing focus or minimizing must dismiss them.
  const dismiss = () => {
    if (!entry.visible) return;
    hideSurface(win);
    send(win, 'overlay:outside');
  };
  win.on('blur', dismiss);
  win.on('minimize', dismiss);
  win.on('hide', dismiss);
  win.once('closed', () => {
    surfaces.delete(win);
    owners.delete(view.webContents.id);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  });
  return entry;
}

function surfaceFor(win) {
  return surfaces.get(win) ?? createSurface(win);
}

function isSurfaceVisible(win) {
  return Boolean(surfaces.get(win)?.visible);
}

async function showSurface(win, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const rect = payload?.rect ?? {};
  const x = Math.round(Number(rect.x));
  const y = Math.round(Number(rect.y));
  const width = Math.round(Number(rect.width));
  const height = Math.round(Number(rect.height));
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return false;

  const entry = surfaceFor(win);
  const view = entry.view;
  if (view.webContents.isDestroyed()) return false;
  // Page views are attached above the React layer; re-adding the surface puts
  // it back on top after a tab switch created a new page view. Only touch the
  // z-order when needed: re-adding the focused view would break the click that
  // is currently being delivered to it.
  const siblings = win.contentView.children;
  if (siblings[siblings.length - 1] !== view) {
    win.contentView.removeChildView(view);
    win.contentView.addChildView(view);
  }
  view.setBounds({ x: x - SHADOW, y: y - SHADOW, width: width + SHADOW * 2, height: height + SHADOW * 2 });

  if (!entry.loaded) {
    entry.loaded = view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BASE_HTML)}`)
      .catch(() => undefined);
  }
  await entry.loaded;
  if (view.webContents.isDestroyed()) return false;
  entry.activeId = String(payload?.id ?? '');
  view.webContents.send('overlay:render', {
    html: typeof payload?.html === 'string' ? payload.html : '',
    css: typeof payload?.css === 'string' ? payload.css : undefined,
    theme: typeof payload?.theme === 'string' ? payload.theme : 'light',
    x: SHADOW,
    y: SHADOW,
    width,
    height,
  });
  view.setVisible(true);
  entry.visible = true;
  return true;
}

/**
 * Hides the surface. When an id is given only that owner may hide it, so a
 * closing popover cannot tear down another one that opened meanwhile.
 */
function hideSurface(win, id) {
  const entry = surfaces.get(win);
  if (!entry) return;
  if (id !== undefined && entry.activeId && String(id) !== entry.activeId) return;
  entry.activeId = '';
  if (!entry.visible) return;
  entry.visible = false;
  if (!entry.view.webContents.isDestroyed()) entry.view.setVisible(false);
}

/** A click in the page means the user clicked away from the popover. */
function dismissForPageClick(win) {
  const entry = surfaces.get(win);
  if (!entry || !entry.visible) return;
  hideSurface(win);
  send(win, 'overlay:outside');
}

function wireIpc(ipcMain, BrowserWindow) {
  const windowOf = (sender) => {
    const viaSurface = owners.get(sender.id);
    if (viaSurface && !viaSurface.isDestroyed()) return viaSurface;
    return BrowserWindow.fromWebContents(sender);
  };

  ipcMain.on('overlay:show', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    void showSurface(win, payload);
  });
  ipcMain.on('overlay:hide', (event, id) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) hideSurface(win, id);
  });
  // The click path comes from the mirrored DOM; running it in the real
  // renderer keeps every React handler (and its state) authoritative.
  ipcMain.on('overlay:click', (event, steps) => {
    const win = windowOf(event.sender);
    if (!win || !Array.isArray(steps)) return;
    send(win, 'overlay:click', steps.map(Number));
    win.webContents.focus();
  });
  ipcMain.on('overlay:key', (event, key) => {
    const win = windowOf(event.sender);
    if (!win) return;
    win.webContents.focus();
    if (key === 'Escape') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }
  });
  ipcMain.on('overlay:dismiss', (event) => {
    const win = windowOf(event.sender);
    if (!win) return;
    hideSurface(win);
    send(win, 'overlay:outside');
  });
}

module.exports = { wireIpc, dismissForPageClick, isSurfaceVisible, hideSurface };
