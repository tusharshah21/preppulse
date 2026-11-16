'use strict';

const $ = (id) => document.getElementById(id);
const CAL_SECONDS = 60;
const WAVE_WINDOW_US = 20e6; // sample timestamps are epoch microseconds

let consentGiven = false; // asked again on every launch, never stored
let baseline = null;
let cal = null;
let latest = {};
let wave = [];

function show(id) {
  for (const s of ['consent', 'home', 'calibrate', 'settings']) $(s).hidden = s !== id;
}

// ---------- Home ----------

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderBaseline() {
  const box = $('baselineBox');
  box.replaceChildren();
  const p = (text, cls) => { const el = document.createElement('p'); el.textContent = text; if (cls) el.className = cls; box.append(el); };
  if (!baseline) {
    p('You have not set a calm baseline yet. It takes a few minutes with the camera on.');
    $('calibrateBtn').textContent = 'Learn my calm baseline';
    return;
  }
  p(`Your calm baseline: pulse ${Math.round(baseline.pulseBpm)}, breathing ${Math.round(baseline.breathingPerMin)} per minute.`);
  p(baseline.hrvRmssdMs == null
    ? 'Heart-rate variability: not enough data yet.'
    : `Heart-rate variability (RMSSD): ${Math.round(baseline.hrvRmssdMs)} ms.`);
  p(`Saved ${formatDate(baseline.createdAt)}. Later sessions will be compared with these numbers, not with anyone else's.`, 'muted');
  $('calibrateBtn').textContent = 'Redo calibration';
}

async function goHome(message = '') {
  baseline = await window.vitals.getBaseline();
  renderBaseline();
  $('error').textContent = message;
  show('home');
}

// ---------- Consent ----------

$('agreeBtn').addEventListener('click', () => { consentGiven = true; startCalibration(); });
$('notNowBtn').addEventListener('click', () => goHome());
$('calibrateBtn').addEventListener('click', () => (consentGiven ? startCalibration() : show('consent')));

// ---------- Calibration ----------

const gateOpen = () => latest.status === 'kRunning' && latest.ok && latest.pulse?.stable && latest.breathing?.stable;

function collect(kind, s, value) {
  if (!cal || !s?.stable || !Number.isFinite(value) || cal.seen[kind].has(s.timestamp)) return;
  cal.seen[kind].add(s.timestamp);
  cal[kind].push(value);
}

function collectLatest() {
  collect('pulse', latest.pulse, latest.pulse?.value);
  collect('breathing', latest.breathing, latest.breathing?.value);
  collect('hrv', latest.hrv, latest.hrv?.rmssd);
}

async function startCalibration() {
  latest = {};
  wave = [];
  cal = { seconds: 0, pulse: [], breathing: [], hrv: [], seen: { pulse: new Set(), breathing: new Set(), hrv: new Set() }, lastTick: performance.now(), timer: null };
  $('calError').textContent = '';
  $('hint').textContent = 'Starting camera...';
  $('pulse').textContent = '--';
  $('breathing').textContent = '--';
  setProgress(0);
  resetPreview(true);
  show('calibrate');
  const res = await window.vitals.start();
  if (!res.ok) { cal = null; return goHome(res.message); }
  window.vitals.setPreview(previewWanted);
  cal.timer = setInterval(tick, 250);
}

function setProgress(sec) {
  $('calProgress').value = sec;
  $('calSeconds').textContent = Math.floor(sec);
}

function tick() {
  if (!cal) return;
  const now = performance.now();
  const dt = (now - cal.lastTick) / 1000;
  cal.lastTick = now;
  if (gateOpen()) {
    collectLatest();
    cal.seconds = Math.min(CAL_SECONDS, cal.seconds + dt);
    $('hint').textContent = 'Measuring. Keep breathing normally.';
  } else if (latest.status !== 'kRunning') {
    $('hint').textContent = 'Starting camera...';
  } else if (!latest.ok) {
    $('hint').textContent = `Paused: ${latest.hint || 'looking for your face'}`;
  } else {
    $('hint').textContent = 'Good position. Hold still while the readings settle...';
  }
  setProgress(cal.seconds);
  if (cal.seconds >= CAL_SECONDS) finishCalibration();
}

async function endSession() {
  if (cal?.timer) clearInterval(cal.timer);
  await window.vitals.setPreview(false);
  await window.vitals.stop();
}

async function finishCalibration() {
  const { seconds, pulse, breathing, hrv } = cal;
  await endSession();
  cal = null;
  try {
    await window.vitals.saveBaseline({ seconds, pulse, breathing, hrv });
    await goHome();
  } catch (e) {
    await goHome(`Could not save the baseline: ${e.message}`);
  }
}

$('cancelBtn').addEventListener('click', async () => {
  await endSession();
  cal = null;
  goHome();
});

// ---------- Live data ----------

window.vitals.on('vitals:status', (s) => { latest.status = s; });

window.vitals.on('vitals:validation', ({ ok, hint }) => { latest.ok = ok; latest.hint = hint; });

window.vitals.on('vitals:error', ({ code, message }) => {
  $('calError').textContent = `The measurement reported a problem (${code}): ${message}`;
});

function showRate(el, note, unit, s) {
  if (!s || s.value == null) return;
  $(el).textContent = Math.round(s.value);
  $(note).textContent = s.stable ? unit : `${unit} (settling)`;
}

window.vitals.on('vitals:metrics', ({ pulse, breathing, hrv, trace }) => {
  if (pulse) latest.pulse = pulse;
  if (breathing) latest.breathing = breathing;
  if (hrv) latest.hrv = hrv;
  if (gateOpen()) collectLatest();
  showRate('pulse', 'pulseNote', 'beats per minute', pulse);
  showRate('breathing', 'breathNote', 'breaths per minute', breathing);
  const lastTs = wave.length ? wave[wave.length - 1][0] : -Infinity;
  for (const p of trace) if (p[0] > lastTs) wave.push(p);
  if (wave.length) {
    const cutoff = wave[wave.length - 1][0] - WAVE_WINDOW_US;
    while (wave.length && wave[0][0] < cutoff) wave.shift();
  }
  drawWave();
});

function drawWave() {
  const c = $('wave');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (wave.length < 2) return;
  const vals = wave.map((p) => p[1]);
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const t1 = wave[wave.length - 1][0];
  g.strokeStyle = '#2f5bd3';
  g.lineWidth = 2;
  g.beginPath();
  wave.forEach(([t, v], i) => {
    const x = c.width - ((t1 - t) / WAVE_WINDOW_US) * c.width;
    const y = c.height - 8 - ((v - min) / span) * (c.height - 16);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

// ---------- Preview (memory only) ----------

let previewWanted = true;

function resetPreview(wanted) {
  previewWanted = wanted;
  $('preview').hidden = true;
  $('previewMsg').hidden = false;
  $('previewMsg').textContent = wanted ? 'Camera preview will appear here' : 'Preview hidden';
  $('previewBtn').textContent = wanted ? 'Hide preview' : 'Show preview';
}

$('previewBtn').addEventListener('click', () => {
  resetPreview(!previewWanted);
  if (cal) window.vitals.setPreview(previewWanted);
});

window.vitals.on('vitals:frame', ({ width, height, data }) => {
  if (!previewWanted || !cal) return;
  const c = $('preview');
  if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height), 0, 0);
  c.hidden = false;
  $('previewMsg').hidden = true;
});

// ---------- Settings ----------

$('settingsBtn').addEventListener('click', async () => {
  $('dataFolder').textContent = (await window.vitals.dataInfo()).folder;
  $('deleteMsg').textContent = '';
  show('settings');
});

$('backBtn').addEventListener('click', () => goHome());

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm('Delete all PrepPulse data on this computer? This removes your saved baseline and cannot be undone.')) return;
  await window.vitals.deleteAllData();
  baseline = null;
  $('deleteMsg').textContent = 'Done. All PrepPulse data on this computer has been deleted.';
});

show('consent');
