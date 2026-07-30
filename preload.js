'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remiAPI', {
  rendererReady: () => ipcRenderer.send('remi:ready'),
  onUpdate: (cb) => ipcRenderer.on('remi:update', (_e, u) => cb(u)),
  decide: (id, behavior) => ipcRenderer.send('remi:decide', { id, behavior }),
  focus: () => ipcRenderer.send('remi:focus'),
});
