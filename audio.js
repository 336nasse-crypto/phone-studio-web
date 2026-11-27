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
 *   The settings actually applied are read back with
 *   track.getSettings() on every take and logged (Step 1B).
 * - Safari CANNOT select the input device. If iOS routes the mic to
 *   the Bluetooth headset (HFP), the recording is low-quality. The app
 *   carries a plain-words warning about this (see app.js); no hacks
 *   are attempted to force the input.
 * - The mic is open ONLY while something needs it (a take, a
 *   calibration, the live monitor, the ideas logger). Afterwards the
 *   track is stopped and the AudioSession is cycled back to playback
 *   then auto, so review plays at full quality (Step 1B): with the
 *   mic open, iOS lowers the output sample rate and folds stereo to
 *   mono (WebKit 311451). Re-opening the mic later re-uses the
 *   already-granted permission — no second prompt on iOS Safari.
 * - AudioSession routing guard (Step 1B): before/right after
 *   getUserMedia(), the session type cycles auto -> play-and-record
 *   so iOS locks playback to the headphones; on stop it goes
 *   playback -> auto so iOS exits HFP/VPIO and restores full-
 *   bandwidth A2DP stereo. Safari's AudioSession API implements
 *   only `type` (no `state` — WebKit 283417). AudioContext.state is
 *   NOT watched for interruptions — the block flow is (v41, QUEUE
 *   #42): capture.lastBlockAt stamps every worklet block, and
 *   app.js ends the take flagged 'audio-interrupted' when no block
 *   arrives for > 2 s.
 * - Takes are written to storage in 48,000-sample chunks WHILE
 *   recording (Step 1B): the onChunk callback fires once per chunk,
 *   so a killed take is recoverable from its chunks.
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
  // v36 (QUEUE #34): how long stopCapture waits for the worklet's
  // 'flushed' ack after posting 'stop' — the ack lands ~one render
  // quantum later (~2.7 ms); 100 ms is ~37 quanta of headroom, and
  // past it the save assembles from the blocks already in hand
  // instead of hanging the take on a lost message.
  var STOP_DRAIN_TIMEOUT_MS = 100;
  // Nominal round-trip latency used when no acoustic calibration
  // exists (wired/speaker, or uncalibrated Bluetooth). The native app
  // reads this from AVAudioSession; the web has no input-latency API,
  // so this is outputLatency when the browser reports it, plus a
  // 10 ms input allowance, floored at 20 ms. It is a FALLBACK only —
  // the take is flagged uncalibrated and the residual check measures
  // what is left.
  var NOMINAL_FLOOR = 0.02;
  var NOMINAL_INPUT_ALLOWANCE = 0.01;
  // Chunked-write size (Step 1B): one chunk per ~1 s at 48 kHz.
  // Must match PS.safety.CHUNK_SAMPLES (kept as a local constant
  // so this module has no load-order dependency on safety.js).
  var PS_CHUNK_SAMPLES = 48000;

  var ctx = null;
  var workletReady = false;
  var masterGain = null; // one gain for all PLAYBACK — fixed at full (v40, QUEUE #124: the master slider is gone; the phone's hardware buttons are the overall volume)
  var monitorGain = null; // B2 (v13.1): the live monitor's own gain, fixed at full like the master — one loudness everywhere he hears sound
  var volumeLevel = 1; // v40: fixed at full — setVolume is gone (QUEUE #124); the level is remembered only so the gain nodes are built at 1.0
  // v40 (QUEUE #124): one gain per layer kind ('lead', 'adlibs',
  // 'harmonies', 'extra1'..., 'beat') — every playback player
  // connects through its own layer's gain into masterGain, so one
  // layer can be made louder than another. Built on demand the
  // first time the layer plays; the level lives in layerLevels
  // (kind -> percent, 0..150, default 100), seeded by the app from
  // the session at boot / song switch, so a tap rebalances live.
  var layerGains = {};
  var layerLevels = {};
  var stream = null;
  var sourceNode = null;
  var workletNode = null;
  var micSettingsCache = null; // last track.getSettings() reading
  var micTrackLabel = ''; // v13.2 (item 4): the mic track's label (device name), cached when the mic opens
  var sessionLog = []; // AudioSession type transitions (for take metadata)

  // Capture state (one capture at a time — calibration or take).
  // v36 (QUEUE #34): stopping/stopPromise/stopResolve/stopTimer/
  // stopDone are the stop drain — stopCapture keeps the capture
  // alive in a 'stopping' state until the worklet's 'flushed' ack
  // (or the drain timeout) instead of nulling it synchronously and
  // dropping the final partial batch.
  var capture = null; // { blocks, firstTime, totalFrames, onBlock, waiters, chunkBuf, chunkFill, chunkIndex, onChunk, stopping, stopPromise, stopResolve, stopTimer, stopDone }

  function sampleRate() {
    return ctx ? ctx.sampleRate : 0;
  }

  /* Creates (on first call) and resumes the AudioContext. Must be
   * called from a user gesture on iOS Safari, or the context stays
   * suspended. Loads the worklet module once.
   */
  function ensureContext() {
    // The worklet module must load whenever it has not loaded yet —
    // even if the context already exists. (The decode path creates
    // the context without the worklet; the old code returned early
    // on an existing context and the worklet never loaded, so every
    // record / mic-test / calibration failed with "No
    // ScriptProcessor was registered with this name".)
    var ready;
    if (ctx) {
      ready = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    } else {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return Promise.reject(new Error('This browser cannot do audio recording.'));
      ctx = new AC();
      ready = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    }
    return ready.then(function () {
      if (workletReady) return ctx;
      return ctx.audioWorklet.addModule('worklet.js').then(function () {
        workletReady = true;
        return ctx;
      });
    }).then(function () {
      // The master gain for playback: built once, fed by every
      // layer gain (v40 — the per-layer gains feed this, not the
      // players directly). B2 (v13.1): the live monitor gets its
      // own gain at the SAME level — fixed at full, like the
      // master. The calibration clicks stay direct: they are a
      // measurement, not a sound he listens to.
      if (!masterGain) {
        masterGain = ctx.createGain();
        masterGain.gain.value = volumeLevel;
        masterGain.connect(ctx.destination);
      }
      if (!monitorGain) {
        monitorGain = ctx.createGain();
        monitorGain.gain.value = volumeLevel;
        monitorGain.connect(ctx.destination);
      }
      return ctx;
    });
  }

  /* Per-layer volume (v40, QUEUE #124): each layer's own gain into
   * masterGain. Safe to call before the context exists for the
   * level setters (the level is remembered and applied when the
   * gain node is built); layerGainFor returns null with no context.
   */
  function layerGainFor(kind) {
    var k = kind || 'lead';
    if (!ctx) return null;
    if (!layerGains[k]) {
      var g = ctx.createGain();
      g.gain.value = layerLevel(k) / 100;
      g.connect(masterGain || ctx.destination);
      layerGains[k] = g;
    }
    return layerGains[k];
  }

  function setLayerLevel(kind, pct) {
    var k = kind || 'lead';
    var v = Math.max(0, Math.min(150, Math.round(Number(pct) || 0)));
    layerLevels[k] = v;
    if (layerGains[k]) layerGains[k].gain.value = v / 100;
    return v;
  }

  function layerLevel(kind) {
    var k = kind || 'lead';
    return (typeof layerLevels[k] === 'number') ? layerLevels[k] : 100;
  }

  function setLayerLevels(map) {
    if (!map) return;
    Object.keys(map).forEach(function (k) { setLayerLevel(k, map[k]); });
  }

  /* The live gain value for a layer (the AudioParam the players run
   * through) — the stored level / 100 when the node does not exist
   * yet. The CDP suite reads this, not the stored number, so the
   * test proves the graph itself moves, not just the label.
   */
  function layerGainValue(kind) {
    var k = kind || 'lead';
    if (layerGains[k]) return layerGains[k].gain.value;
    return layerLevel(k) / 100;
  }

  /* The node playback players connect to: the master gain once the
   * context exists, the raw destination before that (callers only
   * use it after ensureContext, so the gain is the normal case).
   */
  function outputNode() {
    if (masterGain) return masterGain;
    return ctx ? ctx.destination : null;
  }

  /* B2 (v13.1): the node the live monitor connects to — its own
   * gain, tied to the same volume level as playback. Before the
   * context exists, the raw destination (callers only use it
   * after ensureContext, so the gain is the normal case).
   */
  function monitorNode() {
    if (monitorGain) return monitorGain;
    return ctx ? ctx.destination : null;
  }

  /* Creates the audio context for DECODING only — never resumes it
   * and never loads the worklet. decodeAudioData is an offline
   * operation: it works fine on a suspended context. On iOS Safari,
   * ctx.resume() outside a tap returns a promise that never settles,
   * which used to hang the beat import silently after the file
   * picker closed (the tap that opened the picker is long gone by
   * the time the file comes back — and the file picker's own tap is
   * not a web-page gesture). Live paths (mic, record, play) still
   * use ensureContext(), which resumes on a real tap.
   */
  function ensureDecodeContext() {
    if (ctx) return Promise.resolve(ctx);
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('This browser cannot do audio recording.'));
    ctx = new AC();
    return Promise.resolve(ctx);
  }

  /* AudioSession routing guard (Step 1B). Safari implements only
   * `navigator.audioSession.type`. No-op (logged) where the API
   * does not exist — the guard must never throw.
   */
  function setAudioSessionType(type) {
    try {
      if (navigator.audioSession && typeof navigator.audioSession.type !== 'undefined') {
        navigator.audioSession.type = type;
        sessionLog.push({ type: type, at: new Date().toISOString() });
        if (sessionLog.length > 20) sessionLog.shift();
      }
    } catch (err) {
      console.warn('AudioSession type could not be set to ' + type + ':', err);
    }
  }

  function audioSessionLog() {
    return sessionLog.slice();
  }

  /* v35 (QUEUE #32): who to tell when the mic track dies. The
   * app registers one handler (app.js, next to the
   * visibilitychange listener); audio.js owns the track, so it
   * owns the firing. Null until registered.
   */
  var micEndedHandler = null;

  function onMicEnded(fn) {
    micEndedHandler = (typeof fn === 'function') ? fn : null;
  }

  /* v35 (QUEUE #32): is the mic track still live? The polled
   * backstop in app.js updateRecordTimer reads this every 100 ms
   * while a take runs. False when there is no mic, the stream is
   * inactive, or no audio track is live.
   */
  function micAlive() {
    if (!stream || !stream.active) return false;
    var tracks = stream.getAudioTracks();
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].readyState === 'live') return true;
    }
    return false;
  }

  /* v41 (QUEUE #42): when the last capture block arrived, or null
   * when no capture is running / no block has arrived yet. The
   * liveness watchdog in app.js updateRecordTimer reads this every
   * 100 ms — a live mic track with no blocks for > 2 s is a stalled
   * take, not a dead mic.
   */
  function captureLastBlockAt() {
    return capture ? capture.lastBlockAt : null;
  }

  /* v35 (QUEUE #32): the current mic track, or null. The CDP
   * suite ends it to prove the guard; the app never stops a
   * track through this (closeMic owns that).
   */
  function micTrack() {
    if (!stream) return null;
    var tracks = stream.getAudioTracks();
    return tracks.length ? tracks[0] : null;
  }

  /* Opens the mic with raw-audio constraints (no echo cancellation,
   * no noise suppression, no automatic gain). Verifies the settings
   * actually applied via track.getSettings() and logs them (Step 1B)
   * — Safari may silently apply processing the constraints asked it
   * not to. Locks the session to play-and-record so iOS keeps
   * playback on the headphones.
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
      var track = s.getAudioTracks()[0];
      // v35 (QUEUE #32): the mic can die mid-take (Bluetooth
      // disconnect, another app grabbing the mic, an iOS route
      // change) and the worklet would keep emitting silence with
      // nothing noticing. Attach the end handler at open — the
      // only moment the track exists. Fires once per track:
      // track.onended and stream.oninactive report the same death,
      // and closeMic's own stop() fires onended too (the app
      // handler no-ops then — nothing is recording).
      var micEndedFired = false;
      var fireMicEnded = function () {
        if (micEndedFired) return;
        micEndedFired = true;
        if (micEndedHandler) {
          try { micEndedHandler(); } catch (e) { console.warn('Mic-ended handler failed:', e); }
        }
      };
      if (track) track.onended = fireMicEnded;
      try { s.oninactive = fireMicEnded; } catch (e) { /* older browsers may not allow it */ }
      // v13.2 (item 4): the track label names the mic ("AirPods
      // Pro", "iPhone Microphone", "Microphone" when the browser
      // cannot name it). Cached here, at open — it is the only
      // moment the label is reliably available.
      micTrackLabel = (track && track.label) || '';
      if (track && track.getSettings) {
        try {
          micSettingsCache = track.getSettings();
        } catch (err) {
          micSettingsCache = null;
        }
      }
      if (micSettingsCache) {
        console.log('Mic settings:', JSON.stringify(micSettingsCache));
        if (micSettingsCache.echoCancellation === true) {
          console.warn('Mic echoCancellation is ON despite the raw constraints — the take may be processed.');
        }
      }
      setAudioSessionType('play-and-record');
      return s;
    });
  }

  /* The last verified mic settings (track.getSettings()), or null
   * when the mic has never been opened.
   */
  function micSettings() {
    return micSettingsCache ? JSON.parse(JSON.stringify(micSettingsCache)) : null;
  }

  /* B9 (v13.1): did the phone process the mic despite the raw
   * constraints? True when ANY of echo cancellation, noise
   * suppression, or automatic gain is actually on in the last
   * verified settings — the take may sound different from what
   * the app asked for. The take sheet says so in plain words.
   */
  function micProcessed() {
    if (!micSettingsCache) return false;
    return micSettingsCache.echoCancellation === true ||
      micSettingsCache.noiseSuppression === true ||
      micSettingsCache.autoGainControl === true;
  }

  /* v13.2 (item 4) — what mic recorded the take, in plain words.
   * The track label IS the identification (it names the device
   * once the mic is open — no device list needed). "Microphone"
   * and "Default" are the generic labels browsers report when
   * they cannot name the input, so they mean "cannot tell", not
   * "built-in". Only an iPhone-named input is called the built-in
   * mic. Anything else is the label itself (a product name).
   * Never guesses: an unnameable input says "input unknown".
   */
  function micLabelFromTrackLabel(label) {
    var l = (label || '').trim();
    if (!l) return 'input unknown';
    if (/iphone/i.test(l)) return 'built-in mic';
    if (l === 'Microphone' || l === 'Default') return 'input unknown';
    return l;
  }

  function micLabel() {
    return micLabelFromTrackLabel(micTrackLabel);
  }

  /* Closes the mic: stops every track and drops the graph so the
   * next open rebuilds it. No-op while a capture is running (the
   * caller must stop the capture first) and when the mic is already
   * closed. Cycles the session playback -> auto so iOS exits
   * HFP/VPIO and restores full-bandwidth A2DP stereo for review.
   */
  function closeMic() {
    if (capture) return false; // a live capture owns the mic
    if (!stream) return false;
    try {
      stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (err) { /* ignore */ }
    stream = null;
    sourceNode = null;
    workletNode = null;
    setAudioSessionType('playback');
    setTimeout(function () { setAudioSessionType('auto'); }, 500);
    return true;
  }

  function isMicOpen() {
    return !!(stream && stream.active);
  }

  function ensureGraph() {
    return ensureContext().then(function () {
      return ensureMic();
    }).then(function () {
      if (!sourceNode) {
        try {
          sourceNode = ctx.createMediaStreamSource(stream);
          workletNode = new AudioWorkletNode(ctx, 'recorder-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1
          });
          workletNode.port.onmessage = onWorkletMessage;
          sourceNode.connect(workletNode);
        } catch (err) {
          // A failed graph build must not leave a half-built graph
          // behind (source set, worklet null) — the next attempt
          // would skip the build and crash on workletNode.port.
          // Reset both so the next attempt retries from scratch.
          sourceNode = null;
          workletNode = null;
          throw err;
        }
      }
      return ctx;
    });
  }

  function onWorkletMessage(event) {
    var data = event.data;
    if (!data) return;
    if (data.type === 'flushed') {
      // v36 (QUEUE #34): the worklet's stop-flush landed — every
      // block it posted is already ahead of this ack on the same
      // port, so the drain is done and the stop can assemble.
      if (capture && capture.stopping) finishStopCapture(capture);
      return;
    }
    if (!capture || data.type !== 'block') return;
    // v41 (QUEUE #42): liveness stamp — every block refreshes it.
    // app.js updateRecordTimer reads it through
    // captureLastBlockAt: a live mic track with no blocks for > 2 s
    // is a stalled take (page-visible interruption, suspended
    // context, stalled worklet), not a dead mic — the micAlive poll
    // cannot see it.
    capture.lastBlockAt = Date.now();
    if (capture.firstTime === null) {
      capture.firstTime = data.time;
      var waiters = capture.waiters;
      capture.waiters = [];
      waiters.forEach(function (w) { w(); });
    }
    capture.blocks.push(data);
    capture.totalFrames += data.samples.length;
    if (capture.onBlock) capture.onBlock(data);
    // Chunked writes (Step 1B): every 48,000 samples (~1 s) is a
    // chunk, handed to the onChunk callback as soon as it is full —
    // so a take killed mid-record leaves its chunks on disk.
    if (capture.onChunk) {
      var samples = data.samples;
      var offset = 0;
      while (offset < samples.length) {
        var room = PS_CHUNK_SAMPLES - capture.chunkFill;
        var take = Math.min(room, samples.length - offset);
        capture.chunkBuf.set(samples.subarray(offset, offset + take), capture.chunkFill);
        capture.chunkFill += take;
        offset += take;
        if (capture.chunkFill >= PS_CHUNK_SAMPLES) {
          var chunk = capture.chunkBuf.slice();
          var index = capture.chunkIndex;
          capture.chunkIndex += 1;
          capture.chunkFill = 0;
          try {
            capture.onChunk(index, chunk);
          } catch (err) {
            console.warn('Chunk write callback failed:', err);
          }
        }
      }
    }
  }

  /* Starts a capture run. onBlock receives each batch
   * { time, samples, peak } as it arrives. opts.onChunk(index,
   * samples) receives each full 48,000-sample chunk as it fills
   * (Step 1B). Returns a promise that resolves with the capture
   * handle once the first block has arrived (so the caller knows
   * the mic is actually flowing) — or rejects if no block arrives
   * within FIRST_BLOCK_TIMEOUT_MS.
   */
  function startCapture(onBlock, opts) {
    return ensureGraph().then(function () {
      if (capture) {
        if (capture.stopping && capture.stopPromise) {
          // v36 (QUEUE #34): a stop is draining — wait for it, then
          // start fresh, instead of failing a record tap that lands
          // in the ~10 ms window between stop and drain. The drain
          // is ~one render quantum, so this is not a real wait.
          return capture.stopPromise.then(function () { return startCapture(onBlock, opts); });
        }
        return Promise.reject(new Error('A recording is already running.'));
      }
      if (!workletNode) return Promise.reject(new Error('The recorder could not start. Close the app and open it again.'));
      capture = {
        blocks: [], firstTime: null, totalFrames: 0, onBlock: onBlock || null, waiters: [],
        lastBlockAt: null, // v41 (QUEUE #42): stamped in onWorkletMessage, per block (the liveness watchdog reads it)
        chunkBuf: new Float32Array(PS_CHUNK_SAMPLES), chunkFill: 0, chunkIndex: 0,
        onChunk: (opts && opts.onChunk) || null,
        stopping: false, stopPromise: null, stopResolve: null, stopTimer: null, stopDone: false
      };
      try {
        workletNode.port.postMessage({ type: 'start' });
      } catch (err) {
        // Never leave a half-started capture behind — it blocks
        // every later attempt with "already running".
        capture = null;
        throw err;
      }
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

  /* Stops the capture and returns a promise of everything recorded:
   * { samples: Float32Array, firstSampleTime, totalFrames }.
   * firstSampleTime is the render-clock time of samples[0].
   *
   * v36 (QUEUE #34): the stop DRAINS. The old code posted 'stop'
   * and synchronously nulled the capture, so the worklet's flush of
   * its final partial 4096-frame batch arrived after capture was
   * null and onWorkletMessage dropped it — every take lost its last
   * 0–85 ms, by construction. Now the capture stays alive in a
   * 'stopping' state until the worklet's 'flushed' ack (or the
   * 100 ms drain timeout), the flush block lands in the capture,
   * and only then does the stop assemble. No padding, no synthesis
   * — the save waits for the real frames. A second stop while one
   * is draining waits on the same promise instead of starting a
   * second drain. The #32 liveness behavior is untouched: a dead
   * mic still finishes the take through this same stop, and the
   * drain timeout is the backstop when the worklet never acks.
   */
  function stopCapture() {
    var c = capture;
    if (!c) return Promise.resolve({ samples: new Float32Array(0), firstSampleTime: null, totalFrames: 0 });
    if (c.stopping) return c.stopPromise;
    c.stopping = true;
    if (workletNode) workletNode.port.postMessage({ type: 'stop' });
    c.stopPromise = new Promise(function (resolve) {
      c.stopResolve = resolve;
      c.stopTimer = setTimeout(function () { finishStopCapture(c); }, STOP_DRAIN_TIMEOUT_MS);
    });
    return c.stopPromise;
  }

  /* Assembles a stopping capture: flushes the final partial 1 s
   * chunk to disk first (the recovery copy keeps the tail — the old
   * code never flushed it, so a killed take recovered up to ~1 s
   * short), then builds the samples from the blocks. Runs once —
   * the 'flushed' ack and the drain timeout race, and whichever
   * fires second no-ops on stopDone. The chunk put is awaited
   * (500 ms cap) before resolving, so completeTakeSave's chunk
   * delete can never run ahead of the put and leave a phantom
   * recovery row behind on the next boot.
   */
  function finishStopCapture(c) {
    if (!c || c.stopDone) return;
    c.stopDone = true;
    if (c.stopTimer) { clearTimeout(c.stopTimer); c.stopTimer = null; }
    var chunkWritten = null;
    if (c.onChunk && c.chunkFill > 0) {
      var chunk = c.chunkBuf.slice(0, c.chunkFill);
      var index = c.chunkIndex;
      c.chunkIndex += 1;
      c.chunkFill = 0;
      try {
        chunkWritten = c.onChunk(index, chunk);
      } catch (err) {
        console.warn('Chunk write callback failed:', err);
      }
    }
    if (capture === c) capture = null;
    var samples = new Float32Array(c.totalFrames);
    var offset = 0;
    for (var i = 0; i < c.blocks.length; i++) {
      samples.set(c.blocks[i].samples, offset);
      offset += c.blocks[i].samples.length;
    }
    var result = { samples: samples, firstSampleTime: c.firstTime, totalFrames: c.totalFrames };
    if (chunkWritten && typeof chunkWritten.then === 'function') {
      var settled = false;
      var done = function () {
        if (settled) return;
        settled = true;
        if (c.stopResolve) c.stopResolve(result);
      };
      chunkWritten.then(done, done);
      setTimeout(done, 500); // the put is local IndexedDB — never hang the save on it
    } else if (c.stopResolve) {
      c.stopResolve(result);
    }
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
   * v24 (QUEUE #53): do NOT trust the browser to resample — the old
   * comment asserted decodeAudioData resamples to the context rate,
   * and Chromium does, but Safari is unverified and his phone runs
   * Safari. If the decoded beat arrives at its native rate, resample
   * the mono mix to the context rate explicitly (OfflineAudioContext
   * render, the same technique as makeSmallCopy) and stamp the
   * resampled rate — the residual check reads beat onsets at the
   * context rate, so a native-rate mono would mis-trim the take by
   * ~8% (a 120 ms-late vocal never corrected, an on-time take
   * flagged off-beat; auditor probe, cycle 66). The returned
   * `buffer` stays the decoded buffer (playback resamples it); only
   * `mono` — what the check and the key/tempo listeners read — is
   * forced to the context rate. If this browser cannot render
   * offline, the mono stays native and `sampleRate` says so
   * honestly — finishTake then refuses the check with
   * 'unverified-rate-mismatch' instead of verifying on mismatched
   * arrays. `resampledFrom` is the file's native rate when a
   * resample ran, else null.
   */
  function decodeBeat(arrayBuffer) {
    return ensureDecodeContext().then(function () {
      return ctx.decodeAudioData(arrayBuffer);
    }).then(function (buffer) {
      var mono = new Float32Array(buffer.length);
      for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
        var data = buffer.getChannelData(ch);
        for (var i = 0; i < buffer.length; i++) mono[i] += data[i];
      }
      for (var j = 0; j < buffer.length; j++) mono[j] /= buffer.numberOfChannels;
      if (buffer.sampleRate === ctx.sampleRate) {
        return { buffer: buffer, mono: mono, duration: buffer.duration, sampleRate: buffer.sampleRate, resampledFrom: null };
      }
      if (typeof OfflineAudioContext === 'undefined') {
        // Cannot resample here — report the true (native) rate so
        // the caller refuses the residual check instead of running
        // it on mismatched arrays.
        return { buffer: buffer, mono: mono, duration: buffer.duration, sampleRate: buffer.sampleRate, resampledFrom: null, resampleUnavailable: true };
      }
      var target = ctx.sampleRate;
      var nativeRate = buffer.sampleRate;
      var outLen = Math.max(1, Math.round(mono.length * target / nativeRate));
      var off = new OfflineAudioContext(1, outLen, target);
      var srcBuf = off.createBuffer(1, mono.length, nativeRate);
      srcBuf.getChannelData(0).set(mono);
      var src = off.createBufferSource();
      src.buffer = srcBuf;
      src.connect(off.destination);
      src.start(0);
      return off.startRendering().then(function (rendered) {
        return { buffer: buffer, mono: rendered.getChannelData(0), duration: rendered.length / target, sampleRate: target, resampledFrom: nativeRate };
      });
    });
  }

  function decodeAudio(arrayBuffer) {
    return ensureDecodeContext().then(function () {
      return ctx.decodeAudioData(arrayBuffer);
    });
  }

  /* B10 (v13.1): creates an AudioBuffer on the engine's own
   * context (which always exists by the time the app slices —
   * playback runs after ensureContext / ensureDecodeContext).
   * The app used to spin up a scratch AudioContext just to slice
   * buffers and never closed it; creating a buffer plays no
   * audio, so the shared context is the right place for it.
   */
  function createBuffer(numberOfChannels, length, sampleRate) {
    if (!ctx) throw new Error('Audio has not started yet.');
    return ctx.createBuffer(numberOfChannels, length, sampleRate);
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

  /* Runs a click test: N clicks through the output, recorded
   * through the mic, median delay across the clicks heard.
   * options: { count, spacingSeconds, firstDelaySeconds, onProgress,
   *   progressText } — the calibration (5 clicks, 0.6 s apart) and
   * the route lab's clap test (8 clicks at 90 BPM) are the same
   * measurement with different counts. Returns the
   * calibrate.measureDelays result ({ ok, medianMs, medianSamples,
   * delaySeconds, delaysMs, detected, error }).
   * (Port of LatencyCalibrator.calibrate, generalized.)
   */
  function runClickTest(options) {
    var opts = options || {};
    var count = opts.count || PS.calibrate.CLICK_COUNT;
    var spacing = opts.spacingSeconds || PS.calibrate.CLICK_SPACING;
    var firstDelay = (typeof opts.firstDelaySeconds === 'number')
      ? opts.firstDelaySeconds : PS.calibrate.FIRST_CLICK_DELAY;
    var C = PS.calibrate;
    var clickBuffer = null;
    var scheduledTimes = [];
    var players = [];
    function progress(text) {
      if (opts.onProgress) opts.onProgress(text);
    }
    progress(opts.progressText || ('Playing ' + count + ' clicks — keep the headphones still…'));
    return startCapture(null).then(function (cap) {
      clickBuffer = makeClickBuffer();
      // First click firstDelay s after the first recorded sample,
      // then one every spacing s. (Native schedules from the engine
      // clock after the tap starts; the first recorded sample is the
      // same reference point on the web.)
      var firstClickTime = cap.firstTime + firstDelay;
      for (var i = 0; i < count; i++) {
        var at = firstClickTime + i * spacing;
        scheduledTimes.push(at);
        var player = ctx.createBufferSource();
        player.buffer = clickBuffer;
        player.connect(ctx.destination);
        player.start(at);
        players.push(player);
      }
      var totalWait = firstDelay + count * spacing + C.SEARCH_WINDOW + 0.5;
      return sleep(totalWait * 1000);
    }).then(function () {
      players.forEach(function (p) { try { p.stop(); } catch (e) { /* already stopped */ } });
      players.forEach(function (p) { try { p.disconnect(); } catch (e) { /* ignore */ } });
      // v36 (QUEUE #34): the click test reads the drained capture —
      // the last click's tail is in the final partial batch.
      return stopCapture();
    }).then(function (recorded) {
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

  /* Runs a full acoustic calibration: 5 clicks through the output,
   * recorded through the mic, median delay across the clicks heard.
   * onProgress(text) reports plain-words status. Returns the
   * calibrate.measureDelays result. (Port of
   * LatencyCalibrator.calibrate.)
   */
  function runCalibration(onProgress) {
    return runClickTest({
      count: PS.calibrate.CLICK_COUNT,
      spacingSeconds: PS.calibrate.CLICK_SPACING,
      firstDelaySeconds: PS.calibrate.FIRST_CLICK_DELAY,
      onProgress: onProgress
    });
  }

  /* Starts a take. Options:
   *   beat: { buffer } | null — the decoded beat (plays at the anchor)
   *   overdubs: [{ buffer, sound }] — active takes of the other
   *     vocal tracks, each with its own stamped sound (B3, v13.1)
   *   tuneNodeFor: fn(ctx, sound, kind) — builds a playback tune node
   *     (v40: wired to the overdub's layer gain, not the master)
   *     for an overdub (supplied by the app, which owns the tune
   *     module); without it an overdub plays dry, as before
   *   delaySeconds: number | null — the measured round-trip D (null
   *     when uncalibrated: pre-comp is off, nominal fallback applies)
   *   onBlock: fn(batch) — level meter updates
   *   onChunk: fn(index, samples) — chunked-write callback (Step 1B):
   *     one 48,000-sample chunk per call, as it fills
   *   loop: { start, end } | null — Step 6C (v13.3): the loop
   *     region in song seconds. When set, the beat (and any
   *     overdub that reaches the region) loops between start and
   *     end for the whole take — the capture keeps running and
   *     the app splits it into one take per pass when the take
   *     stops. An overdub that ends before the region starts is
   *     skipped (it has nothing to say in the part being looped).
   *     Without a loop, an overdub starts late by its own
   *     songOffsetSeconds, so a loop pass or a comp used as a
   *     guide vocal lines up with the beat instead of playing
   *     from the top.
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
   *
   * SPEAKER ROUTE (v13): before the mic opens, a silent buffer
   * loops through the speaker — audio is already flowing out of
   * the speaker when capture starts, so iOS (hopefully) keeps the
   * speaker route instead of dropping output to the earpiece,
   * where the beat is inaudible and the take feels dead. The
   * primer is silent (no bleed into the take) and stops with the
   * take. UNPROVEN on a real iPhone — the web gives the app no
   * way to force the speaker; this is the best order available.
   * See BUILD-v13.md.
   */
  function startPrimer() {
    try {
      if (!ctx) return null;
      var buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.start();
      return src;
    } catch (e) {
      return null;
    }
  }

  function stopPrimer(primer) {
    if (!primer) return;
    try { primer.stop(); } catch (e) { /* ignore */ }
    try { primer.disconnect(); } catch (e) { /* ignore */ }
  }

  function startTake(options) {
    var opts = options || {};
    var players = [];
    var handle = null;
    var primer = null;
    // Audio flowing through the speaker BEFORE the mic opens
    // (see the speaker-route note above) — ensureContext first so
    // there is a context to prime, then the primer, then capture.
    return ensureContext().then(function () {
      primer = startPrimer();
      return startCapture(opts.onBlock || null, { onChunk: opts.onChunk || null });
    }).then(function (cap) {
      var anchorTime = cap.firstTime + ANCHOR_DELAY;
      var delaySeconds = (typeof opts.delaySeconds === 'number') ? opts.delaySeconds : null;
      var preCompActive = false;
      var playbackTime = anchorTime;
      if (delaySeconds !== null && delaySeconds < PRECOMP_GUARD) {
        preCompActive = true;
        playbackTime = anchorTime - delaySeconds;
      }
      // Step 6C (v13.3): the loop region, validated here (the app
      // validates it too — the engine never trusts a region it
      // cannot play).
      var loop = null;
      if (opts.loop && isFinite(opts.loop.start) && isFinite(opts.loop.end) &&
          opts.loop.end > opts.loop.start && opts.loop.start >= 0) {
        loop = { start: opts.loop.start, end: opts.loop.end };
      }
      function schedule(buffer) {
        var player = ctx.createBufferSource();
        player.buffer = buffer;
        // v40 (QUEUE #124): the beat plays through its own layer
        // gain — the beat lane's + / − moves the beat alone.
        player.connect(layerGainFor('beat') || masterGain || ctx.destination);
        if (loop && loop.start < buffer.duration) {
          // Loop Zone: the beat plays [start, end) over and over
          // from the anchor — the singer hears the loop start
          // exactly when the anchor lands, every pass.
          player.loop = true;
          player.loopStart = loop.start;
          player.loopEnd = Math.min(loop.end, buffer.duration);
          player.start(playbackTime, loop.start);
        } else {
          player.start(playbackTime);
        }
        players.push(player);
      }
      // B3 (v13.1): an overdub is a finished take — it plays
      // through its own playback tune node, with its own stamped
      // sound, so the guide vocal he sings against sounds like
      // the finished take instead of raw. A plain AudioBuffer
      // (no sound attached) still plays dry, as before.
      var overdubNodes = [];
      function scheduleOverdub(item) {
        var buffer = item && item.buffer ? item.buffer : item;
        // v40 (QUEUE #124): the guide vocal plays through ITS
        // layer's gain — balancing a layer rebalances the guide
        // he sings against, not just playback.
        var overdubKind = (item && item.kind) || 'lead';
        var player = ctx.createBufferSource();
        player.buffer = buffer;
        if (item && item.sound && typeof opts.tuneNodeFor === 'function') {
          var node = opts.tuneNodeFor(ctx, item.sound, overdubKind);
          if (node && node.input && node.output) {
            // Step 4A (v13.4): a full vocal chain, not just a tune
            // node — the builder already wired the chain's output
            // to the layer gain, so the player only connects to
            // the chain's input. The chain object carries a
            // disconnect() that drops the whole chain with it.
            player.connect(node.input);
          } else {
            player.connect(node);
            node.connect(layerGainFor(overdubKind) || masterGain || ctx.destination);
          }
          overdubNodes.push(node);
        } else {
          player.connect(layerGainFor(overdubKind) || masterGain || ctx.destination);
        }
        if (loop) {
          // Step 6C: the guide vocal loops with the beat — but
          // only if it reaches the part being looped at all.
          if (buffer.duration <= loop.start) return;
          player.loop = true;
          player.loopStart = loop.start;
          player.loopEnd = Math.min(loop.end, buffer.duration);
          player.start(playbackTime, loop.start);
        } else {
          // A pass or a comp used as a guide vocal starts at its
          // own place in the song, not at the top.
          player.start(playbackTime + (item && item.songOffsetSeconds ? item.songOffsetSeconds : 0));
        }
        players.push(player);
      }
      if (opts.beat && opts.beat.buffer) schedule(opts.beat.buffer);
      (opts.overdubs || []).forEach(scheduleOverdub);
      handle = {
        anchorTime: anchorTime,
        firstSampleTime: cap.firstTime,
        preCompActive: preCompActive,
        delaySeconds: delaySeconds,
        playbackTime: playbackTime,
        players: players,
        overdubNodes: overdubNodes,
        primer: primer
      };
      return handle;
    }).catch(function (err) {
      // A take that never started must not leave the primer
      // looping — or the next attempt starts on top of it.
      stopPrimer(primer);
      throw err;
    });
  }

  /* Stops the take: stops the players, stops the capture, and returns
   * a promise of the recording plus the take handle's timing numbers.
   * v36 (QUEUE #34): async now — stopCapture drains the worklet's
   * final partial batch before the take assembles. Callers (finishTake)
   * await it; the players stop synchronously up front so the beat
   * never plays past the tap.
   */
  function stopTake(handle) {
    if (handle && handle.players) {
      handle.players.forEach(function (p) {
        try { p.stop(); } catch (e) { /* already stopped */ }
        try { p.disconnect(); } catch (e) { /* ignore */ }
      });
    }
    // B3 (v13.1): the overdub tune nodes belong to the take — drop
    // them with it, or they keep a detector running on nothing.
    // Step 4A (v13.4): an overdub chain disconnects the same way
    // (its disconnect() drops every node in the chain).
    if (handle && handle.overdubNodes) {
      handle.overdubNodes.forEach(function (n) {
        try { n.disconnect(); } catch (e) { /* ignore */ }
      });
    }
    if (handle && handle.primer) stopPrimer(handle.primer);
    return stopCapture().then(function (recorded) {
      return {
        samples: recorded.samples,
        firstSampleTime: recorded.firstSampleTime,
        totalFrames: recorded.totalFrames,
        anchorTime: handle ? handle.anchorTime : null,
        preCompActive: handle ? handle.preCompActive : false,
        delaySeconds: handle ? handle.delaySeconds : null
      };
    });
  }

  /* Plays one take against the beat, both from the same anchor, so
   * the singer hears exactly how the take sits in the song. (Port of
   * AudioEngineManager.playTake.) Returns a stop function.
   * delaySeconds (Step 6C, v13.3): the take starts this late — a
   * loop pass or a comp lives at its place in the song, so it
   * starts when the playhead reaches it instead of at the top.
   * layerKind (v40, QUEUE #124): the take's layer — the take
   * plays through that layer's gain, the beat through the beat's.
   */
  function playTake(takeBuffer, beatBuffer, onEnded, delaySeconds, layerKind) {
    return ensureContext().then(function () {
      var anchor = ctx.currentTime + 0.1;
      var players = [];
      function schedule(buffer, isTake) {
        var player = ctx.createBufferSource();
        player.buffer = buffer;
        // v40 (QUEUE #124): take through its layer's gain, beat
        // through the beat's — never straight to the master.
        var gain = isTake
          ? (layerGainFor(layerKind || 'lead') || masterGain || ctx.destination)
          : (layerGainFor('beat') || masterGain || ctx.destination);
        player.connect(gain);
        player.start(anchor + (isTake ? (delaySeconds || 0) : 0));
        if (isTake && onEnded) {
          player.onended = function () {
            // The take ended — the song is over. Stop the beat too
            // (it outlasts every take) or it plays on with no stop
            // button, then tell the caller playback is over.
            players.forEach(function (p) {
              if (p === player) return;
              try { p.stop(); } catch (e) { /* ignore */ }
              try { p.disconnect(); } catch (e) { /* ignore */ }
            });
            onEnded();
          };
        }
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

  /* The 60 s Audio Logger (Step 1B): a bare mic capture whose
   * blocks feed the caller's ring buffer. startLogger returns the
   * capture handle once the mic is flowing; stopLogger returns a
   * promise of the recorded samples (v36, QUEUE #34: the drain —
   * the caller normally ignores them, the ring buffer already holds
   * the last 60 s). The mic stays open only while the logger is armed.
   */
  function startLogger(onBlock) {
    return startCapture(onBlock || null);
  }

  function stopLogger() {
    return stopCapture();
  }

  /* Output latency in seconds (Safari 18.4+), or null when the
   * browser does not report it. Logged on every take next to the
   * acoustic calibration (Step 0C).
   */
  function outputLatency() {
    if (ctx && typeof ctx.outputLatency === 'number' && isFinite(ctx.outputLatency)) {
      return ctx.outputLatency;
    }
    return null;
  }

  function baseLatency() {
    if (ctx && typeof ctx.baseLatency === 'number' && isFinite(ctx.baseLatency)) {
      return ctx.baseLatency;
    }
    return null;
  }

  /* Everything the route lab needs about the current audio route,
   * in one object (Step 0).
   */
  function contextInfo() {
    return {
      sampleRate: sampleRate(),
      baseLatency: baseLatency(),
      outputLatency: outputLatency(),
      state: ctx ? ctx.state : null,
      micSettings: micSettings()
    };
  }

  return {
    ANCHOR_DELAY: ANCHOR_DELAY,
    PRECOMP_GUARD: PRECOMP_GUARD,
    CHUNK_SAMPLES: PS_CHUNK_SAMPLES,
    sampleRate: sampleRate,
    ensureContext: ensureContext,
    ensureMic: ensureMic,
    onMicEnded: onMicEnded, // v35 (QUEUE #32): register the mic-died handler
    micAlive: micAlive, // v35 (QUEUE #32): polled liveness backstop
    captureLastBlockAt: captureLastBlockAt, // v41 (QUEUE #42): last block stamp, or null (the watchdog reads it)
    micTrack: micTrack, // v35 (QUEUE #32): the current mic track, or null (CDP suite ends it)
    closeMic: closeMic,
    isMicOpen: isMicOpen,
    micSettings: micSettings,
    micProcessed: micProcessed, // B9 (v13.1): the phone processed the mic despite the raw constraints
    micLabel: micLabel, // v13.2 (item 4): the mic that recorded the take, in plain words
    micLabelFromTrackLabel: micLabelFromTrackLabel, // v13.2 (item 4): the label rule, unit-tested in Node
    audioSessionLog: audioSessionLog,
    nominalLatency: nominalLatency,
    outputLatency: outputLatency,
    baseLatency: baseLatency,
    contextInfo: contextInfo,
    // v40 (QUEUE #124): per-layer volume — one gain per layer kind,
    // fed by every playback player; the master is fixed at full.
    layerGainFor: layerGainFor,
    setLayerLevel: setLayerLevel,
    layerLevel: layerLevel,
    setLayerLevels: setLayerLevels,
    layerGainValue: layerGainValue,
    outputNode: outputNode,
    monitorNode: monitorNode, // B2 (v13.1): the live monitor's gain — fixed at full, like the master
    decodeBeat: decodeBeat,
    decodeAudio: decodeAudio,
    createBuffer: createBuffer, // B10 (v13.1): buffer creation on the engine's context, no scratch context
    runCalibration: runCalibration,
    runClickTest: runClickTest,
    startTake: startTake,
    stopTake: stopTake,
    playTake: playTake,
    startLogger: startLogger,
    stopLogger: stopLogger,
    isCapturing: isCapturing,
    // Bare capture (no beat scheduling) — the mic test uses it.
    startCapture: startCapture,
    stopCapture: stopCapture,
    currentTime: function () { return ctx ? ctx.currentTime : 0; }
  };
});
