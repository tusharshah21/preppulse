'use strict';

// Diagnostics mode (PREPPULSE_DIAGNOSTICS=1): numbers about one camera session,
// for retuning lib/config.js after the live session. Numbers and SDK status
// names only: no frames, no face data, no measured values beyond timing and
// counts, nothing about the API key. Written by main.js to data/diagnostics/.
const CONFIG = require('./config');

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

function spacingStats(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / 1000);
  gaps.sort((a, b) => a - b);
  const over = CONFIG.coverage.pulseMaxSpacingSeconds;
  return {
    count: gaps.length,
    medianSeconds: round1(pct(gaps, 0.5)),
    p95Seconds: round1(pct(gaps, 0.95)),
    maxSeconds: round1(gaps.at(-1) ?? null),
    [`over${over}Seconds`]: gaps.filter((g) => g > over).length,
  };
}

// t0: camera start (ms). All times below are ms on the same clock (Date.now()).
function createDiagnostics(t0, meta = {}) {
  const first = { pulse: null, pulseStable: null, breathing: null, breathingStable: null, hrv: null, hrvStable: null, validationOk: null, running: null };
  const seen = { pulse: new Set(), breathing: new Set() };
  const pulseArrivals = []; // arrival times of new pulse samples
  const pulseSampleTimes = []; // the samples' own timestamps, ms
  const breathingArrivals = [];
  const validation = {};
  const errors = {};
  const status = [];
  let calibration = null;
  let test = null;
  const mark = (k, t) => { if (first[k] == null) first[k] = t - t0; };

  return {
    onStatus(t, name) { status.push({ seconds: round1((t - t0) / 1000), status: String(name) }); if (name === 'kRunning') mark('running', t); },
    onValidation(t, v) {
      const code = String(v?.code ?? 'unknown');
      validation[code] = (validation[code] || 0) + 1;
      if (v?.ok) mark('validationOk', t);
    },
    onError(_t, e) { const c = String(e?.code ?? 'unknown'); errors[c] = (errors[c] || 0) + 1; },
    onMetrics(t, d) {
      const p = d?.pulse;
      if (p && p.timestamp != null && !seen.pulse.has(p.timestamp)) {
        seen.pulse.add(p.timestamp);
        mark('pulse', t);
        if (p.stable) mark('pulseStable', t);
        pulseArrivals.push(t);
        pulseSampleTimes.push(p.timestamp / 1000);
      }
      const b = d?.breathing;
      if (b && b.timestamp != null && !seen.breathing.has(b.timestamp)) {
        seen.breathing.add(b.timestamp);
        mark('breathing', t);
        if (b.stable) mark('breathingStable', t);
        breathingArrivals.push(t);
      }
      if (d?.hrv) { mark('hrv', t); if (d.hrv.stable) mark('hrvStable', t); }
    },
    onCalibration(t, r, cfg = CONFIG.calibration) {
      const endedBy = r.outcome !== 'done' ? (r.pulse?.length ? 'warmup_timeout' : 'no_stable_pulse')
        : r.seconds >= cfg.maxCalibrationSeconds - 1 ? 'max_calibration_cap' : 'calm_target_reached';
      calibration = {
        outcome: r.outcome,
        endedBy,
        secondsSinceCameraStart: round1((t - t0) / 1000),
        calibrationPhaseSeconds: round1(r.seconds),
        calmSeconds: { pulse: round1(r.calmSeconds?.pulse), breathing: round1(r.calmSeconds?.breathing) },
        stableSamples: { pulse: r.pulse?.length ?? 0, breathing: r.breathing?.length ?? 0, hrv: r.hrv?.length ?? 0 },
        pauses: (r.gaps || []).length,
      };
    },
    onTest(session) {
      test = {
        durationSeconds: round1((session.events?.find((e) => e.type === 'test_end')?.t ?? session.settings?.durationMs ?? 0) / 1000),
        coverage: session.coverage,
        resets: (session.events || []).filter((e) => e.type === 'reset_start').length,
        pauses: (session.gaps?.pauses || []).map((g) => ({ startSeconds: round1(g.start / 1000), seconds: round1((g.end - g.start) / 1000), code: String(g.reason) })),
        questions: (session.questions || []).map((q) => ({
          q: q.q + 1, difficulty: q.difficulty, onScreenSeconds: round1(q.timeMs / 1000), measuredSeconds: round1(q.measuredMs / 1000), coverage: q.coverage,
        })),
      };
    },
    summary(tEnd) {
      const minutes = (tEnd - t0) / 60000;
      const secs = (ms) => round1(ms == null ? null : ms / 1000);
      return {
        format: 'preppulse-diagnostics/1',
        mode: meta.mode ?? null,
        simulated: !!meta.simulated,
        dataset: meta.dataset ?? null,
        requestedMetrics: meta.requestedMetrics ?? null,
        cameraSeconds: round1((tEnd - t0) / 1000),
        secondsToFirst: {
          running: secs(first.running), validationOk: secs(first.validationOk),
          pulse: secs(first.pulse), pulseStable: secs(first.pulseStable),
          breathing: secs(first.breathing), breathingStable: secs(first.breathingStable),
          hrv: secs(first.hrv), hrvStable: secs(first.hrvStable),
        },
        pulseSpacingByArrival: spacingStats(pulseArrivals),
        pulseSpacingBySampleTime: spacingStats(pulseSampleTimes),
        pulseSamples: pulseArrivals.length,
        breathingSamples: breathingArrivals.length,
        breathingReadingsPerMinute: minutes > 0 ? round1(breathingArrivals.length / minutes) : null,
        validationCounts: validation,
        errorCounts: errors,
        statusChanges: status,
        calibration,
        test,
      };
    },
  };
}

module.exports = { createDiagnostics, spacingStats };
