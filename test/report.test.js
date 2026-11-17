'use strict';

// lib/report.js with hand-built sessions (synthetic, all times ms since test start).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildReport, labelGaps, findRises, segments, aboutDuration } = require('../lib/report');
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

test('short questions show a value labelled brief; "too brief to read" only with no usable reading', () => {
  const s = makeSession({ pulse: () => 80 });
  s.questions[1].timeMs = 12000; // on screen 12 s: a value, labelled brief
  // Q3 (120 to 180 s, analysed 126 to 186 s with the lag): a pause leaves only 8 s measured: brief.
  // Q5 (240 to 300 s, analysed 246 to 306 s): a pause leaves 3 s: not measured.
  s.gaps.pauses = [{ start: 126000, end: 178000, reason: 'kChestNotVisible' }, { start: 246000, end: 303000, reason: 'kChestNotVisible' }];
  s.questions[2].coverage = 'partial';
  s.questions[3].coverage = 'none';
  s.questions[3].measuredMs = 0;
  s.questions[4].coverage = 'partial';
  s.questions[5].timeMs = 5000; // under 6 s on screen: too brief to read
  const r = buildReport(s);
  assert.strictEqual(r.questions[2].measuredSeconds, 8);
  assert.deepStrictEqual(r.questions.map((q) => q.status), ['ok', 'ok', 'ok', 'not_measured', 'not_measured', 'too_brief']);
  assert.deepStrictEqual(r.questions.map((q) => q.brief), [false, true, true, false, false, false]);
  assert.strictEqual(r.questions[1].medianChange, 8, 'a brief question still shows its value');
  assert.strictEqual(r.questions[5].medianChange, null);
  // The header counts exactly what the tiles show.
  assert.deepStrictEqual([r.header.readCount, r.header.briefCount], [3, 2]);
});

test('Run 1 shape: a 7 s rise on short questions is found, named by the tiles, and its settle time read', () => {
  // Questions of 8 s; pulse +20 for 7 s (Q5's lag-shifted window), back at baseline 2 s later.
  const pulse = (s) => (s >= 40 && s < 47 ? 92 : 72);
  const r = buildReport(makeSession({ n: 10, secs: 8, pulse }));
  assert.strictEqual(r.rises.length, 1);
  assert.match(r.observations[0], /^Your pulse rose most around Q5 (and Q6 )?\(\+20 above your calm baseline\)\.$/);
  assert.strictEqual(r.observations[1], 'After your biggest rise, your pulse took about 5 seconds to settle back near your calm baseline.');
  assert.ok(r.questions.every((q) => q.status !== 'too_brief'));
  // Brief values are never used for the hard vs easy comparison.
  const hv = buildReport(makeSession({ n: 10, secs: 8, pulse, difficulty: (i) => (i < 5 ? 'easy' : 'hard') }));
  assert.ok(!hv.observations.some((o) => /hard-tagged/.test(o)));
});

test('the breathing line never bridges a real gap (coverage.breathingMaxSpacingSeconds)', () => {
  const r = buildReport(makeSession({ breathing: (s) => (s < 20 || s >= 60 ? 14 : null) }));
  assert.ok(r.timeline.breathingRuns.length >= 2, 'split at the 40 s gap');
  for (const run of r.timeline.breathingRuns) for (let i = 1; i < run.length; i++) assert.ok(run[i][0] - run[i - 1][0] <= CONFIG.coverage.breathingMaxSpacingSeconds * 1000);
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

test('recovery time is measured from the peak of a noticeable rise', () => {
  // +10 from 60 s, peak +16 at 75 s, +10 again until 100 s, +6 for 10 s, then baseline.
  const run = [];
  for (let s = 0; s < 200; s++) run.push([s * 1000, s === 75 ? 16 : s >= 60 && s < 100 ? 10 : s >= 100 && s < 110 ? 6 : 0]);
  const [rise] = findRises([run]);
  assert.strictEqual(rise.peak, 16);
  assert.strictEqual(rise.peakT, 75000);
  assert.strictEqual(rise.recoveryMs, 35000, 'from the peak at 75 s to the first reading within 4 at 110 s');
  // Too short to count (5 s, under riseMinSeconds), and a rise hidden by the end of the data.
  assert.deepStrictEqual(findRises([run.map(([t]) => [t, t >= 60000 && t < 65000 ? 12 : 0])]), []);
  const unfinished = findRises([run.filter(([t]) => t < 105000)]);
  assert.strictEqual(unfinished[0].recoveryMs, null);
  const r = buildReport(makeSession({ n: 4, pulse: (s) => (s >= 60 && s < 100 ? 84 : 72) }));
  assert.strictEqual(r.medianRecoveryMs, 40000, 'plateau: the first reading at the peak counts');
});

test('aboutDuration rounds to 5 s and spells out the words', () => {
  assert.strictEqual(aboutDuration(85000), '1 minute 25 seconds');
  assert.strictEqual(aboutDuration(41000), '40 seconds');
  assert.strictEqual(aboutDuration(120000), '2 minutes');
  assert.strictEqual(aboutDuration(1000), '5 seconds');
});

test('pulse lag: each question is analysed over its window shifted later', () => {
  // Pulse is +12 only from 60 to 66 s: with a 6 s lag that belongs to Q1 (0 to 60 s, analysed 6 to 66 s), not Q2.
  const s = makeSession({ pulse: (t) => (t >= 60 && t < 66 ? 84 : 72) });
  const lagged = buildReport(s);
  assert.strictEqual(lagged.questions[0].peakChange, 12);
  assert.strictEqual(lagged.questions[1].peakChange, 0);
  const noLag = buildReport(s, { ...CONFIG.report, pulseLagSeconds: 0 });
  assert.strictEqual(noLag.questions[0].peakChange, 0);
  assert.strictEqual(noLag.questions[1].peakChange, 12);
  // The last question's shifted window is clipped to the end of the test.
  assert.ok(lagged.questions[5].measuredSeconds <= 54);
});

test('observation: biggest rise names the question and what happened on it', () => {
  const r = buildReport(makeSession({
    pulse: (s) => (s >= 240 && s < 300 ? 88 : s >= 120 && s < 180 ? 82 : 72),
    events: [{ t: 245000, type: 'answer_changed', q: 4, option: 1, previous: 0 }, { t: 250000, type: 'answer_changed', q: 4, option: 2, previous: 1 }],
  }));
  assert.strictEqual(r.observations[0], 'Your pulse rose most around Q5 (+16 above your calm baseline). You changed your answer twice on Q5.');
  const flat = buildReport(makeSession({ pulse: () => 74 }));
  assert.strictEqual(flat.observations[0], 'Your pulse did not stay 8 or more beats per minute above your calm baseline for 6 seconds or longer in this test.');
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
  // A change under minBreathingChangeForObservation (3) is skipped, with no "about the same" filler.
  const small = buildReport(makeSession({ breathing: (s) => (s >= 240 ? 16 : 14) }));
  assert.ok(!small.observations.some((o) => /breathing/i.test(o)), small.observations.join(' | '));
});

test('resets: bands from events, question time paused, and a neutral before/after observation', () => {
  // Reset from 90 to 120 s during Q2 (60 to 150 s). Pulse +14 before, +6 after.
  const pulse = (s) => (s < 96 ? 86 : s < 126 ? 82 : 78);
  const s = makeSession({ n: 4, secs: 60, pulse, events: [{ t: 90000, type: 'reset_start' }, { t: 120000, type: 'reset_end' }] });
  const r = buildReport(s);
  assert.deepStrictEqual(r.timeline.resets, [{ start: 90000, end: 120000 }]);
  assert.deepStrictEqual(r.timeline.windows.filter((w) => w.q === 1), [{ q: 1, start: 60000, end: 90000 }, { q: 1, start: 120000, end: 120000 + 0 }].filter((w) => w.end > w.start));
  const obs = r.observations.find((o) => /reset/.test(o));
  assert.strictEqual(obs, 'In the minute before your reset at 1:30, your pulse was a median of +14 compared with your calm baseline, and +6 in the minute after. This compares two minutes; it can\'t tell what caused the change.');
  // An unfinished reset ends with the test; not enough samples: no observation.
  const thin = buildReport(makeSession({ n: 4, pulse: (t) => (t % 4 === 0 ? 80 : null), events: [{ t: 90000, type: 'reset_start' }] }));
  assert.deepStrictEqual(thin.timeline.resets, [{ start: 90000, end: 240000 }]);
  assert.ok(!thin.observations.some((o) => /reset/.test(o)));
});

test('summary for the progress view', () => {
  const r = buildReport(makeSession({ pulse: (s) => (s < 180 ? 81 : 73), difficulty: (i) => (i < 3 ? 'hard' : 'easy') }));
  assert.strictEqual(r.summary.hardMedianChange, 9);
  assert.strictEqual(r.summary.measuredShare, 1);
  assert.deepStrictEqual([r.summary.correct, r.summary.total], [6, 6]);
});

test('self check-in shows as "You said", and only for a real answer', () => {
  const s = makeSession({});
  s.selfReport = { feeling: 'a_bit_tough', answeredAt: '2026-11-17T10:12:00.000Z' };
  assert.strictEqual(buildReport(s).selfReport, 'a bit tough');
  s.selfReport = { feeling: 'skipped' };
  assert.strictEqual(buildReport(s).selfReport, null);
  delete s.selfReport;
  assert.strictEqual(buildReport(s).selfReport, null);
});

test('observation: settle time after the biggest rise, from its peak', () => {
  // Rise 1: +12 (30 to 70 s). Rise 2: +20 peak at 150 s, then a slow fall: back within 4 at 235 s.
  const pulse = (s) => (s >= 30 && s < 70 ? 84 : s >= 140 && s < 150 ? 90 : s >= 150 && s < 235 ? 92 - Math.floor((16 * (s - 150)) / 85) : 72);
  const r = buildReport(makeSession({ n: 6, pulse }));
  assert.ok(r.observations.includes('After your biggest rise, your pulse took about 1 minute 25 seconds to settle back near your calm baseline.'), r.observations.join(' | '));
  assert.strictEqual(r.summary.biggestRiseSettleMs, 85000);
  // Biggest rise still going at the end of the test: no recovery observation.
  const open = buildReport(makeSession({ n: 4, pulse: (s) => (s >= 30 && s < 70 ? 84 : s >= 180 ? 95 : 72) }));
  assert.ok(!open.observations.some((o) => /settle back/.test(o)));
});

test('observation priority: biggest rise, recovery, hard vs easy, breathing, reset; at most 3', () => {
  const opts = { n: 8, pulse: (s) => (s % 120 >= 30 && s % 120 < 70 ? 84 : 72), breathing: (s) => (s >= 320 ? 19 : 14), difficulty: (i) => (i % 2 ? 'hard' : 'easy') };
  const r = buildReport(makeSession(opts));
  assert.strictEqual(r.observations.length, CONFIG.report.maxObservations);
  assert.match(r.observations[0], /^Your pulse rose most/);
  assert.match(r.observations[1], /^After your biggest rise/);
  assert.match(r.observations[2], /hard-tagged/);
  const roomy = buildReport(makeSession(opts), { ...CONFIG.report, maxObservations: 5 });
  assert.match(roomy.observations.at(-1), /^Your breathing rate/);
  // A reset observation comes after hard vs easy and breathing, so it is cut first.
  const withReset = { ...opts, events: [{ t: 200000, type: 'reset_start' }, { t: 230000, type: 'reset_end' }] };
  assert.ok(!buildReport(makeSession(withReset)).observations.some((o) => /reset/.test(o)));
  const all = buildReport(makeSession(withReset), { ...CONFIG.report, maxObservations: 5 }).observations;
  assert.match(all[3], /^Your breathing rate/);
  assert.match(all[4], /^In the minute before your reset/);
});

test('biggest-rise observation adds a second sentence only when something happened', () => {
  const pulse = (s) => (s >= 240 && s < 300 ? 88 : 72);
  const plain = buildReport(makeSession({ pulse })).observations[0];
  assert.strictEqual(plain, 'Your pulse rose most around Q5 (+16 above your calm baseline).');
  const skipped = buildReport(makeSession({ pulse, events: [{ t: 290000, type: 'skipped', q: 4 }] })).observations[0];
  assert.match(skipped, /You skipped Q5 at first and answered it later\.$/);
  const marked = buildReport(makeSession({ pulse, events: [{ t: 250000, type: 'marked_for_review', q: 4, marked: true }] })).observations[0];
  assert.match(marked, /You marked Q5 for review\.$/);
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

test('the window UI text avoids the banned words', () => {
  for (const f of ['index.html', 'renderer.js', 'report-view.js']) {
    const p = path.join(__dirname, '..', f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/\b(stress\w*|anxi\w*|panic\w*|nervous\w*)\b/i);
    assert.strictEqual(m, null, `${f} contains "${m?.[0]}"`);
  }
});

test('the "shifted about N seconds later" note comes from config', () => {
  assert.strictEqual(buildReport(makeSession({})).pulseLagSeconds, CONFIG.report.pulseLagSeconds);
  assert.strictEqual(buildReport(makeSession({}), { ...CONFIG.report, pulseLagSeconds: 9 }).pulseLagSeconds, 9);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /shifted about <span id="rLag">/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8'), /\$\('rLag'\)\.textContent = String\(report\.pulseLagSeconds\)/);
});
