'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const WAVE_WINDOW_US = 20e6; // sample timestamps are epoch microseconds
const WAVE_MAX_STEP_US = 1e6; // trace samples come every ~33 ms; a longer step is a gap
const SCREENS = ['consent', 'home', 'calibrate', 'ready', 'test', 'checkin', 'report', 'reset', 'support', 'settings'];

let info = { simulated: false, dataset: null, banner: null, preview: false, test: { defaultMinutes: 10, quickDemoMinutes: 4 }, reset: { inhaleSeconds: 4, exhaleSeconds: 6, cycles: 3 } };
let consentGiven = false; // asked again on every launch, never stored
let afterConsent = null;
let baseline = null;
let calibrating = false;
let wave = [];
let current = null; // visible screen

function show(id) {
  current = id;
  for (const s of SCREENS) $(s).hidden = s !== id;
  $('main').classList.toggle('wide', id === 'test' || id === 'report');
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
  renderPast();
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

$('redoBtn').addEventListener('click', async () => {
  readyIdle(); await window.vitals.setPreview(false); startCalibration(); });
$('readyBackBtn').addEventListener('click', async () => {
  readyIdle(); await stopCamera(); goHome(); });
function readyIdle() {
  clearTimeout(readyRetry);
  $('beginBtn').disabled = false;
  $('beginAnywayBtn').hidden = true;
  $('readyWait').hidden = true;
}
$('beginBtn').addEventListener('click', () => startTest(false));
$('beginAnywayBtn').addEventListener('click', () => startTest(true));

// ---------- Calm indicator ----------

window.vitals.on('measure:state', ({ state, text }) => {
  for (const i of $$('.indicator')) { i.dataset.state = state; i.textContent = text; }
});

// ---------- Test ----------

let T = null; // { qs, idx, answers[], marked[], visited[], endsAt, timer }

// The test waits for a steady pulse reading (main says so with waiting: true),
// retrying every second while this screen is open, unless the student starts anyway.
let readyRetry = null;
async function startTest(anyway) {
  clearTimeout(readyRetry);
  if (anyway === undefined && current !== 'ready') return; // a retry after leaving the screen
  const minutes = $('lenQuick').checked ? info.test.quickDemoMinutes : info.test.defaultMinutes;
  const res = await window.vitals.startTest({ minutes, anyway: anyway === true });
  if (!res.ok && res.waiting) {
    $('beginBtn').disabled = true;
    $('beginAnywayBtn').hidden = false;
    $('readyWait').hidden = false;
    $('readyWait').textContent = `${res.message}. The test starts by itself once your pulse reading is steady, usually within about a minute. Starting now means the first part may not be measured.`;
    if (current === 'ready') readyRetry = setTimeout(startTest, 1000);
    return;
  }
  readyIdle();
  if (!res.ok) { $('readyError').textContent = res.message; return; }
  await window.vitals.setPreview(false);
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
  $('countdown').textContent = $('resetTimeLeft').textContent = mmss(left);
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
  await closeReset();
  showCheckin(await window.vitals.endTest(reason));
}

// Main also ends the test when time is up, in case the window missed it.
window.vitals.on('test:ended', async (r) => { if (T) { clearInterval(T.timer); T = null; await closeReset(); showCheckin(r); } });

$('testResetBtn').addEventListener('click', () => openReset('test'));

// ---------- How did that test feel? (optional, after submitting) ----------

let savedReport = null; // the saved session's report, once main has written it
let saveError = null;

function showCheckin(r) {
  if (!r) return;
  endResult = r;
  savedReport = null;
  saveError = null;
  show('checkin');
}

function continueToReport() {
  if (savedReport) return showReport(savedReport);
  showEnd(endResult);
  if (saveError) $('rPending').textContent = saveError;
}

// The support screen follows ONLY from the student's own answer here. Nothing
// measured (pulse, breathing, HRV) can open it; see lib/checkin.js and CLAUDE.md.
for (const b of $$('#checkin [data-feeling]')) {
  b.addEventListener('click', async () => {
    const res = await window.vitals.checkin(b.dataset.feeling);
    if (res?.report) savedReport = res.report;
    if (res?.showSupport) return openSupport('postTest');
    continueToReport();
  });
}

// ---------- Support ----------

let supportBack = 'home';

function openSupport(from) {
  supportBack = from;
  $('supportCalm').hidden = from !== 'postTest';
  $('supportReportBtn').hidden = from !== 'postTest';
  $('supportBackBtn').textContent = from === 'postTest' ? 'Go to home' : 'Back';
  show('support');
}

for (const b of $$('.supportLink')) b.addEventListener('click', () => openSupport(current === 'settings' ? 'settings' : 'home'));
$('supportReportBtn').addEventListener('click', continueToReport);
$('supportBackBtn').addEventListener('click', () => {
  if (supportBack === 'settings') return $('settingsBtn').click();
  endResult = null;
  goHome();
});
// Phone numbers open the phone app (main checks the number); no website ever opens.
for (const a of $$('a.tel')) a.addEventListener('click', (e) => { e.preventDefault(); window.vitals.call(a.getAttribute('href')); });

// ---------- 30-second reset ----------

let R = null; // { from, inTest, timer, ended, startedCamera }

async function openReset(from) {
  if (R) return;
  const res = await window.vitals.resetStart();
  R = { from, inTest: res.inTest, timer: null, ended: false, startedCamera: false };
  $('resetTestNote').hidden = !res.inTest;
  $('resetCamBtn').hidden = res.camera;
  $('resetCamNote').hidden = true;
  $('resetPulse').textContent = '';
  $('resetDoneBtn').textContent = res.inTest ? 'Back to the test' : 'Back';
  $('resetCue').textContent = 'Get comfortable';
  $('resetCount').textContent = '';
  $('breathShape').hidden = true;
  wave = [];
  drawWave('resetWave', 0.6);
  show('reset');
  // Camera already on (during a test): start right away. Otherwise the student
  // picks "Show my breathing" (then the guide waits for the trace) or "Start without it".
  $('resetGoBtn').hidden = res.camera;
  if (res.camera) runDrill();
}

// Starts the guide once (from the button or when the breathing trace arrives).
async function beginDrill() {
  if (!R || R.started) return;
  R.waitingTrace = false;
  $('resetGoBtn').hidden = true;
  $('resetCamBtn').hidden = true;
  if (!R.inTest) await window.vitals.resetStart(); // the pulse line compares from the guide's start
  runDrill();
}
$('resetGoBtn').addEventListener('click', beginDrill);

// Paced breathing: inhale, exhale, a few cycles. No score, nothing to get right.
// With reduced motion the circle is replaced by a text countdown.
function runDrill() {
  R.started = true;
  const { inhaleSeconds, exhaleSeconds, cycles } = info.reset;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shape = $('breathShape');
  shape.hidden = reduced;
  shape.style.transitionDuration = '0s';
  shape.style.transform = 'scale(0.45)';
  const phases = [];
  for (let c = 0; c < cycles; c++) phases.push(['in', inhaleSeconds, c], ['out', exhaleSeconds, c]);
  let i = 0;
  let left = phases[0][1];
  const render = (fresh) => {
    const [kind, secs, c] = phases[i];
    if (fresh) {
      $('resetCue').textContent = kind === 'in' ? 'Breathe in' : 'Breathe out';
      requestAnimationFrame(() => { shape.style.transitionDuration = `${secs}s`; shape.style.transform = kind === 'in' ? 'scale(1)' : 'scale(0.45)'; });
    }
    $('resetCount').textContent = `${reduced ? `${left}... ` : ''}Breath ${c + 1} of ${cycles}`;
  };
  render(true);
  R.timer = setInterval(() => {
    left--;
    if (left > 0) return render(false);
    i++;
    if (i >= phases.length) return endDrill();
    left = phases[i][1];
    render(true);
  }, 1000);
}

async function endDrill() {
  if (!R || R.ended) return;
  clearInterval(R.timer);
  R.ended = true;
  $('resetCue').textContent = 'Done';
  $('resetCount').textContent = '';
  const res = await window.vitals.resetEnd();
  // One neutral line, only with enough data, and never during a test (no numbers there).
  if (R && !R.inTest && res?.pulseLine) $('resetPulse').textContent = res.pulseLine;
}

// Leaving early is fine; the end is recorded either way.
async function closeReset() {
  if (!R) return;
  await endDrill();
  const r = R;
  R = null;
  if (r.startedCamera) await stopCamera();
  return r;
}

$('resetDoneBtn').addEventListener('click', async () => {
  const r = await closeReset();
  if (!r) return;
  if (r.inTest && T) return show('test');
  if (r.from === 'report' && reportShown) return show('report');
  goHome();
});

$('resetCamBtn').addEventListener('click', () => withConsent(async () => {
  show('reset');
  if (!R) return;
  const res = await window.vitals.start();
  if (!res.ok) { $('resetCamNote').hidden = false; $('resetCamNote').textContent = res.message; return; }
  R.startedCamera = true;
  $('resetCamBtn').hidden = true;
  $('resetCamNote').hidden = false;
  if (R.started) return;
  R.waitingTrace = true;
  $('resetCue').textContent = 'Getting ready';
}));

$('homeResetBtn').addEventListener('click', () => openReset('home'));

// ---------- Report: Your pressure map ----------

let endResult = null;
let reportShown = null; // report object on screen

function reportHeader({ score, durationMs }) {
  $('rScore').textContent = `${score.correct} of ${score.total} correct`;
  $('rAttempted').textContent = `${score.attempted} answered`;
  $('rTime').textContent = mmss(durationMs);
}

// Right after the test: score and time; the rest once the session is saved.
function showEnd(r) {
  if (!r) return;
  endResult = r;
  reportShown = null;
  reportHeader(r);
  $('rMeasured').textContent = 'checking...';
  $('rPending').hidden = false;
  $('rPending').textContent = 'Finishing the last few seconds of measurement...';
  $('rBody').hidden = true;
  $('reportSim').hidden = true;
  show('report');
}

function showReport(report) {
  reportShown = report;
  reportHeader({ score: report.header.score, durationMs: report.header.durationMs });
  const h = report.header;
  // Counts exactly what the question tiles show.
  $('rMeasured').textContent = `${h.readCount} of ${h.questionCount} questions${h.briefCount ? ` (${h.briefCount} brief)` : ''}`;
  $('rLag').textContent = String(report.pulseLagSeconds);
  $('rSaid').hidden = !report.selfReport;
  $('rSaid').textContent = report.selfReport ? `You said: ${report.selfReport}` : '';
  $('rPending').hidden = true;
  $('reportSim').hidden = !report.simulated || info.simulated; // the top banner already says it in a simulated replay
  $('reportDemo').hidden = !report.dataset || !!info.dataset;
  $('reportDemo').textContent = report.dataset ? `Demo input: this report was made from a public research video (${report.dataset}), not a live webcam. The person in the video was not taking this test.` : '';
  $('reportMsg').textContent = '';
  $('rTip').hidden = true;
  $('rBody').hidden = false;
  show('report');
  window.ReportView.render(report, {
    chartCard: $('rChartCard'), pulseChart: $('rPulseChart'), breathChart: $('rBreathChart'), tip: $('rTip'),
    pulseSummary: $('pulse-sum'), breathSummary: $('breath-sum'), strip: $('rStrip'), obs: $('rObs'), closing: $('rClosing'),
    extras: $('rExtras'), resetBtn: $('resetBtn'),
  }, { onReset: () => openReset('report') });
}

window.vitals.on('test:saved', (s) => {
  if (!endResult) return;
  if (!s.ok) { saveError = s.message; if (current === 'report') $('rPending').textContent = s.message; return; }
  savedReport = s.report;
  if (current === 'report') showReport(s.report);
});

$('reportHomeBtn').addEventListener('click', () => { endResult = null; reportShown = null; savedReport = null; goHome(); });

$('pdfBtn').addEventListener('click', async () => {
  if (!reportShown) return;
  const details = $('rMeaning');
  const wasOpen = details.open;
  details.open = true; // the PDF includes the explanation
  $('reportMsg').textContent = '';
  const res = await window.vitals.saveReportPdf(reportShown.startedAt);
  details.open = wasOpen;
  if (res.ok) $('reportMsg').textContent = `Saved ${res.name}.`;
  else if (!res.canceled) $('reportMsg').textContent = `Could not save the PDF: ${res.message}`;
});

// ---------- Past practice tests ----------

// Sessions from a demo video are listed apart ("Demo sessions") and never count as the student's own.
async function renderPast() {
  const all = await window.vitals.listSessions();
  const demo = all.filter((s) => s.dataset);
  const list = all.filter((s) => !s.dataset);
  $('pastBox').hidden = !list.length;
  $('pastList').replaceChildren(...list.map(pastItem));
  $('demoBox').hidden = !demo.length;
  $('demoList').replaceChildren(...demo.map(pastItem));
  renderProgress(list);
}

function pastItem(s) {
  const li = el('li');
  const label = `${formatDate(s.startedAt)}: ${s.minutes}-minute test, ${s.score.correct} of ${s.score.total} correct${s.simulated ? ' (simulated data)' : ''}${s.dataset ? ` (demo input: ${s.dataset})` : ''}`;
  const b = el('button', label, 'link');
  b.addEventListener('click', async () => {
    const r = await window.vitals.openSession(s.file);
    if (!r.ok) { $('error').textContent = r.message; return; }
    endResult = null;
    showReport(r.report);
  });
  const del = el('button', 'Delete', 'link');
  del.setAttribute('aria-label', `Delete the practice test from ${formatDate(s.startedAt)}`);
  del.addEventListener('click', async () => {
    if (!confirm(`Delete the practice test from ${formatDate(s.startedAt)}? This removes its answers and measurements from this computer and cannot be undone.`)) return;
    await window.vitals.deleteSession(s.file);
    renderPast();
  });
  li.append(b, del);
  return li;
}

// Real sessions only; simulated ones are never mixed in (shown apart, in a simulated replay only).
function renderProgress(list) {
  const body = $('progressBody');
  const real = list.filter((s) => !s.simulated && !s.dataset).reverse();
  const sim = list.filter((s) => s.simulated).reverse();
  $('progressBox').hidden = false;
  body.replaceChildren();
  if (real.length >= 3) window.ReportView.progress(body, real);
  else body.append(el('p', 'Take 3 practice tests to see your patterns.'));
  if (info.simulated && sim.length >= 3) {
    body.append(el('h3', 'Simulated sessions (dev only, made-up data)'));
    const box = el('div');
    window.ReportView.progress(box, sim);
    body.append(box);
  }
}

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
  if (current !== 'calibrate' && current !== 'reset') return; // no numbers anywhere else, especially not during the test
  if (current === 'calibrate') {
    showRate('pulse', 'pulseNote', 'beats per minute', pulse);
    showRate('breathing', 'breathNote', 'breaths per minute', breathing);
  }
  const lastTs = wave.length ? wave[wave.length - 1][0] : -Infinity;
  for (const p of trace || []) if (p[0] > lastTs) wave.push(p);
  if (current === 'reset' && R?.waitingTrace && wave.length >= 2) beginDrill();
  if (wave.length) {
    const cutoff = wave[wave.length - 1][0] - WAVE_WINDOW_US;
    while (wave.length && wave[0][0] < cutoff) wave.shift();
  }
  if (current === 'calibrate') drawWave('wave', 2);
  else drawWave('resetWave', 3);
});

function drawWave(id, width) {
  const c = $(id);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (wave.length < 2) return;
  const vals = wave.map((p) => p[1]);
  const min = Math.min(...vals);
  const span = Math.max(...vals) - min || 1;
  const t1 = wave[wave.length - 1][0];
  g.strokeStyle = '#2f5bd3';
  g.lineWidth = width;
  g.beginPath();
  wave.forEach(([t, v], i) => {
    const x = c.width - ((t1 - t) / WAVE_WINDOW_US) * c.width;
    const y = c.height - 8 - ((v - min) / span) * (c.height - 16);
    // Never join the line across missing samples (a pause, or a video restart).
    i && t - wave[i - 1][0] <= WAVE_MAX_STEP_US ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
}

// ---------- Preview (memory only) ----------

let previewWanted = true;

// The preview exists only for the live camera. A dataset video never shows its frames.
const previewOffText = () => (info.dataset ? 'Preview not available for dataset video' : 'Preview not available in replay');

function resetPreview(wanted) {
  previewWanted = wanted;
  if (!info.preview) {
    for (const c of $$('.preview')) c.hidden = true;
    for (const m of $$('.previewMsg')) { m.hidden = false; m.textContent = previewOffText(); }
    for (const b of $$('.previewBtn')) b.hidden = true;
    return;
  }
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
  if (!info.preview || !previewWanted || !box) return;
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
  // One banner on every screen: SIMULATED DATA for a made-up recording, or the demo video it plays.
  if (i.banner) $('simBanner').textContent = i.banner;
  $('simBanner').hidden = !i.banner;
  document.body.classList.toggle('sim', !!i.banner);
  resetPreview(previewWanted);
});
show('consent');
