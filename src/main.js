'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DownloadManager } = require('./lib/download-manager');
const { resolveSystemProxyCandidates } = require('./lib/proxy-resolver');
const { JsonStore } = require('./lib/settings-store');

const APP_NAME = '轻存';
const MAX_INPUT_LENGTH = 200_000;

let mainWindow = null;
let settingsStore = null;
let queueStore = null;
let manager = null;
let persistTimer = null;
let quitting = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.setName(APP_NAME);
app.setAppUserModelId('com.qingcun.downloader');

function getEnginePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'yt-dlp.exe')
    : path.join(__dirname, '..', 'vendor', 'yt-dlp.exe');
}

function getPublicState() {
  const managerState = manager ? manager.getState() : { tasks: [], counts: {}, activeCount: 0, directoryError: '' };
  return {
    ...managerState,
    downloadDirectory: settingsStore ? settingsStore.get('downloadDirectory') || '' : '',
    engineAvailable: fs.existsSync(getEnginePath())
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state:changed', getPublicState());
}

function persistQueueNow() {
  if (!queueStore || !manager) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const unfinishedTasks = manager.getPersistableTasks().filter((task) => (
    !['completed', 'canceled', 'duplicate'].includes(task.status)
  ));
  queueStore.set('tasks', unfinishedTasks);
}

function scheduleQueuePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persistQueueNow();
    } catch (error) {
      console.error('Unable to persist queue:', error);
    }
  }, 500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 620,
    minWidth: 720,
    minHeight: 500,
    show: false,
    backgroundColor: '#f5f7fb',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIpc() {
  ipcMain.handle('state:get', () => getPublicState());

  ipcMain.handle('queue:add', (_event, input) => {
    if (typeof input !== 'string' || input.length > MAX_INPUT_LENGTH) {
      return { accepted: 0, platforms: { tiktok: 0 }, duplicate: 0, invalid: 1, found: 0 };
    }
    return manager.addText(input);
  });

  ipcMain.handle('settings:choose-directory', async () => {
    const current = settingsStore.get('downloadDirectory');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频保存位置',
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('downloads'),
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const directory = path.resolve(result.filePaths[0]);
    settingsStore.set('downloadDirectory', directory);
    manager.notifyDirectoryChanged();
    broadcastState();
    return { canceled: false, directory };
  });

  ipcMain.handle('settings:open-directory', async () => {
    const directory = settingsStore.get('downloadDirectory');
    if (!directory || !fs.existsSync(directory)) return { ok: false, error: '保存位置不可用' };
    const error = await shell.openPath(directory);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('task:retry', (_event, taskId) => manager.retryTask(validTaskId(taskId)));
  ipcMain.handle('task:cancel', (_event, taskId) => manager.cancelTask(validTaskId(taskId)));
  ipcMain.handle('task:remove', (_event, taskId) => manager.removeTask(validTaskId(taskId)));
  ipcMain.handle('queue:clear-completed', () => manager.clearCompleted());

  ipcMain.handle('task:show-file', (_event, taskId) => {
    const safeId = validTaskId(taskId);
    const task = manager.getState().tasks.find((candidate) => candidate.id === safeId);
    if (!task || task.status !== 'completed' || !task.outputPath || !fs.existsSync(task.outputPath)) return false;
    shell.showItemInFolder(task.outputPath);
    return true;
  });
}

function validTaskId(value) {
  return typeof value === 'string' && value.length <= 100 ? value : '';
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    const proxySession = session.defaultSession;
    try {
      await Promise.race([
        proxySession.forceReloadProxyConfig(),
        new Promise((resolve) => setTimeout(resolve, 1500))
      ]);
    } catch (_error) {
      // Per-task resolution below reports a precise failure if system routing remains unavailable.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const userDataDirectory = app.getPath('userData');
    settingsStore = new JsonStore(path.join(userDataDirectory, 'settings.json'), {
      downloadDirectory: ''
    });
    queueStore = new JsonStore(path.join(userDataDirectory, 'queue.json'), {
      tasks: []
    });
    manager = new DownloadManager({
      enginePath: getEnginePath(),
      getDownloadDirectory: () => settingsStore.get('downloadDirectory') || '',
      concurrency: 2,
      getProxyCandidates: (url) => resolveSystemProxyCandidates(proxySession, url),
      initialTasks: queueStore.get('tasks') || []
    });
    manager.on('change', () => {
      scheduleQueuePersist();
      broadcastState();
    });

    setupIpc();
    createWindow();
    manager.pump();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  if (manager) manager.shutdown();
  try {
    persistQueueNow();
  } catch (error) {
    console.error('Unable to persist queue during shutdown:', error);
  }
});

app.on('window-all-closed', () => app.quit());
