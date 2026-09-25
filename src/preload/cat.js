'use strict';
// The only bridge between the cat window and the main process. Sandboxed:
// it can't require local files, so everything lives in this one file.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('cheshire', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: listen('state'),
  onSay: listen('cat:say'),
  onDemo: listen('cat:demo'),
  hover: (on) => ipcRenderer.send('cat:hover', Boolean(on)),
  dragStart: () => ipcRenderer.send('cat:drag', 'start'),
  dragEnd: () => ipcRenderer.send('cat:drag', 'end'),
  openChat: () => ipcRenderer.send('chat:open'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', String(key), value),
  listModels: () => ipcRenderer.invoke('models:list'),
  restart: () => ipcRenderer.send('app:restart'),
  quit: () => ipcRenderer.send('app:quit'),
});
