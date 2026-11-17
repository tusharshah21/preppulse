'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDiagnostics } = require('../lib/diagnostics');

test('diagnostics: timings, spacing and counts, numbers only', () => {
  const T0 = 1_000_000;
  const d = createDiagnostics(T0, { mode: 'camera', requestedMetrics: [0, 2, 15, 16, 17] });
  d.onStatus(T0 + 5000, 'kRunning');
  d.onValidation(T0 + 6000, { ok: false, code: 'kChestNotVisible', hint: 'Place more of the chest in view.' });
  d.onValidation(T0 + 7000, { ok: true, code: 'kOk', hint: 'Hold still and record.' });
  // Pulse every second from 45 s, stable from 60 s, one 8 s hole at 100 s. A repeated packet is ignored.
  for (let s = 45; s <= 120; s++) {
    if (s > 100 && s < 108) continue;
    const t = T0 + s * 1000;
    d.onMetrics(t, { pulse: { value: 70, stable: s >= 60, confidence: 50, timestamp: (t - 8000) * 1000 } });
  }
  d.onMetrics(T0 + 120500, { pulse: { value: 70, stable: true, confidence: 50, timestamp: (T0 + 112000) * 1000 } });
  d.onMetrics(T0 + 50000, { breathing: { value: 14, stable: true, timestamp: 1 }, hrv: { rmssd: 40, stable: false } });
  d.onMetrics(T0 + 90000, { hrv: { rmssd: 40, stable: true } });
  d.onCalibration(T0 + 150000, { outcome: 'done', seconds: 70, calmSeconds: { pulse: 60, breathing: 61 }, pulse: [1], breathing: [1, 2, 3], hrv: [], gaps: [{}] });
  d.onTest({ events: [{ t: 0, type: 'test_start' }, { t: 10000, type: 'reset_start' }, { t: 240000, type: 'test_end' }], coverage: { full: 1 },
    gaps: { pauses: [{ start: 1000, end: 3000, reason: 'kCameraTuning', hint: 'Hold still while the camera adjusts.' }] },
    questions: [{ q: 0, difficulty: 'easy', timeMs: 40000, measuredMs: 39000, coverage: 'full', answer: 1, correct: true }] });
  const s = d.summary(T0 + 300000);

  assert.deepStrictEqual(s.secondsToFirst, { running: 5, validationOk: 7, pulse: 45, pulseStable: 60, breathing: 50, breathingStable: 50, hrv: 50, hrvStable: 90 });
  assert.strictEqual(s.pulseSamples, 69);
  assert.strictEqual(s.pulseSpacingByArrival.maxSeconds, 8);
  assert.strictEqual(s.pulseSpacingByArrival.over5Seconds, 1);
  assert.strictEqual(s.pulseSpacingByArrival.medianSeconds, 1);
  assert.deepStrictEqual(s.validationCounts, { kChestNotVisible: 1, kOk: 1 });
  assert.strictEqual(s.breathingReadingsPerMinute, 0.2);
  assert.strictEqual(s.calibration.endedBy, 'calm_target_reached');
  assert.strictEqual(s.calibration.secondsSinceCameraStart, 150);
  assert.strictEqual(s.test.resets, 1);
  assert.deepStrictEqual(s.test.questions, [{ q: 1, difficulty: 'easy', onScreenSeconds: 40, measuredSeconds: 39, coverage: 'full' }]);

  // No hints, answers, measured values or anything key-like end up in the file.
  const json = JSON.stringify(s);
  for (const bad of ['Hold still', 'chest in view', 'apiKey', 'API', '"answer"', 'correct', 'value', 'rmssd', 'hint']) assert.ok(!json.includes(bad), bad);

  const capped = createDiagnostics(T0);
  capped.onCalibration(T0 + 1000, { outcome: 'done', seconds: 180, calmSeconds: {}, pulse: [1] });
  assert.strictEqual(capped.summary(T0 + 2000).calibration.endedBy, 'max_calibration_cap');
  const failed = createDiagnostics(T0);
  failed.onCalibration(T0 + 1000, { outcome: 'failed', seconds: 0, calmSeconds: {}, pulse: [] });
  assert.strictEqual(failed.summary(T0 + 2000).calibration.endedBy, 'no_stable_pulse');
});
