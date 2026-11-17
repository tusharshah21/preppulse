'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { needsSupportScreen, selfReport, saidText, isFeeling } = require('../lib/checkin');
const { resetPulseLine } = require('../lib/reset');
const { createTestSession } = require('../lib/session');
const { questionWindows } = require('../lib/align');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('check-in answers: stored locally, shown as "You said"', () => {
  assert.deepStrictEqual(selfReport('a_bit_tough', new Date('2026-11-17T10:00:00Z')), { feeling: 'a_bit_tough', answeredAt: '2026-11-17T10:00:00.000Z' });
  assert.strictEqual(selfReport('stressed'), null);
  assert.strictEqual(saidText('a_bit_tough'), 'a bit tough');
  assert.strictEqual(saidText('really_overwhelming'), 'really overwhelming');
  assert.strictEqual(saidText('skipped'), null);
  assert.ok(!isFeeling('__proto__') && !isFeeling('toString'));
});

test('support screen: only the student answer "Really overwhelming" opens it', () => {
  assert.strictEqual(needsSupportScreen('really_overwhelming'), true);
  for (const f of ['fine', 'a_bit_tough', 'skipped', undefined, null, '']) assert.strictEqual(needsSupportScreen(f), false);
});

test('signals never trigger support', () => {
  // Anything measured, however extreme, is not an answer and returns false.
  const signals = [140, -30, { pulse: { value: 160, stable: true } }, { breathing: { value: 40 } }, { hrv: { rmssd: 5 } },
    [[0, 180]], { feeling: 'really_overwhelming', pulse: 150 }, ['really_overwhelming'], { toString: () => 'really_overwhelming' }];
  for (const s of signals) assert.strictEqual(needsSupportScreen(s), false, JSON.stringify(s));

  // In code: needsSupportScreen is only ever called with the student's answer, in main's check-in handler.
  const main = read('main.js');
  const calls = main.match(/needsSupportScreen\([^)]*\)/g) || [];
  assert.deepStrictEqual(calls, ['needsSupportScreen(feeling)']);
  const handler = main.slice(main.indexOf('function checkin(feeling)'), main.indexOf('function discardTest'));
  assert.ok(handler.includes('needsSupportScreen(feeling)'));
  assert.ok(!/pulse|breath|hrv|samples|recentPulse|baseline/i.test(handler.replace(/buildReport\(s\)/, '')), 'check-in handler must not read signals');

  // In the window: the support screen opens only from the check-in answer or the "Need to talk to someone?" links.
  const r = read('renderer.js');
  const opens = [...r.matchAll(/openSupport\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(opens.sort(), ["'postTest'", "current === 'settings' ? 'settings' : 'home'", 'from'].sort());
  assert.ok(/if \(res\?\.showSupport\) return openSupport\('postTest'\)/.test(r));
  assert.strictEqual((r.match(/show\('support'\)/g) || []).length, 1, 'only openSupport shows the screen');
  const metricsHandler = r.slice(r.indexOf("window.vitals.on('vitals:metrics'"), r.indexOf('function drawWave'));
  assert.ok(!/support/i.test(metricsHandler));
  // Nothing in the report links to support.
  assert.ok(!/support/i.test(read('lib/report.js')));
  assert.ok(!/support/i.test(read('report-view.js')));
});

test('support screen text: numbers as tel: links, no web links', () => {
  const html = read('index.html');
  assert.ok(html.includes('<a class="tel" href="tel:14416">14416</a>'));
  assert.ok(html.includes('<a class="tel" href="tel:1-800-891-4416">1-800-891-4416</a>'));
  assert.ok(html.includes('findahelpline.com lists free helplines by country'));
  assert.ok(html.includes('If you feel unsafe right now, contact local emergency services.'));
  assert.ok(!/href="https?:/i.test(html), 'no website links');
});

test('reset pulse line: neutral, only with enough data', () => {
  const base = 70;
  const samples = [];
  for (let t = 0; t <= 60000; t += 1000) samples.push([t, t <= 20000 ? 84 : 77]);
  assert.strictEqual(resetPulseLine(samples, base, 20000, 50000), 'Pulse at the start: +14 above your baseline. At the end: +7.');
  assert.strictEqual(resetPulseLine(samples.map(([t]) => [t, 66]), base, 20000, 50000), 'Pulse at the start: 4 below your baseline. At the end: -4.');
  assert.strictEqual(resetPulseLine(samples.filter(([t]) => t < 38500), base, 20000, 50000), null, 'no recent readings at the end');
  assert.strictEqual(resetPulseLine(samples, null, 20000, 50000), null);
  assert.ok(!/lower|calm(er)?|worked|better|relax/i.test(resetPulseLine(samples, base, 20000, 50000)));
});

test('session: reset events are recorded once each and pause question time', () => {
  const qs = { title: 't', questions: [0, 1].map((i) => ({ id: `q${i}`, subject: 's', difficulty: 'easy', answer: 0 })) };
  const s = createTestSession({ startedAt: 0, durationMs: 120000, settings: {}, baseline: {}, questions: qs, source: {} });
  s.event(0, { type: 'question_shown', q: 0 });
  assert.strictEqual(s.event(10000, { type: 'reset_end' }), false);
  assert.strictEqual(s.event(20000, { type: 'reset_start' }), true);
  assert.strictEqual(s.event(21000, { type: 'reset_start' }), false);
  assert.strictEqual(s.event(50000, { type: 'reset_end' }), true);
  s.event(60000, { type: 'question_shown', q: 1 });
  s.end(90000, 'submitted');
  const full = s.finish();
  assert.deepStrictEqual(full.events.filter((e) => e.type.startsWith('reset')).map((e) => [e.type, e.t]), [['reset_start', 20000], ['reset_end', 50000]]);
  assert.strictEqual(full.questions[0].timeMs, 30000, '20 s before the reset and 10 s after');
  assert.strictEqual(full.events.find((e) => e.type === 'question_shown').onScreenMs, 20000);
  // A question shown during a reset is not resumed afterwards by mistake.
  assert.deepStrictEqual(questionWindows([{ t: 0, type: 'question_shown', q: 0 }, { t: 5, type: 'reset_start' }, { t: 7, type: 'question_shown', q: 1 }, { t: 9, type: 'reset_end' }], 12),
    [{ q: 0, start: 0, end: 5 }, { q: 1, start: 7, end: 12 }]);
});

test('new UI text avoids the banned words', () => {
  const BANNED = /\b(stress\w*|anxi\w*|panic\w*|nervous\w*|diagnos\w*|at-risk|disorder\w*|healthy|unhealthy|good|bad|better|worse|normal|abnormal|well done|improv\w*)\b/i;
  const html = read('index.html');
  const pick = (id) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));
  const text = [pick('checkin'), pick('reset'), pick('support'), read('lib/checkin.js').replace(/\/\/.*$/gm, ''), read('lib/reset.js').replace(/\/\/.*$/gm, '')].join('\n');
  assert.ok(!BANNED.test(text), text.match(BANNED)?.[0]);
  const rv = read('report-view.js');
  const prog = rv.slice(rv.indexOf('function progress'));
  assert.ok(!BANNED.test(prog.replace(/\/\/.*$/gm, '')), prog.match(BANNED)?.[0]);
});
