'use strict';

// Every tunable threshold in one place. First set from the 45 s probe and
// Presage's analysis windows (pulse 12 s, breathing 30 s, HRV 60 s); report
// and breathing-spacing values retuned from the live Run 1 (2026-11-17, see
// CLAUDE.md). Calibration values held up in Run 1 and are unchanged.
module.exports = {
  calibration: {
    warmupHintSlowSeconds: 120, // after this, the "getting ready" hint suggests checking position and light
    warmupMaxSeconds: 300, // give up if pulse and breathing never became stable once
    minCalmSeconds: 60, // calm seconds needed for pulse and for breathing, counted separately
    maxCalibrationSeconds: 180, // cap after warm-up; then save what was measured, with a note
    minBreathingReadings: 3, // fewer stable breathing readings than this extends calibration (up to the cap)
    pulseFreshSeconds: 10, // a second counts as calm for pulse if a stable pulse arrived this recently
    breathingFreshSeconds: 45, // breathing rate readings are sparse, so the window is longer
    hrvContinuousOkSeconds: 60, // HRV samples count only after this much continuous OK position
  },
  test: {
    defaultMinutes: 10,
    quickDemoMinutes: 4,
    lateSampleGraceSeconds: 10, // pulse arrives ~8 s after its own timestamp; wait this long after the test ends
  },
  coverage: {
    // A question is "measured fully" at >= full of its time, "not at all" at <= none.
    full: 0.9,
    none: 0.1,
    // Longer than this between stable samples counts as a "no stable reading" gap.
    pulseMaxSpacingSeconds: 5,
    // Run 1 (live, 2026-11-17): stable breathing readings every 1.7 s (median), p95 7.7 s;
    // the only longer spacings (18 and 20 s) were real gaps at the start. Was 45.
    breathingMaxSpacingSeconds: 10,
  },
  report: {
    // Per-question reading. Run 1: students spend 7 to 15 s on a question, and stable
    // pulse readings came every 0.9 s (median), p90 2.0 s.
    minOnScreenSeconds: 6, // = pulseLagSeconds: shorter than this, no reading has half its ~12 s window on the question ("too brief to read"). Was 15.
    minStablePulseSeconds: 4, // less measured pulse time than this (after the lag shift): "not measured". Was 10.
    minQuestionPulseSamples: 3, // and at least this many stable readings
    briefOnScreenSeconds: 15, // a reading from a question shown less than this...
    briefStablePulseSeconds: 10, // ...or with less measured pulse than this is labelled "brief"
    resettleToleranceSeconds: 2, // a no-stable-pulse stretch starting this close to a pause end is "pulse re-settling"
    riseBpm: 8, // a noticeable rise: at least this far above baseline...
    riseMinSeconds: 6, // ...for at least this long (half a ~12 s pulse window; Run 1's clear Q5 rise held 7 s). Was 20.
    recoveredWithinBpm: 4, // recovered once back within this of baseline; timed from the rise's peak
    // A pulse value summarises roughly the previous 12 s, so a question's own
    // response shows up a few seconds after it appears: analyse each question
    // window shifted later by this much.
    pulseLagSeconds: 6,
    minBreathingReadingsPerSection: 3, // per third of the test
    minHrvReadingsPerHalf: 3,
    // Observations only when there is enough data:
    minMeasuredQuestions: 4, // readable questions needed for question-level observations
    minStablePulseSamples: 30,
    minQuestionsPerDifficulty: 3, // hard and easy each, for the comparison
    observationMinRiseBpm: 5, // below this, the "biggest rise" observation says pulse stayed close to baseline
    sameWithinBpm: 2, // hard vs easy medians closer than this read as "about the same"
    minBreathingChangeForObservation: 3, // breaths per minute, last third vs first third
    resetObsWindowSeconds: 60, // compare the minute before a reset with the minute after
    resetObsMinSamples: 20, // stable pulse samples needed in each of those minutes
    maxObservations: 3,
  },
  reset: {
    inhaleSeconds: 4,
    exhaleSeconds: 6,
    cycles: 3,
    pulseWindowSeconds: 12, // "at the start" / "at the end" pulse: stable samples in this window before each moment
    minPulseSamples: 3, // fewer than this in either window: say nothing about pulse
  },
  monitor: {
    tickMs: 250,
  },
  // Dev/demo only: a looping video file (PREPPULSE_VIDEO_LOOP=1). Windows follow
  // Presage's analysis windows (pulse 12 s, breathing 30 s, HRV 60 s).
  video: {
    restartGapSeconds: 12, // shown as "not measured: video restarted" after each restart
    restartDropSeconds: { pulse: 12, breathing: 30, hrv: 60 }, // samples mixing both ends are dropped
  },
};
