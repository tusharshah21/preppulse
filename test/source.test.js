'use strict';

// File-input labelling: the demo banner, the looping video's restart gaps, and
// the preview that never shows a dataset participant.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { describeSource, kindOf, SIM_BANNER } = require('../lib/source');
const { createRestartGate } = require('../lib/videofeed');
const { createTestSession } = require('../lib/session');
const { buildReport } = require('../lib/report');
const SAMPLE = require('../questions/sample-test.json');

const ROOT = path.join(__dirname, '..');
const UBFC = path.join(ROOT, 'data', 'videos', 'ubfc-rppg', 'subject3', 'vid.avi');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('banner: demo video named, SIMULATED DATA only for made-up recordings, none for the camera', () => {
  const v = describeSource({ root: ROOT, videoPath: UBFC });
  assert.strictEqual(v.banner, 'Demo input: public research video (UBFC-rPPG, subject 3), not a live webcam');
  assert.strictEqual(v.dataKind, 'dataset');
  assert.strictEqual(v.dataset, 'UBFC-rPPG, subject 3');
  assert.doesNotMatch(v.banner, /SIMULATED/);

  const other = describeSource({ root: ROOT, videoPath: path.join(ROOT, 'data', 'videos', 'x.mp4') });
  assert.strictEqual(other.banner, 'Demo input: test video file, not a live webcam');
  assert.strictEqual(other.dataKind, 'dataset');

  const sim = describeSource({ root: ROOT, replay: true, replayMeta: { simulated: true } });
  assert.strictEqual(sim.banner, SIM_BANNER);
  assert.strictEqual(sim.dataKind, 'simulated');

  // A recording made from the demo video replays with the demo banner, not SIMULATED DATA.
  const rec = describeSource({ root: ROOT, replay: true, replayMeta: { dataset: 'UBFC-rPPG, subject 3', notUserData: true } });
  assert.strictEqual(rec.banner, v.banner);
  assert.strictEqual(rec.dataKind, 'dataset');

  const cam = describeSource({ root: ROOT });
  assert.strictEqual(cam.banner, null);
  assert.strictEqual(cam.dataKind, 'real');

  // The window shows whatever banner main sends, on every screen (one fixed element).
  assert.match(read('renderer.js'), /\$\('simBanner'\)\.hidden = !i\.banner/);
  assert.match(read('index.html'), new RegExp(SIM_BANNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('demo data never counts as the student\'s own', () => {
  assert.strictEqual(kindOf({ dataset: 'UBFC-rPPG, subject 3' }), 'dataset');
  assert.strictEqual(kindOf({ simulated: true }), 'simulated');
  assert.strictEqual(kindOf({ pulseBpm: 70 }), 'real');
  const main = read('main.js');
  assert.match(main, /kindOf\(b\) !== SOURCE\.dataKind/, 'baselines of another kind are ignored');
  assert.match(main, /baseline-\$\{SOURCE\.dataKind\}\.json/, 'a demo baseline never overwrites the real one');
  assert.match(read('renderer.js'), /!s\.simulated && !s\.dataset/, 'progress uses real sessions only');
});

test('preview: only the live camera has one; a dataset video never sends frames', () => {
  assert.strictEqual(describeSource({ root: ROOT }).preview, true);
  assert.strictEqual(describeSource({ root: ROOT, videoPath: UBFC }).preview, false);
  assert.strictEqual(describeSource({ root: ROOT, replay: true, replayMeta: { simulated: true } }).preview, false);
  const main = read('main.js');
  assert.match(main, /onFrame: SOURCE\.preview \? onFrame : undefined/, 'no videoOutput subscription in file mode');
  assert.match(main, /previewOn = on === true && !!sdk && SOURCE\.preview/);
  const r = read('renderer.js');
  assert.match(r, /Preview not available for dataset video/);
  assert.match(r, /if \(!info\.preview \|\| !previewWanted \|\| !box\) return;/, 'frames are never drawn without a preview');
});

test('loop: each restart is a "video restarted" gap and readings mixing both ends are dropped', () => {
  const cfg = { restartGapSeconds: 12, restartDropSeconds: { pulse: 12, breathing: 30, hrv: 60 } };
  const g = createRestartGate(cfg);
  const ok = { ok: true, code: 'kOk', hint: '' };
  assert.strictEqual(g.validation(1000, ok), ok, 'no restart yet: unchanged');
  const first = g.restart(100000, 99800);
  assert.deepStrictEqual(first, { ok: false, code: 'kVideoRestarted', hint: 'video restarted' });
  assert.strictEqual(g.validation(105000, ok).code, 'kVideoRestarted');
  assert.strictEqual(g.validation(112500, ok), ok, 'gap ends after restartGapSeconds');
  const us = (ms) => ms * 1000;
  const p = (ms) => ({ value: 70, stable: true, confidence: 90, timestamp: us(ms) });
  const d = g.metrics({ pulse: p(105000), breathing: p(125000), hrv: { rmssd: 40, stable: true, timestamp: us(150000) }, trace: [[us(99000), 1], [us(100000), 2], [us(120000), 3]] });
  assert.strictEqual(d.pulse, null, 'pulse inside its 12 s window: dropped');
  assert.strictEqual(d.breathing, null, 'breathing inside its 30 s window: dropped');
  assert.strictEqual(d.hrv, null, 'HRV inside its 60 s window: dropped');
  assert.deepStrictEqual(d.trace, [[us(99000), 1], [us(120000), 3]]);
  assert.ok(g.metrics({ pulse: p(112000) }).pulse, 'pulse after its window is kept');
  assert.strictEqual(g.count, 1);

  // Through a real test session and report: a labelled gap, and the pulse line is split there.
  const t0 = 1_000_000;
  const s = createTestSession({ startedAt: t0, durationMs: 60000, questions: SAMPLE, settings: { minutes: 1 }, baseline: { pulseBpm: 70 }, source: { mode: 'video', dataset: 'UBFC-rPPG, subject 3' } });
  s.event(t0, { type: 'question_shown', q: 0 });
  const gate = createRestartGate(cfg);
  const feed = (t, v) => s.onValidation(t, gate.validation(t, v));
  for (let t = t0; t < t0 + 60000; t += 500) {
    if (t === t0 + 20000) s.onValidation(t, gate.restart(t, t));
    feed(t, ok);
    s.onMetrics(t, gate.metrics({ pulse: p(t), trace: [] }));
  }
  s.end(t0 + 60000, 'time_up');
  const session = s.finish();
  const pauses = session.gaps.pauses;
  assert.strictEqual(pauses.length, 1);
  assert.strictEqual(pauses[0].reason, 'kVideoRestarted');
  assert.strictEqual(pauses[0].start, 20000);
  assert.strictEqual(pauses[0].end, 32000);
  assert.ok(!session.samples.pulse.some(([t]) => t >= 20000 && t < 32000), 'no samples inside the restart window');
  const report = buildReport(session);
  assert.ok(report.timeline.gaps.some((x) => x.label === 'not measured: video restarted'));
  for (const run of report.timeline.pulseRuns) {
    assert.ok(run.every(([t]) => t < 20000) || run.every(([t]) => t >= 32000), 'the line is never joined across a restart');
  }
  assert.strictEqual(report.dataset, 'UBFC-rPPG, subject 3');
});
