'use strict';

// Dev/testing only: decode a video file with ffmpeg and push raw RGB frames into
// the SDK's custom-input path (useCustomInput + sendFrame). Needed because the
// SDK's own useFile() cannot open video files on Windows (see CLAUDE.md).
// Frames live only in memory: ffmpeg writes them to a pipe, each one is handed
// to sendFrame and then dropped. Nothing is written to disk.
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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
// Returns stop(). onEnd(framesSent) runs once when the file ends or stop() is called.
function feedVideo(sdk, file, { onEnd, onError }) {
  const { width, height, fps } = probeVideo(file);
  const base = Date.now() * 1000;
  let i = 0;
  let done = false;
  const finish = () => { if (!done) { done = true; onEnd(i); } };

  const child = spawn(FFMPEG, ['-v', 'error', '-re', '-i', file, '-an',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.on('error', (e) => { onError(new Error(`ffmpeg failed to start (${e.code})`)); finish(); });
  child.on('close', (code) => {
    if (code && !done) onError(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop()}`));
    finish();
  });
  child.stdout.on('data', frameSplitter(width * height * 3, (frame) => {
    if (done) return;
    try {
      sdk.sendFrame(frame, width, height, width * 3, PIXEL_FORMAT_RGB, base + Math.round((i * 1e6) / fps));
      i++;
    } catch (e) {
      onError(e);
      child.kill();
      finish();
    }
  }));
  return () => { child.kill(); finish(); };
}

module.exports = { probeVideo, frameSplitter, feedVideo };
