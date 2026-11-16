'use strict';

// One ~45 s live session to measure how the SDK behaves. Prints a summary only
// (never the API key) and saves a numeric-only recording to data/recordings/.
// Usage: npm run probe   (optional: PROBE_SECONDS=45)
const path = require('path');
const { performance } = require('perf_hooks');
const { startSession, stopSession, REQUESTED_METRICS } = require('../lib/vitals');
const { createRecorder } = require('../lib/recording');

const ROOT = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* checked below */ }
const apiKey = process.env.SMARTSPECTRA_API_KEY;
if (!apiKey || apiKey === 'your-api-key-here') {
  console.error('SMARTSPECTRA_API_KEY missing in .env');
  process.exit(1);
}
const SECONDS = Number(process.env.PROBE_SECONDS) || 45;

const stats = (xs) => {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `min ${s[0].toFixed(0)}, median ${q(0.5).toFixed(0)}, p95 ${q(0.95).toFixed(0)}, max ${s[s.length - 1].toFixed(0)}`;
};
const secs = (ms) => (ms == null ? 'never' : `${(ms / 1000).toFixed(1)} s`);

const recorder = createRecorder({ source: 'probe', requestedMetrics: REQUESTED_METRICS });
const statuses = [];
const validation = new Map(); // code -> { count, hint }
const errors = [];
const packets = []; // { wall, ts, m }
const frames = { count: 0, first: null, lastWall: 0, firstWall: 0, luma: [] };
let t0 = 0;
let tRunning = null;
const firstStable = { pulse: null, breathing: null, hrv: null };

function emit(channel, data) {
  recorder.add(channel, data);
  const now = performance.now() - t0;
  if (channel === 'vitals:status') {
    statuses.push(`${data}@${secs(now)}`);
    if (data === 'kRunning' && tRunning == null) tRunning = now;
  } else if (channel === 'vitals:validation') {
    const v = validation.get(data.code) || { count: 0, hint: data.hint };
    v.count++;
    validation.set(data.code, v);
  } else if (channel === 'vitals:error') {
    errors.push(`${data.code}: ${data.message} (retryable=${data.retryable}) @${secs(now)}`);
  } else if (channel === 'vitals:metrics') {
    for (const k of ['pulse', 'breathing', 'hrv']) {
      if (data[k]?.stable && firstStable[k] == null) firstStable[k] = now;
    }
  }
}

function onRaw(m, ts) {
  packets.push({ wall: performance.now(), wallEpochMs: Date.now(), ts, m });
}

function onFrame(buf, w, h, stride, fmt) {
  const now = performance.now();
  if (frames.count % 30 === 0) { // mean brightness only, computed in memory; the frame is not kept
    let sum = 0;
    let k = 0;
    for (let i = 0; i < buf.length; i += 997) { sum += buf[i]; k++; }
    frames.luma.push(sum / k);
  }
  if (!frames.count) { frames.first = { w, h, stride, fmt }; frames.firstWall = now; }
  frames.count++;
  frames.lastWall = now;
}

function traceAnalysis(key) {
  const seen = new Set();
  let total = 0;
  let repeated = 0;
  const lengths = [];
  const spans = [];
  for (const p of packets) {
    const arr = (key === 'pulse' ? p.m.cardio?.pulseRate : key === 'breathing' ? p.m.breathing?.rate
      : key === 'hrv' ? p.m.cardio?.hrv : p.m.breathing?.upperTrace) || [];
    if (!arr.length) continue;
    lengths.push(arr.length);
    spans.push(arr[arr.length - 1].timestamp - arr[0].timestamp);
    for (const s of arr) {
      total++;
      if (seen.has(s.timestamp)) repeated++;
      seen.add(s.timestamp);
    }
  }
  return { packetsWithData: lengths.length, lengths: stats(lengths), spans: stats(spans), total, repeated, unique: seen.size };
}

function summary() {
  const lines = [];
  const n = packets.length;
  lines.push(`Session: ${SECONDS} s requested, metrics ${JSON.stringify(REQUESTED_METRICS)}, telemetry off`);
  lines.push(`Statuses: ${statuses.join(', ')}`);
  lines.push(`Errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  lines.push('Validation codes seen:');
  for (const [code, v] of validation) lines.push(`  ${code} x${v.count}  hint: "${v.hint}"`);

  if (n > 1) {
    const durS = (packets[n - 1].wall - packets[0].wall) / 1000;
    const gaps = packets.slice(1).map((p, i) => p.wall - packets[i].wall);
    lines.push(`Metrics packets: ${n}, ${(n - 1) / durS > 0 ? ((n - 1) / durS).toFixed(2) : 'n/a'} per second, gap ms: ${stats(gaps)}`);
    lines.push(`First packet ${secs(packets[0].wall - t0)} after start()${tRunning != null ? `, ${secs(packets[0].wall - t0 - tRunning)} after Running` : ''}`);

    const wallMs = packets[n - 1].wall - packets[0].wall;
    const evRatio = (packets[n - 1].ts - packets[0].ts) / wallMs;
    lines.push(`Event timestampUs: first ${packets[0].ts}, advances ${evRatio.toFixed(1)} units per wall-clock ms`);
    lines.push(`  event ts vs epoch ms at first packet: ts/1000 = ${(packets[0].ts / 1000).toFixed(0)}, Date.now() = ${packets[0].wallEpochMs}`);
    const sampleTs = packets.flatMap((p) => (p.m.breathing?.upperTrace || []).map((s) => s.timestamp)).filter(Number.isFinite);
    if (sampleTs.length > 1) {
      const sr = (Math.max(...sampleTs) - Math.min(...sampleTs)) / wallMs;
      lines.push(`Sample timestamps (upperTrace): first ${sampleTs[0]}, span advances ${sr.toFixed(1)} units per wall-clock ms; offset from event ts at first packet: ${packets[0].ts - sampleTs[0]}`);
    }
  }

  for (const k of ['trace', 'pulse', 'breathing', 'hrv']) {
    const a = traceAnalysis(k);
    lines.push(`${k}: ${a.packetsWithData} packets with data; array length ${a.lengths}; span per packet ${a.spans}; samples ${a.total}, unique timestamps ${a.unique}, repeats ${a.repeated} (${a.total ? ((100 * a.repeated) / a.total).toFixed(0) : 0}%)`);
  }
  const traceSteps = [];
  const ts = [...new Set(packets.flatMap((p) => (p.m.breathing?.upperTrace || []).map((s) => s.timestamp)))].sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) traceSteps.push(ts[i] - ts[i - 1]);
  lines.push(`Trace sample spacing (ts units): ${stats(traceSteps)}`);

  const rel = (ms) => (ms == null ? 'never' : `${secs(ms)} after start()${tRunning != null ? `, ${secs(ms - tRunning)} after Running` : ''}`);
  lines.push(`First stable pulse: ${rel(firstStable.pulse)}`);
  lines.push(`First stable breathing rate: ${rel(firstStable.breathing)}`);
  lines.push(`First stable HRV: ${rel(firstStable.hrv)}`);
  const lastOf = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
  const lastPacket = packets[n - 1]?.m;
  if (lastPacket) {
    const p = lastOf(lastPacket.cardio?.pulseRate);
    const b = lastOf(lastPacket.breathing?.rate);
    const h = lastOf(lastPacket.cardio?.hrv);
    lines.push(`Last values: pulse ${p?.value?.toFixed(1)} (conf ${p?.confidence?.toFixed(0)}), breathing ${b?.value?.toFixed(1)} (conf ${b?.confidence?.toFixed(0)}), hrv rmssd ${h?.rmssd?.toFixed(1)} sdnn ${h?.sdnn?.toFixed(1)} (conf ${h?.confidence?.toFixed(0)}, stable ${!!h?.stable})`);
    lines.push(`Top-level keys in a packet: ${Object.keys(lastPacket).join(', ')}`);
  }
  if (frames.count) {
    const fps = (frames.count - 1) / ((frames.lastWall - frames.firstWall) / 1000);
    lines.push(`videoOutput: ${frames.count} frames, ~${fps.toFixed(1)} fps, ${frames.first.w}x${frames.first.h}, stride ${frames.first.stride}, pixelFormat ${frames.first.fmt}, mean brightness 0-255: ${stats(frames.luma)}`);
  } else {
    lines.push('videoOutput: no frames delivered with useCamera');
  }
  return lines.join('\n');
}

(async () => {
  t0 = performance.now();
  let sdk;
  try {
    sdk = await startSession({ apiKey, emit, onFrame, onRaw });
  } catch (e) {
    console.error(`start() failed: ${e.codeName}: ${e.message}`);
    process.exit(1);
  }
  console.log(`Measuring for ${SECONDS} s. Sit comfortably and look at the camera...`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  await stopSession(sdk);
  console.log(summary());
  const file = recorder.save(path.join(ROOT, 'data', 'recordings'), 'probe');
  console.log(`Recording saved: ${path.relative(ROOT, file)} (${recorder.events.length} events)`);
  process.exit(0);
})();
