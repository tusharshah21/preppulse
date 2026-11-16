'use strict';

// npm test: quick checks for the non-trivial pure logic.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { median, computeBaseline } = require('../lib/baseline');
const { downscaleToRGBA, toPayload } = require('../lib/vitals');
const { createRecorder, loadRecording, play } = require('../lib/recording');

// Baseline
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([4, 1, 3, 2]), 2.5);
assert.strictEqual(median([]), null);
const b = computeBaseline({ pulse: [70, 72, 74, 90], breathing: [14, 15, 13], hrv: [], seconds: 60.2 }, new Date(0));
assert.deepStrictEqual([b.pulseBpm, b.breathingPerMin, b.hrvRmssdMs, b.calibrationSeconds], [73, 14, null, 60]);
assert.strictEqual(computeBaseline({ pulse: [70], breathing: [14], hrv: [40, 50] }).hrvRmssdMs, 45);
assert.throws(() => computeBaseline({ pulse: ['70'], breathing: [14] }), TypeError);
assert.throws(() => computeBaseline({ pulse: [], breathing: [14] }), RangeError);
assert.throws(() => computeBaseline(null), TypeError);

// Payload never carries face data
const pl = toPayload({ face: { landmarks: [{}] }, cardio: { pulseRate: [{ value: 70, stable: true, timestamp: 5 }] } });
assert.deepStrictEqual(Object.keys(pl).sort(), ['breathing', 'hrv', 'pulse', 'trace']);
assert.strictEqual(pl.pulse.value, 70);

// Downscale: 4x2 RGB and BGRA frames to 2x1 RGBA
const rgb = Buffer.from([10, 20, 30, 0, 0, 0, 40, 50, 60, 0, 0, 0, /* row 2 */ ...new Array(12).fill(9)]);
assert.deepStrictEqual([...downscaleToRGBA(rgb, 4, 2, 12, 0, 2).data], [10, 20, 30, 255, 40, 50, 60, 255]);
const bgra = Buffer.from([30, 20, 10, 255, 0, 0, 0, 0, 60, 50, 40, 255, 0, 0, 0, 0, ...new Array(16).fill(9)]);
assert.deepStrictEqual([...downscaleToRGBA(bgra, 4, 2, 16, 3, 2).data], [10, 20, 30, 255, 40, 50, 60, 255]);
assert.strictEqual(downscaleToRGBA(rgb, 4, 2, 12, 4), null); // NV12 not handled

// Record -> load -> replay with looping and timestamp shift
const rec = createRecorder({ source: 'test' });
rec.add('vitals:status', 'kRunning');
rec.add('vitals:frame', { data: [1] }); // must be ignored
rec.add('vitals:metrics', { pulse: { value: 70, stable: true, timestamp: 1000 }, trace: [[1000, 1], [2000, 2]] });
rec.add('vitals:status', 'kIdle');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preppulse-'));
const events = loadRecording(rec.save(dir, 'test'));
assert.deepStrictEqual(events.map((e) => e.channel), ['vitals:status', 'vitals:metrics', 'vitals:status']);
assert.throws(() => { fs.writeFileSync(path.join(dir, 'bad.json'), '{"version":2}'); loadRecording(path.join(dir, 'bad.json')); });

const got = [];
const stop = play(events, (ch, d) => got.push([ch, d]));
setTimeout(() => {
  stop();
  fs.rmSync(dir, { recursive: true, force: true });
  const statuses = got.filter(([ch]) => ch === 'vitals:status').map(([, d]) => d);
  assert.deepStrictEqual(statuses, ['kRunning'], 'status only on first pass, kIdle dropped');
  const metrics = got.filter(([ch]) => ch === 'vitals:metrics').map(([, d]) => d);
  assert.ok(metrics.length >= 2, 'replay loops');
  assert.ok(metrics[1].pulse.timestamp > metrics[0].pulse.timestamp, 'looped timestamps move forward');
  assert.ok(metrics[1].trace[0][0] > metrics[0].trace[1][0], 'looped trace stays strictly increasing');
  console.log('selfcheck ok');
}, 1300);
