'use strict';

// One mock-test session: the question event log, the signal samples, and the
// pauses, all on one clock (ms since test start, from Date.now() in the main
// process; SDK sample timestamps are epoch µs and are converted to the same
// clock). Numbers only: no frames, no images. finish() builds the JSON that is
// saved to userData/preppulse-data/sessions/<timestamp>.json.
const CONFIG = require('./config');
const { createGapTracker, spacingGaps } = require('./intervals');
const { questionWindows, questionAt, alignQuestions, coverageSummary, finalAnswers } = require('./align');

const NAV_VIA = new Set(['next', 'previous', 'palette']);

function createTestSession({ startedAt, durationMs, settings, baseline, questions, source, lastValidation, cfg = CONFIG }) {
  const n = questions.questions.length;
  const rel = (tMs) => Math.round(tMs - startedAt);
  const gaps = createGapTracker();
  const samples = { pulse: [], breathing: [], hrv: [] }; // [t, value, confidence, stable 0|1]
  const seen = { pulse: new Set(), breathing: new Set(), hrv: new Set() };
  const trace = []; // [t, value], breathing waveform
  const events = [];
  const answers = new Array(n).fill(null);
  const marked = new Array(n).fill(false);
  let current = null;
  let inReset = false;
  let endT = null;

  if (lastValidation && !lastValidation.ok) gaps.update(0, false, lastValidation.code, lastValidation.hint);
  events.push({ t: 0, type: 'test_start' });

  const inTest = (t) => t >= 0 && (endT == null || t <= endT);
  const add = (kind, s, value) => {
    if (!s || !Number.isFinite(s.timestamp) || !Number.isFinite(value) || seen[kind].has(s.timestamp)) return;
    const t = rel(s.timestamp / 1000);
    if (!inTest(t)) return;
    seen[kind].add(s.timestamp);
    samples[kind].push([t, Math.round(value * 10) / 10, s.confidence == null ? null : Math.round(s.confidence * 10) / 10, s.stable ? 1 : 0]);
  };

  // Renderer input is checked here (trust boundary). Returns false if ignored.
  function event(tMs, e) {
    if (endT != null || !e || typeof e.type !== 'string') return false;
    const t = rel(tMs);
    const q = e.q;
    const validQ = Number.isInteger(q) && q >= 0 && q < n;
    switch (e.type) {
      case 'question_shown':
        if (!validQ || q === current) return false;
        current = q;
        events.push({ t, type: 'question_shown', q });
        return true;
      case 'answer_selected': {
        if (!validQ || !Number.isInteger(e.option) || e.option < 0 || e.option > 3 || answers[q] === e.option) return false;
        const previous = answers[q];
        answers[q] = e.option;
        events.push(previous == null ? { t, type: 'answer_selected', q, option: e.option } : { t, type: 'answer_changed', q, option: e.option, previous });
        return true;
      }
      case 'answer_cleared':
        if (!validQ || answers[q] == null) return false;
        events.push({ t, type: 'answer_cleared', q, previous: answers[q] });
        answers[q] = null;
        return true;
      case 'marked_for_review':
        if (!validQ) return false;
        marked[q] = !!e.marked;
        events.push({ t, type: 'marked_for_review', q, marked: marked[q] });
        return true;
      case 'skipped':
        if (!validQ || answers[q] != null) return false;
        events.push({ t, type: 'skipped', q });
        return true;
      case 'navigate':
        if (!validQ || !Number.isInteger(e.from) || e.from < 0 || e.from >= n || !NAV_VIA.has(e.via)) return false;
        events.push({ t, type: 'navigate', from: e.from, to: q, via: e.via });
        return true;
      // 30-second reset during the test (the timer keeps running).
      case 'reset_start':
        if (inReset) return false;
        inReset = true;
        events.push({ t, type: 'reset_start' });
        return true;
      case 'reset_end':
        if (!inReset) return false;
        inReset = false;
        events.push({ t, type: 'reset_end' });
        return true;
      default:
        return false;
    }
  }

  return {
    event,
    onValidation(tMs, v) {
      if (endT == null) gaps.update(Math.max(0, rel(tMs)), !!v?.ok, v?.code, v?.hint);
    },
    onError(tMs, e) {
      if (endT == null) gaps.update(Math.max(0, rel(tMs)), false, e?.code || 'error', e?.message);
    },
    // Late samples (pulse arrives ~8 s after its timestamp) are still accepted
    // after end() as long as their timestamp falls inside the test.
    onMetrics(_tMs, p) {
      add('pulse', p?.pulse, p?.pulse?.value);
      add('breathing', p?.breathing, p?.breathing?.value);
      add('hrv', p?.hrv, p?.hrv?.rmssd);
      for (const [ts, v] of p?.trace || []) {
        const t = rel(ts / 1000);
        if (inTest(t) && (!trace.length || t > trace[trace.length - 1][0])) trace.push([t, Math.round(v * 1000) / 1000]);
      }
    },
    end(tMs, reason) {
      if (endT != null) return false;
      endT = Math.min(rel(tMs), durationMs);
      gaps.close(endT);
      events.push({ t: endT, type: 'test_end', reason: reason === 'time_up' ? 'time_up' : 'submitted' });
      return true;
    },
    get ended() { return endT != null; },

    // Score and time per question, available right after end().
    result() {
      const windows = questionWindows(events, endT);
      const final = finalAnswers(events, n);
      const perQuestion = questions.questions.map((q, i) => {
        const timeMs = windows.filter((w) => w.q === i).reduce((s, w) => s + w.end - w.start, 0);
        const a = final.answers[i];
        return { q: i, id: q.id, subject: q.subject, difficulty: q.difficulty, timeMs, answer: a, correct: a == null ? null : a === q.answer, markedForReview: final.marked[i] };
      });
      const correct = perQuestion.filter((r) => r.correct).length;
      return { score: { correct, attempted: perQuestion.filter((r) => r.answer != null).length, total: n }, durationMs: endT, perQuestion, windows };
    },

    // The full saved session, with alignment. Call after the late-sample grace period.
    finish() {
      const { score, perQuestion, windows } = this.result();
      for (const k of Object.keys(samples)) samples[k].sort((a, b) => a[0] - b[0]);
      const stableTimes = (k) => samples[k].filter((s) => s[3]).map((s) => s[0]);
      const pauses = gaps.snapshot(endT);
      const noStable = [
        ...spacingGaps(stableTimes('pulse'), 0, endT, cfg.coverage.pulseMaxSpacingSeconds * 1000, 'noStablePulse'),
        ...spacingGaps(stableTimes('breathing'), 0, endT, cfg.coverage.breathingMaxSpacingSeconds * 1000, 'noStableBreathing'),
      ];
      // Coverage is based on pulse: breathing readings are too sparse to judge a single question by.
      const aligned = alignQuestions(windows, [...pauses, ...noStable.filter((g) => g.reason === 'noStablePulse')], n, cfg.coverage);
      const withQ = (rows) => rows.map((r) => [...r, questionAt(windows, r[0])]);
      return {
        format: 'preppulse-session/1',
        startedAt: new Date(startedAt).toISOString(),
        clock: 'ms since test start (startedAt)',
        source,
        settings,
        baseline,
        questionSet: { title: questions.title, ids: questions.questions.map((q) => q.id) },
        score,
        events: events.map((e, i) => (e.type === 'question_shown'
          ? { ...e, onScreenMs: (events.slice(i + 1).find((x) => x.type === 'question_shown' || x.type === 'reset_start' || x.type === 'test_end')?.t ?? endT) - e.t }
          : e)),
        questions: perQuestion.map((r, i) => ({ ...r, measuredMs: Math.round(aligned[i].measuredMs), coverage: aligned[i].coverage, notMeasuredBecause: aligned[i].notMeasuredBecause })),
        coverage: { basedOn: 'pulse', ...coverageSummary(aligned) },
        gaps: { pauses, noStableReading: noStable },
        samples: {
          columns: ['t', 'value', 'confidence', 'stable', 'question'],
          pulse: withQ(samples.pulse),
          breathing: withQ(samples.breathing),
          hrv: withQ(samples.hrv),
        },
        breathingTrace: { columns: ['t', 'value'], points: trace },
      };
    },
  };
}

module.exports = { createTestSession };
