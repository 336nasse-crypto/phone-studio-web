/* calibrate.js — acoustic Bluetooth latency calibration.
 *
 * Direct port of LatencyCalibrator.swift: play 5 clicks through the
 * headphones, listen for them coming back through the phone mic, and
 * measure the round-trip delay. The median across clicks rejects
 * outliers (a cough, a room echo).
 *
 * The measurement is identical to native: a click scheduled at
 * render-time C is heard at C + D_out and appears in the recording at
 * C + D_out + D_in, so measured delay = onset − C = D = D_out + D_in.
 * On the web, the click times and the recorded samples share the
 * AudioContext render timeline (worklet currentTime), so no wall
 * clock is involved — same as the native engine clock.
 *
 * Loads in the browser as window.PS.calibrate and in Node as
 * module.exports (the self-test uses the Node form).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.calibrate = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tuning constants — identical to LatencyCalibrator.swift.
  var CLICK_COUNT = 5;
  var CLICK_SPACING = 0.6; // seconds between clicks
  var FIRST_CLICK_DELAY = 0.5; // seconds out for the first click (tap settles)
  var CLICK_DURATION = 0.012; // 12 ms of 2 kHz
  var CLICK_FREQUENCY = 2000;
  var CLICK_FADE = 0.002; // 2 ms fade-out at the end
  var CLICK_AMPLITUDE = 0.9;
  var SEARCH_WINDOW = 0.5; // search 0–500 ms after each click
  var MIN_PLAUSIBLE_DELAY = 0.005; // 5 ms
  var MAX_PLAUSIBLE_DELAY = 0.6; // 600 ms
  var DETECTION_THRESHOLD = 0.01; // -40 dBFS
  var MINIMUM_CLICKS_DETECTED = 3;

  /* A 12 ms burst of 2 kHz sine: full amplitude from the first sample
   * (sharp onset — that is what we time), fading out over the last
   * 2 ms so it ends cleanly. Mono; the caller duplicates it to stereo
   * when building the AudioBuffer so it plays in both ears.
   * (Port of LatencyCalibrator.makeClickBuffer.)
   */
  function makeClickSamples(sampleRate) {
    var frames = Math.round(CLICK_DURATION * sampleRate);
    var fadeFrames = Math.round(CLICK_FADE * sampleRate);
    var samples = new Float32Array(frames);
    for (var i = 0; i < frames; i++) {
      var t = i / sampleRate;
      var value = Math.sin(2 * Math.PI * CLICK_FREQUENCY * t) * CLICK_AMPLITUDE;
      if (i >= frames - fadeFrames) {
        value *= (frames - i) / fadeFrames;
      }
      samples[i] = value;
    }
    return samples;
  }

  /* Finds the onset of a click inside a search window.
   *
   * DELIBERATE IMPROVEMENT OVER THE NATIVE findOnset (proven by the
   * self-test): the native detector peak-picks a sample, then walks
   * back to 10% of the peak. For a 12 ms multi-cycle 2 kHz burst in
   * real room noise, the loudest sample can sit anywhere inside the
   * burst, and the walk-back stops at the zero-crossing just before
   * it — up to ~12 ms after the true onset, scattered per click.
   * The self-test measured 3–8 ms of error and scatter with realistic
   * noise. The envelope has no zero-crossings, so this version works
   * on a 1 ms block envelope (max absolute value per block): find the
   * peak envelope, take the first block above 10% of it, then refine
   * to the first sample above that threshold inside the block. Same
   * constants as native (10% of peak, -40 dBFS detection threshold),
   * same median/bounds around it — only the onset finding is more
   * robust. Returns the index into `samples`, or null if nothing in
   * the window is loud enough to be a click.
   */
  function findOnset(samples, start, end, sampleRate) {
    var blockFrames = Math.max(1, Math.round(0.001 * sampleRate)); // 1 ms blocks
    var blockCount = Math.ceil((end - start) / blockFrames);
    if (blockCount <= 0) return null;
    var env = new Float32Array(blockCount);
    var peakEnv = 0;
    for (var b = 0; b < blockCount; b++) {
      var bs = start + b * blockFrames;
      var be = Math.min(bs + blockFrames, end);
      var m = 0;
      for (var i = bs; i < be; i++) {
        var v = Math.abs(samples[i]);
        if (v > m) m = v;
      }
      env[b] = m;
      if (m > peakEnv) peakEnv = m;
    }
    if (peakEnv < DETECTION_THRESHOLD) return null;
    var threshold = peakEnv * 0.1;
    var onsetBlock = -1;
    for (var k = 0; k < blockCount; k++) {
      if (env[k] > threshold) { onsetBlock = k; break; }
    }
    if (onsetBlock < 0) return null;
    // Refine within the block: first sample above the threshold.
    // (The burst cannot start in an earlier block — every earlier
    // block's envelope is below threshold, so all its samples are.)
    var rs = start + onsetBlock * blockFrames;
    var re = Math.min(rs + blockFrames, end);
    for (var j = rs; j < re; j++) {
      if (Math.abs(samples[j]) > threshold) return j;
    }
    return rs; // block start — within 1 ms of the true onset
  }

  /* Measures the round-trip delay from a calibration recording.
   *
   * samples: the recorded mic samples (Float32Array, mono).
   * sampleRate: the context sample rate.
   * scheduledTimes: the render-clock times (seconds) each click was
   *   scheduled to play at, in order.
   * firstSampleTime: the render-clock time (seconds) of samples[0]
   *   (the first AudioWorklet block's currentTime).
   *
   * Returns { ok, medianMs, medianSamples, delaySeconds, delaysMs,
   * detected, error } — error is a plain-words message when ok is
   * false. (Port of the analysis half of LatencyCalibrator.calibrate.)
   */
  function measureDelays(samples, sampleRate, scheduledTimes, firstSampleTime) {
    if (!samples || samples.length === 0) {
      return {
        ok: false, medianMs: null, medianSamples: null, delaySeconds: null,
        delaysMs: [], detected: 0,
        error: 'The mic heard nothing. Make sure the headphones are next to the phone and the volume is up, then try again.'
      };
    }
    var searchFrames = Math.round(SEARCH_WINDOW * sampleRate);
    var delays = [];
    for (var k = 0; k < scheduledTimes.length; k++) {
      // Window in the recorded array, relative to its start.
      var windowStart = Math.round((scheduledTimes[k] - firstSampleTime) * sampleRate);
      if (windowStart < 0 || windowStart >= samples.length) continue;
      var windowEnd = Math.min(windowStart + searchFrames, samples.length);
      if (windowEnd <= windowStart) continue;
      var onset = findOnset(samples, windowStart, windowEnd, sampleRate);
      if (onset !== null) {
        delays.push(onset - windowStart);
      }
    }

    if (delays.length < MINIMUM_CLICKS_DETECTED) {
      return {
        ok: false, medianMs: null, medianSamples: null, delaySeconds: null,
        delaysMs: delays.map(function (d) { return d / sampleRate * 1000; }),
        detected: delays.length,
        error: 'I could only hear ' + delays.length + ' of ' + scheduledTimes.length +
          ' clicks. Put the headphones right next to the phone, turn the volume up, and try again.'
      };
    }

    var sorted = delays.slice().sort(function (a, b) { return a - b; });
    var medianSamples = sorted[Math.floor(sorted.length / 2)];
    var delaySeconds = medianSamples / sampleRate;
    if (delaySeconds < MIN_PLAUSIBLE_DELAY || delaySeconds > MAX_PLAUSIBLE_DELAY) {
      return {
        ok: false, medianMs: Math.round(delaySeconds * 1000), medianSamples: medianSamples,
        delaySeconds: delaySeconds,
        delaysMs: delays.map(function (d) { return d / sampleRate * 1000; }),
        detected: delays.length,
        error: 'The measurement came back at ' + Math.round(delaySeconds * 1000) +
          ' ms, which is outside the believable range. Try again with the headphones next to the phone.'
      };
    }

    return {
      ok: true,
      medianMs: delaySeconds * 1000,
      medianSamples: medianSamples,
      delaySeconds: delaySeconds,
      delaysMs: delays.map(function (d) { return d / sampleRate * 1000; }),
      detected: delays.length,
      error: null
    };
  }

  return {
    CLICK_COUNT: CLICK_COUNT,
    CLICK_SPACING: CLICK_SPACING,
    FIRST_CLICK_DELAY: FIRST_CLICK_DELAY,
    CLICK_DURATION: CLICK_DURATION,
    CLICK_FREQUENCY: CLICK_FREQUENCY,
    SEARCH_WINDOW: SEARCH_WINDOW,
    MIN_PLAUSIBLE_DELAY: MIN_PLAUSIBLE_DELAY,
    MAX_PLAUSIBLE_DELAY: MAX_PLAUSIBLE_DELAY,
    DETECTION_THRESHOLD: DETECTION_THRESHOLD,
    MINIMUM_CLICKS_DETECTED: MINIMUM_CLICKS_DETECTED,
    makeClickSamples: makeClickSamples,
    findOnset: findOnset,
    measureDelays: measureDelays
  };
});
