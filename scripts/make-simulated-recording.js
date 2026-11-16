'use strict';

// Writes data/recordings/simulated-test-session.json: a made-up session in the
// exact recorder format (lib/recording.js), for building and testing the mock
// test without a camera. It is NOT a measurement of anyone. The file carries
// "simulated": true and replaying it shows a SIMULATED DATA banner on every
// screen. Never use it in the demo video or the DEV post.
//
// Timeline (seconds from start), about 13 minutes:
//   0-5     kStarting, then kRunning; 0-3 camera tuning
//   ~0-60   warm-up: pulse and breathing appear unstable, then stable
//   60-180  calm: pulse ~72, breathing ~14
//   180-780 test stretch: three pulse rises (+15/60 s, +20/90 s, +12/40 s) with
//           faster breathing, each followed by gradual recovery
//   two gaps of 22 s and 26 s with kChestNotVisible
// HRV is stable only after 60 s of continuous OK position.
const fs = require('fs');
const path = require('path');

const CREATED_AT = '2026-11-16T09:00:00.000Z';
const TOTAL_S = 790;
const OK_FROM_S = 3;
const GAPS = [[335, 357], [690, 716]];
const RISES = [{ start: 250, dur: 60, amp: 15 }, { start: 420, dur: 90, amp: 20 }, { start: 590, dur: 40, amp: 12 }];
const PULSE_LATENCY_S = 8; // pulse samples arrive ~8 s after their own timestamp (live probe)
const BREATH_LATENCY_S = 3;

// Deterministic PRNG (mulberry32), so the file is the same every run.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function build() {
  const rand = rng(20261116);
  const noise = (a) => (rand() + rand() + rand() - 1.5) * a;
  const r1 = (x) => Math.round(x * 10) / 10;
  const created = Date.parse(CREATED_AT);
  const us = (s) => Math.round(created * 1000 + s * 1e6);

  const inGap = (s) => GAPS.some(([a, b]) => s >= a && s < b);
  const okStartBefore = (s) => { // start of the continuous OK stretch containing s
    let start = OK_FROM_S;
    for (const [, b] of GAPS) if (s >= b) start = b;
    return start;
  };
  const sinceGapEnd = (s) => s - okStartBefore(s);
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const rise = (s) => RISES.reduce((sum, { start, dur, amp }) => {
    if (s < start) return sum;
    if (s < start + dur) return sum + amp * smooth((s - start) / 10);
    return sum + amp * Math.exp(-(s - start - dur) / 20); // gradual recovery
  }, 0);
  const pulseTrue = (s) => 72 + 1.5 * Math.sin((2 * Math.PI * s) / 37) + rise(s);
  const breathTrue = (s) => 14 + 0.5 * Math.sin((2 * Math.PI * s) / 53) + 0.3 * rise(s);
  const hrvTrue = (s) => 45 + 2 * Math.sin((2 * Math.PI * s) / 71) - 0.8 * rise(s);

  // Samples keyed by arrival time (s).
  const arrivals = [];
  // Pulse: one sample per second of timestamp, from 37 s.
  for (let ts = 37; ts < TOTAL_S; ts += 1) {
    if (inGap(ts) || ts < OK_FROM_S) continue;
    const warm = ts < 52; // first stable at ts 52, arrives at 60
    const afterGap = okStartBefore(ts) > OK_FROM_S && sinceGapEnd(ts) < 12;
    if (afterGap && sinceGapEnd(ts) < 6) continue; // window refilling after a pause
    const stable = !warm && !afterGap;
    const confidence = stable ? 45 + rand() * 35 : warm ? 0.5 + ((ts - 37) / 15) * 30 : 20 + rand() * 15;
    arrivals.push([ts + PULSE_LATENCY_S, 'pulse', { value: r1(pulseTrue(ts) + noise(1.2)), stable, confidence: r1(confidence), timestamp: us(ts) }]);
  }
  // Breathing rate: sparse, every 7 to 11 s, from 30 s.
  for (let ts = 30; ts < TOTAL_S; ts += 7 + rand() * 4) {
    if (inGap(ts)) continue;
    const afterGap = okStartBefore(ts) > OK_FROM_S && sinceGapEnd(ts) < 10;
    if (afterGap) continue;
    const stable = ts >= 45;
    arrivals.push([ts + BREATH_LATENCY_S, 'breathing', { value: r1(breathTrue(ts) + noise(0.6)), stable, confidence: r1(stable ? 50 + rand() * 35 : 20 + rand() * 20), timestamp: us(ts) }]);
  }
  // HRV: every 5 s once 30 s of continuous OK; stable only after 60 s of continuous OK.
  for (let ts = 0; ts < TOTAL_S; ts += 5) {
    if (inGap(ts) || ts < OK_FROM_S || sinceGapEnd(ts) < 30) continue;
    const stable = sinceGapEnd(ts) >= 60;
    arrivals.push([ts + PULSE_LATENCY_S, 'hrv', { rmssd: r1(hrvTrue(ts) + noise(3)), stable, confidence: r1(stable ? 55 + rand() * 20 : 20 + rand() * 25), timestamp: us(ts) }]);
  }
  arrivals.sort((a, b) => a[0] - b[0]);

  // Breathing waveform: one point per frame, from 6 s, none during gaps.
  const trace = [];
  let phase = 0;
  for (let ts = 6; ts < TOTAL_S; ts += 1 / 30) {
    phase += breathTrue(ts) / 60 / 30;
    if (!inGap(ts)) trace.push([ts, Math.round((Math.sin(2 * Math.PI * phase) + noise(0.05)) * 1000) / 1000]);
  }

  const events = [];
  const add = (s, channel, data) => events.push({ t: Math.round(s * 1000), channel, data });
  add(0, 'vitals:status', 'kStarting');
  add(5, 'vitals:status', 'kRunning');
  for (let s = 0.3; s < TOTAL_S; s += 1 / 30) {
    if (s < OK_FROM_S) add(s, 'vitals:validation', { ok: false, code: 'kCameraTuning', hint: 'Hold still while the camera adjusts.' });
    else if (inGap(s)) add(s, 'vitals:validation', { ok: false, code: 'kChestNotVisible', hint: 'Place more of the chest in view.' });
    else add(s, 'vitals:validation', { ok: true, code: 'kOk', hint: 'Hold still and record.' });
  }
  // Metrics packets roughly every 100 ms; each carries what arrived since the last one.
  let ai = 0;
  let ti = 0;
  for (let s = 6; s < TOTAL_S; s += 0.07 + rand() * 0.06) {
    const data = { pulse: null, breathing: null, hrv: null, trace: [] };
    while (ti < trace.length && trace[ti][0] + 0.1 <= s) { data.trace.push([us(trace[ti][0]), trace[ti][1]]); ti++; }
    while (ai < arrivals.length && arrivals[ai][0] <= s) { data[arrivals[ai][1]] = arrivals[ai][2]; ai++; }
    if (data.trace.length || data.pulse || data.breathing || data.hrv) add(s, 'vitals:metrics', data);
  }
  add(TOTAL_S, 'vitals:status', 'kStopping');
  add(TOTAL_S + 0.5, 'vitals:status', 'kIdle');
  events.sort((a, b) => a.t - b.t);

  return {
    version: 1,
    createdAt: CREATED_AT,
    simulated: true,
    source: 'simulated',
    input: 'simulated',
    requestedMetrics: [0, 2, 15, 16, 17],
    note: 'Synthetic data from scripts/make-simulated-recording.js. Not a measurement. Never use it in the demo video or the DEV post.',
    timeline: { warmupS: [0, 60], calmS: [60, 180], testStretchS: [180, 780], rises: RISES, gapsS: GAPS },
    events,
  };
}

if (require.main === module) {
  const out = path.join(__dirname, '..', 'data', 'recordings', 'simulated-test-session.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const rec = build();
  fs.writeFileSync(out, JSON.stringify(rec));
  console.log(`wrote ${path.relative(process.cwd(), out)}: ${rec.events.length} events, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, simulated: true`);
}

module.exports = { build, GAPS, RISES };
