'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const CONFIG = require('./lib/config');
const { startSession, stopSession, downscaleToRGBA, REQUESTED_METRICS } = require('./lib/vitals');
const { createRecorder, loadRecording, play } = require('./lib/recording');
const { computeBaseline } = require('./lib/baseline');
const { createCalibration, pausedHint } = require('./lib/calibration');
const { loadQuestions, publicView } = require('./lib/questions');
const { createTestSession } = require('./lib/session');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* missing .env is reported on start */ }

// Dev/testing switches. The default (none set) is the live camera.
const REPLAY = process.env.PREPPULSE_REPLAY;
const VIDEO = !REPLAY && process.env.PREPPULSE_VIDEO ? path.resolve(process.env.PREPPULSE_VIDEO) : undefined;
const RECORD = process.env.PREPPULSE_RECORD === '1' && !REPLAY;
const MODE = REPLAY ? 'replay' : VIDEO ? 'video' : 'camera';
const PREVIEW_INTERVAL_MS = 100;
const QUESTION_FILE = path.join(__dirname, 'questions', 'sample-test.json');

let replayRec = null;
let replayError = null;
if (REPLAY) {
  try { replayRec = loadRecording(REPLAY); } catch (e) { replayError = e.message; }
}
const SIMULATED = replayRec?.meta.simulated === true;

let win = null;
let sdk = null;
let stopReplay = null;
let recorder = null;
let previewOn = false;
let lastPreview = 0;
let ticker = null;
let lastValidation = null; // { ok, code, hint }
let lastStablePulseAt = -Infinity;
let calibration = null;
let test = null; // { session, timer, result, finalizeTimer }

const dataDir = () => path.join(app.getPath('userData'), 'preppulse-data');
const baselineFile = () => path.join(dataDir(), 'baseline.json');
const sessionsDir = () => path.join(dataDir(), 'sessions');
const running = () => !!(sdk || stopReplay);

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

// Every SDK (or replay) event goes to the recorder, the window, and whatever
// is measuring right now (calibration or a test session), stamped on arrival.
function emit(channel, data) {
  if (recorder) recorder.add(channel, data);
  send(channel, data);
  const t = Date.now();
  if (channel === 'vitals:validation') {
    lastValidation = data;
    calibration?.onValidation(t, data);
    test?.session.onValidation(t, data);
  } else if (channel === 'vitals:error') {
    lastValidation = { ok: false, code: data.code, hint: 'the measurement reported a problem' };
    calibration?.onError(t, data);
    test?.session.onError(t, data);
  } else if (channel === 'vitals:metrics') {
    if (data.pulse?.stable) lastStablePulseAt = t;
    calibration?.onMetrics(t, data);
    test?.session.onMetrics(t, data);
  }
}

// Preview frames stay in memory: downscaled, sent to the window, then dropped.
function onFrame(buf, w, h, stride, fmt) {
  const now = Date.now();
  if (!previewOn || now - lastPreview < PREVIEW_INTERVAL_MS) return;
  lastPreview = now;
  const frame = downscaleToRGBA(buf, w, h, stride, fmt);
  if (frame) send('vitals:frame', frame);
}

// What the calm indicator shows. Never numbers.
function measureState(now) {
  if (!lastValidation) return { state: 'starting', text: 'Starting camera...' };
  if (!lastValidation.ok) return { state: 'paused', text: pausedHint(lastValidation.code, lastValidation.hint) };
  if (now - lastStablePulseAt <= CONFIG.calibration.pulseFreshSeconds * 1000) return { state: 'measuring', text: 'Measuring' };
  return { state: 'getting_ready', text: 'Getting ready' };
}

function onTick() {
  const now = Date.now();
  send('measure:state', measureState(now));
  if (calibration) {
    send('calib:state', calibration.tick(now));
    if (calibration.result) finishCalibration();
  }
  if (test && !test.result && now >= test.startedAt + test.durationMs) endTest('time_up');
}

async function start() {
  if (running()) return { ok: true };
  lastValidation = null;
  lastStablePulseAt = -Infinity;
  if (REPLAY) {
    if (!replayRec) return { ok: false, message: `Could not replay ${path.basename(REPLAY)}: ${replayError}` };
    stopReplay = play(replayRec, emit);
  } else {
    const apiKey = process.env.SMARTSPECTRA_API_KEY;
    if (!apiKey || apiKey === 'your-api-key-here') {
      return { ok: false, message: 'No API key found. Copy .env.example to .env and set SMARTSPECTRA_API_KEY.' };
    }
    if (RECORD) recorder = createRecorder({ source: 'app', input: VIDEO ? 'file' : 'camera', requestedMetrics: REQUESTED_METRICS });
    try {
      sdk = await startSession({ apiKey, emit, onFrame, videoPath: VIDEO });
    } catch (e) {
      recorder = null;
      return { ok: false, message: `${e.codeName}: ${e.message}` };
    }
  }
  ticker = setInterval(onTick, CONFIG.monitor.tickMs);
  return { ok: true };
}

async function stop() {
  previewOn = false;
  calibration = null;
  clearInterval(ticker);
  ticker = null;
  lastValidation = null;
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

// ---------- Baseline ----------

function readBaseline() {
  let b = null;
  try { b = JSON.parse(fs.readFileSync(baselineFile(), 'utf8')); } catch { return null; }
  // A baseline learned from simulated data never counts for a real session.
  if (b?.simulated && !SIMULATED) return null;
  return b;
}

async function startCalibration() {
  const res = await start();
  if (!res.ok) return res;
  calibration = createCalibration(Date.now());
  return { ok: true };
}

async function finishCalibration() {
  const r = calibration.result;
  calibration = null;
  if (r.outcome !== 'done') {
    await stop();
    return send('calib:done', { ok: false, message: r.notes.join(' ') });
  }
  try {
    const baseline = { ...computeBaseline(r), calmSeconds: r.calmSeconds, notes: r.notes, gaps: r.gaps, simulated: SIMULATED };
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(baselineFile(), JSON.stringify(baseline, null, 2));
    send('calib:done', { ok: true, baseline });
  } catch (e) {
    await stop();
    send('calib:done', { ok: false, message: `Could not save the baseline: ${e.message}` });
  }
}

// ---------- Mock test ----------

let questions = null;
let questionsError = null;
try { questions = loadQuestions(QUESTION_FILE); } catch (e) { questionsError = e.message; }

function startTest(opts) {
  if (!questions) return { ok: false, message: `The question file could not be loaded: ${questionsError}` };
  if (!running()) return { ok: false, message: 'The camera is not on.' };
  const baseline = readBaseline();
  if (!baseline) return { ok: false, message: 'Learn your calm baseline first.' };
  const minutes = Number(opts?.minutes);
  if (!(minutes >= 1 && minutes <= 180)) return { ok: false, message: 'Test length must be 1 to 180 minutes.' };
  if (test) discardTest();
  const durationMs = Math.round(minutes * 60000);
  const startedAt = Date.now();
  const sessionObj = createTestSession({
    startedAt,
    durationMs,
    settings: { minutes, durationMs, quickDemo: minutes === CONFIG.test.quickDemoMinutes, questionFile: path.basename(QUESTION_FILE), coverage: CONFIG.coverage },
    baseline,
    questions,
    source: { mode: MODE, simulated: SIMULATED, recording: REPLAY ? path.basename(REPLAY) : null },
    lastValidation,
  });
  test = { session: sessionObj, startedAt, durationMs, result: null, finalizeTimer: null };
  return { ok: true, startedAt, durationMs };
}

function endTest(reason) {
  if (!test) return null;
  if (test.result) return test.result;
  test.session.end(Date.now(), reason);
  const { windows: _w, ...result } = test.session.result();
  test.result = result;
  send('test:ended', result);
  // Pulse samples arrive ~8 s late: keep measuring briefly, then save and turn the camera off.
  test.finalizeTimer = setTimeout(finalizeTest, CONFIG.test.lateSampleGraceSeconds * 1000);
  return result;
}

async function finalizeTest() {
  const t = test;
  if (!t?.result) return;
  clearTimeout(t.finalizeTimer);
  test = null;
  const full = t.session.finish();
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const file = path.join(sessionsDir(), `${full.startedAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(full));
    send('test:saved', { ok: true, file: path.basename(file), coverage: full.coverage, questions: full.questions });
  } catch (e) {
    send('test:saved', { ok: false, message: `Could not save the session: ${e.message}` });
  }
  await stop();
}

function discardTest() {
  if (test) clearTimeout(test.finalizeTimer);
  test = null;
}

// ---------- Data ----------

async function deleteAllData() {
  discardTest();
  await stop();
  fs.rmSync(dataDir(), { recursive: true, force: true }); // baseline.json and sessions/
  await session.defaultSession.clearStorageData();
  await session.defaultSession.clearCache();
  return true;
}

function dataInfo() {
  let sessions = 0;
  try { sessions = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json')).length; } catch { /* none yet */ }
  return { folder: dataDir(), sessions };
}

app.whenReady().then(() => {
  // The renderer never needs camera/mic/etc: capture happens natively in this process.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile('index.html');

  const handle = (channel, fn) => ipcMain.handle(channel, (e, arg) => {
    if (!win || e.sender !== win.webContents) throw new Error('denied');
    return fn(arg);
  });
  handle('app:info', () => ({ mode: MODE, simulated: SIMULATED, test: { defaultMinutes: CONFIG.test.defaultMinutes, quickDemoMinutes: CONFIG.test.quickDemoMinutes } }));
  handle('vitals:start', start);
  handle('vitals:stop', () => { discardTest(); return stop(); });
  handle('vitals:preview', (on) => { previewOn = on === true && !!sdk; });
  handle('calib:start', startCalibration);
  handle('baseline:get', readBaseline);
  handle('questions:get', () => (questions ? publicView(questions) : null));
  handle('test:start', startTest);
  handle('test:event', (e) => !!test && !test.result && test.session.event(Date.now(), e));
  handle('test:end', (reason) => endTest(reason === 'time_up' ? 'time_up' : 'submitted'));
  handle('data:info', dataInfo);
  handle('data:deleteAll', deleteAllData);
});

app.on('window-all-closed', async () => {
  if (test?.result) await finalizeTest(); // save an ended test without waiting for late samples
  await stop();
  app.quit();
});
