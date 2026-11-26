/* perf-probe.js — v13.8-light performance probe (NO app logic, measurement only).
 *
 * Loaded FIRST in <head> so it sees the whole load. Records, with zero
 * dependencies and no network:
 *   - navigation + paint timings (first-paint, first-contentful-paint, DOMContentLoaded)
 *   - main-thread long tasks (PerformanceObserver 'longtask', buffered)
 *   - frame times: a lightweight rAF sampler (ring buffer, last 1200 frames)
 *     with dropped-frame counts (>34ms, >50ms). Scoped windows via
 *     PSPerf.frames.start(label) / .stop() — e.g. around a take.
 *   - named marks: PSPerf.mark(name) / PSPerf.measure(name, from, to).
 *     The app marks: 'record-tap' (record button tap), 'record-first-block'
 *     (first mic block arrives), 'record-started' (take handle resolves),
 *     'worklet-warm-start/end', 'monitor-start/end', 'overdub-decode-start/end'.
 *   - worklet block cost: PSPerf.workletBlock(ms) — called by the app's
 *     recorder onBlock with the wall time between block arrivals? No:
 *     block ARRIVAL gaps are measured in the harness from the probe's
 *     own record of onBlock timestamps (PSPerf.noteBlock(audioTime)).
 *     A gap > ~120ms between 4096-frame batches (93ms of audio at 44.1k)
 *     means the main thread starved the audio path.
 * Readout: window.PSPerf.report() — plain JSON, read by the CDP harness
 * (test/cdp-v138.js) and by PS.perfReport() in the app. A small lab
 * readout lives in Setup (see app.js renderPerfReadout) — same numbers.
 * The sampler costs one rAF callback per frame and stores numbers only;
 * it never touches the DOM and never allocates per frame (fixed ring).
 */
(function (root) {
  'use strict';
  var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
  var marks = {};
  var measures = {};
  var longtasks = [];
  var blocks = []; // {at (wall ms), audioTime} — first-block + arrival gaps
  var frameRing = new Float32Array(1200);
  var frameCount = 0;
  var frameIdx = 0;
  var dropped34 = 0, dropped50 = 0;
  var lastFrameT = 0;
  var scope = null; // {label, startIdx, startCount, dropped34, dropped50, at}
  var scopeResults = [];

  function now() { return performance.now(); }

  function mark(name) { marks[name] = now(); return marks[name]; }
  function measure(name, from, to) {
    var a = marks[from], b = (to === undefined) ? now() : marks[to];
    if (a === undefined || b === undefined) return null;
    measures[name] = b - a;
    return measures[name];
  }

  try {
    if (typeof PerformanceObserver !== 'undefined') {
      var lo = new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          longtasks.push({ start: Math.round(entries[i].startTime * 10) / 10, duration: Math.round(entries[i].duration * 10) / 10 });
          if (longtasks.length > 200) longtasks.shift();
        }
      });
      lo.observe({ type: 'longtask', buffered: true });
    }
  } catch (e) { /* longtask unsupported — report() says so */ }

  function frameLoop(t) {
    if (lastFrameT) {
      var d = t - lastFrameT;
      frameRing[frameIdx] = d;
      frameIdx = (frameIdx + 1) % 1200;
      frameCount++;
      if (d > 34) dropped34++;
      if (d > 50) dropped50++;
    }
    lastFrameT = t;
    requestAnimationFrame(frameLoop);
  }
  try { requestAnimationFrame(frameLoop); } catch (e) { /* headless without rAF */ }

  function frameStats() {
    var n = Math.min(frameCount, 1200);
    if (!n) return { frames: 0 };
    var sorted = [];
    for (var i = 0; i < n; i++) sorted.push(frameRing[i]);
    sorted.sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var j = 0; j < n; j++) sum += sorted[j];
    return {
      frames: frameCount,
      meanMs: Math.round(sum / n * 100) / 100,
      p50Ms: Math.round(sorted[Math.floor(0.5 * n)] * 100) / 100,
      p95Ms: Math.round(sorted[Math.floor(0.95 * n)] * 100) / 100,
      maxMs: Math.round(sorted[n - 1] * 100) / 100,
      dropped34: dropped34, dropped50: dropped50
    };
  }

  function noteBlock(audioTime) {
    var at = now();
    blocks.push({ at: Math.round(at * 10) / 10, audioTime: audioTime });
    if (blocks.length > 600) blocks.shift();
    if (blocks.length === 1) mark('record-first-block');
    return at;
  }

  function blockStats() {
    if (blocks.length < 2) return { blocks: blocks.length, firstBlockAtMs: marks['record-first-block'] || null };
    var gaps = [];
    for (var i = 1; i < blocks.length; i++) gaps.push(blocks[i].at - blocks[i - 1].at);
    gaps.sort(function (a, b) { return a - b; });
    var late = 0;
    for (var j = 0; j < gaps.length; j++) if (gaps[j] > 120) late++;
    return {
      blocks: blocks.length,
      firstBlockAtMs: marks['record-first-block'],
      gapMeanMs: Math.round(gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length * 10) / 10,
      gapP95Ms: Math.round(gaps[Math.floor(0.95 * gaps.length)] * 10) / 10,
      gapMaxMs: Math.round(gaps[gaps.length - 1] * 10) / 10,
      lateGapsOver120ms: late
    };
  }

  function report() {
    var nav = null, paints = {};
    try {
      var navEntries = performance.getEntriesByType('navigation');
      if (navEntries && navEntries[0]) {
        var e = navEntries[0];
        nav = {
          domContentLoadedMs: Math.round(e.domContentLoadedEventEnd * 10) / 10,
          loadMs: Math.round(e.loadEventEnd * 10) / 10,
          responseEndMs: Math.round(e.responseEnd * 10) / 10
        };
      }
      var paintEntries = performance.getEntriesByType('paint');
      for (var i = 0; i < paintEntries.length; i++) {
        paints[paintEntries[i].name] = Math.round(paintEntries[i].startTime * 10) / 10;
      }
    } catch (err) { /* timing API unavailable */ }
    var ltTotal = 0, ltMax = 0;
    for (var k = 0; k < longtasks.length; k++) { ltTotal += longtasks[k].duration; if (longtasks[k].duration > ltMax) ltMax = longtasks[k].duration; }
    return {
      probeLoadedAtMs: Math.round(t0 * 10) / 10,
      navigation: nav,
      paints: paints,
      marks: marks,
      measures: measures,
      longtasks: { count: longtasks.length, totalMs: Math.round(ltTotal * 10) / 10, maxMs: ltMax, list: longtasks.slice(-20) },
      frames: frameStats(),
      blocks: blockStats(),
      scopes: scopeResults.slice(),
      userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    };
  }

  root.PSPerf = {
    mark: mark,
    measure: measure,
    noteBlock: noteBlock,
    report: report,
    frames: {
      start: function (label) {
        scope = { label: label, at: now(), framesAtStart: frameCount, dropped34: dropped34, dropped50: dropped50 };
      },
      stop: function () {
        if (!scope) return null;
        var r = {
          label: scope.label,
          durationMs: Math.round((now() - scope.at) * 10) / 10,
          frames: frameCount - scope.framesAtStart,
          dropped34: dropped34 - scope.dropped34,
          dropped50: dropped50 - scope.dropped50
        };
        scopeResults.push(r);
        scope = null;
        return r;
      }
    }
  };
})(typeof window !== 'undefined' ? window : this);
