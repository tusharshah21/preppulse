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
    recoveredWithinBpm: 4, // recovered once back within this of baseline; timed from the rise's last reading at or above riseBpm
    minBreathingReadingsPerSection: 3, // per third of the test
    minHrvReadingsPerHalf: 3,
    // Observations only when there is enough data:
    minMeasuredQuestions: 4, // readable questions needed for question-level observations
    minStablePulseSamples: 30,
    minQuestionsPerDifficulty: 3, // hard and easy each, for the comparison
    observationMinRiseBpm: 5, // below this, the "biggest rise" observation says pulse stayed close to baseline
    sameWithinBpm: 2, // hard vs easy medians closer than this read as "about the same"
    sameBreathingWithin: 1, // breaths per minute
    maxObservations: 3,
  },
  monitor: {
    tickMs: 250,
  },
};
