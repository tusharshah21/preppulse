'use strict';

// Which input the app is running on, and how it is labelled. Pure, so the
// labels are testable. dataKind keeps data apart: 'real' (live camera, or a
// replay of a real recording), 'simulated' (made-up recording), 'dataset' (a
// video file, never the user's own measurement). Baselines and sessions of one
// kind are never mixed with another, and only 'real' counts for progress.
const path = require('path');

const SIM_BANNER = 'SIMULATED DATA: replaying a made-up recording, not a measurement of anyone';

// "data/videos/ubfc-rppg/subject3/vid.avi" -> "UBFC-rPPG, subject 3"
function datasetName(videoPath, root) {
  const rel = path.relative(path.join(root, 'data', 'videos'), videoPath).split(path.sep).join('/');
  const m = /^ubfc-rppg\/subject(\d+)\//i.exec(rel);
  return m ? `UBFC-rPPG, subject ${Number(m[1])}` : null;
}

const demoBanner = (name) => (name
  ? `Demo input: public research video (${name}), not a live webcam`
  : 'Demo input: test video file, not a live webcam');

function describeSource({ root, replay = false, replayMeta = null, videoPath = null }) {
  if (replay) {
    if (replayMeta?.dataset) return { kind: 'replay', dataKind: 'dataset', dataset: replayMeta.dataset, banner: demoBanner(replayMeta.dataset), preview: false };
    if (replayMeta?.simulated === true) return { kind: 'replay', dataKind: 'simulated', dataset: null, banner: SIM_BANNER, preview: false };
    return { kind: 'replay', dataKind: 'real', dataset: null, banner: null, preview: false };
  }
  if (videoPath) {
    const name = datasetName(videoPath, root);
    // No frames of the person in the video are ever shown.
    return { kind: 'video', dataKind: 'dataset', dataset: name || 'test video file', banner: demoBanner(name), preview: false };
  }
  return { kind: 'camera', dataKind: 'real', dataset: null, banner: null, preview: true };
}

// Which kind a saved baseline or session belongs to.
const kindOf = (x) => (x?.simulated ? 'simulated' : x?.dataset ? 'dataset' : 'real');

module.exports = { describeSource, datasetName, kindOf, SIM_BANNER };
