const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  cacheGet: (name) => ipcRenderer.invoke('cache:get', name),
  cacheSet: (name, data) => ipcRenderer.invoke('cache:set', name, data),
  tmdb: (apiPath, ttl) => ipcRenderer.invoke('tmdb', apiPath, ttl),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  toggleFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  quit: () => ipcRenderer.invoke('app:quit'),
});
