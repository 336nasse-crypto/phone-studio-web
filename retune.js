/* retune.js — re-analyse a finished take, off the live path (Step 3).
 *
 * Two jobs, both after the take is saved (the recorded file stays
 * dry — nothing here ever writes back into it):
 *
 *   analyze(samples, sampleRate, key) — listen to the whole take
 *     once through the tune engine in offline mode (full 7 chorus
 *     voices, no live limits) and record the pitch it hears, hop
 *     by hop. Then smooth that track (median filter + short gaps
 *     filled in) and sum it up: the note the take sings around
 *     most, how much of it fits the song's key, how much of it is
 *     actually sung vs silence. The take sheet shows that summary
 *     in plain words ("Sings around A3 — 83% of the notes fit
 *     D minor").
 *
 *   render(samples, sampleRate, params, smoothedTrack) — tune the
 *     take again, but this time the correction reads the SMOOTHED
 *     track instead of the live detector: the tune can look ahead
 *     at notes the singer has already finished, so it never chases
 *     a note late. Built and tested in v12; the finished render
 *     is not surfaced in the app yet — the Phase 4 mixer will use
 *     it when a take is mixed down. (The take sheet's Play button
 *     keeps using the live tune engine, which is instant.)
 *
 * Needs window.PS.tune (TuneDSP) in the browser — index.html
 * loads tune-worklet.js with a <script> tag for exactly this.
 * In Node it requires tune-worklet.js directly.
 *
 * Pure functions of (samples, sampleRate) — no DOM, no storage.
 */
(function (root, factory) {
  var tune = null;
  if (typeof module !== 'undefined' && module.exports) {
    tune = require('./tune-worklet.js');
  } else {
    tune = root.PS && root.PS.tune;
  }
  var api = factory(tune);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.retune = api;
  }
})(typeof self !== 'undefined' ? self : this, function (tune) {
  'use strict';

  var HOP = 256; // the DSP's hop: one pitch reading per 256 samples
  var SMOOTH_HALF = 2; // median filter over ±2 hops (~27 ms)
  var MAX_GAP_HOPS = 20; // fill gaps up to ~107 ms (a short breath); longer stays silent
  var NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  function noteName(midiFloat) {
    var m = Math.round(midiFloat);
    var pc = ((m % 12) + 12) % 12;
    var octave = Math.floor(m / 12) - 1;
    return NOTE_NAMES[pc] + octave;
  }

  function median(values) {
    if (values.length === 0) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.floor(sorted.length / 2)];
  }

  /* Median-of-5 over the voiced readings around each hop (nulls
   * ignored). Kills single-hop detector glitches without moving
   * the real notes — the same idea as the live median-of-3, but
   * offline it can look both ways.
   */
  function smoothTrack(raw) {
    var out = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] === null || raw[i] === undefined) {
        out[i] = null;
        continue;
      }
      var window = [];
      for (var j = i - SMOOTH_HALF; j <= i + SMOOTH_HALF; j++) {
        if (j >= 0 && j < raw.length && raw[j] !== null && raw[j] !== undefined) {
          window.push(raw[j]);
        }
      }
      out[i] = median(window);
    }
    // Fill short null gaps (a breath inside a phrase) by drawing a
    // straight line between the notes on either side. Longer gaps
    // are real pauses — leave them silent.
    for (var k = 0; k < out.length; k++) {
      if (out[k] !== null) continue;
      var start = k;
      while (k < out.length && out[k] === null) k++;
      var end = k; // first voiced hop after the gap (or out.length)
      var gapLen = end - start;
      var before = start > 0 ? out[start - 1] : null;
      var after = end < out.length ? out[end] : null;
      if (gapLen <= MAX_GAP_HOPS && before !== null && after !== null) {
        for (var g = 0; g < gapLen; g++) {
          out[start + g] = before + (after - before) * ((g + 1) / (gapLen + 1));
        }
      }
      k = end - 1;
    }
    return out;
  }

  /* Runs the DSP over `samples` in hop-sized pieces and returns
   * the raw pitch track (one Hz-or-null per hop). `forAnalysis`
   * records the track; `withTrack` feeds a smoothed track back in
   * instead of the live detector.
   */
  function runDsp(samples, sampleRate, setup, withTrack) {
    var dsp = new tune.TuneDSP(sampleRate);
    if (setup.key) dsp.setKey(setup.key);
    if (setup.preset) dsp.setPreset(setup.preset);
    if (setup.strength !== undefined && setup.strength !== null) {
      dsp.setStrength(setup.strength);
    }
    if (setup.speed !== undefined && setup.speed !== null) {
      dsp.setSpeed(setup.speed);
    }
    dsp.setEnabled(true);
    dsp.setOffline(true);
    var out = new Float32Array(samples.length);
    var chunk = new Float32Array(HOP);
    var track = null;
    if (withTrack === null) {
      // Analysis pass: record what the detector hears.
      dsp.startPitchTrack();
    }
    var hopIndex = 0;
    for (var off = 0; off < samples.length; off += HOP) {
      var len = Math.min(HOP, samples.length - off);
      chunk.fill(0);
      chunk.set(samples.subarray(off, off + len));
      if (withTrack) {
        dsp.setExternalPitchHz(withTrack[hopIndex] !== undefined ? withTrack[hopIndex] : null);
      }
      dsp.process(chunk, len);
      out.set(chunk.subarray(0, len), off);
      hopIndex++;
    }
    if (withTrack === null) track = dsp.stopPitchTrack();
    return { out: out, track: track };
  }

  /* The summary half of analyze(): from a smoothed pitch track,
   * the note the take sings around most, how much of it fits the
   * song's key, and how much of it is actually sung. Shared by
   * analyze() and analyzeChunked() so both report the same words.
   */
  function summarize(smoothed, sampleRate, key, totalSeconds) {
    var voiced = [];
    for (var i = 0; i < smoothed.length; i++) {
      if (smoothed[i] !== null && smoothed[i] !== undefined) voiced.push(smoothed[i]);
    }
    var medianF0 = median(voiced);
    var dominantNoteMidi = medianF0 === null ? null : tune.midiForHz(medianF0);
    var inKeyFraction = null;
    if (key && voiced.length > 0) {
      var mask = tune.scaleMaskForKey(key);
      var inKey = 0;
      for (var j = 0; j < voiced.length; j++) {
        if (tune.isInScale(Math.round(tune.midiForHz(voiced[j])), mask)) inKey++;
      }
      inKeyFraction = inKey / voiced.length;
    }
    return {
      pitchTrack: smoothed,
      medianF0: medianF0,
      dominantNote: dominantNoteMidi === null ? null : noteName(dominantNoteMidi),
      dominantNoteMidi: dominantNoteMidi,
      voicedSeconds: (voiced.length * HOP) / sampleRate,
      totalSeconds: totalSeconds,
      voicedFraction: smoothed.length > 0 ? voiced.length / smoothed.length : 0,
      inKeyFraction: inKeyFraction,
      key: key || null
    };
  }

  function analyze(samples, sampleRate, key) {
    if (!tune) throw new Error('TuneDSP is not loaded.');
    if (!samples || samples.length === 0 || !sampleRate) {
      return {
        pitchTrack: [], medianF0: null, dominantNote: null,
        dominantNoteMidi: null, voicedSeconds: 0, totalSeconds: 0,
        voicedFraction: 0, inKeyFraction: null, key: key || null
      };
    }
    var totalSeconds = samples.length / sampleRate;
    var result = runDsp(samples, sampleRate, { key: key || 'D minor', preset: 'hard', strength: 100 }, null);
    var smoothed = smoothTrack(result.track || []);
    return summarize(smoothed, sampleRate, key, totalSeconds);
  }

  /* The same analysis as analyze(), but the DSP runs in slices of
   * ~2 seconds of audio per macrotask (setTimeout) so a long take
   * never freezes the screen — playback, which already started,
   * stays smooth (its audio runs on the worklet thread anyway, but
   * the buttons and the playhead must not hitch either).
   * onDone(summary) fires when the whole take has been heard.
   * Returns a cancel function; cancelling just stops the slices.
   * The recorded file is never touched — this only listens.
   */
  function analyzeChunked(samples, sampleRate, key, onDone, chunkSeconds) {
    if (!tune) throw new Error('TuneDSP is not loaded.');
    if (!samples || samples.length === 0 || !sampleRate) {
      setTimeout(function () { onDone(summarize([], sampleRate, key, 0)); }, 0);
      return function () {};
    }
    var totalSeconds = samples.length / sampleRate;
    var dsp = new tune.TuneDSP(sampleRate);
    dsp.setKey(key || 'D minor');
    dsp.setPreset('hard');
    dsp.setStrength(100);
    dsp.setEnabled(true);
    dsp.setOffline(true);
    dsp.startPitchTrack();
    var sliceLen = Math.max(HOP, Math.floor(((chunkSeconds || 2) * sampleRate) / HOP) * HOP);
    var off = 0;
    var cancelled = false;
    var chunk = new Float32Array(HOP);
    function step() {
      if (cancelled) return;
      var end = Math.min(samples.length, off + sliceLen);
      for (var o = off; o < end; o += HOP) {
        var len = Math.min(HOP, samples.length - o);
        chunk.fill(0);
        chunk.set(samples.subarray(o, o + len));
        dsp.process(chunk, len);
      }
      off = end;
      if (off < samples.length) {
        setTimeout(step, 0);
      } else {
        var track = dsp.stopPitchTrack();
        onDone(summarize(smoothTrack(track), sampleRate, key, totalSeconds));
      }
    }
    setTimeout(step, 0);
    return function () { cancelled = true; };
  }

  /* Tune a take from its smoothed track (see the header). The
   * output is the same length as the input, tuned, dry file
   * untouched — the caller decides what to do with it.
   */
  function render(samples, sampleRate, params, smoothedTrack) {
    if (!tune) throw new Error('TuneDSP is not loaded.');
    if (!samples || samples.length === 0 || !sampleRate) {
      return new Float32Array(0);
    }
    var setup = {
      key: (params && params.key) || 'D minor',
      preset: (params && params.preset) || 'hard',
      strength: (params && params.strength !== undefined && params.strength !== null) ? params.strength : 100,
      speed: (params && params.speed !== undefined) ? params.speed : null
    };
    var result = runDsp(samples, sampleRate, setup, smoothedTrack || []);
    return result.out;
  }

  /* A Butterworth low-pass, in plain JS (v13.7). The take's small
   * copy needs one: the resampler folds anything above the new top
   * end back down as a phantom tone, so the take is filtered
   * before it is resampled. It is plain JS and not a
   * BiquadFilterNode on purpose — measured in headless Chromium
   * (cdp-v137 probes, Nov 25): a BiquadFilterNode 'lowpass' at
   * 8,500 Hz with Q=0.707 passed 8 kHz at 1.15× where the RBJ
   * cookbook says 0.76×, and a 5-section Butterworth cascade built
   * from those nodes peaked at 3.35× around 7 kHz. The same
   * coefficients run through this loop read 0.995× at 3 kHz and
   * 0.757× at 8 kHz — exactly the cookbook. So the filter lives
   * here, identical in every browser, and the node is not trusted
   * with it.
   *
   * `order` must be even (10 for the small copy: 8 kHz passes at
   * ~0.88×, 12 kHz is down to ~0.03×). The sections are the
   * Butterworth pole pairs, Q = 1 / (2 cos((2k-1)π / (2n))). The
   * loop is Direct Form I with double-precision state, in place —
   * the history lives in variables, so writing y[i] into the same
   * array never corrupts x[i-1]. A cutoff at or above the top end
   * is a no-op (nothing to filter). Returns the same array.
   */
  function lowpassButterworth(samples, sampleRate, cutoffHz, order) {
    if (!samples || samples.length === 0 || !sampleRate || !cutoffHz || !order) return samples;
    if (cutoffHz >= sampleRate / 2) return samples;
    var n = order % 2 === 0 ? order : order + 1;
    var sections = n / 2;
    var w0 = 2 * Math.PI * cutoffHz / sampleRate;
    var cosw = Math.cos(w0);
    var sinw = Math.sin(w0);
    var b0 = (1 - cosw) / 2, b1 = 1 - cosw, b2 = (1 - cosw) / 2;
    for (var k = 1; k <= sections; k++) {
      var q = 1 / (2 * Math.cos((2 * k - 1) * Math.PI / (2 * n)));
      var alpha = sinw / (2 * q);
      var a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
      var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (var i = 0; i < samples.length; i++) {
        var x0 = samples[i];
        var y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        samples[i] = y0;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      }
    }
    return samples;
  }

  return {
    HOP: HOP,
    analyze: analyze,
    analyzeChunked: analyzeChunked,
    render: render,
    smoothTrack: smoothTrack,
    noteName: noteName,
    lowpassButterworth: lowpassButterworth // v13.7: the small copy's anti-alias filter
  };
});
