'use strict';

// "Your pressure map": the post-test report, built from a saved session file
// (lib/session.js). Pure functions; every comparison is against the baseline
// stored in that session, never against other people or "normal ranges".
// Thresholds live in lib/config.js (report, coverage).
//
// Timing: an SDK pulse value is computed over roughly the previous 12 s and
// arrives ~8 s after its own timestamp. Everything here is aligned by the
// sample's own timestamp (ms since test start in the session file), not by
// arrival time. Because each value looks back ~12 s, the body's response to a
// question shows up a few seconds after the question appears, so per-question
// numbers use the question's window shifted later by report.pulseLagSeconds
// (clipped to the end of the test). The chart bands stay at the real times.
const CONFIG = require('./config');
const { median } = require('./baseline');
const { questionWindows, reasonText } = require('./align');
const { subtract, coveredLength } = require('./intervals');
const { saidText } = require('./checkin');

const r0 = (x) => (x == null ? null : Math.round(x));
const signed = (x) => (x > 0 ? `+${x}` : String(x));
const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const TIMES = { 1: 'once', 2: 'twice' };
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return pl(s, 'second', 'seconds');
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : pl(s / 60, 'minute', 'minutes');
}

// "about 1 minute 25 seconds": rounded to 5 s, words spelled out.
function aboutDuration(ms) {
  const s = Math.max(5, Math.round(ms / 5000) * 5);
  const m = Math.floor(s / 60);
  const parts = [];
  if (m) parts.push(pl(m, 'minute', 'minutes'));
  if (s % 60) parts.push(pl(s % 60, 'second', 'seconds'));
  return parts.join(' ');
}

const overlapsAny = (a, b, gaps) => gaps.some((g) => g.start < b && g.end > a);

// Split [t, v] points into drawable runs: never join across a pause or a
// spacing longer than maxSpacing (no interpolation over unmeasured time).
function segments(points, maxSpacing, pauses) {
  const out = [];
  let cur = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && (p[0] - prev[0] > maxSpacing || overlapsAny(prev[0], p[0], pauses))) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Gaps for the chart, labelled. Validation pauses are "not measured: <reason>".
// The no-stable-pulse stretch right after a pause is "pulse re-settling".
function labelGaps(session, cfg = CONFIG.report) {
  const pauses = (session.gaps?.pauses || []).map((g) => ({ start: g.start, end: g.end, reason: g.reason, kind: 'pause', label: `not measured: ${reasonText(g.reason)}` }));
  const tol = cfg.resettleToleranceSeconds * 1000;
  const other = [];
  for (const g of session.gaps?.noStableReading || []) {
    if (g.reason !== 'noStablePulse') continue;
    for (const [s, e] of subtract(g.start, g.end, pauses)) {
      const touchesPause = pauses.some((p) => Math.abs(p.start - e) <= tol || Math.abs(p.end - s) <= tol);
      if (touchesPause && e - s < tol) continue; // a sliver beside a pause, already shown by the pause
      const resettling = pauses.some((p) => Math.abs(p.end - s) <= tol);
      other.push(resettling
        ? { start: s, end: e, reason: g.reason, kind: 'resettling', label: 'pulse re-settling' }
        : { start: s, end: e, reason: g.reason, kind: 'no_reading', label: 'not measured: no steady pulse reading' });
    }
  }
  return [...pauses, ...other].sort((a, b) => a.start - b.start);
}

// Noticeable rises (>= riseBpm above baseline for >= riseMinSeconds) and how
// long after each rise's peak the pulse came back within recoveredWithinBpm.
// A rise whose recovery is hidden by a pause or the end of the test gets
// recoveryMs: null (not seen), never a guess.
function findRises(runs, cfg = CONFIG.report) {
  const rises = [];
  for (const run of runs) {
    let cand = null;
    let rise = null;
    for (const [t, d] of run) {
      if (rise) {
        if (d > rise.peak) { rise.peak = d; rise.peakT = t; }
        if (d >= cfg.riseBpm) rise.highEnd = t;
        if (d <= cfg.recoveredWithinBpm) { rise.recoveredT = t; rise.recoveryMs = t - rise.peakT; rises.push(rise); rise = null; }
      } else if (d >= cfg.riseBpm) {
        cand = cand || { start: t, peak: d, peakT: t };
        cand.highEnd = t;
        if (d > cand.peak) { cand.peak = d; cand.peakT = t; }
        if (t - cand.start >= cfg.riseMinSeconds * 1000) { rise = cand; cand = null; }
      } else cand = null;
    }
    if (rise) rises.push({ ...rise, recoveredT: null, recoveryMs: null });
  }
  // highEnd: the last reading still >= riseBpm (the rise's high stretch is start..highEnd).
  return rises.map((r) => ({ start: r.start, highEnd: r.highEnd, peakT: r.peakT, peak: r0(r.peak), recoveredT: r.recoveredT, recoveryMs: r.recoveryMs }));
}

// The highest rise; its recovery may be null (not seen).
const biggestRise = (rises) => rises.reduce((best, r) => (!best || r.peak > best.peak ? r : best), null);

function sectionStats(points, n, durationMs, minReadings, base) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = (durationMs * i) / n;
    const end = (durationMs * (i + 1)) / n;
    const vals = points.filter(([t]) => t >= start && t < end).map(([, v]) => v);
    if (vals.length < minReadings) continue; // left out, not shown as empty
    const m = median(vals);
    out.push({ index: i, start, end, readings: vals.length, median: Math.round(m * 10) / 10, change: Math.round((m - base) * 10) / 10 });
  }
  return out;
}

// Reset bands from reset_start / reset_end events (an unfinished one ends with the test).
function resetBands(events, durationMs) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.type === 'reset_start' && open == null) open = e.t;
    if (e.type === 'reset_end' && open != null) { out.push({ start: open, end: e.t }); open = null; }
  }
  if (open != null && durationMs > open) out.push({ start: open, end: durationMs });
  return out;
}

// ---------- Observations (rule-based, deterministic) ----------

// Questions a rise belongs to, consistent with the tiles: its high stretch moved
// back by the pulse lag (a reading trails the body), then the questions it
// overlaps whose own value is itself a rise (>= riseBpm). If none is, the one
// it overlaps most.
function riseQuestions(rise, windows, qs, cfg) {
  const lag = cfg.pulseLagSeconds * 1000;
  const a = rise.start - lag;
  const b = Math.max(rise.highEnd, rise.start + 1) - lag;
  const share = {};
  for (const w of windows) share[w.q] = (share[w.q] || 0) + Math.max(0, Math.min(b, w.end) - Math.max(a, w.start));
  const touched = Object.entries(share).filter(([, ms]) => ms > 0).sort((x, y) => y[1] - x[1]).map(([q]) => Number(q));
  const risen = touched.filter((n) => qs.find((q) => q.q === n)?.medianChange >= cfg.riseBpm);
  return (risen.length ? risen : touched.slice(0, 1)).sort((x, y) => x - y);
}

const qList = (qs) => (qs.length === 1 ? `Q${qs[0] + 1}` : qs.length === 2 ? `Q${qs[0] + 1} and Q${qs[1] + 1}` : `Q${qs[0] + 1} to Q${qs.at(-1) + 1}`);

// Rises are found on the pulse timeline itself, then named by question.
function obsBiggestRise(rises, windows, qs, cfg) {
  const big = biggestRise(rises);
  if (!big) {
    if (qs.filter((q) => q.status === 'ok').length < cfg.minMeasuredQuestions) return null;
    return `Your pulse did not stay ${cfg.riseBpm} or more beats per minute above your calm baseline for ${cfg.riseMinSeconds} seconds or longer in this test.`;
  }
  const named = riseQuestions(big, windows, qs, cfg);
  if (!named.length) return `Your pulse rose most at ${clock(big.peakT)} (${signed(big.peak)} above your calm baseline).`;
  let s = `Your pulse rose most around ${qList(named)} (${signed(big.peak)} above your calm baseline).`;
  // A second sentence only when something happened on one of those questions.
  const a = named.map((n) => qs.find((q) => q.q === n)).find((q) => q && (q.changes || q.skipped || q.marked));
  if (a?.changes) s += ` You changed your answer ${TIMES[a.changes] || `${a.changes} times`} on Q${a.q + 1}.`;
  else if (a?.skipped) s += a.answer == null ? ` You skipped Q${a.q + 1}.` : ` You skipped Q${a.q + 1} at first and answered it later.`;
  else if (a?.marked) s += ` You marked Q${a.q + 1} for review.`;
  return s;
}

function obsRecovery(rises) {
  const big = biggestRise(rises);
  if (!big || big.recoveryMs == null) return null;
  return `After your biggest rise, your pulse took about ${aboutDuration(big.recoveryMs)} to settle back near your calm baseline.`;
}

function obsReset(resets, pulse, cfg) {
  const w = cfg.resetObsWindowSeconds * 1000;
  const lag = cfg.pulseLagSeconds * 1000;
  for (const r of resets) {
    const before = pulse.filter(([t]) => t >= r.start - w + lag && t < r.start + lag).map(([, d]) => d);
    const after = pulse.filter(([t]) => t >= r.end + lag && t < r.end + w + lag).map(([, d]) => d);
    if (before.length < cfg.resetObsMinSamples || after.length < cfg.resetObsMinSamples) continue;
    return `In the minute before your reset at ${clock(r.start)}, your pulse was a median of ${signed(r0(median(before)))} compared with your calm baseline, and ${signed(r0(median(after)))} in the minute after. This compares two minutes; it can't tell what caused the change.`;
  }
  return null;
}

function obsHardVsEasy(qs, cfg) {
  // A comparison between groups uses full readings only, never brief ones.
  const by = (d) => qs.filter((q) => q.status === 'ok' && !q.brief && q.difficulty === d).map((q) => q.medianChange);
  const hard = by('hard');
  const easy = by('easy');
  if (hard.length < cfg.minQuestionsPerDifficulty || easy.length < cfg.minQuestionsPerDifficulty) return null;
  const h = r0(median(hard));
  const e = r0(median(easy));
  if (Math.abs(h - e) < cfg.sameWithinBpm) return `Your pulse change was about the same on hard-tagged and easy questions (${signed(h)} and ${signed(e)} compared with your calm baseline).`;
  return `On hard-tagged questions your pulse was a median of ${signed(h)} compared with your calm baseline, and ${signed(e)} on easy ones.`;
}

function obsBreathing(sections, cfg) {
  const first = sections.find((s) => s.index === 0);
  const last = sections.find((s) => s.index === 2);
  if (!first || !last || Math.abs(last.median - first.median) < cfg.minBreathingChangeForObservation) return null;
  return `Your breathing rate was ${Math.round(last.median)} breaths per minute in the last third of the test, compared with ${Math.round(first.median)} in the first third.`;
}

// Reasons in report words: next to a pause, missing pulse is the re-settling stretch.
function reportReasons(reasons = []) {
  const NO_PULSE = 'no steady pulse reading';
  const others = reasons.filter((r) => r !== NO_PULSE && r !== 'no steady breathing reading');
  if (!others.length) return reasons.filter((r) => r === NO_PULSE);
  return reasons.includes(NO_PULSE) ? [...others, 'pulse re-settling'] : others;
}

const CLOSING = 'Patterns get clearer after a few practice tests.';
const NOT_ENOUGH = 'There was not enough measured data in this test to describe a pattern.';

// ---------- Build ----------

function buildReport(session, cfg = CONFIG.report, coverageCfg = CONFIG.coverage) {
  const events = session.events || [];
  const durationMs = events.find((e) => e.type === 'test_end')?.t ?? session.settings?.durationMs ?? 0;
  const windows = questionWindows(events, durationMs);
  const base = session.baseline || {};
  const stable = (rows) => (rows || []).filter((r) => r[3]).map((r) => [r[0], r[1]]);
  const pulse = stable(session.samples?.pulse).map(([t, v]) => [t, v - base.pulseBpm]);
  const breathing = stable(session.samples?.breathing);
  const hrv = stable(session.samples?.hrv);
  const gaps = labelGaps(session, cfg);
  const pauses = gaps.filter((g) => g.kind === 'pause');
  const pulseRuns = segments(pulse, coverageCfg.pulseMaxSpacingSeconds * 1000, pauses);
  const resets = resetBands(events, durationMs);

  // Lag-shifted analysis windows per question, and what was measured inside them.
  const lag = cfg.pulseLagSeconds * 1000;
  const unmeasured = [...pauses, ...(session.gaps?.noStableReading || []).filter((g) => g.reason === 'noStablePulse')];
  const shifted = windows
    .map((w) => ({ q: w.q, start: Math.min(w.start + lag, durationMs), end: Math.min(w.end + lag, durationMs) }))
    .filter((w) => w.end > w.start);

  const changes = {};
  const skipped = {};
  const marked = {};
  const markers = [];
  for (const e of events) {
    if (e.type === 'answer_changed') { changes[e.q] = (changes[e.q] || 0) + 1; markers.push({ t: e.t, q: e.q, type: 'changed' }); }
    if (e.type === 'skipped') { skipped[e.q] = true; markers.push({ t: e.t, q: e.q, type: 'skipped' }); }
    if (e.type === 'marked_for_review' && e.marked) { marked[e.q] = true; markers.push({ t: e.t, q: e.q, type: 'marked' }); }
  }

  const questions = (session.questions || []).map((q) => {
    const mine = shifted.filter((w) => w.q === q.q);
    const vals = pulse.filter(([t]) => mine.some((w) => t >= w.start && t < w.end)).map(([, d]) => d);
    const measuredMs = mine.reduce((s, w) => s + (w.end - w.start) - coveredLength(w.start, w.end, unmeasured), 0);
    // "too brief to read" only when there is really no usable reading; a short but
    // measured question shows its value, labelled brief.
    let status = 'ok';
    if (!q.timeMs) status = 'not_shown';
    else if (q.timeMs < cfg.minOnScreenSeconds * 1000) status = 'too_brief';
    else if (q.coverage === 'none' || vals.length < cfg.minQuestionPulseSamples || measuredMs < cfg.minStablePulseSeconds * 1000) status = 'not_measured';
    const ok = status === 'ok';
    const brief = ok && (q.timeMs < cfg.briefOnScreenSeconds * 1000 || measuredMs < cfg.briefStablePulseSeconds * 1000);
    return {
      q: q.q, id: q.id, subject: q.subject, difficulty: q.difficulty, timeMs: q.timeMs, answer: q.answer, correct: q.correct,
      coverage: q.coverage, measuredSeconds: Math.round(measuredMs / 1000), notMeasuredBecause: reportReasons(q.notMeasuredBecause),
      status, brief, medianChange: ok ? r0(median(vals)) : null, peakChange: ok ? r0(Math.max(...vals)) : null,
      changes: changes[q.q] || 0, skipped: !!skipped[q.q], marked: !!marked[q.q] || !!q.markedForReview,
    };
  });

  const rises = findRises(pulseRuns, cfg);
  const recovered = rises.filter((r) => r.recoveryMs != null).map((r) => r.recoveryMs);
  const medianRecoveryMs = recovered.length ? median(recovered) : null;
  const big = biggestRise(rises);
  const breathingSections = base.breathingPerMin == null ? [] : sectionStats(breathing, 3, durationMs, cfg.minBreathingReadingsPerSection, base.breathingPerMin);
  const hrvHalves = base.hrvRmssdMs == null ? [] : sectionStats(hrv, 2, durationMs, cfg.minHrvReadingsPerHalf, base.hrvRmssdMs);

  // Priority: biggest rise, recovery, hard vs easy, breathing, reset. At most maxObservations.
  const enoughPulse = pulse.length >= cfg.minStablePulseSamples;
  const observations = [
    enoughPulse && obsBiggestRise(rises, windows, questions, cfg),
    enoughPulse && obsRecovery(rises),
    enoughPulse && obsHardVsEasy(questions, cfg),
    obsBreathing(breathingSections, cfg),
    obsReset(resets, pulse, cfg),
  ].filter(Boolean);

  const shown = questions.filter((q) => q.status !== 'not_shown');
  const readable = questions.filter((q) => q.status === 'ok');
  const hardReadable = readable.filter((q) => q.difficulty === 'hard').map((q) => q.medianChange);
  const top = [...readable].sort((x, y) => y.medianChange - x.medianChange)[0];
  const pulseSummary = !pulse.length
    ? 'Pulse chart: no steady pulse readings were measured in this test.'
    : `Pulse chart, change from your calm baseline of ${r0(base.pulseBpm)} beats per minute over ${duration(durationMs)}. `
      + `${pl(readable.length, 'question has', 'questions have')} a reading${top ? `; the largest median change was ${signed(top.medianChange)} on Q${top.q + 1}` : ''}. `
      + `${pl(rises.length, 'noticeable rise', 'noticeable rises')}. `
      + `${pl(pauses.length, 'pause', 'pauses')} where measurement stopped${pauses.length ? `, totalling ${duration(pauses.reduce((s, g) => s + g.end - g.start, 0))}` : ''}.`
      + `${resets.length ? ` ${resets.length === 1 ? 'One 30-second reset' : resets.length + ' resets of 30 seconds'} at ${resets.map((r) => clock(r.start)).join(', ')}.` : ''}`;
  const breathingSummary = !breathing.length
    ? 'Breathing chart: no steady breathing readings were measured in this test.'
    : `Breathing chart: ${pl(breathing.length, 'breathing rate reading', 'breathing rate readings')}`
      + `${base.breathingPerMin == null ? '' : `, compared with your calm baseline of ${r0(base.breathingPerMin)} per minute`}`
      + `${breathingSections.length ? `. By third of the test: ${breathingSections.map((s) => `part ${s.index + 1}, ${Math.round(s.median)} per minute`).join('; ')}` : ''}.`;
  // The header counts exactly what the tiles show: questions with a pulse value, and how many of those are brief.
  const readCount = readable.length;
  const briefCount = readable.filter((q) => q.brief).length;

  return {
    simulated: !!session.source?.simulated,
    dataset: session.source?.dataset || null, // made from a demo video, not the student
    startedAt: session.startedAt,
    title: session.questionSet?.title || 'Practice test',
    selfReport: saidText(session.selfReport?.feeling), // "a bit tough", or null
    pulseLagSeconds: cfg.pulseLagSeconds, // for the "shifted about N seconds later" note
    header: { score: session.score, durationMs, readCount, briefCount, questionCount: questions.length, shownCount: shown.length },
    baseline: { pulseBpm: base.pulseBpm ?? null, breathingPerMin: base.breathingPerMin ?? null, hrvRmssdMs: base.hrvRmssdMs ?? null },
    timeline: { durationMs, windows, markers, gaps, resets, pulseRuns, breathingRuns: segments(breathing, coverageCfg.breathingMaxSpacingSeconds * 1000, pauses) },
    questions,
    rises,
    medianRecoveryMs,
    breathingSections,
    hrvHalves,
    observations: observations.slice(0, cfg.maxObservations),
    enoughData: observations.length > 0,
    notEnoughText: NOT_ENOUGH,
    closing: CLOSING,
    summaries: { pulse: pulseSummary, breathing: breathingSummary },
    // For "Your progress" on the home screen.
    summary: {
      correct: session.score?.correct ?? 0,
      total: session.score?.total ?? questions.length,
      hardMedianChange: hardReadable.length ? r0(median(hardReadable)) : null,
      biggestRiseSettleMs: big?.recoveryMs ?? null,
      measuredShare: questions.length ? readCount / questions.length : 0, // share of questions with a pulse value
    },
  };
}

module.exports = { buildReport, labelGaps, findRises, segments, sectionStats, resetBands, duration, aboutDuration };
