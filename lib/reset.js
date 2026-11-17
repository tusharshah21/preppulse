'use strict';

// The 30-second reset: one neutral line about pulse at the start and the end,
// only when there is enough stable data for both. It never says the reset
// lowered anything or "worked"; it only reports the two numbers.
const CONFIG = require('./config');
const { median } = require('./baseline');

// samples: stable pulse [tMs epoch, bpm] by sample timestamp. Pulse arrives ~8 s
// late, so "at the end" uses whatever has arrived for the window before endMs.
function resetPulseLine(samples, baselineBpm, startMs, endMs, cfg = CONFIG.reset) {
  if (!Number.isFinite(baselineBpm)) return null;
  const w = cfg.pulseWindowSeconds * 1000;
  const inWin = (to) => samples.filter(([t]) => t > to - w && t <= to).map(([, v]) => v);
  const before = inWin(startMs);
  const after = inWin(endMs);
  if (before.length < cfg.minPulseSamples || after.length < cfg.minPulseSamples) return null;
  const a = Math.round(median(before) - baselineBpm);
  const b = Math.round(median(after) - baselineBpm);
  const start = a > 0 ? `+${a} above your baseline` : a < 0 ? `${-a} below your baseline` : 'at your baseline';
  const end = b > 0 ? `+${b}` : String(b);
  return `Pulse at the start: ${start}. At the end: ${end}.`;
}

module.exports = { resetPulseLine };
