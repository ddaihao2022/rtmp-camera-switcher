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
  },
  // 日志开关
  getLogStatus: () => ipcRenderer.invoke('log:getStatus'),
  toggleLog: (verbose) => ipcRenderer.invoke('log:toggle', verbose),
  onLogStatusChanged: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('log:statusChanged', handler);
    return () => ipcRenderer.removeListener('log:statusChanged', handler);
  },
  // 音频窗口
  openAudioWindow: () => ipcRenderer.invoke('audio:open'),
  // 录制
  saveRecording: (buffer, ext) => ipcRenderer.invoke('record:save', { buffer, ext }),
  // 本地媒体文件
  selectLocalFiles: () => ipcRenderer.invoke('dialog:openFile'),
  // 将本地绝对路径转为 file:// URL（仅 Electron 环境有效）
  toFileUrl: (filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    return `file:///${normalized.replace(/^\//, '')}`;
  }
});
