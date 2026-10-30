'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('flash', {
  info: () => ipcRenderer.invoke('app:info'),
  listDrives: () => ipcRenderer.invoke('drives:list'),
  onDrives: subscribe('drives:changed'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  inspectImage: (file) => ipcRenderer.invoke('image:inspect', file),
  pathForFile: (file) => webUtils.getPathForFile(file),
  start: (job) => ipcRenderer.invoke('job:start', job),
  cancel: () => ipcRenderer.invoke('job:cancel'),
  onProgress: subscribe('job:event'),
  openExternal: (url) => ipcRenderer.invoke('app:open', url),
});
