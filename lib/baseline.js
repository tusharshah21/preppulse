'use strict';

const MAX_SAMPLES = 20000;

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function numbers(xs, name) {
  if (!Array.isArray(xs) || xs.length > MAX_SAMPLES || !xs.every(Number.isFinite)) {
    throw new TypeError(`${name} must be an array of at most ${MAX_SAMPLES} finite numbers`);
  }
  return xs;
}

// Input comes from the renderer, so it is validated here (trust boundary).
function computeBaseline(input, now = new Date()) {
  const pulse = numbers(input?.pulse, 'pulse');
  const breathing = numbers(input?.breathing, 'breathing');
  const hrv = numbers(input?.hrv ?? [], 'hrv');
  if (!pulse.length || !breathing.length) throw new RangeError('need at least one pulse and one breathing sample');
  return {
    createdAt: now.toISOString(),
    calibrationSeconds: Number.isFinite(input.seconds) ? Math.round(input.seconds) : null,
    pulseBpm: round1(median(pulse)),
    breathingPerMin: round1(median(breathing)),
    hrvRmssdMs: hrv.length ? round1(median(hrv)) : null, // null = not enough data yet
    sampleCounts: { pulse: pulse.length, breathing: breathing.length, hrv: hrv.length },
  };
}

module.exports = { median, computeBaseline };
