'use strict';
// The only bridge between the chat window and the main process. The chat can
// send your message and render events — it cannot run tools, read files,
// reach the network or see the API key.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('cheshire', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: listen('state'),
  onEvent: listen('chat:event'),
  onSide: listen('chat:side'),
  onMode: listen('chat:mode'),
  history: () => ipcRenderer.invoke('chat:history'),
  send: (text, image) => ipcRenderer.invoke('chat:send', {
    text: String(text || ''),
    image: image ? { mime: String(image.mime), data: String(image.data) } : null,
  }),
  hide: () => ipcRenderer.send('chat:hide'),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  copy: (text) => ipcRenderer.send('clipboard:write', String(text)),
});
