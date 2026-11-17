'use strict';

// Draws "Your pressure map" from a report object (lib/report.js) with plain SVG.
// No chart library, no network. Colours: Okabe-Ito (colourblind-safe); no
// red/green good/bad colouring anywhere.
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const C = { pulse: '#0072B2', tint: 'rgba(0,114,178,0.16)', breath: '#009E73', base: '#33405a', grid: '#dfe3ea',
    bandA: '#f4f6fa', bandB: '#ffffff', sel: '#0072B2', changed: '#E69F00', marked: '#CC79A7', skipped: '#5b6475', hatch: '#8a94a6', reset: 'rgba(86,180,233,0.28)', resetLine: '#56B4E9' };
  const W = 1000;
  const L = 64;
  const R = 16;

  const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  };
  const title = (e, text) => { svgEl('title', {}, e).textContent = text; return e; };
  const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const signed = (x) => (x > 0 ? `+${x}` : String(x));
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const secs = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };
  const STATUS = { too_brief: 'too brief to read', not_measured: 'not measured', not_shown: 'not shown' };

  function answerText(q) {
    if (q.answer == null) return 'not answered';
    return `${'ABCD'[q.answer]}, ${q.correct ? 'correct' : 'not correct'}`;
  }

  function pulseText(q) {
    if (q.status === 'ok') return `median ${signed(q.medianChange)}, peak ${signed(q.peakChange)} compared with your calm baseline`;
    if (q.status === 'not_measured') return q.notMeasuredBecause.length ? `not measured: ${q.notMeasuredBecause.join(', ')}` : 'not measured';
    return STATUS[q.status];
  }

  const COVERAGE = { full: 'measured fully', partial: 'measured partly', none: 'not measured', not_shown: 'not shown' };

  function tipLines(q) {
    const why = q.coverage === 'partial' && q.notMeasuredBecause.length ? ` (not measured: ${q.notMeasuredBecause.join(', ')})` : '';
    return [
      `Q${q.q + 1} · ${q.subject} · ${q.difficulty}`,
      `On screen: ${secs(q.timeMs)}`,
      `Your answer: ${answerText(q)}`,
      `Pulse: ${pulseText(q)}`,
      `Measurement: ${COVERAGE[q.coverage]}${why}`,
    ];
  }

  function defs(svg, id) {
    const d = svgEl('defs', {}, svg);
    const p = svgEl('pattern', { id: `hatch-${id}`, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, d);
    svgEl('rect', { width: 8, height: 8, fill: '#eef0f4' }, p);
    svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: C.hatch, 'stroke-width': 3 }, p);
    return d;
  }

  // One chart: shared bands, gaps and x axis; draw() adds the series.
  function chart(container, { id, height, top, bottom, report, yLo, yHi, xAxis, labels, onBand, draw }) {
    const tl = report.timeline;
    const x = (t) => L + (t / Math.max(1, tl.durationMs)) * (W - L - R);
    const y = (v) => top + ((yHi - v) / (yHi - yLo)) * (height - top - bottom);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${height}`, width: '100%', role: 'img', 'aria-labelledby': `${id}-sum`, class: 'chartSvg' });
    const d = defs(svg, id);
    const bands = svgEl('g', {}, svg);
    tl.windows.forEach((w, i) => {
      const r = svgEl('rect', { x: x(w.start), y: top, width: Math.max(1, x(w.end) - x(w.start)), height: height - top - bottom,
        fill: w.q % 2 ? C.bandA : C.bandB, class: 'band', 'data-q': w.q }, bands);
      r.addEventListener('mouseenter', (ev) => onBand(w.q, ev));
      r.addEventListener('click', (ev) => onBand(w.q, ev, true));
      if (labels && x(w.end) - x(w.start) >= 26) {
        svgEl('text', { x: (x(w.start) + x(w.end)) / 2, y: top - 8, 'text-anchor': 'middle', class: 'bandLabel' }, svg).textContent = `Q${w.q + 1}`;
      }
      if (i > 0) svgEl('line', { x1: x(w.start), x2: x(w.start), y1: top, y2: height - bottom, stroke: C.grid }, bands);
    });
    for (const g of tl.gaps) {
      const r = svgEl('rect', { x: x(g.start), y: top, width: Math.max(2, x(g.end) - x(g.start)), height: height - top - bottom,
        fill: g.kind === 'resettling' ? '#f3f4f7' : `url(#hatch-${id})`, opacity: g.kind === 'resettling' ? 0.9 : 0.85, class: 'gap' }, svg);
      if (g.kind === 'resettling') r.setAttribute('stroke', C.hatch), r.setAttribute('stroke-dasharray', '3 3');
      title(r, `${g.label} (${secs(g.end - g.start)})`);
    }
    for (const b of tl.resets || []) {
      const r = svgEl('rect', { x: x(b.start), y: top, width: Math.max(2, x(b.end) - x(b.start)), height: height - top - bottom, fill: C.reset, stroke: C.resetLine, class: 'resetBand' }, svg);
      title(r, `30-second reset at ${mmss(b.start)} (${secs(b.end - b.start)})`);
      if (labels) svgEl('text', { x: (x(b.start) + x(b.end)) / 2, y: top + 30, 'text-anchor': 'middle', class: 'bandLabel' }, svg).textContent = 'reset';
    }
    draw({ svg, x, y, defs: d });
    if (xAxis) {
      const step = tl.durationMs > 8 * 60000 ? 120000 : 60000;
      for (let t = 0; t <= tl.durationMs; t += step) {
        svgEl('text', { x: x(t), y: height - 6, 'text-anchor': 'middle', class: 'axis' }, svg).textContent = mmss(t);
      }
    }
    container.replaceChildren(svg);
    return { svg, x };
  }

  function render(report, els, { onReset }) {
    const qs = report.questions;
    const tl = report.timeline;
    let selected = null;

    const tip = els.tip;
    function showTip(q, ev, pin) {
      const row = qs[q];
      if (!row) return;
      tip.replaceChildren(...tipLines(row).map((t, i) => el(i ? 'div' : 'strong', t)));
      tip.hidden = false;
      const box = els.chartCard.getBoundingClientRect();
      const px = ev?.clientX != null ? ev.clientX - box.left : box.width / 2;
      tip.style.left = `${Math.min(Math.max(8, px + 12), box.width - 300)}px`;
      tip.style.top = `${ev?.clientY != null ? Math.max(40, ev.clientY - box.top + 12) : 60}px`;
      if (pin) select(q);
    }

    function select(q) {
      selected = q;
      for (const b of els.chartCard.querySelectorAll('.band')) b.classList.toggle('selected', Number(b.dataset.q) === q);
      for (const t of els.strip.querySelectorAll('.tile')) t.classList.toggle('selected', Number(t.dataset.q) === q);
    }

    // ---- Pulse chart ----
    const ds = tl.pulseRuns.flat().map((p) => p[1]);
    const yLo = Math.min(-8, Math.floor((Math.min(...ds, 0) - 2) / 4) * 4);
    const yHi = Math.max(16, Math.ceil((Math.max(...ds, 0) + 2) / 4) * 4);
    chart(els.pulseChart, {
      id: 'pulse', height: 300, top: 40, bottom: 12, report, yLo, yHi, labels: true, onBand: showTip,
      draw: ({ svg, x, y, defs: d }) => {
        for (let v = Math.ceil(yLo / 4) * 4; v <= yHi; v += 4) {
          if (v === 0) continue;
          svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: C.grid, 'stroke-dasharray': '2 4' }, svg);
          if (v % 8 === 0) svgEl('text', { x: L - 8, y: y(v) + 5, 'text-anchor': 'end', class: 'axis' }, svg).textContent = signed(v);
        }
        const clip = svgEl('clipPath', { id: 'aboveBase' }, d);
        svgEl('rect', { x: 0, y: 0, width: W, height: y(0) }, clip);
        for (const run of tl.pulseRuns) {
          if (run.length === 1) { svgEl('circle', { cx: x(run[0][0]), cy: y(run[0][1]), r: 3, fill: C.pulse }, svg); continue; }
          const line = run.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
          svgEl('path', { d: `${line}L${x(run.at(-1)[0]).toFixed(1)},${y(0)}L${x(run[0][0]).toFixed(1)},${y(0)}Z`, fill: C.tint, 'clip-path': 'url(#aboveBase)' }, svg);
          svgEl('path', { d: line, fill: 'none', stroke: C.pulse, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, svg);
        }
        svgEl('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), stroke: C.base, 'stroke-width': 1.5 }, svg);
        svgEl('text', { x: L - 8, y: y(0) + 5, 'text-anchor': 'end', class: 'axis strong' }, svg).textContent = '0';
        const mk = svgEl('g', {}, svg);
        for (const m of tl.markers) {
          const cx = x(m.t);
          const cy = 40 + 12;
          const name = { changed: 'answer changed', skipped: 'skipped', marked: 'marked for review' }[m.type];
          let s;
          if (m.type === 'changed') s = svgEl('rect', { x: cx - 5, y: cy - 5, width: 10, height: 10, fill: C.changed, transform: `rotate(45 ${cx} ${cy})` }, mk);
          else if (m.type === 'marked') s = svgEl('path', { d: `M${cx},${cy - 6}L${cx + 6},${cy + 5}L${cx - 6},${cy + 5}Z`, fill: C.marked }, mk);
          else s = svgEl('circle', { cx, cy, r: 5, fill: '#fff', stroke: C.skipped, 'stroke-width': 2 }, mk);
          title(s, `Q${m.q + 1}: ${name} at ${mmss(m.t)}`);
        }
      },
    });

    // ---- Breathing chart ----
    const bv = tl.breathingRuns.flat().map((p) => p[1]);
    const base = report.baseline.breathingPerMin;
    const all = base == null ? bv : [...bv, base];
    const bLo = Math.floor(Math.min(...all, 10) - 2);
    const bHi = Math.ceil(Math.max(...all, 18) + 2);
    chart(els.breathChart, {
      id: 'breath', height: 170, top: 10, bottom: 30, report, yLo: bLo, yHi: bHi, xAxis: true, onBand: showTip,
      draw: ({ svg, x, y }) => {
        if (base != null) {
          svgEl('line', { x1: L, x2: W - R, y1: y(base), y2: y(base), stroke: C.base, 'stroke-dasharray': '6 4' }, svg);
          svgEl('text', { x: L - 8, y: y(base) + 5, 'text-anchor': 'end', class: 'axis strong' }, svg).textContent = String(Math.round(base));
        }
        for (const run of tl.breathingRuns) {
          if (run.length > 1) svgEl('path', { d: run.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(''), fill: 'none', stroke: C.breath, 'stroke-width': 2 }, svg);
          for (const [t, v] of run) title(svgEl('circle', { cx: x(t), cy: y(v), r: 4, fill: C.breath }, svg), `${Math.round(v)} breaths per minute at ${mmss(t)}`);
        }
      },
    });
    els.pulseSummary.textContent = report.summaries.pulse;
    els.breathSummary.textContent = report.summaries.breathing;
    els.chartCard.addEventListener('mouseleave', () => { if (selected == null) tip.hidden = true; });

    // ---- Question strip ----
    els.strip.replaceChildren(...qs.map((q) => {
      const b = el('button', null, `tile tile-${q.status}`);
      b.dataset.q = q.q;
      b.append(el('span', `Q${q.q + 1}`, 'tileNum'));
      b.append(el('span', q.status === 'ok' ? signed(q.medianChange) : STATUS[q.status], q.status === 'ok' ? 'tileVal' : 'tileNote'));
      if (q.correct === false) {
        const i = el('span', '×', 'tileWrong');
        i.title = 'answered incorrectly';
        b.append(i);
      }
      b.setAttribute('aria-label', tipLines(q).join('. '));
      b.addEventListener('click', () => {
        select(q.q);
        const band = els.chartCard.querySelector(`.band[data-q="${q.q}"]`);
        const r = band?.getBoundingClientRect();
        showTip(q.q, r ? { clientX: r.left + r.width / 2, clientY: r.top + 30 } : null);
      });
      return b;
    }));

    // ---- Observations ----
    els.obs.replaceChildren(...(report.observations.length ? report.observations : [report.notEnoughText]).map((o) => el('li', o)));
    els.closing.textContent = report.closing;

    // ---- Breathing by part, HRV by half: only what was measured ----
    const extras = [];
    if (report.breathingSections.length) {
      const names = ['first third', 'middle third', 'last third'];
      extras.push(el('h3', 'Breathing rate by part of the test'));
      const ul = el('ul');
      for (const s of report.breathingSections) ul.append(el('li', `${names[s.index]}: ${Math.round(s.median)} per minute (${signed(Math.round(s.change))} compared with your calm baseline, ${s.readings} readings)`));
      extras.push(ul);
    }
    if (report.hrvHalves.length) {
      const names = ['first half', 'second half'];
      extras.push(el('h3', 'Heart-rate variability (RMSSD) by half'));
      const ul = el('ul');
      for (const h of report.hrvHalves) ul.append(el('li', `${names[h.index]}: ${Math.round(h.median)} ms (${signed(Math.round(h.change))} ms compared with your calm baseline)`));
      extras.push(ul);
    }
    els.extras.replaceChildren(...extras);
    els.extras.hidden = !extras.length;
    els.resetBtn.onclick = onReset;
  }

  // "Your progress": one small chart and one plain line per measure, oldest first.
  // Values only, no trend labels, arrows, or colour for direction.
  function progress(container, sessions) {
    const rows = [
      { name: 'Score', get: (s) => s.score?.correct, text: (v, s) => `${v}/${s.score.total}` },
      { name: 'Median rise on hard questions', get: (s) => s.summary?.hardMedianChange, text: (v) => signed(v) },
      { name: 'Settle time after your biggest rise', get: (s) => (s.summary?.biggestRiseSettleMs == null ? null : s.summary.biggestRiseSettleMs), text: (v) => mmss(Math.round(v / 5000) * 5000) },
      { name: 'Share of questions measured', get: (s) => (s.summary?.measuredShare == null ? null : Math.round(s.summary.measuredShare * 100)), text: (v) => `${v}%` },
    ];
    for (const r of rows) {
      const vals = sessions.map((s) => { const v = r.get(s); return Number.isFinite(v) ? v : null; });
      const words = vals.map((v, i) => (v == null ? 'not enough data' : r.text(v, sessions[i]))).join(', ');
      const box = el('div', null, 'prog');
      box.append(el('p', `${r.name}: ${words}.`));
      const w = 220;
      const h = 56;
      const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' });
      const nums = vals.filter((v) => v != null);
      if (nums.length) {
        const lo = Math.min(...nums);
        const span = Math.max(...nums) - lo || 1;
        const px = (i) => 8 + (i / Math.max(1, vals.length - 1)) * (w - 16);
        const py = (v) => h - 8 - ((v - lo) / span) * (h - 16);
        let d = '';
        vals.forEach((v, i) => { if (v == null) { d += ' '; return; } d += `${/[\d.]$/.test(d) ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`; });
        svgEl('path', { d, fill: 'none', stroke: C.pulse, 'stroke-width': 2 }, svg);
        vals.forEach((v, i) => { if (v != null) svgEl('circle', { cx: px(i), cy: py(v), r: 3.5, fill: C.pulse }, svg); });
      }
      box.append(svg);
      container.append(box);
    }
    container.append(el('p', `Oldest first, ${sessions.length} practice tests. Each value is compared with your own calm baseline on that day.`, 'muted'));
  }

  window.ReportView = { render, progress };
})();
