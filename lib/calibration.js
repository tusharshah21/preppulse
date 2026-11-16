'use strict';

// Adaptive calm-baseline calibration as a pure state machine. Every call takes
// the arrival time t (epoch ms) explicitly, so tests can drive it on a virtual
// clock and the app drives it from Date.now().
//
// 1. warmup: wait until pulse and breathing have each been stable once.
// 2. calibrating: count calm seconds for pulse and breathing separately (OK
//    position and a stable sample of that signal arrived recently). Done when
//    both reach minCalmSeconds and there are enough breathing readings, or at
//    maxCalibrationSeconds, then save what was measured with honest notes.
//    HRV samples count only after hrvContinuousOkSeconds of continuous OK
//    position; HRV never extends calibration.
// Pauses (non-OK validation, SDK errors) are recorded as gaps with reasons.
const CONFIG = require('./config');
const { createGapTracker } = require('./intervals');

const POSITION_CODES = new Set(['kChestNotVisible', 'kFaceTooClose', 'kFaceTooFar', 'kFaceNotCentered',
  'kFaceTooHigh', 'kFaceTooLow', 'kNoFaceFound']);

function pausedHint(code, hint) {
  if (POSITION_CODES.has(code)) return 'Paused: sit back so your shoulders are in view';
  if (code === 'kCameraTuning') return 'Getting ready: the camera is adjusting';
  return `Paused: ${hint || 'measurement interrupted'}`;
}

function createCalibration(t0, cfg = CONFIG.calibration) {
  const gaps = createGapTracker();
  const samples = { pulse: [], breathing: [], hrv: [] };
  const seen = { pulse: new Set(), breathing: new Set(), hrv: new Set() };
  const everStable = { pulse: false, breathing: false };
  const lastStableAt = { pulse: -Infinity, breathing: -Infinity };
  const calm = { pulse: 0, breathing: 0 };
  const fresh = { pulse: cfg.pulseFreshSeconds * 1000, breathing: cfg.breathingFreshSeconds * 1000 };
  let phase = 'warmup';
  let calStart = null;
  let lastTick = t0;
  let ok = false;
  let okSince = null;
  let pause = null; // { code, hint } while paused
  let result = null;

  const collect = (kind, ts, value) => {
    if (!Number.isFinite(value) || seen[kind].has(ts)) return;
    seen[kind].add(ts);
    samples[kind].push(value);
  };

  function finish(t, outcome) {
    gaps.close(t);
    const notes = [];
    const min = cfg.minCalmSeconds;
    const secs = (x) => Math.floor(x / 1000);
    if (outcome === 'failed') {
      notes.push(`Pulse and breathing did not both settle within ${Math.round(cfg.warmupMaxSeconds / 60)} minutes.`);
    } else {
      if (calm.pulse < min * 1000) notes.push(`Pulse was measured for ${secs(calm.pulse)} of ${min} seconds.`);
      if (!samples.breathing.length) notes.push('Breathing: not enough data yet.');
      else if (calm.breathing < min * 1000 || samples.breathing.length < cfg.minBreathingReadings) {
        notes.push(`Breathing readings were sparse: ${samples.breathing.length} in ${secs(t - calStart)} seconds.`);
      }
      if (!samples.hrv.length) notes.push('Heart-rate variability: not enough data yet.');
      if (!samples.pulse.length) { outcome = 'failed'; notes.unshift('No steady pulse reading was collected.'); }
    }
    phase = outcome;
    result = {
      outcome, // 'done' | 'failed'
      seconds: calStart == null ? 0 : (t - calStart) / 1000,
      calmSeconds: { pulse: calm.pulse / 1000, breathing: calm.breathing / 1000 },
      pulse: samples.pulse,
      breathing: samples.breathing,
      hrv: samples.hrv,
      notes,
      // Relative to the start of calibration (t0), in ms.
      gaps: gaps.snapshot(t).map((g) => ({ ...g, start: g.start - t0, end: g.end - t0 })),
    };
  }

  return {
    onValidation(t, v) {
      const isOk = !!v?.ok;
      gaps.update(t, isOk, v?.code, v?.hint);
      if (isOk && !ok) okSince = t;
      if (!isOk) okSince = null;
      ok = isOk;
      pause = isOk ? null : { code: v?.code, hint: v?.hint };
    },
    onError(t, e) {
      gaps.update(t, false, e?.code || 'error', e?.message);
      ok = false;
      okSince = null;
      pause = { code: e?.code, hint: 'the measurement reported a problem' };
    },
    onMetrics(t, p) {
      if (result) return;
      for (const kind of ['pulse', 'breathing']) {
        const s = p?.[kind];
        if (!s?.stable || !Number.isFinite(s.value)) continue;
        everStable[kind] = true;
        lastStableAt[kind] = t;
        if (phase === 'calibrating' && ok) collect(kind, s.timestamp, s.value);
      }
      const h = p?.hrv;
      if (h?.stable && phase === 'calibrating' && okSince != null && t - okSince >= cfg.hrvContinuousOkSeconds * 1000) {
        collect('hrv', h.timestamp, h.rmssd);
      }
    },
    tick(t) {
      const dt = Math.max(0, t - lastTick);
      lastTick = t;
      if (result) return this.state(t);
      if (phase === 'warmup') {
        if (everStable.pulse && everStable.breathing) { phase = 'calibrating'; calStart = t; }
        else if (t - t0 >= cfg.warmupMaxSeconds * 1000) finish(t, 'failed');
      } else if (phase === 'calibrating') {
        if (ok) for (const k of ['pulse', 'breathing']) if (t - lastStableAt[k] <= fresh[k]) calm[k] += dt;
        const need = cfg.minCalmSeconds * 1000;
        const enough = calm.pulse >= need && calm.breathing >= need && samples.breathing.length >= cfg.minBreathingReadings;
        if (enough || t - calStart >= cfg.maxCalibrationSeconds * 1000) finish(t, 'done');
      }
      return this.state(t);
    },
    state(t) {
      let hint;
      if (pause) hint = pausedHint(pause.code, pause.hint);
      else if (phase === 'warmup') {
        hint = t - t0 >= cfg.warmupHintSlowSeconds * 1000
          ? 'Still getting ready. Keep sitting back with your shoulders in view, in even light.'
          : 'Getting ready, about a minute';
      } else if (phase === 'calibrating') {
        const measuring = ['pulse', 'breathing'].some((k) => t - lastStableAt[k] <= fresh[k]);
        hint = measuring ? 'Measuring. Keep breathing normally.' : 'Hold still while the readings settle';
      } else hint = phase === 'done' ? 'Done' : 'Could not finish';
      return {
        phase,
        paused: !!pause,
        hint,
        target: cfg.minCalmSeconds,
        calmSeconds: { pulse: Math.floor(calm.pulse / 1000), breathing: Math.floor(calm.breathing / 1000) },
        breathingReadings: samples.breathing.length,
      };
    },
    get result() { return result; },
  };
}

module.exports = { createCalibration, pausedHint };
