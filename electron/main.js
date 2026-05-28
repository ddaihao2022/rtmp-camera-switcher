const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;

// 仅在打包后由 Electron 内嵌启动本地服务;开发模式下 server 由 npm 脚本独立启动
if (!isDev) {
  require('../server/index.js');
}

const DEV_URL = 'http://localhost:5173';
const PROD_INDEX = path.join(__dirname, '..', 'client', 'dist', 'index.html');

let controlWin = null;
let outputWin = null;

function loadView(win, view) {
  if (isDev) {
    win.loadURL(view ? `${DEV_URL}/?view=${view}` : DEV_URL);
  } else {
    win.loadFile(PROD_INDEX, view ? { search: `?view=${view}` } : {});
  }
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1400,
    height: 880,
    title: 'RTMP 多摄影设备管理',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loadView(controlWin, null);
  controlWin.on('closed', () => {
    controlWin = null;
    if (outputWin) outputWin.close();
  });
}

function createOutputWindow(displayId) {
  if (outputWin) {
    outputWin.close();
    outputWin = null;
  }

  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  let target = displays.find(d => d.id === displayId);
  if (!target) {
    // 默认选一块非主屏(有 HDMI 外接时通常就是它)
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
  loadView(outputWin, 'output');
  outputWin.on('closed', () => {
    outputWin = null;
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('output:closed');
    }
  });
}

ipcMain.handle('displays:list', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    label: d.label || `显示器 ${d.id}`,
    bounds: d.bounds,
    primary: d.id === primaryId
  }));
});

ipcMain.handle('output:open', (_e, displayId) => {
  createOutputWindow(displayId);
  return { success: true };
});

ipcMain.handle('output:close', () => {
  if (outputWin) outputWin.close();
  return { success: true };
});

ipcMain.handle('output:status', () => {
  return { open: !!outputWin };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createControlWindow();

  // 屏幕插拔时通知主控刷新列表
  screen.on('display-added', () => {
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('displays:changed');
    }
  });
  screen.on('display-removed', () => {
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send('displays:changed');
    }
    // 如果输出窗口在被拔掉的屏幕上,自动关闭
    if (outputWin) outputWin.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
