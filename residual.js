/* residual.js — post-take residual check.
 *
 * Direct port of ResidualVerifier.swift: after the base trim, is the
 * vocal actually on the beat, or is a little delay left over?
 *
 * No BPM, no downbeat assumption; the beat file IS the grid. Strong
 * onsets in the first 30 seconds of the vocal (phrase starts) are
 * matched to the nearest beat onsets (kick/snare hits); the median
 * offset is the residual. The MAD (median absolute deviation) tells a
 * real delay (offsets cluster) from a singer singing off-beat
 * (offsets scatter). Only a positive (late) residual between 15 ms
 * and 300 ms is applied. A negative residual is recorded, NEVER
 * corrected — trimming cannot fix early.
 *
 * Verdict strings are the kebab-case forms documented in
 * TrackRecorder.TakeMetadata ("within-tolerance",
 * "early-not-corrected", ...). Note: the native Swift enum's raw
 * values are actually camelCase ("withinTolerance") — the doc comment
 * and the code disagree there. This port follows the documented
 * contract.
 *
 * Loads in the browser as window.PS.residual and in Node as
 * module.exports (the self-test uses the Node form).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.residual = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tuning constants — identical to ResidualVerifier.swift.
  var WINDOW_SECONDS = 30;
  var WINDOW_DURATION = 0.01; // 10 ms onset window
  var VOCAL_QUIET_GAP = 0.25; // 250 ms of quiet before a phrase start
  var BEAT_MIN_SEPARATION = 0.25; // beat onsets at least 250 ms apart
  var VOCAL_THRESHOLD_DB = -25;
  var BEAT_THRESHOLD_DB = -15;
  var MAX_MATCH_DISTANCE = 0.25;
  var MINIMUM_ONSETS = 3;
  var APPLY_THRESHOLD = 0.015; // 15 ms
  var MAX_PLAUSIBLE_RESIDUAL = 0.300; // 300 ms
  var MAX_MAD = 0.040; // 40 ms

  /* Finds onsets in a mono sample array: windows whose RMS rises above
   * the threshold after a quiet gap. Returns onset times in seconds
   * from the start of the array. A window counts as an onset only if
   * the preceding quietGap was all below threshold — that is what makes
   * it a phrase/hit start rather than a loud moment inside an ongoing
   * sound. (Port of ResidualVerifier.detectOnsets.)
   */
  function detectOnsets(samples, sampleRate, thresholdDB, quietGap) {
    var windowFrames = Math.max(1, Math.round(WINDOW_DURATION * sampleRate));
    var windowCount = Math.floor(samples.length / windowFrames);
    if (windowCount <= 0) return [];
    var rms = new Float32Array(windowCount);
    var peak = 0;
    for (var w = 0; w < windowCount; w++) {
      var sum = 0;
      var start = w * windowFrames;
      for (var i = 0; i < windowFrames; i++) {
        var value = samples[start + i];
        sum += value * value;
      }
      var v = Math.sqrt(sum / windowFrames);
      rms[w] = v;
      if (v > peak) peak = v;
    }
    if (peak <= 0) return [];
    var threshold = peak * Math.pow(10, thresholdDB / 20);
    var quietWindows = Math.max(1, Math.round(quietGap / WINDOW_DURATION));
    var onsets = [];
    // Start "quiet" so an onset in the very first window counts
    // (a beat that starts loud at frame 0).
    var quietRun = quietWindows;
    for (var k = 0; k < windowCount; k++) {
      if (rms[k] >= threshold) {
        if (quietRun >= quietWindows) {
          onsets.push((k * windowFrames) / sampleRate);
        }
        quietRun = 0;
      } else {
        quietRun += 1;
      }
    }
    return onsets;
  }

  /* Measures the residual offset of one take against its beat.
   *
   * vocalSamples: the take's raw samples (untrimmed, from the first
   *   recorded sample — the lead-in is still in there).
   * beatSamples: the beat's mono samples (stereo mixed to mono).
   * baseTrimSamples: the trim already applied (lead-in, plus delay
   *   when pre-compensation was off). Vocal onsets are measured in
   *   raw-file coordinates and shifted by this so they line up with
   *   beat-file coordinates.
   * sampleRate: the sample rate both arrays run at.
   *
   * Returns { trimSamples, residualSeconds, onsetCount, verdict }.
   * trimSamples is 0 unless the verdict is "applied". residualSeconds
   * is null when nothing was measured. (Port of
   * ResidualVerifier.verify; the "no-beat" and "read-failed" verdicts
   * are produced by the caller, as in the native app.)
   */
  function verify(vocalSamples, beatSamples, baseTrimSamples, sampleRate) {
    var maxFrames = Math.round(WINDOW_SECONDS * sampleRate);
    var vocal = vocalSamples.length > maxFrames
      ? vocalSamples.subarray(0, maxFrames) : vocalSamples;
    var beat = beatSamples.length > maxFrames
      ? beatSamples.subarray(0, maxFrames) : beatSamples;
    if (vocal.length === 0 || beat.length === 0) {
      return { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'unverified-too-few-onsets' };
    }

    var baseTrimSeconds = baseTrimSamples / sampleRate;
    // Vocal onsets after the trimmed lead-in only (onsets inside the
    // lead-in are room noise, not singing), shifted into aligned
    // coordinates. The one-window grace before the trim point keeps a
    // phrase starting exactly on beat 1 — its onset window can
    // straddle the trim boundary.
    var vocalOnsets = detectOnsets(vocal, sampleRate, VOCAL_THRESHOLD_DB, VOCAL_QUIET_GAP)
      .filter(function (t) { return t > baseTrimSeconds - WINDOW_DURATION; })
      .map(function (t) { return t - baseTrimSeconds; });
    var beatOnsets = detectOnsets(beat, sampleRate, BEAT_THRESHOLD_DB, BEAT_MIN_SEPARATION);
    if (vocalOnsets.length < MINIMUM_ONSETS || beatOnsets.length === 0) {
      return { trimSamples: 0, residualSeconds: null, onsetCount: vocalOnsets.length, verdict: 'unverified-too-few-onsets' };
    }

    // Match each vocal onset to its nearest beat onset.
    var offsets = [];
    for (var i = 0; i < vocalOnsets.length; i++) {
      var vocalOnset = vocalOnsets[i];
      var nearest = null;
      var nearestDist = Infinity;
      for (var j = 0; j < beatOnsets.length; j++) {
        var dist = Math.abs(beatOnsets[j] - vocalOnset);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = beatOnsets[j];
        }
      }
      if (nearest === null) continue;
      var offset = vocalOnset - nearest;
      if (Math.abs(offset) <= MAX_MATCH_DISTANCE) offsets.push(offset);
    }
    if (offsets.length < MINIMUM_ONSETS) {
      return { trimSamples: 0, residualSeconds: null, onsetCount: offsets.length, verdict: 'unverified-too-few-onsets' };
    }

    // Median offset = the residual; MAD = do the onsets agree?
    var sorted = offsets.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    var deviations = offsets.map(function (o) { return Math.abs(o - median); })
      .sort(function (a, b) { return a - b; });
    var mad = deviations[Math.floor(deviations.length / 2)];
    if (mad > MAX_MAD) {
      return { trimSamples: 0, residualSeconds: median, onsetCount: offsets.length, verdict: 'unverified-onsets-disagree' };
    }

    if (median > APPLY_THRESHOLD) {
      if (median < MAX_PLAUSIBLE_RESIDUAL) {
        return {
          trimSamples: Math.round(median * sampleRate),
          residualSeconds: median, onsetCount: offsets.length, verdict: 'applied'
        };
      }
      return { trimSamples: 0, residualSeconds: median, onsetCount: offsets.length, verdict: 'rejected-implausible' };
    } else if (median < -APPLY_THRESHOLD) {
      return { trimSamples: 0, residualSeconds: median, onsetCount: offsets.length, verdict: 'early-not-corrected' };
    }
    return { trimSamples: 0, residualSeconds: median, onsetCount: offsets.length, verdict: 'within-tolerance' };
  }

  return {
    WINDOW_SECONDS: WINDOW_SECONDS,
    WINDOW_DURATION: WINDOW_DURATION,
    VOCAL_QUIET_GAP: VOCAL_QUIET_GAP,
    BEAT_MIN_SEPARATION: BEAT_MIN_SEPARATION,
    VOCAL_THRESHOLD_DB: VOCAL_THRESHOLD_DB,
    BEAT_THRESHOLD_DB: BEAT_THRESHOLD_DB,
    MAX_MATCH_DISTANCE: MAX_MATCH_DISTANCE,
    MINIMUM_ONSETS: MINIMUM_ONSETS,
    APPLY_THRESHOLD: APPLY_THRESHOLD,
    MAX_PLAUSIBLE_RESIDUAL: MAX_PLAUSIBLE_RESIDUAL,
    MAX_MAD: MAX_MAD,
    detectOnsets: detectOnsets,
    verify: verify
  };
});
