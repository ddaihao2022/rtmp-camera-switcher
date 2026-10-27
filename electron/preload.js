const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (displayId, opts) => ipcRenderer.invoke('output:open', displayId, opts),
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
  // 录制（流式写盘：start → 若干 chunk → end/cancel）
  startRecording: (ext) => ipcRenderer.invoke('record:start', { ext }),
  writeRecordingChunk: (sessionId, chunk) => ipcRenderer.send('record:chunk', { sessionId, chunk }),
  finishRecording: (sessionId) => ipcRenderer.invoke('record:end', sessionId),
  cancelRecording: (sessionId) => ipcRenderer.invoke('record:cancel', sessionId),
  // 本地媒体文件
  selectLocalFiles: () => ipcRenderer.invoke('dialog:openFile'),
  // 将本地绝对路径转为 file:// URL（仅 Electron 环境有效）
  toFileUrl: (filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    return `file:///${normalized.replace(/^\//, '')}`;
  }
});
