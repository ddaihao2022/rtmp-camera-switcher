const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  /**
   * 打开一路 HDMI 输出
   * @param {number} displayId
   * @param {'fullscreen'|'window'} mode
   * @param {{ source?: string|null }} [opts] source 固定信号源；省略/空则跟随 PROGRAM
   */
  openOutput: (displayId, mode = 'fullscreen', opts = {}) =>
    ipcRenderer.invoke('output:open', displayId, mode, opts),
  /** 批量打开多路：[{ displayId, mode?, source? }] */
  openMultiOutputs: (routes) => ipcRenderer.invoke('output:openMulti', routes),
  /** 关闭一路或全部（不传 displayId 关全部） */
  closeOutput: (displayId) => ipcRenderer.invoke('output:close', displayId),
  getOutputStatus: () => ipcRenderer.invoke('output:status'),
  listOutputs: () => ipcRenderer.invoke('outputs:list'),
  onOutputClosed: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('output:closed', handler);
    return () => ipcRenderer.removeListener('output:closed', handler);
  },
  onOutputsChanged: (cb) => {
    const handler = (_e, outputs) => cb(outputs);
    ipcRenderer.on('output:changed', handler);
    return () => ipcRenderer.removeListener('output:changed', handler);
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
