'use strict';

// Smoke test: the window scripts run top to bottom against a stub DOM without
// throwing (a top-level error would silently leave later buttons dead).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function stub() {
  const f = function () {};
  return new Proxy(f, {
    get: (_t, k) => (k === Symbol.iterator || k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : stub()),
    set: () => true,
    apply: () => stub(),
  });
}

test('renderer.js and report-view.js load without errors', () => {
  const document = { getElementById: () => stub(), querySelectorAll: () => [], querySelector: () => stub(), createElement: () => stub(), createElementNS: () => stub(), body: stub(), documentElement: stub() };
  const vitals = new Proxy({}, { get: (_t, k) => (k === 'on' ? () => {} : () => Promise.resolve({ ok: true, simulated: false, test: {}, reset: {} })) });
  const window = { vitals };
  const ctx = vm.createContext({ window, document, console, setInterval, clearInterval, setTimeout, clearTimeout, requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }), confirm: () => false });
  window.ReportView = undefined;
  for (const f of ['report-view.js', 'renderer.js']) {
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }), f);
  }
});
