'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = ['vitals:status', 'vitals:validation', 'vitals:error', 'vitals:metrics', 'vitals:frame',
  'measure:state', 'calib:state', 'calib:done', 'test:ended', 'test:saved'];

contextBridge.exposeInMainWorld('vitals', {
  info: () => ipcRenderer.invoke('app:info'),
  start: () => ipcRenderer.invoke('vitals:start'),
  stop: () => ipcRenderer.invoke('vitals:stop'),
  setPreview: (on) => ipcRenderer.invoke('vitals:preview', on === true),
  startCalibration: () => ipcRenderer.invoke('calib:start'),
  getBaseline: () => ipcRenderer.invoke('baseline:get'),
  getQuestions: () => ipcRenderer.invoke('questions:get'),
  startTest: (opts) => ipcRenderer.invoke('test:start', opts),
  testEvent: (e) => ipcRenderer.invoke('test:event', e),
  endTest: (reason) => ipcRenderer.invoke('test:end', reason),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  openSession: (file) => ipcRenderer.invoke('sessions:open', file),
  saveReportPdf: (startedAt) => ipcRenderer.invoke('report:pdf', startedAt),
  deleteSession: (file) => ipcRenderer.invoke('sessions:delete', file),
  resetStart: () => ipcRenderer.invoke('reset:start'),
  resetEnd: () => ipcRenderer.invoke('reset:end'),
  checkin: (feeling) => ipcRenderer.invoke('test:checkin', feeling),
  call: (url) => ipcRenderer.invoke('support:call', url),
  dataInfo: () => ipcRenderer.invoke('data:info'),
  deleteAllData: () => ipcRenderer.invoke('data:deleteAll'),
  on: (channel, cb) => {
    if (channels.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  },
});
