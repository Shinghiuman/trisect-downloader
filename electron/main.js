'use strict';
/**
 * Electron 主进程：内嵌下载引擎（HTTP/BT/eD2K）+ 打开桌面窗口
 * 端口默认 0（随机空闲端口），可用环境变量 TD_PORT 固定。
 */
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;
let mainWindow = null;
let engine = null;
let baseUrl = '';

// 兼容无独显 / 受限容器环境：默认走软件渲染并关闭 Chromium 沙箱，
// 否则 GPU 进程在某些会话下会以 0xC0000005 崩溃并导致整个应用退出。
// 需要硬件加速时设置环境变量 TD_GPU=1。
if (process.env.TD_GPU !== '1') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// 用户数据目录（打包后写入 %APPDATA%，不污染安装目录）
const USER_DATA = app.getPath('userData');
const DOWNLOAD_ROOT = path.join(app.getPath('downloads'), 'TrisectDownloads');
fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });

process.env.TD_DATA_DIR = process.env.TD_DATA_DIR || path.join(USER_DATA, 'data');
process.env.TD_DOWNLOAD_DIR = process.env.TD_DOWNLOAD_DIR || DOWNLOAD_ROOT;

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0a0d13',
    title: '三栖下载器 · ED2K / BT / HTTP',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(baseUrl);
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function boot() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          {
            label: '打开下载目录',
            click: () => shell.openPath(process.env.TD_DOWNLOAD_DIR),
          },
          {
            label: '打开数据目录',
            click: () => shell.openPath(process.env.TD_DATA_DIR),
          },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload', label: '刷新' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
        ],
      },
      {
        label: '帮助',
        submenu: [
          {
            label: '关于',
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: '关于三栖下载器',
                message: '三栖下载器 1.0.0',
                detail:
                  '多协议下载：HTTP(S) 原生引擎 · BitTorrent/磁力（WebTorrent 真实协议栈） · eD2K 协议模型\n\n' +
                  'Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome + ' / Node ' + process.versions.node,
              }),
          },
        ],
      },
    ])
  );

  try {
    const server = require('../server.js');
    engine = server;
    const port = Number(process.env.TD_PORT || 0);
    const actual = await engine.start(port);
    baseUrl = `http://127.0.0.1:${actual}`;
    console.log('[electron] engine at', baseUrl);
  } catch (e) {
    dialog.showErrorBox('下载引擎启动失败', String(e && e.stack ? e.stack : e));
    app.quit();
    return;
  }

  createWindow();
}

app.whenReady().then(() => {
  if (!gotLock) return; // 已有实例在运行，当前进程直接退出，不再启动引擎
  boot();
});

app.on('window-all-closed', async () => {
  try { engine && engine.stop && (await engine.stop()); } catch (_) {}
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && baseUrl) createWindow();
});

process.on('uncaughtException', (e) => {
  console.error('[electron] uncaught', e);
});
