/* tune-worklet.js — the live vocal effects for the Phone Studio PWA.
 *
 * Port of the native app's Phase 2 live-tune prototype
 * (PitchDetector.swift + PitchShifter.swift + LiveTuneEngine.swift)
 * to the Web Audio render thread. The ALGORITHM is the port, not
 * the Swift code:
 *
 *   YIN pitch detection (on a 4x decimated copy) -> note-center
 *   correction model -> PSOLA shift
 *
 * THE 2A CORRECTION MODEL (roadmap-99-v2 §4, Claude's fix — the v1
 * "slew the target note" design erased vibrato BY CONSTRUCTION, so
 * it is gone): the sung pitch p is split into a slow note center c
 * (p low-passed at 80 ms) and fast expression (vibrato, slides).
 * Natural Tune corrects only the CENTER: Δ = S · LPF_τr[T(c) − c],
 * so the vibrato in p passes through untouched. Hard Tune corrects
 * the raw pitch: Δ = S · LPF_τr[T(c) − p], which flattens vibrato
 * on purpose — that IS the hard auto-tune sound. The CORRECTION is
 * smoothed in milliseconds (τr: Hard 2 ms, Natural 30 ms), never
 * the target note. Humanize (Natural only): after a note is held
 * 250 ms, τr × 3. A note change switches only 15 cents past the
 * midpoint between notes, held for 25 ms (roadmap §4 said 35 —
 * MEASURED wrong: a 460 Hz note snapped to A instead of Bb).
 * Breaths and S sounds
 * (aperiodicity > 0.2 or level < −50 dBFS) bypass the correction
 * with an 8 ms crossfade. All values ESTIMATED until the
 * measurement pass and Denasse's ear confirm them.
 *
 * THE FIVE STARTER PRESETS (Voloco's Starter pack, spec §2.2):
 *
 * - Hard Tune: the classic instant snap — the correction lands in
 *   ~2 ms, so the sung pitch jumps to the nearest note in the key
 *   EXACTLY, no sliding. That instant jump IS the hard auto-tune
 *   sound, and it flattens vibrato on purpose.
 * - Natural Tune: the SAME worklet, slower retune (30 ms) on the
 *   note center — the correction glides, and at least 80% of the
 *   vibrato survives (scorecard row 4). There is NO dead zone:
 *   the draft's 25-cent dead zone was invented and is removed.
 * - Super Vocoder: FFT (1024-pt) -> spectral envelope (smoothed
 *   magnitude) -> an IMPULSE-TRAIN carrier at the corrected pitch,
 *   built by additive synthesis (the impulse train's Fourier
 *   series — the carrier harmonics are exact multiples of the
 *   corrected F0, with amplitudes from the envelope). Three
 *   carrier modes: Unison (pitch-tracked), Monster (F0÷2 + unison
 *   blend — Voloco's classic pitched-down monster vocoder, the
 *   default), Chord (root + 5th + octave, locked to the song key).
 *   Unvoiced consonants pass through a high-pass bypass above
 *   ~4 kHz so the lyrics stay intelligible. The carrier is
 *   real-time (zero added latency) — the envelope comes from the
 *   latest input frame, no lookahead. (Why additive, not IFFT:
 *   quantizing harmonics to 46.9 Hz FFT bins destroys the
 *   harmonic series — MEASURED: YIN heard a 187 Hz difference
 *   tone and Goertzel found no carrier harmonics. Additive
 *   synthesis is the same DSP — envelope × impulse-train carrier
 *   — with exact frequencies.)
 * - Big Chorus: the tuned lead voice plus six more voices, all
 *   within ±7 semitones (Claude's voicing table): two detuned
 *   unisons (±12 cents, 18/27 ms delays), the 3rd and 5th above,
 *   the 3rd and 4th below — each with its own micro-delay and
 *   gain. Seven PSOLA shifters share one YIN detector, so all
 *   seven voices stay in time. NO octave-up voices: this PSOLA
 *   loses ~24 dB shifting a full octave up (MEASURED), so they
 *   would be nearly inaudible. On unvoiced frames the harmony
 *   voices drop 18 dB. LIVE MODE (the monitor branch): 4 voices
 *   only (lead + unison + 12c + 3rd + 5th) to save phone CPU;
 *   playback renders the full 7.
 * - Clean: no pitch correction. A high-pass filter takes out low
 *   rumble/hum and a soft gate pushes the room tone down between
 *   phrases. The voice itself passes through unchanged.
 *
 * STRENGTH (0-100): how far the correction goes, in pitch — not a
 * wet/dry mix. 100 = the full snap to the target note; 50 = halfway
 * there; 0 = no shift at all (the dry voice). On the vocoder it
 * moves the CARRIER between the sung pitch (0) and the snapped
 * note (100); on the chorus it moves every voice toward unison.
 * Clean ignores it (nothing to correct).
 *
 * SPEED (0-100, engine parameter — no UI slider yet): overrides
 * the retune time τr in ms. 100 = instant (0 ms), 0 = slowest
 * (50 ms). When not sent, the preset defaults apply (Hard 2 ms,
 * Natural 30 ms). The mapping is a starting point (ESTIMATED) —
 * no source gives the 0-100 mapping.
 *
 * The take stays DRY — this runs on the MONITOR (live, while
 * singing) and on take PLAYBACK (the recorded take is tuned as it
 * plays), never baked into the file. Outside 80-800 Hz, or with no
 * clear note (silence, breath, consonants), the voice passes
 * through unchanged (or, for the vocoder, goes quiet except for
 * the consonant bypass — the carrier has nothing to say). The lead
 * shift is clamped to ~4 semitones either way so a wrong detection
 * never throws the voice somewhere wild.
 *
 * This file is BOTH the AudioWorklet module (loaded with
 * ctx.audioWorklet.addModule('tune-worklet.js'), processor name
 * 'tune-processor') AND a Node-testable module (require it in a
 * test — the processor class is only defined where
 * AudioWorkletProcessor exists). Messages:
 *   main -> worklet: { type: 'key', key: 'D minor' }
 *                    { type: 'preset', preset: 'hard',
 *                      strength: 100, speed: 80,
 *                      vocoderMode: 'monster', live: false }
 *                    { type: 'strength', value: 100 }
 *                    { type: 'speed', value: 80 }
 *                    { type: 'vocoderMode', mode: 'monster' }
 *                    { type: 'live', on: true }
 *                    { type: 'enabled', on: true }
 *                    { type: 'reset' }
 */

// ---------------------------------------------------------------- FFT (1024-pt, radix-2)

// One FFT size for the whole file (the vocoder frame). Tables are
// built once, lazily, and shared — no allocation per frame.
var FFT_N = 1024;
var fftRev = null; // bit-reversal table
var fftCos = null; // twiddle cosines, fftCos[k] = cos(2πk/N)
var fftSin = null; // twiddle sines

function fftInit() {
  if (fftRev) return;
  fftRev = new Int32Array(FFT_N);
  var bits = 10; // log2(1024)
  for (var i = 0; i < FFT_N; i++) {
    var r = 0;
    for (var b = 0; b < bits; b++) {
      if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    }
    fftRev[i] = r;
  }
  fftCos = new Float32Array(FFT_N / 2);
  fftSin = new Float32Array(FFT_N / 2);
  for (var k = 0; k < FFT_N / 2; k++) {
    fftCos[k] = Math.cos(2 * Math.PI * k / FFT_N);
    fftSin[k] = Math.sin(2 * Math.PI * k / FFT_N);
  }
}

/* In-place FFT on re/im (Float32Array, length 1024). inverse=true
 * runs the inverse transform (and scales by 1/N).
 */
function fft1024(re, im, inverse) {
  fftInit();
  var n = FFT_N;
  // Bit-reversal permutation.
  for (var i = 0; i < n; i++) {
    var j = fftRev[i];
    if (j > i) {
      var tr = re[i]; re[i] = re[j]; re[j] = tr;
      var ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Butterfly stages.
  for (var len = 2; len <= n; len <<= 1) {
    var half = len >> 1;
    var step = n / len;
    for (var base = 0; base < n; base += len) {
      for (var k = 0; k < half; k++) {
        var wr = fftCos[k * step];
        var wi = inverse ? fftSin[k * step] : -fftSin[k * step];
        var a = base + k;
        var b = a + half;
        var br = re[b] * wr - im[b] * wi;
        var bi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - br;
        im[b] = im[a] - bi;
        re[a] += br;
        im[a] += bi;
      }
    }
  }
  if (inverse) {
    for (var s = 0; s < n; s++) { re[s] /= n; im[s] /= n; }
  }
}

// ---------------------------------------------------------------- YIN (decimated)

// YIN runs on a 4x decimated copy (12 kHz at a 48 kHz sample rate):
// 150-sample window, 150-sample max lag (80 Hz), threshold
// 0.10-0.15. A 512-sample window at 48 kHz cannot reach 80 Hz
// unless the buffer holds window plus lag (~23 ms) — the decimated
// form needs only 302 samples at 12 kHz (~25 ms of audio) and
// costs ~14x less than brute-force YIN at full rate.
function YinDetector(sampleRate, lowHz, highHz) {
  this.sampleRate = sampleRate;
  this.decim = 4;
  this.decRate = sampleRate / this.decim;
  this.maxLag = Math.ceil(this.decRate / (lowHz || 80)); // 150 at 12 kHz
  this.minLag = Math.max(2, Math.floor(this.decRate / (highHz || 800)));
  this.windowSize = 150;
  this.spanDec = this.windowSize + this.maxLag + 2; // decimated span
  this.spanSize = this.spanDec * this.decim; // full-rate span (~25 ms)
  this.threshold = 0.12;
  this.dec = new Float32Array(this.spanDec);
  this.diff = new Float32Array(this.maxLag + 2);
  this.cmnd = new Float32Array(this.maxLag + 2);
}

/* Looks at spanSize full-rate samples in x (oldest first).
 * Returns { frequency, confidence, aperiodicity } or null when
 * there is no clear note (silence, breath, a consonant like "s"
 * or "t"). aperiodicity is the YIN normalized difference at the
 * chosen lag: ~0 for a clean periodic tone, ~1 for noise — the
 * breath/S bypass reads it.
 */
YinDetector.prototype.detect = function (x) {
  var W = this.windowSize;
  var maxLag = this.maxLag;
  var diff = this.diff;
  var cmnd = this.cmnd;

  // Decimate by 4 with a 4-sample moving average (a cheap
  // anti-alias filter — its first null sits at the decimated
  // Nyquist). Stateless, so no startup transient.
  var dec = this.dec;
  for (var d = 0; d < this.spanDec; d++) {
    var base = d * 4;
    dec[d] = (x[base] + x[base + 1] + x[base + 2] + x[base + 3]) * 0.25;
  }

  // Silence gate: a very quiet slice has no note worth tuning.
  var energy0 = 0;
  for (var j = 0; j < W; j++) energy0 += dec[j] * dec[j];
  if (energy0 / W < 1e-7) return null;

  // d(lag) = sum over the window of (x[j] - x[j+lag])^2
  //        = e0 + e(lag) - 2 * r(lag)
  // where r is the dot product of the slice with its slid copy
  // and e(lag) is the energy of the slid copy. e(lag) slides one
  // sample at a time, so it costs two multiplies per lag.
  var eLag = energy0; // energy of dec[lag ..< lag+W], lag = 0
  diff[0] = 0;
  for (var lag = 1; lag <= maxLag; lag++) {
    var outgoing = dec[lag - 1];
    var incoming = dec[lag - 1 + W];
    eLag += incoming * incoming - outgoing * outgoing;
    if (eLag < 0) eLag = 0;
    var r = 0;
    for (var k = 0; k < W; k++) r += dec[k] * dec[k + lag];
    var dd = energy0 + eLag - 2 * r;
    diff[lag] = dd > 0 ? dd : 0;
  }

  // Cumulative-mean normalisation:
  // d'(lag) = d(lag) * lag / (d(1) + ... + d(lag))
  cmnd[0] = 1;
  var running = 0;
  for (lag = 1; lag <= maxLag; lag++) {
    running += diff[lag];
    cmnd[lag] = running > 0 ? diff[lag] * lag / running : 1;
  }

  // First dip under the threshold (then follow it down to its
  // bottom). Picking the FIRST dip avoids octave-down errors.
  var best = -1;
  lag = this.minLag;
  while (lag < maxLag) {
    if (cmnd[lag] < this.threshold) {
      while (lag + 1 < maxLag && cmnd[lag + 1] < cmnd[lag]) lag += 1;
      best = lag;
      break;
    }
    lag += 1;
  }
  if (best < 0) return null;

  // Parabolic interpolation around the dip — sub-sample period.
  var period = best;
  if (best > 1 && best < maxLag) {
    var a = cmnd[best - 1], b = cmnd[best], c = cmnd[best + 1];
    var denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-9) {
      var shift = 0.5 * (a - c) / denom;
      if (shift > -1 && shift < 1) period += shift;
    }
  }
  if (period < this.minLag) return null;
  return {
    frequency: this.decRate / period,
    confidence: Math.max(0, Math.min(1, 1 - cmnd[best])),
    aperiodicity: Math.max(0, Math.min(1, cmnd[best]))
  };
};

// ---------------------------------------------------------------- PSOLA

function PsolaShifter(sampleRate) {
  this.sampleRate = sampleRate;
  // Longest grain half-width: 4 ms. Latency = 2 x half-width = 8 ms.
  this.maxHalfWidth = Math.max(8, Math.round(sampleRate * 0.004));
  this.latencySamples = 2 * this.maxHalfWidth;
  this.windowLength = 2 * this.maxHalfWidth;
  this.ringSize = 8192;
  this.ringMask = this.ringSize - 1;
  this.inRing = new Float32Array(this.ringSize);
  this.outRing = new Float32Array(this.ringSize);
  // A 1 kHz low-passed copy of the input, for pitch-mark picking
  // only (Claude): marks go on the strongest NEGATIVE peak of the
  // low-passed wave, so every grain is cut at the same point in
  // its period. The grain itself is still cut from the original.
  this.lpRing = new Float32Array(this.ringSize);
  this.lpState = 0;
  this.lpK = 1 - Math.exp(-2 * Math.PI * 1000 / sampleRate);
  this.window = new Float32Array(this.windowLength);
  for (var k = 0; k < this.windowLength; k++) {
    this.window[k] = 0.5 * (1 - Math.cos(2 * Math.PI * (k + 0.5) / this.windowLength));
  }
  this.inCount = 0;
  this.outCount = 0;
  this.period = this.maxHalfWidth;
  this.ratio = 1;
  this.nextMark = 0;
  this.lastAnalysisMark = 0;
}

/* Clears all history (used when the tune is switched on, so old
 * audio never leaks into the new stream).
 */
PsolaShifter.prototype.reset = function () {
  this.inRing.fill(0);
  this.outRing.fill(0);
  this.lpRing.fill(0);
  this.lpState = 0;
  this.inCount = 0;
  this.outCount = 0;
  this.nextMark = this.latencySamples;
  this.lastAnalysisMark = 0;
  this.ratio = 1;
  this.period = this.maxHalfWidth;
};

/* New instruction from the pitch stage: the voice's period in
 * samples and the pitch ratio to apply (target Hz / sung Hz).
 * Pass period 0 for "no note" — the voice then passes through
 * unchanged (just delayed by the fixed latency).
 */
PsolaShifter.prototype.setTarget = function (periodSamples, ratio) {
  if (periodSamples > 0) {
    this.period = periodSamples;
    this.ratio = ratio;
  } else {
    this.period = this.maxHalfWidth;
    this.ratio = 1;
  }
};

/* Shifts `count` samples from inBuf to outBuf (they may be the same
 * array — each input sample is stored before the output sample is
 * written).
 */
PsolaShifter.prototype.process = function (inBuf, outBuf, count) {
  var mask = this.ringMask;
  for (var i = 0; i < count; i++) {
    this.inRing[this.inCount & mask] = inBuf[i];
    this.lpState += (inBuf[i] - this.lpState) * this.lpK;
    this.lpRing[this.inCount & mask] = this.lpState;
    this.inCount += 1;

    // Lay down every grain whose left edge has reached the output
    // position.
    var halfWidth = Math.min(Math.round(this.period), this.maxHalfWidth);
    while (this.nextMark - halfWidth <= this.outCount) {
      this.addGrain(Math.round(this.nextMark), halfWidth);
      this.nextMark += this.period / this.ratio;
    }

    var slot = this.outCount & mask;
    outBuf[i] = this.outRing[slot];
    this.outRing[slot] = 0;
    this.outCount += 1;
  }
};

/* Cuts one grain from the input (centred on a pitch mark) and
 * overlap-adds it into the output around centreOut.
 */
PsolaShifter.prototype.addGrain = function (centreOut, halfWidth) {
  var wanted = centreOut - this.latencySamples; // input time to look at
  var mark = this.pickAnalysisMark(wanted);
  var gainScale = Math.max(0.5, Math.min(2.0, (this.period / this.ratio) / Math.max(halfWidth, 1)));
  var length = 2 * halfWidth;
  var outStart = centreOut - halfWidth;
  var inStart = mark - halfWidth;
  var mask = this.ringMask;
  for (var k = 0; k < length; k++) {
    var outIndex = outStart + k;
    if (outIndex < this.outCount) continue; // already played
    var inIndex = inStart + k;
    if (inIndex < 0 || inIndex >= this.inCount) continue;
    var w = this.window[Math.floor(k * this.windowLength / length)];
    this.outRing[outIndex & mask] += this.inRing[inIndex & mask] * w * gainScale;
  }
};

/* Walks the chain of analysis marks (one per period) forward until
 * it is closest to `wanted`, and returns the closest mark. Each
 * mark is placed at the strongest NEGATIVE peak of the 1 kHz
 * low-passed wave within a quarter period of where the previous
 * mark predicts, so every grain is cut at the same spot in its
 * period.
 */
PsolaShifter.prototype.pickAnalysisMark = function (wanted) {
  var p = Math.max(2, Math.round(this.period));
  // Fell far behind (first grain, or a long silence): restart.
  if (wanted - this.lastAnalysisMark > 4 * p || this.lastAnalysisMark > wanted + 4 * p) {
    this.lastAnalysisMark = wanted;
  }
  var search = Math.max(1, Math.floor(p / 4));
  var mask = this.ringMask;
  for (;;) {
    var predicted = this.lastAnalysisMark + p;
    if (predicted > wanted + Math.floor(p / 2)) break;
    if (predicted + search >= this.inCount) break; // not sung yet
    if (predicted - search < 0 || this.inCount - (predicted - search) >= this.ringSize) break;
    var bestIndex = predicted;
    var bestValue = this.lpRing[predicted & mask];
    for (var j = predicted - search; j <= predicted + search; j++) {
      var v = this.lpRing[j & mask];
      if (v < bestValue) { bestValue = v; bestIndex = j; }
    }
    this.lastAnalysisMark = bestIndex;
  }
  return this.lastAnalysisMark;
};

// ---------------------------------------------------------------- key + scale

/* The five starter presets (Voloco's Starter pack). */
var PRESETS = ['hard', 'natural', 'vocoder', 'chorus', 'clean'];

/* Super Vocoder carrier modes (Gemini's multi-mode design). */
var VOCODER_MODES = ['unison', 'monster', 'chord'];

var TONIC_SEMITONES = {
  C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11
};

/* Scale interval sets (semitones from the tonic). Major/minor are
 * what the key picker offers today; the rest are DSP-ready for a
 * later step — the worklet already understands them.
 */
var SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'pentatonic major': [0, 2, 4, 7, 9],
  'pentatonic minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

/* 'D minor' -> { tonic: 2, scale: 'minor' }. Any tonic (all 12)
 * with any scale above. Anything unparseable falls back to D
 * minor (the app default).
 */
function parseKeyName(keyName) {
  var m = /^\s*([A-G](?:#|b)?)\s+(.+?)\s*$/i.exec(keyName || '');
  if (!m) return { tonic: 2, scale: 'minor' };
  var tonicName = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  var tonic = TONIC_SEMITONES[tonicName];
  var scale = m[2].toLowerCase();
  if (tonic === undefined || !SCALE_STEPS[scale]) return { tonic: 2, scale: 'minor' };
  return { tonic: tonic, scale: scale };
}

function scaleMaskForKey(keyName) {
  var parsed = parseKeyName(keyName);
  var steps = SCALE_STEPS[parsed.scale];
  var mask = 0;
  for (var i = 0; i < steps.length; i++) {
    mask |= 1 << ((parsed.tonic + steps[i]) % 12);
  }
  return mask;
}

function isInScale(note, mask) {
  var pc = ((note % 12) + 12) % 12;
  return (mask & (1 << pc)) !== 0;
}

function hzForMidi(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function midiForHz(hz) {
  return 69 + 12 * (Math.log(hz / 440) / Math.LN2);
}

/* The nearest note in the key to a sung pitch (MIDI float). Pure —
 * the note-change rule (midpoint + 15 cents, held 25 ms) lives in
 * the tracker, not here.
 */
function nearestInScaleNote(midi, scaleMask) {
  var centre = Math.round(midi);
  var bestNote = centre;
  var bestDistance = Infinity;
  for (var note = centre - 6; note <= centre + 6; note++) {
    if (!isInScale(note, scaleMask)) continue;
    var distance = Math.abs(midi - note);
    if (distance < bestDistance) { bestDistance = distance; bestNote = note; }
  }
  return bestNote;
}

/* HARD snap (kept for compatibility): the nearest in-scale note,
 * with the old 0.62-semitone hysteresis. The live tracker uses the
 * midpoint rule instead — this is only for callers that need a
 * one-shot snap.
 */
function snapNote(hz, scaleMask, previous) {
  var midi = midiForHz(hz);
  if (previous !== null && previous !== undefined &&
      isInScale(previous, scaleMask) &&
      Math.abs(midi - previous) < 0.62) {
    return previous;
  }
  return nearestInScaleNote(midi, scaleMask);
}

/* Walk `steps` scale degrees from `note` in the key (positive =
 * up, negative = down). Used for the chorus harmony notes.
 */
function scaleStep(note, steps, scaleMask) {
  var n = note;
  var dir = steps >= 0 ? 1 : -1;
  var left = Math.abs(steps);
  while (left > 0) {
    n += dir;
    if (isInScale(n, scaleMask)) left -= 1;
  }
  return n;
}

/* The Big Chorus harmony notes, counted in the key from the snapped
 * note: the 3rd and 5th above, the 3rd and 4th below. All within
 * ±7 semitones — no octave voices (this PSOLA loses ~24 dB
 * shifting a full octave up). Returns [thirdAbove, fifthAbove,
 * thirdBelow, fourthBelow] as MIDI.
 */
function harmonyNotes(note, scaleMask) {
  return [
    scaleStep(note, 2, scaleMask),
    scaleStep(note, 4, scaleMask),
    scaleStep(note, -2, scaleMask),
    scaleStep(note, -3, scaleMask)
  ];
}

// ---------------------------------------------------------------- Big Chorus voicing

/* Claude's voicing table (ESTIMATED), all intervals diatonic in
 * the chosen key. delayMs is the micro-delay spread (thickness);
 * gainDb is relative to the lead at 0 dB. Pan is recorded for the
 * future stereo step — the worklet output is mono today, so pan
 * has no effect on the mix.
 *
 * Voice: 0 = lead, 1-2 = detuned unisons, 3 = 3rd above,
 * 4 = 5th above, 5 = 3rd below, 6 = 4th below.
 */
var CHORUS_VOICES = [
  { kind: 'lead',   cents: 0,   delayMs: 0,  pan: 0,     gainDb: 0 },
  { kind: 'unison', cents: 12,  delayMs: 18, pan: -0.60, gainDb: -6 },
  { kind: 'unison', cents: -12, delayMs: 27, pan: 0.60,  gainDb: -6 },
  { kind: 'third',  cents: 0,   delayMs: 9,  pan: -0.35, gainDb: -9 },
  { kind: 'fifth',  cents: 0,   delayMs: 13, pan: 0.35,  gainDb: -10 },
  { kind: 'thirdDn',cents: 0,   delayMs: 11, pan: -0.80, gainDb: -11 },
  { kind: 'fourthDn',cents: 0,  delayMs: 15, pan: 0.80,  gainDb: -12 }
];
/* Live mode (the monitor branch): 4 voices only, to save phone
 * CPU — lead + unison +12c + 3rd + 5th. Playback renders all 7.
 */
var CHORUS_LIVE_VOICES = [0, 1, 3, 4];
/* Master gain for the chorus mix: the seven voices sum to ~1.37x
 * the input in power, so 0.7 keeps the mix in range (ESTIMATED,
 * tune by ear).
 */
var CHORUS_MASTER_GAIN = 0.7;
/* Unvoiced frames: harmony voices 2-7 drop 18 dB (ESTIMATED). */
var CHORUS_UNVOICED_DB = -18;

// ---------------------------------------------------------------- the DSP

/* Everything the effects do to the audio. After construction it
 * allocates nothing — safe on the audio render thread.
 *
 * All five presets share one YIN detector (the expensive part runs
 * once). Hard/Natural/Chorus shift with PSOLA; the vocoder
 * resynthesises with an FFT frame; Clean filters and gates.
 */
function TuneDSP(sampleRate) {
  this.sampleRate = sampleRate;
  this.detector = new YinDetector(sampleRate, 80, 800);
  this.shifter = new PsolaShifter(sampleRate); // lead voice
  // Big Chorus: six more shifters (voices 2-7) + one scratch
  // buffer per voice (lead included) + a micro-delay line per
  // harmony voice. A chunk is never longer than one hop, so
  // hop-sized buffers are enough.
  this.chorusShifters = [];
  this.chorusDelays = []; // { ring, mask, pos, delay } per voice 2-7
  for (var v = 0; v < 6; v++) {
    this.chorusShifters.push(new PsolaShifter(sampleRate));
    var d = CHORUS_VOICES[v + 1];
    this.chorusDelays.push({
      ring: new Float32Array(2048),
      mask: 2047,
      pos: 0,
      delay: Math.round(d.delayMs * sampleRate / 1000)
    });
  }
  // Fixed hop (256 samples): the detection cadence AND the vocoder
  // frame hop, so the FFT overlap-add stays aligned with the
  // chunking. 5.33 ms at 48 kHz, 5.8 ms at 44.1 kHz.
  this.hop = 256;
  var scratchLen = this.hop + 1;
  this.voiceBufs = [];
  for (var b = 0; b < 7; b++) this.voiceBufs.push(new Float32Array(scratchLen));
  this.history = new Float32Array(this.detector.spanSize);
  this.scaleMask = scaleMaskForKey('D minor');
  this.enabled = false;
  this.preset = 'hard';
  this.strength = 1; // 0..1 (from the 0-100 slider)
  this.speedOverride = null; // null = preset default retune time
  // B1 (v13.1) — output safety: the gain the finished block leaves
  // through. reset() drops it to 0 and it slews back to 1 over
  // ~10 ms, so a preset/vocoder switch or an enable never clicks;
  // applyOutputSafety() also soft-limits peaks above 0.9, so the
  // output can never exceed full scale (the v10 switch transient
  // peaked at 1.47 and clipped the DAC).
  this.outRamp = 1;
  // --- offline re-tune (Step 3 / retune.js) ---
  this.offline = false; // true = re-tuning a finished take, not live
  this.externalPitchHz = null; // null = detect with YIN; a number = use this pitch
  this.pitchTrack = null; // array or null; when set, one Hz (or null) per hop is recorded
  this.vocoderMode = 'monster'; // 'unison' | 'monster' | 'chord'
  this.liveMode = false; // chorus: 4 voices live, 7 on playback
  this.filled = 0;
  this.sinceLastDetect = 0;
  this.wasEnabled = false;
  // --- the pitch tracker (the 2A correction model) ---
  this.center = null; // note center, MIDI float (null = no note yet)
  this.targetNote = null; // current target note, MIDI int
  this.pendingNote = null; // note-change hold state
  this.pendingHops = 0;
  this.noteHoldHops = 0; // hops since the target changed (Humanize)
  this.correction = 0; // smoothed correction, semitones (the LPF_τr state)
  this.bypass = 1; // 1 = fully bypassed (unvoiced), 0 = fully correcting
  this.lastP = null; // last accepted sung pitch, MIDI float
  this.pHist = [null, null, null]; // median-of-3 (2-frame hysteresis)
  this.jumpPending = null; // >7-semitone jump gate state
  this.jumpHops = 0;
  this.hopRms = 0; // RMS of the current hop (the −50 dBFS gate)
  this.aperiodicity = 1;
  // --- Super Vocoder (FFT envelope + additive carrier) ---
  this.vocInRing = new Float32Array(2048); // input ring (2 frames)
  this.vocInCount = 0;
  this.vocSinceFrame = 0; // input samples since the last frame
  this.vocFrame = new Float32Array(FFT_N); // windowed input frame
  this.vocRe = new Float32Array(FFT_N);
  this.vocIm = new Float32Array(FFT_N);
  this.vocMag = new Float32Array(FFT_N / 2 + 1); // per-bin magnitude
  this.vocEnv = new Float32Array(FFT_N / 2 + 1); // smoothed magnitude
  this.vocWindow = new Float32Array(FFT_N); // Hann window
  for (var k = 0; k < FFT_N; k++) {
    this.vocWindow[k] = 0.5 * (1 - Math.cos(2 * Math.PI * k / FFT_N));
  }
  this.vocCarrierHz = 0; // 0 = no note heard yet
  // The carrier oscillators: a fixed pool of 48, each a sine at
  // one harmonic of the carrier F0. Amplitudes interpolate toward
  // per-frame targets (from the envelope); phases run
  // continuously, so a frequency change is a smooth glide, never
  // a click. Oscillators at (near) zero amplitude are skipped.
  this.vocOscCount = 48;
  this.vocOscFreq = new Float32Array(48);
  this.vocOscPhase = new Float32Array(48);
  this.vocOscAmp = new Float32Array(48);
  this.vocOscTarget = new Float32Array(48);
  // Scratch for the per-frame harmonic list (freq + amplitude),
  // built from the carrier series and the envelope.
  this.vocHarmFreq = new Float32Array(128);
  this.vocHarmAmp = new Float32Array(128);
  this.vocHarmCount = 0;
  // HF consonant bypass: a 4 kHz high-pass, mixed in real time
  // (the carrier has no latency, so the bypass needs no delay).
  var wHp = 2 * Math.PI * 4000 / sampleRate;
  var cosHp = Math.cos(wHp);
  var alphaHp = Math.sin(wHp) / (2 * 0.7071);
  var a0Hp = 1 + alphaHp;
  this.vocHp = {
    b0: ((1 + cosHp) / 2) / a0Hp,
    b1: (-(1 + cosHp)) / a0Hp,
    b2: ((1 + cosHp) / 2) / a0Hp,
    a1: (-2 * cosHp) / a0Hp,
    a2: (1 - alphaHp) / a0Hp,
    x1: 0, x2: 0, y1: 0, y2: 0
  };
  // Clean: biquad high-pass at 120 Hz + soft downward expander.
  var w0 = 2 * Math.PI * 120 / sampleRate;
  var cosW0 = Math.cos(w0);
  var alpha = Math.sin(w0) / (2 * 0.7071);
  var a0 = 1 + alpha;
  this.hpf = {
    b0: ((1 + cosW0) / 2) / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: ((1 + cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
    x1: 0, x2: 0, y1: 0, y2: 0
  };
  this.gateLevel = 0;
  this.gateGain = 1;
}

TuneDSP.prototype.setKey = function (keyName) {
  this.scaleMask = scaleMaskForKey(keyName);
  this.currentKeyName = keyName; // the vocoder's Chord mode reads the tonic
};

TuneDSP.prototype.setEnabled = function (on) {
  this.enabled = !!on;
};

TuneDSP.prototype.setPreset = function (name) {
  if (PRESETS.indexOf(name) === -1) return;
  if (this.preset !== name) {
    this.preset = name;
    // A new preset starts from a clean slate — no stale grains,
    // no held carrier, no gate state from the old sound.
    this.reset();
  }
};

TuneDSP.prototype.setStrength = function (percent) {
  var p = Math.max(0, Math.min(100, percent || 0));
  this.strength = p / 100;
};

/* Speed 0-100 overrides the retune time τr (100 = instant, 0 =
 * 50 ms). Pass null/undefined to go back to the preset defaults.
 */
TuneDSP.prototype.setSpeed = function (value) {
  if (value === null || value === undefined || isNaN(value)) {
    this.speedOverride = null;
  } else {
    this.speedOverride = Math.max(0, Math.min(100, value));
  }
};

TuneDSP.prototype.setVocoderMode = function (mode) {
  if (VOCODER_MODES.indexOf(mode) === -1) return;
  if (this.vocoderMode !== mode) {
    this.vocoderMode = mode;
    this.reset();
  }
};

TuneDSP.prototype.setLiveMode = function (on) {
  this.liveMode = !!on;
};

/* Offline re-tune (Step 3): retune.js drives the DSP over a
 * finished take, hop by hop, instead of live audio. Offline the
 * chorus gets all 7 voices (the live path caps it at 4 so the
 * phone keeps up while singing).
 */
TuneDSP.prototype.setOffline = function (on) {
  this.offline = !!on;
  if (this.offline) this.liveMode = false;
};

/* The pitch to correct from, in Hz — the smoothed pitch track
 * from the analysis pass. Pass null to go back to live YIN
 * detection. The track may carry nulls (breaths, pauses); a null
 * hop is unvoiced, same as no detection.
 */
TuneDSP.prototype.setExternalPitchHz = function (hz) {
  this.externalPitchHz = (hz === null || hz === undefined || isNaN(hz) || hz <= 0) ? null : hz;
};

/* Record one pitch reading per hop (Hz, or null when unvoiced)
 * until stopPitchTrack() hands the track back. Used by the
 * analysis pass — the track is the raw material the smoothing
 * and the key check work from.
 */
TuneDSP.prototype.startPitchTrack = function () {
  this.pitchTrack = [];
};

TuneDSP.prototype.stopPitchTrack = function () {
  var track = this.pitchTrack;
  this.pitchTrack = null;
  return track || [];
};

/* The retune time in ms for the current preset: the speed
 * override wins when set, else Hard 2 ms / Natural 30 ms.
 * Humanize (Natural only): after the note is held 250 ms, τr × 3.
 */
TuneDSP.prototype.retuneTimeMs = function () {
  var tau;
  if (this.speedOverride !== null) {
    tau = 50 * (1 - this.speedOverride / 100);
  } else {
    tau = this.preset === 'natural' ? 30 : 2;
  }
  if (this.preset === 'natural' &&
      this.noteHoldHops * this.hop / this.sampleRate >= 0.25) {
    tau *= 3;
  }
  return Math.max(0.5, tau);
};

TuneDSP.prototype.reset = function () {
  this.shifter.reset();
  for (var v = 0; v < 6; v++) {
    this.chorusShifters[v].reset();
    this.chorusDelays[v].ring.fill(0);
    this.chorusDelays[v].pos = 0;
  }
  this.history.fill(0);
  // B1 (v13.1): the output fades back in over ~10 ms after any
  // reset (preset switch, vocoder-mode switch, enable) — the
  // discontinuity that clicked on a switch is gone.
  this.outRamp = 0;
  this.sinceLastDetect = 0;
  this.filled = 0;
  this.wasEnabled = false;
  this.center = null;
  this.targetNote = null;
  this.pendingNote = null;
  this.pendingHops = 0;
  this.noteHoldHops = 0;
  this.correction = 0;
  this.bypass = 1;
  this.lastP = null;
  this.pHist[0] = null; this.pHist[1] = null; this.pHist[2] = null;
  this.jumpPending = null;
  this.jumpHops = 0;
  this.hopRms = 0;
  this.aperiodicity = 1;
  this.vocInRing.fill(0);
  this.vocInCount = 0;
  this.vocSinceFrame = 0;
  this.vocCarrierHz = 0;
  this.vocOscFreq.fill(0);
  this.vocOscPhase.fill(0);
  this.vocOscAmp.fill(0);
  this.vocOscTarget.fill(0);
  this.vocHarmCount = 0;
  this.vocHp.x1 = 0; this.vocHp.x2 = 0; this.vocHp.y1 = 0; this.vocHp.y2 = 0;
  this.hpf.x1 = 0; this.hpf.x2 = 0; this.hpf.y1 = 0; this.hpf.y2 = 0;
  this.gateLevel = 0;
  this.gateGain = 1;
};

/* Tunes `count` samples in place in `samples` (a Float32Array).
 * When disabled, the samples pass through untouched.
 */
TuneDSP.prototype.process = function (samples, count) {
  if (!this.enabled) {
    this.wasEnabled = false;
    return;
  }
  if (!this.wasEnabled) {
    // Just switched on: start from a clean slate.
    this.reset();
    this.wasEnabled = true;
  }

  // Clean needs no pitch detection at all — filter + gate the whole
  // block in one pass.
  if (this.preset === 'clean') {
    this.processClean(samples, count);
  } else {
    var offset = 0;
    while (offset < count) {
      var chunk = Math.min(count - offset, this.hop - this.sinceLastDetect);
      var part = samples.subarray(offset, offset + chunk);
      // The detector listens to the CLEAN input — copy it into the
      // history before the effect rewrites the buffer. The hop RMS
      // (the −50 dBFS breath gate) is measured on the clean chunk.
      var sumSq = 0;
      for (var m = 0; m < chunk; m++) sumSq += part[m] * part[m];
      this.hopRms = Math.sqrt(sumSq / Math.max(1, chunk));
      this.appendHistory(part, chunk);
      if (this.preset === 'vocoder') {
        this.processVocoder(part, chunk);
      } else if (this.preset === 'chorus') {
        this.processChorus(part, chunk);
      } else {
        this.shifter.process(part, part, chunk); // hard / natural
      }
      this.sinceLastDetect += chunk;
      offset += chunk;
      if (this.sinceLastDetect >= this.hop) {
        this.sinceLastDetect = 0;
        this.updateTarget();
      }
    }
  }
  // B1 (v13.1): every path leaves through the output safety — the
  // fade-in after a reset plus the soft limiter. Nothing in the
  // worklet writes past this point.
  this.applyOutputSafety(samples, count);
};

/* B1 (v13.1) — output safety, the last thing a block passes
 * through. Two jobs: (1) the fade-in — after any reset() the gain
 * slews 0 -> 1 over ~10 ms, so a preset switch never clicks;
 * (2) the soft limiter — below 0.9 the signal is untouched (the
 * approved preset sounds do not change); above 0.9 it bends
 * smoothly toward 1.0 and never exceeds it, so a switch transient
 * (v10 measured 1.47) can never clip the DAC. Transparent for
 * normal material: test tones peak at ~1.05 only at their summed
 * harmonics, and the loudest real vocal peaks sit well under 0.9.
 */
TuneDSP.prototype.applyOutputSafety = function (samples, count) {
  var rampStep = 1 / (0.010 * this.sampleRate); // 10 ms fade-in
  for (var i = 0; i < count; i++) {
    if (this.outRamp < 1) {
      this.outRamp = Math.min(1, this.outRamp + rampStep);
    }
    var x = samples[i] * this.outRamp;
    var ax = x < 0 ? -x : x;
    if (ax > 0.9) {
      // Piecewise soft clip: y = 0.9 + 0.1 * tanh((|x| - 0.9) / 0.1),
      // which approaches 1.0 from below and never reaches it.
      x = (x < 0 ? -1 : 1) * (0.9 + 0.1 * Math.tanh((ax - 0.9) / 0.1));
    }
    samples[i] = x;
  }
};

TuneDSP.prototype.appendHistory = function (samples, count) {
  var span = this.detector.spanSize;
  if (count >= span) {
    this.history.set(samples.subarray(count - span));
  } else {
    this.history.copyWithin(0, count);
    this.history.set(samples, span - count);
  }
  this.filled = Math.min(span, this.filled + count);
};

/* Median of the (up to) 3 pitch readings, ignoring nulls — the
 * 2-frame confidence hysteresis: a single bad hop never moves the
 * tune.
 */
function median3(a, b, c) {
  var vals = [];
  if (a !== null) vals.push(a);
  if (b !== null) vals.push(b);
  if (c !== null) vals.push(c);
  if (vals.length === 0) return null;
  if (vals.length === 1) return vals[0];
  if (vals.length === 2) return (vals[0] + vals[1]) / 2;
  vals.sort(function (x, y) { return x - y; });
  return vals[1];
}

/* Runs the detector on the latest history and steers the effect:
 * the PSOLA ratio(s) for the tune presets, the carrier pitch for
 * the vocoder. This is the 2A correction model — see the header.
 */
TuneDSP.prototype.updateTarget = function () {
  var levelDb = 20 * Math.log10(this.hopRms + 1e-12);
  var found = null;
  if (this.externalPitchHz !== null) {
    // Offline re-tune: the pitch comes from the smoothed track,
    // not the live detector — the correction can look ahead at
    // notes the singer has already finished.
    found = { frequency: this.externalPitchHz, confidence: 1, aperiodicity: 0 };
  } else if (this.filled >= this.detector.spanSize) {
    found = this.detector.detect(this.history);
  }
  this.aperiodicity = found ? found.aperiodicity : 1;
  // Record the raw pitch reading for the analysis pass.
  if (this.pitchTrack !== null) {
    this.pitchTrack.push(found ? found.frequency : null);
  }

  // Breaths and S sounds bypass the correction with an 8 ms
  // crossfade: aperiodic (> 0.2), too quiet (< −50 dBFS), or no
  // detection at all.
  var bypassTarget = (!found || this.aperiodicity > 0.2 || levelDb < -50) ? 1 : 0;
  var bk = 1 - Math.exp(-(this.hop / this.sampleRate) / 0.008);
  this.bypass += (bypassTarget - this.bypass) * bk;

  // Accept a pitch reading: median-of-3, then the >7-semitone
  // jump gate (an octave jump needs 30 ms of consistent readings
  // unless the detector is very confident — octave errors are the
  // worst failure, worse than a late note change).
  var p = null;
  if (found && found.confidence > 0.6) {
    var rawP = midiForHz(found.frequency);
    this.pHist[0] = this.pHist[1];
    this.pHist[1] = this.pHist[2];
    this.pHist[2] = rawP;
    var med = median3(this.pHist[0], this.pHist[1], this.pHist[2]);
    if (this.lastP !== null && Math.abs(med - this.lastP) > 7) {
      if (found.confidence >= 0.85) {
        p = med;
        this.jumpPending = null;
        this.jumpHops = 0;
      } else if (this.jumpPending !== null && Math.abs(med - this.jumpPending) < 0.5) {
        this.jumpHops += 1;
        if (this.jumpHops >= 6) { // ~32 ms at 5.33 ms/hop
          p = med;
          this.jumpPending = null;
          this.jumpHops = 0;
        }
        // else: hold — p stays null this hop.
      } else {
        this.jumpPending = med;
        this.jumpHops = 1;
      }
    } else {
      p = med;
      this.jumpPending = null;
      this.jumpHops = 0;
    }
  }

  if (p !== null) {
    this.lastP = p;
    // Note center: snap to the note on the first voiced hop, then
    // a one-pole low-pass at 80 ms (top of the 60-80 ms range —
    // the center must be slow enough that the 5.5 Hz vibrato does
    // not leak into it; see the vibrato-survival test).
    if (this.center === null) {
      this.center = p;
    } else {
      var ck = 1 - Math.exp(-(this.hop / this.sampleRate) / 0.080);
      this.center += (p - this.center) * ck;
    }
    // Target note: switch only 15 cents past the midpoint between
    // the current target and the candidate, held for 25 ms.
    // (DEVIATION from roadmap §4's 35 cents, MEASURED: 35 cents
    // makes a 70-cent dead band around each midpoint, and a
    // sustained 460 Hz note — 23 cents from Bb, 78 from A — snapped
    // to A and stayed there. The candidate already comes from the
    // 80 ms note center, so the vibrato is smoothed out before
    // this rule ever sees it; 15 cents + the 25 ms hold is the
    // anti-flip-flop protection, and notes clearly past the
    // midpoint switch correctly.)
    var cand = nearestInScaleNote(this.center, this.scaleMask);
    if (this.targetNote === null) {
      this.targetNote = cand;
      this.noteHoldHops = 0;
    } else if (cand !== this.targetNote) {
      var mid = (this.targetNote + cand) / 2;
      var past = cand > this.targetNote
        ? (this.center >= mid + 0.15)
        : (this.center <= mid - 0.15);
      if (past) {
        if (this.pendingNote === cand) this.pendingHops += 1;
        else { this.pendingNote = cand; this.pendingHops = 1; }
        if (this.pendingHops >= 5) { // 25 ms at 5.33 ms/hop
          this.targetNote = cand;
          this.pendingNote = null;
          this.pendingHops = 0;
          this.noteHoldHops = 0;
        }
      } else {
        this.pendingNote = null;
        this.pendingHops = 0;
      }
    } else {
      this.pendingNote = null;
      this.pendingHops = 0;
    }
    this.noteHoldHops += 1;

    // The correction: Natural corrects the CENTER (keeps the
    // vibrato), Hard corrects the raw pitch (flattens it). The
    // correction itself is smoothed with the retune time τr.
    var tauR = this.retuneTimeMs();
    var err = this.preset === 'natural'
      ? (this.targetNote - this.center)
      : (this.targetNote - p);
    var targetCorr = err * this.strength;
    var rk = 1 - Math.exp(-(this.hop / this.sampleRate) / (tauR / 1000));
    this.correction += (targetCorr - this.correction) * rk;
  }
  // No accepted pitch: the correction holds, and the bypass (now
  // fading toward 1) fades the EFFECTIVE correction to 0 — the
  // voice glides back to dry instead of snapping.

  var effCorr = this.correction * (1 - this.bypass);
  // A voiced note is one the bypass is letting through; anything
  // else gets the neutral PSOLA period (clean pass-through —
  // a stale period would modulate breaths and consonants).
  var voiced = this.bypass < 0.5 && this.lastP !== null;
  var period = voiced ? this.sampleRate / hzForMidi(this.lastP) : 0;

  if (this.preset === 'vocoder') {
    // The carrier follows the corrected pitch — scaled by strength
    // toward the sung pitch (at 0% it tracks the voice exactly).
    // The bypass fades the carrier itself to silence on unvoiced
    // frames (processVocoder), so the carrier pitch can stay put.
    this.vocCarrierHz = this.lastP !== null
      ? hzForMidi(this.lastP + effCorr) : 0;
    return;
  }

  // Lead voice target (hard / natural / chorus lead). Safety:
  // never shift the lead more than ~4 semitones either way.
  var ratio = Math.max(0.79, Math.min(1.26, Math.pow(2, effCorr / 12)));
  this.shifter.setTarget(period, ratio);

  if (this.preset === 'chorus') {
    // The harmony voices shift from the same sung pitch to their
    // own in-key notes. Strength moves them toward unison with the
    // lead (at 0% all seven voices sing the same note); the bypass
    // fades them to unison on unvoiced frames too.
    var harmony = harmonyNotes(this.targetNote !== null ? this.targetNote : Math.round(this.lastP), this.scaleMask);
    var targets = [
      this.lastP + effCorr + 0.12, // voice 2: unison +12 cents
      this.lastP + effCorr - 0.12, // voice 3: unison −12 cents
      harmony[0], harmony[1], harmony[2], harmony[3] // 3rd, 5th, 3rd dn, 4th dn
    ];
    for (var v2 = 0; v2 < 6; v2++) {
      var hMidi;
      if (v2 < 2) {
        hMidi = targets[v2];
      } else {
        hMidi = this.lastP + (targets[v2] - this.lastP) * this.strength * (1 - this.bypass);
      }
      var hRatio = Math.max(0.5, Math.min(1.65, Math.pow(2, (hMidi - this.lastP) / 12)));
      this.chorusShifters[v2].setTarget(period, hRatio);
    }
  }
};

/* Big Chorus: the lead plus six harmony voices, each through its
 * own PSOLA shifter (all fed the same clean input, all in time —
 * the same 8 ms latency), each through its micro-delay, mixed
 * with the lead loudest. In live mode only 4 voices run.
 */
TuneDSP.prototype.processChorus = function (part, count) {
  var bufs = this.voiceBufs;
  var active = this.liveMode ? CHORUS_LIVE_VOICES : [0, 1, 2, 3, 4, 5, 6];
  var isActive = [false, false, false, false, false, false, false];
  for (var a = 0; a < active.length; a++) isActive[active[a]] = true;

  this.shifter.process(part, bufs[0], count);
  for (var v = 1; v < 7; v++) {
    if (!isActive[v]) continue;
    this.chorusShifters[v - 1].process(part, bufs[v], count);
    // Micro-delay: push the voice through its delay line.
    var dl = this.chorusDelays[v - 1];
    for (var i = 0; i < count; i++) {
      dl.ring[dl.pos & dl.mask] = bufs[v][i];
      bufs[v][i] = dl.ring[(dl.pos - dl.delay) & dl.mask];
      dl.pos += 1;
    }
  }
  // Unvoiced frames: harmony voices drop 18 dB (the bypass factor
  // fades it in smoothly, so no click when a phrase ends).
  var unvoicedScale = Math.pow(10, CHORUS_UNVOICED_DB / 20);
  var harmScale = 1 - (1 - unvoicedScale) * this.bypass;
  for (var s = 0; s < count; s++) {
    var sum = 0;
    for (var w = 0; w < 7; w++) {
      if (!isActive[w]) continue;
      var g = Math.pow(10, CHORUS_VOICES[w].gainDb / 20);
      if (w > 0) g *= harmScale;
      sum += bufs[w][s] * g;
    }
    part[s] = sum * CHORUS_MASTER_GAIN;
  }
};

/* Super Vocoder: an FFT frame every hop (256 samples, 75%
 * overlap). The spectral envelope of the voice is imposed on an
 * impulse-train carrier at the corrected pitch, and the result is
 * overlap-added back. Unvoiced frames get no carrier — the
 * consonants come through the high-pass bypass instead.
 *
 * A worklet block (128 samples) is half a hop, so the frame runs
 * every OTHER call — the emit pointer advances every call and
 * always sits exactly at the frontier of finished audio.
 */
TuneDSP.prototype.processVocoder = function (part, chunk) {
  var sr = this.sampleRate;
  var i;
  var o;
  // Push the clean input into the ring.
  for (i = 0; i < chunk; i++) {
    this.vocInRing[this.vocInCount & 2047] = part[i];
    this.vocInCount += 1;
  }
  // One frame per hop (updates the envelope + oscillator targets).
  this.vocSinceFrame += chunk;
  if (this.vocSinceFrame >= this.hop) {
    this.vocSinceFrame -= this.hop;
    this.vocFrameStep();
  }
  // The carrier is generated sample by sample from the oscillator
  // pool — real time, zero added latency. Amplitudes glide toward
  // their per-frame targets (τ ≈ 1 ms) so the envelope never
  // zipper-clicks; phases run continuously so a frequency change
  // is a smooth glide. Oscillators at (near) zero amplitude are
  // skipped entirely.
  var hp = this.vocHp;
  var bypassGain = 0.2 + 0.8 * this.bypass;
  var oscFreq = this.vocOscFreq;
  var oscPhase = this.vocOscPhase;
  var oscAmp = this.vocOscAmp;
  var oscTarget = this.vocOscTarget;
  var oscCount = this.vocOscCount;
  var twoPi = 2 * Math.PI;
  for (i = 0; i < chunk; i++) {
    // HF consonant bypass: high-pass the input at 4 kHz, mix it
    // in (a little air while voiced, full strength on unvoiced
    // frames). No delay — the carrier is real-time.
    var x = part[i];
    var y = hp.b0 * x + hp.b1 * hp.x1 + hp.b2 * hp.x2 - hp.a1 * hp.y1 - hp.a2 * hp.y2;
    hp.x2 = hp.x1; hp.x1 = x; hp.y2 = hp.y1; hp.y1 = y;
    var sum = 0;
    for (o = 0; o < oscCount; o++) {
      var amp = oscAmp[o];
      var target = oscTarget[o];
      if (amp < 0.0005 && target < 0.0005) continue;
      amp += (target - amp) * 0.02;
      oscAmp[o] = amp;
      var ph = oscPhase[o] + oscFreq[o] / sr;
      if (ph >= 1) ph -= 1;
      oscPhase[o] = ph;
      sum += Math.sin(twoPi * ph) * amp;
    }
    // Soft-clip the total: the harmonics are phase-locked (they
    // are all multiples of one F0), so their peaks line up and
    // the sum can exceed 1.0 — monster mode measured RMS 0.75
    // with peaks near 1.7. tanh bounds it to ±1 and is nearly
    // linear below 0.5, so normal levels pass through unchanged.
    part[i] = Math.tanh(sum + y * bypassGain);
  }
};

/* One vocoder frame: FFT the latest 1024 input samples, smooth
 * the magnitude into an envelope, then build the carrier harmonic
 * list from the envelope and assign it to the oscillator pool.
 * The envelope is the voice's timbre (the vowel shape); the
 * carrier harmonics are exact multiples of the corrected pitch.
 */
TuneDSP.prototype.vocFrameStep = function () {
  var sr = this.sampleRate;
  var i;
  var frame = this.vocFrame;
  var inStart = this.vocInCount - FFT_N;
  for (i = 0; i < FFT_N; i++) {
    frame[i] = this.vocInRing[(inStart + i) & 2047] * this.vocWindow[i];
  }
  var re = this.vocRe;
  var im = this.vocIm;
  for (i = 0; i < FFT_N; i++) { re[i] = frame[i]; im[i] = 0; }
  fft1024(re, im, false);

  // Spectral envelope: the magnitude, smoothed across frequency
  // (±4 bins ≈ ±190 Hz — wide enough to erase the harmonic comb,
  // narrow enough to keep the vowel shape). Each magnitude is
  // computed once; the smoothing is a sliding window.
  var mag = this.vocMag;
  var env = this.vocEnv;
  var bins = FFT_N / 2 + 1;
  for (var b = 0; b < bins; b++) {
    mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
  }
  var lo = 0;
  var hi = Math.min(bins - 1, 4);
  var acc = 0;
  for (var m = 0; m <= hi; m++) acc += mag[m];
  for (b = 0; b < bins; b++) {
    var nlo = Math.max(0, b - 4);
    var nhi = Math.min(bins - 1, b + 4);
    while (lo < nlo) { acc -= mag[lo]; lo += 1; }
    while (hi < nhi) { hi += 1; acc += mag[hi]; }
    env[b] = acc / (nhi - nlo + 1);
  }

  // The carrier harmonic list: exact multiples of each series'
  // F0, with amplitudes from the envelope at that frequency. The
  // envelope is the smoothed FFT magnitude: a Hann-windowed tone
  // of amplitude A peaks at A·N/4, and the 9-bin smoothing keeps
  // roughly a quarter of the peak, so the envelope at a formant
  // is ≈ A·N/16 = A·64 (N = 1024) — divide by 64 to get the
  // time-domain amplitude back. (Measured against the probe tone
  // after the build; the trim lives here, not in the UI.)
  var carrierGain = 1 - this.bypass; // fades the carrier out on unvoiced frames
  var harmFreq = this.vocHarmFreq;
  var harmAmp = this.vocHarmAmp;
  var harmCount = 0;
  var binHz = sr / FFT_N;
  if (this.vocCarrierHz > 0 && carrierGain > 0.001) {
    var series = this.vocoderSeries();
    for (var s = 0; s < series.length; s++) {
      var f0 = series[s].f0;
      if (f0 <= 0) continue;
      var sg = series[s].gain;
      // Harmonics up to 5 kHz — the envelope above that is
      // negligible for a voice (the HF bypass carries the
      // consonants instead).
      for (var h = 1; h * f0 <= 5000 && harmCount < 128; h++) {
        var hf = h * f0;
        // Envelope at hf, linear interpolation between bins.
        var binPos = hf / binHz;
        var binLo = Math.floor(binPos);
        if (binLo >= bins - 1) break;
        var frac = binPos - binLo;
        var envAt = env[binLo] * (1 - frac) + env[binLo + 1] * frac;
        var amp = envAt * sg * carrierGain / 64;
        if (amp < 0.003) continue; // inaudible — saves oscillators
        harmFreq[harmCount] = hf;
        harmAmp[harmCount] = amp;
        harmCount += 1;
      }
    }
    // Sort by frequency (insertion sort — the list is short),
    // then merge harmonics that coincide (within 1 Hz: the
    // monster's unison harmonics land on the sub's even ones).
    for (var i = 1; i < harmCount; i++) {
      var kf = harmFreq[i];
      var ka = harmAmp[i];
      var j = i - 1;
      while (j >= 0 && harmFreq[j] > kf) {
        harmFreq[j + 1] = harmFreq[j];
        harmAmp[j + 1] = harmAmp[j];
        j -= 1;
      }
      harmFreq[j + 1] = kf;
      harmAmp[j + 1] = ka;
    }
    var merged = 0;
    for (var m = 0; m < harmCount; m++) {
      if (merged > 0 && harmFreq[m] - harmFreq[merged - 1] < 1) {
        harmAmp[merged - 1] += harmAmp[m];
      } else {
        harmFreq[merged] = harmFreq[m];
        harmAmp[merged] = harmAmp[m];
        merged += 1;
      }
    }
    harmCount = merged;
    // If the list still exceeds the pool, keep the 48 loudest.
    if (harmCount > this.vocOscCount) {
      // Selection: repeatedly drop the quietest entry.
      while (harmCount > this.vocOscCount) {
        var quiet = 0;
        for (var q = 1; q < harmCount; q++) {
          if (harmAmp[q] < harmAmp[quiet]) quiet = q;
        }
        for (var r = quiet; r < harmCount - 1; r++) {
          harmFreq[r] = harmFreq[r + 1];
          harmAmp[r] = harmAmp[r + 1];
        }
        harmCount -= 1;
      }
    }
  }
  this.vocHarmCount = harmCount;
  // Assign the harmonic list to the oscillator pool, lowest first
  // (so each oscillator tracks the same harmonic as the pitch
  // drifts). Oscillators past the list fade to silence; phases
  // are never reset, so a frequency change is a smooth glide.
  var oscFreq = this.vocOscFreq;
  var oscTarget = this.vocOscTarget;
  for (var o = 0; o < this.vocOscCount; o++) {
    if (o < harmCount) {
      oscFreq[o] = harmFreq[o];
      oscTarget[o] = harmAmp[o];
    } else {
      oscTarget[o] = 0;
    }
  }
};

/* The carrier harmonic series for the current vocoder mode:
 * unison = the corrected F0; monster = F0÷2 at full level plus
 * the unison at −6 dB; chord = the key's root, 5th, and octave
 * (locked to the key, not to the sung note).
 */
TuneDSP.prototype.vocoderSeries = function () {
  var f0 = this.vocCarrierHz;
  if (this.vocoderMode === 'monster') {
    return [{ f0: f0 / 2, gain: 1.0 }, { f0: f0, gain: 0.5 }];
  }
  if (this.vocoderMode === 'chord') {
    var parsed = parseKeyName(this.currentKeyName || 'D minor');
    var sungMidi = this.lastP !== null ? this.lastP : 69;
    var rootMidi = parsed.tonic + 12 * Math.round((sungMidi - parsed.tonic) / 12);
    return [
      { f0: hzForMidi(rootMidi), gain: 0.6 },
      { f0: hzForMidi(rootMidi + 7), gain: 0.6 },
      { f0: hzForMidi(rootMidi + 12), gain: 0.6 }
    ];
  }
  return [{ f0: f0, gain: 1.0 }];
};

/* Clean: a high-pass filter (takes out low rumble and hum) plus a
 * soft downward expander (pushes the room tone down between
 * phrases). The voice itself is never pitch-shifted.
 */
TuneDSP.prototype.processClean = function (samples, count) {
  var h = this.hpf;
  for (var i = 0; i < count; i++) {
    var x = samples[i];
    var y = h.b0 * x + h.b1 * h.x1 + h.b2 * h.x2 - h.a1 * h.y1 - h.a2 * h.y2;
    h.x2 = h.x1; h.x1 = x; h.y2 = h.y1; h.y1 = y;
    // Level follower (fast attack, slow release) + soft gate:
    // full level above ~-30 dB, pushed down toward 0.1x below
    // ~-40 dB, with the gain smoothed so the gate never clicks.
    var a = y < 0 ? -y : y;
    var k = a > this.gateLevel ? 0.01 : 0.0005;
    this.gateLevel += (a - this.gateLevel) * k;
    var target = 1;
    if (this.gateLevel < 0.01) target = 0.1;
    else if (this.gateLevel < 0.03) target = 0.1 + 0.9 * (this.gateLevel - 0.01) / 0.02;
    var gk = target < this.gateGain ? 0.005 : 0.0005;
    this.gateGain += (target - this.gateGain) * gk;
    samples[i] = y * this.gateGain;
  }
};

// ---------------------------------------------------------------- worklet wrapper (browser only)

if (typeof AudioWorkletProcessor !== 'undefined') {
  class TuneProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new TuneDSP(sampleRate);
      this.port.onmessage = (event) => {
        var data = event.data || {};
        if (data.type === 'key') {
          this.dsp.setKey(data.key);
          this.dsp.currentKeyName = data.key;
        } else if (data.type === 'preset') {
          if (data.preset) this.dsp.setPreset(data.preset);
          if (data.strength !== undefined) this.dsp.setStrength(data.strength);
          if (data.speed !== undefined) this.dsp.setSpeed(data.speed);
          if (data.vocoderMode) this.dsp.setVocoderMode(data.vocoderMode);
          if (data.live !== undefined) this.dsp.setLiveMode(data.live);
        } else if (data.type === 'strength') {
          this.dsp.setStrength(data.value);
        } else if (data.type === 'speed') {
          this.dsp.setSpeed(data.value);
        } else if (data.type === 'vocoderMode') {
          this.dsp.setVocoderMode(data.mode);
        } else if (data.type === 'live') {
          this.dsp.setLiveMode(data.on);
        } else if (data.type === 'enabled') {
          this.dsp.setEnabled(data.on);
        } else if (data.type === 'reset') {
          this.dsp.reset();
        }
      };
    }

    process(inputs, outputs) {
      var input = inputs[0];
      var output = outputs[0];
      if (!input || input.length === 0 || !output || output.length === 0) return true;
      var inCh = input[0];
      var outCh = output[0];
      if (!inCh || inCh.length === 0) {
        outCh.fill(0);
        return true;
      }
      // Copy the clean input out first, then tune in place (the
      // DSP detects on the clean copy before the effect rewrites
      // it — same order as the native render callback).
      outCh.set(inCh);
      this.dsp.process(outCh, outCh.length);
      return true;
    }
  }

  registerProcessor('tune-processor', TuneProcessor);
}

// ---------------------------------------------------------------- exports

var TuneExports = {
  YinDetector: YinDetector,
  PsolaShifter: PsolaShifter,
  TuneDSP: TuneDSP,
  PRESETS: PRESETS,
  VOCODER_MODES: VOCODER_MODES,
  CHORUS_VOICES: CHORUS_VOICES,
  CHORUS_LIVE_VOICES: CHORUS_LIVE_VOICES,
  SCALE_STEPS: SCALE_STEPS,
  parseKeyName: parseKeyName,
  scaleMaskForKey: scaleMaskForKey,
  nearestInScaleNote: nearestInScaleNote,
  snapNote: snapNote,
  scaleStep: scaleStep,
  harmonyNotes: harmonyNotes,
  hzForMidi: hzForMidi,
  midiForHz: midiForHz,
  isInScale: isInScale,
  fft1024: fft1024
};

// Node export (tests only).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TuneExports;
}

// Browser classic-script load (retune.js needs TuneDSP outside the
// worklet — the app loads this file with a <script> tag as well as
// through audioWorklet.addModule). Harmless in the worklet context
// and in Node — neither has `window`.
if (typeof window !== 'undefined') {
  window.PS = window.PS || {};
  window.PS.tune = TuneExports;
}
