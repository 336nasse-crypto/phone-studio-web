/* tempo-detect.js — how fast is this beat? (Step 9A)
 *
 * Listens to the imported beat and guesses its tempo, so the tune
 * and (later) the grid know where the downbeats fall.
 *
 * Method (no ML model, no network, no extra library):
 *   1. Loudness envelope: RMS loudness in short slices (~11 ms).
 *   2. Onsets: where the loudness JUMPS up (a kick, a snare, a
 *      hat) — the rising edges only.
 *   3. Autocorrelation: slide the onset pattern against itself
 *      and see which shift lines the hits back up. The shift that
 *      lines up best is the beat period. Searched over 40-240 BPM.
 *   4. The answer comes as a PAIR: the detected tempo and its
 *      half/double partner nearest 120 BPM (68 <-> 136), because
 *      a beat at 68 and a beat at 136 have the same pulse — the
 *      app shows both and lets Denasse pick.
 *   5. Grid Start Offset: where the first real hit lands, in
 *      seconds — the downbeat the grid starts from. (The mixer in
 *      Phase 4 lines the vocals up to it; v12 only stores it and
 *      lets him nudge it.)
 *
 * Returns { bpm, bpmAlt, confidence, periodSeconds,
 * gridStartOffsetSeconds } or nulls when there is nothing to hear.
 * Confidence is the autocorrelation peak (0..1): a steady click
 * train lands ~0.9, a loose or rubato beat lands low, and the app
 * says so instead of guessing.
 *
 * Pure function of (samples, sampleRate) — no DOM, no storage.
 * Loads in the browser as window.PS.tempodetect; in Node as a module.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.tempodetect = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOP = 512; // envelope slice, ~11 ms at 48 kHz
  var MIN_BPM = 40;
  var MAX_BPM = 240;
  var SEARCH_MIN_BPM = 60; // primary search: the tempo is usually here
  var SEARCH_MAX_BPM = 180;
  var MAX_SECONDS = 60; // analyse at most the first 60 s
  var MIN_SECONDS = 2; // shorter than this, no tempo can be heard

  function empty(reason) {
    return {
      bpm: null, bpmAlt: null, confidence: 0,
      periodSeconds: null, gridStartOffsetSeconds: null,
      reason: reason || null
    };
  }

  /* RMS loudness per hop. */
  function envelope(mono) {
    var frames = Math.floor(mono.length / HOP);
    var env = new Float32Array(frames);
    for (var f = 0; f < frames; f++) {
      var sum = 0;
      var base = f * HOP;
      for (var i = 0; i < HOP; i++) {
        var v = mono[base + i];
        sum += v * v;
      }
      env[f] = Math.sqrt(sum / HOP);
    }
    return env;
  }

  /* Onsets: rising edges of the envelope, mean removed so the
   * autocorrelation is not swamped by the overall level. */
  function onsets(env) {
    var n = env.length;
    var out = new Float32Array(n);
    var mean = 0;
    for (var i = 1; i < n; i++) {
      var d = env[i] - env[i - 1];
      out[i] = d > 0 ? d : 0;
      mean += out[i];
    }
    mean /= Math.max(1, n);
    for (var j = 0; j < n; j++) out[j] -= mean;
    return out;
  }

  /* Autocorrelation at one lag, normalised by the overlap length
   * (so long lags are not punished for having fewer pairs) and by
   * the zero-lag energy (so the value lands in 0..1). */
  function autocorrAt(x, lag, energy0) {
    var n = x.length - lag;
    if (n <= 0 || energy0 <= 0) return 0;
    var sum = 0;
    for (var i = 0; i < n; i++) sum += x[i] * x[i + lag];
    return (sum / n) / (energy0 / x.length);
  }

  function detectTempo(mono, sampleRate) {
    if (!mono || !mono.length || !sampleRate || sampleRate <= 0) return empty('no-audio');
    var seconds = mono.length / sampleRate;
    if (seconds < MIN_SECONDS) return empty('too-short');
    var maxLen = Math.floor(MAX_SECONDS * sampleRate);
    var use = mono.length > maxLen ? mono.subarray(0, maxLen) : mono;
    var env = envelope(use);
    if (env.length < 10) return empty('too-short');
    var peak = 0;
    for (var i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
    if (peak < 1e-4) return empty('silent');
    var ons = onsets(env);
    var energy0 = 0;
    for (var j = 0; j < ons.length; j++) energy0 += ons[j] * ons[j];
    if (energy0 <= 0) return empty('no-onsets');
    var hopSeconds = HOP / sampleRate;
    // Search lags for 40..240 BPM; the primary pick comes from
    // 60..180 BPM (where a song tempo almost always is).
    var minLag = Math.max(1, Math.floor((60 / MAX_BPM) / hopSeconds));
    var maxLag = Math.floor((60 / MIN_BPM) / hopSeconds);
    var searchMinLag = Math.max(1, Math.floor((60 / SEARCH_MAX_BPM) / hopSeconds));
    var searchMaxLag = Math.floor((60 / SEARCH_MIN_BPM) / hopSeconds);
    var bestLag = -1, bestScore = -1;
    var bestInSearch = -1, bestInSearchScore = -1;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var score = autocorrAt(ons, lag, energy0);
      if (score > bestScore) { bestScore = score; bestLag = lag; }
      if (lag >= searchMinLag && lag <= searchMaxLag && score > bestInSearchScore) {
        bestInSearchScore = score;
        bestInSearch = lag;
      }
    }
    if (bestInSearch === -1 || bestInSearchScore <= 0) return empty('no-beat');
    var period = bestInSearch * hopSeconds;
    var bpm = Math.round((60 / period) * 10) / 10;
    // The partner: the half/double on the other side of 100 BPM.
    // A 68 BPM beat and a 136 BPM beat pulse the same way; 120
    // pairs with 60, 140 with 70, 90 with 180. The detected tempo
    // stays the primary — the partner is the one-tap alternative.
    var bpmAlt = bpm < 100 ? bpm * 2 : bpm / 2;
    // Grid Start Offset: the first slice whose loudness clears 20%
    // of the peak — the first real hit, the downbeat.
    var gridOffset = 0;
    var threshold = peak * 0.2;
    for (var f = 0; f < env.length; f++) {
      if (env[f] >= threshold) {
        gridOffset = f * hopSeconds;
        break;
      }
    }
    return {
      bpm: bpm,
      bpmAlt: Math.round(bpmAlt * 10) / 10,
      confidence: Math.max(0, Math.min(1, bestInSearchScore)),
      periodSeconds: period,
      gridStartOffsetSeconds: Math.round(gridOffset * 1000) / 1000,
      reason: null
    };
  }

  return {
    detectTempo: detectTempo
  };
});
