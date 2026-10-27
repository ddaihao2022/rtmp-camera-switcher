const { app, BrowserWindow, ipcMain, screen, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// ─── 日志文件 & 日志窗口 ──────────────────────────────────────────────────────
let logWin = null;
let logStream = null;   // fs.WriteStream
let logFilePath = null;

function initLogFile() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  logFilePath = path.join(logDir, `rtmp-${date}.log`);
  logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
}

function writeLogLine(line) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}\n`;
  if (logStream) logStream.write(text);
  if (logWin && !logWin.isDestroyed()) {
    logWin.webContents.send('log:line', line);
  }
}

/** 拦截 server 进程（同进程加载时）的 console 输出，转发到日志窗口 */
function hookConsole() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    origLog(...args);
    writeLogLine(line);
  };
  console.warn = (...args) => {
    const line = '[WARN] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    origWarn(...args);
    writeLogLine(line);
  };
  console.error = (...args) => {
    const line = '[ERROR] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    origError(...args);
    writeLogLine(line);
  };
}

function openLogWindow() {
  if (logWin && !logWin.isDestroyed()) {
    logWin.focus();
    return;
  }
  logWin = new BrowserWindow({
    width: 900,
    height: 600,
    title: '日志输出',
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'logwin-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  logWin.loadFile(path.join(__dirname, 'logwin.html'));
  logWin.on('closed', () => { logWin = null; });
}

function closeLogWindow() {
  if (logWin && !logWin.isDestroyed()) logWin.close();
}

// ─── 初始化：先建日志文件，再挂钩 console，再加载 server ──────────────────────
initLogFile();
hookConsole();

if (!isDev) {
  require('../server/index.js');
}

// ─── 其余窗口 & 配置 ──────────────────────────────────────────────────────────
const DEV_URL = 'http://localhost:5173';
const PROD_INDEX = path.join(__dirname, '..', 'client', 'dist', 'index.html');

let controlWin = null;
let audioWin = null;
let settingsWin = null;   // 独立设置窗口
// 多路 HDMI 输出：Map<displayId, { win, mode, source }>
const outputWins = new Map();
let outputMode = null; // 兼容旧状态（任意一路的 mode）

function openAudioWindow() {
  if (audioWin && !audioWin.isDestroyed()) { audioWin.focus(); return; }
  audioWin = new BrowserWindow({
    width: 720,
    height: 480,
    minWidth: 400,
    minHeight: 320,
    title: '音频混音台',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadView(audioWin, 'audio');
  audioWin.on('closed', () => { audioWin = null; });
}

function isSettingsOpen() {
  return !!(settingsWin && !settingsWin.isDestroyed());
}

function notifySettingsChanged() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('settings:changed', { open: isSettingsOpen() });
  }
}

/** 打开（或聚焦）独立设置窗口：可拖到第二块屏幕，主窗口继续看画面 */
function openSettingsWindow() {
  if (isSettingsOpen()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  settingsWin = new BrowserWindow({
    width: 780,
    height: 920,
    minWidth: 420,
    minHeight: 520,
    title: '设置',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loadView(settingsWin, 'settings');
  settingsWin.once('ready-to-show', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.show();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
    notifySettingsChanged();
  });

  notifySettingsChanged();
  return settingsWin;
}

function closeSettingsWindow() {
  if (isSettingsOpen()) settingsWin.close();
}

function loadView(win, view, extraQuery = {}) {
  const params = new URLSearchParams();
  if (view) params.set('view', view);
  for (const [k, v] of Object.entries(extraQuery)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  if (isDev) {
    win.loadURL(qs ? `${DEV_URL}/?${qs}` : DEV_URL);
  } else {
    win.loadFile(PROD_INDEX, qs ? { search: `?${qs}` } : {});
  }
}

async function toggleVerboseLog(enable) {
  try {
    const res = await fetch('http://localhost:3001/api/log/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verbose: enable })
    });
    const data = await res.json();
    return data.verbose;
  } catch {
    return null;
  }
}

async function getLogStatus() {
  try {
    const res = await fetch('http://localhost:3001/api/log/status');
    const data = await res.json();
    return data.verbose;
  } catch {
    return false;
  }
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1400,
    height: 880,
    title: 'RTMP 多摄影设备管理',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadView(controlWin, null);
  controlWin.on('close', (e) => {
    if (recordingFiles.size === 0) return;
    const choice = dialog.showMessageBoxSync(controlWin, {
      type: 'warning',
      buttons: ['继续录制', '停止并退出'],
      defaultId: 0,
      cancelId: 0,
      title: '正在录制',
      message: '正在录制中，确定要退出吗？',
      detail: '退出会停止录制。已经写入磁盘的内容会保留，但当前分段可能缺少最后约 1 秒。',
    });
    if (choice === 0) e.preventDefault();
  });
  controlWin.on('closed', () => {
    controlWin = null;
    closeAllOutputWindows();
    closeSettingsWindow();
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '工具',
      submenu: [
        {
          label: '⚙️ 设置（独立窗口）',
          accelerator: 'CmdOrCtrl+,',
          click: () => openSettingsWindow()
        },
        { type: 'separator' },
        {
          label: '🎚 音频混音台',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => openAudioWindow()
        }
      ]
    },
    {
      label: '日志',
      submenu: [
        {
          id: 'toggleVerbose',
          label: '开启详细日志',
          type: 'checkbox',
          checked: false,
          accelerator: 'CmdOrCtrl+Shift+L',
          click: async (menuItem) => {
            const newState = await toggleVerboseLog(menuItem.checked);
            if (newState !== null) {
              menuItem.checked = newState;
              if (newState) {
                openLogWindow();
              } else {
                closeLogWindow();
              }
            }
            if (controlWin && !controlWin.isDestroyed()) {
              controlWin.webContents.send('log:statusChanged', { verbose: menuItem.checked });
            }
          }
        },
        {
          label: '打开日志窗口',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => openLogWindow()
        },
        { type: 'separator' },
        {
          label: '在文件管理器中查看日志',
          click: () => {
            if (logFilePath) shell.showItemInFolder(logFilePath);
          }
        }
      ]
    }
  ]);
}

function getTargetDisplay(displayId) {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  let target = displays.find((d) => d.id === displayId);
  if (!target) {
    target = displays.find((d) => d.id !== primaryId) || displays[0];
  }
  return target;
}

function getWindowedOutputBounds(target) {
  const workArea = target.workArea || target.bounds;
  const maxWidth = Math.max(640, Math.floor(workArea.width * 0.9));
  const maxHeight = Math.max(360, Math.floor(workArea.height * 0.9));

  let width = Math.min(1280, maxWidth);
  let height = Math.round(width * 9 / 16);

  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * 16 / 9);
  }

  return {
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
  };
}

function notifyOutputsChanged() {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('output:changed', listOutputStatus());
  }
}

function listOutputStatus() {
  return [...outputWins.entries()].map(([displayId, entry]) => ({
    displayId,
    open: !entry.win.isDestroyed(),
    mode: entry.mode,
    source: entry.source || null,
  }));
}

function closeOutputWindow(displayId) {
  const entry = outputWins.get(displayId);
  if (!entry) return false;
  outputWins.delete(displayId);
  if (entry.win && !entry.win.isDestroyed()) entry.win.close();
  outputMode = outputWins.size ? [...outputWins.values()][0].mode : null;
  notifyOutputsChanged();
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('output:closed', { displayId });
  }
  return true;
}

function closeAllOutputWindows() {
  for (const id of [...outputWins.keys()]) closeOutputWindow(id);
}

/**
 * 在指定显示器上打开/重建一路 HDMI 输出。
 * source 非空则该路固定播指定流；空则跟随主输出(PGM)。
 */
function createOutputWindow(displayId, mode = 'fullscreen', opts = {}) {
  const source = opts.source || null;
  const view = opts.view || 'output';

  // 同一显示器上已有输出 → 先关再开（等价于切换信号源）
  if (outputWins.has(displayId)) {
    const prev = outputWins.get(displayId);
    outputWins.delete(displayId);
    if (prev.win && !prev.win.isDestroyed()) {
      prev.win.removeAllListeners('closed');
      prev.win.close();
    }
  }

  const target = getTargetDisplay(displayId);
  const isWindowed = mode === 'window';
  const bounds = isWindowed ? getWindowedOutputBounds(target) : target.bounds;

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fullscreen: !isWindowed,
    frame: isWindowed,
    resizable: isWindowed,
    minimizable: isWindowed,
    maximizable: isWindowed,
    movable: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: source ? `HDMI 输出 · ${source}` : 'HDMI 输出 · PROGRAM',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  outputWins.set(displayId, { win, mode, source });
  outputMode = mode;

  loadView(win, view, source ? { source } : {});
  if (isWindowed) win.setMenuBarVisibility(false);

  win.on('closed', () => {
    if (outputWins.get(displayId)?.win === win) {
      outputWins.delete(displayId);
      outputMode = outputWins.size ? [...outputWins.values()][0].mode : null;
      notifyOutputsChanged();
      if (controlWin && !controlWin.isDestroyed()) {
        controlWin.webContents.send('output:closed', { displayId });
      }
    }
  });

  notifyOutputsChanged();
  return win;
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('displays:list', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    label: d.label || `显示器 ${d.id}`,
    bounds: d.bounds,
    primary: d.id === primaryId
  }));
});

// 兼容旧签名 openOutput(displayId, mode) 与新签名 openOutput(displayId, mode, { source })
ipcMain.handle('output:open', (_e, displayId, mode = 'fullscreen', opts = {}) => {
  createOutputWindow(displayId, mode, opts || {});
  return { success: true, outputs: listOutputStatus() };
});

// 批量：多块副屏一次打开（可选固定不同信号源） [{ displayId, mode?, source? }]
ipcMain.handle('output:openMulti', (_e, routes = []) => {
  for (const r of routes) {
    if (r?.displayId == null) continue;
    createOutputWindow(r.displayId, r.mode || 'fullscreen', { source: r.source || null });
  }
  return { success: true, outputs: listOutputStatus() };
});

// closeOutput() 关全部；closeOutput(displayId) 关指定一路
ipcMain.handle('output:close', (_e, displayId) => {
  if (displayId == null) {
    closeAllOutputWindows();
  } else {
    closeOutputWindow(displayId);
  }
  return { success: true, outputs: listOutputStatus() };
});

ipcMain.handle('output:status', () => ({
  open: outputWins.size > 0,
  mode: outputMode,
  outputs: listOutputStatus(),
}));

ipcMain.handle('outputs:list', () => listOutputStatus());

ipcMain.handle('log:getStatus', async () => ({ verbose: await getLogStatus() }));

ipcMain.handle('log:toggle', async (_e, verbose) => {
  const newState = await toggleVerboseLog(verbose);
  const menu = Menu.getApplicationMenu();
  const item = menu?.getMenuItemById('toggleVerbose');
  if (item) item.checked = !!newState;
  if (newState) {
    openLogWindow();
  } else {
    closeLogWindow();
  }
  return { verbose: newState };
});

ipcMain.handle('audio:open', () => { openAudioWindow(); return { success: true }; });

// 独立设置窗口
ipcMain.handle('settings:open', () => {
  openSettingsWindow();
  return { open: true };
});

ipcMain.handle('settings:close', () => {
  closeSettingsWindow();
  return { open: false };
});

ipcMain.handle('settings:status', () => ({ open: isSettingsOpen() }));

// 把独立窗口收回主界面弹窗
ipcMain.handle('settings:restore', () => {
  closeSettingsWindow();
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('settings:restore');
    controlWin.focus();
  }
  return { open: false, restored: true };
});

// 录制文件保存
ipcMain.handle('record:save', async (_e, { buffer, ext }) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(controlWin, {
    title: '保存录制文件',
    defaultPath: path.join(app.getPath('videos'), `recording-${ts}.${ext}`),
    filters: [{ name: '视频文件', extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { success: false };
  fs.writeFileSync(result.filePath, Buffer.from(buffer));
  shell.showItemInFolder(result.filePath);
  return { success: true, filePath: result.filePath };
});

// 一次录制导出多份成片：选一次目录，按 <base>_<后缀>.<ext> 一起落盘
ipcMain.handle('record:saveBatch', async (_e, { files = [] } = {}) => {
  const list = (Array.isArray(files) ? files : []).filter(f => f && f.buffer);
  if (!list.length) return { success: false, filePaths: [] };

  const ext = String(list[0].ext || 'webm').replace(/^\./, '');
  const base = list[0].base
    || `recording-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const result = await dialog.showOpenDialog(controlWin, {
    title: `选择保存目录（本次导出 ${list.length} 个文件）`,
    defaultPath: app.getPath('videos'),
    buttonLabel: '保存到此处',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths?.length) return { success: false, filePaths: [] };

  const dir = result.filePaths[0];
  const written = [];
  for (const f of list) {
    const e = String(f.ext || ext).replace(/^\./, '');
    const name = `${f.base || base}_${f.suffix || 'video'}.${e}`;
    const target = path.join(dir, name);
    fs.writeFileSync(target, Buffer.from(f.buffer));
    written.push(target);
  }
  if (written.length) shell.showItemInFolder(written[0]);
  return { success: true, filePaths: written };
});

// ─── 录制：边录边写 + 按时间分段 ─────────────────────────────────────────────
// 渲染进程每收到一个 MediaRecorder 分片就 append 一次，主进程用文件流直接写盘；
// 不再等停止后把整段录制塞进一个 ArrayBuffer 再 writeFileSync。
const RECORDING_SETTINGS_FILE = path.join(app.getPath('userData'), 'recording-settings.json');
const recordingFiles = new Map(); // token -> { stream, filePath, error }
let recordingTokenSeq = 0;

function loadRecordingSettings() {
  try {
    const d = JSON.parse(fs.readFileSync(RECORDING_SETTINGS_FILE, 'utf8'));
    return {
      dir: typeof d?.dir === 'string' ? d.dir : '',
      segmentMinutes: Number.isFinite(Number(d?.segmentMinutes)) ? Number(d.segmentMinutes) : 10,
    };
  } catch {
    return { dir: '', segmentMinutes: 10 };
  }
}

function saveRecordingSettings(patch = {}) {
  const prev = loadRecordingSettings();
  const next = { ...prev };
  if (typeof patch.dir === 'string') next.dir = patch.dir;
  if (patch.segmentMinutes !== undefined && Number.isFinite(Number(patch.segmentMinutes))) {
    next.segmentMinutes = Math.max(0, Math.min(180, Number(patch.segmentMinutes)));
  }
  try {
    fs.mkdirSync(path.dirname(RECORDING_SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(RECORDING_SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    writeLogLine('[record] 保存录制设置失败: ' + e.message);
  }
  return next;
}

function safeRecordingName(s, fallback = 'video') {
  const v = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (v || fallback).slice(0, 48);
}

function uniqueRecordingPath(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target) && i < 1000; i += 1) {
    target = path.join(dir, `${stem}-${i}${ext}`);
  }
  return target;
}

function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(() => reject(new Error('磁盘写入超时，移动磁盘可能已无响应'))), 30000);
    const cleanup = (fn) => {
      clearTimeout(timer);
      stream.off('drain', onDrain);
      stream.off('error', onError);
      stream.off('close', onClose);
      fn();
    };
    const onDrain = () => cleanup(resolve);
    const onError = (err) => cleanup(() => reject(err));
    const onClose = () => cleanup(() => reject(new Error('录制文件已关闭')));
    stream.once('drain', onDrain);
    stream.once('error', onError);
    stream.once('close', onClose);
  });
}

function notifyRecordingError(token, err) {
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.webContents.send('recording:error', { token, message: err?.message || String(err) });
  }
}

ipcMain.handle('recording:getSettings', () => loadRecordingSettings());

ipcMain.handle('recording:setSettings', (_e, patch = {}) => saveRecordingSettings(patch));

ipcMain.handle('recording:pickDir', async () => {
  const settings = loadRecordingSettings();
  const result = await dialog.showOpenDialog(controlWin, {
    title: '选择录制保存目录（建议选移动磁盘）',
    defaultPath: settings.dir || app.getPath('videos'),
    buttonLabel: '保存到这里',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths?.length) return { success: false };
  const dir = result.filePaths[0];
  saveRecordingSettings({ dir });
  return { success: true, dir };
});

ipcMain.handle('recording:diskInfo', async (_e, dir) => {
  const target = dir || loadRecordingSettings().dir;
  if (!target) return { success: false, error: '未选择保存目录' };
  try {
    const st = await fs.promises.statfs(target);
    return {
      success: true,
      dir: target,
      free: st.bavail * st.bsize,
      total: st.blocks * st.bsize,
    };
  } catch (e) {
    return { success: false, error: e.message, code: e.code };
  }
});

ipcMain.handle('recording:begin', async (_e, payload = {}) => {
  const settings = loadRecordingSettings();
  const dir = payload.dir || settings.dir;
  const base = safeRecordingName(payload.base, `recording-${Date.now()}`);
  const files = Array.isArray(payload.files) ? payload.files : [];

  if (!dir) return { success: false, error: '未选择保存目录', code: 'NODIR' };
  if (!files.length) return { success: false, error: '没有要保存的文件' };

  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) throw new Error('保存路径不是目录');
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch (e) {
    return { success: false, error: `保存目录不可用：${e.message}`, code: e.code || 'EDIR' };
  }

  const created = [];
  try {
    for (const f of files) {
      const ext = safeRecordingName(f.ext || 'webm').replace(/^\./, '') || 'webm';
      const segment = Math.max(0, Math.floor(Number(f.segment) || 0));
      const name = `${base}_${safeRecordingName(f.suffix)}_${String(segment).padStart(3, '0')}.${ext}`;
      const filePath = uniqueRecordingPath(dir, name);

      const stream = fs.createWriteStream(filePath, { flags: 'wx', autoClose: false });
      await new Promise((resolve, reject) => {
        stream.once('open', resolve);
        stream.once('error', reject);
      });

      const token = `rec-${++recordingTokenSeq}`;
      const rec = { token, filePath, stream, error: null };
      stream.on('error', (err) => {
        rec.error = err;
        notifyRecordingError(token, err);
      });
      recordingFiles.set(token, rec);
      created.push({ token, filePath, suffix: f.suffix, segment });
    }
  } catch (e) {
    // 任一文件建失败：把已经建出来的空文件清掉，别在磁盘上留垃圾
    for (const c of created) {
      const rec = recordingFiles.get(c.token);
      recordingFiles.delete(c.token);
      try { rec?.stream?.destroy(); } catch {}
      if (typeof rec?.stream?.fd === 'number') {
        try { fs.closeSync(rec.stream.fd); } catch {}
      }
      try { fs.unlinkSync(c.filePath); } catch {}
    }
    return { success: false, error: '创建录制文件失败：' + e.message, code: e.code || 'ECREATE' };
  }

  return { success: true, dir, files: created };
});

ipcMain.handle('recording:append', async (_e, { token, buffer } = {}) => {
  const rec = recordingFiles.get(token);
  if (!rec) throw new Error('录制会话已结束');
  if (rec.error) throw rec.error;

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!buf.length) return { success: true, bytes: 0 };

  const ok = rec.stream.write(buf);
  if (!ok) await waitForDrain(rec.stream);
  return { success: true, bytes: buf.length };
});

ipcMain.handle('recording:end', async (_e, { token } = {}) => {
  const rec = recordingFiles.get(token);
  if (!rec) return { success: false, error: '录制会话不存在' };
  recordingFiles.delete(token);

  const closeFd = () => {
    if (typeof rec.stream?.fd === 'number') {
      try { fs.closeSync(rec.stream.fd); } catch {}
    }
  };

  if (rec.error) {
    try { rec.stream.destroy(); } catch {}
    closeFd();
    return { success: false, filePath: rec.filePath, error: rec.error.message };
  }

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(reject, new Error('收尾超时：磁盘可能已拔出或无响应')), 20000);
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rec.stream.off('error', onError);
        fn(arg);
      };
      const onError = (err) => done(reject, err);
      rec.stream.once('error', onError);
      if (rec.stream.destroyed || rec.stream.closed) {
        done(reject, new Error('录制文件已意外关闭'));
        return;
      }
      rec.stream.end((err) => done(err ? reject : resolve, err));
    });
    // 移动磁盘：停止时强制刷盘，拔盘前数据已经在介质上
    if (typeof rec.stream.fd === 'number') {
      try { fs.fsyncSync(rec.stream.fd); } catch {}
    }
    closeFd();
    return { success: true, filePath: rec.filePath };
  } catch (e) {
    try { rec.stream.destroy(); } catch {}
    closeFd();
    return { success: false, filePath: rec.filePath, error: e.message };
  }
});

ipcMain.handle('recording:openDir', async (_e, dir) => {
  const target = dir || loadRecordingSettings().dir;
  if (!target) return { success: false, error: '未选择保存目录' };
  const err = await shell.openPath(target);
  return { success: !err, error: err || undefined };
});

ipcMain.handle('recording:reveal', async (_e, filePath) => {
  if (!filePath) return { success: false };
  shell.showItemInFolder(filePath);
  return { success: true };
});

// 本地媒体文件选择（音视频 + 图片）
ipcMain.handle('dialog:openFile', async () => {
  const result = await dialog.showOpenDialog(controlWin, {
    title: '选择媒体文件（音视频 / 图片）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '媒体文件', extensions: [
        'mp4','mov','mkv','avi','webm','m4v','ts','flv','wmv',
        'mp3','aac','wav','flac','m4a','ogg',
        'png','jpg','jpeg','gif','webp','bmp','svg','ico','avif',
      ]},
      { name: '视频', extensions: ['mp4','mov','mkv','avi','webm','m4v','ts','flv','wmv'] },
      { name: '音频', extensions: ['mp3','aac','wav','flac','m4a','ogg'] },
      { name: '图片', extensions: ['png','jpg','jpeg','gif','webp','bmp','svg','ico','avif'] },
    ]
  });
  if (result.canceled) return null;
  return result.filePaths;
});

// 日志窗口：打开日志文件
ipcMain.on('log:openFile', () => {
  if (logFilePath) shell.showItemInFolder(logFilePath);
});

// ─── 启动 ─────────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const menu = buildMenu();
  Menu.setApplicationMenu(menu);
  createControlWindow();

  screen.on('display-added', () => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('displays:changed');
  });
  screen.on('display-removed', () => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('displays:changed');
    for (const [id, entry] of [...outputWins.entries()]) {
      if (!entry.win || entry.win.isDestroyed()) outputWins.delete(id);
    }
    notifyOutputsChanged();
  });
});

// 退出前把还在写的录制文件收尾，避免留下未关闭的文件句柄
let quittingAfterRecordings = false;
app.on('before-quit', (e) => {
  if (quittingAfterRecordings || recordingFiles.size === 0) return;
  e.preventDefault();
  quittingAfterRecordings = true;
  (async () => {
    for (const rec of [...recordingFiles.values()]) {
      try {
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          try { rec.stream.end(finish); } catch { finish(); }
          setTimeout(finish, 3000);
        });
        if (typeof rec.stream?.fd === 'number') {
          try { fs.fsyncSync(rec.stream.fd); } catch {}
          try { fs.closeSync(rec.stream.fd); } catch {}
        }
      } catch (err) {
        writeLogLine('[record] 退出时收尾失败: ' + err.message);
      }
    }
    recordingFiles.clear();
    app.quit();
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (logStream) logStream.end();
    app.quit();
  }
});
