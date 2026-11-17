'use strict';

// Calibration state machine on a virtual clock with synthetic inputs.
const test = require('node:test');
const assert = require('node:assert');
const { createCalibration } = require('../lib/calibration');
const { build } = require('../scripts/make-simulated-recording');

const T0 = 1_000_000;
const OK = { ok: true, code: 'kOk', hint: '' };
const CHEST = { ok: false, code: 'kChestNotVisible', hint: 'Place more of the chest in view.' };
const cfg = {
  warmupHintSlowSeconds: 120, warmupMaxSeconds: 300, minCalmSeconds: 60, maxCalibrationSeconds: 180,
  minBreathingReadings: 3, pulseFreshSeconds: 10, breathingFreshSeconds: 45, hrvContinuousOkSeconds: 60,
};

// Drive the machine second by second. plan(s) returns what happens at second s:
// { v: validation, pulse, breathing, hrv } (each optional, values = stable samples).
function run(plan, maxS = 600, c = cfg) {
  const cal = createCalibration(T0, c);
  const states = [];
  for (let s = 0; s <= maxS && !cal.result; s++) {
    const t = T0 + s * 1000;
    const p = plan(s) || {};
    if (p.v) cal.onValidation(t, p.v);
    if (p.error) cal.onError(t, p.error);
    const pkt = {};
    if (p.pulse != null) pkt.pulse = { value: p.pulse, stable: p.pulseStable !== false, confidence: 60, timestamp: s * 1e6 };
    if (p.breathing != null) pkt.breathing = { value: p.breathing, stable: true, confidence: 60, timestamp: s * 1e6 };
    if (p.hrv != null) pkt.hrv = { rmssd: p.hrv, stable: true, confidence: 60, timestamp: s * 1e6 };
    if (Object.keys(pkt).length) cal.onMetrics(t, pkt);
    states.push(cal.tick(t));
  }
  return { cal, states, r: cal.result };
}

test('warm-up lasts until pulse and breathing have each been stable once', () => {
  const { states } = run((s) => ({ v: OK, pulse: s >= 40 ? 70 : null, breathing: s >= 55 && s % 5 === 0 ? 14 : null }), 70);
  assert.strictEqual(states[39].phase, 'warmup');
  assert.strictEqual(states[39].hint, 'Getting ready, about a minute');
  assert.strictEqual(states[50].phase, 'warmup', 'pulse alone is not enough');
  assert.strictEqual(states[55].phase, 'calibrating');
  assert.strictEqual(states[30].calmSeconds.pulse, 0, 'nothing counts during warm-up');
});

test('unstable samples do not end warm-up', () => {
  const { states } = run((s) => ({ v: OK, pulse: 70, pulseStable: false, breathing: 14 }), 130);
  assert.strictEqual(states[130].phase, 'warmup');
  assert.match(states[125].hint, /Still getting ready/);
});

test('warm-up gives up after warmupMaxSeconds without saving', () => {
  const { r } = run(() => ({ v: OK }), 400);
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.seconds, 0);
});

test('pulse and breathing calm seconds are counted separately', () => {
  // Breathing goes quiet for 60 s mid-way (beyond its 45 s freshness), pulse keeps going.
  const { states } = run((s) => ({ v: OK, pulse: 72, breathing: (s < 10 || s > 80) && s % 5 === 0 ? 14 : null }), 100);
  const at = states[79].calmSeconds;
  assert.ok(at.pulse >= 78, `pulse ${at.pulse}`);
  assert.ok(at.breathing < at.pulse - 10, `breathing ${at.breathing} should lag pulse ${at.pulse}`);
});

test('done after 60 calm seconds of each, with a baseline of measured samples only', () => {
  const { r, states } = run((s) => ({ v: OK, pulse: 70 + (s % 3), breathing: s % 6 === 0 ? 14 : null, hrv: 40 }));
  assert.strictEqual(r.outcome, 'done');
  assert.ok(r.seconds >= 60 && r.seconds <= 62, `seconds ${r.seconds}`);
  assert.ok(r.calmSeconds.pulse >= 60 && r.calmSeconds.breathing >= 60);
  assert.ok(r.breathing.length >= 3);
  assert.deepStrictEqual(r.notes, []);
  assert.strictEqual(states.at(-1).phase, 'done');
});

test('pauses stop counting and are recorded as gaps with reasons', () => {
  const { r, states } = run((s) => ({ v: s >= 20 && s < 35 ? CHEST : OK, pulse: s >= 20 && s < 35 ? null : 72, breathing: s % 5 === 0 ? 14 : null }));
  assert.strictEqual(states[25].paused, true);
  assert.strictEqual(states[25].hint, 'Paused: sit back so your shoulders are in view');
  assert.strictEqual(states[34].calmSeconds.pulse, states[20].calmSeconds.pulse, 'no counting while paused');
  assert.deepStrictEqual(r.gaps.map((g) => [g.reason, g.start, g.end]), [['kChestNotVisible', 20000, 35000]]);
  assert.ok(r.seconds >= 75, 'calibration took longer by the pause');
});

test('sparse breathing extends calibration up to the cap, then saves with an honest note', () => {
  // Warm-up ends at 2 s; one more reading at 10 s stays "fresh" for 45 s, then nothing.
  const { r } = run((s) => ({ v: OK, pulse: 72, breathing: s === 2 || s === 10 ? 15 : null, hrv: 40 }), 400);
  assert.strictEqual(r.outcome, 'done');
  assert.ok(r.seconds >= 180 && r.seconds <= 181, `capped at ${r.seconds}`);
  assert.ok(r.notes.some((n) => /Breathing readings were sparse/.test(n)), r.notes.join(' | '));
});

test('enough breathing calm time but too few readings still extends', () => {
  // Readings every 40 s keep breathing "fresh"; the third counted one arrives at 120 s.
  const { r } = run((s) => ({ v: OK, pulse: 72, breathing: s % 40 === 0 ? 14 : null }), 400);
  assert.strictEqual(r.outcome, 'done');
  assert.ok(r.seconds >= 118 && r.seconds <= 122, `extended to the third reading, ${r.seconds}`);
});

test('HRV counts only after 60 s of continuous OK and never extends calibration', () => {
  // Warm-up ends at 30 s. A 1 s pause at 10 s resets the continuous-OK clock to 11 s.
  const { r } = run((s) => ({ v: s === 10 ? CHEST : OK, pulse: 72, breathing: s >= 30 && s % 5 === 0 ? 14 : null, hrv: s }));
  assert.strictEqual(r.outcome, 'done');
  assert.ok(r.hrv.length > 0);
  assert.strictEqual(Math.min(...r.hrv), 71, 'first HRV sample 60 s after the pause ended at 11 s');

  const none = run((s) => ({ v: s % 50 === 0 ? CHEST : OK, pulse: 72, breathing: s % 5 === 0 ? 14 : null, hrv: 40 })).r;
  assert.strictEqual(none.outcome, 'done');
  assert.strictEqual(none.hrv.length, 0);
  assert.ok(none.seconds < 100, 'did not wait for HRV');
  assert.ok(none.notes.includes('Heart-rate variability: not enough data yet.'));
});

test('an SDK error pauses like a positioning problem', () => {
  const { r } = run((s) => ({ v: s > 25 && s < 30 ? null : OK, error: s === 25 ? { code: 'kProcessingFailed', message: 'x' } : null, pulse: s >= 25 && s < 30 ? null : 72, breathing: s % 5 === 0 ? 14 : null }));
  assert.ok(r.gaps.some((g) => g.reason === 'kProcessingFailed' && g.start === 25000 && g.end === 30000));
});

test('the simulated recording calibrates in about two minutes', () => {
  const rec = build();
  const c0 = Date.parse(rec.createdAt);
  const cal = createCalibration(c0, cfg);
  let next = c0 + 250;
  for (const e of rec.events) {
    const t = c0 + e.t;
    while (next <= t && !cal.result) { cal.tick(next); next += 250; }
    if (cal.result) break;
    if (e.channel === 'vitals:validation') cal.onValidation(t, e.data);
    else if (e.channel === 'vitals:metrics') cal.onMetrics(t, e.data);
  }
  const r = cal.result;
  assert.strictEqual(r.outcome, 'done');
  const doneAt = (next - c0) / 1000;
  assert.ok(doneAt > 100 && doneAt < 150, `done at ${doneAt} s`);
  const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
  assert.ok(Math.abs(med(r.pulse) - 72) < 3, `pulse ${med(r.pulse)}`);
  assert.ok(Math.abs(med(r.breathing) - 14) < 1.5, `breathing ${med(r.breathing)}`);
  assert.ok(r.hrv.length > 0, 'HRV collected after 60 s of continuous OK');
});

test('a test waits for a steady pulse: measureState is "measuring" only with OK position and a fresh stable pulse', () => {
  const { measureState } = require('../lib/calibration');
  const now = 5_000_000;
  assert.strictEqual(measureState(now, null, -Infinity).state, 'starting');
  // Camera just turned on (the cold start behind Q1 "not measured"): position OK, no stable pulse yet.
  assert.strictEqual(measureState(now, OK, -Infinity).state, 'getting_ready');
  assert.strictEqual(measureState(now, CHEST, now - 1000).state, 'paused');
  assert.strictEqual(measureState(now, OK, now - 1000).state, 'measuring');
  assert.strictEqual(measureState(now, OK, now - 11000).state, 'getting_ready', 'stale after pulseFreshSeconds (10)');
  // main.js refuses to start the test unless measuring, or the student chose "Start now anyway".
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /m\.state !== 'measuring' && !opts\?\.anyway\) return \{ ok: false, waiting: true/);
});
