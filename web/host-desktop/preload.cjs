'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('matchHost', Object.freeze({
  get: () => ipcRenderer.invoke('host:get'),
  start: options => ipcRenderer.invoke('host:start', options),
  stop: () => ipcRenderer.invoke('host:stop'),
  copyInvite: () => ipcRenderer.invoke('host:copy-invite'),
  copyPassword: () => ipcRenderer.invoke('host:copy-password'),
  openGame: () => ipcRenderer.invoke('host:open-game'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('host:state', listener); return () => ipcRenderer.removeListener('host:state', listener); },
}));
