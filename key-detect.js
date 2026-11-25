/* key-detect.js — what key is this beat in? (Step 9A)
 *
 * Listens to the imported beat and guesses its key, so the tune
 * snaps to the right scale without Denasse setting it by hand.
 *
 * Method (Temperley, no ML model, no network, no extra library):
 *   1. Shrink the audio to ~8 kHz (a beat's key lives below 1 kHz)
 *      and take at most the first 45 seconds.
 *   2. Measure how loud each of the 12 notes is, across octaves
 *      C2..C6, with a Goertzel tone detector per note — that is the
 *      "chroma" (how much C, C#, D, ... the beat contains).
 *   3. Compare that chroma against the 24 standard key shapes
 *      (Krumhansl-Schmuckler profiles: what a song in C major, C
 *      minor, D major ... "looks like" note-wise) with a Pearson
 *      correlation. Best match wins.
 *   4. Confidence is the gap between the best and second-best
 *      match: a clean beat has one clear winner; a noisy or
 *      key-changing beat has two close ones, and the app says so
 *      instead of guessing.
 *
 * Returns { key, tonic, scale, confidence, top2, relative } where
 * key is e.g. 'A minor', top2 is the two best matches with their
 * scores, and relative is the relative major/minor ('A minor' <->
 * 'C major') so the app can offer "also sounds like ..." with one
 * tap. If the audio is too short or silent, key is null.
 *
 * Pure function of (samples, sampleRate) — no DOM, no storage.
 * Loads in the browser as window.PS.keydetect; in Node as a module.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.keydetect = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var SCALES = ['major', 'minor'];

  // Krumhansl-Schmuckler key profiles: how strongly each of the 12
  // notes (C..B) shows up in a song in C major / C minor.
  var PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  var PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  var MAX_SECONDS = 45; // analyse at most the first 45 s of a beat
  var TARGET_RATE = 8000; // decimated rate: the key lives below 1 kHz
  var MIN_SECONDS = 0.5; // shorter than this, there is nothing to hear
  var LOW_MIDI = 36; // C2
  var HIGH_MIDI = 84; // C6

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /* Shrink mono to ~8 kHz with a boxcar average (a crude low-pass,
   * good enough: it kills the highs that would fold back down).
   */
  function decimate(mono, sampleRate) {
    var factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
    var decRate = sampleRate / factor;
    var maxLen = Math.floor(MAX_SECONDS * decRate);
    var n = Math.min(Math.floor(mono.length / factor), maxLen);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var sum = 0;
      var base = i * factor;
      for (var k = 0; k < factor; k++) sum += mono[base + k];
      out[i] = sum / factor;
    }
    return { samples: out, rate: decRate };
  }

  /* Goertzel magnitude of one frequency over the whole signal. */
  function goertzel(samples, freq, rate) {
    var w = 2 * Math.PI * freq / rate;
    var coeff = 2 * Math.cos(w);
    var s1 = 0, s2 = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    var mag2 = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    return mag2 > 0 ? Math.sqrt(mag2) : 0;
  }

  /* Pearson correlation between two 12-element vectors. */
  function pearson(a, b) {
    var n = a.length;
    var ma = 0, mb = 0;
    for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    var num = 0, da = 0, db = 0;
    for (var j = 0; j < n; j++) {
      var x = a[j] - ma, y = b[j] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    var den = Math.sqrt(da * db);
    return den > 0 ? num / den : 0;
  }

  /* The relative key: C major <-> A minor (same notes, 3 semitones
   * between tonics). The app offers it as "also sounds like ...". */
  function relativeKey(tonic, scale) {
    var idx = TONICS.indexOf(tonic);
    if (idx === -1) return null;
    if (scale === 'major') {
      return TONICS[(idx + 9) % 12] + ' minor';
    }
    return TONICS[(idx + 3) % 12] + ' major';
  }

  function detectKey(mono, sampleRate) {
    var empty = {
      key: null, tonic: null, scale: null, confidence: 0,
      top2: [], relative: null, reason: null
    };
    if (!mono || !mono.length || !sampleRate || sampleRate <= 0) {
      empty.reason = 'no-audio';
      return empty;
    }
    if (mono.length / sampleRate < MIN_SECONDS) {
      empty.reason = 'too-short';
      return empty;
    }
    var dec = decimate(mono, sampleRate);
    var samples = dec.samples;
    var rate = dec.rate;
    // Silence (or near it) has no key.
    var peak = 0;
    for (var i = 0; i < samples.length; i++) {
      var a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-4) {
      empty.reason = 'silent';
      return empty;
    }
    // Chroma: loudness per note name, summed across octaves.
    var chroma = new Float64Array(12);
    for (var midi = LOW_MIDI; midi <= HIGH_MIDI; midi++) {
      var mag = goertzel(samples, midiToFreq(midi), rate);
      chroma[midi % 12] += mag;
    }
    var total = 0;
    for (var p = 0; p < 12; p++) total += chroma[p];
    if (total <= 0) {
      empty.reason = 'no-notes';
      return empty;
    }
    for (var q = 0; q < 12; q++) chroma[q] /= total;
    // Score all 24 keys.
    var scored = [];
    for (var t = 0; t < 12; t++) {
      for (var s = 0; s < 2; s++) {
        var profile = s === 0 ? PROFILE_MAJOR : PROFILE_MINOR;
        var rotated = new Array(12);
        for (var r = 0; r < 12; r++) rotated[(r + t) % 12] = profile[r];
        var score = pearson(chroma, rotated);
        scored.push({
          key: TONICS[t] + ' ' + SCALES[s],
          tonic: TONICS[t],
          scale: SCALES[s],
          score: score
        });
      }
    }
    scored.sort(function (a, b) { return b.score - a.score; });
    var best = scored[0];
    var second = scored[1];
    // Confidence = how far the winner is ahead of the runner-up,
    // as a share of the room left above the runner-up. A clean
    // triad lands ~0.5-0.9; noise lands near 0.
    var conf = 0;
    if (best.score > 0) {
      conf = (best.score - second.score) / (1 - second.score);
      if (conf < 0) conf = 0;
      if (conf > 1) conf = 1;
    }
    return {
      key: best.key,
      tonic: best.tonic,
      scale: best.scale,
      confidence: conf,
      top2: [
        { key: best.key, score: best.score },
        { key: second.key, score: second.score }
      ],
      relative: relativeKey(best.tonic, best.scale),
      reason: null
    };
  }

  return {
    TONICS: TONICS,
    SCALES: SCALES,
    detectKey: detectKey,
    relativeKey: relativeKey
  };
});
