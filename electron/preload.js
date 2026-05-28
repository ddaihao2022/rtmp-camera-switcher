const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (displayId) => ipcRenderer.invoke('output:open', displayId),
  closeOutput: () => ipcRenderer.invoke('output:close'),
  getOutputStatus: () => ipcRenderer.invoke('output:status'),
  onOutputClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('output:closed', handler);
    return () => ipcRenderer.removeListener('output:closed', handler);
  },
  onDisplaysChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('displays:changed', handler);
    return () => ipcRenderer.removeListener('displays:changed', handler);
  }
});
