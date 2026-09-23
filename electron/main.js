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
  controlWin.on('closed', () => {
    controlWin = null;
    closeAllOutputWindows();
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '工具',
      submenu: [
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (logStream) logStream.end();
    app.quit();
  }
});
