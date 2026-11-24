/* app.js — Phone Studio PWA: UI, take flow, calibration, export.
 *
 * The take flow ports AudioEngineManager.beginTake/finishTake:
 * record raw PCM over the beat (pre-compensated when a calibration
 * exists), trim lead-in (only) or lead-in + delay, run the residual
 * check, save raw + aligned WAVs + a metadata JSON sidecar.
 *
 * Plain words everywhere — Denasse is not a coder. No jargon in the
 * UI: "Measure my headphones", "Send", "Lined up".
 */
(function () {
  'use strict';

  var PS = window.PS;
  var $ = function (id) { return document.getElementById(id); };

  var SONG_KEYS = ['C major', 'G major', 'D major', 'A major', 'E major',
    'F major', 'Bb major', 'Eb major', 'A minor', 'E minor', 'B minor',
    'F# minor', 'D minor', 'G minor', 'C minor', 'F minor'];

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

  var state = {
    sessions: [],
    session: null,
    beat: null, // { buffer, mono, duration, sampleRate, fileName, originalName }
    calibrations: {},
    recording: null, // { track, handle, startWall, timer, interrupted }
    calibrating: false,
    pendingTakeTrack: null,
    playingStop: null,
    playingTakeId: null,
    micTesting: false,
    wakeLock: null,
    wakeLockSupported: ('wakeLock' in navigator)
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function showError(message) {
    var box = $('error-box');
    box.textContent = message;
    box.style.display = 'block';
    $('error-dismiss').style.display = '';
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function clearError() {
    var box = $('error-box');
    box.textContent = '';
    box.style.display = 'none';
    $('error-dismiss').style.display = 'none';
  }

  function fmtMs(seconds) {
    return Math.round(seconds * 1000) + ' ms';
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
      if (state.micTesting) finishMicTest(true);
    } else if (document.visibilityState === 'visible') {
      if (state.recording || state.calibrating) acquireWakeLock();
    }
  });

  // ---------------------------------------------------------------- sessions

  function loadSessions() {
    state.sessions = PS.store.loadSessions();
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
          originalName: state.session.beatOriginalName
        };
      });
    }).catch(function (err) {
      console.warn('Beat could not be loaded:', err);
      showError('The beat could not be loaded. Import it again.');
    });
  }

  function onBeatFilePicked(file) {
    if (!file) return;
    clearError();
    var status = $('beat-status');
    status.textContent = 'Loading the beat…';
    file.arrayBuffer().then(function (buf) {
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
          originalName: file.name
        };
        renderBeat();
      });
    }).catch(function (err) {
      console.warn('Beat import failed:', err);
      status.textContent = '';
      showError('That file could not be used as a beat. Try an MP3, M4A, or WAV file.');
    });
  }

  function removeBeat() {
    PS.db.deleteBeat(state.session.id).catch(function () { /* ignore */ });
    state.session.beatFileName = null;
    state.session.beatOriginalName = null;
    state.session.beatDuration = null;
    state.beat = null;
    saveSessions();
    renderBeat();
  }

  // ---------------------------------------------------------------- calibration

  function startCalibration() {
    var label = $('cal-label').value.trim();
    if (!label) {
      showError('Type a name for the headphones first — like "my AirPods".');
      $('cal-label').focus();
      return;
    }
    clearError();
    state.calibrating = true;
    renderCalibration();
    acquireWakeLock();
    $('cal-status').textContent = 'Getting the mic ready…';
    PS.audio.runCalibration(function (text) {
      $('cal-status').textContent = text;
    }).then(function (result) {
      state.calibrating = false;
      releaseWakeLock();
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
      // A take was waiting on this calibration — start it now.
      if (state.pendingTakeTrack) {
        var track = state.pendingTakeTrack;
        state.pendingTakeTrack = null;
        beginTake(track);
      }
    }).catch(function (err) {
      state.calibrating = false;
      releaseWakeLock();
      $('cal-status').textContent = '';
      renderCalibration();
      showError(err && err.message ? err.message : 'The measurement failed. Try again.');
    });
  }

  // ---------------------------------------------------------------- takes

  function startTakeRequest(track) {
    if (state.recording || state.calibrating || state.micTesting) return;
    clearError();
    // Calibration gate (native startTake): headphones mode with no
    // measured headphones → offer to measure first, or record anyway.
    // Recording is never blocked.
    if (PS.store.outputMode() === 'headphones' && !activeCalibration()) {
      state.pendingTakeTrack = track;
      $('cal-gate').style.display = 'block';
      $('cal-gate').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    beginTake(track);
  }

  function beginTake(track) {
    $('cal-gate').style.display = 'none';
    var active = activeCalibration();
    var mode = PS.store.outputMode();
    var delaySeconds = null;
    if (mode === 'headphones' && active) {
      delaySeconds = active.calibration.delaySeconds;
    }
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
      state.recording = {
        track: track,
        handle: handle,
        startWall: Date.now(),
        interrupted: false,
        timer: setInterval(updateRecordTimer, 100)
      };
      acquireWakeLock();
      renderTracks();
      $('record-hint').textContent = 'Recording — sing when the beat starts. Keep this page open.';
    }).catch(function (err) {
      showError(err && err.message ? err.message : 'The take could not start. Try again.');
      renderTracks();
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
    var timerEl = $('record-timer');
    if (timerEl) timerEl.textContent = '';

    var result = PS.audio.stopTake(rec.handle);
    var track = rec.track;
    var sr = PS.audio.sampleRate();
    if (!result.samples || result.samples.length === 0 || result.firstSampleTime === null) {
      showError('Nothing was recorded — the mic did not pick up any sound.');
      renderTracks();
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

    var vocal = state.session.tracks[track];
    var takeNumber = vocal.takes.length + 1;
    var baseName = 'take-' + takeNumber;
    var metadata = {
      trackKind: track,
      rawFileName: baseName + '-raw.wav',
      alignedFileName: baseName + '.wav',
      sampleRate: sr,
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
    }).catch(function (err) {
      console.warn('Take save failed:', err);
      showError('The take recorded but could not be saved — the phone may be out of space for this site.');
      renderTracks();
    });
  }

  // ---------------------------------------------------------------- playback

  function playTake(takeId) {
    if (state.playingStop) {
      var wasPlaying = state.playingTakeId;
      state.playingStop();
      state.playingStop = null;
      state.playingTakeId = null;
      renderTracks();
      if (wasPlaying === takeId) return;
    }
    clearError();
    PS.db.getTake(takeId).then(function (record) {
      if (!record || !record.alignedWav) {
        showError('That take could not be found.');
        return;
      }
      return record.alignedWav.arrayBuffer().then(function (buf) {
        return PS.audio.decodeAudio(buf);
      }).then(function (takeBuffer) {
        return PS.audio.playTake(takeBuffer, state.beat ? state.beat.buffer : null, function () {
          state.playingStop = null;
          state.playingTakeId = null;
          renderTracks();
        });
      }).then(function (stopFn) {
        state.playingStop = stopFn;
        state.playingTakeId = takeId;
        renderTracks();
      });
    }).catch(function (err) {
      console.warn('Playback failed:', err);
      showError('That take could not be played.');
    });
  }

  function stopPlayback() {
    if (state.playingStop) state.playingStop();
    state.playingStop = null;
    state.playingTakeId = null;
    renderTracks();
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
    saveSessions();
    PS.db.deleteTake(takeId).catch(function () { /* ignore */ });
    renderTracks();
  }

  function setActiveTake(track, takeId) {
    state.session.tracks[track].activeTakeId = takeId;
    saveSessions();
    renderTracks();
  }

  // ---------------------------------------------------------------- mic test

  /* Records 10 seconds with no beat, so Jim can check the frequency
   * content and prove which mic the phone used (phone mic = full
   * range; Bluetooth headset mic = nothing above ~4 kHz).
   */
  function startMicTest() {
    if (state.recording || state.calibrating || state.micTesting) return;
    clearError();
    state.micTesting = true;
    renderMicTest();
    $('mic-status').textContent = 'Recording… talk or sing for 10 seconds.';
    acquireWakeLock();
    PS.audio.startCapture(null).then(function () {
      return new Promise(function (resolve) { setTimeout(resolve, 10000); });
    }).then(function () {
      finishMicTest(false);
    }).catch(function (err) {
      state.micTesting = false;
      releaseWakeLock();
      renderMicTest();
      showError(err && err.message ? err.message : 'The mic test could not start.');
    });
  }

  function finishMicTest(interrupted) {
    if (!state.micTesting) return;
    state.micTesting = false;
    releaseWakeLock();
    var recorded = PS.audio.stopCapture();
    var sr = PS.audio.sampleRate();
    if (!recorded.samples || recorded.samples.length === 0) {
      $('mic-status').textContent = 'Nothing was recorded.';
      renderMicTest();
      return;
    }
    var wavBlob = new Blob([PS.wav.encodeWavFloat32(recorded.samples, sr)], { type: 'audio/wav' });
    PS.db.saveMisc('mic-test', {
      wav: wavBlob,
      sampleRate: sr,
      recordedAt: new Date().toISOString(),
      interrupted: !!interrupted
    }).then(function () {
      $('mic-status').textContent = interrupted
        ? 'Stopped early — the page went to the background. What was recorded is saved; send it anyway or try again.'
        : 'Done — 10 seconds saved. Send it to Jim so he can check which mic your phone used.';
      renderMicTest();
    }).catch(function () {
      $('mic-status').textContent = 'Recorded, but could not be saved.';
      renderMicTest();
    });
  }

  function shareMicTest() {
    PS.db.getMisc('mic-test').then(function (row) {
      if (!row || !row.wav) {
        showError('No mic test saved yet.');
        return;
      }
      var file = new File([row.wav], 'mic-test.wav', { type: 'audio/wav' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: 'Mic test' }).catch(function (err) {
          if (err && err.name !== 'AbortError') throw err;
        });
      }
      downloadBlob(row.wav, 'mic-test.wav');
    }).catch(function () {
      showError('Sharing failed. Try again.');
    });
  }

  // ---------------------------------------------------------------- rendering

  function renderSession() {
    $('song-name').value = state.session.name;
    var keySelect = $('song-key');
    keySelect.innerHTML = '';
    SONG_KEYS.forEach(function (key) {
      var opt = document.createElement('option');
      opt.value = key;
      opt.textContent = key;
      if (key === state.session.key) opt.selected = true;
      keySelect.appendChild(opt);
    });
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

  function renderBeat() {
    var status = $('beat-status');
    if (state.beat) {
      status.textContent = state.beat.originalName + ' — ' +
        Math.round(state.beat.duration) + ' seconds';
      $('beat-remove').style.display = '';
    } else {
      status.textContent = state.session.beatOriginalName
        ? state.session.beatOriginalName + ' — loading…'
        : 'No beat yet. Import one to record over it.';
      $('beat-remove').style.display = 'none';
    }
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
        : 'Pick your headphones above, or measure a new pair.';
    }
  }

  function renderTracks() {
    var container = $('tracks');
    container.innerHTML = '';
    PS.store.TRACKS.forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      var section = el('section', 'card track');
      var head = el('div', 'track-head');
      head.appendChild(el('h2', '', PS.store.TRACK_NAMES[kind]));
      var recBtn = el('button', 'btn-record', 'Record');
      if (state.recording) {
        if (state.recording.track === kind) {
          recBtn.textContent = 'Stop';
          recBtn.classList.add('recording');
          recBtn.addEventListener('click', stopTakeRequest);
        } else {
          recBtn.disabled = true;
        }
      } else {
        recBtn.addEventListener('click', function () { startTakeRequest(kind); });
      }
      head.appendChild(recBtn);
      section.appendChild(head);

      if (state.recording && state.recording.track === kind) {
        var live = el('div', 'live-row');
        live.appendChild(el('span', 'live-dot', '●'));
        live.appendChild(el('span', '', 'Recording — '));
        var timer = el('span', '');
        timer.id = 'record-timer';
        live.appendChild(timer);
        section.appendChild(live);
        var meter = el('div', 'meter');
        var bar = el('div', 'meter-bar');
        bar.id = 'level-bar';
        meter.appendChild(bar);
        section.appendChild(meter);
        section.appendChild(el('p', 'muted', 'Keep this page open and the screen on.'));
      }

      if (vocal.takes.length === 0) {
        section.appendChild(el('p', 'muted', 'No takes yet.'));
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
        section.appendChild(row);
      });
      container.appendChild(section);
    });
  }

  function renderMicTest() {
    $('mic-btn').disabled = state.micTesting;
    $('mic-btn').textContent = state.micTesting ? 'Recording…' : 'Check my mic (10 seconds)';
    PS.db.getMisc('mic-test').then(function (row) {
      $('mic-send').style.display = row && row.wav ? '' : 'none';
      if (row && row.wav && !$('mic-status').textContent) {
        $('mic-status').textContent = 'Last mic test: ' + fmtTime(row.recordedAt) + '.';
      }
    }).catch(function () { /* ignore */ });
  }

  function renderAll() {
    renderSession();
    renderBeat();
    renderCalibration();
    renderTracks();
    renderMicTest();
    $('wake-note').style.display = state.wakeLockSupported ? 'none' : '';
  }

  // ---------------------------------------------------------------- wiring

  function wire() {
    $('song-name').addEventListener('change', function () {
      state.session.name = $('song-name').value.trim() || 'New Song';
      saveSessions();
      renderSession();
    });
    $('song-key').addEventListener('change', function () {
      state.session.key = $('song-key').value;
      saveSessions();
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
    $('beat-pick').addEventListener('click', function () { $('beat-file').click(); });
    $('beat-file').addEventListener('change', function () {
      onBeatFilePicked($('beat-file').files[0]);
      $('beat-file').value = '';
    });
    $('beat-remove').addEventListener('click', removeBeat);
    $('mode-headphones').addEventListener('change', function () {
      PS.store.setOutputMode('headphones');
      renderCalibration();
    });
    $('mode-speaker').addEventListener('change', function () {
      PS.store.setOutputMode('speaker');
      renderCalibration();
    });
    $('cal-measure').addEventListener('click', startCalibration);
    $('cal-gate-measure').addEventListener('click', function () {
      $('cal-gate').style.display = 'none';
      document.getElementById('calibration-card').scrollIntoView({ behavior: 'smooth' });
      $('cal-label').focus();
    });
    $('cal-gate-anyway').addEventListener('click', function () {
      $('cal-gate').style.display = 'none';
      var track = state.pendingTakeTrack;
      state.pendingTakeTrack = null;
      if (track) beginTake(track);
    });
    $('cal-gate-cancel').addEventListener('click', function () {
      $('cal-gate').style.display = 'none';
      state.pendingTakeTrack = null;
    });
    $('mic-btn').addEventListener('click', startMicTest);
    $('mic-send').addEventListener('click', shareMicTest);
    $('error-dismiss').addEventListener('click', clearError);
  }

  function switchSession(id) {
    if (state.recording || state.calibrating || state.micTesting) return;
    stopPlayback();
    var session = state.sessions.find(function (s) { return s.id === id; });
    if (!session) return;
    state.session = session;
    PS.store.setCurrentSessionId(id);
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
      document.querySelector('main').innerHTML =
        '<div class="error-box" style="display:block">This app needs ' +
        'storage on your phone to save your songs. If you opened it in ' +
        'a private browsing tab, open it in a normal Safari tab instead.</div>';
      return;
    }
    wire();
    renderAll();
    loadBeatForSession().then(function () { renderBeat(); });
    // Service worker: works offline after the first load.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker failed:', err);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
