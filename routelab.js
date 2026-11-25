/* routelab.js — route-lab measurements (Step 0, Phase 0).
 *
 * Pure DSP + measurement math, no DOM, no audio APIs: every function
 * here runs in Node (the self-test uses the Node form) and in the
 * browser as window.PS.routelab.
 *
 * What it measures, from a recorded segment:
 * - bandwidth: the highest frequency within 60 dB of the spectral
 *   peak. Studio grade means 15 kHz or more (the bar from the
 *   pipeline review). A held "sss" is the test signal — sibilance
 *   has energy across the whole top end, so where it stops is the
 *   route's ceiling, not the voice's.
 * - energyAbove(freq): the fraction of total spectral energy above a
 *   frequency — the narrowband check (7.5 kHz) and the 12 kHz check.
 * - narrowbandWarning: true when a take has virtually no energy
 *   above 7.5 kHz — a Bluetooth HFP mic crushes everything above
 *   ~4 kHz (narrowband) or ~7-8 kHz (wideband); no software recovers
 *   frequencies the mic never captured.
 * - clapOffsets: median + spread of a set of measured click delays —
 *   the clap test passes when the spread is <= 10 ms (ESTIMATED).
 * - roomToneFloor: RMS level of a room-tone segment, in dBFS.
 *
 * The spectrum is a Hann-windowed FFT averaged over up to 8 windows
 * spread through the segment, so one loud moment cannot fake the
 * bandwidth and one quiet moment cannot hide it.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.routelab = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FFT_SIZE = 4096;
  var MAX_WINDOWS = 8;
  var BANDWIDTH_DB_DOWN = 60; // within 60 dB of the spectral peak
  var STUDIO_GRADE_HZ = 15000; // studio grade means 15 kHz or more
  var NARROWBAND_FREQ_HZ = 7500; // HFP warning threshold
  var NARROWBAND_FRACTION = 0.0005; // "virtually zero" = under 0.05%
  var NARROWBAND_MIN_RMS_DB = -50; // the take must have real content
  var CLAP_SPREAD_PASS_MS = 10; // clap test passes when spread <= 10 ms

  /* Iterative radix-2 FFT, in place. re/im are Float64Arrays of the
   * same power-of-two length. Standard bit-reversal + butterfly.
   */
  function fft(re, im) {
    var n = re.length;
    var j = 0;
    var i, k, m;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    var len = 2;
    while (len <= n) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang);
      var wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cwr = 1;
        var cwi = 0;
        for (k = 0; k < len / 2; k++) {
          var ur = re[i + k];
          var ui = im[i + k];
          var vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          var vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr;
          im[i + k + len / 2] = ui - vi;
          var nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
      len <<= 1;
    }
  }

  /* Average magnitude spectrum over windows spread through the
   * segment. Returns { magnitudes: Float64Array (bins 0..N/2),
   * binHz, sampleRate } or null when the segment is too short.
   * Hann window; magnitudes are linear (not dB).
   */
  function magnitudeSpectrum(samples, sampleRate, fftSize) {
    var n = fftSize || FFT_SIZE;
    if (!samples || samples.length < n) return null;
    var windows = Math.min(MAX_WINDOWS, Math.floor(samples.length / n));
    if (windows < 1) return null;
    var half = n / 2;
    var sum = new Float64Array(half + 1);
    var step = windows > 1 ? Math.floor((samples.length - n) / (windows - 1)) : 0;
    var re = new Float64Array(n);
    var im = new Float64Array(n);
    for (var w = 0; w < windows; w++) {
      var start = w * step;
      for (var i = 0; i < n; i++) {
        // Hann window.
        var win = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
        re[i] = samples[start + i] * win;
        im[i] = 0;
      }
      fft(re, im);
      for (var b = 0; b <= half; b++) {
        sum[b] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      }
    }
    for (var c = 0; c <= half; c++) sum[c] /= windows;
    return { magnitudes: sum, binHz: sampleRate / n, sampleRate: sampleRate };
  }

  function spectrumEnergyFraction(spec, freqHz) {
    var startBin = Math.ceil(freqHz / spec.binHz);
    var total = 0;
    var above = 0;
    for (var b = 0; b < spec.magnitudes.length; b++) {
      var e = spec.magnitudes[b] * spec.magnitudes[b];
      total += e;
      if (b >= startBin) above += e;
    }
    if (total <= 0) return 0;
    return above / total;
  }

  /* The highest frequency whose magnitude is within 60 dB of the
   * spectral peak. Returns { bandwidthHz, peakHz, peakMagnitude,
   * energyAbove12kHz } — bandwidthHz is 0 when the segment is silent.
   */
  function bandwidth(samples, sampleRate) {
    var spec = magnitudeSpectrum(samples, sampleRate);
    if (!spec) return { bandwidthHz: 0, peakHz: 0, peakMagnitude: 0, energyAbove12kHz: 0 };
    var peak = 0;
    var peakBin = 0;
    for (var b = 0; b < spec.magnitudes.length; b++) {
      if (spec.magnitudes[b] > peak) {
        peak = spec.magnitudes[b];
        peakBin = b;
      }
    }
    if (peak <= 0) return { bandwidthHz: 0, peakHz: 0, peakMagnitude: 0, energyAbove12kHz: 0 };
    var threshold = peak * Math.pow(10, -BANDWIDTH_DB_DOWN / 20); // 60 dB down
    var topBin = peakBin;
    for (var k = spec.magnitudes.length - 1; k >= 0; k--) {
      if (spec.magnitudes[k] >= threshold) { topBin = k; break; }
    }
    return {
      bandwidthHz: topBin * spec.binHz,
      peakHz: peakBin * spec.binHz,
      peakMagnitude: peak,
      energyAbove12kHz: spectrumEnergyFraction(spec, 12000)
    };
  }

  /* Fraction of total spectral energy above freqHz. 0 when the
   * segment is too short or silent.
   */
  function energyAbove(samples, sampleRate, freqHz) {
    var spec = magnitudeSpectrum(samples, sampleRate);
    if (!spec) return 0;
    return spectrumEnergyFraction(spec, freqHz);
  }

  function rmsDb(samples) {
    if (!samples || samples.length === 0) return -Infinity;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    var rms = Math.sqrt(sum / samples.length);
    if (rms <= 0) return -Infinity;
    return 20 * Math.log10(rms);
  }

  /* The Bluetooth HFP narrowband check: true when the take has real
   * content but virtually no energy above 7.5 kHz. Returns
   * { warn, fractionAbove7k5, rmsDb }.
   */
  function narrowbandWarning(samples, sampleRate) {
    var level = rmsDb(samples);
    var frac = energyAbove(samples, sampleRate, NARROWBAND_FREQ_HZ);
    return {
      warn: level > NARROWBAND_MIN_RMS_DB && frac < NARROWBAND_FRACTION,
      fractionAbove7k5: frac,
      rmsDb: level
    };
  }

  /* Clap-test summary from a set of measured click delays (ms).
   * Passes when the spread (max - min) is <= 10 ms (ESTIMATED).
   * Returns { medianMs, spreadMs, detected, pass }.
   */
  function clapOffsets(delaysMs) {
    var list = (delaysMs || []).slice().sort(function (a, b) { return a - b; });
    if (list.length === 0) {
      return { medianMs: null, spreadMs: null, detected: 0, pass: false };
    }
    var median = list[Math.floor(list.length / 2)];
    var spread = list[list.length - 1] - list[0];
    return {
      medianMs: median,
      spreadMs: spread,
      detected: list.length,
      pass: spread <= CLAP_SPREAD_PASS_MS
    };
  }

  /* One-call take analysis (used right after a take finishes):
   * bandwidth of the take, the 12 kHz energy share, and the
   * narrowband warning. The bandwidth of a sung take is a lower
   * bound on the route's ceiling (a vocal has less top end than a
   * held "sss"), so the take check only feeds the narrowband
   * warning; the lab's "sss" is the bandwidth authority.
   */
  function analyzeTake(samples, sampleRate) {
    var bw = bandwidth(samples, sampleRate);
    var nb = narrowbandWarning(samples, sampleRate);
    return {
      bandwidthHz: bw.bandwidthHz,
      energyAbove12kHz: bw.energyAbove12kHz,
      narrowbandWarn: nb.warn,
      fractionAbove7k5: nb.fractionAbove7k5,
      rmsDb: nb.rmsDb
    };
  }

  return {
    FFT_SIZE: FFT_SIZE,
    STUDIO_GRADE_HZ: STUDIO_GRADE_HZ,
    NARROWBAND_FREQ_HZ: NARROWBAND_FREQ_HZ,
    CLAP_SPREAD_PASS_MS: CLAP_SPREAD_PASS_MS,
    fft: fft,
    magnitudeSpectrum: magnitudeSpectrum,
    bandwidth: bandwidth,
    energyAbove: energyAbove,
    rmsDb: rmsDb,
    narrowbandWarning: narrowbandWarning,
    clapOffsets: clapOffsets,
    analyzeTake: analyzeTake
  };
});
