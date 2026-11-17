'use strict';

// Every tunable threshold in one place. Values are first guesses from the
// 45 s probe and Presage's analysis windows (pulse 12 s, breathing 30 s,
// HRV 60 s); retune them after the live camera session.
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
    breathingMaxSpacingSeconds: 45,
  },
  report: {
    minOnScreenSeconds: 15, // shorter than this on screen: "too brief to read"
    minStablePulseSeconds: 10, // less measured pulse time than this: "too brief to read"
    resettleToleranceSeconds: 2, // a no-stable-pulse stretch starting this close to a pause end is "pulse re-settling"
    riseBpm: 8, // a noticeable rise: at least this far above baseline...
    riseMinSeconds: 20, // ...for at least this long
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
