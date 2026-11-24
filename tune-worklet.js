/* tune-worklet.js — the live Hard Tune for the Phone Studio PWA.
 *
 * Port of the native app's Phase 2 live-tune prototype
 * (PitchDetector.swift + PitchShifter.swift + LiveTuneEngine.swift)
 * to the Web Audio render thread. The ALGORITHM is the port, not
 * the Swift code:
 *
 *   YIN pitch detection -> hard snap to the song key -> PSOLA shift
 *
 * - YIN hears which note the voice is singing (10.7 ms window,
 *   80-800 Hz, first dip under 0.15 so it does not lock onto a
 *   lower octave by mistake, parabolic interpolation for sub-sample
 *   pitch). Runs every ~5.3 ms hop, not per sample.
 * - Hard snap jumps the sung pitch to the nearest note in the song's
 *   key EXACTLY — no sliding, no softness. That instant jump IS the
 *   hard auto-tune sound. A small hysteresis (0.62 semitones) stops
 *   a note sung on the line between two notes from flickering.
 * - PSOLA moves the voice to the snapped note while keeping its
 *   timing and its vowel colour (grains cut at the same spot in
 *   every period, laid closer together to raise the pitch, further
 *   apart to lower it). Fixed 8 ms delay (2 x 4 ms grain half-width).
 *   The detector adds NO audio delay — it only steers upcoming
 *   grains.
 *
 * ONE preset: Hard Tune, 100% strength, at the song's key (D minor
 * default; the key arrives by message). The take stays DRY — this
 * runs on the MONITOR (live, while singing) and on take PLAYBACK
 * (the recorded take is tuned as it plays), never baked into the
 * file. Outside 80-800 Hz, or with no clear note (silence, breath,
 * consonants), the voice passes through unchanged. The shift is
 * clamped to ~4 semitones either way so a wrong detection never
 * throws the voice somewhere wild.
 *
 * This file is BOTH the AudioWorklet module (loaded with
 * ctx.audioWorklet.addModule('tune-worklet.js'), processor name
 * 'tune-processor') AND a Node-testable module (require it in a
 * test — the processor class is only defined where
 * AudioWorkletProcessor exists). Messages:
 *   main -> worklet: { type: 'key', key: 'D minor' }
 *                    { type: 'enabled', on: true }
 *                    { type: 'reset' }
 */

// ---------------------------------------------------------------- YIN

function YinDetector(sampleRate, lowHz, highHz) {
  this.sampleRate = sampleRate;
  this.maxLag = Math.ceil(sampleRate / (lowHz || 80));
  this.minLag = Math.max(2, Math.floor(sampleRate / (highHz || 800)));
  this.windowSize = Math.round(sampleRate * 0.0107); // ~10.7 ms
  this.spanSize = this.windowSize + this.maxLag + 2;
  this.threshold = 0.15;
  this.diff = new Float32Array(this.maxLag + 2);
  this.cmnd = new Float32Array(this.maxLag + 2);
}

/* Looks at spanSize samples in x (oldest first). Returns
 * { frequency, confidence } or null when there is no clear note
 * (silence, breath, a consonant like "s" or "t").
 */
YinDetector.prototype.detect = function (x) {
  var W = this.windowSize;
  var maxLag = this.maxLag;
  var diff = this.diff;
  var cmnd = this.cmnd;

  // Silence gate: a very quiet slice has no note worth tuning.
  var energy0 = 0;
  for (var j = 0; j < W; j++) energy0 += x[j] * x[j];
  if (energy0 / W < 1e-7) return null;

  // d(lag) = sum over the window of (x[j] - x[j+lag])^2
  //        = e0 + e(lag) - 2 * r(lag)
  // where r is the dot product of the slice with its slid copy
  // and e(lag) is the energy of the slid copy. e(lag) slides one
  // sample at a time, so it costs two multiplies per lag.
  var eLag = energy0; // energy of x[lag ..< lag+W], lag = 0
  diff[0] = 0;
  for (var lag = 1; lag <= maxLag; lag++) {
    var outgoing = x[lag - 1];
    var incoming = x[lag - 1 + W];
    eLag += incoming * incoming - outgoing * outgoing;
    if (eLag < 0) eLag = 0;
    var r = 0;
    for (var k = 0; k < W; k++) r += x[k] * x[k + lag];
    var d = energy0 + eLag - 2 * r;
    diff[lag] = d > 0 ? d : 0;
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
    frequency: this.sampleRate / period,
    confidence: Math.max(0, Math.min(1, 1 - cmnd[best]))
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

/* Walks the chain of analysis marks (one waveform peak per period)
 * forward until it is closest to `wanted`, and returns the closest
 * mark. Each mark is placed at the highest sample within a quarter
 * period of where the previous mark predicts, so every grain is cut
 * at the same spot in its period.
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
    var bestValue = this.inRing[predicted & mask];
    for (var j = predicted - search; j <= predicted + search; j++) {
      var v = this.inRing[j & mask];
      if (v > bestValue) { bestValue = v; bestIndex = j; }
    }
    this.lastAnalysisMark = bestIndex;
  }
  return this.lastAnalysisMark;
};

// ---------------------------------------------------------------- key snapping

/* The 16 song keys (same list as the app's key dropdown). Tonic:
 * 0 = C ... 11 = B. Major = whole-whole-half-whole-whole-whole-half;
 * minor is the natural minor (same notes as the relative major).
 */
var KEY_DEFS = {
  'C major': [0, false], 'G major': [7, false], 'D major': [2, false],
  'A major': [9, false], 'E major': [4, false], 'F major': [5, false],
  'Bb major': [10, false], 'Eb major': [3, false],
  'A minor': [9, true], 'E minor': [4, true], 'B minor': [11, true],
  'F# minor': [6, true], 'D minor': [2, true], 'G minor': [7, true],
  'C minor': [0, true], 'F minor': [5, true]
};

function scaleMaskForKey(keyName) {
  var def = KEY_DEFS[keyName] || KEY_DEFS['D minor'];
  var tonic = def[0];
  var steps = def[1] ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  var mask = 0;
  for (var i = 0; i < steps.length; i++) {
    mask |= 1 << ((tonic + steps[i]) % 12);
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

/* HARD snap: the nearest note in the key, jumped to exactly.
 * `previous` is the note we were on: we stay on it until the voice
 * is clearly closer to another one (a small hysteresis), so a note
 * sung right on the line between two notes does not flicker back
 * and forth. The jump itself is still instant.
 */
function snapNote(hz, scaleMask, previous) {
  var midi = 69 + 12 * (Math.log(hz / 440) / Math.LN2);
  if (previous !== null && previous !== undefined &&
      isInScale(previous, scaleMask) &&
      Math.abs(midi - previous) < 0.62) {
    return previous;
  }
  var centre = Math.round(midi);
  var bestNote = centre;
  var bestDistance = Infinity;
  for (var note = centre - 3; note <= centre + 3; note++) {
    if (!isInScale(note, scaleMask)) continue;
    var distance = Math.abs(midi - note);
    if (distance < bestDistance) { bestDistance = distance; bestNote = note; }
  }
  return bestNote;
}

// ---------------------------------------------------------------- the DSP

/* Everything the tune does to the audio: detect (YIN) -> snap
 * (hard, to the key) -> shift (PSOLA). After construction it
 * allocates nothing — safe on the audio render thread.
 */
function TuneDSP(sampleRate) {
  this.sampleRate = sampleRate;
  this.detector = new YinDetector(sampleRate, 80, 800);
  this.shifter = new PsolaShifter(sampleRate);
  this.hop = Math.max(32, Math.round(sampleRate * 0.0053)); // ~5.3 ms
  this.history = new Float32Array(this.detector.spanSize);
  this.scaleMask = scaleMaskForKey('D minor');
  this.enabled = false;
  this.currentNote = null;
  this.holdHops = 0;
  this.holdHopsAfterLoss = 3;
  this.wasEnabled = false;
  this.sinceLastDetect = 0;
  this.filled = 0;
}

TuneDSP.prototype.setKey = function (keyName) {
  this.scaleMask = scaleMaskForKey(keyName);
};

TuneDSP.prototype.setEnabled = function (on) {
  this.enabled = !!on;
};

TuneDSP.prototype.reset = function () {
  this.shifter.reset();
  this.history.fill(0);
  this.sinceLastDetect = 0;
  this.filled = 0;
  this.currentNote = null;
  this.holdHops = 0;
  this.wasEnabled = false;
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
    this.shifter.reset();
    this.history.fill(0);
    this.sinceLastDetect = 0;
    this.filled = 0;
    this.currentNote = null;
    this.holdHops = 0;
    this.wasEnabled = true;
  }

  var offset = 0;
  while (offset < count) {
    var chunk = Math.min(count - offset, this.hop - this.sinceLastDetect);
    var part = samples.subarray(offset, offset + chunk);
    // The detector listens to the CLEAN input — copy it into the
    // history before the shifter rewrites the buffer.
    this.appendHistory(part, chunk);
    this.shifter.process(part, part, chunk);
    this.sinceLastDetect += chunk;
    offset += chunk;
    if (this.sinceLastDetect >= this.hop) {
      this.sinceLastDetect = 0;
      this.updateTarget();
    }
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

/* Runs the detector on the latest history and tells the shifter how
 * far to move the voice.
 */
TuneDSP.prototype.updateTarget = function () {
  var found = null;
  if (this.filled >= this.detector.spanSize) {
    found = this.detector.detect(this.history);
  }
  if (!found || found.confidence <= 0.6) {
    // No clear note. Hold the last shift for a few hops (a
    // consonant or a wobble should not drop the tune), then let the
    // voice through untouched.
    if (this.holdHops > 0) {
      this.holdHops -= 1;
    } else {
      this.currentNote = null;
      this.shifter.setTarget(0, 1);
    }
    return;
  }
  var hz = found.frequency;
  var note = snapNote(hz, this.scaleMask, this.currentNote);
  this.currentNote = note;
  this.holdHops = this.holdHopsAfterLoss;
  // Safety: never shift more than ~4 semitones either way.
  var ratio = Math.max(0.79, Math.min(1.26, hzForMidi(note) / hz));
  this.shifter.setTarget(this.sampleRate / hz, ratio);
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
      // DSP detects on the clean copy before the shifter rewrites
      // it — same order as the native render callback).
      outCh.set(inCh);
      this.dsp.process(outCh, outCh.length);
      return true;
    }
  }

  registerProcessor('tune-processor', TuneProcessor);
}

// ---------------------------------------------------------------- Node export (tests only)

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    YinDetector: YinDetector,
    PsolaShifter: PsolaShifter,
    TuneDSP: TuneDSP,
    scaleMaskForKey: scaleMaskForKey,
    snapNote: snapNote,
    hzForMidi: hzForMidi,
    isInScale: isInScale
  };
}
