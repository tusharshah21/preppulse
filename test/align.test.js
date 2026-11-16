'use strict';

// Aligning samples and pauses to question time windows, plus a full quick test
// session over the simulated recording on a virtual clock.
const test = require('node:test');
const assert = require('node:assert');
const { questionWindows, alignQuestions, coverageSummary, finalAnswers } = require('../lib/align');
const { spacingGaps, coveredLength, createGapTracker } = require('../lib/intervals');
const { createTestSession } = require('../lib/session');
const { validateQuestions, publicView } = require('../lib/questions');
const { build } = require('../scripts/make-simulated-recording');
const CONFIG = require('../lib/config');
const SAMPLE = require('../questions/sample-test.json');

test('gap tracker opens, splits on a new reason, and closes', () => {
  const g = createGapTracker();
  g.update(0, true); g.update(10, false, 'kChestNotVisible', 'x'); g.update(12, false, 'kChestNotVisible');
  g.update(20, false, 'kTooDark'); g.update(30, true); g.update(40, false, 'kNoFaceFound');
  assert.deepStrictEqual(g.snapshot(45).map((x) => [x.reason, x.start, x.end]), [['kChestNotVisible', 10, 20], ['kTooDark', 20, 30], ['kNoFaceFound', 40, 45]]);
});

test('coveredLength merges overlapping gaps and clips to the window', () => {
  assert.strictEqual(coveredLength(0, 100, [{ start: -10, end: 20 }, { start: 10, end: 30 }, { start: 90, end: 200 }]), 40);
  assert.strictEqual(coveredLength(0, 100, []), 0);
});

test('spacingGaps finds stretches without stable samples, including the edges', () => {
  assert.deepStrictEqual(spacingGaps([3000, 4000, 12000, 13000], 0, 20000, 5000, 'noStablePulse').map((x) => [x.start, x.end]),
    [[4000, 12000], [13000, 20000]]);
  assert.deepStrictEqual(spacingGaps([], 0, 3000, 5000, 'r'), []);
});

test('question windows come from question_shown events; revisits add up', () => {
  const events = [{ t: 0, type: 'test_start' }, { t: 0, type: 'question_shown', q: 0 }, { t: 30000, type: 'question_shown', q: 1 },
    { t: 50000, type: 'answer_selected', q: 1, option: 2 }, { t: 70000, type: 'question_shown', q: 0 }, { t: 90000, type: 'test_end' }];
  const w = questionWindows(events, 90000);
  assert.deepStrictEqual(w, [{ q: 0, start: 0, end: 30000 }, { q: 1, start: 30000, end: 70000 }, { q: 0, start: 70000, end: 90000 }]);
  // A pause from 20 s to 40 s overlaps q0 by 10 s and q1 by 10 s.
  const a = alignQuestions(w, [{ start: 20000, end: 40000, reason: 'kChestNotVisible' }], 3, CONFIG.coverage);
  assert.deepStrictEqual(a.map((r) => [r.timeMs, r.measuredMs, r.coverage]), [[50000, 40000, 'partial'], [40000, 30000, 'partial'], [0, 0, 'not_shown']]);
  assert.deepStrictEqual(a[0].notMeasuredBecause, ['moved out of view']);
  // Fully covered and fully paused questions.
  const b = alignQuestions(w, [{ start: 30000, end: 70000, reason: 'kTooDark' }], 2, CONFIG.coverage);
  assert.deepStrictEqual(b.map((r) => r.coverage), ['full', 'none']);
  assert.deepStrictEqual(coverageSummary(b), { full: 1, partial: 0, none: 1, not_shown: 0 });
});

test('final answers replay selects, changes and clears', () => {
  const f = finalAnswers([{ type: 'answer_selected', q: 0, option: 1 }, { type: 'answer_changed', q: 0, option: 3 },
    { type: 'answer_selected', q: 1, option: 0 }, { type: 'answer_cleared', q: 1 }, { type: 'marked_for_review', q: 2, marked: true }], 3);
  assert.deepStrictEqual(f, { answers: [3, null, null], marked: [false, false, true] });
});

test('question file validates and the public view has no answers', () => {
  validateQuestions(SAMPLE);
  assert.strictEqual(SAMPLE.questions.length, 12);
  assert.strictEqual(SAMPLE.questions.filter((q) => q.difficulty === 'hard').length, 4);
  assert.ok(publicView(SAMPLE).questions.every((q) => !('answer' in q)));
  assert.throws(() => validateQuestions({ ...SAMPLE, questions: [{ ...SAMPLE.questions[0], options: ['a', 'b'] }] }), /4 options/);
});

test('session rejects bad renderer input and records answer changes', () => {
  const s = createTestSession({ startedAt: 0, durationMs: 60000, questions: SAMPLE, settings: {}, baseline: {}, source: {} });
  assert.strictEqual(s.event(1000, { type: 'question_shown', q: 99 }), false);
  assert.strictEqual(s.event(1000, { type: 'rm -rf', q: 0 }), false);
  assert.strictEqual(s.event(1000, { type: 'question_shown', q: 0 }), true);
  assert.strictEqual(s.event(2000, { type: 'answer_selected', q: 0, option: 7 }), false);
  s.event(2000, { type: 'answer_selected', q: 0, option: 1 });
  s.event(3000, { type: 'answer_selected', q: 0, option: 2 });
  s.end(5000, 'submitted');
  assert.strictEqual(s.event(6000, { type: 'question_shown', q: 1 }), false, 'nothing after the end');
  const full = s.finish();
  assert.deepStrictEqual(full.events.map((e) => e.type), ['test_start', 'question_shown', 'answer_selected', 'answer_changed', 'test_end']);
  assert.strictEqual(full.events[3].previous, 1);
  assert.strictEqual(full.events[1].onScreenMs, 4000);
  assert.deepStrictEqual(full.score, { correct: 0, attempted: 1, total: 12 });
});

test('quick test over the simulated recording: gaps land on the right questions', () => {
  const rec = build();
  const c0 = Date.parse(rec.createdAt);
  const startS = 200;
  const durationMs = 4 * 60000;
  const questions = SAMPLE;
  const session = createTestSession({ startedAt: c0 + startS * 1000, durationMs, questions, settings: { minutes: 4 }, baseline: { pulseBpm: 72 }, source: { mode: 'test', simulated: true } });
  // One question every 20 s: q0 at 200 s ... q11 at 420 s. The 335 to 357 s pause spans q6 (320 to 340 s) and q7 (340 to 360 s).
  const shows = Array.from({ length: 12 }, (_, i) => [c0 + (startS + i * 20) * 1000, i]);
  let si = 0;
  for (const e of rec.events) {
    const t = c0 + e.t;
    while (si < shows.length && shows[si][0] <= t) { session.event(shows[si][0], { type: 'question_shown', q: shows[si][1] }); si++; }
    if (!session.ended && t >= c0 + startS * 1000 + durationMs) session.end(c0 + startS * 1000 + durationMs, 'time_up');
    if (t > c0 + startS * 1000 + durationMs + CONFIG.test.lateSampleGraceSeconds * 1000) break;
    if (e.channel === 'vitals:validation') session.onValidation(t, e.data);
    else if (e.channel === 'vitals:metrics') session.onMetrics(t, e.data);
  }
  session.event(c0 + 210000, { type: 'answer_selected', q: 0, option: 1 }); // ignored: already ended
  const full = session.finish();

  assert.strictEqual(full.source.simulated, true);
  const pause = full.gaps.pauses.find((g) => g.reason === 'kChestNotVisible');
  assert.ok(pause, 'the chest pause is recorded');
  assert.ok(Math.abs(pause.start - 135000) < 100 && Math.abs(pause.end - 157000) < 100, `pause ${pause.start}-${pause.end}`);
  const byQ = full.questions;
  assert.deepStrictEqual(byQ.slice(0, 6).map((q) => q.coverage), ['full', 'full', 'full', 'full', 'full', 'full']);
  assert.strictEqual(byQ[6].coverage, 'partial');
  assert.ok(byQ[6].notMeasuredBecause.includes('moved out of view'));
  assert.notStrictEqual(byQ[7].coverage, 'full');
  assert.strictEqual(byQ[11].timeMs, 20000);
  // Late pulse samples (arriving ~8 s after their timestamp) were still taken after the end.
  const lastPulse = full.samples.pulse.at(-1)[0];
  assert.ok(lastPulse > durationMs - 3000, `last pulse sample at ${lastPulse}`);
  // No sample sits inside the pause, and nothing was filled in.
  assert.ok(full.samples.pulse.every(([t]) => t < pause.start || t >= pause.end));
  assert.ok(full.samples.pulse.every((r) => r.length === 5 && (r[4] === null || Number.isInteger(r[4]))));
  assert.strictEqual(full.coverage.full + full.coverage.partial + full.coverage.none + full.coverage.not_shown, 12);
  // A pulse rise (+15 from 250 s) shows up in the samples of the questions it covers.
  const pulseOf = (q) => { const v = full.samples.pulse.filter((r) => r[4] === q && r[3]).map((r) => r[1]); return v.reduce((a, b) => a + b, 0) / v.length; };
  assert.ok(pulseOf(4) - pulseOf(0) > 10, `q4 ${pulseOf(4)} vs q0 ${pulseOf(0)}`);
});
