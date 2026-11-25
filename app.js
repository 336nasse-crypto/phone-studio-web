/* app.js — Phone Studio PWA: one-screen studio UI, take flow,
 * calibration, export, real waveforms.
 *
 * ONE SCREEN: the whole studio fits in one phone screen (100dvh) —
 * no scrolling on the main view. Tracks are slim rows with real
 * waveforms drawn from the actual audio (canvas); the beat is the
 * bottom row, on the same timeline. One shared playhead, one big
 * red record button in the transport (it records the SELECTED
 * track). Setup (song, headphones) lives behind the gear. Takes
 * are managed from a bottom sheet (the ··· on a row). The key
 * picker is one tap from the top bar.
 *
 * The ENGINE is untouched: the take flow ports
 * AudioEngineManager.beginTake/finishTake (record raw PCM over the
 * beat, pre-compensated when a calibration exists, trim lead-in
 * (only) or lead-in + delay, run the residual check, save raw +
 * aligned WAVs + a metadata JSON sidecar). All engine calls go
 * through PS.audio / PS.db / PS.store / PS.wav / PS.residual
 * exactly as before — this file only changes the UI around them.
 *
 * Plain words everywhere — Denasse is not a coder. No jargon in
 * the UI: "Measure my headphones", "Send", "Lined up".
 */
(function () {
  'use strict';

  var PS = window.PS;
  var $ = function (id) { return document.getElementById(id); };

  /* The key is a tonic (12 notes) + a scale (Major/Minor) — the
   * picker shows them as two rows, and the song key is the two
   * joined ('D minor'). The worklet parses the same string, so any
   * of the 24 combinations works.
   */
  var TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  var SCALES = ['major', 'minor'];
  var TONIC_NAMES = { C: 1, 'C#': 1, D: 1, Eb: 1, E: 1, F: 1, 'F#': 1, G: 1, Ab: 1, A: 1, Bb: 1, B: 1 };

  function parseKey(key) {
    // 'D minor' -> { tonic: 'D', scale: 'minor' }. Unparseable -> D minor.
    var m = /^\s*([A-G](?:#|b)?)\s+(major|minor)\s*$/i.exec(key || '');
    if (!m) return { tonic: 'D', scale: 'minor' };
    var tonic = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    if (!TONIC_NAMES[tonic]) return { tonic: 'D', scale: 'minor' };
    return { tonic: tonic, scale: m[2].toLowerCase() };
  }

  /* The five starter presets (Voloco's Starter pack). The id goes
   * to the worklet; the short label is what Denasse taps on the
   * preset strip; the full label is the accessible name.
   */
  var PRESETS = [
    { id: 'hard', short: 'Hard', label: 'Hard Tune' },
    { id: 'natural', short: 'Natural', label: 'Natural Tune' },
    { id: 'vocoder', short: 'Vocoder', label: 'Super Vocoder' },
    { id: 'chorus', short: 'Chorus', label: 'Big Chorus' },
    { id: 'clean', short: 'Clean', label: 'Clean' }
  ];
  var PRESET_IDS = PRESETS.map(function (p) { return p.id; });

  // Plain-words versions of the residual verdicts.
  var VERDICT_TEXT = {
    'applied': 'Lined up — trimmed a little extra delay off the front.',
    'within-tolerance': 'Lined up — right on the beat.',
    'early-not-corrected': 'A touch early — left as-is. Measure the headphones again if it keeps happening.',
    'unverified-too-few-onsets': 'Could not check the timing — not enough singing to measure against.',
    'unverified-onsets-disagree': 'Could not check the timing — the singing did not line up with the beat clearly.',
    'rejected-implausible': 'Could not check the timing — the measurement looked wrong, so nothing was changed.',
    'no-beat': 'No beat to check against.',
    'read-failed': 'Could not read the take to check the timing.'
  };

  // Waveform peaks are cached at this fixed resolution per take/beat
  // (4 KB per take) and downsampled to the lane width when drawn —
  // so a resize never re-decodes audio.
  var PEAK_BUCKETS = 1000;
  var WAVE_CACHE_MAX = 20;
  var MIN_TIMELINE_SECONDS = 30;

  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
  var MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';
  var NOTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';

  var state = {
    sessions: [],
    session: null,
    beat: null, // { buffer, mono, duration, sampleRate, fileName, originalName, peaks }
    beatLoading: false, // a beat file is being read + decoded (row shows "Loading…")
    calibrations: {},
    recording: null, // { track, handle, anchorTime, startWall, timer, interrupted }
    startingTake: false, // record tapped, the take is still starting (mic opening, overdubs loading)
    calibrating: false,
    playingStop: null,
    playingTakeId: null,
    playGen: 0, // playback generation — a stale play chain (still loading when a newer play starts) aborts instead of doubling up
    playingStartCtx: 0,
    playingStartOffset: 0,
    playheadTimer: null,
    wakeLock: null,
    wakeLockSupported: ('wakeLock' in navigator),
    selectedTrack: 'lead',
    playheadSeconds: 0,
    timelineSeconds: MIN_TIMELINE_SECONDS,
    waveCache: {}, // takeId -> { peaks, duration } (peaks: Float32Array, PEAK_BUCKETS)
    waveCacheOrder: [],
    sheetTrack: null,
    sliceCtx: null,
    scrubbing: false,
    // Live tune (Hard Tune): the headphones toggle = hear the tuned
    // voice live. OFF by default (Voloco's own answer on Bluetooth —
    // the tuned voice arrives late, and hearing yourself late throws
    // a take off). The tuned take is heard on playback either way.
    monitorOn: false,
    monitor: null, // { source, gain, tune } — the live monitor branch, or null
    tuneModuleReady: false,
    playbackTune: null, // the AudioWorkletNode that tunes take playback
    // Phase 0 — trust the recording.
    labReports: {}, // route-lab reports, keyed by label
    storagePersisted: null, // navigator.storage.persist() result (null = unknown)
    storageEstimate: null, // { quota, usage } from storage.estimate()
    storageLine: '', // plain-words storage status for Setup
    newDeviceDetected: false, // a never-seen audio input appeared (Step 0C)
    logger: null, // { ring, startWall, sampleRate } while the ideas logger is armed
    loggerArming: false,
    recoverQueue: [], // orphaned chunk groups found on boot, one at a time
    recovering: false
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function showError(message) {
    $('error-text').textContent = message;
    $('error-box').style.display = 'flex';
  }

  function clearError() {
    $('error-text').textContent = '';
    $('error-box').style.display = 'none';
  }

  function fmtClock(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function fmtTime(dateIso) {
    try {
      var d = new Date(dateIso);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // ---------------------------------------------------------------- wake lock

  function acquireWakeLock() {
    if (!state.wakeLockSupported) return Promise.resolve(false);
    if (state.wakeLock) return Promise.resolve(true);
    return navigator.wakeLock.request('screen').then(function (lock) {
      state.wakeLock = lock;
      lock.addEventListener('release', function () {
        if (state.wakeLock === lock) state.wakeLock = null;
      });
      return true;
    }).catch(function () { return false; });
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(function () { /* ignore */ });
      state.wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      // Recording STOPS when Safari backgrounds — finish the take now
      // so what was recorded is saved, flagged interrupted, instead
      // of silently losing audio. (Native keeps recording on lock;
      // the web cannot. This is the honest handling.) The chunked
      // writes (Step 1B) already hold the take up to the last full
      // second on disk — the finish below saves the rest best-effort.
      if (state.recording) finishTake(true);
      if (state.logger) disarmLogger(false); // the mic stops on background anyway
    } else if (document.visibilityState === 'visible') {
      if (state.recording || state.calibrating) acquireWakeLock();
      // The context may have been suspended while hidden — resume
      // it so the monitor (and everything else) comes back alive.
      PS.audio.ensureContext().catch(function () { /* ignore */ });
    }
  });

  // ---------------------------------------------------------------- phase 0 helpers

  /* The mic is open ONLY while something needs it (a take, a
   * calibration, the live monitor, the ideas logger). When nothing
   * does, close it so review plays at full quality — with the mic
   * open, iOS lowers the output sample rate and folds stereo to
   * mono (WebKit 311451). (Step 1B.)
   */
  function maybeCloseMic() {
    if (state.recording || state.calibrating || state.monitor || state.logger) return;
    PS.audio.closeMic();
  }

  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) { /* ignore */ }
    return !!window.navigator.standalone;
  }

  /* Storage health on boot (Step 1B): ask the phone to keep this
   * site's storage (persist() — called even though WebKit 271401
   * says it can return false) and read the estimate. The numbers
   * feed the Setup line and the 500 MB arm gate.
   */
  function checkStorage() {
    if (!navigator.storage) return Promise.resolve();
    var jobs = [];
    if (navigator.storage.persist) {
      jobs.push(navigator.storage.persist().then(function (ok) {
        state.storagePersisted = !!ok;
      }).catch(function () { state.storagePersisted = null; }));
    }
    if (navigator.storage.estimate) {
      jobs.push(navigator.storage.estimate().then(function (est) {
        state.storageEstimate = est;
      }).catch(function () { /* ignore */ }));
    }
    return Promise.all(jobs).then(renderStorageLine);
  }

  function renderStorageLine() {
    var line = $('storage-line');
    if (!line) return;
    var est = state.storageEstimate;
    if (!est || typeof est.quota !== 'number' || typeof est.usage !== 'number') {
      line.textContent = 'Storage: the phone did not report how much space is left.';
      return;
    }
    var usedMB = Math.round(est.usage / (1024 * 1024));
    var quotaGB = (est.quota / (1024 * 1024 * 1024)).toFixed(1);
    line.textContent = 'Storage: ' + usedMB + ' MB used of about ' + quotaGB +
      ' GB for this app — your takes stay on this phone.' +
      (state.storagePersisted === false ? ' The phone may still clear this storage — add the app to your Home Screen to be safe.' : '');
  }

  /* Refuse to arm with less than 500 MB free (Step 1B). Returns a
   * promise resolving to true when arming is allowed.
   */
  function storageGate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(true);
    return navigator.storage.estimate().then(function (est) {
      state.storageEstimate = est;
      var gate = PS.safety.hasEnoughFree(est);
      if (gate.unknown) return true;
      if (gate.ok) return true;
      showError('Not enough space to record — only about ' + gate.freeMB +
        ' MB free for this app. Free some space on the phone, then try again.');
      return false;
    }).catch(function () { return true; }); // a missing reading never blocks a take
  }

  // ---------------------------------------------------------------- sessions

  function loadSessions() {
    state.sessions = PS.store.loadSessions();
    // Songs saved before step 2 have no preset/strength — backfill
    // the defaults (Hard Tune, 100%) so the picker and the worklet
    // always have something real to use.
    state.sessions.forEach(function (s) {
      if (PRESET_IDS.indexOf(s.preset) === -1) s.preset = 'hard';
      if (typeof s.strength !== 'number' || s.strength < 0 || s.strength > 100) s.strength = 100;
      // Step 2A — speed: null means Auto (the preset's own retune
      // time); a number 0-100 overrides it.
      if (s.speed !== null && (typeof s.speed !== 'number' || s.speed < 0 || s.speed > 100)) s.speed = null;
      if (typeof s.keyManuallySet !== 'boolean') {
        // Songs saved before Step 9A have no flag — a key other
        // than the default D minor means he picked it himself.
        s.keyManuallySet = s.key !== 'D minor';
      }
      if (typeof s.beatKeyConfidence !== 'number') s.beatKeyConfidence = 0;
      if (typeof s.keySource !== 'string') s.keySource = null;
    });
    var currentId = PS.store.currentSessionId();
    state.session = state.sessions.find(function (s) { return s.id === currentId; }) || state.sessions[0];
    PS.store.setCurrentSessionId(state.session.id);
    state.calibrations = PS.store.loadCalibrations();
  }

  function saveSessions() {
    PS.store.saveSessions(state.sessions);
  }

  function activeCalibration() {
    var label = PS.store.activeCalibrationLabel();
    if (!label) return null;
    var cal = state.calibrations[label];
    return cal ? { label: label, calibration: cal } : null;
  }

  function activeTakeOf(kind) {
    var vocal = state.session.tracks[kind];
    if (!vocal || !vocal.takes.length) return null;
    if (vocal.activeTakeId) {
      var found = vocal.takes.find(function (t) { return t.id === vocal.activeTakeId; });
      if (found) return found;
    }
    return vocal.takes[vocal.takes.length - 1];
  }

  // ---------------------------------------------------------------- beat

  function loadBeatForSession() {
    state.beat = null;
    if (!state.session.beatFileName) return Promise.resolve();
    return PS.db.getBeat(state.session.id).then(function (row) {
      if (!row || !row.blob) return;
      return row.blob.arrayBuffer().then(function (buf) {
        return PS.audio.decodeBeat(buf);
      }).then(function (decoded) {
        state.beat = {
          buffer: decoded.buffer,
          mono: decoded.mono,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          fileName: state.session.beatFileName,
          originalName: state.session.beatOriginalName,
          peaks: null
        };
        // A beat saved before Step 9A has no detection stored —
        // listen to it once now (the same pass as a fresh import).
        if (!state.session.beatKey && !state.session.beatBpm) {
          setTimeout(function () { detectBeatKeyTempo(); }, 0);
        }
      });
    }).catch(function (err) {
      console.warn('Beat could not be loaded:', err);
      showError('The beat could not be loaded. Import it again.');
    });
  }

  /* A promise that rejects if the given promise takes longer than ms.
   * The beat import used to hang silently on iOS (see
   * ensureDecodeContext in audio.js) — a hang must become an error
   * the singer can see, never silence.
   */
  function withTimeout(promise, ms, message) {
    return Promise.race([promise, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(message)); }, ms);
    })]);
  }

  function onBeatFilePicked(file) {
    if (!file) return;
    clearError();
    state.beatLoading = true;
    renderTracks(); // the beat row shows "Loading…" while it decodes
    var importJob = file.arrayBuffer().then(function (buf) {
      return PS.audio.decodeBeat(buf);
    }).then(function (decoded) {
      return PS.db.saveBeat({
        sessionId: state.session.id,
        fileName: 'beat.' + (file.name.split('.').pop() || 'audio').toLowerCase(),
        originalName: file.name,
        duration: decoded.duration,
        blob: file,
        addedAt: new Date().toISOString()
      }).then(function () {
        state.session.beatFileName = 'beat.' + (file.name.split('.').pop() || 'audio').toLowerCase();
        state.session.beatOriginalName = file.name;
        state.session.beatDuration = decoded.duration;
        saveSessions();
        state.beat = {
          buffer: decoded.buffer,
          mono: decoded.mono,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          fileName: state.session.beatFileName,
          originalName: file.name,
          peaks: null
        };
        // A late success (after the timeout fired) still lands the
        // beat and clears the error — the take is never lost.
        clearError();
        setPlayhead(0);
        renderTracks();
        updateTransport();
        // Step 9A — listen to the beat once and guess its key +
        // tempo, on the next tick so the beat row paints first.
        // A 3-minute beat costs ~0.1-0.3 s of listening; the take
        // stays dry and nothing here blocks the screen.
        setTimeout(function () { detectBeatKeyTempo(); }, 0);
      });
    });
    withTimeout(importJob, 30000, 'The beat took too long to load. Try tapping the Beat row again.').then(function () {
      state.beatLoading = false;
      renderTracks();
      updateTransport(); // the beat arriving enables Play
    }).catch(function (err) {
      state.beatLoading = false;
      console.warn('Beat import failed:', err);
      showError(err && err.message && err.message.indexOf('too long') !== -1 ? err.message : 'That file could not be used as a beat. Try an MP3, M4A, or WAV file.');
      renderTracks();
      updateTransport();
    });
  }

  function removeBeat() {
    if (!window.confirm('Remove the beat from this song? Your takes stay.')) return;
    PS.db.deleteBeat(state.session.id).catch(function () { /* ignore */ });
    state.session.beatFileName = null;
    state.session.beatOriginalName = null;
    state.session.beatDuration = null;
    // The key + tempo came from that beat — they go with it.
    state.session.beatKey = null;
    state.session.beatKeyConfidence = 0;
    state.session.beatBpm = null;
    state.session.beatBpmAlt = null;
    state.session.beatGridOffset = null;
    if (state.session.keySource === 'beat') state.session.keySource = null;
    state.beat = null;
    saveSessions();
    setPlayhead(0);
    renderTracks();
    updateTransport(); // no beat and no take — Play goes back off
  }

  /* Step 9A — what key is this beat in, and how fast? Runs once
   * after import (and again when an old session's beat loads with
   * no detection stored). The detected key only becomes the song's
   * key if Denasse never picked one himself — his pick always wins,
   * and the detected key stays offered in the key sheet either way.
   * Below 0.25 confidence the app says it is not sure instead of
   * guessing. Nothing here touches the recorded takes.
   */
  function detectBeatKeyTempo() {
    if (!state.beat || !state.beat.mono || !PS.keydetect || !PS.tempodetect) return;
    var s = state.session;
    var keyResult = null;
    var tempoResult = null;
    try { keyResult = PS.keydetect.detectKey(state.beat.mono, state.beat.sampleRate); } catch (e) { /* no key — the beat stays keyless */ }
    try { tempoResult = PS.tempodetect.detectTempo(state.beat.mono, state.beat.sampleRate); } catch (e) { /* no tempo */ }
    if (keyResult && keyResult.key) {
      s.beatKey = keyResult.key;
      s.beatKeyConfidence = keyResult.confidence || 0;
    }
    if (tempoResult && tempoResult.bpm) {
      s.beatBpm = tempoResult.bpm;
      s.beatBpmAlt = tempoResult.bpmAlt;
      s.beatGridOffset = tempoResult.gridStartOffsetSeconds;
      if (typeof s.bpm !== 'number') s.bpm = tempoResult.bpm;
    }
    // Auto-apply the key only while he has never picked one.
    if (s.beatKey && !s.keyManuallySet) {
      applyKey(s.beatKey, false);
      s.keySource = 'beat';
    }
    saveSessions();
    renderTracks();
    renderSession();
  }

  // ---------------------------------------------------------------- calibration

  /* No typing required to measure: one pair of headphones is the
   * normal case, so an empty name becomes "My headphones" (a second
   * pair gets a number). The name only matters if he ever measures
   * a second pair.
   */
  function defaultCalLabel() {
    if (!state.calibrations['My headphones']) return 'My headphones';
    var n = 2;
    while (state.calibrations['Headphones ' + n]) n += 1;
    return 'Headphones ' + n;
  }

  function startCalibration() {
    var label = $('cal-label').value.trim() || defaultCalLabel();
    clearError();
    state.calibrating = true;
    renderCalibration();
    updateTransport();
    updateMonitor(); // the monitor would loop the clicks back into the measurement
    acquireWakeLock();
    $('cal-status').textContent = 'Getting the mic ready…';
    PS.audio.runCalibration(function (text) {
      $('cal-status').textContent = text;
    }).then(function (result) {
      state.calibrating = false;
      releaseWakeLock();
      updateTransport();
      updateMonitor();
      maybeCloseMic(); // the mic was open for the measurement only
      if (!result.ok) {
        $('cal-status').textContent = result.error;
        renderCalibration();
        return;
      }
      // Step 0C — calibrate IN THE RECORD STATE, on the route
      // actually used: the mic was open with the session locked to
      // play-and-record, so the delay measured is the record-state
      // delay. Log outputLatency next to the acoustic calibration;
      // a take whose outputLatency has moved > 20 ms from this
      // value is flagged to re-measure.
      var micSettings = PS.audio.micSettings();
      var calibration = {
        label: label,
        delaySamples: result.medianSamples,
        delayMs: result.medianMs,
        delaySeconds: result.delaySeconds,
        sampleRate: PS.audio.sampleRate(),
        nominalLatencySeconds: PS.audio.nominalLatency(),
        outputLatencySeconds: PS.audio.outputLatency(),
        micSampleRate: micSettings && typeof micSettings.sampleRate === 'number' ? micSettings.sampleRate : null,
        micDeviceId: micSettings && micSettings.deviceId ? micSettings.deviceId : null,
        audioSessionLog: PS.audio.audioSessionLog(),
        date: new Date().toISOString()
      };
      PS.store.saveCalibration(label, calibration);
      PS.store.setActiveCalibrationLabel(label);
      if (micSettings && micSettings.deviceId) PS.store.markDeviceSeen(micSettings.deviceId);
      state.calibrations = PS.store.loadCalibrations();
      $('cal-status').textContent = 'Done — ' + label + ': ' + Math.round(result.medianMs) +
        ' ms. Your voice will land in time.';
      renderCalibration();
    }).catch(function (err) {
      state.calibrating = false;
      releaseWakeLock();
      updateTransport();
      updateMonitor();
      maybeCloseMic();
      $('cal-status').textContent = '';
      renderCalibration();
      showError(err && err.message ? err.message : 'The measurement failed. Try again.');
    });
  }

  /* Step 0C — a new audio input appeared (devicechange). Safari
   * exposes no Bluetooth identity, but after the mic is granted,
   * enumerateDevices gives each input a deviceId. A deviceId never
   * seen before is a new pair of headphones: prompt to measure it
   * (Voloco 9.6's pattern — one calibration per headphone).
   */
  function onDevicesChanged() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var foundNew = false;
      devices.forEach(function (d) {
        if (d.kind === 'audioinput' && d.deviceId && !PS.store.hasSeenDevice(d.deviceId)) {
          foundNew = true;
        }
      });
      if (foundNew) {
        state.newDeviceDetected = true;
        renderCalibration();
      }
    }).catch(function () { /* ignore */ });
  }

  // ---------------------------------------------------------------- route lab (Step 0)

  /* The route lab tests the headphones the singer is actually
   * wearing and tells him, in plain words, which setup gives the
   * best take — before he sings a note. Three measurements, one
   * run: 5 s of room tone, a held "sss" for the bandwidth check,
   * and 8 clicks at 90 BPM for the timing spread. The report is
   * saved per headphone pair so setups can be compared.
   */
  var labRunning = false;
  var labReturnTo = 'studio'; // 'studio' (banner) or 'setup' (Setup button)

  function defaultLabLabel() {
    if (!state.labReports['My headphones']) return 'My headphones';
    var n = 2;
    while (state.labReports['Headphones ' + n]) n += 1;
    return 'Headphones ' + n;
  }

  function openLab() {
    // The lab opens from the studio banner AND from Setup — remember
    // where to go back to, and hide both views underneath.
    labReturnTo = $('setup-view').style.display !== 'none' ? 'setup' : 'studio';
    renderLabReports();
    $('lab-view').style.display = 'flex';
    $('studio-view').style.display = 'none';
    $('setup-view').style.display = 'none';
  }

  function closeLab() {
    $('lab-view').style.display = 'none';
    if (labReturnTo === 'setup') {
      $('setup-view').style.display = 'flex';
    } else {
      $('studio-view').style.display = 'flex';
      requestAnimationFrame(function () {
        drawAllWaves();
        renderPlayhead();
      });
    }
  }

  function renderLabReports() {
    var list = $('lab-list');
    if (!list) return;
    list.innerHTML = '';
    var labels = Object.keys(state.labReports);
    if (labels.length === 0) {
      list.appendChild(el('p', 'muted', 'No setups tested yet.'));
      return;
    }
    labels.forEach(function (label) {
      var r = state.labReports[label];
      var row = el('div', 'lab-row');
      var head = el('div', '', label + ' — hears up to ' +
        (r.bandwidthHz >= 1000 ? (r.bandwidthHz / 1000).toFixed(1) + ' kHz' : Math.round(r.bandwidthHz) + ' Hz') +
        (r.studioGrade ? ' — studio grade' : '') +
        ', timing spread ' + (r.clapSpreadMs !== null ? r.clapSpreadMs.toFixed(1) + ' ms' : 'not measured'));
      row.appendChild(head);
      row.appendChild(el('p', 'muted small', r.recommendation || ''));
      var del = el('button', 'btn-small danger', 'Remove');
      del.addEventListener('click', function () {
        if (!window.confirm('Remove the test for "' + label + '"?')) return;
        PS.store.deleteLabReport(label);
        state.labReports = PS.store.loadLabReports();
        renderLabReports();
      });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  /* Plain-words recommendation from one lab report, compared with
   * the other saved setups.
   */
  function labRecommendation(report, others) {
    var parts = [];
    var bwKhz = (report.bandwidthHz / 1000).toFixed(1);
    if (report.bandwidthHz >= PS.routelab.STUDIO_GRADE_HZ) {
      parts.push('Studio grade — this setup hears up to ' + bwKhz + ' kHz, clear enough for a lead vocal.');
    } else if (report.bandwidthHz >= 12000) {
      parts.push('Good — it hears up to ' + bwKhz + ' kHz. The phone mic reaches higher; use it for the lead vocal if you want the clearest sound.');
    } else if (report.bandwidthHz >= 8000) {
      parts.push('Usable, but it stops at ' + bwKhz + ' kHz — the top end of your voice will sound dull. The phone mic is clearer.');
    } else {
      parts.push('This setup is crushing your vocal — it stops at ' + bwKhz + ' kHz. Use the phone mic or wired headphones for the lead.');
    }
    if (report.clapSpreadMs !== null && !report.clapPass) {
      parts.push('The timing wobbles by ' + report.clapSpreadMs.toFixed(1) + ' ms between clicks — measure again.');
    }
    if (report.echoCancellation !== false && report.echoCancellation !== null) {
      parts.push('The phone is still processing the mic — the take may sound processed.');
    }
    var bestLabel = report.label;
    var bestBw = report.bandwidthHz;
    Object.keys(others || {}).forEach(function (label) {
      var o = others[label];
      if (o && o.bandwidthHz > bestBw) {
        bestBw = o.bandwidthHz;
        bestLabel = label;
      }
    });
    if (bestLabel !== report.label) {
      parts.push('Best so far is ' + bestLabel + ' at ' + (bestBw / 1000).toFixed(1) + ' kHz.');
    } else if (Object.keys(others || {}).length > 0) {
      parts.push('Best setup so far.');
    }
    return parts.join(' ');
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* Records `seconds` of mic input and returns the samples. Used
   * by the lab for the room tone and the "sss".
   */
  function recordSegment(seconds) {
    return PS.audio.startCapture(null).then(function () {
      return sleep(seconds * 1000);
    }).then(function () {
      var recorded = PS.audio.stopCapture();
      return recorded.samples || new Float32Array(0);
    });
  }

  function startLabRun() {
    if (labRunning || state.recording || state.calibrating) return;
    var label = ($('lab-label').value || '').trim() || defaultLabLabel();
    labRunning = true;
    $('lab-run').disabled = true;
    $('lab-status').textContent = 'Opening the mic…';
    var before = PS.audio.contextInfo();
    var report = {
      label: label,
      date: new Date().toISOString(),
      contextSampleRate: before.sampleRate,
      baseLatencySeconds: before.baseLatency,
      outputLatencySeconds: before.outputLatency
    };
    acquireWakeLock();
    // Phase 1 — 5 s of room tone (stay quiet).
    $('lab-status').textContent = 'Stay quiet for 5 seconds — listening to the room…';
    recordSegment(5).then(function (roomSamples) {
      report.roomFloorDb = PS.routelab.rmsDb(roomSamples);
      // Phase 2 — a held "sss" for the bandwidth check.
      $('lab-status').textContent = 'Now hold a steady "sss" like a snake for 3 seconds…';
      return recordSegment(3).then(function (sssSamples) {
        var bw = PS.routelab.bandwidth(sssSamples, PS.audio.sampleRate());
        report.bandwidthHz = bw.bandwidthHz;
        report.energyAbove12kHz = bw.energyAbove12kHz;
        report.studioGrade = bw.bandwidthHz >= PS.routelab.STUDIO_GRADE_HZ;
        var settings = PS.audio.micSettings();
        report.inputSampleRate = settings && typeof settings.sampleRate === 'number' ? settings.sampleRate : PS.audio.sampleRate();
        report.channels = settings && typeof settings.channelCount === 'number' ? settings.channelCount : 1;
        report.echoCancellation = settings ? settings.echoCancellation : null;
        report.noiseSuppression = settings ? settings.noiseSuppression : null;
        report.autoGainControl = settings ? settings.autoGainControl : null;
        if (settings && settings.deviceId) PS.store.markDeviceSeen(settings.deviceId);
        // Phase 3 — 8 clicks at 90 BPM for the timing spread.
        $('lab-status').textContent = 'Playing 8 clicks — keep the headphones still…';
        return PS.audio.runClickTest({
          count: 8,
          spacingSeconds: 60 / 90,
          firstDelaySeconds: 0.5,
          progressText: 'Playing 8 clicks at 90 BPM — keep the headphones still…',
          onProgress: function (text) { $('lab-status').textContent = text; }
        });
      });
    }).then(function (clap) {
      var offsets = PS.routelab.clapOffsets(clap.delaysMs || []);
      report.clapMedianMs = offsets.medianMs;
      report.clapSpreadMs = offsets.spreadMs;
      report.clapDetected = offsets.detected;
      report.clapPass = offsets.pass;
      report.clapOk = !!clap.ok;
      report.recommendation = labRecommendation(report, state.labReports);
      PS.store.saveLabReport(label, report);
      state.labReports = PS.store.loadLabReports();
      state.newDeviceDetected = false;
      $('lab-status').textContent = 'Done — ' + label + ': hears up to ' +
        (report.bandwidthHz / 1000).toFixed(1) + ' kHz' +
        (report.studioGrade ? ' (studio grade)' : '') +
        '. ' + report.recommendation;
      renderLabReports();
      renderCalibration();
    }).catch(function (err) {
      $('lab-status').textContent = '';
      showError(err && err.message ? err.message : 'The test failed. Try again.');
    }).then(function () {
      labRunning = false;
      releaseWakeLock();
      maybeCloseMic();
      $('lab-run').disabled = false;
    });
  }

  // ---------------------------------------------------------------- ideas logger (Step 1B)

  /* The 60 s Audio Logger: while the record screen is armed, the
   * last 60 s of mic input sits in a circular buffer. One tap
   * saves it — a spontaneous hook or melody sung while rehearsing
   * is never lost. Armed only on purpose: an open mic dulls the
   * beat (WebKit 311451), so the logger never runs in the
   * background.
   */
  var loggerTimer = null;

  function updateIdeasUI() {
    var btn = $('ideas-btn');
    var note = $('ideas-note');
    if (!btn) return;
    if (state.logger) {
      btn.textContent = 'Save last 60s';
      btn.classList.add('active');
      var held = PS.safety ? state.logger.ring.secondsHeld(state.logger.sampleRate) : 0;
      if (note) note.textContent = 'Listening' + (held >= 1 ? ' — holding the last ' + Math.round(held) + 's' : '…') +
        '. The beat may sound duller while the mic is open. Keep this page open.';
    } else {
      btn.textContent = 'Catch ideas';
      btn.classList.remove('active');
      if (note) note.textContent = 'Sings something great while rehearsing? Tap once and the last 60 seconds are saved as a take.';
    }
    btn.disabled = !!state.recording || !!state.calibrating || state.loggerArming;
  }

  function toggleIdeas() {
    if (state.logger) {
      saveLoggerTake();
    } else {
      armLogger();
    }
  }

  function armLogger() {
    if (state.logger || state.recording || state.calibrating || state.loggerArming) return;
    state.loggerArming = true;
    updateIdeasUI();
    PS.audio.ensureContext().then(function (ctx) {
      var sr = ctx.sampleRate;
      var ring = new PS.safety.RingBuffer(PS.safety.LOGGER_SECONDS * sr);
      return PS.audio.startLogger(function (batch) {
        ring.push(batch.samples);
      }).then(function () {
        state.loggerArming = false;
        state.logger = { ring: ring, startWall: Date.now(), sampleRate: sr };
        acquireWakeLock();
        updateIdeasUI();
        loggerTimer = setInterval(updateIdeasUI, 1000);
      });
    }).catch(function (err) {
      state.loggerArming = false;
      updateIdeasUI();
      showError(err && err.message ? err.message : 'Could not open the mic to listen. Try again.');
    });
  }

  /* Stops the logger without saving (the take path and the page-hide
   * path use this — the ring buffer is dropped).
   */
  function disarmLogger(saveFirst) {
    if (!state.logger) return;
    if (loggerTimer) { clearInterval(loggerTimer); loggerTimer = null; }
    try { PS.audio.stopLogger(); } catch (e) { /* ignore */ }
    state.logger = null;
    releaseWakeLock();
    updateIdeasUI();
    maybeCloseMic();
  }

  /* Saves the last 60 s (or less) in the ring buffer as a take on
   * the selected track. No beat anchor — the audio is saved as
   * recorded, marked as a logger recovery.
   */
  function saveLoggerTake() {
    if (!state.logger) return;
    var logger = state.logger;
    if (loggerTimer) { clearInterval(loggerTimer); loggerTimer = null; }
    var snapshot = logger.ring.snapshot();
    var sr = logger.sampleRate;
    state.logger = null;
    releaseWakeLock();
    updateIdeasUI();
    try { PS.audio.stopLogger(); } catch (e) { /* ignore */ }
    maybeCloseMic();
    if (snapshot.length < Math.round(0.5 * sr)) {
      showError('Nothing to save yet — the logger had just started listening.');
      return;
    }
    var track = state.selectedTrack;
    var vocal = state.session.tracks[track];
    var takeNumber = vocal.takes.length + 1;
    var takeId = PS.store.newId();
    var durationSeconds = snapshot.length / sr;
    var metadata = {
      trackKind: track,
      rawFileName: 'take-' + takeNumber + '-raw.wav',
      alignedFileName: 'take-' + takeNumber + '.wav',
      sampleRate: sr,
      durationSeconds: durationSeconds,
      leadInSamples: 0,
      delaySamples: 0,
      delayMilliseconds: 0,
      trimSamples: 0,
      preCompensationActive: false,
      preCompensationDelayMilliseconds: null,
      residualTrimSamples: 0,
      residualMilliseconds: null,
      residualOnsets: 0,
      residualVerdict: 'no-beat',
      calibrationDeviceUID: null,
      calibrationLabel: null,
      calibrationDeviceName: null,
      calibrationDate: null,
      calibrated: false,
      compensationSource: 'logger',
      interrupted: false,
      loggerRecovery: true,
      chunkCount: 0,
      savedUpToSeconds: durationSeconds,
      micSettings: PS.audio.micSettings(),
      echoCancellationOff: null,
      narrowbandWarn: false,
      narrowbandFractionAbove7k5: null,
      takeBandwidthHz: null,
      takeRmsDb: PS.routelab.rmsDb(snapshot),
      outputLatencySeconds: PS.audio.outputLatency(),
      outputLatencyAtStartSeconds: null,
      calibrationOutputLatencySeconds: null,
      outputLatencyDrift: false,
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.1',
      // Step 3 — the sound this take was sung with. Playback uses
      // the TAKE's sound, not the song's current one, so changing
      // the preset later never rewrites what this take sounds like.
      preset: state.session.preset,
      strength: state.session.strength,
      speed: state.session.speed,
      key: state.session.key,
      analysis: null // filled in after the take saves (Step 3)
    };
    var wav = new Blob([PS.wav.encodeWavFloat32(snapshot, sr)], { type: 'audio/wav' });
    PS.db.saveTake({
      id: takeId,
      sessionId: state.session.id,
      track: track,
      takeNumber: takeNumber,
      rawWav: wav,
      alignedWav: wav,
      metadata: metadata,
      recordedAt: metadata.recordedAt
    }).then(function () {
      vocal.takes.push({
        id: takeId,
        takeNumber: takeNumber,
        rawFileName: metadata.rawFileName,
        alignedFileName: metadata.alignedFileName,
        recordedAt: metadata.recordedAt,
        calibrated: false,
        delayMilliseconds: 0,
        durationSeconds: durationSeconds,
        residualVerdict: 'no-beat',
        partial: false,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: false,
        outputLatencyDrift: false,
        loggerRecovery: true,
        // Step 3 — same sound stamp as a recorded take.
        preset: state.session.preset,
        strength: state.session.strength,
        speed: state.session.speed,
        key: state.session.key,
        analysis: null
      });
      vocal.activeTakeId = takeId;
      saveSessions();
      renderTracks();
      renderSheet();
      updateTransport();
    }).catch(function (err) {
      console.warn('Logger take save failed:', err);
      showError('The last 60 seconds could not be saved — the phone may be out of space for this site.');
    });
  }

  // ---------------------------------------------------------------- takes

  function startTakeRequest(track) {
    if (state.recording || state.calibrating || state.startingTake) return;
    clearError();
    // A playing take or beat would double up with the take's beat —
    // stop it first. (The record button is disabled while playing is
    // loading, so this also cancels a play still starting up.)
    stopPlayback();
    // Refuse to arm with less than 500 MB free (Step 1B).
    storageGate().then(function (allowed) {
      if (allowed) beginTake(track);
    });
  }

  function beginTake(track) {
    var active = activeCalibration();
    var mode = PS.store.outputMode();
    var delaySeconds = null;
    if (mode === 'headphones' && active) {
      delaySeconds = active.calibration.delaySeconds;
    }
    // The ideas logger owns the mic while armed — stop it first so
    // the take can open the mic (one capture at a time).
    if (state.logger) disarmLogger(false);
    // The take id + number are fixed BEFORE recording starts, so the
    // chunked writes (Step 1B) can be keyed while the take records.
    var vocal = state.session.tracks[track];
    var takeId = PS.store.newId();
    var takeNumber = vocal.takes.length + 1;
    var chunkState = { count: 0 }; // shared with the onChunk closure
    // No calibration gate: record anyway. With no measured
    // headphones the take uses the nominal delay and is flagged
    // uncalibrated (see finishTake) — the check after the take
    // still catches part of the delay. Recording is never blocked.
    state.startingTake = true;
    updateTransport(); // the record button goes quiet while starting — a second tap must not start a second take
    $('live-strip').style.display = 'flex';
    $('record-hint').textContent = 'Getting ready…';
    setMeter(0);
    // Overdubs: the active takes of the OTHER vocal tracks, so ad-libs
    // and harmonies record over the lead. Same anchor as the beat —
    // they travel the same Bluetooth path, so they need the same
    // early start. (Port of AudioEngineManager.beginTake.)
    loadOverdubBuffers(track).then(function (overdubs) {
      return PS.audio.startTake({
        beat: state.beat,
        overdubs: overdubs,
        delaySeconds: delaySeconds,
        onBlock: function (batch) { setMeter(batch.peak); },
        // Chunked writes (Step 1B): one 48,000-sample chunk per
        // second, straight to storage while recording. A write
        // failure never fails the take — the in-memory recording
        // is still the primary copy.
        onChunk: function (index, samples) {
          chunkState.count = index + 1;
          PS.db.saveTakeChunk({
            key: PS.safety.chunkKey(state.session.id, track, takeId, index),
            sessionId: state.session.id,
            track: track,
            takeId: takeId,
            index: index,
            sampleRate: PS.audio.sampleRate(),
            data: samples
          }).catch(function (err) {
            console.warn('Chunk write failed (take continues in memory):', err);
          });
        }
      });
    }).then(function (handle) {
      state.startingTake = false;
      state.recording = {
        track: track,
        handle: handle,
        anchorTime: handle.anchorTime,
        startWall: Date.now(),
        interrupted: false,
        timer: setInterval(updateRecordTimer, 100),
        takeId: takeId,
        takeNumber: takeNumber,
        chunkState: chunkState,
        outputLatencyAtStart: PS.audio.outputLatency()
      };
      acquireWakeLock();
      $('live-strip').style.display = 'flex';
      $('record-hint').textContent = state.beat
        ? 'Recording — sing when the beat starts. Keep this page open.'
        : 'Recording — sing whenever you are ready. Keep this page open.';
      setPlayhead(0);
      ensurePlayheadTimer();
      renderTracks();
      updateTransport();
    }).catch(function (err) {
      state.startingTake = false;
      $('live-strip').style.display = 'none';
      $('record-hint').textContent = '';
      showError(err && err.message ? err.message : 'The take could not start. Try again.');
      renderTracks();
      updateTransport();
    });
  }

  function loadOverdubBuffers(exceptTrack) {
    var jobs = [];
    PS.store.TRACKS.forEach(function (kind) {
      if (kind === exceptTrack) return;
      var vocal = state.session.tracks[kind];
      if (!vocal) return;
      var takeId = vocal.activeTakeId || (vocal.takes.length ? vocal.takes[vocal.takes.length - 1].id : null);
      if (!takeId) return;
      jobs.push(
        PS.db.getTake(takeId).then(function (record) {
          if (!record || !record.alignedWav) return null;
          return record.alignedWav.arrayBuffer().then(function (buf) {
            return PS.audio.decodeAudio(buf);
          });
        }).catch(function () { return null; }) // a missing overdub never kills the take
      );
    });
    return Promise.all(jobs).then(function (buffers) {
      return buffers.filter(function (b) { return b !== null; });
    });
  }

  function updateRecordTimer() {
    if (!state.recording) return;
    var elapsed = (Date.now() - state.recording.startWall) / 1000;
    var label = $('record-timer');
    if (label) label.textContent = elapsed.toFixed(1) + 's';
  }

  function setMeter(peak) {
    var bar = $('level-bar');
    if (!bar) return;
    var pct = Math.min(100, Math.max(0, peak * 100));
    bar.style.width = pct + '%';
  }

  function stopTakeRequest() {
    if (!state.recording) return;
    finishTake(false);
  }

  /* Finishes the take: trim, residual check, save. (Port of
   * AudioEngineManager.finishTake + TrackRecorder.)
   */
  function finishTake(interrupted) {
    var rec = state.recording;
    if (!rec) return;
    state.recording = null;
    clearInterval(rec.timer);
    releaseWakeLock();
    setMeter(0);
    $('record-hint').textContent = '';
    $('live-strip').style.display = 'none';
    var timerEl = $('record-timer');
    if (timerEl) timerEl.textContent = '';
    clearPlayheadTimer();
    setPlayhead(0); // the take is done — back to the top, so Play hears it from the beginning

    var result = PS.audio.stopTake(rec.handle);
    var track = rec.track;
    var sr = PS.audio.sampleRate();
    var chunkCount = rec.chunkState ? rec.chunkState.count : 0;
    if (!result.samples || result.samples.length === 0 || result.firstSampleTime === null) {
      // Nothing recorded — drop any chunks so they never surface as
      // a phantom recovery on the next boot.
      if (rec.takeId) PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
      showError('Nothing was recorded — the mic did not pick up any sound.');
      renderTracks();
      updateTransport();
      return;
    }

    // --- Narrowband check (Step 1B). ---
    // If the recorded input has virtually no energy above 7.5 kHz,
    // the Bluetooth mic is in phone-call mode and the vocal is
    // crushed — no software recovers those frequencies. Warn him
    // plainly (and record it in the metadata) instead of silently
    // keeping a muffled take.
    var takeAnalysis = PS.routelab.analyzeTake(result.samples, sr);

    // --- Compensation. ---
    // Pre-comp ON: the beat was played early by D, so the vocal
    // already lands on time — trim the lead-in ONLY. Pre-comp OFF:
    // trim lead-in + delay (the post-shift path). The calibration and
    // the mode are the ones captured at take start.
    var leadInSamples = Math.max(0, Math.round((result.anchorTime - result.firstSampleTime) * sr));
    var active = activeCalibration();
    var mode = PS.store.outputMode();
    var delaySamples;
    var compensationSource;
    var calibrated;
    if (mode === 'headphones' && active) {
      delaySamples = Math.round(active.calibration.delaySeconds * sr);
      compensationSource = 'acoustic';
      calibrated = true;
    } else if (mode === 'headphones') {
      // No calibration ("Record anyway"): the nominal latency
      // UNDERSTATES the real Bluetooth delay — the take is flagged
      // uncalibrated, and the residual check may still catch part
      // of the unmeasured delay from the take itself.
      delaySamples = Math.round(PS.audio.nominalLatency() * sr);
      compensationSource = 'session-nominal-fallback';
      calibrated = false;
    } else {
      // Speaker: no Bluetooth codec in the path, so the nominal
      // latency IS the full delay. No calibration needed.
      delaySamples = Math.round(PS.audio.nominalLatency() * sr);
      compensationSource = 'session-nominal';
      calibrated = true;
    }
    var baseTrimSamples = result.preCompActive ? leadInSamples : leadInSamples + delaySamples;

    // Residual check: measure what is left after the base trim.
    var residual;
    if (state.beat && state.beat.mono) {
      residual = PS.residual.verify(result.samples, state.beat.mono, baseTrimSamples, sr);
    } else {
      residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
    }
    var trimSamples = Math.max(0, Math.min(baseTrimSamples + residual.trimSamples, result.samples.length));
    var alignedSamples = result.samples.subarray(trimSamples);
    if (alignedSamples.length < Math.round(0.3 * sr)) {
      // A tap-and-release (or a take sung entirely inside the
      // lead-in) leaves nothing after the trim — do not save an
      // empty take. Drop any chunks for the same reason as above.
      if (rec.takeId) PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
      showError('Too short to save — tap record and sing a little longer.');
      renderTracks();
      updateTransport();
      return;
    }

    var vocal = state.session.tracks[track];
    var takeNumber = rec.takeNumber;
    var baseName = 'take-' + takeNumber;
    var durationSeconds = alignedSamples.length / sr;
    // outputLatency drift (Step 0C): recalibrate when it has moved
    // more than 20 ms from the calibration's value.
    var outputLatencyNow = PS.audio.outputLatency();
    var calibrationOutputLatency = active && typeof active.calibration.outputLatencySeconds === 'number'
      ? active.calibration.outputLatencySeconds : null;
    var drifted = PS.safety.outputLatencyDrifted(calibrationOutputLatency, outputLatencyNow);
    var micSettings = PS.audio.micSettings();
    var metadata = {
      trackKind: track,
      rawFileName: baseName + '-raw.wav',
      alignedFileName: baseName + '.wav',
      sampleRate: sr,
      durationSeconds: durationSeconds,
      leadInSamples: leadInSamples,
      delaySamples: delaySamples,
      delayMilliseconds: delaySamples / sr * 1000,
      trimSamples: trimSamples,
      preCompensationActive: result.preCompActive,
      preCompensationDelayMilliseconds: result.preCompActive && result.delaySeconds !== null
        ? result.delaySeconds * 1000 : null,
      residualTrimSamples: residual.trimSamples,
      residualMilliseconds: residual.residualSeconds !== null ? residual.residualSeconds * 1000 : null,
      residualOnsets: residual.onsetCount,
      residualVerdict: residual.verdict,
      calibrationDeviceUID: null, // the web has no device identity
      calibrationLabel: active ? active.label : null,
      calibrationDeviceName: active ? active.label : null,
      calibrationDate: active ? active.calibration.date : null,
      calibrated: calibrated,
      compensationSource: compensationSource,
      interrupted: !!interrupted,
      // Step 1B — the take is durable from its chunks up to the last
      // full second; the rest was saved best-effort in memory.
      chunkCount: chunkCount,
      savedUpToSeconds: interrupted ? PS.safety.chunkedSeconds(chunkCount, sr) : durationSeconds,
      // Step 1B — the mic settings actually applied (verified via
      // track.getSettings() when the mic opened).
      micSettings: micSettings,
      echoCancellationOff: micSettings ? micSettings.echoCancellation === false : null,
      // Step 1B — narrowband warning (Bluetooth HFP mic).
      narrowbandWarn: takeAnalysis.narrowbandWarn,
      narrowbandFractionAbove7k5: takeAnalysis.fractionAbove7k5,
      takeBandwidthHz: takeAnalysis.bandwidthHz,
      takeRmsDb: takeAnalysis.rmsDb,
      // Step 0C — outputLatency next to the acoustic calibration.
      outputLatencySeconds: outputLatencyNow,
      outputLatencyAtStartSeconds: rec.outputLatencyAtStart,
      calibrationOutputLatencySeconds: calibrationOutputLatency,
      outputLatencyDrift: drifted,
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.1',
      // Step 3 — the sound this take was sung with. Playback uses
      // the TAKE's sound, not the song's current one, so changing
      // the preset later never rewrites what this take sounds like.
      preset: state.session.preset,
      strength: state.session.strength,
      speed: state.session.speed,
      key: state.session.key,
      analysis: null // filled in after the take saves (Step 3)
    };

    var rawWav = new Blob([PS.wav.encodeWavFloat32(result.samples, sr)], { type: 'audio/wav' });
    var alignedWav = new Blob([PS.wav.encodeWavFloat32(alignedSamples, sr)], { type: 'audio/wav' });
    var takeId = rec.takeId;
    var takeMeta = {
      id: takeId,
      takeNumber: takeNumber,
      rawFileName: metadata.rawFileName,
      alignedFileName: metadata.alignedFileName,
      recordedAt: metadata.recordedAt,
      calibrated: calibrated,
      delayMilliseconds: metadata.delayMilliseconds,
      durationSeconds: durationSeconds,
      residualVerdict: residual.verdict,
      partial: !!interrupted,
      savedUpToSeconds: metadata.savedUpToSeconds,
      narrowbandWarn: takeAnalysis.narrowbandWarn,
      outputLatencyDrift: drifted,
      // Step 3 — the take's own sound + its one-line summary.
      preset: state.session.preset,
      strength: state.session.strength,
      speed: state.session.speed,
      key: state.session.key,
      analysis: null
    };

    PS.db.saveTake({
      id: takeId,
      sessionId: state.session.id,
      track: track,
      takeNumber: takeNumber,
      rawWav: rawWav,
      alignedWav: alignedWav,
      metadata: metadata,
      recordedAt: metadata.recordedAt
    }).then(function () {
      vocal.takes.push(takeMeta);
      vocal.activeTakeId = takeId;
      saveSessions();
      // The take is saved — its chunks have done their job.
      PS.db.deleteTakeChunks(takeId).catch(function () { /* ignore */ });
      maybeCloseMic(); // review plays at full quality once the mic is closed
      renderTracks();
      renderSheet();
      updateTransport();
      // Step 3B — the take is saved: play it back tuned at once,
      // so he hears the finished sound without tapping Play. Only
      // takes worth hearing (2 s or more) play themselves.
      if (durationSeconds >= 2) {
        playTake(takeId);
      }
      // Step 3 — listen to the finished take once, in slices, and
      // write one plain-words line about it ("Sings around A3 —
      // most of the notes fit D minor"). Playback already started,
      // so this runs after it and never blocks the screen. The
      // recorded file is never touched — this only listens.
      if (PS.retune) {
        setTimeout(function () {
          try {
            PS.retune.analyzeChunked(alignedSamples, sr, state.session.key, function (summary) {
              takeMeta.analysis = summary;
              metadata.analysis = summary;
              saveSessions();
              // The stored record keeps the same summary, so the
              // line survives a reload (put() rewrites the whole
              // record — the sound files go back unchanged).
              PS.db.saveTake({
                id: takeId,
                sessionId: state.session.id,
                track: track,
                takeNumber: takeNumber,
                rawWav: rawWav,
                alignedWav: alignedWav,
                metadata: metadata,
                recordedAt: metadata.recordedAt
              }).catch(function () { /* the line still shows this session */ });
              renderSheet();
            });
          } catch (e) {
            // Analysis never breaks the take — it just stays
            // without its one-line summary.
          }
        }, 0);
      }
      if (takeAnalysis.narrowbandWarn) {
        showError('That take sounds muffled — your Bluetooth mic dropped to phone-call mode and crushed the high end. Switch to the phone mic or wired headphones for the lead vocal, then record it again.');
      } else if (drifted) {
        showError('The timing may have drifted since you measured these headphones — measure them again before the next take.');
      }
    }).catch(function (err) {
      console.warn('Take save failed:', err);
      showError('The take recorded but could not be saved — the phone may be out of space for this site.');
      renderTracks();
      updateTransport();
    });
  }

  // ---------------------------------------------------------------- playback

  /* Plays one take against the beat from the PLAYHEAD position.
   * The engine's playTake always starts its buffers at 0, so this
   * slices both buffers from the playhead offset first (stereo kept:
   * the slice is built channel by channel at the buffer's own
   * sample rate, on a scratch context used only for creating
   * buffers — no audio ever plays through it). If the playhead is
   * past the take, playback starts from 0 instead.
   */
  function sliceBuffer(buffer, startSeconds) {
    var sr = buffer.sampleRate;
    var startSample = Math.min(Math.floor(startSeconds * sr), buffer.length);
    var len = buffer.length - startSample;
    if (len <= 0) return null;
    if (!state.sliceCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      state.sliceCtx = new AC();
    }
    var out = state.sliceCtx.createBuffer(buffer.numberOfChannels, len, sr);
    for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
      out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample));
    }
    return out;
  }

  /* Step 3 — the sound a take plays back with: the take's own
   * preset/strength/speed/key, stamped when it was recorded. A take
   * saved before v12 has none of these stored (preset null,
   * strength null, speed undefined, key null) and falls back to the
   * song's current sound — the song's sound is what he heard when
   * he recorded it. Speed null (not undefined) means Auto.
   */
  function takeSound(take) {
    if (!take) {
      return {
        preset: state.session.preset,
        strength: state.session.strength,
        speed: state.session.speed,
        key: state.session.key
      };
    }
    return {
      preset: take.preset || state.session.preset,
      strength: typeof take.strength === 'number' ? take.strength : state.session.strength,
      speed: take.speed === undefined ? state.session.speed : take.speed,
      key: take.key || state.session.key
    };
  }

  function findTake(takeId) {
    var found = null;
    PS.store.TRACKS.forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      if (!vocal || found) return;
      var t = vocal.takes.find(function (x) { return x.id === takeId; });
      if (t) found = t;
    });
    return found;
  }

  function playTake(takeId) {
    if (state.playingStop) {
      var wasPlaying = state.playingTakeId;
      stopPlayback();
      if (wasPlaying === takeId) return;
    }
    if (state.recording || state.calibrating) return;
    clearError();
    // Generation: if another play starts (or the user stops) while
    // this take is still loading, the stale chain must not start
    // playing over it — or leave a take playing with no stop.
    var gen = ++state.playGen;
    PS.db.getTake(takeId).then(function (record) {
      if (!record || !record.alignedWav) {
        showError('That take could not be found.');
        return;
      }
      return record.alignedWav.arrayBuffer().then(function (buf) {
        return PS.audio.decodeAudio(buf);
      }).then(function (takeBuffer) {
        var offset = state.playheadSeconds;
        var playTakeBuffer = takeBuffer;
        var playBeatBuffer = state.beat ? state.beat.buffer : null;
        if (offset > 0.05) {
          if (offset >= takeBuffer.duration - 0.5) {
            offset = 0; // at (or nearly at) the end — start from the beginning, not a sliver of the tail
            setPlayhead(0);
          } else {
            playTakeBuffer = sliceBuffer(takeBuffer, offset);
            if (playBeatBuffer) {
              playBeatBuffer = offset >= playBeatBuffer.duration
                ? null : sliceBuffer(playBeatBuffer, offset);
            }
          }
        }
        state.playingStartOffset = offset;
        // Step 3 — this take plays with ITS sound, not the song's
        // current one.
        var sound = takeSound(findTake(takeId));
        return playTakeTuned(playTakeBuffer, playBeatBuffer, function () {
          state.playingStop = null;
          state.playingTakeId = null;
          clearPlayheadTimer();
          renderTracks();
          renderSheet();
          updateTransport();
        }, sound).then(function (stopFn) {
          if (gen !== state.playGen) {
            // A newer play won — stop this one before it is heard.
            if (stopFn) stopFn();
            return;
          }
          state.playingStop = stopFn;
          state.playingTakeId = takeId;
          // Set the clock anchor HERE (the players were just created
          // with anchor = currentTime + 0.1), not before the decode —
          // the decode time used to push the playhead ahead.
          state.playingStartCtx = PS.audio.currentTime() + 0.1;
          ensurePlayheadTimer();
          renderTracks();
          renderSheet();
          updateTransport();
        });
      });
    }).catch(function (err) {
      console.warn('Playback failed:', err);
      showError('That take could not be played.');
    });
  }

  function stopPlayback() {
    state.playGen += 1; // cancel any play still loading
    if (state.playingStop) state.playingStop();
    state.playingStop = null;
    state.playingTakeId = null;
    clearPlayheadTimer();
    renderTracks();
    renderSheet();
    updateTransport();
  }

  function playSelected() {
    if (state.playingStop) {
      stopPlayback();
      return;
    }
    var take = activeTakeOf(state.selectedTrack);
    if (take) {
      playTake(take.id);
      return;
    }
    // No take yet — play the beat alone, from the playhead, so the
    // singer can hear it and rehearse before recording.
    if (state.beat) playBeatOnly();
  }

  /* Plays just the beat (no take to tune — the beat plays dry).
   * The transport Play button used to do nothing at all before the
   * first take (it was even disabled); the beat is the song, so it
   * plays on its own.
   */
  function playBeatOnly() {
    if (!state.beat) return;
    if (state.recording || state.calibrating) return;
    clearError();
    // Same generation rule as playTake: a stale chain aborts.
    var gen = ++state.playGen;
    var offset = state.playheadSeconds;
    var beatBuffer = state.beat.buffer;
    if (offset > 0.05) {
      if (offset >= beatBuffer.duration - 0.5) {
        offset = 0; // at (or nearly at) the end — start from the beginning, not a sliver of the tail
        setPlayhead(0);
      } else {
        beatBuffer = sliceBuffer(beatBuffer, offset);
      }
    }
    state.playingStartOffset = offset;
    PS.audio.ensureContext().then(function (ctx) {
      var anchor = ctx.currentTime + 0.1;
      var player = ctx.createBufferSource();
      player.buffer = beatBuffer;
      player.connect(ctx.destination);
      player.start(anchor);
      if (gen !== state.playGen) {
        // A newer play won — stop this one before it is heard
        // (the anchor is 0.1 s out, so nothing has played yet).
        try { player.stop(); } catch (e) { /* ignore */ }
        try { player.disconnect(); } catch (e) { /* ignore */ }
        return;
      }
      state.playingStartCtx = anchor;
      var player = ctx.createBufferSource();
      player.buffer = beatBuffer;
      player.connect(ctx.destination);
      player.start(anchor);
      player.onended = function () {
        state.playingStop = null;
        state.playingTakeId = null;
        clearPlayheadTimer();
        renderTracks();
        updateTransport();
      };
      state.playingStop = function () {
        try { player.onended = null; player.stop(); } catch (e) { /* ignore */ }
        try { player.disconnect(); } catch (e) { /* ignore */ }
      };
      state.playingTakeId = 'beat-only';
      ensurePlayheadTimer();
      renderTracks();
      updateTransport();
    }).catch(function (err) {
      console.warn('Beat playback failed:', err);
      showError('The beat could not be played.');
    });
  }

  // ---------------------------------------------------------------- share / export

  function shareTake(takeId) {
    clearError();
    PS.db.getTake(takeId).then(function (record) {
      if (!record) {
        showError('That take could not be found.');
        return;
      }
      var metaJson = JSON.stringify(record.metadata, null, 2);
      var metaName = record.metadata.alignedFileName.replace(/\.wav$/i, '.json');
      var files = [
        new File([record.alignedWav], record.metadata.alignedFileName, { type: 'audio/wav' }),
        new File([metaJson], metaName, { type: 'application/json' })
      ];
      if (navigator.canShare && navigator.canShare({ files: files })) {
        return navigator.share({ files: files, title: 'Phone Studio take' }).catch(function (err) {
          if (err && err.name !== 'AbortError') throw err;
        });
      }
      // No share sheet — download the files instead.
      downloadBlob(record.alignedWav, record.metadata.alignedFileName);
      downloadBlob(new Blob([metaJson], { type: 'application/json' }), metaName);
    }).catch(function (err) {
      console.warn('Share failed:', err);
      showError('Sharing failed. Try the download buttons instead.');
    });
  }

  function shareSelected() {
    var take = activeTakeOf(state.selectedTrack);
    if (!take) return;
    shareTake(take.id);
  }

  /* One-tap backup (Step 1B): every take as one WAV, plus one JSON
   * with all the metadata, calibrations, and lab reports — through
   * the share sheet (no zip: iOS cannot open one from a share). If
   * the share sheet cannot take the files, each one downloads
   * instead.
   */
  function backupAllTakes() {
    var status = $('backup-status');
    if (status) status.textContent = 'Gathering your takes…';
    var jobs = state.sessions.map(function (session) {
      return PS.db.getTakesBySession(session.id).then(function (takes) {
        return { session: session, takes: takes || [] };
      }).catch(function () { return { session: session, takes: [] }; });
    });
    Promise.all(jobs).then(function (groups) {
      var files = [];
      var manifest = {
        exportedAt: new Date().toISOString(),
        appVersion: 'pwa-1.1',
        sessions: [],
        calibrations: PS.store.loadCalibrations(),
        labReports: PS.store.loadLabReports()
      };
      groups.forEach(function (g) {
        var entry = { name: g.session.name, key: g.session.key, takes: [] };
        g.takes.forEach(function (take) {
          var safeName = (g.session.name + '-' + take.track + '-take' + take.takeNumber)
            .replace(/[^A-Za-z0-9._-]+/g, '-');
          files.push(new File([take.alignedWav], safeName + '.wav', { type: 'audio/wav' }));
          entry.takes.push(take.metadata);
        });
        manifest.sessions.push(entry);
      });
      files.push(new File([JSON.stringify(manifest, null, 2)], 'phone-studio-backup.json', { type: 'application/json' }));
      if (files.length === 1) {
        if (status) status.textContent = 'No takes to back up yet.';
        return;
      }
      if (status) status.textContent = 'Backing up ' + (files.length - 1) + ' take' + (files.length - 1 === 1 ? '' : 's') + '…';
      if (navigator.canShare && navigator.canShare({ files: files })) {
        return navigator.share({ files: files, title: 'Phone Studio backup' }).then(function () {
          if (status) status.textContent = 'Backed up ' + (files.length - 1) + ' take' + (files.length - 1 === 1 ? '' : 's') + '.';
        }).catch(function (err) {
          if (err && err.name === 'AbortError') {
            if (status) status.textContent = '';
            return;
          }
          throw err;
        });
      }
      // No share sheet — download the files one by one.
      files.forEach(function (f) { downloadBlob(f, f.name); });
      if (status) status.textContent = 'Downloaded ' + files.length + ' files.';
    }).catch(function (err) {
      console.warn('Backup failed:', err);
      if (status) status.textContent = '';
      showError('The backup could not be made. Try again.');
    });
  }

  function downloadRawTake(takeId) {
    PS.db.getTake(takeId).then(function (record) {
      if (!record) return;
      downloadBlob(record.rawWav, record.metadata.rawFileName);
    });
  }

  function deleteTake(track, takeId) {
    if (!window.confirm('Delete this take? It cannot be undone.')) return;
    var vocal = state.session.tracks[track];
    vocal.takes = vocal.takes.filter(function (t) { return t.id !== takeId; });
    if (vocal.activeTakeId === takeId) {
      vocal.activeTakeId = vocal.takes.length ? vocal.takes[vocal.takes.length - 1].id : null;
    }
    delete state.waveCache[takeId];
    state.waveCacheOrder = state.waveCacheOrder.filter(function (id) { return id !== takeId; });
    saveSessions();
    PS.db.deleteTake(takeId).catch(function () { /* ignore */ });
    if (state.playingTakeId === takeId) stopPlayback();
    renderTracks();
    renderSheet();
    updateTransport();
  }

  function setActiveTake(track, takeId) {
    state.session.tracks[track].activeTakeId = takeId;
    saveSessions();
    renderTracks();
    renderSheet();
    updateTransport();
  }

  // ---------------------------------------------------------------- live tune

  /* The live tune (Voloco's Starter presets): YIN pitch detection
   * -> snap to the song key -> PSOLA shift, in an AudioWorklet
   * (tune-worklet.js — a port of the native app's live-tune
   * prototype). Five presets (Hard Tune, Natural Tune, Super
   * Vocoder, Big Chorus, Clean) + a strength slider, at the song's
   * key. The take stays DRY — the tune runs on the MONITOR (live,
   * while singing) and on take PLAYBACK (the recorded take is tuned
   * as it plays), never baked into the file.
   *
   * Two nodes share the processor: one for the live monitor branch,
   * one for playback. (Separate nodes so the live mic and a playing
   * take never mix inside one detector.) The monitor node runs in
   * live mode — Big Chorus renders 4 voices there to save phone
   * CPU; playback renders the full 7.
   */
  function ensureTuneModule() {
    if (state.tuneModuleReady) return PS.audio.ensureContext();
    return PS.audio.ensureContext().then(function (ctx) {
      return ctx.audioWorklet.addModule('tune-worklet.js').then(function () {
        state.tuneModuleReady = true;
        return ctx;
      });
    });
  }

  function makeTuneNode(ctx, isLive) {
    var node = new AudioWorkletNode(ctx, 'tune-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1]
    });
    node.port.postMessage({ type: 'key', key: state.session.key });
    node.port.postMessage({ type: 'preset', preset: state.session.preset });
    node.port.postMessage({ type: 'strength', value: state.session.strength });
    node.port.postMessage({ type: 'speed', value: state.session.speed });
    node.port.postMessage({ type: 'live', on: !!isLive });
    node.port.postMessage({ type: 'enabled', on: true });
    return node;
  }

  function broadcastTune() {
    // The song key, preset, strength, or speed changed — retune
    // every live tune node (monitor + playback) so what he hears
    // changes at once, even mid-playback.
    var messages = [
      { type: 'key', key: state.session.key },
      { type: 'preset', preset: state.session.preset },
      { type: 'strength', value: state.session.strength },
      { type: 'speed', value: state.session.speed }
    ];
    [state.monitor && state.monitor.tune, state.playbackTune].forEach(function (node) {
      if (!node) return;
      messages.forEach(function (msg) { node.port.postMessage(msg); });
    });
  }

  /* The monitor branch: mic -> tune -> headphones, live. It runs
   * only when the toggle is on AND headphones are the output AND
   * calibration is not running (the monitor would loop the clicks
   * back into the measurement).
   */
  function monitorWanted() {
    return state.monitorOn &&
      PS.store.outputMode() === 'headphones' &&
      !state.calibrating;
  }

  function updateMonitor() {
    if (monitorWanted()) {
      if (state.monitor) return; // already running
      // The start runs on a 3-second timeout: after a calibration
      // finishes (not a tap), the context resume can hang on iOS
      // Safari, and a hang must become a visible error — never a
      // toggle that says ON with no sound. (If the start resolves
      // late, the monitorWanted guard below still refuses to build
      // the branch, because the timeout already turned the toggle
      // off.)
      var startJob = ensureTuneModule().then(function (ctx) {
        return PS.audio.ensureMic().then(function (stream) {
          // The toggle may have flipped while the mic was opening.
          if (!monitorWanted() || state.monitor) return;
          var source = ctx.createMediaStreamSource(stream);
          var gain = ctx.createGain();
          gain.gain.value = 0;
          var tune = makeTuneNode(ctx, true); // live mode: chorus renders 4 voices
          source.connect(gain);
          gain.connect(tune);
          tune.connect(ctx.destination);
          state.monitor = { source: source, gain: gain, tune: tune };
          gain.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
        });
      });
      withTimeout(startJob, 3000, 'Monitor start timed out.').catch(function (err) {
        console.warn('Monitor could not start:', err);
        state.monitorOn = false;
        updateTransport();
        showError('Could not hear yourself — the mic did not open. Try again.');
      });
      return;
    }
    // Not wanted — tear the branch down (fade first, no click).
    if (!state.monitor) return;
    var mon = state.monitor;
    state.monitor = null;
    PS.audio.ensureContext().then(function (ctx) {
      try { mon.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01); } catch (e) { /* ignore */ }
      setTimeout(function () {
        try { mon.source.disconnect(); } catch (e) { /* ignore */ }
        try { mon.gain.disconnect(); } catch (e) { /* ignore */ }
        try { mon.tune.disconnect(); } catch (e) { /* ignore */ }
        maybeCloseMic(); // nothing needs the mic now — review plays at full quality
      }, 120);
    }).catch(function () {
      try { mon.source.disconnect(); } catch (e) { /* ignore */ }
      try { mon.gain.disconnect(); } catch (e) { /* ignore */ }
      try { mon.tune.disconnect(); } catch (e) { /* ignore */ }
      maybeCloseMic();
    });
  }

  function toggleMonitor() {
    if (PS.store.outputMode() !== 'headphones') {
      showError('Put your headphones on to hear yourself while you sing — through the speaker it would feed back.');
      return;
    }
    state.monitorOn = !state.monitorOn;
    updateMonitor();
    updateTransport();
  }

  /* Plays the take (tuned) against the beat, both from the anchor.
   * The take runs through the tune worklet so Denasse hears the
   * chosen preset on playback — the same sound as the live monitor.
   * The beat goes straight to the output. (The tune adds ~8 ms to
   * the vocal — the vocoder ~0 ms more, its carrier is real-time —
   * that is inside the app's own 15 ms timing tolerance, so the
   * beat is not delayed to match.) If the tune cannot start, the
   * take plays dry and he is told — never silently wrong.
   */
  function playTakeTuned(takeBuffer, beatBuffer, onEnded, opts) {
    return ensureTuneModule().then(function (ctx) {
      if (!state.playbackTune) {
        state.playbackTune = makeTuneNode(ctx, false); // full 7-voice chorus on playback
        state.playbackTune.connect(ctx.destination);
      }
      var tune = state.playbackTune;
      // Step 3 — `opts` is the TAKE's sound; without it, the song's
      // current sound (the old behaviour).
      var sound = opts || {
        key: state.session.key,
        preset: state.session.preset,
        strength: state.session.strength,
        speed: state.session.speed
      };
      tune.port.postMessage({ type: 'reset' });
      tune.port.postMessage({ type: 'key', key: sound.key });
      tune.port.postMessage({ type: 'preset', preset: sound.preset });
      tune.port.postMessage({ type: 'strength', value: sound.strength });
      tune.port.postMessage({ type: 'speed', value: sound.speed });
      tune.port.postMessage({ type: 'enabled', on: true });
      var anchor = PS.audio.currentTime() + 0.1;
      var players = [];
      var takePlayer = ctx.createBufferSource();
      takePlayer.buffer = takeBuffer;
      takePlayer.connect(tune);
      takePlayer.start(anchor);
      if (onEnded) {
        takePlayer.onended = function () {
          // The take ended — the song is over. Stop the beat too
          // (it outlasts every take) or it plays on with no stop
          // button, then tell the UI playback is over.
          players.forEach(function (p) {
            if (p === takePlayer) return;
            try { p.stop(); } catch (e) { /* ignore */ }
            try { p.disconnect(); } catch (e) { /* ignore */ }
          });
          onEnded();
        };
      }
      players.push(takePlayer);
      if (beatBuffer) {
        var beatPlayer = ctx.createBufferSource();
        beatPlayer.buffer = beatBuffer;
        beatPlayer.connect(ctx.destination);
        beatPlayer.start(anchor);
        players.push(beatPlayer);
      }
      return function stop() {
        players.forEach(function (p) {
          try { p.onended = null; p.stop(); } catch (e) { /* ignore */ }
          try { p.disconnect(); } catch (e) { /* ignore */ }
        });
      };
    }).catch(function (err) {
      console.warn('Tuned playback failed, playing dry:', err);
      showError('The tune could not start — playing the raw take instead.');
      return PS.audio.playTake(takeBuffer, beatBuffer, onEnded);
    });
  }

  // ---------------------------------------------------------------- waveforms

  /* Peaks: one magnitude (0..1) per bucket — the loudest absolute
   * sample in that slice of the audio. Computed once at PEAK_BUCKETS
   * and downsampled to the lane width when drawn.
   */
  function computePeaks(samples, buckets) {
    var peaks = new Float32Array(buckets);
    if (!samples || samples.length === 0) return peaks;
    var perBucket = samples.length / buckets;
    for (var b = 0; b < buckets; b++) {
      var start = Math.floor(b * perBucket);
      var end = Math.min(samples.length, Math.floor((b + 1) * perBucket));
      var max = 0;
      for (var i = start; i < end; i++) {
        var v = samples[i];
        if (v < 0) v = -v;
        if (v > max) max = v;
      }
      peaks[b] = max > 1 ? 1 : max;
    }
    return peaks;
  }

  function cacheWave(takeId, entry) {
    if (!state.waveCache[takeId]) {
      state.waveCacheOrder.push(takeId);
      while (state.waveCacheOrder.length > WAVE_CACHE_MAX) {
        var oldest = state.waveCacheOrder.shift();
        delete state.waveCache[oldest];
      }
    }
    state.waveCache[takeId] = entry;
  }

  /* Decodes a take's aligned WAV and caches its peaks + duration.
   * Returns a promise resolving to the entry (or null on failure —
   * a missing wave never breaks the row).
   */
  function getTakeWave(takeId) {
    if (state.waveCache[takeId]) return Promise.resolve(state.waveCache[takeId]);
    return PS.db.getTake(takeId).then(function (record) {
      if (!record || !record.alignedWav) return null;
      return record.alignedWav.arrayBuffer().then(function (buf) {
        return PS.audio.decodeAudio(buf);
      }).then(function (audioBuffer) {
        var entry = {
          peaks: computePeaks(audioBuffer.getChannelData(0), PEAK_BUCKETS),
          duration: audioBuffer.duration
        };
        cacheWave(takeId, entry);
        return entry;
      });
    }).catch(function () { return null; });
  }

  function getBeatWave() {
    if (!state.beat || !state.beat.mono) return null;
    if (!state.beat.peaks) {
      state.beat.peaks = computePeaks(state.beat.mono, PEAK_BUCKETS);
    }
    return { peaks: state.beat.peaks, duration: state.beat.duration };
  }

  /* The timeline covers the longest thing on it (beat or active
   * takes), with a 30-second floor so a short take does not stretch
   * across the whole lane. Recomputed whenever waves resolve.
   */
  function updateTimeline() {
    var longest = MIN_TIMELINE_SECONDS;
    if (state.beat) longest = Math.max(longest, state.beat.duration);
    PS.store.TRACKS.forEach(function (kind) {
      var take = activeTakeOf(kind);
      if (!take) return;
      var cached = state.waveCache[take.id];
      var d = cached ? cached.duration : (take.durationSeconds || 0);
      if (d > longest) longest = d;
    });
    if (Math.abs(longest - state.timelineSeconds) > 0.01) {
      state.timelineSeconds = longest;
      drawAllWaves();
      renderPlayhead();
    }
  }

  /* Draws one lane: real bars where the audio is, a dotted baseline
   * where it is not. The wave occupies [0, duration] on the shared
   * timeline — every lane is on the same time scale, like Voloco.
   */
  function drawWave(canvas, wave, color) {
    if (!canvas) return;
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var mid = h / 2;
    var maxBar = h * 0.42;
    // Dotted baseline across the whole lane (the empty-region look).
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    for (var x = 2; x < w; x += 7) {
      ctx.beginPath();
      ctx.arc(x, mid, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!wave || !wave.peaks) return;
    var span = Math.max(1, (wave.duration / state.timelineSeconds) * w);
    var barW = 2;
    var gap = 1;
    var step = barW + gap;
    var bars = Math.max(1, Math.floor(span / step));
    ctx.fillStyle = color;
    for (var b = 0; b < bars; b++) {
      var from = Math.floor((b / bars) * PEAK_BUCKETS);
      var to = Math.max(from + 1, Math.floor(((b + 1) / bars) * PEAK_BUCKETS));
      var peak = 0;
      for (var i = from; i < to && i < PEAK_BUCKETS; i++) {
        if (wave.peaks[i] > peak) peak = wave.peaks[i];
      }
      var barH = Math.max(2, peak * maxBar * 2);
      var bx = b * step;
      ctx.beginPath();
      var r = Math.min(barW / 2, barH / 2);
      var top = mid - barH / 2;
      if (ctx.roundRect) {
        ctx.roundRect(bx, top, barW, barH, r);
      } else {
        ctx.rect(bx, top, barW, barH);
      }
      ctx.fill();
    }
  }

  function drawAllWaves() {
    var rows = document.querySelectorAll('.track-row');
    rows.forEach(function (row) {
      var canvas = row.querySelector('canvas');
      if (!canvas) return;
      var kind = row.getAttribute('data-track');
      var color = getComputedStyle(row).getPropertyValue('--track-accent').trim() || '#8b5cf6';
      if (kind === 'beat') {
        drawWave(canvas, getBeatWave(), '#e5e5e5');
        return;
      }
      var take = activeTakeOf(kind);
      if (!take) {
        drawWave(canvas, null, color);
        return;
      }
      var cached = state.waveCache[take.id];
      if (cached) {
        drawWave(canvas, cached, color);
      } else {
        drawWave(canvas, null, color);
        getTakeWave(take.id).then(function (entry) {
          if (!entry) return;
          updateTimeline();
          var live = document.querySelector('.track-row[data-track="' + kind + '"] canvas');
          if (live) drawWave(live, entry, color);
        });
      }
    });
  }

  // ---------------------------------------------------------------- playhead

  function fmtPlayhead() {
    $('time-label').textContent = fmtClock(state.playheadSeconds);
  }

  function laneRect() {
    var canvas = document.querySelector('.track-row canvas');
    var wrap = document.querySelector('.tracks-wrap');
    if (!canvas || !wrap) return null;
    var c = canvas.getBoundingClientRect();
    var w = wrap.getBoundingClientRect();
    return { left: c.left - w.left, width: c.width };
  }

  function renderPlayhead() {
    var line = $('playhead');
    var rect = laneRect();
    if (!rect || rect.width <= 0) {
      line.style.display = 'none';
      fmtPlayhead();
      return;
    }
    var frac = Math.max(0, Math.min(1, state.playheadSeconds / state.timelineSeconds));
    line.style.display = '';
    line.style.left = (rect.left + frac * rect.width) + 'px';
    fmtPlayhead();
  }

  function setPlayhead(seconds) {
    state.playheadSeconds = Math.max(0, Math.min(state.timelineSeconds, seconds));
    renderPlayhead();
  }

  function tickPlayhead() {
    if (state.recording) {
      var pos = PS.audio.currentTime() - state.recording.anchorTime;
      setPlayhead(Math.max(0, pos));
    } else if (state.playingStop) {
      var elapsed = PS.audio.currentTime() - state.playingStartCtx;
      setPlayhead(state.playingStartOffset + Math.max(0, elapsed));
    }
  }

  function ensurePlayheadTimer() {
    if (state.playheadTimer) return;
    state.playheadTimer = setInterval(tickPlayhead, 100);
  }

  function clearPlayheadTimer() {
    if (!state.playheadTimer) return;
    if (state.recording || state.playingStop) return; // the other one still needs it
    clearInterval(state.playheadTimer);
    state.playheadTimer = null;
  }

  /* Scrub: press/drag on the lanes moves the playhead. Ignored while
   * recording (the playhead is live then) and on buttons.
   */
  function scrubFromEvent(event) {
    var rect = laneRect();
    if (!rect || rect.width <= 0) return;
    var wrap = document.querySelector('.tracks-wrap');
    var wrapRect = wrap.getBoundingClientRect();
    var x = (event.clientX - wrapRect.left) - rect.left;
    var frac = Math.max(0, Math.min(1, x / rect.width));
    setPlayhead(frac * state.timelineSeconds);
  }

  /* A press on a vocal row SELECTS it (selection happens on
   * pointerdown, not click — pointer capture would retarget the
   * click and break it, so no capture is used here). A press on the
   * beat row with no beat opens the import picker. A press on the
   * track's NAME only selects it — it does not move the playhead or
   * stop playback. Scrubbing starts from the waveform lane.
   */
  function onTracksPointerDown(event) {
    if (event.target.closest('button')) return;
    var row = event.target.closest('.track-row');
    if (row) {
      var kind = row.getAttribute('data-track');
      if (kind === 'beat') {
        if (!state.beat) {
          $('beat-file').click();
          return;
        }
      } else {
        selectTrack(kind);
      }
      if (event.target.closest('.row-label')) return;
    }
    if (state.recording) return;
    if (state.playingStop) stopPlayback();
    state.scrubbing = true;
    scrubFromEvent(event);
  }

  function onTracksPointerMove(event) {
    if (!state.scrubbing) return;
    scrubFromEvent(event);
  }

  function onTracksPointerUp() {
    state.scrubbing = false;
  }

  // ---------------------------------------------------------------- rendering

  function renderSession() {
    $('song-name').value = state.session.name;
    $('topbar-song-name').textContent = state.session.name;
    $('topbar-song-key').textContent = state.session.key;
    var sessionSelect = $('session-select');
    sessionSelect.innerHTML = '';
    state.sessions.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === state.session.id) opt.selected = true;
      sessionSelect.appendChild(opt);
    });
  }

  /* The song key — set from the key picker (top bar) or from the
   * beat's detected key (Step 9A). `manual` is true when Denasse
   * picked it himself — his pick always wins over the beat's guess
   * from then on. Retunes every live tune node at once (monitor +
   * playback).
   */
  function applyKey(key, manual) {
    var parsed = parseKey(key);
    var composed = parsed.tonic + ' ' + parsed.scale;
    state.session.key = composed;
    if (manual) {
      state.session.keyManuallySet = true;
      state.session.keySource = 'manual';
    }
    saveSessions();
    renderSession();
    broadcastTune();
  }

  function setKey(key) {
    applyKey(key, true);
  }

  /* The beat row is built by renderTracks — this just re-renders. */
  function renderBeat() {
    renderTracks();
    updateTransport(); // the beat arriving (or leaving) changes what Play can do
  }

  function renderCalibration() {
    var mode = PS.store.outputMode();
    $('mode-headphones').checked = mode === 'headphones';
    $('mode-speaker').checked = mode === 'speaker';
    $('headphones-box').style.display = mode === 'headphones' ? '' : 'none';
    $('speaker-note').style.display = mode === 'speaker' ? '' : 'none';

    var list = $('cal-list');
    list.innerHTML = '';
    var labels = Object.keys(state.calibrations);
    var activeLabel = PS.store.activeCalibrationLabel();
    if (labels.length === 0) {
      list.appendChild(el('p', 'muted', 'No headphones measured yet.'));
    }
    labels.forEach(function (label) {
      var cal = state.calibrations[label];
      var row = el('div', 'cal-row');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'headphones';
      radio.value = label;
      radio.checked = label === activeLabel;
      radio.addEventListener('change', function () {
        PS.store.setActiveCalibrationLabel(label);
        renderCalibration();
      });
      var text = el('span', '', label + ' — ' + Math.round(cal.delayMs) + ' ms, measured ' + fmtTime(cal.date));
      var del = el('button', 'btn-small danger', 'Remove');
      del.addEventListener('click', function () {
        if (!window.confirm('Remove the measurement for "' + label + '"?')) return;
        PS.store.deleteCalibration(label);
        state.calibrations = PS.store.loadCalibrations();
        renderCalibration();
      });
      row.appendChild(radio);
      row.appendChild(text);
      row.appendChild(del);
      list.appendChild(row);
    });

    $('cal-measure').disabled = state.calibrating;
    $('cal-measure').textContent = state.calibrating ? 'Measuring…' : 'Measure my headphones';
    if (!state.calibrating && !$('cal-status').textContent) {
      var active = activeCalibration();
      $('cal-status').textContent = active
        ? 'Using ' + active.label + ' — your voice will land in time.'
        : 'Not measured yet.';
    }
    // Step 0C — a pair of headphones the app has never seen appeared.
    // One calibration per pair: prompt to measure the new one.
    var newDeviceLine = $('cal-new-device');
    if (newDeviceLine) {
      newDeviceLine.style.display = state.newDeviceDetected ? '' : 'none';
    }
  }

  function selectTrack(kind) {
    if (state.selectedTrack === kind) return;
    state.selectedTrack = kind;
    renderTracks();
    updateTransport();
  }

  function renderTracks() {
    var container = $('tracks');
    container.innerHTML = '';
    PS.store.TRACKS.forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      var row = el('div', 'track-row' + (kind === state.selectedTrack ? ' selected' : ''));
      row.setAttribute('data-track', kind);
      var label = el('div', 'row-label');
      var name = el('div', 'row-name');
      name.innerHTML = MIC_SVG;
      name.appendChild(document.createTextNode(PS.store.TRACK_NAMES[kind]));
      label.appendChild(name);
      var active = activeTakeOf(kind);
      label.appendChild(el('div', 'row-sub', active ? 'Take ' + active.takeNumber : ''));
      row.appendChild(label);
      var lane = el('div', 'wave-lane');
      lane.appendChild(document.createElement('canvas'));
      row.appendChild(lane);
      var more = el('button', 'row-more', '···');
      more.setAttribute('aria-label', PS.store.TRACK_NAMES[kind] + ' takes');
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        openTakeSheet(kind);
      });
      row.appendChild(more);
      container.appendChild(row);
    });

    // The beat is the bottom row, on the same timeline.
    var beatRow = el('div', 'track-row beat-row');
    beatRow.setAttribute('data-track', 'beat');
    var beatLabel = el('div', 'row-label');
    var beatName = el('div', 'row-name');
    beatName.innerHTML = NOTE_SVG;
    beatName.appendChild(document.createTextNode('Beat'));
    beatLabel.appendChild(beatName);
    var beatSub;
    if (state.beat) {
      beatSub = state.beat.originalName + ' — ' + Math.round(state.beat.duration) + 's';
      // Step 9A — what the beat detector heard, in plain words.
      var detected = [];
      if (state.session.beatKey) detected.push(state.session.beatKey);
      if (typeof state.session.bpm === 'number') detected.push(state.session.bpm + ' BPM');
      if (detected.length) beatSub += ' — ' + detected.join(' · ');
    } else if (state.beatLoading) {
      beatSub = 'Loading…';
    } else if (state.session.beatOriginalName) {
      beatSub = state.session.beatOriginalName + ' — loading…';
    } else {
      beatSub = 'Tap to import';
    }
    beatLabel.appendChild(el('div', 'row-sub', beatSub));
    beatRow.appendChild(beatLabel);
    var beatLane = el('div', 'wave-lane');
    beatLane.appendChild(document.createElement('canvas'));
    if (!state.beat) {
      var importBtn = el('button', 'btn-small lane-btn', 'Import a beat');
      importBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        $('beat-file').click();
      });
      beatLane.appendChild(importBtn);
    }
    beatRow.appendChild(beatLane);
    if (state.beat) {
      var remove = el('button', 'row-more', '×');
      remove.setAttribute('aria-label', 'Remove beat');
      remove.addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeBeat();
      });
      beatRow.appendChild(remove);
    }
    container.appendChild(beatRow);

    updateTimeline();
    requestAnimationFrame(function () {
      drawAllWaves();
      renderPlayhead();
    });
  }

  // ---------------------------------------------------------------- take sheet

  function openTakeSheet(track) {
    state.sheetTrack = track;
    renderSheet();
    $('take-sheet').style.display = 'flex';
  }

  function closeTakeSheet() {
    state.sheetTrack = null;
    $('take-sheet').style.display = 'none';
  }

  /* Step 3 — the post-record analysis as one plain-words line.
   * "Sings around A3 — most of the notes fit D minor." When the
   * take is mostly quiet, say that instead of guessing.
   */
  function analysisLine(a) {
    if (!a || !a.dominantNote) {
      if (a && typeof a.voicedFraction === 'number' && a.voicedFraction < 0.1) {
        return 'Mostly quiet — not enough singing to check.';
      }
      return null;
    }
    var line = 'Sings around ' + a.dominantNote;
    if (a.inKeyFraction !== null && a.inKeyFraction !== undefined && a.key) {
      if (a.inKeyFraction >= 0.95) line += ' — all of the notes fit ' + a.key + '.';
      else if (a.inKeyFraction >= 0.75) line += ' — most of the notes fit ' + a.key + '.';
      else if (a.inKeyFraction >= 0.5) line += ' — about half the notes fit ' + a.key + '.';
      else line += ' — most of the notes fall outside ' + a.key + '.';
    }
    return line;
  }

  /* Step 3 — this take's own sound, changeable right in its row.
   * The preset, strength, and speed save with the take at once; if
   * the take is playing, it restarts so he hears the change now.
   * (The recorded file never changes — these only steer playback.)
   */
  function takeSoundControls(kind, take) {
    var sound = takeSound(take);
    var box = el('div', 'take-sound');
    box.appendChild(el('div', 'take-sound-label', 'Sound for this take'));
    var presetSel = document.createElement('select');
    presetSel.setAttribute('aria-label', 'Sound for Take ' + take.takeNumber);
    PRESETS.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      if (p.id === sound.preset) opt.selected = true;
      presetSel.appendChild(opt);
    });
    presetSel.addEventListener('change', function () {
      take.preset = presetSel.value;
      saveSessions();
      restartTakeIfPlaying(take);
    });
    box.appendChild(presetSel);
    var strRow = el('div', 'strength-row');
    strRow.appendChild(el('label', '', 'Strength'));
    var strSlider = document.createElement('input');
    strSlider.type = 'range';
    strSlider.min = '0';
    strSlider.max = '100';
    strSlider.value = String(sound.strength);
    strSlider.setAttribute('aria-label', 'Tune strength for Take ' + take.takeNumber);
    var strVal = el('span', '', sound.strength + '%');
    strSlider.addEventListener('input', function () {
      take.strength = Number(strSlider.value);
      strVal.textContent = take.strength + '%';
    });
    strSlider.addEventListener('change', function () {
      take.strength = Number(strSlider.value);
      saveSessions();
      restartTakeIfPlaying(take);
    });
    strRow.appendChild(strSlider);
    strRow.appendChild(strVal);
    box.appendChild(strRow);
    var spdRow = el('div', 'strength-row');
    spdRow.appendChild(el('label', '', 'Speed'));
    var spdSlider = document.createElement('input');
    spdSlider.type = 'range';
    spdSlider.min = '0';
    spdSlider.max = '100';
    spdSlider.value = String(sound.speed === null ? 50 : sound.speed);
    spdSlider.setAttribute('aria-label', 'Tune speed for Take ' + take.takeNumber);
    var spdVal = el('span', '', sound.speed === null ? 'Auto' : sound.speed + '%');
    spdSlider.addEventListener('input', function () {
      take.speed = Number(spdSlider.value);
      spdVal.textContent = take.speed + '%';
    });
    spdSlider.addEventListener('change', function () {
      take.speed = Number(spdSlider.value);
      saveSessions();
      restartTakeIfPlaying(take);
    });
    var autoBtn = el('button', 'btn-small' + (sound.speed === null ? ' current' : ''), 'Auto');
    autoBtn.addEventListener('click', function () {
      take.speed = null;
      saveSessions();
      restartTakeIfPlaying(take);
      renderSheet();
    });
    spdRow.appendChild(spdSlider);
    spdRow.appendChild(spdVal);
    spdRow.appendChild(autoBtn);
    box.appendChild(spdRow);
    return box;
  }

  function restartTakeIfPlaying(take) {
    if (take.id !== state.playingTakeId) return;
    stopPlayback();
    playTake(take.id);
  }

  function renderSheet() {
    if (!state.sheetTrack) return;
    var kind = state.sheetTrack;
    var vocal = state.session.tracks[kind];
    $('sheet-title').textContent = PS.store.TRACK_NAMES[kind] + ' — Takes';
    var list = $('sheet-list');
    list.innerHTML = '';
    if (vocal.takes.length === 0) {
      list.appendChild(el('p', 'muted', 'No takes yet.'));
      return;
    }
    vocal.takes.slice().reverse().forEach(function (take) {
      var row = el('div', 'take-row');
      var isActive = take.id === vocal.activeTakeId;
      var isPlaying = take.id === state.playingTakeId;
      var info = el('div', 'take-info');
      info.appendChild(el('strong', '', 'Take ' + take.takeNumber + (isActive ? ' ✓' : '')));
      var subBits = [fmtTime(take.recordedAt)];
      if (!take.calibrated) subBits.push('not measured, timing may be off');
      if (take.partial) subBits.push(PS.safety.fmtSavedUpTo(take.savedUpToSeconds || 0) + ' — interrupted');
      if (take.recovered) subBits.push('recovered after the app closed');
      if (take.narrowbandWarn) subBits.push('Bluetooth mic warning — sounds muffled');
      if (take.outputLatencyDrift) subBits.push('timing drifted — measure the headphones again');
      if (take.residualVerdict) subBits.push(VERDICT_TEXT[take.residualVerdict] || take.residualVerdict);
      var sub = el('div', 'muted small', subBits.join(' — '));
      info.appendChild(sub);
      // Step 3 — one plain-words line about what the take sings.
      if (take.analysis) {
        var line = analysisLine(take.analysis);
        if (line) info.appendChild(el('div', 'muted small', line));
      }
      row.appendChild(info);
      // Step 3 — this take's own sound, changeable right here.
      row.appendChild(takeSoundControls(kind, take));
      var actions = el('div', 'take-actions');
      var play = el('button', 'btn-small', isPlaying ? 'Stop' : 'Play');
      play.addEventListener('click', function () {
        if (isPlaying) stopPlayback(); else playTake(take.id);
      });
      var send = el('button', 'btn-small', 'Send');
      send.addEventListener('click', function () { shareTake(take.id); });
      var raw = el('button', 'btn-small', 'Raw');
      raw.title = 'Download the untrimmed recording';
      raw.addEventListener('click', function () { downloadRawTake(take.id); });
      var use = el('button', 'btn-small', isActive ? 'In use' : 'Use this');
      use.disabled = isActive;
      use.addEventListener('click', function () { setActiveTake(kind, take.id); });
      var del = el('button', 'btn-small danger', 'Delete');
      del.addEventListener('click', function () { deleteTake(kind, take.id); });
      [play, send, raw, use, del].forEach(function (b) { actions.appendChild(b); });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- key picker

  /* The key, one tap from the studio screen: tap the key in the top
   * bar, tap a key, done. (Voloco puts Key top-right on the effects
   * screen; ours is in the top bar, always visible.)
   */
  function openKeySheet() {
    renderKeySheet();
    $('key-sheet').style.display = 'flex';
  }

  function closeKeySheet() {
    $('key-sheet').style.display = 'none';
  }

  function renderKeySheet() {
    var parsed = parseKey(state.session.key);
    var tonicList = $('tonic-list');
    tonicList.innerHTML = '';
    TONICS.forEach(function (tonic) {
      var pill = el('button', 'key-pill' + (tonic === parsed.tonic ? ' current' : ''), tonic);
      pill.addEventListener('click', function () {
        setKey(tonic + ' ' + parsed.scale);
        renderKeySheet(); // stays open — he may want to change the scale too
      });
      tonicList.appendChild(pill);
    });
    var scaleList = $('scale-list');
    scaleList.innerHTML = '';
    SCALES.forEach(function (scale) {
      var label = scale.charAt(0).toUpperCase() + scale.slice(1);
      var pill = el('button', 'key-pill' + (scale === parsed.scale ? ' current' : ''), label);
      pill.addEventListener('click', function () {
        setKey(parsed.tonic + ' ' + scale);
        renderKeySheet();
      });
      scaleList.appendChild(pill);
    });
    renderBeatBlock();
  }

  /* Step 9A — the Beat block at the bottom of the key sheet: what
   * the beat detector heard, in plain words, with one-tap actions.
   * The detected key is offered even when the app is not sure —
   * tapping it is his choice, and it marks the key as hand-picked.
   */
  function renderBeatBlock() {
    var block = $('key-beat-block');
    block.innerHTML = '';
    var s = state.session;
    if (!state.beat && !s.beatKey && typeof s.bpm !== 'number') {
      block.appendChild(el('p', 'muted small',
        'Import a beat and the app will hear its key and tempo for you.'));
      return;
    }
    block.appendChild(el('p', 'key-section-label', 'This beat'));
    if (s.beatKey) {
      var sure = s.beatKeyConfidence >= 0.25;
      block.appendChild(el('p', '',
        'Sounds like ' + s.beatKey + (sure ? ' — pretty sure.'
          : ' — not sure, the beat\'s key is unclear, so check it by ear.')));
      var row = el('div', 'beat-actions');
      var use = el('button', 'btn-small', 'Use ' + s.beatKey);
      use.addEventListener('click', function () {
        setKey(s.beatKey);
        renderKeySheet();
      });
      row.appendChild(use);
      // The relative key shares the same notes (D minor <-> F
      // major) — the other way the beat could be heard.
      var rel = null;
      if (PS.keydetect) {
        var parsedBeat = parseKey(s.beatKey);
        rel = PS.keydetect.relativeKey(parsedBeat.tonic, parsedBeat.scale);
      }
      if (rel) {
        var swap = el('button', 'btn-small', 'Also sounds like ' + rel);
        swap.addEventListener('click', function () {
          setKey(rel);
          renderKeySheet();
        });
        row.appendChild(swap);
      }
      block.appendChild(row);
    }
    if (typeof s.bpm === 'number' && s.beatBpm) {
      block.appendChild(el('p', '', 'Tempo: ' + s.bpm + ' BPM' +
        (s.beatBpmAlt ? ' — or ' + s.beatBpmAlt + ' BPM, same pulse.' : '')));
      if (s.beatBpmAlt) {
        var alt = s.bpm === s.beatBpm ? s.beatBpmAlt : s.beatBpm;
        var trow = el('div', 'beat-actions');
        var toggle = el('button', 'btn-small', 'Use ' + alt + ' BPM instead');
        toggle.addEventListener('click', function () {
          s.bpm = alt;
          saveSessions();
          renderTracks();
          renderKeySheet();
        });
        trow.appendChild(toggle);
        block.appendChild(trow);
      }
    }
    if (typeof s.beatGridOffset === 'number') {
      block.appendChild(el('p', '', 'First hit lands ' +
        s.beatGridOffset.toFixed(3) + 's in.'));
      var grow = el('div', 'beat-actions');
      var minus = el('button', 'btn-small', '−10 ms');
      minus.addEventListener('click', function () { nudgeGrid(-0.01); });
      var plus = el('button', 'btn-small', '+10 ms');
      plus.addEventListener('click', function () { nudgeGrid(0.01); });
      grow.appendChild(minus);
      grow.appendChild(plus);
      block.appendChild(grow);
    }
  }

  /* Step 9A — nudge where the grid starts, 10 ms at a time. The
   * mixer in Phase 4 lines the vocals up to it; v12 only stores
   * the choice.
   */
  function nudgeGrid(delta) {
    var s = state.session;
    if (typeof s.beatGridOffset !== 'number') return;
    s.beatGridOffset = Math.max(0, Math.round((s.beatGridOffset + delta) * 1000) / 1000);
    saveSessions();
    renderKeySheet();
  }

  // ---------------------------------------------------------------- preset strip

  /* The preset picker + strength slider on the record screen: five
   * pills (Hard, Natural, Vocoder, Chorus, Clean) and a 0-100
   * slider. Tapping a pill switches the sound at once — even
   * mid-playback (broadcastTune retunes the live nodes) — and the
   * choice is saved with the song. Clean ignores strength (nothing
   * to correct), so the slider greys out on Clean.
   */
  function renderPresetStrip() {
    var pills = $('preset-pills');
    pills.innerHTML = '';
    PRESETS.forEach(function (preset) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'preset-pill' + (state.session.preset === preset.id ? ' current' : '');
      pill.textContent = preset.short;
      pill.setAttribute('aria-label', preset.label);
      pill.setAttribute('aria-pressed', state.session.preset === preset.id ? 'true' : 'false');
      pill.addEventListener('click', function () { setPreset(preset.id); });
      pills.appendChild(pill);
    });
    var slider = $('strength-slider');
    slider.value = String(state.session.strength);
    slider.disabled = state.session.preset === 'clean';
    $('strength-value').textContent = state.session.strength + '%';
    // Step 2A — speed: the slider shows the override, or sits at
    // the middle when Auto (the preset's own retune time) is in
    // charge. Clean ignores speed too (nothing to correct).
    var speedSlider = $('speed-slider');
    speedSlider.value = String(state.session.speed === null ? 50 : state.session.speed);
    speedSlider.disabled = state.session.preset === 'clean';
    $('speed-value').textContent = state.session.speed === null ? 'Auto' : state.session.speed + '%';
    $('speed-auto').classList.toggle('current', state.session.speed === null);
  }

  function setPreset(id) {
    if (PRESET_IDS.indexOf(id) === -1) return;
    if (state.session.preset === id) return;
    state.session.preset = id;
    saveSessions();
    broadcastTune();
    renderPresetStrip();
  }

  function setStrength(value) {
    var v = Math.max(0, Math.min(100, Math.round(value)));
    state.session.strength = v;
    $('strength-value').textContent = v + '%';
    broadcastTune();
  }

  /* Step 2A — speed: how fast the tune snaps to the note (100 =
   * instant, 0 = slow, about 50 ms). Null means Auto — the preset's
   * own retune time (Hard fast, Natural slower), which is exactly
   * how v11 sounded. Dragging the slider turns Auto off.
   */
  function setSpeed(value) {
    var v = Math.max(0, Math.min(100, Math.round(value)));
    state.session.speed = v;
    $('speed-value').textContent = v + '%';
    $('speed-auto').classList.remove('current');
    broadcastTune();
  }

  function setSpeedAuto() {
    if (state.session.speed === null) return;
    state.session.speed = null;
    saveSessions();
    broadcastTune();
    renderPresetStrip();
  }

  function renderAll() {
    renderSession();
    renderCalibration();
    renderTracks();
    renderPresetStrip();
    updateIdeasUI();
    $('wake-note').style.display = state.wakeLockSupported ? 'none' : '';
    updateTransport();
  }

  // ---------------------------------------------------------------- transport

  function updateTransport() {
    var rec = $('transport-record');
    var play = $('transport-play');
    var share = $('transport-share');
    var rewind = $('transport-rewind');
    var phones = $('transport-headphones');
    var busy = state.calibrating;
    var playing = !!state.playingStop;
    var take = activeTakeOf(state.selectedTrack);
    rec.disabled = busy || state.startingTake;
    rec.classList.toggle('recording', !!state.recording);
    rec.setAttribute('aria-label', state.recording ? 'Stop' : 'Record');
    play.disabled = busy || !!state.recording || (!playing && !take && !state.beat);
    play.innerHTML = playing ? STOP_SVG : PLAY_SVG;
    play.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    share.disabled = !take;
    rewind.disabled = !!state.recording;
    phones.classList.toggle('active', state.monitorOn);
    updateIdeasUI();
  }

  // ---------------------------------------------------------------- views

  function showSetup() {
    $('studio-view').style.display = 'none';
    $('setup-view').style.display = 'flex';
  }

  function showStudio() {
    $('setup-view').style.display = 'none';
    $('studio-view').style.display = 'flex';
    // The canvases were 0-size while hidden — redraw once laid out.
    requestAnimationFrame(function () {
      drawAllWaves();
      renderPlayhead();
    });
  }

  // ---------------------------------------------------------------- wiring

  function wire() {
    $('setup-open').addEventListener('click', showSetup);
    $('setup-song').addEventListener('click', showSetup);
    $('setup-back').addEventListener('click', showStudio);
    $('transport-record').addEventListener('click', function () {
      if (state.recording) stopTakeRequest();
      else startTakeRequest(state.selectedTrack);
    });
    $('transport-play').addEventListener('click', playSelected);
    $('transport-rewind').addEventListener('click', function () {
      if (state.playingStop) stopPlayback();
      setPlayhead(0);
    });
    $('transport-share').addEventListener('click', shareSelected);
    $('transport-headphones').addEventListener('click', toggleMonitor);
    // Strength slider: live while dragging (he hears it change),
    // saved when he lets go.
    $('strength-slider').addEventListener('input', function () {
      setStrength(Number(this.value));
    });
    $('strength-slider').addEventListener('change', function () {
      setStrength(Number(this.value));
      saveSessions();
    });
    // Speed slider: live while dragging (he hears it change),
    // saved when he lets go. Auto hands the speed back to the preset.
    $('speed-slider').addEventListener('input', function () {
      setSpeed(Number(this.value));
    });
    $('speed-slider').addEventListener('change', function () {
      setSpeed(Number(this.value));
      saveSessions();
    });
    $('speed-auto').addEventListener('click', setSpeedAuto);
    $('sheet-close').addEventListener('click', closeTakeSheet);
    $('take-sheet').addEventListener('click', function (event) {
      if (event.target === $('take-sheet')) closeTakeSheet();
    });
    $('topbar-key').addEventListener('click', openKeySheet);
    $('key-sheet-close').addEventListener('click', closeKeySheet);
    $('key-sheet').addEventListener('click', function (event) {
      if (event.target === $('key-sheet')) closeKeySheet();
    });
    var wrap = document.querySelector('.tracks-wrap');
    wrap.addEventListener('pointerdown', onTracksPointerDown);
    wrap.addEventListener('pointermove', onTracksPointerMove);
    // pointerup on the window: a drag released outside the lanes
    // still has to end the scrub.
    window.addEventListener('pointerup', onTracksPointerUp);
    window.addEventListener('pointercancel', onTracksPointerUp);

    $('song-name').addEventListener('change', function () {
      state.session.name = $('song-name').value.trim() || 'New Song';
      saveSessions();
      renderSession();
    });
    $('session-select').addEventListener('change', function () {
      switchSession($('session-select').value);
    });
    $('new-song').addEventListener('click', function () {
      var name = window.prompt('Name the new song:', 'New Song');
      if (name === null) return;
      var session = PS.store.makeSession(name.trim() || 'New Song');
      state.sessions.push(session);
      saveSessions();
      switchSession(session.id);
    });
    $('beat-file').addEventListener('change', function () {
      onBeatFilePicked($('beat-file').files[0]);
      $('beat-file').value = '';
    });
    $('mode-headphones').addEventListener('change', function () {
      PS.store.setOutputMode('headphones');
      renderCalibration();
      updateTransport();
      updateMonitor();
    });
    $('mode-speaker').addEventListener('change', function () {
      PS.store.setOutputMode('speaker');
      renderCalibration();
      updateTransport();
      updateMonitor();
    });
    $('cal-measure').addEventListener('click', startCalibration);
    $('error-dismiss').addEventListener('click', clearError);
    // Phase 0 wiring.
    $('lab-open').addEventListener('click', openLab);
    $('lab-back').addEventListener('click', closeLab);
    $('lab-run').addEventListener('click', startLabRun);
    $('ideas-btn').addEventListener('click', toggleIdeas);
    $('backup-btn').addEventListener('click', backupAllTakes);
    $('home-banner-dismiss').addEventListener('click', function () {
      PS.store.dismissBanner('home-screen');
      $('home-banner').style.display = 'none';
      maybeShowLabBanner(); // the lab prompt follows, one banner at a time
    });
    $('lab-banner-run').addEventListener('click', function () {
      PS.store.dismissBanner('lab-first-run');
      $('lab-banner').style.display = 'none';
      openLab();
    });
    $('lab-banner-dismiss').addEventListener('click', function () {
      PS.store.dismissBanner('lab-first-run');
      $('lab-banner').style.display = 'none';
    });
    $('recover-keep').addEventListener('click', function () { recoverOrphan(true); });
    $('recover-delete').addEventListener('click', function () { recoverOrphan(false); });
    $('cal-new-device-dismiss').addEventListener('click', function () {
      state.newDeviceDetected = false;
      renderCalibration();
    });

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        drawAllWaves();
        renderPlayhead();
      }, 150);
    });
  }

  function switchSession(id) {
    if (state.recording || state.calibrating) return;
    stopPlayback();
    var session = state.sessions.find(function (s) { return s.id === id; });
    if (!session) return;
    state.session = session;
    PS.store.setCurrentSessionId(id);
    setPlayhead(0);
    broadcastTune(); // the new song may be in a different key, preset, or strength — retune the monitor + playback
    loadBeatForSession().then(function () {
      renderAll();
    });
  }

  // ---------------------------------------------------------------- orphan recovery (Step 1B)

  /* IndexedDB is the durable record of takes; the take LIST lives
   * in localStorage, and browsers flush localStorage to disk
   * asynchronously — a forced close can lose the last list writes
   * while IndexedDB's transactions survive. After a kill, takes
   * would be on disk but invisible. So on every boot, rebuild any
   * missing list entries from the stored takes (their metadata
   * carries everything the list needs). A take is never lost to a
   * stale list again.
   */
  function reconcileTakesFromDb() {
    var jobs = state.sessions.map(function (session) {
      return PS.db.getTakesBySession(session.id).then(function (takes) {
        var changed = false;
        (takes || []).forEach(function (take) {
          var vocal = session.tracks[take.track];
          if (!vocal) return;
          var exists = vocal.takes.some(function (t) { return t.id === take.id; });
          if (exists) return;
          var m = take.metadata || {};
          vocal.takes.push({
            id: take.id,
            takeNumber: take.takeNumber,
            rawFileName: m.rawFileName || null,
            alignedFileName: m.alignedFileName || null,
            recordedAt: take.recordedAt,
            calibrated: !!m.calibrated,
            delayMilliseconds: m.delayMilliseconds || 0,
            durationSeconds: m.durationSeconds || 0,
            residualVerdict: m.residualVerdict || null,
            partial: !!m.interrupted,
            savedUpToSeconds: m.savedUpToSeconds || null,
            narrowbandWarn: !!m.narrowbandWarn,
            outputLatencyDrift: !!m.outputLatencyDrift,
            recovered: !!m.recovered,
            loggerRecovery: !!m.loggerRecovery,
            // Step 3 — the take's own sound, backfilled from the
            // stored record. Takes saved before v12 have none of
            // these: `undefined` means "fall back to the song's
            // sound", while null speed means Auto (the preset's own
            // retune time). JSON keeps null but drops undefined, so
            // the two stay distinct across a reload.
            preset: m.preset || null,
            strength: typeof m.strength === 'number' ? m.strength : null,
            speed: m.speed === undefined ? undefined : m.speed,
            key: m.key || null,
            analysis: m.analysis || null
          });
          changed = true;
        });
        if (changed) {
          Object.keys(session.tracks).forEach(function (kind) {
            var v = session.tracks[kind];
            v.takes.sort(function (a, b) { return a.takeNumber - b.takeNumber; });
            if (v.takes.length && !v.takes.some(function (t) { return t.id === v.activeTakeId; })) {
              v.activeTakeId = v.takes[v.takes.length - 1].id;
            }
          });
        }
        return changed;
      }).catch(function () { return false; });
    });
    return Promise.all(jobs).then(function (results) {
      if (results.indexOf(true) !== -1) {
        saveSessions();
        renderTracks();
        renderSheet();
        updateTransport();
      }
    });
  }

  /* On boot, chunks whose take was never saved are a take killed
   * mid-record (a call, a crash, a forced close). Offer them back
   * one at a time: keep rebuilds the take from its chunks (at most
   * the last partial second is lost), delete drops them.
   */
  function checkOrphanChunks() {
    PS.db.getAllTakeChunks().then(function (rows) {
      if (!rows || rows.length === 0) return;
      var byTake = {};
      rows.forEach(function (r) {
        (byTake[r.takeId] = byTake[r.takeId] || []).push(r);
      });
      var takeIds = Object.keys(byTake);
      var checks = takeIds.map(function (takeId) {
        return PS.db.getTake(takeId).then(function (take) {
          return take ? null : {
            takeId: takeId,
            sessionId: byTake[takeId][0].sessionId,
            track: byTake[takeId][0].track,
            rows: byTake[takeId]
          };
        }).catch(function () { return null; });
      });
      return Promise.all(checks);
    }).then(function (orphans) {
      if (!orphans) return;
      state.recoverQueue = orphans.filter(function (o) { return o !== null; });
      if (state.recoverQueue.length > 0) showRecoverBar();
    }).catch(function (err) {
      console.warn('Orphan chunk check failed:', err);
    });
  }

  function showRecoverBar() {
    var next = state.recoverQueue[0];
    if (!next) {
      $('recover-bar').style.display = 'none';
      return;
    }
    var sr = next.rows[0].sampleRate || 48000;
    var seconds = PS.safety.chunkedSeconds(next.rows.length, sr);
    $('recover-text').textContent = 'Recovered a take from before the app closed — ' +
      PS.safety.fmtSavedUpTo(seconds) + '.';
    $('recover-bar').style.display = 'flex';
  }

  function recoverOrphan(keep) {
    var next = state.recoverQueue.shift();
    if (!next) {
      $('recover-bar').style.display = 'none';
      return;
    }
    $('recover-bar').style.display = 'none';
    if (!keep) {
      PS.db.deleteTakeChunks(next.takeId).catch(function () { /* ignore */ });
      showRecoverBar();
      return;
    }
    var sr = next.rows[0].sampleRate || 48000;
    var samples = PS.safety.reassembleChunks(next.rows.map(function (r) {
      return { index: r.index, data: r.data };
    }));
    var session = state.sessions.find(function (s) { return s.id === next.sessionId; }) || state.session;
    var vocal = session.tracks[next.track];
    if (!vocal) {
      PS.db.deleteTakeChunks(next.takeId).catch(function () { /* ignore */ });
      showRecoverBar();
      return;
    }
    var takeNumber = vocal.takes.length + 1;
    var durationSeconds = samples.length / sr;
    var metadata = {
      trackKind: next.track,
      rawFileName: 'take-' + takeNumber + '-raw.wav',
      alignedFileName: 'take-' + takeNumber + '.wav',
      sampleRate: sr,
      durationSeconds: durationSeconds,
      leadInSamples: 0,
      delaySamples: 0,
      delayMilliseconds: 0,
      trimSamples: 0,
      preCompensationActive: false,
      preCompensationDelayMilliseconds: null,
      residualTrimSamples: 0,
      residualMilliseconds: null,
      residualOnsets: 0,
      residualVerdict: 'no-beat',
      calibrationDeviceUID: null,
      calibrationLabel: null,
      calibrationDeviceName: null,
      calibrationDate: null,
      calibrated: false,
      compensationSource: 'recovery',
      interrupted: true,
      recovered: true,
      chunkCount: next.rows.length,
      savedUpToSeconds: durationSeconds,
      micSettings: null,
      echoCancellationOff: null,
      narrowbandWarn: false,
      narrowbandFractionAbove7k5: null,
      takeBandwidthHz: null,
      takeRmsDb: PS.routelab.rmsDb(samples),
      outputLatencySeconds: null,
      outputLatencyAtStartSeconds: null,
      calibrationOutputLatencySeconds: null,
      outputLatencyDrift: false,
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.1'
    };
    var wav = new Blob([PS.wav.encodeWavFloat32(samples, sr)], { type: 'audio/wav' });
    PS.db.saveTake({
      id: next.takeId,
      sessionId: session.id,
      track: next.track,
      takeNumber: takeNumber,
      rawWav: wav,
      alignedWav: wav,
      metadata: metadata,
      recordedAt: metadata.recordedAt
    }).then(function () {
      vocal.takes.push({
        id: next.takeId,
        takeNumber: takeNumber,
        rawFileName: metadata.rawFileName,
        alignedFileName: metadata.alignedFileName,
        recordedAt: metadata.recordedAt,
        calibrated: false,
        delayMilliseconds: 0,
        durationSeconds: durationSeconds,
        residualVerdict: 'no-beat',
        partial: true,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: false,
        outputLatencyDrift: false,
        recovered: true
      });
      vocal.activeTakeId = next.takeId;
      saveSessions();
      PS.db.deleteTakeChunks(next.takeId).catch(function () { /* ignore */ });
      renderTracks();
      renderSheet();
      updateTransport();
      showRecoverBar();
    }).catch(function (err) {
      console.warn('Recovery save failed:', err);
      showError('The recovered take could not be saved.');
      showRecoverBar();
    });
  }

  /* First-run route-lab prompt: the app can test his headphones
   * and tell him which setup sounds best — before he sings. Shows
   * only when the home-screen banner is not up (one banner at a
   * time — two tall banners squeeze the track rows).
   */
  function maybeShowLabBanner() {
    if (Object.keys(state.labReports).length === 0 && !PS.store.bannerDismissed('lab-first-run')) {
      $('lab-banner').style.display = 'flex';
    }
  }

  // ---------------------------------------------------------------- init

  function init() {
    try {
      loadSessions();
      state.labReports = PS.store.loadLabReports();
    } catch (e) {
      // Storage unavailable (e.g. a private browsing tab): say so
      // plainly instead of showing a blank page.
      $('studio-view').innerHTML =
        '<div class="error-box" style="display:flex;position:static;margin:16px">This app needs ' +
        'storage on your phone to save your songs. If you opened it in ' +
        'a private browsing tab, open it in a normal Safari tab instead.</div>';
      return;
    }
    wire();
    renderAll();
    loadBeatForSession().then(function () { renderBeat(); });
    if (window.location.hash === '#setup') showSetup();
    // Service worker: works offline after the first load.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker failed:', err);
      });
    }
    // Phase 0 boot checks (Step 1B + 0C).
    checkStorage();
    // Home Screen gate: a regular Safari tab can have its takes
    // deleted after 7 days (ITP); an installed Home Screen app is
    // exempt. One non-intrusive banner, dismissible once. Only one
    // banner shows at a time — two tall banners squeeze the track
    // rows until the names clip. Home first; the lab prompt follows
    // once it is dismissed.
    if (!isStandalone() && !PS.store.bannerDismissed('home-screen')) {
      $('home-banner').style.display = 'flex';
    } else {
      maybeShowLabBanner();
    }
    // Wake Lock check: home-screen apps keep the screen awake only
    // from iOS 18.4 — warn below it (Step 1B).
    var ios = PS.safety.parseIOSVersion(navigator.userAgent || '');
    if (PS.safety.wakeLockWarnNeeded(ios, isStandalone())) {
      var note = $('ios-wake-note');
      if (note) {
        note.style.display = '';
        note.textContent = 'Your iPhone is on iOS ' + ios.major + '.' + ios.minor +
          ' — the screen may lock during long takes in the Home Screen app. Update to iOS 18.4 or later and it stays awake.';
      }
    }
    // A new pair of headphones mid-session (Step 0C).
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDevicesChanged);
    }
    // Takes killed mid-record, back from their chunks (Step 1B).
    // Rebuild the take list from IndexedDB first — a forced close
    // can lose localStorage's list while the takes survive on disk.
    reconcileTakesFromDb().then(function () { checkOrphanChunks(); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
