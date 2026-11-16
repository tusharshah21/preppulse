'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = ['vitals:status', 'vitals:validation', 'vitals:error', 'vitals:metrics', 'vitals:frame'];

contextBridge.exposeInMainWorld('vitals', {
  start: () => ipcRenderer.invoke('vitals:start'),
  stop: () => ipcRenderer.invoke('vitals:stop'),
  setPreview: (on) => ipcRenderer.invoke('vitals:preview', on === true),
  getBaseline: () => ipcRenderer.invoke('baseline:get'),
  saveBaseline: (samples) => ipcRenderer.invoke('baseline:save', samples),
  dataInfo: () => ipcRenderer.invoke('data:info'),
  deleteAllData: () => ipcRenderer.invoke('data:deleteAll'),
  on: (channel, cb) => {
    if (channels.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
