const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('logAPI', {
  onLogLine: (cb) => {
    ipcRenderer.on('log:line', (_e, line) => cb(line));
  },
  openLogFile: () => ipcRenderer.send('log:openFile')
});
