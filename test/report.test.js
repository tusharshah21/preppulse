'use strict';

// lib/report.js with hand-built sessions (synthetic, all times ms since test start).
const test = require('node:test');
const assert = require('node:assert');
const { buildReport, labelGaps, findRises, segments } = require('../lib/report');
const CONFIG = require('../lib/config');

const BANNED = /\b(stress\w*|anxi\w*|panic\w*|nervous\w*|diagnos\w*|at-risk|disorder\w*|healthy|unhealthy|good|bad|better|worse|normal|abnormal|poor\w*|well done)\b/i;

// One question per `secs` seconds; pulse(t) gives the bpm at second t (null = no stable sample).
function makeSession({ n = 6, secs = 60, pulse = () => 72, breathing = null, hrv = null, pauses = [], difficulty = () => 'medium', events = [], base = { pulseBpm: 72, breathingPerMin: 14, hrvRmssdMs: 40 } }) {
  const dur = n * secs * 1000;
  const ev = [{ t: 0, type: 'test_start' }];
  for (let i = 0; i < n; i++) ev.push({ t: i * secs * 1000, type: 'question_shown', q: i });
  ev.push(...events);
  ev.sort((a, b) => a.t - b.t);
  ev.push({ t: dur, type: 'test_end', reason: 'time_up' });
  const inPause = (t) => pauses.some((p) => t >= p.start && t < p.end);
  const ps = [];
  for (let s = 0; s < dur / 1000; s++) { const v = pulse(s); if (v != null && !inPause(s * 1000)) ps.push([s * 1000, v, 60, 1, Math.floor(s / secs)]); }
  const series = (fn, step) => { const out = []; if (!fn) return out; for (let s = 0; s < dur / 1000; s += step) { const v = fn(s); if (v != null && !inPause(s * 1000)) out.push([s * 1000, v, 60, 1, Math.floor(s / secs)]); } return out; };
  // Coverage per question as lib/session.js would compute it: pauses only (pulse is dense here).
  const questions = Array.from({ length: n }, (_, i) => {
    const a = i * secs * 1000;
    const b = a + secs * 1000;
    const paused = pauses.reduce((sum, p) => sum + Math.max(0, Math.min(b, p.end) - Math.max(a, p.start)), 0);
    const f = (secs * 1000 - paused) / (secs * 1000);
    return { q: i, id: `q${i}`, subject: 'Physics', difficulty: difficulty(i), timeMs: secs * 1000, answer: 0, correct: true, markedForReview: false,
      measuredMs: secs * 1000 - paused, coverage: f >= 0.9 ? 'full' : f <= 0.1 ? 'none' : 'partial', notMeasuredBecause: [] };
  });
  return {
    format: 'preppulse-session/1', startedAt: '2026-11-17T10:00:00.000Z', source: { simulated: false }, settings: { durationMs: dur },
    baseline: base, score: { correct: n, attempted: n, total: n }, events: ev, questions,
    gaps: { pauses: pauses.map((p) => ({ ...p, reason: p.reason || 'kChestNotVisible', hint: '' })), noStableReading: [] },
    samples: { pulse: ps, breathing: series(breathing, 9), hrv: series(hrv, 5) },
  };
}

const allText = (r) => [...r.observations, r.closing, r.notEnoughText, r.summaries.pulse, r.summaries.breathing, ...r.timeline.gaps.map((g) => g.label)].join(' ');

test('per-question median and peak change against the session baseline', () => {
  const r = buildReport(makeSession({ pulse: (s) => (s >= 120 && s < 180 ? 84 + (s % 3) : 72) }));
  const q2 = r.questions[2];
  assert.strictEqual(q2.status, 'ok');
  assert.strictEqual(q2.medianChange, 13);
  assert.strictEqual(q2.peakChange, 14);
  assert.strictEqual(r.questions[0].medianChange, 0);
});

test('"too brief to read": short on screen, or under 10 s of measured pulse', () => {
  const s = makeSession({});
  s.questions[1].timeMs = 12000; // on screen 12 s
  s.questions[2].measuredMs = 8000; // only 8 s measured
  s.questions[2].coverage = 'partial';
  s.questions[3].coverage = 'none';
  s.questions[3].measuredMs = 0;
  const r = buildReport(s);
  assert.deepStrictEqual(r.questions.slice(0, 4).map((q) => q.status), ['ok', 'too_brief', 'too_brief', 'not_measured']);
  assert.strictEqual(r.questions[1].medianChange, null, 'no number for a brief question');
});

test('gap labels: pauses are "not measured", the stretch after a pause is "pulse re-settling"', () => {
  const s = makeSession({});
  s.gaps.pauses = [{ start: 100000, end: 120000, reason: 'kChestNotVisible' }, { start: 200000, end: 205000, reason: 'kTooDark' }];
  s.gaps.noStableReading = [
    { start: 99500, end: 132000, reason: 'noStablePulse' }, // spans the pause and 12 s after it
    { start: 250000, end: 262000, reason: 'noStablePulse' }, // not near a pause
    { start: 10000, end: 70000, reason: 'noStableBreathing' }, // breathing gaps are not drawn on the pulse chart
  ];
  const g = labelGaps(s).map((x) => [x.kind, x.start, x.end, x.label]);
  assert.deepStrictEqual(g, [
    ['pause', 100000, 120000, 'not measured: moved out of view'],
    ['resettling', 120000, 132000, 'pulse re-settling'],
    ['pause', 200000, 205000, 'not measured: too dark'],
    ['no_reading', 250000, 262000, 'not measured: no steady pulse reading'],
  ]);
});

test('question reasons use report words: missing pulse next to a pause is re-settling', () => {
  const s = makeSession({});
  s.questions[0].notMeasuredBecause = ['no steady pulse reading', 'moved out of view'];
  s.questions[1].notMeasuredBecause = ['no steady pulse reading'];
  const r = buildReport(s);
  assert.deepStrictEqual(r.questions[0].notMeasuredBecause, ['moved out of view', 'pulse re-settling']);
  assert.deepStrictEqual(r.questions[1].notMeasuredBecause, ['no steady pulse reading']);
});

test('charts never join points across a pause or a long spacing', () => {
  const runs = segments([[0, 1], [1000, 2], [2000, 3], [30000, 4], [31000, 5]], 5000, [{ start: 1500, end: 1800 }]);
  assert.deepStrictEqual(runs.map((r) => r.length), [2, 1, 2]);
});

test('recovery time after a noticeable rise', () => {
  // +12 from 60 s to 100 s, then +6 for 10 s, then baseline.
  const run = [];
  for (let s = 0; s < 200; s++) run.push([s * 1000, s >= 60 && s < 100 ? 12 : s >= 100 && s < 110 ? 6 : 0]);
  const [rise] = findRises([run]);
  assert.strictEqual(rise.peak, 12);
  assert.strictEqual(rise.end, 99000);
  assert.strictEqual(rise.recoveryMs, 11000, 'from the last reading at +8 or more to the first within 4');
  // Too short to count (15 s), and a rise hidden by the end of the data.
  assert.deepStrictEqual(findRises([run.map(([t]) => [t, t >= 60000 && t < 75000 ? 12 : 0])]), []);
  const unfinished = findRises([run.filter(([t]) => t < 105000)]);
  assert.strictEqual(unfinished[0].recoveryMs, null);
  const r = buildReport(makeSession({ n: 4, pulse: (s) => (s >= 60 && s < 100 ? 84 : 72) }));
  assert.strictEqual(r.medianRecoveryMs, 1000);
});

test('observation: biggest rise names the question and what happened on it', () => {
  const r = buildReport(makeSession({
    pulse: (s) => (s >= 240 && s < 300 ? 88 : s >= 120 && s < 180 ? 82 : 72),
    events: [{ t: 245000, type: 'answer_changed', q: 4, option: 1, previous: 0 }, { t: 250000, type: 'answer_changed', q: 4, option: 2, previous: 1 }],
  }));
  assert.strictEqual(r.observations[0], 'Your pulse rose most on Q5 (+16 above your calm baseline) and Q3 (+10). You changed your answer twice on Q5.');
  const flat = buildReport(makeSession({ pulse: () => 74 }));
  assert.strictEqual(flat.observations[0], 'Your pulse stayed within 5 beats per minute of your calm baseline on every measured question.');
  const few = buildReport(makeSession({ n: 3 }));
  assert.ok(!few.observations.some((o) => /rose most|stayed within/.test(o)), 'needs minMeasuredQuestions');
});

test('observation: hard vs easy only with at least 3 measured of each', () => {
  const diff = (i) => (i < 3 ? 'hard' : 'easy');
  const r = buildReport(makeSession({ pulse: (s) => (s < 180 ? 81 : 73), difficulty: diff }));
  assert.ok(r.observations.includes('On hard-tagged questions your pulse was a median of +9 compared with your calm baseline, and +1 on easy ones.'), r.observations.join(' | '));
  const same = buildReport(makeSession({ pulse: () => 73, difficulty: diff }));
  assert.ok(same.observations.some((o) => /about the same on hard-tagged and easy/.test(o)));
  const two = buildReport(makeSession({ pulse: () => 73, difficulty: (i) => (i < 2 ? 'hard' : 'easy') }));
  assert.ok(!two.observations.some((o) => /hard-tagged/.test(o)));
});

test('observation: breathing last third vs first third, only with enough readings', () => {
  const r = buildReport(makeSession({ breathing: (s) => (s >= 240 ? 18 : 14) }));
  assert.ok(r.observations.includes('Your breathing rate was 18 breaths per minute in the last third of the test, compared with 14 in the first third.'), r.observations.join(' | '));
  assert.strictEqual(r.breathingSections.length, 3);
  // Only 2 readings in the last third: that third (and the observation) are left out.
  const sparse = buildReport(makeSession({ breathing: (s) => (s < 240 || s === 243 || s === 279 ? 14 : null) }));
  assert.ok(!sparse.breathingSections.some((x) => x.index === 2));
  assert.ok(!sparse.observations.some((o) => /breathing/i.test(o)));
});

test('observation: median recovery time, capped at 3 observations', () => {
  const r = buildReport(makeSession({ n: 8, pulse: (s) => (s % 120 >= 30 && s % 120 < 70 ? 84 : 72) }));
  assert.ok(r.rises.length >= 3);
  const rec = r.observations.find((o) => /come back close to your calm baseline/.test(o));
  assert.ok(rec, r.observations.join(' | '));
  assert.match(rec, /^After each rise, your pulse took a median of 1 second/);
  const all = buildReport(makeSession({ n: 8, pulse: (s) => (s % 120 >= 30 && s % 120 < 70 ? 84 : 72), breathing: (s) => (s >= 320 ? 18 : 14), difficulty: (i) => (i % 2 ? 'hard' : 'easy') }));
  assert.strictEqual(all.observations.length, CONFIG.report.maxObservations);
});

test('not enough data: no observations, a plain note, and HRV left out', () => {
  const r = buildReport(makeSession({ n: 2, pulse: () => null, base: { pulseBpm: 72, breathingPerMin: 14, hrvRmssdMs: null }, hrv: () => 40 }));
  assert.deepStrictEqual(r.observations, []);
  assert.strictEqual(r.enoughData, false);
  assert.strictEqual(r.notEnoughText, 'There was not enough measured data in this test to describe a pattern.');
  assert.deepStrictEqual(r.hrvHalves, [], 'no baseline HRV: no HRV comparison at all');
  assert.ok(r.questions.every((q) => q.status === 'not_measured'));
  const withHrv = buildReport(makeSession({ hrv: (s) => (s < 180 ? 38 : 34) }));
  assert.deepStrictEqual(withHrv.hrvHalves.map((h) => h.change), [-2, -6]);
});

test('no banned or judging words in any generated text', () => {
  const variants = [
    makeSession({ pulse: (s) => (s >= 240 && s < 300 ? 90 : 72), breathing: (s) => (s >= 240 ? 19 : 13), difficulty: (i) => (i % 2 ? 'hard' : 'easy'),
      events: [{ t: 241000, type: 'skipped', q: 4 }, { t: 100000, type: 'marked_for_review', q: 1, marked: true }],
      pauses: [{ start: 50000, end: 70000 }, { start: 150000, end: 160000, reason: 'kTooDark' }] }),
    makeSession({ pulse: () => 70 }),
    makeSession({ n: 2, pulse: () => null }),
    makeSession({ n: 8, pulse: (s) => (s % 120 >= 30 && s % 120 < 70 ? 84 : 72) }),
  ];
  for (const s of variants) {
    const text = allText(buildReport(s));
    assert.ok(!BANNED.test(text), `banned word in: ${text.match(BANNED)?.[0]} :: ${text}`);
  }
});
