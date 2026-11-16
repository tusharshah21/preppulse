'use strict';

// Record and replay the IPC events the renderer sees. Recordings hold only the
// numeric payloads from lib/vitals.js (pulse, breathing, breathing trace, HRV,
// validation status, errors). Preview frames use a separate channel and are
// never passed in here.
const fs = require('fs');
const path = require('path');

const CHANNELS = new Set(['vitals:status', 'vitals:validation', 'vitals:error', 'vitals:metrics']);

function createRecorder(meta = {}) {
  const t0 = Date.now();
  const events = [];
  return {
    add(channel, data) {
      if (CHANNELS.has(channel)) events.push({ t: Date.now() - t0, channel, data });
    },
    get events() { return events; },
    save(dir, prefix = 'session') {
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${prefix}-${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify({ version: 1, createdAt: new Date(t0).toISOString(), ...meta, events }));
      return file;
    },
  };
}

function loadRecording(file) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (rec.version !== 1 || !Array.isArray(rec.events)) throw new Error('not a PrepPulse recording (version 1)');
  const events = rec.events.filter((e) => e && CHANNELS.has(e.channel) && Number.isFinite(e.t));
  if (!events.length) throw new Error('recording has no events');
  const { events: _drop, ...meta } = rec;
  return { events, meta };
}

// Move every sample timestamp (epoch µs) forward by d.
function shiftMetrics(data, d) {
  const s = (x) => x && { ...x, timestamp: x.timestamp == null ? null : x.timestamp + d };
  return { ...data, pulse: s(data.pulse), breathing: s(data.breathing), hrv: s(data.hrv),
    trace: (data.trace || []).map(([t, v]) => [t + d, v]) };
}

// Replays events at real speed and loops. Sample timestamps are rebased so the
// recording's createdAt maps to the moment play starts (plus one pass length per
// loop), which keeps them on the same clock as Date.now() like a live session.
// Recorded kStopping/kIdle statuses are dropped (the caller sends Idle on stop)
// and status events play only on the first pass.
// ponytail: loop seam can jump the waveform; record a longer session if that matters.
function play({ events, meta = {} }, emit) {
  const passMs = events[events.length - 1].t + 500;
  let t0 = Date.now();
  const created = Date.parse(meta.createdAt);
  const baseShiftUs = Number.isFinite(created) ? (t0 - created) * 1000 : 0;
  let i = 0;
  let pass = 0;
  let timer = null;

  const tick = () => {
    for (;;) {
      if (i >= events.length) { i = 0; pass++; t0 += passMs; }
      const e = events[i];
      const wait = t0 + e.t - Date.now();
      if (wait > 0) { timer = setTimeout(tick, wait); return; }
      i++;
      if (e.channel === 'vitals:status' && (pass > 0 || e.data === 'kStopping' || e.data === 'kIdle')) continue;
      emit(e.channel, e.channel === 'vitals:metrics' ? shiftMetrics(e.data, baseShiftUs + pass * passMs * 1000) : e.data);
    }
  };
  tick();
  return () => clearTimeout(timer);
}

module.exports = { CHANNELS, createRecorder, loadRecording, play };
