'use strict';

// Shared SDK session code for the Electron main process and scripts/probe.js.
const fs = require('fs');
const {
  SmartSpectraSDK, CameraSelection, ProcessingStatus, ValidationCode,
  SmartSpectraErrorCode, SmartSpectraLogLevel, decodeMetrics,
} = require('@smartspectra/node-sdk');
const { Metrics } = require('@smartspectra/node-sdk/messages');
const { feedVideo } = require('./videofeed');

// CHEST_BREATHING, BREATHING_RATE, PULSE_RATE, ARTERIAL_PRESSURE_TRACE, HRV.
// Never add EXPRESSIONS (14) or FACE_LANDMARKS (11): see CLAUDE.md.
const REQUESTED_METRICS = [0, 2, 15, 16, 17];
const feeders = new WeakMap(); // sdk -> stop() for an ffmpeg video feed

const nameOf = (enumObj, v) => Object.keys(enumObj).find((k) => enumObj[k] === v) ?? String(v);
const last = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
const sample = (s) => s && {
  value: s.value ?? null, stable: !!s.stable, confidence: s.confidence ?? null, timestamp: s.timestamp ?? null,
};

const decode = (buf) => Metrics.toObject(decodeMetrics(buf), { longs: Number });

// The only metrics shape that leaves this module: plain numbers, no face data.
function toPayload(m) {
  const h = last(m.cardio?.hrv);
  return {
    pulse: sample(last(m.cardio?.pulseRate)),
    breathing: sample(last(m.breathing?.rate)),
    hrv: h && { rmssd: h.rmssd ?? null, stable: !!h.stable, confidence: h.confidence ?? null, timestamp: h.timestamp ?? null },
    trace: (m.breathing?.upperTrace ?? []).map((p) => [p.timestamp ?? 0, p.value ?? 0]),
  };
}

// emit(channel, data) receives the same events the renderer gets over IPC.
// onFrame(buf, w, h, stride, fmt, ts) gets preview frames (memory only, never stored).
// onRaw(decodedMetrics, timestampUs) is for the probe's analysis.
// videoPath (dev/testing only) plays a file through the same pipeline instead of the camera.
// loop restarts the file at its end; onRestart(frameTimeUs) runs at each restart.
async function startSession({ apiKey, emit, onFrame, onRaw, videoPath, loop = false, onRestart, requestedMetrics = REQUESTED_METRICS }) {
  if (videoPath && !fs.statSync(videoPath, { throwIfNoEntry: false })?.isFile()) {
    throw Object.assign(new Error(`video file not found: ${videoPath}`), { codeName: 'kInputUnavailable' });
  }
  const sdk = new SmartSpectraSDK({
    apiKey,
    enableTelemetry: false,
    logLevel: SmartSpectraLogLevel.kError,
    requestedMetrics,
  });
  sdk.on('processingStatus', (s) => emit('vitals:status', nameOf(ProcessingStatus, s)));
  sdk.on('validationStatus', (code, _ts, hint) =>
    emit('vitals:validation', { ok: code === ValidationCode.kOk, code: nameOf(ValidationCode, code), hint }));
  sdk.on('error', (code, message, retryable) =>
    emit('vitals:error', { code: nameOf(SmartSpectraErrorCode, code), message, retryable }));
  sdk.on('metrics', (buf, ts) => {
    const m = decode(buf);
    if (onRaw) onRaw(m, ts);
    emit('vitals:metrics', toPayload(m));
  });
  if (onFrame) sdk.on('videoOutput', onFrame);

  try {
    if (!videoPath) {
      sdk.useCamera(CameraSelection.default).start();
      return sdk;
    }
    // Video file: ffmpeg decodes, we push frames (useFile can't open files on Windows).
    sdk.useCustomInput().start();
    feeders.set(sdk, feedVideo(sdk, videoPath, {
      loop,
      onRestart,
      onError: (e) => emit('vitals:error', { code: 'kInputUnavailable', message: `video feed: ${e.message}`, retryable: false }),
      onEnd: () => { sdk.stopAsync().catch(() => {}); }, // end of file -> kStopping -> kIdle, like useFile
    }));
    return sdk;
  } catch (e) {
    await sdk.destroy().catch(() => {});
    e.codeName = e.code == null ? 'kInputUnavailable' : nameOf(SmartSpectraErrorCode, e.code);
    throw e;
  }
}

async function stopSession(sdk) {
  if (!sdk) return;
  feeders.get(sdk)?.();
  try { await sdk.stopAsync(); } catch { /* already stopped */ }
  await sdk.destroy();
}

// [rOffset, gOffset, bOffset, bytesPerPixel] per PixelFormat (kRGB 0, kBGR 1, kRGBA 2, kBGRA 3).
const LAYOUT = { 0: [0, 1, 2, 3], 1: [2, 1, 0, 3], 2: [0, 1, 2, 4], 3: [2, 1, 0, 4] };

// Nearest-neighbour downscale to a small RGBA image for the positioning preview.
// Returns null for pixel formats we don't handle (YUV).
function downscaleToRGBA(buf, w, h, stride, fmt, targetW = 320) {
  const layout = LAYOUT[fmt];
  if (!layout) return null;
  const [r, g, b, bpp] = layout;
  const step = Math.max(1, Math.floor(w / targetW));
  const ow = Math.floor(w / step);
  const oh = Math.floor(h / step);
  const out = Buffer.alloc(ow * oh * 4);
  let o = 0;
  for (let y = 0; y < oh; y++) {
    const row = y * step * stride;
    for (let x = 0; x < ow; x++) {
      const s = row + x * step * bpp;
      out[o++] = buf[s + r];
      out[o++] = buf[s + g];
      out[o++] = buf[s + b];
      out[o++] = 255;
    }
  }
  return { width: ow, height: oh, data: out };
}

module.exports = { REQUESTED_METRICS, startSession, stopSession, toPayload, downscaleToRGBA };
