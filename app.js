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
    playbackTune: null // the AudioWorkletNode that tunes take playback
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
      // the web cannot. This is the honest handling.)
      if (state.recording) finishTake(true);
    } else if (document.visibilityState === 'visible') {
      if (state.recording || state.calibrating) acquireWakeLock();
      // The context may have been suspended while hidden — resume
      // it so the monitor (and everything else) comes back alive.
      PS.audio.ensureContext().catch(function () { /* ignore */ });
    }
  });

  // ---------------------------------------------------------------- sessions

  function loadSessions() {
    state.sessions = PS.store.loadSessions();
    // Songs saved before step 2 have no preset/strength — backfill
    // the defaults (Hard Tune, 100%) so the picker and the worklet
    // always have something real to use.
    state.sessions.forEach(function (s) {
      if (PRESET_IDS.indexOf(s.preset) === -1) s.preset = 'hard';
      if (typeof s.strength !== 'number' || s.strength < 0 || s.strength > 100) s.strength = 100;
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
    state.beat = null;
    saveSessions();
    setPlayhead(0);
    renderTracks();
    updateTransport(); // no beat and no take — Play goes back off
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
      if (!result.ok) {
        $('cal-status').textContent = result.error;
        renderCalibration();
        return;
      }
      var calibration = {
        label: label,
        delaySamples: result.medianSamples,
        delayMs: result.medianMs,
        delaySeconds: result.delaySeconds,
        sampleRate: PS.audio.sampleRate(),
        nominalLatencySeconds: PS.audio.nominalLatency(),
        date: new Date().toISOString()
      };
      PS.store.saveCalibration(label, calibration);
      PS.store.setActiveCalibrationLabel(label);
      state.calibrations = PS.store.loadCalibrations();
      $('cal-status').textContent = 'Done — ' + label + ': ' + Math.round(result.medianMs) +
        ' ms. Your voice will land in time.';
      renderCalibration();
    }).catch(function (err) {
      state.calibrating = false;
      releaseWakeLock();
      updateTransport();
      updateMonitor();
      $('cal-status').textContent = '';
      renderCalibration();
      showError(err && err.message ? err.message : 'The measurement failed. Try again.');
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
    beginTake(track);
  }

  function beginTake(track) {
    var active = activeCalibration();
    var mode = PS.store.outputMode();
    var delaySeconds = null;
    if (mode === 'headphones' && active) {
      delaySeconds = active.calibration.delaySeconds;
    }
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
        onBlock: function (batch) { setMeter(batch.peak); }
      });
    }).then(function (handle) {
      state.startingTake = false;
      state.recording = {
        track: track,
        handle: handle,
        anchorTime: handle.anchorTime,
        startWall: Date.now(),
        interrupted: false,
        timer: setInterval(updateRecordTimer, 100)
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
    if (!result.samples || result.samples.length === 0 || result.firstSampleTime === null) {
      showError('Nothing was recorded — the mic did not pick up any sound.');
      renderTracks();
      updateTransport();
      return;
    }

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
      // empty take.
      showError('Too short to save — tap record and sing a little longer.');
      renderTracks();
      updateTransport();
      return;
    }

    var vocal = state.session.tracks[track];
    var takeNumber = vocal.takes.length + 1;
    var baseName = 'take-' + takeNumber;
    var durationSeconds = alignedSamples.length / sr;
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
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.0'
    };

    var rawWav = new Blob([PS.wav.encodeWavFloat32(result.samples, sr)], { type: 'audio/wav' });
    var alignedWav = new Blob([PS.wav.encodeWavFloat32(alignedSamples, sr)], { type: 'audio/wav' });
    var takeId = PS.store.newId();
    var takeMeta = {
      id: takeId,
      takeNumber: takeNumber,
      rawFileName: metadata.rawFileName,
      alignedFileName: metadata.alignedFileName,
      recordedAt: metadata.recordedAt,
      calibrated: calibrated,
      delayMilliseconds: metadata.delayMilliseconds,
      durationSeconds: durationSeconds,
      residualVerdict: residual.verdict
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
      renderTracks();
      renderSheet();
      updateTransport();
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
        return playTakeTuned(playTakeBuffer, playBeatBuffer, function () {
          state.playingStop = null;
          state.playingTakeId = null;
          clearPlayheadTimer();
          renderTracks();
          renderSheet();
          updateTransport();
        }).then(function (stopFn) {
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
    node.port.postMessage({ type: 'live', on: !!isLive });
    node.port.postMessage({ type: 'enabled', on: true });
    return node;
  }

  function broadcastTune() {
    // The song key, preset, or strength changed — retune every live
    // tune node (monitor + playback) so what he hears changes at
    // once, even mid-playback.
    var messages = [
      { type: 'key', key: state.session.key },
      { type: 'preset', preset: state.session.preset },
      { type: 'strength', value: state.session.strength }
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
      }, 120);
    }).catch(function () {
      try { mon.source.disconnect(); } catch (e) { /* ignore */ }
      try { mon.gain.disconnect(); } catch (e) { /* ignore */ }
      try { mon.tune.disconnect(); } catch (e) { /* ignore */ }
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
  function playTakeTuned(takeBuffer, beatBuffer, onEnded) {
    return ensureTuneModule().then(function (ctx) {
      if (!state.playbackTune) {
        state.playbackTune = makeTuneNode(ctx, false); // full 7-voice chorus on playback
        state.playbackTune.connect(ctx.destination);
      }
      var tune = state.playbackTune;
      tune.port.postMessage({ type: 'reset' });
      tune.port.postMessage({ type: 'key', key: state.session.key });
      tune.port.postMessage({ type: 'preset', preset: state.session.preset });
      tune.port.postMessage({ type: 'strength', value: state.session.strength });
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

  /* The song key — set from the key picker (top bar). Retunes every
   * live tune node at once (monitor + playback).
   */
  function setKey(key) {
    var parsed = parseKey(key);
    var composed = parsed.tonic + ' ' + parsed.scale;
    state.session.key = composed;
    saveSessions();
    renderSession();
    broadcastTune();
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
      var sub = el('div', 'muted small', fmtTime(take.recordedAt) +
        (take.calibrated ? '' : ' — not measured, timing may be off') +
        (take.residualVerdict ? ' — ' + (VERDICT_TEXT[take.residualVerdict] || take.residualVerdict) : ''));
      info.appendChild(sub);
      row.appendChild(info);
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

  function renderAll() {
    renderSession();
    renderCalibration();
    renderTracks();
    renderPresetStrip();
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

  // ---------------------------------------------------------------- init

  function init() {
    try {
      loadSessions();
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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
