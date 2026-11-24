/* audio.js — the Web Audio engine for the Phone Studio PWA.
 *
 * Port of AudioEngineManager + LatencyCalibrator + AudioSessionManager
 * from the native app, on the Web Audio render timeline:
 *
 * - One AudioContext. The mic comes in through getUserMedia +
 *   AudioWorklet (raw PCM, no processing). The beat plays through
 *   AudioBufferSourceNodes scheduled on ctx.currentTime.
 * - Input and output share the render timeline (worklet currentTime),
 *   so the calibration measurement and the pre-compensation math are
 *   identical to native — see MATH.md. No wall clock anywhere.
 * - getUserMedia constraints ask for RAW audio: echoCancellation,
 *   noiseSuppression, and autoGainControl all off. Safari may still
 *   process the signal; the mic test (frequency content) is the proof.
 * - Safari CANNOT select the input device. If iOS routes the mic to
 *   the Bluetooth headset (HFP), the recording is low-quality. The app
 *   carries a plain-words warning about this (see app.js); no hacks
 *   are attempted to force the input.
 *
 * Loads in the browser as window.PS.audio.
 */
(function (root, factory) {
  var api = factory(root.PS || {});
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.audio = api;
  }
})(typeof self !== 'undefined' ? self : this, function (PS) {
  'use strict';

  // Anchor offset: the beat starts this far after the first recorded
  // sample. ~1.2 s of lead-in (clean room noise before the beat) —
  // the pipeline measures its noise floor from it. (Native:
  // anchorDelay = 1.2 s, ~0.2 s tap settle + ~1.0 s lead-in.)
  var ANCHOR_DELAY = 1.2;
  // Pre-compensation guard (native: D < anchorDelay − 0.1 s).
  var PRECOMP_GUARD = ANCHOR_DELAY - 0.1;
  // How long to wait for the mic to start flowing before giving up.
  var FIRST_BLOCK_TIMEOUT_MS = 3000;
  // Nominal round-trip latency used when no acoustic calibration
  // exists (wired/speaker, or uncalibrated Bluetooth). The native app
  // reads this from AVAudioSession; the web has no input-latency API,
  // so this is outputLatency when the browser reports it, plus a
  // 10 ms input allowance, floored at 20 ms. It is a FALLBACK only —
  // the take is flagged uncalibrated and the residual check measures
  // what is left.
  var NOMINAL_FLOOR = 0.02;
  var NOMINAL_INPUT_ALLOWANCE = 0.01;

  var ctx = null;
  var workletReady = false;
  var stream = null;
  var sourceNode = null;
  var workletNode = null;

  // Capture state (one capture at a time — calibration or take).
  var capture = null; // { blocks, firstTime, totalFrames, onBlock, waiters }

  function sampleRate() {
    return ctx ? ctx.sampleRate : 0;
  }

  /* Creates (on first call) and resumes the AudioContext. Must be
   * called from a user gesture on iOS Safari, or the context stays
   * suspended. Loads the worklet module once.
   */
  function ensureContext() {
    if (ctx) {
      if (ctx.state === 'suspended') return ctx.resume().then(function () { return ctx; });
      return Promise.resolve(ctx);
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('This browser cannot do audio recording.'));
    ctx = new AC();
    var resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    return resume.then(function () {
      if (workletReady) return ctx;
      return ctx.audioWorklet.addModule('worklet.js').then(function () {
        workletReady = true;
        return ctx;
      });
    });
  }

  /* Opens the mic with raw-audio constraints (no echo cancellation,
   * no noise suppression, no automatic gain). Keeps the stream open
   * across takes so the user is asked once.
   */
  function ensureMic() {
    if (stream && stream.active) return Promise.resolve(stream);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('This browser cannot open the microphone.'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    }).then(function (s) {
      stream = s;
      return s;
    });
  }

  function ensureGraph() {
    return ensureContext().then(function () {
      return ensureMic();
    }).then(function () {
      if (!sourceNode) {
        sourceNode = ctx.createMediaStreamSource(stream);
        workletNode = new AudioWorkletNode(ctx, 'recorder-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1
        });
        workletNode.port.onmessage = onWorkletMessage;
        sourceNode.connect(workletNode);
      }
      return ctx;
    });
  }

  function onWorkletMessage(event) {
    var data = event.data;
    if (!capture || !data || data.type !== 'block') return;
    if (capture.firstTime === null) {
      capture.firstTime = data.time;
      var waiters = capture.waiters;
      capture.waiters = [];
      waiters.forEach(function (w) { w(); });
    }
    capture.blocks.push(data);
    capture.totalFrames += data.samples.length;
    if (capture.onBlock) capture.onBlock(data);
  }

  /* Starts a capture run. onBlock receives each batch
   * { time, samples, peak } as it arrives. Returns a promise that
   * resolves with the capture handle once the first block has arrived
   * (so the caller knows the mic is actually flowing) — or rejects if
   * no block arrives within FIRST_BLOCK_TIMEOUT_MS.
   */
  function startCapture(onBlock) {
    return ensureGraph().then(function () {
      if (capture) return Promise.reject(new Error('A recording is already running.'));
      capture = { blocks: [], firstTime: null, totalFrames: 0, onBlock: onBlock || null, waiters: [] };
      workletNode.port.postMessage({ type: 'start' });
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          stopCapture();
          reject(new Error('The mic did not start. Check that Safari is allowed to use the microphone, then try again.'));
        }, FIRST_BLOCK_TIMEOUT_MS);
        capture.waiters.push(function () {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(capture);
        });
      });
    });
  }

  /* Stops the capture and returns everything recorded:
   * { samples: Float32Array, firstSampleTime, totalFrames }.
   * firstSampleTime is the render-clock time of samples[0].
   */
  function stopCapture() {
    if (workletNode) workletNode.port.postMessage({ type: 'stop' });
    var c = capture;
    capture = null;
    if (!c) return { samples: new Float32Array(0), firstSampleTime: null, totalFrames: 0 };
    var samples = new Float32Array(c.totalFrames);
    var offset = 0;
    for (var i = 0; i < c.blocks.length; i++) {
      samples.set(c.blocks[i].samples, offset);
      offset += c.blocks[i].samples.length;
    }
    return { samples: samples, firstSampleTime: c.firstTime, totalFrames: c.totalFrames };
  }

  function isCapturing() {
    return capture !== null;
  }

  /* The session's nominal round-trip latency (fallback / cross-check
   * only). See NOMINAL_FLOOR above.
   */
  function nominalLatency() {
    var out = 0;
    if (ctx && typeof ctx.outputLatency === 'number' && isFinite(ctx.outputLatency)) {
      out = ctx.outputLatency;
    }
    return Math.max(NOMINAL_FLOOR, out + NOMINAL_INPUT_ALLOWANCE);
  }

  /* Decodes an audio file (ArrayBuffer) to an AudioBuffer at the
   * context's sample rate, plus a mono mix for the residual check.
   * (decodeAudioData resamples to the context rate — the web
   * equivalent of BeatImporter converting to the engine rate.)
   */
  function decodeBeat(arrayBuffer) {
    return ensureContext().then(function () {
      return ctx.decodeAudioData(arrayBuffer);
    }).then(function (buffer) {
      var mono = new Float32Array(buffer.length);
      for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
        var data = buffer.getChannelData(ch);
        for (var i = 0; i < buffer.length; i++) mono[i] += data[i];
      }
      for (var j = 0; j < buffer.length; j++) mono[j] /= buffer.numberOfChannels;
      return { buffer: buffer, mono: mono, duration: buffer.duration, sampleRate: buffer.sampleRate };
    });
  }

  function decodeAudio(arrayBuffer) {
    return ensureContext().then(function () {
      return ctx.decodeAudioData(arrayBuffer);
    });
  }

  /* Builds a stereo AudioBuffer holding one calibration click in both
   * ears. (Port of LatencyCalibrator.makeClickBuffer — the click
   * samples come from PS.calibrate.)
   */
  function makeClickBuffer() {
    var sr = ctx.sampleRate;
    var click = PS.calibrate.makeClickSamples(sr);
    var buffer = ctx.createBuffer(2, click.length, sr);
    buffer.getChannelData(0).set(click);
    buffer.getChannelData(1).set(click);
    return buffer;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* Runs a full acoustic calibration: 5 clicks through the output,
   * recorded through the mic, median delay across the clicks heard.
   * onProgress(text) reports plain-words status. Returns the
   * calibrate.measureDelays result ({ ok, medianMs, medianSamples,
   * delaySeconds, delaysMs, detected, error }).
   * (Port of LatencyCalibrator.calibrate.)
   */
  function runCalibration(onProgress) {
    var C = PS.calibrate;
    var clickBuffer = null;
    var scheduledTimes = [];
    var players = [];
    function progress(text) {
      if (onProgress) onProgress(text);
    }
    progress('Playing 5 clicks — keep the headphones still…');
    return startCapture(null).then(function (cap) {
      clickBuffer = makeClickBuffer();
      // First click 0.5 s after the first recorded sample, then one
      // every 0.6 s. (Native schedules from the engine clock after
      // the tap starts; the first recorded sample is the same
      // reference point on the web.)
      var firstClickTime = cap.firstTime + C.FIRST_CLICK_DELAY;
      for (var i = 0; i < C.CLICK_COUNT; i++) {
        var at = firstClickTime + i * C.CLICK_SPACING;
        scheduledTimes.push(at);
        var player = ctx.createBufferSource();
        player.buffer = clickBuffer;
        player.connect(ctx.destination);
        player.start(at);
        players.push(player);
      }
      var totalWait = C.FIRST_CLICK_DELAY + C.CLICK_COUNT * C.CLICK_SPACING + C.SEARCH_WINDOW + 0.5;
      return sleep(totalWait * 1000);
    }).then(function () {
      players.forEach(function (p) { try { p.stop(); } catch (e) { /* already stopped */ } });
      players.forEach(function (p) { try { p.disconnect(); } catch (e) { /* ignore */ } });
      var recorded = stopCapture();
      progress('Measuring the delay…');
      if (recorded.firstSampleTime === null || recorded.samples.length === 0) {
        return {
          ok: false, medianMs: null, medianSamples: null, delaySeconds: null,
          delaysMs: [], detected: 0,
          error: 'The mic heard nothing. Make sure the headphones are next to the phone and the volume is up, then try again.'
        };
      }
      return C.measureDelays(recorded.samples, ctx.sampleRate, scheduledTimes, recorded.firstSampleTime);
    });
  }

  /* Starts a take. Options:
   *   beat: { buffer } | null — the decoded beat (plays at the anchor)
   *   overdubs: [AudioBuffer] — active takes of the other vocal tracks
   *   delaySeconds: number | null — the measured round-trip D (null
   *     when uncalibrated: pre-comp is off, nominal fallback applies)
   *   onBlock: fn(batch) — level meter updates
   *
   * Returns a promise resolving to the take handle:
   *   { anchorTime, firstSampleTime, preCompActive, delaySeconds,
   *     playbackTime }
   * The anchor is the time the singer HEARS the beat start:
   * firstSampleTime + 1.2 s. When pre-comp is on, the beat (and the
   * overdubs) are scheduled EARLY by D, so they arrive at the singer's
   * ears exactly on the anchor (see MATH.md). The guard refuses
   * pre-comp when D >= 1.1 s (never schedules in the past).
   * (Port of AudioEngineManager.beginTake.)
   */
  function startTake(options) {
    var opts = options || {};
    var players = [];
    var handle = null;
    return startCapture(opts.onBlock || null).then(function (cap) {
      var anchorTime = cap.firstTime + ANCHOR_DELAY;
      var delaySeconds = (typeof opts.delaySeconds === 'number') ? opts.delaySeconds : null;
      var preCompActive = false;
      var playbackTime = anchorTime;
      if (delaySeconds !== null && delaySeconds < PRECOMP_GUARD) {
        preCompActive = true;
        playbackTime = anchorTime - delaySeconds;
      }
      function schedule(buffer) {
        var player = ctx.createBufferSource();
        player.buffer = buffer;
        player.connect(ctx.destination);
        player.start(playbackTime);
        players.push(player);
      }
      if (opts.beat && opts.beat.buffer) schedule(opts.beat.buffer);
      (opts.overdubs || []).forEach(schedule);
      handle = {
        anchorTime: anchorTime,
        firstSampleTime: cap.firstTime,
        preCompActive: preCompActive,
        delaySeconds: delaySeconds,
        playbackTime: playbackTime,
        players: players
      };
      return handle;
    });
  }

  /* Stops the take: stops the players, stops the capture, and returns
   * the recording plus the take handle's timing numbers.
   */
  function stopTake(handle) {
    if (handle && handle.players) {
      handle.players.forEach(function (p) {
        try { p.stop(); } catch (e) { /* already stopped */ }
        try { p.disconnect(); } catch (e) { /* ignore */ }
      });
    }
    var recorded = stopCapture();
    return {
      samples: recorded.samples,
      firstSampleTime: recorded.firstSampleTime,
      totalFrames: recorded.totalFrames,
      anchorTime: handle ? handle.anchorTime : null,
      preCompActive: handle ? handle.preCompActive : false,
      delaySeconds: handle ? handle.delaySeconds : null
    };
  }

  /* Plays one take against the beat, both from the same anchor, so
   * the singer hears exactly how the take sits in the song. (Port of
   * AudioEngineManager.playTake.) Returns a stop function.
   */
  function playTake(takeBuffer, beatBuffer, onEnded) {
    return ensureContext().then(function () {
      var anchor = ctx.currentTime + 0.1;
      var players = [];
      function schedule(buffer, isTake) {
        var player = ctx.createBufferSource();
        player.buffer = buffer;
        player.connect(ctx.destination);
        player.start(anchor);
        if (isTake && onEnded) player.onended = onEnded;
        players.push(player);
      }
      schedule(takeBuffer, true);
      if (beatBuffer) schedule(beatBuffer, false);
      return function stop() {
        players.forEach(function (p) {
          try { p.onended = null; p.stop(); } catch (e) { /* ignore */ }
          try { p.disconnect(); } catch (e) { /* ignore */ }
        });
      };
    });
  }

  return {
    ANCHOR_DELAY: ANCHOR_DELAY,
    PRECOMP_GUARD: PRECOMP_GUARD,
    sampleRate: sampleRate,
    ensureContext: ensureContext,
    ensureMic: ensureMic,
    nominalLatency: nominalLatency,
    decodeBeat: decodeBeat,
    decodeAudio: decodeAudio,
    runCalibration: runCalibration,
    startTake: startTake,
    stopTake: stopTake,
    playTake: playTake,
    isCapturing: isCapturing,
    // Bare capture (no beat scheduling) — the mic test uses it.
    startCapture: startCapture,
    stopCapture: stopCapture,
    currentTime: function () { return ctx ? ctx.currentTime : 0; }
  };
});
