'use strict';

// Dev/testing only: decode a video file with ffmpeg and push raw RGB frames into
// the SDK's custom-input path (useCustomInput + sendFrame). Needed because the
// SDK's own useFile() cannot open video files on Windows (see CLAUDE.md).
// Frames live only in memory: ffmpeg writes them to a pipe, each one is handed
// to sendFrame and then dropped. Nothing is written to disk.
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const CONFIG = require('./config');

const FFMPEG = process.env.PREPPULSE_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.PREPPULSE_FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe') : 'ffprobe';
const PIXEL_FORMAT_RGB = 0; // PixelFormat.kRGB

function probeVideo(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffprobe not found (${r.error.code}). Install ffmpeg or set PREPPULSE_FFMPEG.`);
  const s = JSON.parse(r.stdout || '{}').streams?.[0];
  const [num, den] = String(s?.r_frame_rate || '').split('/').map(Number);
  const fps = num / (den || 1);
  if (!(s?.width > 0 && s?.height > 0 && fps > 0)) throw new Error(`ffprobe could not read video stream: ${r.stderr.trim()}`);
  return { width: s.width, height: s.height, fps };
}

// Reassemble a byte stream into fixed-size frames.
function frameSplitter(frameSize, onFrame) {
  let frame = Buffer.allocUnsafe(frameSize);
  let filled = 0;
  return (chunk) => {
    let off = 0;
    while (off < chunk.length) {
      const n = Math.min(frameSize - filled, chunk.length - off);
      chunk.copy(frame, filled, off, off + n);
      filled += n;
      off += n;
      if (filled === frameSize) {
        onFrame(frame);
        frame = Buffer.allocUnsafe(frameSize);
        filled = 0;
      }
    }
  };
}

// Plays the file at its native frame rate (ffmpeg -re). Timestamps are epoch µs,
// spaced exactly by the file's frame rate, so they match the live camera's clock.
// With loop, the file starts again when it ends: timestamps keep counting up
// (the SDK needs them monotonic) and onRestart(frameTimeUs) runs at each restart.
// Returns stop(). onEnd(framesSent) runs once when the file ends or stop() is called.
// ponytail: frame time falls behind the wall clock by ffmpeg's restart delay (well
// under a second per restart); pace by Date.now() if long loops ever need it.
function feedVideo(sdk, file, { onEnd, onError, loop = false, onRestart = () => {} }) {
  const { width, height, fps } = probeVideo(file);
  const base = Date.now() * 1000;
  const frameTime = (n) => base + Math.round((n * 1e6) / fps);
  let i = 0;
  let done = false;
  let child = null;
  const finish = () => { if (!done) { done = true; onEnd(i); } };

  const play = () => {
    const startFrames = i;
    child = spawn(FFMPEG, ['-v', 'error', '-re', '-i', file, '-an',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.on('error', (e) => { onError(new Error(`ffmpeg failed to start (${e.code})`)); finish(); });
    child.on('close', (code) => {
      if (done) return;
      if (code) { onError(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop()}`)); finish(); return; }
      if (loop && i > startFrames) { onRestart(frameTime(i)); play(); return; }
      finish();
    });
    child.stdout.on('data', frameSplitter(width * height * 3, (frame) => {
      if (done) return;
      try {
        sdk.sendFrame(frame, width, height, width * 3, PIXEL_FORMAT_RGB, frameTime(i));
        i++;
      } catch (e) {
        onError(e);
        child.kill();
        finish();
      }
    }));
  };
  play();
  return () => { done || child.kill(); finish(); };
}

// After a loop restart the SDK's analysis windows mix the end and the start of
// the video, so the readings right after it are not a measurement of anything.
// From each restart: validation reads as a "video restarted" pause for
// restartGapSeconds, and every sample whose own timestamp falls within its
// signal's window after the restart is dropped (never carried across). Pure.
const RESTARTED = Object.freeze({ ok: false, code: 'kVideoRestarted', hint: 'video restarted' });

function createRestartGate(cfg = CONFIG.video) {
  const restarts = []; // { wallMs, frameMs }
  const near = (tMs, key, secs) => restarts.some((r) => tMs >= r[key] && tMs < r[key] + secs * 1000);
  const drop = cfg.restartDropSeconds;
  return {
    restart(wallMs, frameMs = wallMs) { restarts.push({ wallMs, frameMs }); return RESTARTED; },
    get count() { return restarts.length; },
    validation(tMs, v) { return near(tMs, 'wallMs', cfg.restartGapSeconds) ? RESTARTED : v; },
    metrics(d) {
      if (!restarts.length || !d) return d;
      const keep = (s, k) => (s && Number.isFinite(s.timestamp) && near(s.timestamp / 1000, 'frameMs', drop[k]) ? null : s);
      return {
        ...d,
        pulse: keep(d.pulse, 'pulse'),
        breathing: keep(d.breathing, 'breathing'),
        hrv: keep(d.hrv, 'hrv'),
        trace: (d.trace || []).filter(([ts]) => !near(ts / 1000, 'frameMs', cfg.restartGapSeconds)),
      };
    },
  };
}

module.exports = { probeVideo, frameSplitter, feedVideo, createRestartGate, RESTARTED };
