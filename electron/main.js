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
let outputWin = null;
let audioWin = null;

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
  loadView(audioWin, { view: 'audio' });
  audioWin.on('closed', () => { audioWin = null; });
}

function loadView(win, query = null) {
  const search = query ? new URLSearchParams(query).toString() : '';
  if (isDev) {
    win.loadURL(search ? `${DEV_URL}/?${search}` : DEV_URL);
  } else {
    win.loadFile(PROD_INDEX, search ? { search: `?${search}` } : {});
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
    // 主窗口关掉时若还在录制，先把写入流收尾，避免文件句柄悬挂
    if (recordSession) finishRecordSession();
    if (outputWin) outputWin.close();
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

function createOutputWindow(displayId, { withAudio = false } = {}) {
  if (outputWin) { outputWin.close(); outputWin = null; }

  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  let target = displays.find(d => d.id === displayId);
  if (!target) {
    target = displays.find(d => d.id !== primaryId) || displays[0];
  }

  outputWin = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'HDMI 输出',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadView(outputWin, withAudio ? { view: 'output', audio: '1' } : { view: 'output' });
  outputWin.on('closed', () => {
    outputWin = null;
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('output:closed');
    }
  });
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

ipcMain.handle('output:open', (_e, displayId, opts) => {
  createOutputWindow(displayId, opts || {});
  return { success: true };
});

ipcMain.handle('output:close', () => {
  if (outputWin) outputWin.close();
  return { success: true };
});

ipcMain.handle('output:status', () => ({ open: !!outputWin }));

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

// ─── 录制：边录边写盘 ─────────────────────────────────────────────────────────
// 旧实现让渲染进程把整段录制的 chunk 攒在内存里，停止时一次性 arrayBuffer → IPC → writeFileSync。
// 几分钟 1080p 就吃掉数 GB 内存、拷贝一次全量数据并同步阻塞主进程。
// 现在：开始时建好写入流，每收到一块就追加写盘，渲染进程侧不再持有历史数据。
let recordSession = null; // { id, stream, filePath, bytes, error }

function finishRecordSession() {
  const session = recordSession;
  recordSession = null;
  if (!session) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (session.stream.writableEnded || session.stream.destroyed) {
      resolve(session);
      return;
    }
    session.stream.once('close', () => resolve(session));
    session.stream.end();
  });
}

ipcMain.handle('record:start', async (_e, { ext = 'webm' } = {}) => {
  // 上一次会话没收尾（如渲染进程异常）先关掉，避免句柄泄漏
  if (recordSession) await finishRecordSession();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(controlWin, {
    title: '保存录制文件',
    defaultPath: path.join(app.getPath('videos'), `recording-${ts}.${ext}`),
    filters: [{ name: '视频文件', extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  const stream = fs.createWriteStream(result.filePath);
  const session = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    stream,
    filePath: result.filePath,
    bytes: 0,
    error: null,
  };
  stream.on('error', (err) => {
    session.error = err.message;
    if (recordSession === session) recordSession = null;
  });
  recordSession = session;
  return { success: true, sessionId: session.id, filePath: session.filePath };
});

// 用 send（不 invoke）保证分块顺序，也不会给渲染进程造成逐块 RTT
ipcMain.on('record:chunk', (_e, payload) => {
  const session = recordSession;
  if (!session || !payload || session.id !== payload.sessionId) return;
  const { chunk } = payload;
  if (!chunk || !chunk.byteLength) return;
  const buf = Buffer.from(chunk);
  session.bytes += buf.length;
  // 写不动时交给可写流自身缓冲（远小于旧实现的整段驻留），不丢块以免容器损坏
  session.stream.write(buf);
});

ipcMain.handle('record:end', async (_e, sessionId) => {
  const session = recordSession;
  if (!session || session.id !== sessionId) {
    return { success: false, error: '录制会话不存在或已结束' };
  }
  await finishRecordSession();
  if (session.error) return { success: false, error: session.error };
  if (session.bytes === 0) {
    try { fs.unlinkSync(session.filePath); } catch { /* ignore */ }
    return { success: false, error: '没有收到任何录制数据' };
  }
  shell.showItemInFolder(session.filePath);
  return { success: true, filePath: session.filePath, bytes: session.bytes };
});

ipcMain.handle('record:cancel', async (_e, sessionId) => {
  const session = recordSession;
  if (!session || session.id !== sessionId) return { success: false };
  await finishRecordSession();
  try { fs.unlinkSync(session.filePath); } catch { /* ignore */ }
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
    if (outputWin) outputWin.close();
  });
});

app.on('window-all-closed', () => {
  if (recordSession) finishRecordSession();
  if (process.platform !== 'darwin') {
    if (logStream) logStream.end();
    app.quit();
  }
});
