'use strict';

// Aligns signal samples and pauses with question time windows. All times are
// ms since test start (the session clock, see lib/session.js).
const CONFIG = require('./config');
const { coveredLength } = require('./intervals');

const REASON_TEXT = {
  kChestNotVisible: 'moved out of view', kFaceTooClose: 'moved out of view', kFaceTooFar: 'moved out of view',
  kFaceNotCentered: 'moved out of view', kFaceTooHigh: 'moved out of view', kFaceTooLow: 'moved out of view',
  kNoFaceFound: 'moved out of view', kFaceNotForward: 'turned away from the camera', kMultipleFacesFound: 'more than one face in view',
  kTooDark: 'too dark', kTooBright: 'too bright', kExcessiveMotion: 'moving', kCameraTuning: 'camera adjusting',
  kFrameRateTooLow: 'camera too slow', noStablePulse: 'no steady pulse reading', noStableBreathing: 'no steady breathing reading',
};
const reasonText = (code) => REASON_TEXT[code] || 'measurement interrupted';

// Each question_shown event opens a window that the next one (or the end) closes.
function questionWindows(events, endT) {
  const windows = [];
  let cur = null;
  for (const e of events) {
    if (e.type !== 'question_shown') continue;
    if (cur) windows.push({ ...cur, end: e.t });
    cur = { q: e.q, start: e.t };
  }
  if (cur && endT > cur.start) windows.push({ ...cur, end: endT });
  return windows.filter((w) => w.end > w.start);
}

function questionAt(windows, t) {
  for (const w of windows) if (t >= w.start && t < w.end) return w.q;
  return null;
}

// Per question: time on screen, how much of it was measured, and why the rest was not.
// gaps: pause gaps plus "no stable reading" gaps for the signal coverage is based on.
function alignQuestions(windows, gaps, count, cfg = CONFIG.coverage) {
  const out = Array.from({ length: count }, (_, q) => ({ q, timeMs: 0, measuredMs: 0, gapMs: {} }));
  for (const w of windows) {
    const r = out[w.q];
    if (!r) continue;
    const len = w.end - w.start;
    r.timeMs += len;
    r.measuredMs += len - coveredLength(w.start, w.end, gaps);
    for (const g of gaps) {
      const ov = Math.min(w.end, g.end) - Math.max(w.start, g.start);
      if (ov > 0) r.gapMs[g.reason] = (r.gapMs[g.reason] || 0) + ov;
    }
  }
  for (const r of out) {
    const f = r.timeMs ? r.measuredMs / r.timeMs : 0;
    r.coverage = !r.timeMs ? 'not_shown' : f >= cfg.full ? 'full' : f <= cfg.none ? 'none' : 'partial';
    // Longest reason first, as plain words ("not measured: moved out of view").
    r.notMeasuredBecause = [...new Set(Object.entries(r.gapMs).sort((a, b) => b[1] - a[1]).map(([k]) => reasonText(k)))];
  }
  return out;
}

function coverageSummary(perQuestion) {
  const s = { full: 0, partial: 0, none: 0, not_shown: 0 };
  for (const r of perQuestion) s[r.coverage]++;
  return s;
}

// Final answer and review mark per question, replayed from the event log.
function finalAnswers(events, count) {
  const answers = new Array(count).fill(null);
  const marked = new Array(count).fill(false);
  for (const e of events) {
    if (e.type === 'answer_selected' || e.type === 'answer_changed') answers[e.q] = e.option;
    else if (e.type === 'answer_cleared') answers[e.q] = null;
    else if (e.type === 'marked_for_review') marked[e.q] = !!e.marked;
  }
  return { answers, marked };
}

module.exports = { questionWindows, questionAt, alignQuestions, coverageSummary, finalAnswers, reasonText };
