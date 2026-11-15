const { contextBridge, ipcRenderer } = require('electron');

const isIncognito = process.argv.includes('--luma-incognito');
const windowKind = process.argv.includes('--luma-window=tearoff') ? 'tearoff' : 'main';
const windowKeyArgument = process.argv.find((argument) => argument.startsWith('--luma-window-key='));
const windowKey = windowKeyArgument ? windowKeyArgument.slice('--luma-window-key='.length) : null;

let initialPayload = null;
if (windowKey) {
  try {
    // The payload is created together with this window, so a synchronous read
    // is the simplest way to hand it to the renderer before the first paint.
    initialPayload = ipcRenderer.sendSync('window:initial-tab', windowKey) || null;
  } catch {
    initialPayload = null;
  }
}
const initialTabs = initialPayload && Array.isArray(initialPayload.tabs)
  ? initialPayload.tabs
  : (initialPayload ? [initialPayload] : []);
const initialTab = initialTabs[0] ?? null;
const initialActiveId = initialPayload?.activeId ?? null;

contextBridge.exposeInMainWorld('lumaDesktop', {
  isDesktop: true,
  isIncognito,
  windowKind,
  initialTab,
  initialTabs,
  initialActiveId,
  platform: process.platform,
  getAppVersions: () => ipcRenderer.invoke('app:versions'),
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },
  openIncognito: () => ipcRenderer.send('window:open-incognito'),
  openDownloads: () => ipcRenderer.send('window:open-downloads'),
  tearOffTab: (tab, point) => ipcRenderer.invoke('window:tear-off-tab', tab, point),
  splitTabs: (tabs, activeId, bounds) => ipcRenderer.invoke('window:split-tabs', { tabs, activeId, bounds }),
  beginTabDrag: (payload) => ipcRenderer.invoke('window:begin-tab-drag', payload),
  updateTabDrag: (point) => ipcRenderer.invoke('window:update-tab-drag', point),
  showTabPreview: (payload) => ipcRenderer.invoke('tab-preview:show', payload),
  hideTabPreview: () => ipcRenderer.invoke('tab-preview:hide'),
  onTabDragStarted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tab-drag:started', listener);
    return () => ipcRenderer.removeListener('tab-drag:started', listener);
  },
  onTabDragMerged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tab-drag:merged', listener);
    return () => ipcRenderer.removeListener('tab-drag:merged', listener);
  },
  endTabDrag: (payload) => ipcRenderer.invoke('window:end-tab-drag', payload),
  moveWindow: (bounds) => ipcRenderer.invoke('window:move-to', bounds),
  mergeTab: (tab, point) => ipcRenderer.invoke('window:merge-tab', tab, point),
  onAdoptTab: (callback) => {
    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('window:adopt-tab', listener);
    return () => ipcRenderer.removeListener('window:adopt-tab', listener);
  },
  capturePage: (targetId, options) => ipcRenderer.invoke('page:capture', targetId, options),
  getCursorPoint: () => ipcRenderer.invoke('window:cursor-point'),
  getWindowId: () => ipcRenderer.invoke('window:id'),
  pageView: {
    ensure: (tabId, url, incognito) => ipcRenderer.invoke('page-view:ensure', tabId, url, incognito),
    attach: (tabId, bounds, incognito) => ipcRenderer.invoke('page-view:attach', tabId, bounds, incognito),
    move: (tabId, windowId, bounds, incognito) => ipcRenderer.invoke('page-view:move', tabId, windowId, bounds, incognito),
    detach: (tabId, incognito) => ipcRenderer.invoke('page-view:detach', tabId, incognito),
    setBounds: (tabId, bounds, incognito) => ipcRenderer.invoke('page-view:bounds', tabId, bounds, incognito),
    setVisible: (tabId, visible, incognito) => ipcRenderer.invoke('page-view:visible', tabId, visible, incognito),
    info: (tabId, incognito) => ipcRenderer.invoke('page-view:info', tabId, incognito),
    command: (tabId, name, args, incognito) => ipcRenderer.invoke('page-view:command', tabId, name, args, incognito),
    destroy: (tabId, incognito) => ipcRenderer.invoke('page-view:destroy', tabId, incognito),
  },
  onPageEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('page-view:event', listener);
    return () => ipcRenderer.removeListener('page-view:event', listener);
  },
  fetchFavicon: (url) => ipcRenderer.invoke('favicon:fetch', url),
  configureShortcuts: (shortcuts, bossKey) => ipcRenderer.invoke('settings:configure', { shortcuts, bossKey }),
  listDownloads: () => ipcRenderer.invoke('downloads:list'),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  pauseDownload: (id) => ipcRenderer.invoke('downloads:pause', id),
  resumeDownload: (id) => ipcRenderer.invoke('downloads:resume', id),
  resumeInterruptedDownload: (id) => ipcRenderer.invoke('downloads:resume-interrupted', id),
  removeDownload: (id) => ipcRenderer.invoke('downloads:remove', id),
  deleteDownloadFile: (id) => ipcRenderer.invoke('downloads:delete-file', id),
  clearDownloads: () => ipcRenderer.invoke('downloads:clear'),
  openDownload: (id) => ipcRenderer.invoke('downloads:open', id),
  showDownloadInFolder: (id) => ipcRenderer.invoke('downloads:show-in-folder', id),
  getDownloadDirectory: () => ipcRenderer.invoke('downloads:get-directory'),
  chooseDownloadDirectory: () => ipcRenderer.invoke('downloads:choose-directory'),
  resetDownloadDirectory: () => ipcRenderer.invoke('downloads:reset-directory'),
  saveUrl: (webContentsId, url) => ipcRenderer.invoke('downloads:save-url', webContentsId, url),
  importBookmarks: () => ipcRenderer.invoke('bookmarks:import-file'),
  exportBookmarks: (content, suggestedName) => ipcRenderer.invoke('bookmarks:export-file', content, suggestedName),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  printPage: (targetId) => ipcRenderer.invoke('page:print', targetId),
  savePagePdf: (targetId, suggestedName) => ipcRenderer.invoke('page:save-pdf', targetId, suggestedName),
  openDevTools: (targetId, bounds) => ipcRenderer.invoke('browser:open-devtools', targetId, bounds),
  resizeDevTools: (targetId, bounds) => ipcRenderer.invoke('browser:resize-devtools', targetId, bounds),
  setDevToolsVisible: (targetId, visible) => ipcRenderer.invoke('browser:set-devtools-visible', targetId, visible),
  closeDevTools: (targetId) => ipcRenderer.invoke('browser:close-devtools', targetId),
  getPermissions: () => ipcRenderer.invoke('permissions:overview'),
  setPermissionDefault: (category, policy) => ipcRenderer.invoke('permissions:set-default', category, policy),
  setSitePermission: (origin, category, policy) => ipcRenderer.invoke('permissions:set-site', origin, category, policy),
  removeSitePermission: (origin) => ipcRenderer.invoke('permissions:remove-site', origin),
  clearSitePermissions: () => ipcRenderer.invoke('permissions:clear-sites'),
  respondPermission: (requestId, decision) => ipcRenderer.invoke('permissions:respond', requestId, decision),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  clearSiteData: () => ipcRenderer.invoke('browser:clear-site-data'),
  getSiteData: () => ipcRenderer.invoke('browser:site-data-overview'),
  clearSiteDataForDomain: (domain) => ipcRenderer.invoke('browser:clear-site-data-for-domain', domain),
  clearCache: () => ipcRenderer.invoke('browser:clear-cache'),
  clearCookies: () => ipcRenderer.invoke('browser:clear-cookies'),
  getAdblockState: () => ipcRenderer.invoke('adblock:state'),
  setAdblockEnabled: (enabled) => ipcRenderer.invoke('adblock:set-enabled', enabled),
  setAdblockSite: (host, disabled) => ipcRenderer.invoke('adblock:set-site', host, disabled),
  updateAdblock: () => ipcRenderer.invoke('adblock:update'),
  translatePage: (texts, target) => ipcRenderer.invoke('page:translate', texts, target),
  getPasswordStatus: () => ipcRenderer.invoke('passwords:status'),
  listPasswords: () => ipcRenderer.invoke('passwords:list'),
  savePassword: (origin, username, password) => ipcRenderer.invoke('passwords:save', origin, username, password),
  deletePassword: (id) => ipcRenderer.invoke('passwords:delete', id),
  clearPasswords: () => ipcRenderer.invoke('passwords:clear'),
  revealPassword: (id) => ipcRenderer.invoke('passwords:reveal', id),
  getPasswordsForOrigin: (origin) => ipcRenderer.invoke('passwords:list-for-origin', origin),
  autofillTab: (webContentsId, entryId) => ipcRenderer.invoke('passwords:autofill-tab', webContentsId, entryId),
  hasPasswordCredential: (origin, username, password) => ipcRenderer.invoke('passwords:has-credential', origin, username, password),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onOpenInNewTab: (callback) => {
    const listener = (_event, url) => callback(String(url));
    ipcRenderer.on('browser:new-window', listener);
    return () => ipcRenderer.removeListener('browser:new-window', listener);
  },
  onShortcut: (callback) => {
    const listener = (_event, command) => callback(String(command));
    ipcRenderer.on('browser:shortcut', listener);
    return () => ipcRenderer.removeListener('browser:shortcut', listener);
  },
  onPageContextMenu: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:page-context-menu', listener);
    return () => ipcRenderer.removeListener('browser:page-context-menu', listener);
  },
  onDownloadsChanged: (callback) => {
    const listener = (_event, items) => callback(items);
    ipcRenderer.on('downloads:changed', listener);
    return () => ipcRenderer.removeListener('downloads:changed', listener);
  },
  onPermissionRequest: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('permissions:request', listener);
    return () => ipcRenderer.removeListener('permissions:request', listener);
  },
  onRenderGone: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:render-gone', listener);
    return () => ipcRenderer.removeListener('browser:render-gone', listener);
  },
  onUnresponsive: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:unresponsive', listener);
    return () => ipcRenderer.removeListener('browser:unresponsive', listener);
  },
  onAdblockBlocked: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('adblock:blocked', listener);
    return () => ipcRenderer.removeListener('adblock:blocked', listener);
  },
});
