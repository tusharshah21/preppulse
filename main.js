'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, session, dialog, shell } = require('electron');
const CONFIG = require('./lib/config');
const { startSession, stopSession, downscaleToRGBA, REQUESTED_METRICS } = require('./lib/vitals');
const { createRecorder, loadRecording, play } = require('./lib/recording');
const { computeBaseline } = require('./lib/baseline');
const { createCalibration, measureState } = require('./lib/calibration');
const { loadQuestions, publicView } = require('./lib/questions');
const { createTestSession } = require('./lib/session');
const { buildReport } = require('./lib/report');
const { resetPulseLine } = require('./lib/reset');
const { isFeeling, selfReport, needsSupportScreen } = require('./lib/checkin');

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
let test = null; // { session, timer, result, finalizeTimer, checkin }
let recentPulse = []; // stable pulse [sample time ms epoch, bpm], last 2 minutes, for the reset line
let reset = null; // { startMs, inTest }
let lastSaved = null; // file name of the session saved last, for a late check-in answer

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
    if (data.pulse?.stable) {
      lastStablePulseAt = t;
      recentPulse.push([data.pulse.timestamp / 1000, data.pulse.value]);
      recentPulse = recentPulse.filter(([ts]) => ts > t - 120000);
    }
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


function onTick() {
  const now = Date.now();
  send('measure:state', measureState(now, lastValidation, lastStablePulseAt));
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
  recentPulse = [];
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
  // Wait for a steady pulse unless the student chose to start anyway.
  const m = measureState(Date.now(), lastValidation, lastStablePulseAt);
  if (m.state !== 'measuring' && !opts?.anyway) return { ok: false, waiting: true, message: m.text };
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
    if (t.checkin) full.selfReport = t.checkin;
    fs.writeFileSync(file, JSON.stringify(full));
    lastSaved = path.basename(file);
    send('test:saved', { ok: true, file: path.basename(file), report: buildReport(full) });
  } catch (e) {
    send('test:saved', { ok: false, message: `Could not save the session: ${e.message}` });
  }
  await stop();
}

// ---------- 30-second reset ----------

// During a test the timer keeps running; the reset is recorded as two events.
function resetStart() {
  const inTest = !!test && !test.result;
  reset = { startMs: Date.now(), inTest };
  if (inTest) test.session.event(reset.startMs, { type: 'reset_start' });
  return { ok: true, inTest, camera: running() };
}

function resetEnd() {
  if (!reset) return { ok: false };
  const r = reset;
  reset = null;
  const now = Date.now();
  if (r.inTest && test && !test.result) test.session.event(now, { type: 'reset_end' });
  return { ok: true, pulseLine: resetPulseLine(recentPulse, readBaseline()?.pulseBpm, r.startMs, now) };
}

// ---------- Self check-in ----------

// The support screen follows ONLY from the student's own answer (lib/checkin.js).
function checkin(feeling) {
  if (!isFeeling(feeling)) return { ok: false };
  const sr = selfReport(feeling);
  const out = { ok: true, showSupport: needsSupportScreen(feeling) };
  if (test?.result) { test.checkin = sr; return out; } // saved with the session in a few seconds
  if (!lastSaved) return out;
  try {
    const file = path.join(sessionsDir(), lastSaved);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    s.selfReport = sr;
    fs.writeFileSync(file, JSON.stringify(s));
    out.report = buildReport(s);
  } catch { /* deleted meanwhile: nothing to update */ }
  return out;
}

function discardTest() {
  if (test) clearTimeout(test.finalizeTimer);
  test = null;
}

// ---------- Past sessions and reports ----------

const SESSION_FILE = /^[0-9TZ-]+\.json$/;

// ponytail: parses every session file for the list; add an index file if there are hundreds.
function listSessions() {
  let files = [];
  try { files = fs.readdirSync(sessionsDir()).filter((f) => SESSION_FILE.test(f)); } catch { return []; }
  const out = [];
  for (const file of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), file), 'utf8'));
      if (s.format !== 'preppulse-session/1') continue;
      out.push({ file, startedAt: s.startedAt, minutes: s.settings?.minutes, score: s.score, simulated: !!s.source?.simulated, summary: buildReport(s).summary });
    } catch { /* unreadable file: skip */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function openSession(file) {
  // The name comes from the window: only plain session file names inside sessions/.
  if (typeof file !== 'string' || !SESSION_FILE.test(file)) return { ok: false, message: 'Not a session file.' };
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessionsDir(), file), 'utf8'));
    if (s.format !== 'preppulse-session/1') return { ok: false, message: 'Not a session file.' };
    return { ok: true, report: buildReport(s) };
  } catch (e) {
    return { ok: false, message: `Could not open that session: ${e.message}` };
  }
}

function deleteSession(file) {
  if (typeof file !== 'string' || !SESSION_FILE.test(file)) return false;
  fs.rmSync(path.join(sessionsDir(), file), { force: true });
  if (lastSaved === file) lastSaved = null;
  return true;
}

// Phone numbers on the support screen; nothing else leaves the app.
const TEL = /^tel:[0-9-]{3,20}$/;
const callNumber = (url) => { if (typeof url === 'string' && TEL.test(url)) shell.openExternal(url); };

// Saves only where the student picks in the save dialog; nothing is written otherwise.
async function saveReportPdf(startedAt) {
  const day = typeof startedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(startedAt) ? startedAt.slice(0, 10) : 'report';
  const res = await dialog.showSaveDialog(win, {
    title: 'Save report as PDF',
    defaultPath: path.join(app.getPath('documents'), `PrepPulse pressure map ${day}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(res.filePath, pdf);
    return { ok: true, name: path.basename(res.filePath) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ---------- Data ----------

async function deleteAllData() {
  discardTest();
  await stop();
  fs.rmSync(dataDir(), { recursive: true, force: true }); // baseline.json and sessions/
  lastSaved = null;
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
  // The window never navigates or opens pages; tel: links go to the phone app.
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); callNumber(url); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile('index.html');

  const handle = (channel, fn) => ipcMain.handle(channel, (e, arg) => {
    if (!win || e.sender !== win.webContents) throw new Error('denied');
    return fn(arg);
  });
  handle('app:info', () => ({ mode: MODE, simulated: SIMULATED, test: { defaultMinutes: CONFIG.test.defaultMinutes, quickDemoMinutes: CONFIG.test.quickDemoMinutes }, reset: CONFIG.reset }));
  handle('vitals:start', start);
  handle('vitals:stop', () => { discardTest(); return stop(); });
  handle('vitals:preview', (on) => { previewOn = on === true && !!sdk; });
  handle('calib:start', startCalibration);
  handle('baseline:get', readBaseline);
  handle('questions:get', () => (questions ? publicView(questions) : null));
  handle('test:start', startTest);
  handle('test:event', (e) => !!test && !test.result && test.session.event(Date.now(), e));
  handle('test:end', (reason) => endTest(reason === 'time_up' ? 'time_up' : 'submitted'));
  handle('sessions:list', listSessions);
  handle('sessions:open', openSession);
  handle('sessions:delete', deleteSession);
  handle('reset:start', resetStart);
  handle('reset:end', resetEnd);
  handle('test:checkin', checkin);
  handle('support:call', callNumber);
  handle('report:pdf', saveReportPdf);
  handle('data:info', dataInfo);
  handle('data:deleteAll', deleteAllData);
});

app.on('window-all-closed', async () => {
  if (test?.result) await finalizeTest(); // save an ended test without waiting for late samples
  await stop();
  app.quit();
});
