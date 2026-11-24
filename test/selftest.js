/* selftest.js — Node self-test for the PWA's pure modules.
 *
 * Run: node test/selftest.js
 *
 * 1. Calibration math: synthesize a click train + a copy delayed by a
 *    KNOWN delay, run measureDelays, confirm the measured delay
 *    matches the injected delay (within 1 ms).
 * 2. Residual verifier: synthesize a beat (drum hits) + a vocal whose
 *    phrase starts are late by a KNOWN offset, confirm the verdict and
 *    the trim match. Also the within-tolerance, early, too-few-onsets,
 *    and disagree cases.
 * 3. WAV round-trip: encode float32, decode, confirm samples match.
 * 4. Pre-comp trim arithmetic: lead-in-only vs lead-in + delay, from
 *    the MATH.md model.
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */
'use strict';

const calibrate = require('../calibrate.js');
const residual = require('../residual.js');
const wav = require('../wav.js');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('PASS  ' + name + (detail ? ' — ' + detail : ''));
  } else {
    failures += 1;
    console.log('FAIL  ' + name + (detail ? ' — ' + detail : ''));
  }
}

// ---------------------------------------------------------------- 1. Calibration
(function testCalibration() {
  const sr = 48000;
  const injectedDelayMs = 187; // a realistic Bluetooth round trip
  const injectedDelaySamples = Math.round(injectedDelayMs / 1000 * sr);

  // Build a fake recording: 5 clicks, 0.6 s apart, first at 0.5 s,
  // each appearing in the recording delayed by the injected delay.
  const click = calibrate.makeClickSamples(sr);
  const totalSeconds = 0.5 + 5 * 0.6 + 0.5 + 0.5;
  const samples = new Float32Array(Math.ceil(totalSeconds * sr));
  const scheduledTimes = [];
  for (let i = 0; i < 5; i++) {
    const t = 0.5 + i * 0.6;
    scheduledTimes.push(t);
    const at = Math.round(t * sr) + injectedDelaySamples;
    for (let j = 0; j < click.length; j++) samples[at + j] += click[j];
  }
  // A little room noise so the test is not trivially clean.
  for (let i = 0; i < samples.length; i++) samples[i] += (Math.random() - 0.5) * 0.002;

  const result = calibrate.measureDelays(samples, sr, scheduledTimes, 0);
  check('calibration: ok', result.ok === true, result.error || '');
  check('calibration: detected 5 of 5', result.detected === 5, 'detected=' + result.detected);
  const errMs = Math.abs(result.medianMs - injectedDelayMs);
  check('calibration: median matches injected delay within 1 ms',
    errMs <= 1, 'measured=' + result.medianMs.toFixed(2) + ' ms, injected=' + injectedDelayMs + ' ms');
  check('calibration: all 5 delays cluster within 1 ms',
    Math.max(...result.delaysMs) - Math.min(...result.delaysMs) <= 1,
    'delays=' + result.delaysMs.map((d) => d.toFixed(2)).join(', '));

  // Edge: only 2 clicks heard → must fail with the plain-words message.
  const quiet = new Float32Array(samples.length);
  for (let i = 0; i < 2; i++) {
    const at = Math.round(scheduledTimes[i] * sr) + injectedDelaySamples;
    for (let j = 0; j < click.length; j++) quiet[at + j] += click[j];
  }
  const few = calibrate.measureDelays(quiet, sr, scheduledTimes, 0);
  check('calibration: 2 of 5 heard fails', few.ok === false && few.detected === 2,
    'detected=' + few.detected);

  // Edge: delay outside 5–600 ms that lands in NO window (550 ms —
  // past the 500 ms search window, before the next click's window at
  // 600 ms) → the clicks are not heard, the run fails.
  const gap = new Float32Array(Math.ceil(6 * sr));
  const gapDelay = Math.round(0.55 * sr); // 550 ms — falls in the gap
  for (let i = 0; i < 5; i++) {
    const at = Math.round(scheduledTimes[i] * sr) + gapDelay;
    for (let j = 0; j < click.length; j++) gap[at + j] += click[j];
  }
  const notHeard = calibrate.measureDelays(gap, sr, scheduledTimes, 0);
  check('calibration: 550 ms delay (in the window gap) is not heard',
    notHeard.ok === false && notHeard.detected === 0, 'detected=' + notHeard.detected);
  // NOTE (known limitation, shared with the native app): a delay over
  // 600 ms aliases into the NEXT click's search window (the clicks are
  // identical, 0.6 s apart) and reads as (delay − 600 ms). Real
  // Bluetooth delay is 100–300 ms, far from the aliasing zone, so this
  // does not matter in practice — but a 900 ms delay would measure as
  // 300 ms, not reject. The 5–600 ms bounds catch delays that land in
  // their own window; the aliasing case is documented, not fixed.

  // Same test at 44.1 kHz (the rate iOS Safari typically grants) —
  // the block math must work at both rates.
  const sr441 = 44100;
  const click441 = calibrate.makeClickSamples(sr441);
  const samples441 = new Float32Array(Math.ceil(totalSeconds * sr441));
  const delay441 = Math.round(0.234 * sr441); // 234 ms
  for (let i = 0; i < 5; i++) {
    const at = Math.round(scheduledTimes[i] * sr441) + delay441;
    for (let j = 0; j < click441.length; j++) samples441[at + j] += click441[j];
  }
  const r441 = calibrate.measureDelays(samples441, sr441, scheduledTimes, 0);
  check('calibration: 44.1 kHz, 234 ms delay within 1 ms',
    r441.ok === true && Math.abs(r441.medianMs - 234) <= 1,
    'measured=' + (r441.medianMs === null ? 'null' : r441.medianMs.toFixed(2)) + ' ms');

  // Edge: silence → must fail, not crash.
  const silent = calibrate.measureDelays(new Float32Array(Math.ceil(4 * sr)), sr, scheduledTimes, 0);
  check('calibration: silence fails cleanly', silent.ok === false && silent.detected === 0, '');
})();

// ---------------------------------------------------------------- 2. Residual verifier
(function testResidual() {
  const sr = 48000;

  // Synthetic beat: kick hits every 0.5 s (a 40 ms burst), 10 s long.
  function makeBeat(seconds) {
    const samples = new Float32Array(Math.ceil(seconds * sr));
    for (let t = 0.5; t < seconds; t += 0.5) {
      const at = Math.round(t * sr);
      const len = Math.round(0.04 * sr);
      for (let j = 0; j < len; j++) {
        samples[at + j] += Math.sin(2 * Math.PI * 60 * j / sr) * 0.9 * (1 - j / len);
      }
    }
    return samples;
  }
  // Synthetic vocal: phrase starts (200 ms bursts) at given times.
  function makeVocal(phraseTimes, seconds) {
    const samples = new Float32Array(Math.ceil(seconds * sr));
    for (const t of phraseTimes) {
      const at = Math.round(t * sr);
      const len = Math.round(0.2 * sr);
      for (let j = 0; j < len; j++) {
        samples[at + j] += Math.sin(2 * Math.PI * 220 * j / sr) * 0.5;
      }
    }
    return samples;
  }

  const beat = makeBeat(10);
  // Phrases on the grid (1.0, 2.0, 3.0, 4.0, 5.0 s) but the whole
  // vocal is 120 ms late — the residual the check must find.
  const lateBy = 0.12;
  const vocalLate = makeVocal([1.0 + lateBy, 2.0 + lateBy, 3.0 + lateBy, 4.0 + lateBy, 5.0 + lateBy], 10);
  const r1 = residual.verify(vocalLate, beat, 0, sr);
  check('residual: 120 ms late → applied', r1.verdict === 'applied', 'verdict=' + r1.verdict);
  check('residual: measured offset within 10 ms of 120 ms',
    r1.residualSeconds !== null && Math.abs(r1.residualSeconds - lateBy) <= 0.01,
    'measured=' + (r1.residualSeconds * 1000).toFixed(1) + ' ms');
  check('residual: trim equals the median offset',
    r1.trimSamples === Math.round(r1.residualSeconds * sr),
    'trimSamples=' + r1.trimSamples);
  check('residual: 5 onsets used', r1.onsetCount === 5, 'onsetCount=' + r1.onsetCount);

  // On time (within 15 ms) → within-tolerance, trims nothing.
  const vocalOnTime = makeVocal([1.0, 2.0, 3.0, 4.0, 5.0], 10);
  const r2 = residual.verify(vocalOnTime, beat, 0, sr);
  check('residual: on time → within-tolerance, no trim',
    r2.verdict === 'within-tolerance' && r2.trimSamples === 0, 'verdict=' + r2.verdict);

  // Early by 120 ms → recorded, never corrected.
  const vocalEarly = makeVocal([1.0 - lateBy, 2.0 - lateBy, 3.0 - lateBy, 4.0 - lateBy, 5.0 - lateBy], 10);
  const r3 = residual.verify(vocalEarly, beat, 0, sr);
  check('residual: 120 ms early → early-not-corrected, no trim',
    r3.verdict === 'early-not-corrected' && r3.trimSamples === 0, 'verdict=' + r3.verdict);

  // Too few onsets → unverified.
  const vocalTwo = makeVocal([1.0 + lateBy, 2.0 + lateBy], 10);
  const r4 = residual.verify(vocalTwo, beat, 0, sr);
  check('residual: 2 onsets → unverified-too-few-onsets',
    r4.verdict === 'unverified-too-few-onsets', 'verdict=' + r4.verdict);

  // Onsets disagree (scattered offsets) → unverified-onsets-disagree.
  const vocalScatter = makeVocal([1.0 + 0.02, 2.0 + 0.15, 3.0 + 0.05, 4.0 + 0.22, 5.0 + 0.01], 10);
  const r5 = residual.verify(vocalScatter, beat, 0, sr);
  check('residual: scattered offsets → unverified-onsets-disagree',
    r5.verdict === 'unverified-onsets-disagree', 'verdict=' + r5.verdict);

  // Base trim shifts the vocal into aligned coordinates: a vocal that
  // is on time AFTER a 1 s lead-in trim must read within-tolerance.
  const vocalWithLeadIn = makeVocal([2.0, 3.0, 4.0, 5.0, 6.0], 10); // phrases at 2–6 s raw
  const beatShifted = makeBeat(10); // hits at 0.5, 1.0, ... — phrases land on hits after a 1 s trim
  const r6 = residual.verify(vocalWithLeadIn, beatShifted, Math.round(1.0 * sr), sr);
  check('residual: base trim applied before matching',
    r6.verdict === 'within-tolerance', 'verdict=' + r6.verdict + ', residual=' +
    (r6.residualSeconds === null ? 'null' : (r6.residualSeconds * 1000).toFixed(1) + ' ms'));

  // Silence on both sides → unverified, no crash.
  const r7 = residual.verify(new Float32Array(sr * 5), new Float32Array(sr * 5), 0, sr);
  check('residual: silence → unverified-too-few-onsets',
    r7.verdict === 'unverified-too-few-onsets', 'verdict=' + r7.verdict);
})();

// ---------------------------------------------------------------- 3. WAV round-trip
(function testWav() {
  const sr = 44100;
  const samples = new Float32Array(sr * 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.5;
  }
  const encoded = wav.encodeWavFloat32(samples, sr);
  check('wav: encoded size is 44 + 4*frames', encoded.byteLength === 44 + samples.length * 4,
    'bytes=' + encoded.byteLength);
  const decoded = wav.decodeWavFloat32(encoded);
  check('wav: decodes back', decoded !== null && decoded.sampleRate === sr, '');
  let maxErr = 0;
  for (let i = 0; i < samples.length; i++) {
    maxErr = Math.max(maxErr, Math.abs(decoded.samples[i] - samples[i]));
  }
  check('wav: float32 round-trip is bit-exact', maxErr === 0, 'maxErr=' + maxErr);
  check('wav: garbage input returns null', wav.decodeWavFloat32(new ArrayBuffer(100)) === null, '');
})();

// ---------------------------------------------------------------- 4. Pre-comp trim arithmetic
(function testPrecompTrim() {
  // Model from MATH.md, checked against AudioEngineManager.finishTake:
  //   baseTrim = preComp ? leadIn : leadIn + delay
  //   totalTrim = baseTrim + residualTrim, clamped to the file length.
  function baseTrim(preComp, leadInSamples, delaySamples) {
    return preComp ? leadInSamples : leadInSamples + delaySamples;
  }
  const sr = 48000;
  const leadIn = Math.round(1.0 * sr); // ~1 s lead-in
  const delay = Math.round(0.187 * sr); // 187 ms measured D
  check('pre-comp: ON → trim is lead-in only',
    baseTrim(true, leadIn, delay) === leadIn, '');
  check('pre-comp: OFF → trim is lead-in + delay',
    baseTrim(false, leadIn, delay) === leadIn + delay, '');
  // The exactness check from MATH.md §3: with pre-comp, the vocal for
  // beat-time t lands at A + t in the recording, so trimming the
  // lead-in (A − F0) puts beat-time 0 at file sample 0.
  const F0 = 100000; // first recorded sample, render frames
  const A = F0 + leadIn; // anchor frame
  const vocalFrameForBeatTime0 = A; // lands exactly at the anchor
  check('pre-comp: vocal for beat-time 0 lands at the anchor, trim puts it at 0',
    vocalFrameForBeatTime0 - (A - F0) - F0 === 0, '');
  // Guard: pre-comp only if D < anchorDelay − 0.1 s = 1.1 s.
  const anchorDelay = 1.2;
  check('pre-comp: guard allows D = 0.6 s', 0.6 < anchorDelay - 0.1, '');
  check('pre-comp: guard refuses D = 1.15 s', !(1.15 < anchorDelay - 0.1), '');
})();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
