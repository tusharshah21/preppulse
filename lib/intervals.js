'use strict';

// Gaps are { start, end, reason, hint } on whatever clock the caller uses.

// Tracks pauses from a stream of (t, ok, reason) updates. A not-OK update opens a
// gap; a different reason splits it; an OK update closes it.
function createGapTracker() {
  const gaps = [];
  let open = null;
  const close = (t) => {
    if (!open) return;
    if (t > open.start) gaps.push({ ...open, end: t });
    open = null;
  };
  return {
    update(t, ok, reason, hint) {
      if (ok) return close(t);
      if (open && open.reason === reason) return;
      close(t);
      open = { start: t, reason, hint: hint || '' };
    },
    close,
    get isOpen() { return !!open; },
    // Closed gaps plus the open one clipped at t (without closing it).
    snapshot(t) { return open && t > open.start ? [...gaps, { ...open, end: t }] : [...gaps]; },
  };
}

// Periods inside [start, end] with no stable sample for longer than maxSpacing.
// times must be sorted.
function spacingGaps(times, start, end, maxSpacing, reason) {
  const out = [];
  let prev = start;
  for (const t of times) {
    if (t < start || t > end) continue;
    if (t - prev > maxSpacing) out.push({ start: prev, end: t, reason, hint: '' });
    prev = t;
  }
  if (end - prev > maxSpacing) out.push({ start: prev, end, reason, hint: '' });
  return out;
}

// Total length of [a, b] covered by the union of gaps.
function coveredLength(a, b, gaps) {
  const parts = gaps
    .map((g) => [Math.max(a, g.start), Math.min(b, g.end)])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of parts) {
    if (curE == null || s > curE) {
      if (curE != null) total += curE - curS;
      curS = s;
      curE = e;
    } else curE = Math.max(curE, e);
  }
  if (curE != null) total += curE - curS;
  return total;
}

module.exports = { createGapTracker, spacingGaps, coveredLength };
