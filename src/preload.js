'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingcun', Object.freeze({
  getState: () => ipcRenderer.invoke('state:get'),
  addLinks: (input) => ipcRenderer.invoke('queue:add', input),
  chooseDirectory: () => ipcRenderer.invoke('settings:choose-directory'),
  openDirectory: () => ipcRenderer.invoke('settings:open-directory'),
  retryTask: (taskId) => ipcRenderer.invoke('task:retry', taskId),
  cancelTask: (taskId) => ipcRenderer.invoke('task:cancel', taskId),
  removeTask: (taskId) => ipcRenderer.invoke('task:remove', taskId),
  clearCompleted: () => ipcRenderer.invoke('queue:clear-completed'),
  showFile: (taskId) => ipcRenderer.invoke('task:show-file', taskId),
  onStateChanged: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  }
}));
