# PrepPulse

Entry for the Presage SmartSpectra SDK Challenge on DEV (deadline 22 Nov 2026, 11:59 PM PST).

A desktop app (Electron + Node.js) for students preparing for high-stakes exams (JEE/NEET, SAT, A-levels). A student takes a timed mock test while the webcam measures pulse and breathing with the SmartSpectra SDK. Afterwards they see a "stress map" of how their body responded at each question, plus a short breathing reset drill. Everything is compared with the student's own baseline, never with "normal ranges".

## Hard rules (contest + ethics), apply to all work

- No diagnosis, treatment, or medical claims. Never use words like "anxiety detection", "diagnose", "at-risk", "disorder", "healthy/unhealthy". Use phrasing like "your body's response" and "compared with your own baseline". (Presage's own docs: SDK metrics are for general wellness and informational use only, not FDA-cleared.)
- Camera only turns on after explicit opt-in consent. No covert monitoring. The SDK camera is opened only from the `vitals:start` IPC handler, which the renderer calls only after the student pressed "I agree, start camera" in this app run. Consent is not persisted; it is asked again on every launch.
- Process on the device. Never save or upload video frames or face images. Do not subscribe to the SDK `videoOutput` event unless a frame stays in memory for display only.
- SDK telemetry disabled (`enableTelemetry: false`) unless the developer decides otherwise. Keep the network facts below current.
- Any stored data is local only, with a clear delete option. No accounts.
- The API key is read from `.env` (`SMARTSPECTRA_API_KEY`, gitignored). Never print it, log it, send it to the renderer, or hardcode it. `.env.example` holds a placeholder.
- Writing style: no em dashes anywhere.

## Architecture

- `lib/vitals.js`: the only place that talks to the SDK (`startSession`, `stopSession`). Native camera capture in the main process (`useCamera`), so the API key never reaches the renderer. Turns each metrics packet into a plain-number payload (`toPayload`: pulse, breathing, hrv, trace). Also `downscaleToRGBA` for the preview.
- `lib/recording.js`: recorder and replay of the four IPC event channels (`vitals:status`, `vitals:validation`, `vitals:error`, `vitals:metrics`). Recordings are numeric only. Replay loops at real speed and shifts timestamps each pass.
- `lib/baseline.js`: median-based calm baseline from calibration samples.
- `main.js`: window, IPC handlers, live vs replay switch, preview throttling, baseline storage, delete-all-data.
- `preload.js`: exposes `window.vitals` via `contextBridge`.
- `index.html` + `renderer.js`: consent, home, calibration, settings screens. No Node access (`contextIsolation`, `sandbox`). All renderer permission requests are denied.
- Preview frames: `videoOutput` (1280x720 RGB) is downscaled in main to ~320 px, throttled to ~10 fps, sent on `vitals:frame` only while the renderer has preview on. Never recorded, logged, or written to disk.
- Storage: `app.getPath('userData')/preppulse-data/baseline.json` (latest calm baseline). Delete all data removes that folder and clears Chromium storage for the app session. Dev recordings live in `data/recordings/` (gitignored, project folder, not user data).
- Env: `PREPPULSE_REPLAY=<recording.json>` replays instead of starting camera/SDK; `PREPPULSE_RECORD=1` saves live sessions to `data/recordings/`.
- Run: `npm install`, copy `.env.example` to `.env`, `npm start`. Probe: `npm run probe` (`PROBE_SECONDS` to change length). Self-check: `npm test`.

## SmartSpectra SDK facts (`@smartspectra/node-sdk` 3.5.0, checked 2026-11-16)

### Packaging and platform

- Pure FFI via koffi, no native build step, no install scripts. Native runtime in per-platform packages (`@smartspectra/node-sdk-win32-x64`, `-darwin-arm64`, `-linux-x64`, `-linux-arm64`); npm installs all four (a few hundred MB), only the matching one loads.
- Requirements: Node >= 20 (24 LTS recommended), Electron >= 28. Linux needs glibc >= 2.35. Windows x64 bundles `opencv_world4100.dll`, `vulkan-1.dll`, `smartspectra.dll`, `smartspectra_capi.dll`, plus tflite face/pose models.
- Packaging: ship `node_modules/@smartspectra/node-sdk-<plat>-<arch>/` as an extra resource (see SDK README).
- If launched from a shell that has `ELECTRON_RUN_AS_NODE` set (VS Code, some Electron-hosted terminals), Electron exits immediately. Unset it.

### Entry points

- `@smartspectra/node-sdk`: `SmartSpectraSDK` (main process), enums, metric bundles, `decodeMetrics`.
- `@smartspectra/node-sdk/main` + `/preload` + `/renderer`: Presage's own Electron bridge where the renderer captures via `getUserMedia` and ships RGBA frames over a MessagePort. Not used here, because its renderer constructor takes the API key in the renderer.
- `@smartspectra/node-sdk/messages`: protobufjs `Metrics` class, `decodeMetrics`.

### Initialisation

```js
new SmartSpectraSDK({
  apiKey,                       // server-validated
  requestedMetrics: [...],      // MetricType ints; default = breathingMetrics
  enableAccumulatedOutput,      // extra 'accumulatedMetrics' packet at session end
  logLevel,                     // SmartSpectraLogLevel.kDebug..kNone, default kWarning
  enableTelemetry: false,       // DEFAULT IS TRUE
});
sdk.useCamera(CameraSelection.default /* | .byId(id) */, { width, height, fps, frameTransform });
sdk.start();                    // throws Error with numeric .code, .message, .retryable
await sdk.stopAsync(); await sdk.destroy();
```

Other inputs: `useCustomInput()` + `sendFrame(buf, w, h, stride, PixelFormat, tsUs)` (monotonic µs timestamps), `useFile(path, opts)`. `SmartSpectraSDK.availableCameras()` lists cameras without a key. On Windows `CameraSelection.front/.back` fail (`kInputUnavailable`); use `default` or `byId`. Only one SDK session per process at a time; await `destroy()` before creating another. `checkDeviceReadiness()` returns `{ verdict: 'ready'|'limited'|'blocked'|'inconclusive', reason }`.

### MetricType codes

- Breathing: `CHEST_BREATHING` 0, `ABDOMEN_BREATHING` 1, `BREATHING_RATE` 2, `BREATHING_RATE_STRICT` 19.
- Cardio: `PULSE_RATE` 15, `ARTERIAL_PRESSURE_TRACE` 16, `HRV` 17, `PULSE_RATE_STRICT` 18.
- Face: `FACE_LANDMARKS` 11, `BLINKING` 12, `TALKING` 13, `EXPRESSIONS` 14.
- Other: `GLUTES_MICROMOTION` 8, `KNEES_MICROMOTION` 9, `EDA_TRACE` 10.
- Unavailable (requesting makes `start()` throw `kConfigurationFailed`): `BREATHING_AMPLITUDE` 3, `APNEA` 4, `RESPIRATORY_LINE_LENGTH` 5, `BASELINE` 6, `INHALE_EXHALE_RATIO` 7.
- Bundles: `breathingMetrics` [0,1,2], `cardioMetrics` [15,16,17], `faceMetrics` [11,12,13,14], `micromotionMetrics` [8,9], `edaMetrics` [10]. A key may not be authorized for every metric (`kMetricNotAuthorized` 13).

### Events (`sdk.on(name, cb)`, one callback per event, later calls replace)

- `processingStatus(status)`: 0 Uninitialized, 1 Idle, 2 Starting, 3 Running, 4 Stopping, 5 Error.
- `validationStatus(code, timestampUs, hint)`: 0 Ok, 1 NoFaceFound, 2 MultipleFacesFound, 3 FaceNotCentered, 4 FaceSizeOutOfRange (deprecated), 5 TooDark, 6 TooBright, 7 ChestNotVisible, 10 CameraTuning, 11 FrameRateTooLow, 12 ExcessiveMotion, 13 FaceTooClose, 14 FaceTooFar, 15 FaceTooHigh, 16 FaceTooLow, 17 FaceNotForward. `hint` is SDK-provided text.
- `metrics(buf, timestampUs)`: protobuf; decode with `decodeMetrics(buf)`. `accumulatedMetrics` same shape.
- `error(code, message, retryable)`: 1 InvalidState, 2 AuthenticationFailed, 3 ConfigurationFailed, 4 CreditExhausted, 5 NetworkError, 6 ServerError, 7 InputUnavailable, 8 ProcessingFailed, 9 FrameConversionFailed, 10 NonMonotonicTimestamp, 11 TimestampGap, 13 MetricNotAuthorized, 14 SustainedLowFrameRate (do not auto-restart).
- Also `frameSentThrough(sent, ts)`, `videoOutput(buf, w, h, stride, fmt, ts)`, `insight(buf, requestId)` (for `requestInsight(text)`, an LLM feature; would send text to Presage; not used).

### Decoded `Metrics` shape (camelCase, protobufjs)

- Sample types: `Measurement { value, stable, timestamp }`, `MeasurementWithConfidence { value, stable, confidence, timestamp }`, `DetectionStatus { detected, stable, timestamp }`, `Strict { value, timestamp, stable }`. Timestamps may be `Long`; `Metrics.toObject(m, { longs: Number })` flattens them.
- `breathing.rate[]` (WithConfidence; `stable` means confidence >= 45, about +/-1 br/min), `breathing.upperTrace[]` (chest waveform), `breathing.lowerTrace[]` (abdomen waveform), `breathing.breathingRateStrict`.
- `cardio.pulseRate[]` (WithConfidence; `stable` means confidence >= 40, about +/-3 bpm), `cardio.arterialPressureTrace[]` (uncalibrated, unitless), `cardio.hrv[] { rmssd, meanNn, sdnn, baevsky, confidence, stable, timestamp }` (`stable` at confidence >= 50), `cardio.pulseRateStrict`.
- `face.blinking[]`, `face.talking[]` (DetectionStatus), `face.landmarks[] { value: [{x,y}], stable, reset, timestamp }`, `face.expression[] { scores: [{ type, confidence 0..100 }] }`; ExpressionType: ANGRY, CONTEMPT, DISGUST, FEAR, HAPPY, NEUTRAL, SAD, SURPRISE. Expression labels carry emotional connotations; do not present them as feelings or states of mind.
- `eda.trace[]`, `micromotion.glutes[]`, `micromotion.knees[]`.
- Also a deprecated-looking `pulse { rate, trace, pulseRespirationQuotient }` message exists in the proto; the docs use `cardio.*`.
- Latest value idiom: `m.cardio?.pulseRate?.at(-1)?.value`.

### Confirmed by live probe (`npm run probe`, Windows 11, Integrated Camera, 2026-11-16)

- **Pulse needs `ARTERIAL_PRESSURE_TRACE` (16).** With [0,2,15,17] no `cardio` data arrived at all in 45 s and no error was raised. With [0,2,15,16,17] pulse appeared. The app requests [0,2,15,16,17] (`lib/vitals.js`).
- **Timestamps are microseconds since the Unix epoch** (event `timestampUs` and every sample `timestamp`, same clock; matches `Date.now() * 1000` within ~30 ms).
- **Arrays are incremental.** Each packet carries only new samples (0% repeated timestamps across 1000+ packets). A packet only contains the groups with new data (often just `breathing` or just `cardio`).
- Packet cadence follows frames: median gap 33 ms, about 15 to 26 packets/s, irregular (p95 60 to 110 ms; one 6 s stall with the arterial pressure model on). The breathing trace (`upperTrace`) has about one sample per frame (~32 ms spacing).
- Start to `kRunning` takes ~5 s (includes the key check). First packet ~0.1 s after `kRunning`.
- **Warm-up is long.** Pulse: first sample 45 s after `start()`, about 27 s after the face became continuously OK, and samples arrive ~8 s after their own timestamp. Confidence 0.5 to 26, never `stable` within 45 s. Breathing rate: sparse (1 to 9 samples per 45 s), first `stable` at 46 s (value 3.5, confidence 79, which looks implausibly low). HRV: never appeared in 45 s. Plan calibration UX for several minutes, not seconds.
- Validation fires once per frame (~30/s). Hints seen: kOk "Hold still and record.", kNoFaceFound "No face found.", kTooDark "Increase light on face.", kChestNotVisible "Place more of the chest in view.", kFaceNotForward "Face the camera.", kMultipleFacesFound "Only one face is allowed."
- **The SDK will not start measuring until the face and upper chest are in view.** A 180 s probe with the student too close (5296 of ~5350 frames `kChestNotVisible`) stayed in `kStarting` the whole time and produced zero metrics packets, with no error. Show the validation hint before any "starting" message, and tell students to sit back so the upper chest is visible.
- Status names arrive as `kIdle`, `kStarting`, `kRunning`, `kStopping` (the enum key names).
- `videoOutput` IS delivered with `useCamera`: 1280x720, `PixelFormat.kRGB` (0), stride 3840, ~29.5 fps.
- Still unknown: how long pulse and HRV take to reach `stable`, and whether a bad-face period resets the warm-up.

### Decision: no facial expression metrics

Never request `EXPRESSIONS` (14) anywhere in the app, nor `FACE_LANDMARKS` (11). Emotion labels such as FEAR or ANGRY are judgements about the student, which conflicts with the no-diagnosis rule. Landmarks are face geometry we have no use for.

### Network and telemetry

- `apiKey` is validated against Presage's server, so a network connection is needed to start a session (errors `kNetworkError`, `kServerError`, `kCreditExhausted` exist). Per-use credits appear to be metered server-side.
- Telemetry defaults ON. When on, Presage receives: session summaries (SDK build, platform/OS/device model/CPU arch, input source kind and outcome, count of requested metrics, throughput/timing stats, validation-state counts, coarse error code, timestamp) and full device-readiness reports (device/OS, requested metrics, camera settings, performance checks, free-text diagnostics). Sent over the SDK's authenticated, TLS-pinned channel and linkable to the account/device. Presage says it never includes video frames or measured vitals.
- `enableTelemetry: false`: per Presage docs "the SDK starts no telemetry session and transmits nothing" for telemetry. Auth traffic still happens. No retention limit is configured for reports on Presage's side.
- Not yet verified with a network capture. Verify before writing the privacy section of the submission.
- Source: SDK README, `js/index.d.ts`, `js/messages/generated.d.ts`, `docs/device-readiness.md`, and GitHub `Presage-Security/SmartSpectra` `docs/telemetry-and-privacy.md`, `nodejs/docs/metrics.md`.
