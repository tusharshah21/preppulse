'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { startSession, stopSession, downscaleToRGBA, REQUESTED_METRICS } = require('./lib/vitals');
const { createRecorder, loadRecording, play } = require('./lib/recording');
const { computeBaseline } = require('./lib/baseline');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* missing .env is reported on start */ }

// Dev/testing switches. The default (none set) is the live camera.
const REPLAY = process.env.PREPPULSE_REPLAY;
const VIDEO = !REPLAY && process.env.PREPPULSE_VIDEO ? path.resolve(process.env.PREPPULSE_VIDEO) : undefined;
const RECORD = process.env.PREPPULSE_RECORD === '1' && !REPLAY;
const PREVIEW_INTERVAL_MS = 100;

let win = null;
let sdk = null;
let stopReplay = null;
let recorder = null;
let previewOn = false;
let lastPreview = 0;

const dataDir = () => path.join(app.getPath('userData'), 'preppulse-data');
const baselineFile = () => path.join(dataDir(), 'baseline.json');

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
const emit = (channel, data) => {
  if (recorder) recorder.add(channel, data);
  send(channel, data);
};

// Preview frames stay in memory: downscaled, sent to the window, then dropped.
function onFrame(buf, w, h, stride, fmt) {
  const now = Date.now();
  if (!previewOn || now - lastPreview < PREVIEW_INTERVAL_MS) return;
  lastPreview = now;
  const frame = downscaleToRGBA(buf, w, h, stride, fmt);
  if (frame) send('vitals:frame', frame);
}

async function start() {
  if (sdk || stopReplay) return { ok: true };

  if (REPLAY) {
    try {
      stopReplay = play(loadRecording(REPLAY), emit);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: `Could not replay ${path.basename(REPLAY)}: ${e.message}` };
    }
  }

  const apiKey = process.env.SMARTSPECTRA_API_KEY;
  if (!apiKey || apiKey === 'your-api-key-here') {
    return { ok: false, message: 'No API key found. Copy .env.example to .env and set SMARTSPECTRA_API_KEY.' };
  }
  if (RECORD) recorder = createRecorder({ source: 'app', input: VIDEO ? 'file' : 'camera', requestedMetrics: REQUESTED_METRICS });
  try {
    sdk = await startSession({ apiKey, emit, onFrame, videoPath: VIDEO });
    return { ok: true };
  } catch (e) {
    recorder = null;
    return { ok: false, message: `${e.codeName}: ${e.message}` };
  }
}

async function stop() {
  previewOn = false;
  if (stopReplay) {
    stopReplay();
    stopReplay = null;
    send('vitals:status', 'kIdle');
    return;
  }
  const s = sdk;
  sdk = null;
  if (!s) return;
  await stopSession(s);
  if (recorder) {
    recorder.save(path.join(__dirname, 'data', 'recordings'), 'app');
    recorder = null;
  }
}

function readBaseline() {
  try { return JSON.parse(fs.readFileSync(baselineFile(), 'utf8')); } catch { return null; }
}

function saveBaseline(samples) {
  const baseline = computeBaseline(samples);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(baselineFile(), JSON.stringify(baseline, null, 2));
  return baseline;
}

async function deleteAllData() {
  await stop();
  fs.rmSync(dataDir(), { recursive: true, force: true });
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  return true;
}

app.whenReady().then(() => {
  // The renderer never needs camera/mic/etc: capture happens natively in this process.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  win = new BrowserWindow({
    width: 960,
    height: 760,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile('index.html');

  const handle = (channel, fn) => ipcMain.handle(channel, (e, arg) => {
    if (!win || e.sender !== win.webContents) throw new Error('denied');
    return fn(arg);
  });
  handle('vitals:start', start);
  handle('vitals:stop', stop);
  handle('vitals:preview', (on) => { previewOn = on === true && !!sdk; });
  handle('baseline:get', readBaseline);
  handle('baseline:save', saveBaseline);
  handle('data:info', () => ({ folder: dataDir() }));
  handle('data:deleteAll', deleteAllData);
});

app.on('window-all-closed', async () => {
  await stop();
  app.quit();
});
