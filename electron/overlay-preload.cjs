// Runs in the mirrored popover view. The cloned DOM cannot run React handlers,
// so clicks report the element path back to the window that owns the surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumaOverlay', {
  onRender: (listener) => {
    ipcRenderer.on('overlay:render', (_event, payload) => listener(payload));
  },
  onClick: (steps) => ipcRenderer.send('overlay:click', steps),
  onKey: (key) => ipcRenderer.send('overlay:key', key),
  onDismiss: () => ipcRenderer.send('overlay:dismiss'),
});
