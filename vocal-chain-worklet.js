/* vocal-chain-worklet.js — the 9-stage live vocal chain (Phase 3 Step 4A).
 *
 * One AudioWorkletProcessor, `vocal-chain-processor`, holding the
 * stages that have to be sample-accurate and zero-lookahead:
 *   room-noise gate → compressor (auto-threshold) → de-esser →
 *   saturation → algorithmic reverb (Freeverb-style FDN).
 *
 * The other stages live outside the worklet as plain nodes, wired by
 * the app in this order (the roadmap's 9-stage chain):
 *   noise reduction (this worklet's gate — OFF by default) →
 *   Corrective EQ (one peaking biquad, -2 dB @ 300 Hz) →
 *   low cut (two cascaded 12 dB high-passes @ 90 Hz = 24 dB/oct,
 *   placed BEFORE the tune — Gemini's correction: sub-80 Hz mic
 *   rumble degrades YIN accuracy, so the tune never sees it) →
 *   Main FX (the tune worklet — already built) →
 *   compressor + de-esser + saturation + reverb (this worklet) →
 *   manual EQ (three biquads driven by the One Knob macros) →
 *   delay (a tempo-synced dotted-1/8 send) → reverb (in this
 *   worklet, wet/dry mix — the send discipline's 100%-wet return
 *   folded into one node).
 *
 * Why the compressor + de-esser are here and not a
 * DynamicsCompressorNode: that node has a mandatory 6 ms internal
 * lookahead (W3C Web Audio API 1.1) — +6 ms on the live monitor,
 * comb filtering on a parallel path, and zipper noise if a
 * main-thread loop moves the threshold. This compressor is
 * zero-lookahead: an impulse at sample 0 is in the output at
 * sample 0. The only latency the chain adds is the worklet's own
 * 128-sample render block (~2.7 ms at 48 kHz); the tune adds its
 * documented 8 ms. Code budget for the live path: ~11 ms.
 *
 * Compressor (Gemini's starting preset, ESTIMATED until the ear
 * pass): zero-lookahead feed-forward, peak envelope with separate
 * attack/release smoothing, and an AUTO-THRESHOLD — a 300 ms RMS
 * tracker sets the threshold at (slow RMS + Diff dB), so the
 * threshold follows the singer instead of needing a fixed level.
 * Moderate target: 3:1, 15 ms / 120 ms, Diff -6 dB (~3-5 dB GR).
 * The One Knob macros move it: Even 0-100 drives ratio 1:1-4:1
 * and Diff -2 to -9 dB; Punch 0-100 drives attack 30-3 ms and
 * release 150-60 ms. Makeup is a fixed +3 dB (starting point).
 *
 * De-esser (split-band, Gemini + Claude agree on the shape):
 * a 6 kHz one-pole high-pass feeds an envelope detector (1 ms
 * attack / 40 ms release); when sibilance crosses the threshold
 * the HIGH band is ducked by up to 6 dB — the low band is never
 * touched, so the body of the voice stays put.
 *
 * Saturation (Warm): tanh soft clip, drive 1.5, blended in by
 * the Warm macro (0 = dry, exactly the input; 100 = full soft
 * clip). Blending — not just the drive — is what makes Warm 0
 * mean "no warmth": a bare tanh at drive 1.0 still rounds peaks
 * by ~4% (chain-test caught it), so the dry path must be exact.
 *
 * Reverb (FDN, Gemini's worklet option): 25 ms pre-delay, 4
 * parallel combs (Freeverb-style damped feedback, 0.84) into 2
 * series allpasses (0.5), wet high-passed at 250 Hz so the room
 * never fights the 808. Wet 0-0.30 from the Space macro. When
 * wet is 0 the FDN is skipped entirely — no tail, no CPU.
 *
 * The room-noise gate: a downward expander (threshold -50 dBFS,
 * floor -20 dB). OFF by default — the roadmap's call, because a
 * gate that guesses wrong eats the start of a line.
 *
 * `enabled: false` is a bit-exact passthrough (the DSP does
 * nothing to the buffer) — the chain toggle parks the whole
 * worklet this way, and the app parks the biquads + delay with
 * it. Macro changes are smoothed per block (10 ms one-pole)
 * toward their targets, so a slider drag never clicks.
 *
 * Node export (tests only): ChainDSP + the macro mapping lives
 * in the app (macrosToChain), not here — this file only knows
 * raw DSP parameters.
 */
'use strict';

/* Freeverb-style FDN constants. */
var CHAIN_FEEDBACK = 0.84; // comb feedback — decay ~1.6 s
var CHAIN_DAMP = 0.2; // comb feedback damping (tames the metallic ring)
var CHAIN_ALLPASS_FB = 0.5;
var CHAIN_PREDELAY_MS = 25;
var CHAIN_WET_HP_HZ = 250; // the room never fights the 808
var CHAIN_DEESS_HP_HZ = 6000; // sibilance lives above here
var CHAIN_DEESS_THRESH = 0.12; // ~-18 dBFS on the sibilance envelope
var CHAIN_DEESS_MAX_DUCK = 0.5; // at most -6 dB
var CHAIN_NR_THRESH_DB = -50;
var CHAIN_NR_FLOOR = 0.1; // -20 dB floor — a gate, not a mute
var CHAIN_SLOW_RMS_MS = 300; // auto-threshold tracker

function onePoleCoef(ms, sampleRate) {
  return 1 - Math.exp(-1 / (Math.max(0.1, ms) / 1000 * sampleRate));
}

function onePoleCoefHz(hz, sampleRate) {
  return 1 - Math.exp(-2 * Math.PI * hz / sampleRate);
}

function ChainDSP(sampleRate) {
  this.sampleRate = sampleRate;
  // Targets (set by port messages) and currents (smoothed per
  // block toward the targets — no zipper noise on a slider drag).
  this.tRatio = 2.5; this.ratio = 2.5;
  this.tDiffDb = -6; this.diffDb = -6;
  this.tAttackMs = 10; this.attackMs = 10;
  this.tReleaseMs = 100; this.releaseMs = 100;
  this.tMakeupDb = 3; this.makeupDb = 3;
  this.tDrive = 1.5; this.drive = 1.5;
  this.tSatMix = 0; this.satMix = 0; // Warm 0 = dry, exactly the input
  this.tReverbWet = 0.15; this.reverbWet = 0.15;
  this.tNrOn = false; this.nrOn = false;
  this.tDeessOn = true; this.deessOn = true;
  this.tEnabled = true; this.enabled = true;
  this.nrThresh = Math.pow(10, CHAIN_NR_THRESH_DB / 20);
  // Envelope / detector state.
  this.compEnv = 0;
  this.compGain = 1;
  this.slowSq = 0;
  this.sessEnv = 0;
  this.sessLp = 0;
  this.duck = 1;
  this.gateEnv = 0;
  this.gateGain = 1;
  // Last measured values (for tests + the app's chain readout).
  this.lastGrDb = 0;
  this.lastDuckDb = 0;
  this.lastGateGainDb = 0;
  this.buildReverb();
}

ChainDSP.prototype.buildReverb = function () {
  var scale = this.sampleRate / 48000;
  function scaled(ms) { return Math.max(16, Math.round(ms * scale)); }
  var combLens = [1116, 1188, 1277, 1356];
  var apLens = [556, 441];
  this.combs = combLens.map(function (len) {
    return { buf: new Float32Array(scaled(len)), idx: 0, filterStore: 0 };
  });
  this.allpasses = apLens.map(function (len) {
    return { buf: new Float32Array(scaled(len)), idx: 0 };
  });
  this.preBuf = new Float32Array(Math.max(16, Math.round(CHAIN_PREDELAY_MS / 1000 * this.sampleRate)));
  this.preIdx = 0;
  this.wetLp = 0;
};

ChainDSP.prototype.setParams = function (p) {
  if (!p) return;
  function clamp(v, lo, hi, fallback) {
    v = Number(v);
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
  }
  if (p.ratio !== undefined) this.tRatio = clamp(p.ratio, 1, 10, 2.5);
  if (p.diffDb !== undefined) this.tDiffDb = clamp(p.diffDb, -20, 0, -6);
  if (p.attackMs !== undefined) this.tAttackMs = clamp(p.attackMs, 1, 100, 10);
  if (p.releaseMs !== undefined) this.tReleaseMs = clamp(p.releaseMs, 10, 500, 100);
  if (p.makeupDb !== undefined) this.tMakeupDb = clamp(p.makeupDb, 0, 6, 3);
  if (p.drive !== undefined) this.tDrive = clamp(p.drive, 1, 3, 1.5);
  if (p.satMix !== undefined) this.tSatMix = clamp(p.satMix, 0, 1, 0);
  if (p.reverbWet !== undefined) this.tReverbWet = clamp(p.reverbWet, 0, 0.5, 0.15);
  // The first params message snaps the currents straight to the
  // targets — a fresh node starts at the singer's settings, not
  // at the defaults with a 50 ms glide. Later messages glide
  // (the per-block smoothing in process), so a slider drag never
  // steps. A reset re-arms the snap for the next params message.
  if (!this.started) {
    this.ratio = this.tRatio;
    this.diffDb = this.tDiffDb;
    this.attackMs = this.tAttackMs;
    this.releaseMs = this.tReleaseMs;
    this.makeupDb = this.tMakeupDb;
    this.drive = this.tDrive;
    this.satMix = this.tSatMix;
    this.reverbWet = this.tReverbWet;
    this.started = true;
  }
};

ChainDSP.prototype.setNr = function (on) {
  this.tNrOn = !!on;
};

ChainDSP.prototype.setDeess = function (on) {
  this.tDeessOn = !!on;
};

ChainDSP.prototype.setEnabled = function (on) {
  this.tEnabled = !!on;
};

ChainDSP.prototype.reset = function () {
  this.compEnv = 0;
  this.compGain = 1;
  this.slowSq = 0;
  this.sessEnv = 0;
  this.sessLp = 0;
  this.duck = 1;
  this.gateEnv = 0;
  this.gateGain = 1;
  this.lastGrDb = 0;
  this.lastDuckDb = 0;
  this.lastGateGainDb = 0;
  this.started = false; // the next params message snaps again
  this.combs.forEach(function (c) { c.buf.fill(0); c.idx = 0; c.filterStore = 0; });
  this.allpasses.forEach(function (a) { a.buf.fill(0); a.idx = 0; });
  this.preBuf.fill(0);
  this.preIdx = 0;
  this.wetLp = 0;
};

ChainDSP.prototype.lastGainReductionDb = function () {
  return this.lastGrDb;
};

ChainDSP.prototype.lastDeessDuckDb = function () {
  return this.lastDuckDb;
};

ChainDSP.prototype.lastGateGainDb = function () {
  return this.lastGateGainDb;
};

/* Processes `buf` in place, like TuneDSP.process. When disabled
 * the buffer is left untouched (bit-exact passthrough).
 */
ChainDSP.prototype.process = function (buf, len) {
  var sr = this.sampleRate;
  // Per-block: ease every current value toward its target (10 ms
  // one-pole) so a macro change glides instead of stepping.
  var sm = 1 - Math.exp(-128 / (0.010 * sr));
  this.ratio += (this.tRatio - this.ratio) * sm;
  this.diffDb += (this.tDiffDb - this.diffDb) * sm;
  this.attackMs += (this.tAttackMs - this.attackMs) * sm;
  this.releaseMs += (this.tReleaseMs - this.releaseMs) * sm;
  this.makeupDb += (this.tMakeupDb - this.makeupDb) * sm;
  this.drive += (this.tDrive - this.drive) * sm;
  this.satMix += (this.tSatMix - this.satMix) * sm;
  this.reverbWet += (this.tReverbWet - this.reverbWet) * sm;
  this.nrOn = this.tNrOn;
  this.deessOn = this.tDeessOn;
  this.enabled = this.tEnabled;
  if (!this.enabled) return;

  var atk = onePoleCoef(this.attackMs, sr);
  var rel = onePoleCoef(this.releaseMs, sr);
  var slowCoef = onePoleCoef(CHAIN_SLOW_RMS_MS, sr);
  var sessAtk = onePoleCoef(1, sr);
  var sessRel = onePoleCoef(40, sr);
  var gateAtk = onePoleCoef(10, sr);
  var gateRel = onePoleCoef(100, sr);
  var sessLpCoef = onePoleCoefHz(CHAIN_DEESS_HP_HZ, sr);
  var wetLpCoef = onePoleCoefHz(CHAIN_WET_HP_HZ, sr);
  var diffLin = Math.pow(10, this.diffDb / 20);
  var makeupLin = Math.pow(10, this.makeupDb / 20);
  var invRatio = 1 - 1 / this.ratio;
  var reverbOn = this.reverbWet > 0.0005;

  for (var i = 0; i < len; i++) {
    var x = buf[i];

    // 1 — Room-noise gate (OFF unless the singer asked for it).
    if (this.nrOn) {
      var ax0 = x < 0 ? -x : x;
      if (ax0 > this.gateEnv) this.gateEnv += (ax0 - this.gateEnv) * gateAtk;
      else this.gateEnv += (ax0 - this.gateEnv) * gateRel;
      var gateTarget = this.gateEnv < this.nrThresh ? CHAIN_NR_FLOOR : 1;
      if (gateTarget < this.gateGain) this.gateGain += (gateTarget - this.gateGain) * gateAtk;
      else this.gateGain += (gateTarget - this.gateGain) * gateRel;
      x *= this.gateGain;
    }

    // 2 — Compressor: peak envelope, auto-threshold from the
    // 300 ms RMS tracker, gain smoothed with the same attack /
    // release so the gain itself never steps.
    var ax = x < 0 ? -x : x;
    if (ax > this.compEnv) this.compEnv += (ax - this.compEnv) * atk;
    else this.compEnv += (ax - this.compEnv) * rel;
    this.slowSq += (x * x - this.slowSq) * slowCoef;
    var slowEnv = Math.sqrt(this.slowSq);
    var thresh = slowEnv * diffLin;
    var targetGain = 1;
    if (thresh > 1e-6 && this.compEnv > thresh) {
      targetGain = Math.pow(thresh / this.compEnv, invRatio);
    }
    if (targetGain < this.compGain) this.compGain += (targetGain - this.compGain) * atk;
    else this.compGain += (targetGain - this.compGain) * rel;
    x *= this.compGain * makeupLin;

    // 3 — De-esser: the high band (above 6 kHz) is ducked up to
    // 6 dB when sibilance crosses the threshold; the low band —
    // the body of the voice — is never touched.
    if (this.deessOn) {
      this.sessLp += (x - this.sessLp) * sessLpCoef;
      var hp = x - this.sessLp;
      var ahp = hp < 0 ? -hp : hp;
      if (ahp > this.sessEnv) this.sessEnv += (ahp - this.sessEnv) * sessAtk;
      else this.sessEnv += (ahp - this.sessEnv) * sessRel;
      var duckTarget = 1;
      if (this.sessEnv > CHAIN_DEESS_THRESH) {
        duckTarget = Math.pow(CHAIN_DEESS_THRESH / this.sessEnv, 0.5);
        if (duckTarget < CHAIN_DEESS_MAX_DUCK) duckTarget = CHAIN_DEESS_MAX_DUCK;
      }
      if (duckTarget < this.duck) this.duck += (duckTarget - this.duck) * sessAtk;
      else this.duck += (duckTarget - this.duck) * sessRel;
      x = this.sessLp + hp * this.duck;
    }

    // 4 — Saturation (Warm): tanh soft clip, blended in by the
    // Warm macro. satMix 0 is exactly the input (no warmth means
    // no saturation); satMix 1 is the full tanh curve. The blend
    // is a crossfade, so a slider drag never steps.
    var sat = Math.tanh(x * this.drive) / this.drive;
    x = x + (sat - x) * this.satMix;

    // 5 — Reverb (FDN): pre-delay -> 4 damped combs in parallel
    // -> 2 series allpasses -> wet high-passed at 250 Hz.
    // Skipped entirely when wet is 0.
    var wet = 0;
    if (reverbOn) {
      var pd = this.preBuf[this.preIdx];
      this.preBuf[this.preIdx] = x;
      this.preIdx = (this.preIdx + 1) % this.preBuf.length;
      var sum = 0;
      for (var c = 0; c < 4; c++) {
        var comb = this.combs[c];
        var cOut = comb.buf[comb.idx];
        comb.filterStore = cOut * (1 - CHAIN_DAMP) + comb.filterStore * CHAIN_DAMP;
        comb.buf[comb.idx] = pd + comb.filterStore * CHAIN_FEEDBACK;
        comb.idx = (comb.idx + 1) % comb.buf.length;
        sum += cOut;
      }
      sum *= 0.5; // the four combs are decorrelated copies — half
      // keeps a dense vocal from doubling the wet level outright
      for (var a = 0; a < 2; a++) {
        var ap = this.allpasses[a];
        var apOut = ap.buf[ap.idx];
        var y = apOut - CHAIN_ALLPASS_FB * sum;
        ap.buf[ap.idx] = sum + CHAIN_ALLPASS_FB * y;
        ap.idx = (ap.idx + 1) % ap.buf.length;
        sum = y;
      }
      this.wetLp += (sum - this.wetLp) * wetLpCoef;
      wet = (sum - this.wetLp) * this.reverbWet;
    }
    buf[i] = x + wet;
  }
  this.lastGrDb = 20 * Math.log10(Math.max(this.compGain, 1e-6));
  this.lastDuckDb = 20 * Math.log10(Math.max(this.duck, 1e-6));
  this.lastGateGainDb = 20 * Math.log10(Math.max(this.gateGain, 1e-6));
};

/* Browser worklet wrapper (same shape as tune-worklet.js). */
if (typeof AudioWorkletProcessor !== 'undefined') {
  class ChainProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.dsp = new ChainDSP(sampleRate);
      this.port.onmessage = (event) => {
        var data = event.data || {};
        if (data.type === 'params') {
          this.dsp.setParams(data.params || {});
        } else if (data.type === 'nr') {
          this.dsp.setNr(!!data.on);
        } else if (data.type === 'deess') {
          this.dsp.setDeess(data.on !== false);
        } else if (data.type === 'enabled') {
          this.dsp.setEnabled(!!data.on);
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
      outCh.set(inCh);
      this.dsp.process(outCh, outCh.length);
      return true;
    }
  }

  registerProcessor('vocal-chain-processor', ChainProcessor);
}

var ChainExports = {
  ChainDSP: ChainDSP,
  CHAIN_FEEDBACK: CHAIN_FEEDBACK,
  CHAIN_DAMP: CHAIN_DAMP,
  CHAIN_PREDELAY_MS: CHAIN_PREDELAY_MS,
  CHAIN_WET_HP_HZ: CHAIN_WET_HP_HZ,
  CHAIN_DEESS_HP_HZ: CHAIN_DEESS_HP_HZ,
  CHAIN_DEESS_THRESH: CHAIN_DEESS_THRESH,
  CHAIN_NR_THRESH_DB: CHAIN_NR_THRESH_DB
};

// Node export (tests only).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ChainExports;
}
