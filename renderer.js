'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const WAVE_WINDOW_US = 20e6; // sample timestamps are epoch microseconds
const SCREENS = ['consent', 'home', 'calibrate', 'ready', 'test', 'end', 'settings'];

let info = { simulated: false, test: { defaultMinutes: 10, quickDemoMinutes: 4 } };
let consentGiven = false; // asked again on every launch, never stored
let afterConsent = null;
let baseline = null;
let calibrating = false;
let wave = [];
let current = null; // visible screen

function show(id) {
  current = id;
  for (const s of SCREENS) $(s).hidden = s !== id;
  $('main').classList.toggle('wide', id === 'test');
}

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Neutral baseline summary, used on home and on "Before you begin".
function baselineLines(box) {
  box.replaceChildren();
  if (!baseline) { box.append(el('p', 'You have not set a calm baseline yet. It takes about two minutes with the camera on.')); return; }
  const b = baseline;
  const breath = b.breathingPerMin == null ? 'breathing: not enough data yet' : `breathing ${Math.round(b.breathingPerMin)} per minute`;
  box.append(el('p', `Your calm baseline: pulse ${Math.round(b.pulseBpm)}, ${breath}.`));
  box.append(el('p', b.hrvRmssdMs == null ? 'Heart-rate variability: not enough data yet.' : `Heart-rate variability (RMSSD): ${Math.round(b.hrvRmssdMs)} ms.`));
  for (const n of b.notes || []) if (!/not enough data yet/.test(n)) box.append(el('p', n, 'notes'));
  box.append(el('p', `Saved ${formatDate(b.createdAt)}. Your sessions are compared with these numbers, not with anyone else's.`, 'muted'));
}

async function goHome(message = '') {
  baseline = await window.vitals.getBaseline();
  baselineLines($('baselineBox'));
  $('calibrateBtn').textContent = baseline ? 'Redo calibration' : 'Learn my calm baseline';
  $('error').textContent = message;
  show('home');
}

// ---------- Consent ----------

function withConsent(fn) {
  if (consentGiven) return fn();
  afterConsent = fn;
  show('consent');
}

$('agreeBtn').addEventListener('click', () => { consentGiven = true; const fn = afterConsent; afterConsent = null; (fn || startCalibration)(); });
$('notNowBtn').addEventListener('click', () => { afterConsent = null; goHome(); });
$('calibrateBtn').addEventListener('click', () => withConsent(startCalibration));
$('practiceBtn').addEventListener('click', () => withConsent(startPractice));

// Calibrate first unless there is a baseline from today.
async function startPractice() {
  baseline = await window.vitals.getBaseline();
  if (!baseline || !isToday(baseline.createdAt)) return startCalibration();
  const res = await window.vitals.start();
  if (!res.ok) return goHome(res.message);
  showReady();
}

// ---------- Calibration (driven by the main process) ----------

async function startCalibration() {
  wave = [];
  calibrating = true;
  $('calError').textContent = '';
  $('hint').textContent = 'Starting camera...';
  $('pulse').textContent = '--';
  $('breathing').textContent = '--';
  renderCalib({ calmSeconds: { pulse: 0, breathing: 0 }, target: 60 });
  show('calibrate');
  const res = await window.vitals.startCalibration();
  if (!res.ok) { calibrating = false; return goHome(res.message); }
  window.vitals.setPreview(previewWanted);
}

function renderCalib(s) {
  for (const t of $$('.calTarget')) t.textContent = s.target;
  $('calPulse').max = $('calBreath').max = s.target;
  $('calPulse').value = Math.min(s.target, s.calmSeconds.pulse);
  $('calBreath').value = Math.min(s.target, s.calmSeconds.breathing);
  $('calPulseSec').textContent = Math.min(s.target, s.calmSeconds.pulse);
  $('calBreathSec').textContent = Math.min(s.target, s.calmSeconds.breathing);
  if (s.hint) $('hint').textContent = s.hint;
}

window.vitals.on('calib:state', (s) => { if (calibrating) renderCalib(s); });

window.vitals.on('calib:done', async (r) => {
  if (!calibrating) return;
  calibrating = false;
  if (!r.ok) { await window.vitals.setPreview(false); return goHome(r.message); }
  baseline = r.baseline;
  showReady();
});

async function stopCamera() {
  calibrating = false;
  await window.vitals.setPreview(false);
  await window.vitals.stop();
}

$('cancelBtn').addEventListener('click', async () => { await stopCamera(); goHome(); });

// ---------- Before you begin ----------

let questionSet = null;

async function showReady() {
  questionSet = questionSet || await window.vitals.getQuestions();
  baselineLines($('readyBaseline'));
  $('qCount').textContent = questionSet ? questionSet.questions.length : 0;
  $('lenFullText').textContent = `${info.test.defaultMinutes} minutes`;
  $('lenQuickText').textContent = `${info.test.quickDemoMinutes}-minute quick demo`;
  $('readyError').textContent = questionSet ? '' : 'The question file could not be loaded.';
  resetPreview(previewWanted);
  show('ready');
  window.vitals.setPreview(previewWanted);
}

$('redoBtn').addEventListener('click', async () => { await window.vitals.setPreview(false); startCalibration(); });
$('readyBackBtn').addEventListener('click', async () => { await stopCamera(); goHome(); });
$('beginBtn').addEventListener('click', startTest);

// ---------- Calm indicator ----------

window.vitals.on('measure:state', ({ state, text }) => {
  for (const i of $$('.indicator')) { i.dataset.state = state; i.textContent = text; }
});

// ---------- Test ----------

let T = null; // { qs, idx, answers[], marked[], visited[], endsAt, timer }

async function startTest() {
  const minutes = $('lenQuick').checked ? info.test.quickDemoMinutes : info.test.defaultMinutes;
  await window.vitals.setPreview(false);
  const res = await window.vitals.startTest({ minutes });
  if (!res.ok) { $('readyError').textContent = res.message; return; }
  const n = questionSet.questions.length;
  T = { qs: questionSet.questions, idx: 0, answers: new Array(n).fill(null), marked: new Array(n).fill(false), visited: new Array(n).fill(false), endsAt: Date.now() + res.durationMs, timer: null };
  $('testTitle').textContent = questionSet.title;
  show('test');
  goTo(0, null);
  T.timer = setInterval(tickCountdown, 250);
  tickCountdown();
}

function tickCountdown() {
  if (!T) return;
  const left = T.endsAt - Date.now();
  $('countdown').textContent = mmss(left);
  if (left <= 0) finishTest('time_up');
}

function goTo(i, via) {
  if (via) window.vitals.testEvent({ type: 'navigate', from: T.idx, q: i, via });
  T.idx = i;
  T.visited[i] = true;
  window.vitals.testEvent({ type: 'question_shown', q: i });
  renderQuestion();
}

function renderQuestion() {
  const q = T.qs[T.idx];
  $('qNum').textContent = `Question ${T.idx + 1} of ${T.qs.length}`;
  $('qSubject').textContent = q.subject;
  $('qText').textContent = q.text;
  const box = $('options');
  box.replaceChildren();
  q.options.forEach((opt, k) => {
    const label = el('label');
    const input = el('input');
    input.type = 'radio';
    input.name = 'opt';
    input.checked = T.answers[T.idx] === k;
    input.addEventListener('change', () => {
      T.answers[T.idx] = k;
      window.vitals.testEvent({ type: 'answer_selected', q: T.idx, option: k });
      renderPalette();
    });
    label.append(input, el('span', `${'ABCD'[k]}. ${opt}`));
    box.append(label);
  });
  $('prevBtn').disabled = T.idx === 0;
  $('markBtn').textContent = T.marked[T.idx] ? 'Unmark review' : 'Mark for review';
  renderPalette();
}

function statusOf(i) {
  if (!T.visited[i]) return 'notVisited';
  const a = T.answers[i] != null;
  if (T.marked[i]) return a ? 'answeredMarked' : 'marked';
  return a ? 'answered' : 'notAnswered';
}

const STATUS_TEXT = { notVisited: 'not visited', notAnswered: 'not answered', answered: 'answered', marked: 'marked for review', answeredMarked: 'answered and marked for review' };

function renderPalette() {
  const p = $('palette');
  p.replaceChildren();
  T.qs.forEach((_, i) => {
    const st = statusOf(i);
    const b = el('button', String(i + 1), `st-${st}${i === T.idx ? ' current' : ''}`);
    b.setAttribute('aria-label', `Question ${i + 1}, ${STATUS_TEXT[st]}`);
    b.addEventListener('click', () => { if (i !== T.idx) goTo(i, 'palette'); });
    p.append(b);
  });
}

$('prevBtn').addEventListener('click', () => { if (T.idx > 0) goTo(T.idx - 1, 'previous'); });
$('nextBtn').addEventListener('click', () => {
  if (T.answers[T.idx] == null) window.vitals.testEvent({ type: 'skipped', q: T.idx });
  if (T.idx < T.qs.length - 1) goTo(T.idx + 1, 'next');
});
$('clearBtn').addEventListener('click', () => {
  if (T.answers[T.idx] == null) return;
  T.answers[T.idx] = null;
  window.vitals.testEvent({ type: 'answer_cleared', q: T.idx });
  renderQuestion();
});
$('markBtn').addEventListener('click', () => {
  T.marked[T.idx] = !T.marked[T.idx];
  window.vitals.testEvent({ type: 'marked_for_review', q: T.idx, marked: T.marked[T.idx] });
  renderQuestion();
});
$('submitBtn').addEventListener('click', () => {
  const left = T.answers.filter((a) => a == null).length;
  if (confirm(left ? `Submit the test? ${left} question${left === 1 ? ' is' : 's are'} not answered.` : 'Submit the test?')) finishTest('submitted');
});

async function finishTest(reason) {
  if (!T) return;
  clearInterval(T.timer);
  T = null;
  showEnd(await window.vitals.endTest(reason));
}

// Main also ends the test when time is up, in case the window missed it.
window.vitals.on('test:ended', (r) => { if (T) { clearInterval(T.timer); T = null; showEnd(r); } });

// ---------- End ----------

let endResult = null;

function showEnd(r) {
  if (!r || (current === 'end' && endResult)) return;
  endResult = r;
  $('endReason').textContent = r.durationMs >= 0 ? `Time used: ${mmss(r.durationMs)}.` : '';
  $('endScore').textContent = `${r.score.correct} of ${r.score.total} correct`;
  $('endAttempted').textContent = `You answered ${r.score.attempted} of ${r.score.total} questions.`;
  $('endCoverage').textContent = 'Finishing the last few seconds of measurement...';
  renderEndRows(r.perQuestion, null);
  show('end');
}

function measurementText(row) {
  if (!row) return 'checking...';
  const why = row.notMeasuredBecause.length ? ` (not measured: ${row.notMeasuredBecause.join(', ')})` : '';
  if (row.coverage === 'full') return 'measured fully';
  if (row.coverage === 'partial') return `measured partly${why}`;
  if (row.coverage === 'none') return `not measured${why ? `: ${row.notMeasuredBecause.join(', ')}` : ''}`;
  return 'not shown';
}

function renderEndRows(perQuestion, saved) {
  const body = $('endRows');
  body.replaceChildren();
  for (const r of perQuestion) {
    const tr = el('tr');
    const ans = r.answer == null ? 'not answered' : `${'ABCD'[r.answer]}, ${r.correct ? 'correct' : 'not correct'}`;
    const m = saved ? measurementText(saved[r.q]) : 'checking...';
    for (const text of [r.q + 1, r.subject, r.timeMs ? mmss(r.timeMs) : 'not shown', ans, r.timeMs ? m : '']) tr.append(el('td', String(text)));
    body.append(tr);
  }
}

window.vitals.on('test:saved', (s) => {
  if (!endResult) return;
  if (!s.ok) { $('endCoverage').textContent = s.message; return; }
  const c = s.coverage;
  $('endCoverage').textContent = `Measurement: ${c.full} question${c.full === 1 ? '' : 's'} measured fully, ${c.partial} partly, ${c.none} not at all${c.not_shown ? ` (${c.not_shown} not shown)` : ''}. Saved on this computer.`;
  renderEndRows(endResult.perQuestion, s.questions);
});

$('endHomeBtn').addEventListener('click', () => { endResult = null; goHome(); });

// ---------- Live data on the calibration screen ----------

window.vitals.on('vitals:error', ({ code, message }) => {
  if (calibrating) $('calError').textContent = `The measurement reported a problem (${code}): ${message}`;
});

function showRate(id, note, unit, s) {
  if (!s || s.value == null) return;
  $(id).textContent = Math.round(s.value);
  $(note).textContent = s.stable ? unit : `${unit} (settling)`;
}

window.vitals.on('vitals:metrics', ({ pulse, breathing, trace }) => {
  if (current !== 'calibrate') return; // no numbers anywhere else, especially not during the test
  showRate('pulse', 'pulseNote', 'beats per minute', pulse);
  showRate('breathing', 'breathNote', 'breaths per minute', breathing);
  const lastTs = wave.length ? wave[wave.length - 1][0] : -Infinity;
  for (const p of trace || []) if (p[0] > lastTs) wave.push(p);
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
  for (const c of $$('.preview')) c.hidden = true;
  for (const m of $$('.previewMsg')) { m.hidden = false; m.textContent = wanted ? 'Camera preview will appear here' : 'Preview hidden'; }
  for (const b of $$('.previewBtn')) b.textContent = wanted ? 'Hide preview' : 'Show preview';
}

for (const b of $$('.previewBtn')) {
  b.addEventListener('click', () => {
    resetPreview(!previewWanted);
    window.vitals.setPreview(previewWanted);
  });
}

window.vitals.on('vitals:frame', ({ width, height, data }) => {
  const box = current && $(current).querySelector('.previewBox');
  if (!previewWanted || !box) return;
  const c = box.querySelector('.preview');
  if (c.width !== width || c.height !== height) { c.width = width; c.height = height; }
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height), 0, 0);
  c.hidden = false;
  box.querySelector('.previewMsg').hidden = true;
});

// ---------- Settings ----------

$('settingsBtn').addEventListener('click', async () => {
  const d = await window.vitals.dataInfo();
  $('dataFolder').textContent = d.folder;
  $('dataCount').textContent = `${d.sessions} saved practice session${d.sessions === 1 ? '' : 's'}.`;
  $('deleteMsg').textContent = '';
  show('settings');
});

$('backBtn').addEventListener('click', () => goHome());

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm('Delete all PrepPulse data on this computer? This removes your saved baseline and all practice sessions, and cannot be undone.')) return;
  await window.vitals.deleteAllData();
  baseline = null;
  $('dataCount').textContent = '0 saved practice sessions.';
  $('deleteMsg').textContent = 'Done. All PrepPulse data on this computer has been deleted.';
});

// ---------- Start ----------

window.vitals.info().then((i) => {
  info = i;
  $('simBanner').hidden = !i.simulated;
  document.body.classList.toggle('sim', i.simulated);
});
show('consent');
