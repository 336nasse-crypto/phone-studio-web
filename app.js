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

  /* v13.2 (item 7) — the sound choices in plain words. The three
   * main buttons are the whole sound in one tap (preset + full
   * strength); the fun sounds are just the presets, keeping
   * whatever "How much" he already set. The phrases ARE the
   * buttons — no key names, no scale names, no "Strength" anywhere
   * on the record screen. The key sheet stays Jim-only.
   */
  var SOUND_MAIN = [
    { id: 'hard', text: 'Hard — you can hear the tune' },
    { id: 'natural', text: 'Natural — smooth, keeps your vibrato' },
    { id: 'clean', text: 'Clean — just my voice' }
  ];
  var SOUND_FUN = [
    { id: 'vocoder', text: 'Vocoder' },
    { id: 'chorus', text: 'Chorus' }
  ];

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
    beatLoadPromise: null, // v39 (QUEUE #123): the in-flight beat load (boot / song switch / import) — Play waits on it
    playWaiting: false, // v39 (QUEUE #123): a Play tap is waiting for the beat load to land
    beatImportSeq: 0, // v27 (QUEUE #87): generation counter — each beat import stamps its own number; a late landing from an older import drops instead of replacing the newer beat
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
    compTrack: null, // which track's best-of editor is open, or null
    compPicks: {}, // segment index -> take id (the picks in the best-of editor)
    scrubbing: false,
    // v29 (mockup 12): the timeline block that is selected (its
    // handles + menu show), and an in-progress block drag
    // { takeId, mode: 'move'|'trim-start'|'trim-end', ... }.
    selectedBlockId: null,
    blockDrag: null,
    swipeStart: null, // v29: the press point for the swipe-up gesture on the lanes
    // Live tune (Hard Tune): the headphones toggle = hear the tuned
    // voice live. ON by default (v38, QUEUE #122 — Denasse, live
    // v37: he recorded and could not hear himself at all). The
    // guard stays in monitorWanted(): headphones output only (never
    // the speaker — feedback) and never on a slow (Bluetooth-like)
    // route, where the tuned voice arrives late and hearing
    // yourself late throws a take off (Voloco's own rule). The
    // tuned take is heard on playback either way.
    monitorOn: true,
    monitor: null, // { source, gain, chain, tune } — the live monitor branch, or null
    tuneModuleReady: false,
    playbackTune: null, // the AudioWorkletNode that tunes take playback
    // Step 4A (v13.4) — the live chain.
    chainModuleReady: false,
    playbackChain: null, // the vocal chain take playback runs through (tune + chain worklet + EQ + echo)
    // Phase 0 — trust the recording.
    labReports: {}, // route-lab reports, keyed by label
    storagePersisted: null, // navigator.storage.persist() result (null = unknown)
    storageEstimate: null, // { quota, usage } from storage.estimate()
    storageLine: '', // plain-words storage status for Setup
    newDeviceDetected: false, // a never-seen audio input appeared (Step 0C)
    logger: null, // { ring, startWall, sampleRate } while the ideas logger is armed
    loggerArming: false,
    // v17 (QUEUE #10) — a take whose save failed, held in memory
    // for the retry button: { kind, record, onSaved } for a
    // single save, or { kind, resume } for a multi-save job (loop
    // passes) whose chain re-runs from the failed pass.
    // kind is 'take', 'logger' or 'loop-pass'. The record is the
    // exact saveTake record (blobs + metadata); onSaved is the
    // success path the save would have run. Cleared by a
    // successful retry, by dismissing the error, or by starting a
    // new take (the error box is gone by then, so the retry is
    // unreachable — the take is still recoverable from its chunks
    // on the next boot; logger takes have no chunks, so dismissing
    // a logger failure really does drop it, and its message says so
    // in plain words by NOT promising a boot recovery).
    pendingFailedTake: null,
    recoverQueue: [], // orphaned chunk groups found on boot, one at a time
    recovering: false,
    overdubCache: {}, // v13.8-light: takeId -> decoded overdub {buffer, sound, songOffsetSeconds} — a take's audio never changes after save, so re-decoding it on every record tap is pure waste
    voiceReference: null // v13.2 (item 8): Denasse's measured voice, when voice-reference.json exists — v16 WIRED it: new songs open on Natural / E minor from his voice (QUEUE #3); the reference itself is still held here for later use
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* v29 (mockup 12): the lane list for the current song — the
   * three built-in vocal tracks plus any lanes the + Add layer
   * button added. Old sessions (no extraTracks) read as the three.
   * Every PS.store.TRACKS loop in the app goes through these so a
   * lane added by + behaves like a built-in one (record, play,
   * overdub, find, timeline, render).
   */
  function trackKinds() {
    return PS.store.trackKinds(state.session);
  }

  function trackName(kind) {
    return PS.store.trackName(state.session, kind);
  }

  function trackColor(kind) {
    return PS.store.trackColor(state.session, kind);
  }

  // v29: a take's audible window on the timeline. Trimming is
  // non-destructive — the recorded audio never changes; the block
  // just plays [trimStart, trimEnd] of it. trimStart defaults 0,
  // trimEnd defaults null (the take's full length).
  function takeTrimStart(take) {
    return Math.max(0, take.trimStartSeconds || 0);
  }

  function takeTrimEnd(take) {
    var full = take.durationSeconds || 0;
    var end = (take.trimEndSeconds === null || take.trimEndSeconds === undefined) ? full : take.trimEndSeconds;
    return Math.max(takeTrimStart(take), Math.min(full, end));
  }

  function takeAudibleDuration(take) {
    return Math.max(0, takeTrimEnd(take) - takeTrimStart(take));
  }

  function hexToRgba(hex, alpha) {
    var h = String(hex || '#8b5cf6').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16) || 0;
    var g = parseInt(h.slice(2, 4), 16) || 0;
    var b = parseInt(h.slice(4, 6), 16) || 0;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function showError(message) {
    $('error-text').textContent = message;
    // Hide the retry button AND reset it: a later showError (the
    // narrowband warning after a successful retry, say) must never
    // leave it stuck on "Saving…" + disabled behind the box.
    var retryBtn = $('error-retry');
    retryBtn.style.display = 'none';
    retryBtn.textContent = 'Try saving again';
    retryBtn.disabled = false;
    $('error-box').style.display = 'flex';
  }

  function clearError() {
    $('error-text').textContent = '';
    var retryBtn = $('error-retry');
    retryBtn.style.display = 'none';
    retryBtn.textContent = 'Try saving again';
    retryBtn.disabled = false;
    $('error-box').style.display = 'none';
  }

  /* v17 (QUEUE #10) — a failed take save is not the end of the
   * take. The blobs + metadata stay in state.pendingFailedTake and
   * the error box grows a "Try saving again" button that re-runs
   * the exact same saveTake. The message always names the other
   * way back: for a recorded take, close the app and reopen it —
   * the take is kept as a chunk recovery (checkOrphanChunks).
   * "Got it" dismisses AND drops the held copy (dismissError) —
   * the retry is unreachable once the box is gone, so holding the
   * blobs would only leak ~37 MB.
   */
  function showSaveFailedError(message, pending) {
    state.pendingFailedTake = pending;
    $('error-text').textContent = message;
    var btn = $('error-retry');
    btn.textContent = 'Try saving again';
    btn.disabled = false;
    btn.style.display = '';
    $('error-box').style.display = 'flex';
  }

  function dismissError() {
    state.pendingFailedTake = null;
    clearError();
  }

  function retryFailedTakeSave() {
    var pending = state.pendingFailedTake;
    if (!pending) return;
    var btn = $('error-retry');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (pending.resume) {
      // A multi-save job (loop passes): re-run the chain from the
      // failed pass. Its own catch re-holds + re-shows on failure.
      state.pendingFailedTake = null;
      clearError();
      pending.resume();
      return;
    }
    PS.db.saveTake(pending.record).then(function () {
      state.pendingFailedTake = null;
      clearError();
      pending.onSaved();
    }).catch(function (err) {
      console.warn('Take save retry failed:', err);
      if (btn) { btn.disabled = false; btn.textContent = 'Try saving again'; }
      // The box is still showing with the same message — the
      // recovery it names (close + reopen, chunk recovery for a
      // recorded take) is still true.
    });
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

  // v35 (QUEUE #32): the mic can die mid-take (Bluetooth
  // disconnect, another app grabbing the mic, an iOS route
  // change) and the worklet keeps emitting silence with nothing
  // noticing. audio.js fires this when the track ends. A take in
  // progress finishes flagged interrupted (same shape as the
  // visibilitychange path above — saved up to the disconnect,
  // never a silent tail passed off as clean). An armed logger
  // saves its ring buffer the same way. No auto-restart: a new
  // track mid-take would splice two inputs. Registered once here
  // (audio.js loads before app.js) and never per-take, so a
  // re-opened mic keeps the same handler.
  if (PS.audio && PS.audio.onMicEnded) {
    PS.audio.onMicEnded(function () {
      if (state.recording) {
        finishTake(true, 'mic-disconnected');
      } else if (state.logger) {
        state.logger.micEnded = true;
        saveLoggerTake();
      }
    });
  }

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
    // the defaults so the picker and the worklet always have
    // something real to use.
    state.sessions.forEach(function (s) {
      if (PRESET_IDS.indexOf(s.preset) === -1) {
        // v16 (QUEUE #3): a song with no (or an invalid) preset
        // never had a real sound picked — it gets his voice
        // defaults, the same as a new song: Natural / E minor,
        // key settled from his voice. A song WITH a valid preset
        // keeps its pick (his current song: Clean/40 + E minor).
        s.preset = 'natural';
        s.key = 'E minor';
        s.keyManuallySet = true;
        s.keySource = 'voice';
      }
      if (typeof s.strength !== 'number' || s.strength < 0 || s.strength > 100) s.strength = 100;
      // v13 — Speed is gone from the app (Denasse: the knob is
      // useless; a singer should not have to think about it). Every
      // song's speed is Auto forever — null means the preset's own
      // retune time, which is exactly how v11 sounded. Any speed a
      // song saved in v12 is thrown away on load.
      s.speed = null;
      if (typeof s.keyManuallySet !== 'boolean') {
        // Songs saved before Step 9A have no flag — a key other
        // than the default D minor means he picked it himself.
        // v16: the baseline stays D minor on purpose. D minor WAS
        // the default when these songs were created, so inferring
        // vs the new default (E minor) would mark a hand-picked
        // E-minor song as unsettled and re-open the exact hole #3
        // closes (a beat import flipping his song's key). The
        // backfill above is the only place a key is re-settled.
        s.keyManuallySet = s.key !== 'D minor';
      }
      if (typeof s.beatKeyConfidence !== 'number') s.beatKeyConfidence = 0;
      // v13.8-light: beats imported before the fingerprint existed
      // have no hash — it is computed on the next beat load, and
      // takes saved before then carry beatSha256: null.
      if (typeof s.beatSha256 !== 'string') s.beatSha256 = null;
      if (typeof s.keySource !== 'string') s.keySource = null;
      // Step 4A (v13.4): the live chain's One Knob macros +
      // toggles. Old songs get the defaults (all 50, chain on,
      // room-noise cut off); old takes fall back to the song's
      // macros when they play (see takeSound).
      if (!s.macros || typeof s.macros !== 'object') s.macros = { even: 50, bright: 50, space: 50, punch: 50, warm: 50 };
      s.macros = clampMacros(s.macros);
      if (typeof s.chainOn !== 'boolean') s.chainOn = true;
      // v23 (QUEUE #58, Denasse's order 09:19): live sound is the
      // FULL chain by default — what he hears while singing is the
      // studio sound, not the tune-only light version. Old songs
      // missing the flag get the full default; a song WITH a stored
      // flag keeps its pick (the #3 precedent — his current song
      // stays light until he flips the Setup switch). The switch
      // lives in Setup ("Light live sound").
      if (typeof s.lightLive !== 'boolean') s.lightLive = false;
      // Step 4B (v13.5): per-stage bypasses + fine tone. Old
      // songs get the defaults; a song saved by v13.4 keeps its
      // room-noise cut — it becomes the nr bypass (cut on means
      // bypass off). nrOn is gone after this: the bypass set is
      // the one source of truth for the noise cut now.
      if (!s.bypass || typeof s.bypass !== 'object') {
        s.bypass = {};
        if (typeof s.nrOn === 'boolean') s.bypass.nr = !s.nrOn;
      }
      s.bypass = clampBypass(s.bypass);
      if (typeof s.nrOn !== 'undefined') delete s.nrOn;
      if (!s.tone || typeof s.tone !== 'object') s.tone = {};
      s.tone = clampTone(s.tone);
      // Step 6C (v13.3): the loop region is null on old sessions.
      if (typeof s.loop === 'undefined') s.loop = null;
      // v29: normalize the extraTracks list too — old sessions
      // have none, and a lane added by + needs its track entry.
      if (!Array.isArray(s.extraTracks)) s.extraTracks = [];
      PS.store.trackKinds(s).forEach(function (kind) {
        if (!s.tracks[kind]) s.tracks[kind] = { takes: [], activeTakeId: null, starredTakeId: null };
        if (typeof s.tracks[kind].starredTakeId === 'undefined') s.tracks[kind].starredTakeId = null;
        (s.tracks[kind].takes || []).forEach(function (t) {
          // A take lives at its place in the song. Normal takes
          // start at 0; a loop pass or a best-of take starts at
          // the part it covers. Old takes (saved before the field
          // existed) are plain takes at 0.
          if (typeof t.songOffsetSeconds !== 'number') t.songOffsetSeconds = 0;
          if (typeof t.comp === 'undefined') t.comp = false;
          if (typeof t.loopPass === 'undefined') t.loopPass = false;
        });
      });
    });
    // v16 (QUEUE #3): the backfill above rewrites what the app
    // shows — persist it, so the stored record matches the screen.
    // A backfill that lives only in memory leaves the ledger lying
    // (the QUEUE #7 class: localStorage still says 'bogus' / D
    // minor while the app shows Natural / E minor). Best-effort:
    // a full store must never block boot — the next save persists it.
    try { saveSessions(); } catch (e) { /* the next save persists it */ }
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
    // v26 (QUEUE #97): the session's beat reference lives in
    // localStorage, whose flush can lag a kill by seconds — a beat
    // imported moments before the app died came back beatless
    // while its blob sat orphaned in IDB (proven: pre-kill
    // snapshot beatFileName 'beat.wav', post-relaunch null, in
    // cdp-v149 runs 3/5/6 — the IDB chunks seeded in the same leg
    // survived the same kill). The blob is the source of truth, so
    // the beat is re-attached before the load below; a removed beat
    // can never come back this way (removeBeat deletes the row).
    // v39 (QUEUE #123): the boot / song-switch load is the load Play
    // waits on — store it the moment it starts (before the reattach,
    // so a Play tap in that window can wait on it), and give it the
    // same 30 s timeout the fresh-import path has. A decode that
    // hangs on iOS used to leave Play dead for the whole session
    // with no message — now the timeout surfaces it in plain words,
    // and the inner chain keeps running, so a late landing still
    // sets state.beat and clears the error below. The stored
    // promise always resolves (the timeout is caught here), so the
    // boot / song-switch .then(renderBeat / renderAll) still runs
    // on a failure.
    var load = reattachOrphanBeat().then(function () {
    if (!state.session.beatFileName) return Promise.resolve();
    // v25 (QUEUE #85): the boot / song-switch load is a load too —
    // the row must show "loading…" and the record button must stay
    // greyed out until the beat is actually playable. Only the
    // fresh-import path set this flag before; a fast tap in the
    // boot window sang with no beat while the take stamped the
    // beat anyway. The trailing .then clears the flag on every
    // exit (loaded, missing blob, decode failure) so it can never
    // stick and grey the button out forever.
    state.beatLoading = true;
    renderTracks();
    updateTransport();
    return PS.db.getBeat(state.session.id).then(function (row) {
      if (!row || !row.blob) return;
      return row.blob.arrayBuffer().then(function (buf) {
        // v13.8-light: fingerprint the beat BEFORE decoding (the
        // decode can detach the buffer) — a beat imported before
        // fingerprints existed gets its hash on this load.
        return hashBeatBytes(buf).then(function (sha) { return { buf: buf, sha: sha }; });
      }).then(function (hashed) {
        return PS.audio.decodeBeat(hashed.buf).then(function (decoded) { return { decoded: decoded, sha: hashed.sha }; });
      }).then(function (pair) {
        var decoded = pair.decoded;
        if (pair.sha && state.session.beatSha256 !== pair.sha) {
          state.session.beatSha256 = pair.sha;
          saveSessions();
        }
        state.beat = {
          buffer: decoded.buffer,
          mono: decoded.mono,
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          fileName: state.session.beatFileName,
          originalName: state.session.beatOriginalName,
          peaks: null
        };
        // v39 (QUEUE #123): a late landing after the 30 s timeout
        // fired clears the timeout error — but only the beat-load
        // messages, never an unrelated error (e.g. a failed-save
        // retry) that happens to be showing.
        var shown = $('error-text').textContent || '';
        if (shown === 'The beat took too long to load. Try tapping the Beat row again.' ||
            shown === 'The beat could not be loaded. Import it again.') clearError();
        // A beat saved before Step 9A has no detection stored —
        // listen to it once now (the same pass as a fresh import).
        if (!state.session.beatKey && !state.session.beatBpm) {
          setTimeout(function () { detectBeatKeyTempo(); }, 0);
        }
      });
    }).catch(function (err) {
      console.warn('Beat could not be loaded:', err);
      showError('The beat could not be loaded. Import it again.');
    }).then(function () {
      // v25 (QUEUE #85): the load is over, whatever happened —
      // the button comes back (beatless takes record fine).
      state.beatLoading = false;
      renderTracks();
      updateTransport();
    });
    }); // v26 (QUEUE #97): closes the reattachOrphanBeat wrapper
    state.beatLoadPromise = withTimeout(load, 30000, 'The beat took too long to load. Try tapping the Beat row again.').catch(function (err) {
      console.warn('Beat load timed out:', err);
      showError(err && err.message ? err.message : 'The beat took too long to load. Try tapping the Beat row again.');
    });
    return state.beatLoadPromise;
  }

  /* v26 (QUEUE #97): re-attach an orphaned beat row. The beat
   * import writes the blob to IDB first and the session reference
   * to localStorage second; a kill between the two (the flush can
   * lag seconds) leaves the blob with no song pointing at it. When
   * the session names no beat but IDB holds one for this song, the
   * reference is restored from the row (sha null — recomputed on
   * the load, never guessed). Idempotent: every boot recovers it.
   * A removed beat has no row (removeBeat deletes it), so this can
   * never resurrect one.
   */
  function reattachOrphanBeat() {
    if (state.session.beatFileName) return Promise.resolve();
    return PS.db.getBeat(state.session.id).then(function (row) {
      if (row && row.blob) {
        state.session.beatFileName = row.fileName;
        state.session.beatOriginalName = row.originalName;
        state.session.beatDuration = row.duration;
        state.session.beatSha256 = null;
        saveSessions();
      }
    }).catch(function () { /* no beat to re-attach */ });
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
    // v27 (QUEUE #87): stamp this import's generation — the chain
    // captures it, and every landing checks it still matches.
    var seq = ++state.beatImportSeq;
    renderTracks(); // the beat row shows "Loading…" while it decodes
    // v27 (QUEUE #87): the record-button guard (rec.disabled includes
    // beatLoading, app.js:6189) only takes effect when updateTransport
    // runs — nothing called it while an import was loading, so the
    // button stayed enabled in practice. One call closes it.
    updateTransport();
    var importJob = file.arrayBuffer().then(function (buf) {
      // v13.8-light: fingerprint the beat BEFORE decoding (the
      // decode can detach the buffer), then carry the hash into
      // the session next to the file name.
      return hashBeatBytes(buf).then(function (sha) { return { buf: buf, sha: sha }; });
    }).then(function (hashed) {
      return PS.audio.decodeBeat(hashed.buf).then(function (decoded) { return { decoded: decoded, sha: hashed.sha }; });
    }).then(function (pair) {
      // v27 (QUEUE #87): a newer import started since this one — drop
      // the stale landing BEFORE the saveBeat put, so neither the
      // stored blob nor the session fields move under the newer beat.
      if (seq !== state.beatImportSeq) return;
      var decoded = pair.decoded;
      return PS.db.saveBeat({
        sessionId: state.session.id,
        fileName: 'beat.' + (file.name.split('.').pop() || 'audio').toLowerCase(),
        originalName: file.name,
        duration: decoded.duration,
        blob: file,
        addedAt: new Date().toISOString()
      }).then(function () {
        state.session.beatFileName = 'beat.' + (file.name.split('.').pop() || 'audio').toLowerCase();
        state.session.beatSha256 = pair.sha; // null when the browser could not hash — never a guess
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
    // v39 (QUEUE #123): the import is a beat load too — store it so
    // a Play tap during an import waits on the same promise. The
    // chained .then/.catch below settle it resolved in both paths,
    // so awaiting it never throws.
    state.beatLoadPromise = withTimeout(importJob, 30000, 'The beat took too long to load. Try tapping the Beat row again.').then(function () {
      // v27 (QUEUE #87): a newer import owns the loading state now — a
      // stale chain must not clear it (or re-enable Play) mid-import.
      if (seq !== state.beatImportSeq) return;
      state.beatLoading = false;
      renderTracks();
      updateTransport(); // the beat arriving enables Play
    }).catch(function (err) {
      // v27 (QUEUE #87): same guard — a stale timeout must not show
      // its error or clear the loading state under the newer import.
      if (seq !== state.beatImportSeq) return;
      state.beatLoading = false;
      console.warn('Beat import failed:', err);
      showError(err && err.message && err.message.indexOf('too long') !== -1 ? err.message : 'That file could not be used as a beat. Try an MP3, M4A, or WAV file.');
      renderTracks();
      updateTransport();
    });
  }

  function removeBeat() {
    // v22 (QUEUE #45): the beat cannot change under a live take —
    // the × button is disabled while recording too; this is the
    // belt-and-braces guard (removeBeat's only caller is that button).
    if (state.recording) return;
    if (!window.confirm('Remove the beat from this song? Your takes stay.')) return;
    PS.db.deleteBeat(state.session.id).catch(function () { /* ignore */ });
    state.session.beatFileName = null;
    state.session.beatSha256 = null; // v13.8-light: the fingerprint goes with the beat
    state.session.beatOriginalName = null;
    state.session.beatDuration = null;
    // The tempo came from that beat — it goes with it. The key
    // goes back to the voice default instead of staying on the
    // dead beat's key (v26, QUEUE #61 — see below).
    state.session.beatKey = null;
    state.session.beatKeyConfidence = 0;
    state.session.beatBpm = null;
    state.session.beatBpmAlt = null;
    state.session.beatGridOffset = null;
    // v26 (QUEUE #61): the beat's key went with the beat only in
    // the comment — the session key itself stayed, so the next
    // beatless take rendered tuned to a dead beat's key. Restore
    // the voice default instead (the #3 settlement: the key his
    // voice actually sings in when no beat supplies one) and let
    // the monitor follow. Do NOT just null the key: a null key
    // would leave the take keyless and the render would fall back
    // to its own default. The restore settles the song, so a later
    // beat import will not move it again. Only when the beat owned
    // the key — a manual or voice key is untouched.
    if (state.session.keySource === 'beat') {
      state.session.key = 'E minor';
      state.session.keyManuallySet = true;
      state.session.keySource = 'voice';
      renderSession();
      broadcastTune();
    }
    state.beat = null;
    // The loop is a slice of the beat — it goes with it.
    state.session.loop = null;
    saveSessions();
    setPlayhead(0);
    renderTracks();
    updateTransport(); // no beat and no take — Play goes back off
  }

  // ---------------------------------------------------------- Step 6C: loop
  // A loop is a part of the song to work on — drag it across the
  // top bar, tap Loop, and every pass through it becomes its own
  // take (GarageBand's pattern: nothing to set up, nothing lost).
  // The loop lives in the session, so it is still there when the
  // app reopens.

  // Sets the region (song seconds) and turns the loop on. A loop
  // needs a beat — the region is a slice of the beat, so without
  // one there is nothing to loop over. Returns true when set.
  function setLoop(start, end) {
    if (!state.beat) return false;
    start = Math.max(0, start);
    end = Math.min(state.beat.duration, end);
    if (end - start < 0.5) return false;
    state.session.loop = { start: start, end: end, on: true };
    saveSessions();
    renderLoop();
    return true;
  }

  function clearLoop() {
    state.session.loop = null;
    saveSessions();
    renderLoop();
  }

  function loopOn() {
    var loop = state.session.loop;
    return !!(loop && loop.on && state.beat);
  }

  function toggleLoop() {
    var loop = state.session.loop;
    if (!loop) {
      // No region yet — point at the top bar instead of an error.
      $('loop-label').textContent = 'Drag to pick a part';
      return;
    }
    loop.on = !loop.on;
    saveSessions();
    renderLoop();
  }

  // Draws the loop: the button's state, the times on the ruler,
  // and the band over the lanes. The band is positioned after
  // layout (same frame the playhead is drawn in), because the
  // lanes only have real coordinates once the rows exist.
  function renderLoop() {
    var loop = state.session.loop;
    var btn = $('loop-toggle');
    var label = $('loop-label');
    var band = $('loop-band');
    var on = loopOn();
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? 'Loop on' : 'Loop';
    btn.classList.toggle('on', on);
    if (!loop) {
      label.textContent = '';
      label.classList.remove('on');
      band.style.display = 'none';
      return;
    }
    label.textContent = fmtClock(loop.start) + ' – ' + fmtClock(loop.end);
    label.classList.toggle('on', on);
    requestAnimationFrame(function () {
      positionLoopBand(loop.start, loop.end);
    });
  }

  function positionLoopBand(start, end) {
    var rect = laneRect();
    var band = $('loop-band');
    if (!rect || rect.width <= 0) {
      band.style.display = 'none';
      return;
    }
    band.style.display = 'block';
    band.style.left = (rect.left + (start / state.timelineSeconds) * rect.width) + 'px';
    band.style.width = Math.max(2, ((end - start) / state.timelineSeconds) * rect.width) + 'px';
  }

  // The ruler sits above the lanes, so a pointer on it is
  // translated into lane coordinates through the wrap.
  function loopSecondsFromEvent(e) {
    var wrap = document.querySelector('.tracks-wrap');
    var rect = laneRect();
    if (!wrap || !rect || rect.width <= 0) return null;
    var wrapRect = wrap.getBoundingClientRect();
    var x = e.clientX - wrapRect.left - rect.left;
    var frac = Math.max(0, Math.min(1, x / rect.width));
    return frac * state.timelineSeconds;
  }

  var loopDrag = null; // { start, end } while a loop region is being dragged on the ruler

  function onRulerPointerDown(e) {
    if (e.target === $('loop-toggle')) return; // the button is a tap, not a drag
    if (!state.beat) {
      $('loop-label').textContent = 'Import a beat first';
      return;
    }
    var seconds = loopSecondsFromEvent(e);
    if (seconds === null) return;
    loopDrag = { start: seconds, end: seconds };
    e.preventDefault();
  }

  function onRulerPointerMove(e) {
    if (!loopDrag) return;
    var seconds = loopSecondsFromEvent(e);
    if (seconds === null) return;
    loopDrag.end = seconds;
    var start = Math.min(loopDrag.start, loopDrag.end);
    var end = Math.max(loopDrag.start, loopDrag.end);
    $('loop-label').textContent = fmtClock(start) + ' – ' + fmtClock(end);
    positionLoopBand(start, end);
  }

  function onRulerPointerUp(e) {
    if (!loopDrag) return;
    var start = Math.min(loopDrag.start, loopDrag.end);
    var end = Math.max(loopDrag.start, loopDrag.end);
    loopDrag = null;
    if (!setLoop(start, end)) renderLoop();
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
    if (!state.beat || !state.beat.mono) return;
    // v13.8-light: the detectors load after first paint — if a beat
    // lands before they do, load them now and run the analysis once.
    if (!PS.keydetect || !PS.tempodetect) {
      loadHeavyModules().then(function () { detectBeatKeyTempo(); });
      return;
    }
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

  /* v32 (QUEUE #110) — Setup's "Measure my headphones" is gone, so
   * startCalibration + defaultCalLabel are gone with it. The
   * measurement lives in the lab now: startLabRun's 8-click phase
   * measures the same round-trip latency (runClickTest under the
   * hood in both cases) and saveLabCalibration stores it as the
   * active calibration — see the route-lab section below. The
   * stored calibration shape is unchanged (label, delaySamples,
   * delayMs, delaySeconds, sampleRate, nominal/output latency,
   * mic sample rate + device id, audio session log, date), so the
   * beat offset + the slow-route check read it exactly as before.
   */

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
  PS.openLab = openLab; // v33: exposed for the CDP tests (the Setup #lab-open button is gone; the lab view itself stays, opened programmatically)

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
      // v36 (QUEUE #34): stopCapture drains the worklet's final
      // partial batch — async now; the lab's room tone / "sss"
      // keeps its tail too.
      return PS.audio.stopCapture();
    }).then(function (recorded) {
      return recorded.samples || new Float32Array(0);
    });
  }

  /* v32 (QUEUE #110) — the lab test IS the headphone measurement
   * now. The lab's 8-click phase measures the same round-trip
   * latency the old 5-click calibration did — runClickTest under
   * the hood in both cases — so the run saves it as the active
   * calibration: the beat offset + the slow-route check read it,
   * and the next take lands in time. Returns the saved
   * calibration, or null when the clicks were not heard (nothing
   * to save). Exposed as PS.saveLabCalibration for the CDP tests.
   * The stored shape is the old calibration's shape (label,
   * delaySamples, delayMs, delaySeconds, sampleRate, nominal /
   * output latency, mic sample rate + device id, audio session
   * log, date), so nothing downstream changes. delaySamples is
   * informational — beginTake recomputes it from delaySeconds at
   * record time — so a missing AudioContext here (sampleRate 0)
   * falls back to 48000 rather than blocking the save.
   */
  function saveLabCalibration(label, report, contextInfo) {
    var medianMs = report && report.clapMedianMs;
    if (typeof medianMs !== 'number' || !(medianMs > 0)) return null;
    var sr = PS.audio.sampleRate() || 48000;
    var settings = PS.audio.micSettings ? PS.audio.micSettings() : null;
    var calibration = {
      label: label,
      delaySamples: Math.round(medianMs / 1000 * sr),
      delayMs: medianMs,
      delaySeconds: medianMs / 1000,
      sampleRate: sr,
      nominalLatencySeconds: contextInfo && typeof contextInfo.baseLatency === 'number' ? contextInfo.baseLatency : null,
      outputLatencySeconds: contextInfo && typeof contextInfo.outputLatency === 'number' ? contextInfo.outputLatency : (PS.audio.outputLatency ? PS.audio.outputLatency() : null),
      micSampleRate: (report && typeof report.inputSampleRate === 'number') ? report.inputSampleRate : null,
      micDeviceId: (settings && settings.deviceId) ? settings.deviceId : null,
      audioSessionLog: (PS.audio.audioSessionLog ? PS.audio.audioSessionLog() : []),
      date: new Date().toISOString()
    };
    PS.store.saveCalibration(label, calibration);
    PS.store.setActiveCalibrationLabel(label);
    if (settings && settings.deviceId) PS.store.markDeviceSeen(settings.deviceId);
    state.calibrations = PS.store.loadCalibrations();
    state.newDeviceDetected = false;
    return calibration;
  }
  PS.saveLabCalibration = saveLabCalibration;
  // v36 (QUEUE #34): exposed for the CDP tests (cdp-v159 asserts the
  // lab path drains its tail) — the lab itself calls recordSegment
  // directly; nothing else reads this handle.
  PS.recordSegment = recordSegment;
  // v37 (QUEUE #23): exposed for the CDP tests only (cdp-v160 drives
  // the live clip latch + reads the latch state) — the record path
  // calls noteLivePeak itself from onBlock; nothing else reads these.
  PS._noteLivePeak = noteLivePeak;
  PS._clipState = function () { return { blocks: liveClipBlocks, clipped: liveClipped }; };
  // v38 (QUEUE #122): exposed for the CDP tests only (cdp-v161 reads
  // the monitor state + gain) — the record path calls updateMonitor
  // itself on take start; nothing else reads this handle.
  PS._monitorState = function () {
    return {
      on: state.monitorOn,
      running: !!state.monitor,
      gain: state.monitor ? state.monitor.gain.gain.value : null,
      allowed: !routeIsSlow(),
      mode: PS.store.outputMode()
    };
  };
  // v39 (QUEUE #123): exposed for the CDP tests only (cdp-v162 reads
  // the beat-load state + the Play-wait flag) — the play path reads
  // state itself; nothing else reads this handle.
  PS._beatState = function () {
    return {
      loading: state.beatLoading,
      loaded: !!state.beat,
      waiting: state.playWaiting,
      playing: !!state.playingStop
    };
  };
  // v40 (QUEUE #124): exposed for the CDP tests only (cdp-v163 reads
  // the stored level + the live gain per layer) — the play path reads
  // the engine gains itself; nothing else reads this handle.
  PS._layerVolumes = function () {
    var out = {};
    trackKinds().concat(['beat']).forEach(function (k) {
      out[k] = {
        stored: PS.store.layerVolume(state.session, k),
        live: PS.audio.layerGainValue(k)
      };
    });
    return out;
  };

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
      // v32 (QUEUE #110) — the lab test is the measurement now
      // (Setup's "Measure my headphones" is gone): the 8 clicks
      // just measured the round-trip latency, so save it as the
      // active calibration. A run where the clicks were not heard
      // saves nothing (medianMs null) and the old timing stands.
      var savedCal = saveLabCalibration(label, report, before);
      PS.store.saveLabReport(label, report);
      state.labReports = PS.store.loadLabReports();
      state.newDeviceDetected = false;
      $('lab-status').textContent = 'Done — ' + label + ': hears up to ' +
        (report.bandwidthHz / 1000).toFixed(1) + ' kHz' +
        (report.studioGrade ? ' (studio grade)' : '') +
        '. ' + report.recommendation +
        (savedCal ? ' Timing saved — your voice will land in time.' : '');
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
      if (note) note.textContent = 'Tap once — the last 60 seconds are saved as a take.';
    }
    btn.disabled = !!state.recording || !!state.calibrating || state.loggerArming || state.beatLoading;
    // v28 (QUEUE #102): the Ideas button stays live while a beat
    // loads — the record button is greyed in that window (app.js
    // :6261) but this one was not, so arming the logger mid-load
    // froze the session's beat name before the beat was playable.
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
    // v22 (QUEUE #45/#46/#48): freeze the beat + sound identity at
    // ARM time — the logger's ring holds up to 60 s of audio sung
    // BEFORE the save, so the save must stamp what was true when
    // listening started, never live state at save time. Captured
    // here, synchronously at function entry, because the mic opens
    // in a .then below. beatless is set at freeze time, never at save.
    // v28 (QUEUE #102): the four beat fields + beatless freeze only
    // when the beat's buffer actually exists — the take path's own
    // guard (beginTake, v25 #85). A beatFileName with no state.beat
    // means the load is still in flight (or failed), so the logger
    // take is truthfully beatless and stamps no beat fields. The
    // beat's display name freezes under the same guard (v28 #66).
    var frozenBeatFileName = state.beat ? (state.session.beatFileName || null) : null;
    var frozenBeatSha256 = state.beat ? (state.session.beatSha256 || null) : null;
    var frozenBeatBpm = state.beat ? (state.session.beatBpm || null) : null;
    var frozenBeatBpmAlt = state.beat ? (state.session.beatBpmAlt || null) : null;
    var frozenBeatOriginalName = state.beat ? (state.session.beatOriginalName || null) : null;
    // v28 (QUEUE #66): the beat's display name freezes under the
    // same state.beat guard — beatFileName is the normalized
    // 'beat.wav', never a name a singer can tell apart; the row
    // shows the original file name instead.
    var frozenBeatless = !state.session.beatFileName || !state.beat;
    // v24 (QUEUE #53): the beat's rate at arm time — the residual
    // check runs at this rate, and the take stamps it so a later
    // read can prove the check ran on matched arrays.
    var frozenBeatSampleRate = state.beat ? state.beat.sampleRate : null;
    var frozenKey = state.session.key;
    var frozenPreset = state.session.preset;
    var frozenStrength = state.session.strength;
    state.loggerArming = true;
    updateIdeasUI();
    PS.audio.ensureContext().then(function (ctx) {
      var sr = ctx.sampleRate;
      var ring = new PS.safety.RingBuffer(PS.safety.LOGGER_SECONDS * sr);
      return PS.audio.startLogger(function (batch) {
        ring.push(batch.samples);
      }).then(function () {
        state.loggerArming = false;
        // v22: the arm-time freeze (QUEUE #45/#46/#48) — stamped
        // from here at save, never from live session state.
        state.logger = { ring: ring, startWall: Date.now(), sampleRate: sr,
          beatFileName: frozenBeatFileName, beatSha256: frozenBeatSha256,
          beatBpm: frozenBeatBpm, beatBpmAlt: frozenBeatBpmAlt,
          beatOriginalName: frozenBeatOriginalName,
          beatSampleRate: frozenBeatSampleRate,
          beatless: frozenBeatless, key: frozenKey,
          preset: frozenPreset, strength: frozenStrength };
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
    // v36 (QUEUE #34): stopLogger drains (~one render quantum) and
    // closeMic refuses while a capture is stopping — close the mic
    // when the drain lands, or it stays open and review plays dull.
    try {
      PS.audio.stopLogger().then(function () { maybeCloseMic(); }).catch(function () { /* ignore */ });
    } catch (e) { maybeCloseMic(); }
    state.logger = null;
    releaseWakeLock();
    updateIdeasUI();
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
    // v36 (QUEUE #34): stopLogger drains — close the mic when it
    // lands (closeMic refuses while a capture is stopping).
    try {
      PS.audio.stopLogger().then(function () { maybeCloseMic(); }).catch(function () { /* ignore */ });
    } catch (e) { maybeCloseMic(); }
    if (snapshot.length < Math.round(0.5 * sr)) {
      showError('Nothing to save yet — the logger had just started listening.');
      return;
    }
    var track = state.selectedTrack;
    var vocal = state.session.tracks[track];
    var takeNumber = vocal.takes.length + 1;
    var takeId = PS.store.newId();
    var durationSeconds = snapshot.length / sr;
    // v37 (QUEUE #23): the logger take never runs analyzeTake (no
    // narrowband check on the ring buffer) — scan the snapshot for
    // the peak + full-scale count directly, same threshold, same
    // shape as analyzeTake's clip fields.
    var loggerClip = PS.routelab.clipStats(snapshot);
    var baseName = takeFileBase(state.session.name, track, takeNumber, takeId);
    var metadata = {
      trackKind: track,
      rawFileName: baseName + '-raw.wav',
      alignedFileName: baseName + '.wav',
      sampleRate: sr,
      // v13.8-light: which beat this take was sung over (logger
      // takes have no beat anchor — nulls, never a guess).
      // v22 (QUEUE #45/#46): stamped from the arm-time freeze
      // (logger.*), never from live session state.
      beatFileName: logger.beatFileName,
      beatSha256: logger.beatSha256,
      beatOriginalName: logger.beatOriginalName,
      beatless: !!logger.beatless,
      // v20 (QUEUE #41): the beat's tempo travels with the take —
      // the server renders the echo on this grid, never the
      // hardcoded 135. Nulls when there was no beat (or no tempo
      // detected yet); beatBpmAlt is the half/double partner.
      beatBpm: logger.beatBpm,
      beatBpmAlt: logger.beatBpmAlt,
      // v24 (QUEUE #53): the beat's rate at arm time.
      beatSampleRate: logger.beatSampleRate,
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
      // v35 (QUEUE #32): the mic died while the logger was
      // armed — this take is the ring buffer up to the
      // disconnect, flagged interrupted, never a clean minute.
      interrupted: !!logger.micEnded,
      loggerRecovery: true,
      chunkCount: 0,
      savedUpToSeconds: durationSeconds,
      micSettings: PS.audio.micSettings(),
      echoCancellationOff: null,
      // v13.2 (item 4) — what mic recorded the take (the logger
      // take was captured with the mic open too).
      micLabel: PS.audio.micLabel(),
      narrowbandWarn: false,
      narrowbandFractionAbove7k5: null,
      takeBandwidthHz: null,
      takeRmsDb: PS.routelab.rmsDb(snapshot),
      // v37 (QUEUE #23): clipping, from the snapshot scan above.
      takePeakDbfs: loggerClip.peakDbfs,
      takeClippedSamples: loggerClip.clippedSamples,
      clipped: loggerClip.clipped,
      outputLatencySeconds: PS.audio.outputLatency(),
      outputLatencyAtStartSeconds: null,
      calibrationOutputLatencySeconds: null,
      outputLatencyDrift: false,
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.1',
      // Step 3 — the sound this take was sung with. Playback uses
      // the TAKE's sound, not the song's current one, so changing
      // the preset later never rewrites what this take sounds like.
      // v22 (QUEUE #48): stamped from the arm-time freeze.
      preset: logger.preset,
      strength: logger.strength,
      speed: state.session.speed,
      key: logger.key,
      macros: copySessionMacros(),
      chainOn: state.session.chainOn,
      bypass: copySessionBypass(),
      tone: copySessionTone(),
      analysis: null, // filled in after the take saves (Step 3)
      // v13.2 (item 5) — timestamped notes on the take: each is a
      // time in seconds + words the singer typed. Saved here so the
      // backup carries them.
      notes: [],
      // Step 6C (v13.3): where the take sits in the song. A plain
      // take starts at 0; a loop pass or a best-of take starts at
      // the part it covers. The reconcile step reads these back
      // when it rebuilds a take list from storage.
      songOffsetSeconds: 0,
      loopPass: false,
      comp: false
    };
    var wav;
    // v21 (QUEUE #19): the encode is the only pre-save step here
    // and the only one that allocates (~19 MiB for the 60 s ring)
    // — a throw used to die silently and lose the only copy, since
    // a logger take has no chunks. Now the encode + save run inside
    // attemptLoggerSave, whose retry re-runs both from the same
    // snapshot. The save path itself is unchanged (#10 owns it).
    function attemptLoggerSave() {
      try {
        wav = new Blob([PS.wav.encodeWavFloat32(snapshot, sr)], { type: 'audio/wav' });
      } catch (encodeErr) {
        showSaveFailedError('Something went wrong finishing the last 60 seconds — the audio is still in memory. Tap "Try saving again" to save it now. This is the only copy — closing the app loses it.',
          { kind: 'logger-finish', resume: function () { attemptLoggerSave(); } });
        return;
      }
      var loggerRecord = {
        id: takeId,
        sessionId: state.session.id,
        track: track,
        takeNumber: takeNumber,
        rawWav: wav,
        alignedWav: wav,
        metadata: metadata,
        recordedAt: metadata.recordedAt
      };
      PS.db.saveTake(loggerRecord).then(completeLoggerSave).catch(function (err) {
        console.warn('Logger take save failed:', err);
        showSaveFailedError('The last 60 seconds could not be saved — the phone may be out of space for this site. Tap "Try saving again" — the last minute is still in memory, and this is the only copy.',
          { kind: 'logger', record: loggerRecord, onSaved: completeLoggerSave });
      });
    }
    // v17 (QUEUE #10): same shape as finishTake — one record, one
    // success function, so a failed save can be retried with the
    // exact same bytes. A logger take has NO chunks, so its message
    // must not promise a boot recovery: the retry (this copy, still
    // in memory) is the only way back, and it says so.
    function completeLoggerSave() {
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
        // v35 (QUEUE #32): a logger take saved because the mic
        // died is partial — the ring buffer stops at the disconnect.
        partial: !!logger.micEnded,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: false,
        // v37 (QUEUE #23): clipping, from the snapshot scan — the row reads it from here.
        clipped: loggerClip.clipped,
        takePeakDbfs: loggerClip.peakDbfs,
        takeClippedSamples: loggerClip.clippedSamples,
        outputLatencyDrift: false,
        loggerRecovery: true,
        // v28 (QUEUE #66): the logger take's own frozen beat
        // identity, on the list entry — the row reads it from here.
        beatFileName: logger.beatFileName,
        beatOriginalName: logger.beatOriginalName,
        beatless: !!logger.beatless,
        // v13.2 (item 4) — what mic recorded the take.
        micLabel: PS.audio.micLabel(),
        // Step 3 — same sound stamp as a recorded take.
        // v22 (QUEUE #48): stamped from the arm-time freeze.
        preset: logger.preset,
        strength: logger.strength,
        speed: state.session.speed,
        key: logger.key,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        // v13.2 (item 5) — timestamped notes on the take.
        notes: []
      });
      vocal.activeTakeId = takeId;
      saveSessions();
      renderTracks();
      renderSheet();
      updateTransport();
      // v35 (QUEUE #32): the logger take exists because the mic
      // died — say so, so the last minute is never read as a
      // clean minute.
      if (logger.micEnded) {
        showError('The mic disconnected — the last minute was saved up to the disconnect.');
      } else if (loggerClip.clipped) {
        // v37 (QUEUE #23): the last minute clipped — said plainly, never gated.
        showError('That take clipped — the loudest peaks hit the limit. Back off the mic a little and record it again.');
      }
    }
    attemptLoggerSave();
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
    // v17 (QUEUE #10): a new take supersedes a failed save still
    // waiting on its retry — the error box is already hidden
    // (startTakeRequest called clearError), so the retry is
    // unreachable from here. The failed take is still recoverable
    // from its chunks on the next boot.
    state.pendingFailedTake = null;
    // The take id + number are fixed BEFORE recording starts, so the
    // chunked writes (Step 1B) can be keyed while the take records.
    var vocal = state.session.tracks[track];
    var takeId = PS.store.newId();
    var takeNumber = vocal.takes.length + 1;
    // v22 (QUEUE #45/#46/#48): the beat + sound identity is frozen at
    // the SAME point — BEFORE recording starts, synchronously at
    // function entry. A mid-take beat swap/remove or key-pill tap must
    // never rewrite what the take stamps. Captured in closure
    // variables because state.recording is only assigned in the .then
    // after startTake resolves — reading live state there would be
    // the same hole. beatless is set at freeze time, never at save.
    // v25 (QUEUE #85, belt-and-braces): the beat fields freeze
    // only when the beat's buffer actually exists. A beatFileName
    // with no state.beat means the load is still in flight (or
    // failed) — startTake would play nothing, so the take is
    // truthfully beatless and stamps no beat fields. The button
    // guard (updateTransport + beatLoading) is what closes the
    // window; this is the stamp staying honest if a take ever
    // starts through it anyway.
    var frozenBeatFileName = state.beat ? (state.session.beatFileName || null) : null;
    var frozenBeatSha256 = state.beat ? (state.session.beatSha256 || null) : null;
    var frozenBeatBpm = state.beat ? (state.session.beatBpm || null) : null;
    var frozenBeatBpmAlt = state.beat ? (state.session.beatBpmAlt || null) : null;
    var frozenBeatOriginalName = state.beat ? (state.session.beatOriginalName || null) : null;
    var frozenBeatless = !state.session.beatFileName || !state.beat;
    // v24 (QUEUE #53): the beat's rate at record start — the
    // residual check runs at this rate; the take stamps it.
    var frozenBeatSampleRate = state.beat ? state.beat.sampleRate : null;
    var frozenKey = state.session.key;
    var frozenPreset = state.session.preset;
    var frozenStrength = state.session.strength;
    // v25 (QUEUE #59): the FULL sound identity at record start.
    // The v22 freeze covers key/preset/strength; macros/chain/
    // bypass/tone are read live at save today, so only the
    // record-start values can stamp a recovered take. Captured
    // here, carried on state.recording, written to the recovery
    // record when the first chunk lands.
    var frozenMacros = copySessionMacros();
    var frozenChainOn = state.session.chainOn;
    var frozenBypass = copySessionBypass();
    var frozenTone = copySessionTone();
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
    resetClipState(); // v37 (QUEUE #23): a new take starts clean — the latch from the last take never carries over
    // Overdubs: the active takes of the OTHER vocal tracks, so ad-libs
    // and harmonies record over the lead. Same anchor as the beat —
    // they travel the same Bluetooth path, so they need the same
    // early start. (Port of AudioEngineManager.beginTake.)
    livePeaks = [];
    livePeakAccum = 0;
    loadOverdubBuffers(track).then(function (overdubs) {
      // B3 (v13.1): overdubs play tuned — the tune module must be
      // loaded before the take schedules them, or the worklet node
      // cannot be built.
      if (overdubs.length) {
        return ensureTuneModule().then(function () { return overdubs; });
      }
      return overdubs;
    }).then(function (overdubs) {
      return PS.audio.startTake({
        beat: state.beat,
        overdubs: overdubs,
        // B3 (v13.1): each overdub gets a playback tune node with
        // its own take's sound (built here, in the app, where the
        // tune module lives — the engine just wires it in).
        // Step 4A (v13.4): it gets the full vocal chain, not just
        // the tune — a guide vocal should sound like the finished
        // take, room and all.
        tuneNodeFor: function (ctx, sound, kind) { return makeVocalChain(ctx, false, sound, PS.audio.layerGainFor(kind || 'lead') || PS.audio.outputNode() || ctx.destination); },
        delaySeconds: delaySeconds,
        // Step 6C (v13.3): loop the beat (and any overdub that
        // reaches the part) while this take records — the app
        // splits the capture into one take per pass at the end.
        loop: loopOn() ? { start: state.session.loop.start, end: state.session.loop.end } : null,
        onBlock: function (batch) {
          if (window.PSPerf) PSPerf.noteBlock(batch.time);
          setMeter(batch.peak); accumulateLivePeak(batch.peak); noteLivePeak(batch.peak);
        },
        // Chunked writes (Step 1B): one 48,000-sample chunk per
        // second, straight to storage while recording. A write
        // failure never fails the take — the in-memory recording
        // is still the primary copy.
        onChunk: function (index, samples) {
          chunkState.count = index + 1;
          // v36 (QUEUE #34): return the writes — the stop drain
          // waits for the final partial chunk's put to land before
          // the take saves, so completeTakeSave's chunk delete can
          // never run ahead of it and leave a phantom recovery row
          // behind on the next boot. The mid-take path ignores the
          // return value, as before.
          var writes = [];
          // v25 (QUEUE #59): the first chunk landing is the moment
          // the take becomes recoverable — write the at-record
          // sound identity with it, keyed by takeId. A write
          // failure here never fails the take (the record is a
          // stamp, not the audio); a missing record at recovery
          // time falls back to the session + flags the take.
          if (index === 0) {
            writes.push(PS.db.saveTakeRecovery({
              takeId: takeId,
              sessionId: state.session.id,
              track: track,
              key: frozenKey,
              preset: frozenPreset,
              strength: frozenStrength,
              macros: frozenMacros,
              chainOn: frozenChainOn,
              bypass: frozenBypass,
              tone: frozenTone,
              beatFileName: frozenBeatFileName,
              beatSha256: frozenBeatSha256,
              beatBpm: frozenBeatBpm,
              beatBpmAlt: frozenBeatBpmAlt,
              beatOriginalName: frozenBeatOriginalName,
              beatSampleRate: frozenBeatSampleRate,
              beatless: frozenBeatless,
              recordedAt: new Date().toISOString()
            }).catch(function (err) {
              console.warn('Recovery record write failed (take continues in memory):', err);
            }));
          }
          writes.push(PS.db.saveTakeChunk({
            key: PS.safety.chunkKey(state.session.id, track, takeId, index),
            sessionId: state.session.id,
            track: track,
            takeId: takeId,
            index: index,
            sampleRate: PS.audio.sampleRate(),
            data: samples
          }).catch(function (err) {
            console.warn('Chunk write failed (take continues in memory):', err);
            // v25 (QUEUE #82): the chunk writes are the canary —
            // surface the FIRST failure live, while he is still
            // singing. The take keeps recording (the in-memory
            // copy is primary, never stopped mid-line); the flag
            // lets finishTake say the safety copy is partial.
            // Only the first failure warns — one per second after
            // that would be noise over a performance.
            if (!chunkState.writeFailed) {
              chunkState.writeFailed = true;
              chunkState.writeFailedAt = Date.now();
              var hint = $('record-hint');
              if (hint) hint.textContent = 'Storage is full — this take may not save. Stop now and the part so far is kept as a recovery; free space first if you want the whole take.';
              // Name the free space once, if the phone will say —
              // the warning stands without the number.
              if (navigator.storage && navigator.storage.estimate) {
                navigator.storage.estimate().then(function (est) {
                  if (chunkState.writeFailed && hint && est &&
                      typeof est.quota === 'number' && typeof est.usage === 'number') {
                    var freeMB = Math.max(0, Math.round((est.quota - est.usage) / (1024 * 1024)));
                    hint.textContent += ' (' + freeMB + ' MB free.)';
                  }
                }).catch(function () { /* the warning stands without a number */ });
              }
            }
          }));
          return Promise.all(writes);
        }
      });
    }).then(function (handle) {
      state.startingTake = false;
      if (window.PSPerf) { PSPerf.mark('record-started'); PSPerf.measure('record-start-ms', 'record-tap', 'record-started'); PSPerf.measure('tap-to-first-block-ms', 'record-tap', 'record-first-block'); }
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
        // Step 6C (v13.3): the loop this take is cycling, or null
        // for a normal take. finishTake splits a loop capture into
        // one take per pass.
        loop: loopOn() ? { start: state.session.loop.start, end: state.session.loop.end } : null,
        outputLatencyAtStart: PS.audio.outputLatency(),
        // v22 (QUEUE #45/#46/#48): the frozen beat + sound identity —
        // stamped from here at save, never from live session state.
        beatFileName: frozenBeatFileName,
        beatSha256: frozenBeatSha256,
        beatBpm: frozenBeatBpm,
        beatBpmAlt: frozenBeatBpmAlt,
        beatOriginalName: frozenBeatOriginalName,
        beatSampleRate: frozenBeatSampleRate,
        beatless: frozenBeatless,
        key: frozenKey,
        preset: frozenPreset,
        strength: frozenStrength,
        // v25 (QUEUE #59): the full sound identity at record start
        // — the recovery record is written from these (see onChunk).
        macros: frozenMacros,
        chainOn: frozenChainOn,
        bypass: frozenBypass,
        tone: frozenTone
      };
      acquireWakeLock();
      $('live-strip').style.display = 'flex';
      // v13 — say it plainly in speaker mode: if he cannot hear
      // the beat, the fix is headphones, not a louder tap. The
      // meter + waveform + timer underneath prove the take is
      // recording either way.
      var hint = state.beat
        ? 'Recording — sing when the beat starts. Keep this page open.'
        : 'Recording — sing whenever you are ready. Keep this page open.';
      if (PS.store.outputMode() === 'speaker') {
        hint += ' If you can\'t hear the beat, plug in headphones — the take is still recording.';
      }
      $('record-hint').textContent = hint;
      setPlayhead(0);
      ensurePlayheadTimer();
      renderTracks();
      updateTransport();
      // v38 (QUEUE #122): the monitor is ON by default — start the
      // branch with the take, so he hears himself as soon as he
      // records. monitorWanted() still refuses speaker output and
      // slow routes, and a tap on the headphones button
      // (toggleMonitor) turns it off until he taps it back on.
      // updateMonitor() is otherwise only ever called from
      // toggleMonitor — a `true` default alone would never build
      // the branch, and the mic still opens only while a take is
      // recording (v11): no monitor runs before the first record.
      updateMonitor();
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
    trackKinds().forEach(function (kind) {
      if (kind === exceptTrack) return;
      var vocal = state.session.tracks[kind];
      if (!vocal) return;
      var takeId = vocal.activeTakeId || (vocal.takes.length ? vocal.takes[vocal.takes.length - 1].id : null);
      if (!takeId) return;
      // v13.8-light: a take's audio never changes after save, so a
      // decoded overdub is cached by take id — the record tap no
      // longer re-reads IndexedDB + re-decodes every guide vocal
      // on every take. The cache clears on song switch.
      var cached = state.overdubCache[takeId];
      if (cached) { jobs.push(Promise.resolve(cached)); return; }
      jobs.push(
        PS.db.getTake(takeId).then(function (record) {
          if (!record || !record.alignedWav) return null;
          // B3 (v13.1): the overdub carries its take's own sound,
          // so the record path can tune it exactly like playback
          // does — the guide vocal sounds finished, not raw.
          var take = vocal.takes.find(function (t) { return t.id === takeId; });
          var sound = takeSound(take);
          return record.alignedWav.arrayBuffer().then(function (buf) {
            return PS.audio.decodeAudio(buf);
          }).then(function (buffer) {
            // Step 6C (v13.3): the overdub carries where it sits
            // in the song, so the engine can start it late — a
            // loop pass or a best-of take used as a guide vocal
            // lines up with the beat instead of playing from 0.
            var item = { kind: kind, buffer: buffer, sound: sound, songOffsetSeconds: take ? (take.songOffsetSeconds || 0) : 0 };
            state.overdubCache[takeId] = item;
            return item;
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
    // v35 (QUEUE #32): backstop for a mic that died without
    // firing onended — poll liveness on the 100 ms record tick
    // and finish flagged interrupted instead of recording
    // silence. Safe here: the mic is open by construction while
    // a take runs (startCapture resolved on the first block), so
    // a dead track is a real death, not a not-yet-open mic.
    if (PS.audio && typeof PS.audio.micAlive === 'function' && !PS.audio.micAlive()) {
      finishTake(true, 'mic-disconnected');
      return;
    }
    // v41 (QUEUE #42): liveness watchdog — the mic track can stay
    // live while the audio flow stalls (page-visible interruption:
    // Siri, an alarm, an audio-route takeover; a suspended context
    // or a stalled worklet posts no blocks). The micAlive poll
    // above cannot see it, so watch the block flow itself: no block
    // for > 2 s ends the take flagged interrupted, the same path as
    // a dead mic — the pre-stall audio is saved, he re-sings instead
    // of singing into a dead take. No auto-resume: a resume without
    // the watchdog would leave the hole invisible.
    var lastBlockAt = PS.audio && typeof PS.audio.captureLastBlockAt === 'function'
      ? PS.audio.captureLastBlockAt() : null;
    if (lastBlockAt !== null) {
      var blockGapMs = Date.now() - lastBlockAt;
      if (blockGapMs > 2000) {
        finishTake(true, 'audio-interrupted');
        return;
      }
      // v41 (QUEUE #42): meter decay — setMeter is only called from
      // the onBlock path, so on a stall the bar freezes at its last
      // width. Drop it to zero within one tick of a > 100 ms gap,
      // so a stall is visible on the meter, not just the waveform.
      // setMeter's signature is unchanged; the decay is a caller-side call.
      if (blockGapMs > 100) setMeter(0);
    }
    var elapsed = (Date.now() - state.recording.startWall) / 1000;
    var label = $('record-timer');
    if (label) label.textContent = elapsed.toFixed(1) + 's';
    // Step 6C (v13.3): while looping, the hint says which pass he
    // is on — the pass changes when the beat wraps, so the text
    // only updates when the number does.
    if (state.recording.loop) {
      var loopLen = state.recording.loop.end - state.recording.loop.start;
      var pass = Math.floor(Math.max(0, PS.audio.currentTime() - state.recording.anchorTime) / loopLen) + 1;
      // v25 (QUEUE #82): a storage warning in the hint is never
      // overwritten by the pass line — it stays until he stops.
      if (pass !== state.recording.lastPassShown &&
          !(state.recording.chunkState && state.recording.chunkState.writeFailed)) {
        state.recording.lastPassShown = pass;
        $('record-hint').textContent = 'Looping — pass ' + pass + '. Sing the part again, or stop to keep the best.';
      }
    }
    // v13 — live waveform: one bar per 100 ms of the loudest sound
    // since the last tick, so the strip visibly moves while he sings.
    livePeaks.push(livePeakAccum);
    livePeakAccum = 0;
    if (livePeaks.length > 90) livePeaks.shift();
    drawLiveWave();
    drawFxWave();
  }

  function setMeter(peak) {
    var bar = $('level-bar');
    if (!bar) return;
    var pct = Math.min(100, Math.max(0, peak * 100));
    bar.style.width = pct + '%';
  }

  // v37 (QUEUE #23): clipping — detection + warning, NOT auto-gain.
  // The worklet already reports the true peak per block; count the
  // blocks at the rail (>= 0.999, the one threshold in
  // routelab.CLIP_PEAK_THRESHOLD) and latch a red "too loud" state
  // on the meter. It latches: one clipped block is enough to warn,
  // and the warning stays until the next take starts — a loud
  // moment he missed while singing is still there when he looks.
  // The capture sound never changes (no gain node, no limiter).
  var liveClipBlocks = 0;
  var liveClipped = false;

  function clipThreshold() {
    return (PS.routelab && typeof PS.routelab.CLIP_PEAK_THRESHOLD === 'number')
      ? PS.routelab.CLIP_PEAK_THRESHOLD : 0.999;
  }

  function setClipState(on) {
    var bar = $('level-bar');
    if (bar) bar.classList.toggle('clipping', !!on);
    var warn = $('clip-warn');
    if (warn) warn.style.display = on ? 'block' : 'none';
  }

  function noteLivePeak(peak) {
    if (peak >= clipThreshold()) {
      liveClipBlocks++;
      if (!liveClipped) {
        liveClipped = true;
        setClipState(true);
      }
    }
  }

  function resetClipState() {
    liveClipBlocks = 0;
    liveClipped = false;
    setClipState(false);
  }

  // v13 — rolling peaks for the live waveform (last ~9 s). The
  // mic blocks arrive every ~3 ms, so the peak is accumulated
  // between timer ticks and drawn as one bar per tick.
  var livePeaks = [];
  var livePeakAccum = 0;

  function accumulateLivePeak(peak) {
    if (peak > livePeakAccum) livePeakAccum = peak;
  }

  // v13 FIX: this was first named drawWave(), but a lane-waveform
  // drawWave(canvas, wave, color) already exists later in this
  // file — function declarations hoist, so the later one silently
  // replaced this one and the live canvas stayed blank. Renamed.
  // Step 5 (v13.6): the rolling peaks draw into any canvas — the
  // record strip and the sound panel's wave share this one draw.
  // v13.8-light: the live wave draws at most every 200 ms (5 fps
  // still reads as movement) and never while the page is hidden;
  // the 2d context is cached instead of fetched on every draw.
  // Two 100 ms ticks (record timer + monitor analyser) used to
  // draw both canvases each — 20 canvas draws a second, on the
  // same main thread the audio callbacks need.
  function drawLivePeaksInto(canvas) {
    if (!canvas) return;
    if (document.hidden) return;
    var nowMs = performance.now();
    if (canvas._psLastDraw && nowMs - canvas._psLastDraw < 200) return;
    canvas._psLastDraw = nowMs;
    var c2d = canvas._psCtx || (canvas._psCtx = canvas.getContext('2d'));
    if (!c2d) return;
    var w = canvas.width;
    var h = canvas.height;
    c2d.clearRect(0, 0, w, h);
    var n = livePeaks.length;
    if (!n) return;
    var bw = w / 90;
    for (var i = 0; i < n; i++) {
      var v = livePeaks[i];
      if (v <= 0) continue;
      var bh = Math.max(2, Math.min(1, v) * (h - 4));
      c2d.fillStyle = 'rgba(167, 139, 250, 0.9)';
      c2d.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
    }
  }

  function drawLiveWave() {
    drawLivePeaksInto($('live-wave'));
  }

  function stopTakeRequest() {
    if (!state.recording) return;
    finishTake(false);
  }

  /* v25 (QUEUE #70): a take with no sound in it. RMS at or below
   * the floor the narrowband check already uses for "the take must
   * have real content" (-50 dB, routelab.js) — pure silence is
   * -Infinity, room tone sits near -70 dB, a real take measures
   * about -18 dB, so the floor separates them by 32 dB. null means
   * the analysis never ran (a throw) — that take is unfinished,
   * never silent, so it returns false here and the unfinished
   * branch speaks first.
   */
  function takeIsSilent(takeAnalysis) {
    if (!takeAnalysis) return false;
    var rms = takeAnalysis.rmsDb;
    if (rms === null || rms === undefined) return false;
    var floor = (PS.routelab && typeof PS.routelab.NARROWBAND_MIN_RMS_DB === 'number')
      ? PS.routelab.NARROWBAND_MIN_RMS_DB : -50;
    return rms < floor;
  }

  /* Finishes the take: trim, residual check, save. (Port of
   * AudioEngineManager.finishTake + TrackRecorder.)
   */
  function finishTake(interrupted, reason) {
    var rec = state.recording;
    if (!rec) return;
    // v35 (QUEUE #32): why the take ended early, in plain words
    // for the finish message ('mic-disconnected' — the track
    // died; the visibilitychange path passes no reason).
    if (reason) rec.interruptedReason = reason;
    state.recording = null;
    clearInterval(rec.timer);
    releaseWakeLock();
    setMeter(0);
    livePeaks = [];
    livePeakAccum = 0;
    drawLiveWave();
    // Step 5 (v13.6): the panel's wave falls back to the take that
    // just ended, if the panel is open.
    drawFxWave();
    $('record-hint').textContent = '';
    $('live-strip').style.display = 'none';
    var timerEl = $('record-timer');
    if (timerEl) timerEl.textContent = '';
    clearPlayheadTimer();
    setPlayhead(0); // the take is done — back to the top, so Play hears it from the beginning

    var track = rec.track;
    var sr = PS.audio.sampleRate();
    var chunkCount = rec.chunkState ? rec.chunkState.count : 0;
    // v25 (QUEUE #82): a chunk write failed at least once mid-take
    // — the saved take is whole (it comes from memory) but the
    // safety copy is partial; the finish messages say so below.
    var chunkWriteFailed = !!(rec.chunkState && rec.chunkState.writeFailed);
    // v36 (QUEUE #34): stopTake drains the worklet's final partial
    // batch — async now. The rest of the finish runs when the
    // drained samples land (~one render quantum later). Everything
    // above was already synchronous up to the stop call (state
    // cleared, timer stopped, wake lock released), so the async
    // half only moves the save — a second finishTake still no-ops
    // on state.recording === null, and a record tap in the drain
    // window waits on the drain inside startCapture.
    PS.audio.stopTake(rec.handle).then(function (result) {
      if (!result.samples || result.samples.length === 0 || result.firstSampleTime === null) {
        // Nothing recorded — drop any chunks so they never surface as
        // a phantom recovery on the next boot.
        if (rec.takeId) PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
        if (rec.takeId) PS.db.deleteTakeRecovery(rec.takeId).catch(function () { /* ignore */ });
        showError('Nothing was recorded — the mic did not pick up any sound.');
        renderTracks();
        updateTransport();
        return;
      }

      // Step 6C (v13.3): a loop take is one capture of many passes —
      // it splits into one take per pass instead of one take.
      if (rec.loop) {
        finishLoopTake(rec, result, sr, chunkCount);
        return;
      }

      // --- Narrowband check (Step 1B). ---
      // If the recorded input has virtually no energy above 7.5 kHz,
      // the Bluetooth mic is in phone-call mode and the vocal is
      // crushed — no software recovers those frequencies. Warn him
      // plainly (and record it in the metadata) instead of silently
      // keeping a muffled take.
      // v21 (QUEUE #19): the finish path used to run with zero
      // try/catch — a throw here (FFT edge case, heap pressure)
      // died in the console and the take vanished with no error
      // and no retry. A failed analysis now falls back to saving
      // the RAW take untrimmed (analysis fields null, flagged
      // unfinished) — a raw take he can re-trim beats a lost take.
      var finishError = null;
      var takeAnalysis;
      try {
        takeAnalysis = PS.routelab.analyzeTake(result.samples, sr);
      } catch (e) {
        finishError = e;
        takeAnalysis = { narrowbandWarn: false, fractionAbove7k5: null, bandwidthHz: null, rmsDb: null, peakDbfs: null, clippedSamples: null, clipped: false };
      }
      // v25 (QUEUE #70): no sound in the take — the warning chain
      // in completeTakeSave reads this after the unfinished branch
      // (a failed analysis is unfinished, never silent).
      var silentTake = takeIsSilent(takeAnalysis);

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
      // v21 (QUEUE #19): guarded like the analysis above — a throw
      // falls back to the raw take, it never drops the take.
      var residual;
      if (state.beat && state.beat.mono) {
        // v24 (QUEUE #53): the residual check reads both arrays at ONE
        // rate (sr). decodeBeat resamples the beat to the context rate,
        // but if the beat ever arrives at another rate (a browser that
        // hands back the native rate and no offline render to fix it),
        // verify() would read the beat's onsets ~8% early and mis-trim
        // the take — or flag an on-time take off-beat. Refuse loudly
        // instead of verifying on mismatched arrays.
        if (state.beat.sampleRate !== sr) {
          residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'unverified-rate-mismatch' };
        } else {
          try {
            residual = PS.residual.verify(result.samples, state.beat.mono, baseTrimSamples, sr);
          } catch (e) {
            if (!finishError) finishError = e;
            residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
          }
        }
      } else {
        residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
      }
      var trimSamples = Math.max(0, Math.min(baseTrimSamples + residual.trimSamples, result.samples.length));
      var alignedSamples = result.samples.subarray(trimSamples);
      if (finishError) {
        // The analysis failed — save the raw take untrimmed. The
        // too-short check below then reads the full capture, so a
        // take is never dropped for a trim it never got.
        trimSamples = 0;
        alignedSamples = result.samples;
      }
      if (alignedSamples.length < Math.round(0.3 * sr)) {
        // A tap-and-release (or a take sung entirely inside the
        // lead-in) leaves nothing after the trim — do not save an
        // empty take. Drop any chunks for the same reason as above.
        if (rec.takeId) PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
        if (rec.takeId) PS.db.deleteTakeRecovery(rec.takeId).catch(function () { /* ignore */ });
        showError('Too short to save — tap record and sing a little longer.');
        renderTracks();
        updateTransport();
        return;
      }

      var vocal = state.session.tracks[track];
      var takeNumber = rec.takeNumber;
      var baseName = takeFileBase(state.session.name, track, takeNumber, rec.takeId);
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
        // v13.8-light: which beat this take was sung over — the
        // server render matches on this, never guesses. Nulls when
        // there was no beat (or no fingerprint yet).
        // v22 (QUEUE #45/#46): stamped from the freeze at record
        // start (rec.*), never from live session state — a beat
        // swapped or removed mid-take cannot rewrite the stamp.
        beatFileName: rec.beatFileName,
        beatSha256: rec.beatSha256,
        beatOriginalName: rec.beatOriginalName,
        beatless: !!rec.beatless,
        // v20 (QUEUE #41): the beat's tempo travels with the take —
        // the server renders the echo on this grid, never the
        // hardcoded 135. Nulls when there was no beat (or no tempo
        // detected yet); beatBpmAlt is the half/double partner.
        beatBpm: rec.beatBpm,
        beatBpmAlt: rec.beatBpmAlt,
        // v24 (QUEUE #53): the beat's rate at record start — the
        // residual check ran the beat's mono at this rate. Nulls when
        // there was no beat.
        beatSampleRate: rec.beatSampleRate,
        durationSeconds: durationSeconds,
        // v41 (QUEUE #42): wall-clock length of the take, next to
        // the sample-derived duration — a stall is detectable
        // post-hoc even if the watchdog is bypassed (wall exceeds
        // samples by ~ the stall). An addition, not a replacement:
        // durationSeconds / savedUpToSeconds keep their meanings.
        // rec.startWall, not state.recording: finishTake nulled it
        // at the top, rec is the same object.
        wallDurationSeconds: (Date.now() - rec.startWall) / 1000,
        leadInSamples: leadInSamples,
        delaySamples: delaySamples,
        delayMilliseconds: delaySamples / sr * 1000,
        trimSamples: trimSamples,
        preCompensationActive: result.preCompActive,
        preCompensationDelayMilliseconds: result.preCompActive && result.delaySeconds !== null
          ? result.delaySeconds * 1000 : null,
        residualTrimSamples: finishError ? 0 : residual.trimSamples,
        residualMilliseconds: finishError ? null : (residual.residualSeconds !== null ? residual.residualSeconds * 1000 : null),
        residualOnsets: finishError ? 0 : residual.onsetCount,
        residualVerdict: finishError ? 'unfinished' : residual.verdict,
        // v21 (QUEUE #19): a take saved raw because the finish
        // checks threw — the sheet says so in plain words.
        unfinished: !!finishError,
        finishError: finishError ? String(finishError && finishError.message || finishError) : null,
        calibrationDeviceUID: null, // the web has no device identity
        calibrationLabel: active ? active.label : null,
        calibrationDeviceName: active ? active.label : null,
        calibrationDate: active ? active.calibration.date : null,
        calibrated: calibrated,
        compensationSource: compensationSource,
        interrupted: !!interrupted,
        // v41 (QUEUE #42): why the take ended early, in plain code
        // ('mic-disconnected' / 'audio-interrupted' / null) — the
        // saved record names the cause, not just the flag.
        interruptedReason: rec.interruptedReason || null,
        // Step 1B — the take is durable from its chunks up to the last
        // chunk (v36, QUEUE #34: the stop flushes the final partial
        // chunk too, so the durable span runs to the end of the take —
        // chunkedSeconds counts that partial chunk as a full second,
        // so this figure rounds the tail up by < 1 s on interrupted
        // takes; the recovered audio itself is exact). The rest was
        // saved best-effort in memory.
        chunkCount: chunkCount,
        savedUpToSeconds: interrupted ? PS.safety.chunkedSeconds(chunkCount, sr) : durationSeconds,
        // Step 1B — the mic settings actually applied (verified via
        // track.getSettings() when the mic opened).
        micSettings: micSettings,
        echoCancellationOff: micSettings ? micSettings.echoCancellation === false : null,
        // B9 (v13.1) — the phone processed the mic despite the raw
        // constraints (echo cancellation, noise suppression, or auto
        // gain actually on). The take sheet says so in plain words,
        // and the backup carries it in this metadata.
        micProcessed: PS.audio.micProcessed(),
        // v13.2 (item 4) — what mic recorded the take, in plain
        // words ("built-in mic", a product name, or "input unknown"
        // when the app cannot tell). The take sheet shows it.
        micLabel: PS.audio.micLabel(),
        // Step 1B — narrowband warning (Bluetooth HFP mic).
        narrowbandWarn: takeAnalysis.narrowbandWarn,
        narrowbandFractionAbove7k5: takeAnalysis.fractionAbove7k5,
        takeBandwidthHz: takeAnalysis.bandwidthHz,
        takeRmsDb: takeAnalysis.rmsDb,
        // v37 (QUEUE #23): clipping at capture — peak + full-scale count.
        takePeakDbfs: takeAnalysis.peakDbfs,
        takeClippedSamples: takeAnalysis.clippedSamples,
        clipped: takeAnalysis.clipped,
        // v25 (QUEUE #70): no sound in the take. (QUEUE #82): a
        // chunk write failed mid-take — the saved take is whole
        // (from memory) but the safety copy is partial.
        silentTake: silentTake,
        chunkWriteFailed: chunkWriteFailed,
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
        // v22 (QUEUE #48): stamped from the record-start freeze.
        preset: rec.preset,
        strength: rec.strength,
        speed: state.session.speed,
        key: rec.key,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null, // filled in after the take saves (Step 3)
        // v13.2 (item 5) — timestamped notes on the take: each is a
        // time in seconds + words the singer typed. Saved here so the
        // backup carries them.
        notes: [],
        // Step 6C (v13.3): where the take sits in the song. A plain
        // take starts at 0; a loop pass or a best-of take starts at
        // the part it covers. The reconcile step reads these back
        // when it rebuilds a take list from storage.
        songOffsetSeconds: 0,
        loopPass: false,
        comp: false
      };

      // v21 (QUEUE #19): the blobs are built inside attemptTakeSave
      // below, so a throw in the encode can offer the #10 retry
      // instead of dropping the take. Declared here so the success
      // path (completeTakeSave) still sees the saved blobs.
      var rawWav;
      var alignedWav;
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
        residualVerdict: finishError ? 'unfinished' : residual.verdict,
        unfinished: !!finishError,
        partial: !!interrupted,
        savedUpToSeconds: metadata.savedUpToSeconds,
        narrowbandWarn: takeAnalysis.narrowbandWarn,
        // v37 (QUEUE #23): clipping — the row reads it from here.
        clipped: takeAnalysis.clipped,
        takePeakDbfs: takeAnalysis.peakDbfs,
        takeClippedSamples: takeAnalysis.clippedSamples,
        // v25 (QUEUE #70): no sound in the take. (QUEUE #82): a
        // chunk write failed mid-take — the safety copy is partial.
        silentTake: silentTake,
        chunkWriteFailed: chunkWriteFailed,
        // B9 (v13.1) — the phone processed this take's mic.
        micProcessed: metadata.micProcessed,
        // v13.2 (item 4) — what mic recorded the take.
        micLabel: metadata.micLabel,
        outputLatencyDrift: drifted,
        // Step 3 — the take's own sound + its one-line summary.
        // v22 (QUEUE #48): stamped from the record-start freeze.
        // v28 (QUEUE #66): the frozen beat identity rides on the
        // list entry too — the take row reads it from here, never
        // from live session state.
        preset: rec.preset,
        strength: rec.strength,
        speed: state.session.speed,
        key: rec.key,
        beatFileName: rec.beatFileName,
        beatOriginalName: rec.beatOriginalName,
        beatless: !!rec.beatless,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        // v13.2 (item 5) — timestamped notes on the take.
        notes: [],
        // Step 6C (v13.3): a plain take lives at 0 in the song.
        songOffsetSeconds: 0,
        loopPass: false,
        comp: false
      };

      // v17 (QUEUE #10): the save record is built once, so a failed
      // save can be retried with the exact same bytes + metadata —
      // and the success path is one function, run by the first save
      // or by the retry, never duplicated.
      // v21 (QUEUE #19): the encode is the last pre-save step and
      // the only one that allocates ~38 MiB in two fresh ArrayBuffers
      // at the fattest moment of the tab — the likeliest throw in the
      // whole finish path. If it throws, the take is still whole in
      // memory: hold it and offer the #10 retry, whose resume re-runs
      // this encode + save from the same samples. Chunks are NOT
      // deleted here — the boot recovery the message names is still
      // true. The save path itself is unchanged (#10 owns it).
      function attemptTakeSave() {
        try {
          rawWav = new Blob([PS.wav.encodeWavFloat32(result.samples, sr)], { type: 'audio/wav' });
          alignedWav = new Blob([PS.wav.encodeWavFloat32(alignedSamples, sr)], { type: 'audio/wav' });
        } catch (encodeErr) {
          showSaveFailedError('Something went wrong finishing the take — your audio is still here. Tap "Try saving again" to save it now, or close the app and reopen it — your take is kept as a recovery' + (chunkWriteFailed ? ' — only the part recorded before the storage filled up' : '') + '.',
            { kind: 'take-finish', resume: function () { attemptTakeSave(); } });
          renderTracks();
          updateTransport();
          return;
        }
        var takeRecord = {
          id: takeId,
          sessionId: state.session.id,
          track: track,
          takeNumber: takeNumber,
          rawWav: rawWav,
          alignedWav: alignedWav,
          metadata: metadata,
          recordedAt: metadata.recordedAt
        };
        PS.db.saveTake(takeRecord).then(completeTakeSave).catch(function (err) {
          console.warn('Take save failed:', err);
          // v17 (QUEUE #10): hold the take in memory and offer the
          // retry — the blobs are the only full copy (the chunks hold
          // it up to the last full second). Do NOT delete the orphan
          // chunks here: they are the boot recovery the message names.
          showSaveFailedError('The take recorded but could not be saved — the phone may be out of space for this site. Tap "Try saving again" to save it now, or close the app and reopen it — your take is kept as a recovery' + (chunkWriteFailed ? ' — only the part recorded before the storage filled up' : '') + '.',
            { kind: 'take', record: takeRecord, onSaved: completeTakeSave });
          renderTracks();
          updateTransport();
        });
      }
      function completeTakeSave() {
        vocal.takes.push(takeMeta);
        vocal.activeTakeId = takeId;
        saveSessions();
        // The take is saved — its chunks + recovery record have done their job.
        PS.db.deleteTakeChunks(takeId).catch(function () { /* ignore */ });
        PS.db.deleteTakeRecovery(takeId).catch(function () { /* ignore */ });
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
        // write one plain-words line about it. Playback already
        // started, so this runs after it and never blocks the screen.
        runTakeAnalysis(takeMeta, metadata, alignedSamples, sr, track, takeId, rawWav, alignedWav);
        if (metadata.unfinished) {
          showError('Saved raw — something went wrong finishing the take, so it was saved untrimmed and unchecked. It is in the list below; re-trim it or record it again if it sounds off.');
        } else if (rec.interruptedReason === 'mic-disconnected') {
          // v35 (QUEUE #32): the mic died mid-take — said first,
          // before the silent-take branch, because a take cut by a
          // dead mic has no sound at the end for exactly this reason.
          showError('The mic disconnected — your take was saved up to the disconnect.');
        } else if (rec.interruptedReason === 'audio-interrupted') {
          // v41 (QUEUE #42): the audio flow stalled mid-take — the
          // phone took the audio (Siri, an alarm, a route change).
          // Said before the silent-take branch for the same reason
          // as the mic branch: a take cut by a stall ends in
          // nothing, and that nothing is the stall's fault.
          showError('The audio cut out — your take was saved up to where it stopped. Record it again to get the rest.');
        } else if (silentTake) {
          // v25 (QUEUE #70): saved, flagged, never dropped — the
          // v21 rule. The take stays in the list with its "No sound"
          // row bit; the message says what to do next.
          showError('That take has no sound in it — the mic heard nothing. Check the mic and record it again.');
        } else if (chunkWriteFailed) {
          // v25 (QUEUE #82): the take itself saved whole from
          // memory — only the safety copy is partial. Said once,
          // here, so a later storage failure at save time is not
          // blamed on a take that already landed.
          // v37 (QUEUE #23): same combined pattern as muffled — the
          // clip note appends, it never shadows this warning (the
          // v37 clip branch sat ahead of it and hid it — v148).
          // v42 (QUEUE #121): storage leads the soft warnings now —
          // it is the harder failure (the safety copy is partial
          // and the next take hits the same full disk), so it must
          // never be shadowed. The muffled + drift + clip notes
          // append instead of hiding: a take tripping both storage
          // and muffled says both.
          showError('Saved — but the phone ran out of space while recording, so the safety copy of this take is incomplete. The take itself saved from memory; free some space before the next take.' + (takeAnalysis.narrowbandWarn ? ' It also sounds muffled — your Bluetooth mic dropped to phone-call mode; switch to the phone mic or wired headphones for the lead vocal.' : '') + (drifted ? ' The timing may also have drifted since you measured these headphones — measure them again before the next take.' : '') + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
        } else if (takeAnalysis.narrowbandWarn) {
          showError('That take sounds muffled — your Bluetooth mic dropped to phone-call mode and crushed the high end. Switch to the phone mic or wired headphones for the lead vocal, then record it again.' + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
        } else if (drifted) {
          // v37 (QUEUE #23): the drift note stays first when the take also
          // clipped — the clip rides along, it never replaces the message.
          showError('The timing may have drifted since you measured these headphones — measure them again before the next take.' + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
        } else if (takeAnalysis.clipped) {
          // v37 (QUEUE #23): clipped, nothing else to say — said plainly, never gated.
          // Moved after drifted/storage: those warnings must not be shadowed.
          showError('That take clipped — the loudest peaks hit the limit. Back off the mic a little and record it again.');
        }
      }
      attemptTakeSave();
    });
  }

  /* Step 3 — listen to a finished take once, in slices, and write
   * one plain-words line about it ("Sings around A3 — most of the
   * notes fit D minor"). Runs after playback started, never blocks
   * the screen, never touches the recorded file — this only
   * listens. Shared by finishTake and finishLoopTake (one call per
   * pass).
   */
  function runTakeAnalysis(takeMeta, metadata, alignedSamples, sr, track, takeId, rawWav, alignedWav) {
    if (!PS.retune) return;
    setTimeout(function () {
      try {
        // v22 (QUEUE #49): the verdict is graded against the
        // TAKE's own frozen key — never live session state, which
        // a key-pill tap in the analysis window could have moved.
        PS.retune.analyzeChunked(alignedSamples, sr, (metadata && metadata.key) || (takeMeta && takeMeta.key) || state.session.key, function (summary) {
          takeMeta.analysis = summary;
          metadata.analysis = summary;
          saveSessions();
          // The stored record keeps the same summary, so the line
          // survives a reload. v19 (QUEUE #25): merged into the
          // CURRENT stored record (read-then-write, the same pattern
          // as persistNotesToDb) — the old code re-saved the stale
          // metadata object from finish time, which would erase a
          // sent stamp (or a note) added after the take saved but
          // before the analysis finished.
          PS.db.getTake(takeId).then(function (record) {
            if (!record) return;
            record.metadata = record.metadata || {};
            record.metadata.analysis = summary;
            return PS.db.saveTake(record);
          }).catch(function () { /* the line still shows this session */ });
          renderSheet();
        });
      } catch (e) {
        // Analysis never breaks the take — it just stays without
        // its one-line summary.
      }
    }, 0);
  }

  /* Step 6C (v13.3) — finishes a loop take: the one capture is cut
   * into one take per pass through the loop. Each pass is a real
   * take (its own number, its own sound, its own place in the
   * song) — the best line is never lost because the next pass
   * overwrote it. The capture is aligned by the same lead-in +
   * delay trim as a normal take, so pass 0 starts where the loop
   * region starts; each pass then gets its own residual check
   * against the loop's slice of the beat. A pass shorter than
   * 0.3 s (stopped mid-pass, or a tap) is dropped.
   * The chunks belong to the whole recording (keyed by the takeId
   * fixed at record start), so they are deleted once, after every
   * pass is saved — not per pass. A loop take killed mid-record
   * recovers as ONE take (recoverOrphan does not know about
   * passes) — that is a known limit, recorded in BUILD-v13.3.md.
   */
  function finishLoopTake(rec, result, sr, chunkCount) {
    var track = rec.track;
    var loop = rec.loop;
    var loopLenSamples = Math.round((loop.end - loop.start) * sr);

    // Narrowband check (Step 1B) — once, on the whole capture:
    // every pass shares the same mic.
    // v21 (QUEUE #19): the head used to run before the promise
    // chain was built, so a throw here sat outside the chain's
    // catch and dropped the whole capture silently. A failed
    // analysis now flags every pass unfinished (check fields null)
    // instead — the trim never depended on the analysis, so the
    // passes still save.
    var finishError = null;
    var takeAnalysis;
    try {
      takeAnalysis = PS.routelab.analyzeTake(result.samples, sr);
    } catch (e) {
      finishError = e;
      takeAnalysis = { narrowbandWarn: false, fractionAbove7k5: null, bandwidthHz: null, rmsDb: null, peakDbfs: null, clippedSamples: null, clipped: false };
    }
    // v25 (QUEUE #70): no sound in the whole capture — every pass
    // shares the mic, so every pass carries the flag. (QUEUE #82):
    // a chunk write failed mid-take — the passes are whole (from
    // memory) but the safety copy is partial.
    var silentTake = takeIsSilent(takeAnalysis);
    var chunkWriteFailed = !!(rec.chunkState && rec.chunkState.writeFailed);

    // Compensation — the same math as finishTake. After the base
    // trim, sample 0 is the moment the loop region starts at the
    // mic, so pass k is [k * loopLen, (k + 1) * loopLen).
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
      delaySamples = Math.round(PS.audio.nominalLatency() * sr);
      compensationSource = 'session-nominal-fallback';
      calibrated = false;
    } else {
      delaySamples = Math.round(PS.audio.nominalLatency() * sr);
      compensationSource = 'session-nominal';
      calibrated = true;
    }
    var baseTrimSamples = result.preCompActive ? leadInSamples : leadInSamples + delaySamples;
    var aligned = result.samples.subarray(Math.min(baseTrimSamples, result.samples.length));
    var beatSlice = null;
    if (state.beat && state.beat.mono) {
      beatSlice = state.beat.mono.subarray(
        Math.round(loop.start * sr),
        Math.min(state.beat.mono.length, Math.round(loop.end * sr))
      );
    }
    var passes = [];
    for (var k = 0; ; k++) {
      var passStart = k * loopLenSamples;
      if (passStart >= aligned.length) break;
      var passEnd = Math.min(passStart + loopLenSamples, aligned.length);
      if (passEnd - passStart < Math.round(0.3 * sr)) break;
      passes.push({ index: k, samples: aligned.subarray(passStart, passEnd) });
    }
    if (!passes.length) {
      if (rec.takeId) PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
      if (rec.takeId) PS.db.deleteTakeRecovery(rec.takeId).catch(function () { /* ignore */ });
      showError('Too short to save — tap record and sing a little longer.');
      renderTracks();
      updateTransport();
      return;
    }

    var vocal = state.session.tracks[track];
    var baseNumber = vocal.takes.length + 1;
    var outputLatencyNow = PS.audio.outputLatency();
    var calibrationOutputLatency = active && typeof active.calibration.outputLatencySeconds === 'number'
      ? active.calibration.outputLatencySeconds : null;
    var drifted = PS.safety.outputLatencyDrifted(calibrationOutputLatency, outputLatencyNow);
    var micSettings = PS.audio.micSettings();
    var saved = [];
    var failedPass = -1; // v17 (QUEUE #10): the pass whose save broke the chain
    // v17 (QUEUE #10): the pass chain is one function, so a failed
    // pass can be retried together with the passes after it — the
    // passes saved so far stay saved, the rest re-run.
    function runLoopFrom(startIdx) {
      var chain = Promise.resolve();
      for (var i = startIdx; i < passes.length; i++) {
        (function (idx) {
          chain = chain.then(function () { return saveLoopPass(passes[idx], idx); });
        })(i);
      }
      chain.then(finishLoopSaved).catch(function (err) {
        console.warn('Loop pass save failed:', err);
        // The chunks belong to the whole recording and are NOT
        // deleted here — they are the boot recovery the message names.
        showSaveFailedError('The passes recorded but could not be saved — the phone may be out of space for this site. Tap "Try saving again" to save the rest, or close the app and reopen it — your take is kept as a recovery' + (chunkWriteFailed ? ' — only the part recorded before the storage filled up' : '') + '.',
          { kind: 'loop-pass', resume: function () { runLoopFrom(failedPass < 0 ? 0 : failedPass); } });
        renderTracks();
        updateTransport();
      });
    }
    function finishLoopSaved() {
      vocal.activeTakeId = saved.length ? saved[saved.length - 1].id : vocal.activeTakeId;
      saveSessions();
      // The passes are saved — the chunks + recovery record have done their job.
      PS.db.deleteTakeChunks(rec.takeId).catch(function () { /* ignore */ });
      PS.db.deleteTakeRecovery(rec.takeId).catch(function () { /* ignore */ });
      maybeCloseMic(); // review plays at full quality once the mic is closed
      renderTracks();
      renderSheet();
      updateTransport();
      // Step 3B — play the last pass back tuned at once, so he
      // hears the finished sound without tapping Play.
      var last = saved[saved.length - 1];
      if (last && last.durationSeconds >= 2) playTake(last.id);
      if (finishError) {
        showError('Saved without its finish check — something went wrong checking the loop take, so the passes were saved unchecked. They are in the list below; record them again if they sound off.');
      } else if (rec.interruptedReason === 'mic-disconnected') {
        // v35 (QUEUE #32): the mic died mid-loop — the passes
        // saved are the ones sung before the disconnect.
        showError('The mic disconnected — your take was saved up to the disconnect.');
      } else if (rec.interruptedReason === 'audio-interrupted') {
        // v41 (QUEUE #42): the audio flow stalled mid-loop — the
        // passes saved are the ones sung before the stall.
        showError('The audio cut out — your take was saved up to where it stopped. Record it again to get the rest.');
      } else if (silentTake) {
        // v25 (QUEUE #70): the passes saved, flagged, never
        // dropped — same as a plain silent take.
        showError('That take has no sound in it — the mic heard nothing. Check the mic and record it again.');
      } else if (chunkWriteFailed) {
        // v25 (QUEUE #82): the passes saved whole from memory —
        // only the safety copy is partial.
        // v37 (QUEUE #23): same combined pattern as muffled — the
        // clip note appends, it never shadows this warning.
        // v42 (QUEUE #121): storage leads the soft warnings now —
        // same reorder as finishTake: the harder failure first,
        // muffled + drift + clip append instead of hiding.
        showError('Saved — but the phone ran out of space while recording, so the safety copy of this take is incomplete. The passes themselves saved from memory; free some space before the next take.' + (takeAnalysis.narrowbandWarn ? ' It also sounds muffled — your Bluetooth mic dropped to phone-call mode; switch to the phone mic or wired headphones for the lead vocal.' : '') + (drifted ? ' The timing may also have drifted since you measured these headphones — measure them again before the next take.' : '') + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
      } else if (takeAnalysis.narrowbandWarn) {
        showError('That take sounds muffled — your Bluetooth mic dropped to phone-call mode and crushed the high end. Switch to the phone mic or wired headphones for the lead vocal, then record it again.' + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
      } else if (drifted) {
        // v37 (QUEUE #23): the drift note stays first when the take also
        // clipped — the clip rides along, it never replaces the message.
        showError('The timing may have drifted since you measured these headphones — measure them again before the next take.' + (takeAnalysis.clipped ? ' It also clipped — the loudest peaks hit the limit, so back off the mic a little too.' : ''));
      } else if (takeAnalysis.clipped) {
        // v37 (QUEUE #23): clipped, nothing else to say — said plainly, never gated.
        // Moved after drifted/storage: those warnings must not be shadowed.
        showError('That take clipped — the loudest peaks hit the limit. Back off the mic a little and record it again.');
      }
    }
    runLoopFrom(0);

    function saveLoopPass(pass, i) {
      // Each pass gets its own residual check against the loop's
      // slice of the beat — the same check a normal take gets.
      var residual;
      if (beatSlice) {
        // v24 (QUEUE #53): same rate guard as finishTake — the slice
        // is cut from state.beat.mono, so a beat at the wrong rate
        // must refuse the check, never verify on mismatched arrays.
        if (state.beat && state.beat.sampleRate !== sr) {
          residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'unverified-rate-mismatch' };
        } else {
          residual = PS.residual.verify(pass.samples, beatSlice, 0, sr);
        }
      } else {
        residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
      }
      var trimSamples = Math.max(0, Math.min(residual.trimSamples, pass.samples.length - Math.round(0.3 * sr)));
      var alignedSamples = pass.samples.subarray(trimSamples);
      var takeNumber = baseNumber + i;
      var takeId = PS.store.newId();
      var baseName = takeFileBase(state.session.name, track, takeNumber, takeId);
      var durationSeconds = alignedSamples.length / sr;
      var metadata = {
        trackKind: track,
        rawFileName: baseName + '-raw.wav',
        alignedFileName: baseName + '.wav',
        sampleRate: sr,
        // v13.8-light: which beat this take was sung over — the
        // server render matches on this, never guesses. Nulls when
        // there was no beat (or no fingerprint yet).
        // v22 (QUEUE #45/#46): stamped from the freeze at record
        // start (rec.*), never from live session state.
        beatFileName: rec.beatFileName,
        beatSha256: rec.beatSha256,
        beatOriginalName: rec.beatOriginalName,
        beatless: !!rec.beatless,
        // v20 (QUEUE #41): the beat's tempo travels with the take —
        // the server renders the echo on this grid, never the
        // hardcoded 135. Nulls when there was no beat (or no tempo
        // detected yet); beatBpmAlt is the half/double partner.
        beatBpm: rec.beatBpm,
        beatBpmAlt: rec.beatBpmAlt,
        // v24 (QUEUE #53): the beat's rate at record start.
        beatSampleRate: rec.beatSampleRate,
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
        // v21 (QUEUE #19): the loop head's analysis failed — this
        // pass was saved without its tune/timing check (fields
        // null); the trim itself never depended on the analysis.
        unfinished: !!finishError,
        finishError: finishError ? String(finishError && finishError.message || finishError) : null,
        calibrationDeviceUID: null,
        calibrationLabel: active ? active.label : null,
        calibrationDeviceName: active ? active.label : null,
        calibrationDate: active ? active.calibration.date : null,
        calibrated: calibrated,
        compensationSource: compensationSource,
        interrupted: !!rec.interrupted,
        // v41 (QUEUE #42): why the recording ended early — the
        // reason is per-recording, so every pass carries it. (No
        // wallDurationSeconds here: the wall belongs to the whole
        // loop recording, not to one pass — a pass's wall would
        // always exceed its samples by the other passes.)
        interruptedReason: rec.interruptedReason || null,
        // The chunks belong to the whole loop recording, not to
        // one pass — the count is the recording's, and a pass is
        // complete in memory, so it is saved up to its full length.
        chunkCount: chunkCount,
        savedUpToSeconds: durationSeconds,
        micSettings: micSettings,
        echoCancellationOff: micSettings ? micSettings.echoCancellation === false : null,
        micProcessed: PS.audio.micProcessed(),
        micLabel: PS.audio.micLabel(),
        narrowbandWarn: takeAnalysis.narrowbandWarn,
        narrowbandFractionAbove7k5: takeAnalysis.fractionAbove7k5,
        takeBandwidthHz: takeAnalysis.bandwidthHz,
        takeRmsDb: takeAnalysis.rmsDb,
        // v37 (QUEUE #23): clipping at capture — one analysis for the whole capture, every pass shares the mic.
        takePeakDbfs: takeAnalysis.peakDbfs,
        takeClippedSamples: takeAnalysis.clippedSamples,
        clipped: takeAnalysis.clipped,
        // v25 (QUEUE #70): no sound in the capture. (QUEUE #82):
        // a chunk write failed mid-take — the safety copy is partial.
        silentTake: silentTake,
        chunkWriteFailed: chunkWriteFailed,
        outputLatencySeconds: outputLatencyNow,
        outputLatencyAtStartSeconds: rec.outputLatencyAtStart,
        calibrationOutputLatencySeconds: calibrationOutputLatency,
        outputLatencyDrift: drifted,
        recordedAt: new Date().toISOString(),
        appVersion: 'pwa-1.1',
        // v22 (QUEUE #48): stamped from the record-start freeze.
        preset: rec.preset,
        strength: rec.strength,
        speed: state.session.speed,
        key: rec.key,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        notes: [],
        // Step 6C (v13.3): this take is one pass through the loop
        // — it lives at the loop's start in the song.
        songOffsetSeconds: loop.start,
        loopPass: true,
        passIndex: pass.index,
        loopStart: loop.start,
        loopEnd: loop.end,
        comp: false
      };
      var rawWav = new Blob([PS.wav.encodeWavFloat32(pass.samples, sr)], { type: 'audio/wav' });
      var alignedWav = new Blob([PS.wav.encodeWavFloat32(alignedSamples, sr)], { type: 'audio/wav' });
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
        unfinished: !!finishError,
        partial: !!rec.interrupted,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: takeAnalysis.narrowbandWarn,
        // v37 (QUEUE #23): clipping — the row reads it from here.
        clipped: takeAnalysis.clipped,
        takePeakDbfs: takeAnalysis.peakDbfs,
        takeClippedSamples: takeAnalysis.clippedSamples,
        // v25 (QUEUE #70): no sound in the capture. (QUEUE #82):
        // a chunk write failed mid-take — the safety copy is partial.
        silentTake: silentTake,
        chunkWriteFailed: chunkWriteFailed,
        micProcessed: metadata.micProcessed,
        micLabel: metadata.micLabel,
        outputLatencyDrift: drifted,
        // v22 (QUEUE #48): stamped from the record-start freeze.
        // v28 (QUEUE #66): the frozen beat identity rides on the
        // list entry too (loop pass — same freeze as a plain take).
        preset: rec.preset,
        strength: rec.strength,
        speed: state.session.speed,
        key: rec.key,
        beatFileName: rec.beatFileName,
        beatOriginalName: rec.beatOriginalName,
        beatless: !!rec.beatless,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        notes: [],
        songOffsetSeconds: loop.start,
        loopPass: true,
        passIndex: pass.index,
        comp: false
      };
      // v17 (QUEUE #10): remember which pass this is before the
      // save — if the chain breaks here, the retry resumes from
      // this pass, not from the start.
      failedPass = i;
      return PS.db.saveTake({
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
        saved.push(takeMeta);
        saveSessions();
        runTakeAnalysis(takeMeta, metadata, alignedSamples, sr, track, takeId, rawWav, alignedWav);
      });
    }
  }

  // ---------------------------------------------------------------- playback

  /* Plays one take against the beat from the PLAYHEAD position.
   * The engine's playTake always starts its buffers at 0, so this
   * slices both buffers from the playhead offset first (stereo kept:
   * the slice is built channel by channel at the buffer's own
   * sample rate). If the playhead is past the take, playback starts
   * from 0 instead.
   */
  function sliceBuffer(buffer, startSeconds, endSeconds) {
    var sr = buffer.sampleRate;
    var startSample = Math.min(Math.floor(startSeconds * sr), buffer.length);
    // v29: an optional end — a trimmed take plays [trimStart,
    // trimEnd], not [trimStart, end-of-buffer]. Old callers pass
    // two args and still get start-to-end.
    var endSample = (endSeconds === undefined || endSeconds === null) ? buffer.length : Math.min(Math.floor(endSeconds * sr), buffer.length);
    var len = endSample - startSample;
    if (len <= 0) return null;
    // B10 (v13.1): the slice is built on the engine's own context
    // — the old code created a scratch AudioContext here and never
    // closed it (iOS caps live contexts, and a leaked one counts).
    var out = PS.audio.createBuffer(buffer.numberOfChannels, len, sr);
    for (var ch = 0; ch < buffer.numberOfChannels; ch++) {
      out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startSample, endSample));
    }
    return out;
  }

  /* Step 3 — the sound a take plays back with: the take's own
   * preset/strength/key, stamped when it was recorded. A take saved
   * before v12 has none of these stored (preset null, strength
   * null, key null) and falls back to the song's current sound —
   * the song's sound is what he heard when he recorded it.
   * v13 — speed is always Auto (null): the Speed knob is gone, so
   * a take's stamped speed from v12 is ignored, never played.
   */
  function takeSound(take) {
    if (!take) {
      return {
        preset: state.session.preset,
        strength: state.session.strength,
        speed: null,
        key: state.session.key,
        // Step 4A (v13.4): the take's studio sound — its macros
        // and its chain switch. A take without them (saved before
        // v13.4) falls back to the song's current sound.
        // Step 4B (v13.5): the same for its bypasses + fine tone.
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone()
      };
    }
    return {
      preset: take.preset || state.session.preset,
      strength: typeof take.strength === 'number' ? take.strength : state.session.strength,
      speed: null,
      key: take.key || state.session.key,
      macros: take.macros ? clampMacros(take.macros) : copySessionMacros(),
      chainOn: typeof take.chainOn === 'boolean' ? take.chainOn : state.session.chainOn,
      bypass: take.bypass ? clampBypass(take.bypass) : copySessionBypass(),
      tone: take.tone ? clampTone(take.tone) : copySessionTone()
    };
  }

  function findTake(takeId) {
    var found = null;
    trackKinds().forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      if (!vocal || found) return;
      var t = vocal.takes.find(function (x) { return x.id === takeId; });
      if (t) found = t;
    });
    return found;
  }

  /* v40 (QUEUE #124): which layer a take belongs to — the take
   * plays through that layer's gain. Falls back to the selected
   * layer (a take is always found in practice; the fallback only
   * keeps a stale id from playing silent).
   */
  function takeKindOf(takeId) {
    var found = null;
    trackKinds().forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      if (!vocal || found) return;
      if (vocal.takes.some(function (x) { return x.id === takeId; })) found = kind;
    });
    return found || state.selectedTrack;
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
        var take = findTake(takeId);
        // Step 6C (v13.3): a pass or a best-of take lives at its
        // place in the song, not at 0. The playhead is song time —
        // the take only starts when the playhead reaches it, and
        // the beat plays from the playhead either way.
        // v29: a trimmed block plays its audible window only
        // ([trimStart, trimEnd]), not the full take. Slice to the
        // window first; the playhead offset then applies inside
        // that window.
        var songOffset = take ? (take.songOffsetSeconds || 0) : 0;
        var trimStart = take ? takeTrimStart(take) : 0;
        var trimEnd = take ? takeTrimEnd(take) : takeBuffer.duration;
        var audible = Math.max(0, trimEnd - trimStart);
        var offset = state.playheadSeconds;
        var takeDelay = 0;
        var playTakeBuffer = sliceBuffer(takeBuffer, trimStart, trimEnd);
        // The window is never empty (a trim stops at 0.25s) — but
        // if the slice ever fails, play the whole take rather than
        // playing nothing.
        if (!playTakeBuffer) playTakeBuffer = takeBuffer;
        var playBeatBuffer = state.beat ? state.beat.buffer : null;
        var takeOffset = Math.max(0, offset - songOffset);
        if (takeOffset > 0.05) {
          if (takeOffset >= audible - 0.5) {
            // At (or nearly at) the end of the take — start the
            // take from its beginning, and the playhead jumps to
            // the take's place in the song.
            offset = songOffset;
            takeOffset = 0;
            setPlayhead(songOffset);
          } else {
            if (playTakeBuffer) playTakeBuffer = sliceBuffer(playTakeBuffer, takeOffset);
            if (playBeatBuffer) {
              playBeatBuffer = offset >= playBeatBuffer.duration
                ? null : sliceBuffer(playBeatBuffer, offset);
            }
          }
        } else if (offset < songOffset) {
          // The playhead has not reached the take yet — the beat
          // plays from the playhead and the take joins in late.
          takeDelay = songOffset - offset;
          if (playBeatBuffer) {
            playBeatBuffer = offset >= playBeatBuffer.duration
              ? null : sliceBuffer(playBeatBuffer, offset);
          }
        }
        state.playingStartOffset = offset;
        // Step 3 — this take plays with ITS sound, not the song's
        // current one.
        var sound = takeSound(take);
        return playTakeTuned(playTakeBuffer, playBeatBuffer, function () {
          state.playingStop = null;
          state.playingTakeId = null;
          clearPlayheadTimer();
          renderTracks();
          renderSheet();
          updateTransport();
        }, sound, takeDelay, takeKindOf(takeId)).then(function (stopFn) {
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
    if (state.beat) {
      playBeatOnly();
      return;
    }
    // v39 (QUEUE #123): on a cold first start the beat is still
    // loading and there is no take yet — the old code did nothing
    // here, silently, and updateTransport had the button disabled
    // anyway, so the first Play tap of the day read as a broken app.
    // If a beat load is in flight, Play waits for it and then plays
    // the beat; if there is truly no beat, Play says so in plain
    // words instead of a dead tap.
    if (state.beatLoading || (state.beatLoadPromise && state.session && state.session.beatFileName)) {
      waitForBeatThenPlay();
      return;
    }
    showError('This song has no beat yet — import a beat, or record a take first.');
  }

  /* v39 (QUEUE #123): one Play tap waits for the in-flight beat load,
   * then plays the beat from the playhead. The wait is capped (10 s)
   * so a hung load becomes a plain-words message, never a stuck
   * button; the song/beat guards swallow the wait if he switched
   * songs or removed the beat mid-wait. One waiter only — a second
   * tap while waiting is ignored (the button disables while waiting).
   */
  function waitForBeatThenPlay() {
    if (state.playWaiting) return;
    state.playWaiting = true;
    updateTransport();
    var sessionId = state.session ? state.session.id : null;
    var beatFileName = state.session ? state.session.beatFileName : null;
    var load = state.beatLoadPromise || Promise.resolve();
    var cap = new Promise(function (resolve) { setTimeout(resolve, 10000); });
    Promise.race([Promise.resolve(load).catch(function () { /* a failed load is a message, not a throw */ }), cap]).then(function () {
      state.playWaiting = false;
      updateTransport();
      // Switched songs or removed the beat mid-wait — say nothing,
      // the new song's own state is the truth now.
      if (!state.session || state.session.id !== sessionId ||
          state.session.beatFileName !== beatFileName) {
        return;
      }
      if (state.beat) {
        playBeatOnly();
      } else if (state.beatLoading) {
        showError('The beat is still loading — try Play again in a moment.');
      } else {
        showError('The beat could not be loaded. Import it again.');
      }
    });
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
      // v13 FIX (the double-play bug): the old code started a player,
      // checked the generation, then started a SECOND player at the
      // same anchor — the beat played doubled, and Stop only killed
      // the second one, so the first played on with no stop. Now:
      // the generation check runs BEFORE any player starts, and
      // exactly one player is ever created.
      if (gen !== state.playGen) return;
      var anchor = ctx.currentTime + 0.1;
      var player = ctx.createBufferSource();
      player.buffer = beatBuffer;
      // v40 (QUEUE #124): the beat alone plays through the beat's
      // layer gain — the beat lane's + / − moves it.
      player.connect(PS.audio.layerGainFor('beat') || PS.audio.outputNode() || ctx.destination);
      player.start(anchor);
      state.playingStartCtx = anchor;
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

  /* v13.7 — the smaller copy. A 103.8 s take as a 32-bit float WAV
   * is ~20 MB per file, and the share timed out 3 times trying to
   * send it ("unable to upload file"). The smaller copy is the same
   * lined-up take, shorter in the file, not in the song: 16-bit
   * samples at 22,050 Hz — 103.8 s is ~4.6 MB, under the 5 MB the
   * share handles easily. The rate keeps everything up to 11 kHz;
   * his takes carry nothing above ~7.5 kHz (the mic is the
   * phone-call one), so nothing he actually sang is lost — and the
   * top end the small copy cannot carry is measured in the test,
   * not assumed. The full-quality copy stays: the choice is his,
   * every time, and the small copy is never sent instead of the
   * full one without him tapping it.
   *
   * The take is filtered before it is resampled: the renderer's
   * own rate change folds anything above the new top end back down
   * as a phantom tone (a 12 kHz tone came back at 10,050 Hz at
   * 0.81× with no filter — measured in the cdp-v137 harness), so
   * the 10th-order Butterworth at 8,500 Hz runs first (8 kHz
   * passes at ~0.88×, 12 kHz is down to ~0.03×). The filter is
   * plain JS (PS.retune.lowpassButterworth), not a BiquadFilterNode
   * — the node was measured not to match its own cookbook in this
   * Chromium (see retune.js). The rate change itself is the
   * browser's resampler (OfflineAudioContext), so there is no new
   * library and nothing downloaded. If this browser cannot render
   * offline, the small copy says so plainly and the full-quality
   * button still works.
   */
  var SMALL_COPY_SAMPLE_RATE = 22050;
  var SMALL_COPY_BITS = 16;
  var SMALL_COPY_CUTOFF_HZ = 8500;
  var SMALL_COPY_FILTER_ORDER = 10;

  /* v18 (QUEUE #20): a take's filenames are unique per take — song
   * name + track + take number + the first 8 chars of the take id.
   * Before this, every song named its takes take-1/take-2, so the
   * second song's take-2 overwrote the first in the Drive inbox
   * (same name, flat folder) and the server then rendered the wrong
   * take — and the take-sha dedupe refused the right take as a
   * "duplicate". The small-copy name and the JSON name derive from
   * alignedFileName (smallCopyFileName + the .wav -> .json replace
   * in sendSmallCopy/shareTake), so they follow automatically.
   * Same sanitize as the bulk-export path, and the song part is
   * capped at 40 chars so a long song name can't push the name
   * past Drive's limits. */
  function takeFileBase(sessionName, track, takeNumber, takeId) {
    var song = String(sessionName || 'song').slice(0, 40);
    var idPart = String(takeId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'notake';
    return (song + '-' + String(track || 'lead') + '-take' + takeNumber + '-' + idPart)
      .replace(/[^A-Za-z0-9._-]+/g, '-');
  }
  PS.takeFileBase = takeFileBase; // v18: exposed for the CDP tests

  function smallCopyFileName(alignedFileName) {
    return String(alignedFileName || 'take.wav').replace(/\.wav$/i, '-small.wav');
  }

  /* A WAV Blob in, a small WAV Blob out. Returns a promise of
   * { blob, fileName, sampleRate, bitsPerSample, durationSeconds,
   * sizeBytes }. Waits for the heavy modules (v13.8 loads retune.js
   * after first paint) instead of failing when the Send sheet opens
   * fast; throws when the file cannot be read, the filter fails to
   * load, or this browser cannot render offline.
   */
  function makeSmallCopy(wavBlob, alignedFileName) {
    if (!wavBlob) return Promise.reject(new Error('No take to copy.'));
    if (typeof OfflineAudioContext === 'undefined') {
      return Promise.reject(new Error('This browser cannot make the smaller copy.'));
    }
    // v13.8-light: retune.js loads after first paint — wait for the
    // heavy modules instead of failing when the Send sheet opens fast.
    return loadHeavyModules().then(function () {
      if (!PS.retune || !PS.retune.lowpassButterworth) {
        throw new Error('This browser cannot make the smaller copy.');
      }
      return wavBlob.arrayBuffer().then(function (buf) {
        var decoded = PS.wav.decodeWavFloat32(buf);
        if (!decoded || !decoded.samples || decoded.samples.length === 0) {
          throw new Error('That take could not be read.');
        }
        // The anti-alias filter, in plain JS at the take's own rate —
        // anything above the new top end is filtered, not folded back.
        PS.retune.lowpassButterworth(decoded.samples, decoded.sampleRate,
          SMALL_COPY_CUTOFF_HZ, SMALL_COPY_FILTER_ORDER);
        // The rate change, on the already-filtered take.
        var target = SMALL_COPY_SAMPLE_RATE;
        var outLen = Math.max(1, Math.round(decoded.samples.length * target / decoded.sampleRate));
        var off = new OfflineAudioContext(1, outLen, target);
        var srcBuf = off.createBuffer(1, decoded.samples.length, decoded.sampleRate);
        srcBuf.getChannelData(0).set(decoded.samples);
        var src = off.createBufferSource();
        src.buffer = srcBuf;
        src.connect(off.destination);
        src.start(0);
        return off.startRendering();
      }).then(function (rendered) {
        var samples = rendered.getChannelData(0);
        var bytes = PS.wav.encodeWav16(samples, SMALL_COPY_SAMPLE_RATE);
        var blob = new Blob([bytes], { type: 'audio/wav' });
        return {
          blob: blob,
          fileName: smallCopyFileName(alignedFileName),
          sampleRate: SMALL_COPY_SAMPLE_RATE,
          bitsPerSample: SMALL_COPY_BITS,
          durationSeconds: samples.length / SMALL_COPY_SAMPLE_RATE,
          sizeBytes: blob.size
        };
      });
    });
  }
  PS.makeSmallCopy = makeSmallCopy; // v13.7: exposed for the CDP tests
  PS.smallCopyFileName = smallCopyFileName; // v13.7: exposed for the CDP tests

  /* The send choice sheet: one tap picks the smaller copy or the
   * full quality. It opens over the take sheet (the key sheet is
   * the only other sheet that layers this way) and over the sound
   * panel from the transport arrow — one sheet at a time, so the
   * panel closes with it.
   */
  var pendingSendTakeId = null;

  function openSendSheet(takeId) {
    clearError();
    pendingSendTakeId = takeId;
    closeFxPanel();
    var status = $('send-status');
    if (status) status.textContent = '';
    setSendButtonsEnabled(true);
    $('send-sheet').style.display = 'flex';
  }

  function closeSendSheet() {
    pendingSendTakeId = null;
    $('send-sheet').style.display = 'none';
  }

  function setSendButtonsEnabled(enabled) {
    var small = $('send-small');
    var full = $('send-full');
    if (small) small.disabled = !enabled;
    if (full) full.disabled = !enabled;
  }

  /* The smaller copy: make it, then share it with its details file.
   * The details file is the take's own metadata plus one extra line
   * naming the small file, so the studio knows exactly what it is.
   * The raw recording stays full-quality-only — it is the safety
   * copy, and the small send is the lined-up take.
   */
  function sendSmallCopy(takeId) {
    clearError();
    var status = $('send-status');
    if (status) status.textContent = 'Making the smaller copy…';
    setSendButtonsEnabled(false);
    PS.db.getTake(takeId).then(function (record) {
      if (!record) throw new Error('That take could not be found.');
      return makeSmallCopy(record.alignedWav, record.metadata.alignedFileName).then(function (small) {
        var meta = {};
        Object.keys(record.metadata || {}).forEach(function (k) { meta[k] = record.metadata[k]; });
        meta.smallCopy = { fileName: small.fileName, sampleRate: small.sampleRate, bitsPerSample: small.bitsPerSample };
        var metaJson = JSON.stringify(meta, null, 2);
        var metaName = record.metadata.alignedFileName.replace(/\.wav$/i, '.json');
        var files = [
          new File([small.blob], small.fileName, { type: 'audio/wav' }),
          new File([metaJson], metaName, { type: 'application/json' })
        ];
        if (navigator.canShare && navigator.canShare({ files: files })) {
          return navigator.share({ files: files, title: 'Phone Studio take' }).then(function () {
            closeSendSheet();
            // v19 (QUEUE #25): the share sheet resolving is the only
            // proof the files left the app — mark the take sent.
            stampSentTake(takeId, 'small');
          }).catch(function (err) {
            if (err && err.name === 'AbortError') {
              setSendButtonsEnabled(true);
              if (status) status.textContent = '';
              return;
            }
            throw err;
          });
        }
        // No share sheet — download the small files instead.
        downloadBlob(small.blob, small.fileName);
        downloadBlob(new Blob([metaJson], { type: 'application/json' }), metaName);
        closeSendSheet();
      });
    }).catch(function (err) {
      console.warn('Small copy failed:', err);
      if (status) status.textContent = 'The smaller copy could not be made — send the full one instead.';
      setSendButtonsEnabled(true);
    });
  }

  /* Full quality, from the send sheet: the sheet closes and the
   * take goes out exactly as before (lined-up take + raw + the
   * details file). Nothing in the full path changed in v13.7.
   */
  function sendFullQuality(takeId) {
    closeSendSheet();
    shareTake(takeId);
  }

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
      // B5 (v13.1): one take's send includes its untrimmed
      // recording too, when there is one — the raw is the safety
      // copy, and a send without it is a send that cannot be
      // re-lined-up later.
      if (record.rawWav) {
        files.push(new File([record.rawWav], record.metadata.rawFileName, { type: 'audio/wav' }));
      }
      if (navigator.canShare && navigator.canShare({ files: files })) {
        return navigator.share({ files: files, title: 'Phone Studio take' }).then(function () {
          // v19 (QUEUE #25): resolved means sent — mark it. An abort
          // never reaches here (it lands in the catch below, which
          // swallows it without stamping).
          stampSentTake(takeId, 'full');
        }).catch(function (err) {
          if (err && err.name !== 'AbortError') throw err;
        });
      }
      // No share sheet — download the files instead.
      downloadBlob(record.alignedWav, record.metadata.alignedFileName);
      if (record.rawWav) downloadBlob(record.rawWav, record.metadata.rawFileName);
      downloadBlob(new Blob([metaJson], { type: 'application/json' }), metaName);
    }).catch(function (err) {
      console.warn('Share failed:', err);
      showError('Sharing failed. Try again, or back up the take from Setup.');
    });
  }

  /* v19 (QUEUE #25) — a sent take is marked sent, so he can tell it
   * from one that never left the phone, and Setup can clear sent
   * takes later. The stamp is the share sheet RESOLVING: it closed
   * with the files handed over. An abort stamps nothing (the caller
   * never reaches here on abort); a download fallback stamps nothing
   * either — the files landed in the phone's Files, not in Drive,
   * and the backup path never stamps (a backup is not a send). The
   * stamp lives in two places: the stored record's metadata (the
   * IDB record is the truth — a reload or a boot reconcile reads it
   * back) and the take list entry (so the badge shows without a
   * reload, and saveSessions keeps it across one). A stamp failure
   * never reports the send as failed — the files already left; the
   * take just stays unstamped and can be sent again (a second stamp
   * overwrites, never duplicates).
   */
  /* v27 (QUEUE #64) — a sent take with nothing back after a day:
   * sent does NOT mean rendered (the #25 rule — never auto-delete
   * or auto-clear), so a stale send gets a plain-words warning +
   * a one-tap re-send instead of silence. The 24 h threshold is a
   * DEFAULT, not Denasse's word — he has not set a number. Re-send
   * reuses the per-take Send flow (openSendSheet); the server
   * dedupes by take-sha (#1), so sending twice is safe.
   */
  var STALE_SENT_MS = 24 * 60 * 60 * 1000;
  function isStaleSent(take) {
    if (!take || !take.sentAt) return false;
    var sentMs = new Date(take.sentAt).getTime();
    if (isNaN(sentMs)) return false;
    return (Date.now() - sentMs) > STALE_SENT_MS;
  }
  PS.isStaleSent = isStaleSent; // v27: exposed for the CDP tests
  PS.STALE_SENT_MS = STALE_SENT_MS; // v27: exposed for the CDP tests

  function stampSentTake(takeId, via) {
    var sentAt = new Date().toISOString();
    return PS.db.getTake(takeId).then(function (record) {
      if (!record) return;
      record.metadata = record.metadata || {};
      record.metadata.sentAt = sentAt;
      record.metadata.sentVia = via;
      return PS.db.saveTake(record).then(function () {
        var found = null;
        state.sessions.forEach(function (session) {
          Object.keys(session.tracks || {}).forEach(function (track) {
            (session.tracks[track].takes || []).forEach(function (t) {
              if (t.id === takeId) found = t;
            });
          });
        });
        if (found) {
          found.sentAt = sentAt;
          found.sentVia = via;
          saveSessions();
        }
        renderSheet();
      });
    }).catch(function (err) {
      console.warn('Sent stamp failed:', err);
    });
  }
  PS.stampSentTake = stampSentTake; // v19: exposed for the CDP tests

  function shareSelected() {
    var take = activeTakeOf(state.selectedTrack);
    if (!take) return;
    openSendSheet(take.id); // v13.7: the choice, not the big file straight away
  }

  /* One-tap backup (Step 1B): every take as one WAV, plus one JSON
   * with all the metadata, calibrations, and lab reports — through
   * the share sheet (no zip: iOS cannot open one from a share). If
   * the share sheet cannot take the files, each one downloads
   * instead.
   *
   * v13.2 (item 3) — backup health: the manifest now lists every
   * audio file with its size AND its SHA-256 fingerprint, so a
   * backup made today can be checked file by file later ("Check a
   * backup" in Setup, or PS.verifyBackup). A file whose size or
   * fingerprint no longer matches is named, not silently trusted.
   * The manifest cannot fingerprint itself — it is listed by name
   * only (bytes/sha256 null), and the check counts it present when
   * it was picked. When this browser cannot fingerprint files at
   * all (no crypto.subtle), the list carries sizes only and says so
   * plainly — the backup still goes through.
   */
  function backupAllTakes() {
    var status = $('backup-status');
    if (status) status.textContent = 'Gathering your takes…';
    var jobs = state.sessions.map(function (session) {
      return PS.db.getTakesBySession(session.id).then(function (takes) {
        return { session: session, takes: takes || [] };
      }).catch(function () { return { session: session, takes: [] }; });
    });
    // v33 (QUEUE #115): returns the status text so the CDP tests
    // can call it without the Setup button (the button is gone —
    // Setup has no controls). The button handler ignores the
    // return value; the promise resolves after share / download.
    return Promise.all(jobs).then(function (groups) {
      var files = [];
      var audioFiles = []; // every audio File, to fingerprint before the manifest is written
      var takeCount = 0;
      var noRawCount = 0; // B5 (v13.1): takes saved before raw files existed back up aligned-only — said plainly, not silently
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
          takeCount += 1;
          var safeName = (g.session.name + '-' + take.track + '-take' + take.takeNumber)
            .replace(/[^A-Za-z0-9._-]+/g, '-');
          var aligned = new File([take.alignedWav], safeName + '.wav', { type: 'audio/wav' });
          files.push(aligned);
          audioFiles.push(aligned);
          // v13 — the Raw button is gone from the take sheet, so
          // the untrimmed recording ships here instead: every take
          // backs up as TWO files (the lined-up take + the raw
          // recording). The raw file is never deleted — only its
          // button is gone.
          if (take.rawWav) {
            var raw = new File([take.rawWav], safeName + '-raw.wav', { type: 'audio/wav' });
            files.push(raw);
            audioFiles.push(raw);
          } else {
            noRawCount += 1;
          }
          entry.takes.push(take.metadata);
        });
        manifest.sessions.push(entry);
      });
      if (takeCount === 0) {
        if (status) status.textContent = 'No takes to back up yet.';
        return 'No takes to back up yet.';
      }
      var canHash = !!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest);
      var hashJobs = audioFiles.map(function (f) {
        if (!canHash) return Promise.resolve({ name: f.name, bytes: f.size, sha256: null });
        return f.arrayBuffer().then(function (buf) {
          return window.crypto.subtle.digest('SHA-256', buf);
        }).then(function (digest) {
          return { name: f.name, bytes: f.size, sha256: toHex(digest) };
        });
      });
      return Promise.all(hashJobs).then(function (fileList) {
        manifest.files = fileList.concat([
          { name: 'phone-studio-backup.json', bytes: null, sha256: null }
        ]);
        files.push(new File([JSON.stringify(manifest, null, 2)], 'phone-studio-backup.json', { type: 'application/json' }));
        if (status) status.textContent = 'Backing up ' + takeCount + ' take' + (takeCount === 1 ? '' : 's') + '…';
        // B5 (v13.1): say plainly when a take had no raw recording
        // to include — a backup that silently omits files is a
        // backup that lies.
        var rawNote = noRawCount
          ? ' ' + noRawCount + ' take' + (noRawCount === 1 ? '' : 's') + ' had no raw recording to include.'
          : '';
        var hashNote = canHash
          ? ' Every file is hashed in the backup list, so it can be checked later.'
          : ' The backup list has sizes only — this browser could not fingerprint the files.';
        if (navigator.canShare && navigator.canShare({ files: files })) {
          return navigator.share({ files: files, title: 'Phone Studio backup' }).then(function () {
            var text = 'Backed up ' + takeCount + ' take' + (takeCount === 1 ? '' : 's') + '.' + rawNote + hashNote;
            if (status) status.textContent = text;
            return text;
          }).catch(function (err) {
            if (err && err.name === 'AbortError') {
              if (status) status.textContent = '';
              return '';
            }
            throw err;
          });
        }
        // No share sheet — download the files one by one.
        files.forEach(function (f) { downloadBlob(f, f.name); });
        var dlText = 'Downloaded ' + files.length + ' files.' + rawNote + hashNote;
        if (status) status.textContent = dlText;
        return dlText;
      });
    }).catch(function (err) {
      console.warn('Backup failed:', err);
      if (status) status.textContent = '';
      showError('The backup could not be made. Try again.');
    });
  }
  PS.backupAllTakes = backupAllTakes; // v33: exposed for the CDP tests (the Setup backup button is gone; tests call it directly and await the status text)

  function toHex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  /* v13.8-light — fingerprint a beat's bytes (SHA-256 hex, or null
   * when the browser cannot hash). The beat file is fingerprinted
   * ONCE, at import / on the next load, and stored on the session;
   * every take saved after that stamps the fingerprint into its
   * metadata, so the server render can match a take to its beat
   * without guessing. A take saved with no beat, or before the
   * fingerprint existed, carries nulls — never a guess.
   */
  function hashBeatBytes(buf) {
    if (!window.crypto || !window.crypto.subtle || !window.crypto.subtle.digest) return Promise.resolve(null);
    return window.crypto.subtle.digest('SHA-256', buf).then(function (digest) {
      return toHex(digest);
    }).catch(function () { return null; });
  }

  /* v13.2 (item 3) — check a backup against its list. Pure: takes
   * the manifest object + an array of { name, size, sha256 } for
   * the files actually picked, and returns { ok, missing, changed }
   * — missing = listed but not picked; changed = same name, but
   * the size or the fingerprint no longer matches. Files that are
   * in the backup but not in the list are ignored (extra files are
   * fine). Entries with sha256 null are presence-only — that is
   * how the manifest itself is listed, since it cannot fingerprint
   * itself.
   */
  function verifyBackup(manifest, files) {
    var listed = (manifest && Array.isArray(manifest.files)) ? manifest.files : [];
    var byName = {};
    (files || []).forEach(function (f) { byName[f.name] = f; });
    var missing = [];
    var changed = [];
    listed.forEach(function (entry) {
      var found = byName[entry.name];
      if (!found) { missing.push(entry.name); return; }
      if (entry.sha256 === null || entry.sha256 === undefined) return; // presence-only (the manifest itself)
      if (found.size !== entry.bytes || found.sha256 !== entry.sha256) changed.push(entry.name);
    });
    return { ok: missing.length === 0 && changed.length === 0, missing: missing, changed: changed };
  }
  PS.verifyBackup = verifyBackup; // exposed for the "Check a backup" UI + the CDP tests
  PS.macrosToChain = macrosToChain; // Step 4A: the knob-to-stage mapping, for the CDP tests
  PS.toneToChain = toneToChain; // Step 4B: the fine-tone mapping, for the CDP tests
  PS.makeVocalChain = makeVocalChain; // Step 4B: build a chain in any context — the CDP tests render it offline through the real worklets
  PS.chainInfo = chainInfo; // Step 4A: the chain as the app wired it (stages in order, switches, latencies)
  PS.perfReport = function () { return window.PSPerf ? PSPerf.report() : null; }; // v13.8-light: probe readout
  PS.lightLive = function () { return state.session.lightLive !== false; }; // v13.8-light
  PS.setLightLive = setLightLive; // v13.8-light: flip live tune-only/full + re-park live chains
  PS.chainProbe = chainProbe; // Step 4A: the live node values of the playback/monitor chain
  PS.fxPanelState = function () { // Step 5: the panel as the app sees it — open, the song sound, each part on/off
    var slots = {};
    FX_MODULES.forEach(function (m) { slots[m.id] = fxModuleOn(m); });
    return {
      open: $('fx-panel').style.display !== 'none',
      preset: state.session.preset,
      strength: state.session.strength,
      key: state.session.key,
      chainOn: state.session.chainOn,
      slots: slots,
      bypass: copySessionBypass(),
      macros: copySessionMacros(),
      tone: copySessionTone()
    };
  };
  PS.routeIsSlow = routeIsSlow; // Step 4A: is the measured route Bluetooth-like?

  // Step 6C (v13.3) — exposed for the CDP tests: setLoop drives
  // the loop region, buildCompSamples is the pure stitcher (called
  // on synthetic parts in-page), takeLabel is the one name a take
  // carries everywhere.
  PS.setLoop = setLoop;
  PS.clearLoop = clearLoop;
  PS.buildCompSamples = buildCompSamples;
  PS.takeLabel = takeLabel;

  /* v13.2 (item 3) — "Check a backup" in Setup: pick the backup
   * file and the sound files, and the app fingerprints the sound
   * files and checks every one against the list. Plain words:
   * "All N files check out." or the missing / changed names.
   */
  function checkBackupFiles() {
    // v32 (QUEUE #110) — the "Check these files" UI is gone from
    // Setup, so this is dead from the UI; it stays (with the guard
    // below) because the backup CHECK itself — verifyBackup + the
    // status strings — is still proven by cdp-v132, which drives
    // the same flow in-test.
    var status = $('backup-check-status');
    var input = $('backup-check-files');
    if (!input) return;
    var picked = input.files ? Array.prototype.slice.call(input.files) : [];
    if (!picked.length) {
      if (status) status.textContent = 'Pick the backup file and the sound files first.';
      return;
    }
    if (status) status.textContent = 'Checking…';
    var manifestFile = null;
    var others = [];
    picked.forEach(function (f) {
      if (/\.json$/i.test(f.name) && !manifestFile) manifestFile = f;
      else others.push(f);
    });
    if (!manifestFile) {
      if (status) status.textContent = 'No backup list found among the files you picked — pick the phone-studio-backup.json file too.';
      return;
    }
    manifestFile.text().then(function (text) {
      var manifest;
      try { manifest = JSON.parse(text); } catch (e) {
        if (status) status.textContent = 'That backup list could not be read — it is not a backup file from this app.';
        return;
      }
      if (!Array.isArray(manifest.files)) {
        if (status) status.textContent = 'That file is not a backup list from this app — pick the phone-studio-backup.json file.';
        return;
      }
      if (!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest)) {
        if (status) status.textContent = 'This browser cannot fingerprint files, so the backup cannot be checked here.';
        return;
      }
      var hashJobs = others.map(function (f) {
        return f.arrayBuffer().then(function (buf) {
          return window.crypto.subtle.digest('SHA-256', buf);
        }).then(function (digest) {
          return { name: f.name, size: f.size, sha256: toHex(digest) };
        });
      });
      return Promise.all(hashJobs).then(function (hashed) {
        // The manifest file itself counts as present (its entry is
        // presence-only — it cannot fingerprint itself).
        hashed.push({ name: manifestFile.name, size: manifestFile.size, sha256: null });
        var result = verifyBackup(manifest, hashed);
        if (!status) return;
        if (result.ok) {
          status.textContent = 'All ' + manifest.files.length + ' files check out.';
        } else {
          var bits = [];
          if (result.missing.length) bits.push('Missing: ' + result.missing.join(', '));
          if (result.changed.length) bits.push('Changed: ' + result.changed.join(', '));
          status.textContent = bits.join(' ');
        }
      });
    }).catch(function (err) {
      console.warn('Backup check failed:', err);
      if (status) status.textContent = 'The check could not run. Try picking the files again.';
    });
  }

  function deleteTake(track, takeId) {
    if (!window.confirm('Delete this take? It cannot be undone.')) return;
    var vocal = state.session.tracks[track];
    vocal.takes = vocal.takes.filter(function (t) { return t.id !== takeId; });
    if (vocal.activeTakeId === takeId) {
      vocal.activeTakeId = vocal.takes.length ? vocal.takes[vocal.takes.length - 1].id : null;
    }
    // v29: deleting the selected block clears the selection (its
    // handles go away with it).
    if (state.selectedBlockId === takeId) state.selectedBlockId = null;
    // Step 6C (v13.3): the star goes with the take. A best-of
    // take built from a deleted take keeps its own audio — the
    // originals are only ever deleted by hand, one at a time.
    if (vocal.starredTakeId === takeId) vocal.starredTakeId = null;
    delete state.waveCache[takeId];
    state.waveCacheOrder = state.waveCacheOrder.filter(function (id) { return id !== takeId; });
    saveSessions();
    PS.db.deleteTake(takeId).catch(function () { /* ignore */ });
    if (state.playingTakeId === takeId) stopPlayback();
    renderTracks();
    renderSheet();
    updateTransport();
  }

  /* v19 (QUEUE #25) — the sent takes, across all songs: every take
   * whose list entry carries sentAt. The stamp is set by
   * stampSentTake (share sheet resolved) and survives a reload via
   * saveSessions / the boot reconcile.
   */
  function collectSentTakes() {
    var sent = [];
    state.sessions.forEach(function (session) {
      Object.keys(session.tracks || {}).forEach(function (track) {
        (session.tracks[track].takes || []).forEach(function (take) {
          if (take.sentAt) sent.push({ session: session, track: track, take: take });
        });
      });
    });
    return sent;
  }
  PS.collectSentTakes = collectSentTakes; // v19: exposed for the CDP tests

  /* The sent-takes list in Setup. Sizes are estimated from the take
   * length (two 32-bit float files at 48 kHz — about 38 MB for a
   * 104 s take) because weighing the blobs would load every take's
   * audio into memory on every Setup open (QUEUE #31's cost, for a
   * number). The estimate is labelled as one; the count is exact.
   */
  function renderSentTakesList() {
    var box = $('sent-takes-list');
    if (!box) return;
    var sent = collectSentTakes();
    box.innerHTML = '';
    if (!sent.length) {
      box.appendChild(el('p', 'muted small', 'No sent takes yet — nothing has been marked sent.'));
      return;
    }
    var estBytes = 0;
    sent.forEach(function (entry) {
      estBytes += 2 * (entry.take.durationSeconds || 0) * 48000 * 4;
      // v27 (QUEUE #64): a send older than a day with nothing back
      // says so here too — same words as the take row, plus a
      // one-tap re-send through the same Send flow.
      var stale = isStaleSent(entry.take);
      var line = takeLabel(entry.take) + ' — ' + entry.session.name +
        ' — Sent ' + fmtTime(entry.take.sentAt) +
        (entry.take.sentVia ? ' (' + (entry.take.sentVia === 'small' ? 'smaller copy' : 'full quality') + ')' : '') +
        (stale ? ' — nothing came back yet. Re-send it?' : '');
      box.appendChild(el('p', 'muted small', line));
      if (stale) {
        var resendBtn = el('button', 'btn-small', 'Re-send ' + takeLabel(entry.take));
        resendBtn.addEventListener('click', function () { openSendSheet(entry.take.id); });
        box.appendChild(resendBtn);
      }
    });
    var estMb = Math.round(estBytes / 1048576);
    box.appendChild(el('p', 'muted small', sent.length + ' sent take' + (sent.length > 1 ? 's' : '') +
      ' — about ' + estMb + ' MB on this phone.'));
  }

  /* v19 (QUEUE #25) — one tap clears every SENT take: the raw +
   * aligned sound files leave the phone (IDB delete) and the take
   * leaves its track's list. Unstamped takes are never touched —
   * they are the only copy. Deliberately NOT automatic: sent does
   * not mean rendered, and the phone cannot see Drive — deleting a
   * sent-but-unrendered take would destroy the only copy. One
   * confirm names the count + the estimate; the per-take removal
   * mirrors deleteTake (active/star fixup, wave cache, stop
   * playback) for every session, not just the current one.
   */
  function clearSentTakes() {
    var status = $('clear-sent-status');
    var sent = collectSentTakes();
    if (!sent.length) {
      if (status) status.textContent = 'No sent takes to clear — nothing has been marked sent yet.';
      return;
    }
    var estBytes = 0;
    sent.forEach(function (entry) { estBytes += 2 * (entry.take.durationSeconds || 0) * 48000 * 4; });
    var estMb = Math.round(estBytes / 1048576);
    if (!window.confirm('Clear ' + sent.length + ' sent take' + (sent.length > 1 ? 's' : '') +
        ' (about ' + estMb + ' MB)? They were already sent — the sound files leave this phone. ' +
        'Takes that never went out stay put.')) return;
    var removed = 0;
    var jobs = sent.map(function (entry) {
      var vocal = entry.session.tracks[entry.track];
      vocal.takes = vocal.takes.filter(function (t) { return t.id !== entry.take.id; });
      if (vocal.activeTakeId === entry.take.id) {
        vocal.activeTakeId = vocal.takes.length ? vocal.takes[vocal.takes.length - 1].id : null;
      }
      if (vocal.starredTakeId === entry.take.id) vocal.starredTakeId = null;
      delete state.waveCache[entry.take.id];
      state.waveCacheOrder = state.waveCacheOrder.filter(function (id) { return id !== entry.take.id; });
      if (state.playingTakeId === entry.take.id) stopPlayback();
      return PS.db.deleteTake(entry.take.id).then(function () { removed += 1; }).catch(function () { /* ignore */ });
    });
    Promise.all(jobs).then(function () {
      saveSessions();
      renderTracks();
      renderSheet();
      updateTransport();
      renderSentTakesList();
      if (status) status.textContent = 'Cleared ' + removed + ' sent take' + (removed > 1 ? 's' : '') +
        ' (about ' + estMb + ' MB). Takes that never went out are untouched.';
    });
  }
  PS.clearSentTakes = clearSentTakes; // v19: exposed for the CDP tests

  /* Step 6C (v13.3) — what a take is called, in plain words: a
   * best-of take is "Best of 1", a loop pass is "Pass 2", anything
   * else is "Take 3". Used on the track rows, in the take sheet,
   * and in the best-of editor — one name everywhere, so a take is
   * never "Take 4" in one place and "Pass 2" in another.
   */
  function takeLabel(take) {
    if (!take) return '';
    if (take.comp) return 'Best of ' + (take.compNumber || take.takeNumber);
    if (take.loopPass) return 'Pass ' + ((take.passIndex || 0) + 1);
    return 'Take ' + take.takeNumber;
  }

  /* Step 6C (v13.3) — one tap keeps a take as the best on its
   * track. The starred take is the default pick for every part of
   * a best-of take. Tapping another take moves the star; there is
   * exactly one best per track.
   */
  function setStarredTake(track, takeId) {
    var vocal = state.session.tracks[track];
    if (!vocal) return;
    vocal.starredTakeId = takeId;
    saveSessions();
    renderSheet();
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
  /* v13.8-light — heavy modules AFTER first paint.
   *
   * tune-worklet.js (58 KB, the tune DSP), key-detect.js,
   * tempo-detect.js and retune.js are NOT in index.html's
   * synchronous scripts any more: they parse after the first
   * paint, in order, on idle — the record screen never waits
   * for them. Every call site already guards on their absence
   * (detectBeatKeyTempo, analyzeChunked, makeSmallCopy), and
   * the beat-analysis path re-runs itself once they land.
   * loadHeavyModules() is idempotent; warmWorklets() pre-loads
   * the two audio worklets (fetch + compile) off the record
   * tap — on iOS the context resume may never settle outside a
   * gesture, so the warmup races a 3 s timeout and fails
   * silently; the tap path is unchanged when it does.
   */
  var heavyModulesPromise = null;
  function loadHeavyModules() {
    if (heavyModulesPromise) return heavyModulesPromise;
    heavyModulesPromise = new Promise(function (resolve) {
      var files = ['tune-worklet.js', 'key-detect.js', 'tempo-detect.js', 'retune.js'];
      var i = 0;
      function next() {
        if (i >= files.length) { resolve(true); return; }
        var script = document.createElement('script');
        script.src = files[i++];
        script.onload = next;
        script.onerror = next; // a missing module never blocks the rest — call sites guard
        document.head.appendChild(script);
      }
      next();
    });
    return heavyModulesPromise;
  }
  function warmWorklets() {
    if (window.PSPerf) PSPerf.mark('worklet-warm-start');
    var job = ensureTuneModule().then(function () {
      if (window.PSPerf) { PSPerf.mark('worklet-warm-end'); PSPerf.measure('worklet-warm-ms', 'worklet-warm-start', 'worklet-warm-end'); }
      return true;
    }).catch(function () { return false; });
    return Promise.race([job, new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 3000); })]);
  }

  function ensureTuneModule() {
    if (state.tuneModuleReady && state.chainModuleReady) return PS.audio.ensureContext();
    return PS.audio.ensureContext().then(function (ctx) {
      var jobs = [];
      if (!state.tuneModuleReady) {
        jobs.push(ctx.audioWorklet.addModule('tune-worklet.js').then(function () {
          state.tuneModuleReady = true;
        }));
      }
      // Step 4A (v13.4): the chain worklet loads with the tune
      // module — every path that builds a tune node builds a
      // chain, so both modules must be there first.
      if (!state.chainModuleReady) {
        jobs.push(ctx.audioWorklet.addModule('vocal-chain-worklet.js').then(function () {
          state.chainModuleReady = true;
        }));
      }
      return Promise.all(jobs).then(function () { return ctx; });
    });
  }

  function makeTuneNode(ctx, isLive, sound) {
    var node = new AudioWorkletNode(ctx, 'tune-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1]
    });
    // B3 (v13.1): `sound` is a take's own stamped sound (overdubs
    // play with the sound their take was sung with); without it,
    // the song's current sound (monitor + playback).
    var s = sound || {
      key: state.session.key,
      preset: state.session.preset,
      strength: state.session.strength,
      speed: state.session.speed
    };
    node.port.postMessage({ type: 'key', key: s.key });
    node.port.postMessage({ type: 'preset', preset: s.preset });
    node.port.postMessage({ type: 'strength', value: s.strength });
    node.port.postMessage({ type: 'speed', value: s.speed });
    node.port.postMessage({ type: 'live', on: !!isLive });
    node.port.postMessage({ type: 'enabled', on: true });
    return node;
  }

  /* v13.8-light — flip the live sound between tune-only (smooth)
   * and the full chain, and re-park the live chains in place.
   * Playback chains are never light, so they do not move.
   */
  function setLightLive(on) {
    state.session.lightLive = !!on;
    saveSessions();
    broadcastTune();
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
    // Step 4A (v13.4): the macros + the chain switch ride along —
    // every live chain (monitor + playback) hears the change at
    // once, even mid-playback. No reset here: the worklet glides
    // to the new settings, so a slider drag never steps.
    var sound = {
      key: state.session.key,
      preset: state.session.preset,
      strength: state.session.strength,
      speed: null,
      macros: copySessionMacros(),
      chainOn: state.session.chainOn,
      bypass: copySessionBypass(),
      tone: copySessionTone()
    };
    [state.monitor && state.monitor.chain, state.playbackChain].forEach(function (ch) {
      if (!ch) return;
      ch.setSound(sound, false);
    });
    // Step 5 (v13.6): the sound panel shows the same song sound,
    // so every change lands there too — preset, strength, key,
    // macros, tone, parts, the whole switch.
    renderFxPanel();
  }

  // ---------------------------------------------------------------- live chain (Step 4A)

  /* The One Knob macros (BandLab's pattern, our names): one knob
   * = one whole chain, tuned by the crew. The singer picks a sound
   * by name, not by dialing numbers. Each knob is 0-100 and
   * defaults to 50, the sensible middle. Plain words on screen —
   * no dB, Hz, ratio, or any other number that needs a manual.
   *   Even — keeps loud and quiet parts level (the compressor)
   *   Bright — makes the voice shine (high shelf)
   *   Space — how much room you hear (reverb + echo)
   *   Punch — makes words hit harder (fast comp + presence)
   *   Warm — rounds the voice out (soft saturation + low shelf)
   */
  var MACRO_KEYS = ['even', 'bright', 'space', 'punch', 'warm'];
  var MACRO_DEFAULTS = { even: 50, bright: 50, space: 50, punch: 50, warm: 50 };
  var MACRO_LABELS = {
    even: 'Even',
    bright: 'Bright',
    space: 'Space',
    punch: 'Punch',
    warm: 'Warm'
  };
  var MACRO_HINTS = {
    even: 'Keeps loud and quiet parts level.',
    bright: 'Makes the voice shine.',
    space: 'How much room you hear.',
    punch: 'Makes words hit harder.',
    warm: 'Rounds the voice out.'
  };

  function clampMacros(m) {
    var out = {};
    MACRO_KEYS.forEach(function (key) {
      var v = m && typeof m[key] === 'number' ? m[key] : MACRO_DEFAULTS[key];
      out[key] = Math.max(0, Math.min(100, Math.round(v)));
    });
    return out;
  }

  function copySessionMacros() {
    return clampMacros(state.session.macros);
  }

  /* Step 4B (v13.5) — per-stage bypasses + fine tone controls.
   * One switch per part of the studio sound: true means that
   * part is OFF (bypassed) — the rest of the chain keeps working.
   * The fine tone sliders sit on top of the macros: 50 means
   * "the macros as they are" (no change). Plain words on screen
   * — no dB, Hz, ratio, or any other number that needs a manual.
   *   Rumble cut — the low cut, off or on (the slider sets how much)
   *   Clean up the mud — the corrective cut at 300 Hz
   *   Tune — the tune itself; off is the raw voice
   *   Even out — the compressor; off is no levelling
   *   Soften the sizzle — the de-esser
   *   Tone shape — Warmth, punch and shine (the three tone knobs)
   *   Echo — the repeats; Room — the space
   *   Cut background noise — the room-noise gate (off by default)
   */
  var BYPASS_KEYS = ['nr', 'tonefix', 'lowcut', 'tune', 'even', 'deess', 'tone', 'echo', 'room'];
  var BYPASS_DEFAULTS = { nr: true, tonefix: false, lowcut: false, tune: false, even: false, deess: false, tone: false, echo: false, room: false };
  var BYPASS_LABELS = {
    nr: 'Cut background noise',
    tonefix: 'Clean up the mud',
    lowcut: 'Rumble cut',
    tune: 'Tune',
    even: 'Even out',
    deess: 'Soften the sizzle',
    tone: 'Tone shape',
    echo: 'Echo',
    room: 'Room'
  };
  var BYPASS_HINTS = {
    nr: 'Quiets the room between lines.',
    tonefix: 'Takes the mud out of the voice.',
    lowcut: 'Takes out the low rumble. Off means no cut at all.',
    tune: 'The tune itself — off is your raw voice.',
    even: 'Keeps loud and quiet parts level.',
    deess: 'Softens sharp S sounds.',
    tone: 'Warmth, punch and shine.',
    echo: 'The repeats.',
    room: 'The space around the voice.'
  };
  var TONE_KEYS = ['rumble', 'presence', 'air'];
  var TONE_DEFAULTS = { rumble: 50, presence: 50, air: 50 };
  var TONE_LABELS = {
    rumble: 'Cut the rumble',
    presence: 'Cut through',
    air: 'Shine'
  };
  var TONE_HINTS = {
    rumble: 'How much low rumble to take out.',
    presence: 'Makes the words cut through the beat.',
    air: 'Makes the voice shine on top.'
  };

  /* Step 5 (v13.6) — the effects screen's 5-slot chain strip. The
   * live-chain stages group into five parts a singer can turn off
   * or on with one tap — eight of the nine stages. The ninth, the
   * room-noise cut, sits outside the strip as its own switch (it is
   * off by default — a gate you opt into, not a part of the sound
   * you shape — so it would always show its part as off). A part is
   * ON when every stage in it is on; tapping a part that is off
   * turns all of its stages back on, and tapping one that is on
   * turns them all off. A part turned off keeps its settings — the
   * strip only parks it. Icons are plain stroke shapes, same style
   * as the transport icons.
   */
  var FX_ICON_SPARKLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"></path></svg>';
  var FX_ICON_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>';
  var FX_ICON_LEVELS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"></path><path d="M4 12h10"></path><path d="M4 17h13"></path></svg>';
  var FX_ICON_SLIDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 4v16"></path><path d="M12 4v16"></path><path d="M18 4v16"></path><circle cx="6" cy="14" r="2"></circle><circle cx="12" cy="8" r="2"></circle><circle cx="18" cy="11" r="2"></circle></svg>';
  var FX_ICON_SPACE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 14a8 8 0 0 1 16 0"></path><path d="M7.5 14a4.5 4.5 0 0 1 9 0"></path><circle cx="12" cy="14" r="1.5" fill="currentColor" stroke="none"></circle></svg>';
  var FX_MODULES = [
    { id: 'clean', label: 'Clean up', stages: ['tonefix', 'lowcut'], icon: FX_ICON_SPARKLE },
    { id: 'tune', label: 'Tune', stages: ['tune'], icon: FX_ICON_NOTE },
    { id: 'even', label: 'Even out', stages: ['even', 'deess'], icon: FX_ICON_LEVELS },
    { id: 'tone', label: 'Tone shape', stages: ['tone'], icon: FX_ICON_SLIDERS },
    { id: 'space', label: 'Space', stages: ['echo', 'room'], icon: FX_ICON_SPACE }
  ];
  PS.fxModules = FX_MODULES; // Step 5: the chain-strip parts and the stages each one covers, for the CDP tests
  // The strip buttons, built once in wire() and kept for state sync.
  var fxSlots = [];

  function clampBypass(b) {
    var out = {};
    BYPASS_KEYS.forEach(function (key) {
      out[key] = !!(b && b[key] === true);
    });
    return out;
  }

  function copySessionBypass() {
    return clampBypass(state.session.bypass);
  }

  function clampTone(t) {
    var out = {};
    TONE_KEYS.forEach(function (key) {
      var v = t && typeof t[key] === 'number' ? t[key] : TONE_DEFAULTS[key];
      out[key] = Math.max(0, Math.min(100, Math.round(v)));
    });
    return out;
  }

  function copySessionTone() {
    return clampTone(state.session.tone);
  }

  /* The fine tone controls as stage settings (ADDITIVE on top of
   * the macros — 50 means "the macros as they are"): rumble moves
   * the low cut 80 -> 100 Hz (50 = 90 Hz, the v13.4 value);
   * presence adds -2 -> +2 dB at 3 kHz; air adds -3 -> +3 dB at
   * 10 kHz. Exposed as PS.toneToChain so the CDP tests can check
   * the exact settings the sliders produce.
   */
  function toneToChain(t) {
    var x = clampTone(t || TONE_DEFAULTS);
    return {
      lowCutHz: 80 + 20 * (x.rumble / 100),
      presenceDb: -2 + 4 * (x.presence / 100),
      shelfDb: -3 + 6 * (x.air / 100)
    };
  }

  /* The knob-to-stage mapping. Starting points from the research
   * (NOT Voloco's numbers — Voloco publishes none of these; tune
   * by ear): Moderate comp 3:1 / Diff -6 dB at Even 50; Rap's
   * punchy 4.5:1 lives near Even 100; the delay is a tempo-synced
   * dotted 1/8 at 25% feedback; the reverb tops out at 0.50 wet.
   * Exposed as PS.macrosToChain so the CDP tests can check the
   * exact settings the knobs produce.
   */
  function macrosToChain(m) {
    var x = clampMacros(m || MACRO_DEFAULTS);
    return {
      ratio: 1 + 3 * (x.even / 100), // Even: 1:1 (no squeeze) -> 4:1
      diffDb: -2 - 7 * (x.even / 100), // Even: threshold -2 -> -9 dB under the singer's level
      attackMs: 30 - 27 * (x.punch / 100), // Punch: 30 -> 3 ms
      releaseMs: 150 - 90 * (x.punch / 100), // Punch: 150 -> 60 ms
      makeupDb: 3, // fixed, the Moderate starting point
      presenceDb: 2.5 * (x.punch / 100), // Punch: 0 -> +2.5 dB @ 3 kHz
      shelfDb: 6 * (x.bright / 100), // Bright: 0 -> +6 dB high shelf @ 10 kHz
      drive: 1.5, // Warm: fixed soft-clip curve, blended in by satMix
      satMix: x.warm / 100, // Warm: 0 = dry, 1 = full soft clip
      lowShelfDb: 1.5 * (x.warm / 100), // Warm: 0 -> +1.5 dB @ 200 Hz
      reverbWet: 0.5 * (x.space / 100), // Space: 0 -> 0.50 wet
      delayWet: 0.10 + 0.10 * (x.space / 100) // Space: echo 0.10 -> 0.20
    };
  }

  /* Bluetooth (roadmap §3p): the web exposes no Bluetooth device
   * identity, but a measured round trip over 80 ms IS a
   * Bluetooth-like path — wired round trips measure under ~40 ms,
   * AirPods Pro 2 tap-to-sound is 126 ms (9to5Mac, cited in the
   * roadmap). So the acoustic calibration IS the detector: a pair
   * of headphones whose measured delay is over 80 ms never runs
   * the live monitor (hearing yourself late throws a take off),
   * and the full chain stays off live. No calibration means
   * unmeasured, not slow — the monitor runs, and the first
   * measurement sorts it out.
   */
  var BT_SLOW_DELAY_SECONDS = 0.08;

  function routeIsSlow() {
    var active = activeCalibration();
    if (!active || !active.calibration || typeof active.calibration.delaySeconds !== 'number') return false;
    return active.calibration.delaySeconds > BT_SLOW_DELAY_SECONDS;
  }

  /* Builds one full vocal chain: corrective EQ -> low cut (x2) ->
   * tune -> chain worklet (gate -> comp -> de-esser -> saturation
   * -> reverb) -> manual EQ -> out, with the echo as a parallel
   * send off the finished sound. `sound` is a takeSound() object
   * (preset/strength/key/macros/chainOn); without one, the song's
   * current sound. `destination` is where the finished sound goes
   * (the monitor gain for live, the master gain for playback) —
   * the builder wires the output AND the echo send to it, so the
   * caller only connects a source to `input`. Returns
   * { input, output, tune, chain, eq, delay, macros, chainOn,
   *   setSound(sound, resetChain), disconnect() }.
   *
   * The delay taps the finished sound AFTER the reverb (the
   * roadmap's order is delay then reverb — here the echo repeats
   * carry the room with them. One line of difference, same
   * sound family; the offline render is the honest judge).
   */
  /* v13.8-light — `lightOpt`: true forces the tune-only live
   * path, false forces the full chain, undefined means "live
   * chains follow the song's Light live sound switch (on by
   * default), playback/offline chains are always full".
   * A light chain keeps the tune + the two native biquads that
   * protect it (corrective EQ, low cut — ~free, and the low cut
   * keeps rumble out of YIN) and parks everything else: the
   * chain worklet is a bit-exact passthrough, the tone biquads
   * sit at 0, the echo send is dry. Playback is untouched — the
   * finished sound is heard on playback, where a few ms of
   * latency cost nothing.
   */
  function makeVocalChain(ctx, isLive, sound, destination, lightOpt) {
    var s = sound || {
      key: state.session.key,
      preset: state.session.preset,
      strength: state.session.strength,
      speed: null,
      macros: copySessionMacros(),
      chainOn: state.session.chainOn,
      bypass: copySessionBypass(),
      tone: copySessionTone()
    };
    // Corrective EQ: one gentle cut at 300 Hz (mud) — fixed, the
    // roadmap's "corrective" stage. It is a tone change, so it
    // parks at 0 dB when the chain is off (see applyChainSettings).
    var corrective = ctx.createBiquadFilter();
    corrective.type = 'peaking';
    corrective.frequency.value = 300;
    corrective.Q.value = 1;
    corrective.gain.value = -2;
    // Low cut: two cascaded 12 dB high-passes @ 90 Hz = 24 dB/oct,
    // placed BEFORE the tune — Gemini's correction: sub-80 Hz mic
    // rumble degrades YIN accuracy, so the tune never sees it.
    // This one filter IS the roadmap's "low cut" stage, in the
    // slot where it does the work (before Main FX).
    var lowCut1 = ctx.createBiquadFilter();
    lowCut1.type = 'highpass';
    lowCut1.frequency.value = 90;
    lowCut1.Q.value = 0.7071;
    var lowCut2 = ctx.createBiquadFilter();
    lowCut2.type = 'highpass';
    lowCut2.frequency.value = 90;
    lowCut2.Q.value = 0.7071;
    // Main FX: the tune (already built — reused, not rebuilt).
    var tune = makeTuneNode(ctx, isLive, s);
    // The chain worklet: gate -> comp -> de-esser -> saturation
    // -> reverb. Zero-lookahead throughout (see the worklet).
    var chainNode = new AudioWorkletNode(ctx, 'vocal-chain-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      outputChannelCount: [1]
    });
    // Manual EQ: Warm low shelf + Punch presence + Bright shelf.
    var lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 200;
    lowShelf.gain.value = 0;
    var presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 3000;
    presence.Q.value = 1;
    presence.gain.value = 0;
    var highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 10000;
    highShelf.gain.value = 0;
    // Echo send: dotted 1/8 from the beat's tempo (45,000/BPM
    // ms — 375 ms at 120 BPM), 25% feedback, repeats filtered
    // 300 Hz - 6 kHz (FL's send discipline). No beat yet means
    // 120 BPM. Capped at 1.5 s so a slow beat never exceeds the
    // node's 2 s ceiling.
    var bpm = (typeof state.session.bpm === 'number' && state.session.bpm > 0) ? state.session.bpm : 120;
    var delaySeconds = Math.min(1.5, 45 / bpm);
    var delayNode = ctx.createDelay(2);
    delayNode.delayTime.value = delaySeconds;
    var delayLp = ctx.createBiquadFilter();
    delayLp.type = 'lowpass';
    delayLp.frequency.value = 6000;
    var delayHp = ctx.createBiquadFilter();
    delayHp.type = 'highpass';
    delayHp.frequency.value = 300;
    var delayWet = ctx.createGain();
    delayWet.gain.value = 0;
    var delayFb = ctx.createGain();
    delayFb.gain.value = 0.25;
    // Wire it.
    corrective.connect(lowCut1);
    lowCut1.connect(lowCut2);
    lowCut2.connect(tune);
    tune.connect(chainNode);
    chainNode.connect(lowShelf);
    lowShelf.connect(presence);
    presence.connect(highShelf);
    var out = destination || ctx.destination;
    highShelf.connect(out);
    highShelf.connect(delayNode);
    delayNode.connect(delayLp);
    delayLp.connect(delayHp);
    delayHp.connect(delayWet);
    delayWet.connect(out);
    delayHp.connect(delayFb);
    delayFb.connect(delayNode);
    var chainObj = {
      ctx: ctx,
      isLive: !!isLive,
      lightOpt: lightOpt, // v13.8-light: explicit true/false, or undefined = live follows the song switch
      input: corrective,
      output: highShelf,
      tune: tune,
      chain: chainNode,
      eq: {
        corrective: corrective,
        lowCut1: lowCut1,
        lowCut2: lowCut2,
        lowShelf: lowShelf,
        presence: presence,
        highShelf: highShelf
      },
      delay: { node: delayNode, wet: delayWet, fb: delayFb, seconds: delaySeconds, bpm: bpm },
      macros: clampMacros(s.macros),
      bypass: clampBypass(s.bypass),
      tone: clampTone(s.tone),
      chainOn: typeof s.chainOn === 'boolean' ? s.chainOn : true,
      setSound: function (sound2, resetChain) { applyChainSettings(chainObj, sound2, resetChain); },
      /* v40 (QUEUE #124): re-point the chain's output at another
       * layer's gain — the playback chain is shared across layers,
       * so a take on another layer moves its output before it
       * plays. The dry signal (highShelf) and the echo wet both
       * move; the echo feedback loop (delayNode) is re-wired
       * intact, so the tail is never cut. */
      setOutput: function (node) {
        var out = node || ctx.destination;
        try { highShelf.disconnect(); } catch (e) { /* ignore */ }
        highShelf.connect(delayNode);
        highShelf.connect(out);
        try { delayWet.disconnect(); } catch (e) { /* ignore */ }
        delayWet.connect(out);
      },
      disconnect: function () {
        [corrective, lowCut1, lowCut2, tune, chainNode, lowShelf, presence, highShelf,
         delayNode, delayLp, delayHp, delayWet, delayFb].forEach(function (n) {
          try { n.disconnect(); } catch (e) { /* ignore */ }
        });
      }
    };
    applyChainSettings(chainObj, s, true);
    return chainObj;
  }

  /* Steers a built chain to a sound: the tune messages, the
   * worklet params, the EQ gains, the echo wet, the on/off. A
   * take change passes resetChain=true (the tune detector and
   * the chain state start clean — the last take's tail never
   * bleeds in); a macro tweak passes false (the worklet glides
   * to the new settings, no click). When the chain is off, the
   * worklet is a bit-exact passthrough, every EQ gain parks at
   * 0, the echo wet parks at 0, and the low cut parks at 10 Hz
   * (a rumble guard, not a tone change) — the graph stays wired,
   * so the switch itself is silent.
   *
   * Step 4B (v13.5): the same parking discipline, per stage.
   * A bypassed stage parks cleanly and nothing else moves:
   * Tune posts strength 0 (the worklet scales its correction by
   * strength, so 0 is the raw voice); Even posts ratio 1:1 with
   * no makeup (a bypassed compressor must not make the voice
   * louder); Sizzle cut posts the worklet's deess off; Tone
   * parks the three biquads at 0 and the saturation at 0; the
   * low cut parks at 10 Hz; Echo and Room park their wets at 0.
   * The fine tone sliders ride on top of the macros (see
   * toneToChain) — 50 means the macros as they are.
   */
  function applyChainSettings(chainObj, sound, resetChain) {
    var s = sound || {};
    var macros = clampMacros(s.macros || copySessionMacros());
    var bypass = clampBypass(s.bypass || copySessionBypass());
    var tone = clampTone(s.tone || copySessionTone());
    var chainOn = typeof s.chainOn === 'boolean' ? s.chainOn : state.session.chainOn;
    // v13.8-light: a light chain is tune-only live. Recomputed on
    // every setSound, so flipping the Setup switch re-parks the
    // live chains in place — no rebuild, no click. An explicit
    // lightOpt (the CDP light render) always wins.
    var light = chainObj.lightOpt !== undefined ? !!chainObj.lightOpt :
      (chainObj.isLive && state.session.lightLive !== false);
    chainObj.light = light;
    var c = macrosToChain(macros);
    var tc = toneToChain(tone);
    var ctx = chainObj.ctx;
    var t = ctx.currentTime;
    chainObj.tune.port.postMessage({ type: 'key', key: s.key || state.session.key });
    chainObj.tune.port.postMessage({ type: 'preset', preset: s.preset || state.session.preset });
    chainObj.tune.port.postMessage({ type: 'strength', value: bypass.tune ? 0 : (typeof s.strength === 'number' ? s.strength : state.session.strength) });
    chainObj.tune.port.postMessage({ type: 'speed', value: null });
    if (resetChain) {
      chainObj.tune.port.postMessage({ type: 'reset' });
      chainObj.chain.port.postMessage({ type: 'reset' });
    }
    chainObj.chain.port.postMessage({
      type: 'params',
      params: {
        ratio: (light || bypass.even) ? 1 : c.ratio,
        diffDb: c.diffDb,
        attackMs: c.attackMs,
        releaseMs: c.releaseMs,
        makeupDb: (light || bypass.even) ? 0 : c.makeupDb,
        drive: c.drive,
        satMix: (light || bypass.tone) ? 0 : c.satMix,
        reverbWet: (light || !chainOn || bypass.room) ? 0 : c.reverbWet
      }
    });
    chainObj.chain.port.postMessage({ type: 'nr', on: !light && chainOn && !bypass.nr });
    chainObj.chain.port.postMessage({ type: 'deess', on: !light && chainOn && !bypass.deess });
    // Light = the worklet is a bit-exact passthrough (its `enabled:
    // false` path touches nothing) — the tune still tunes, the
    // native biquads still shape, nothing else spends CPU live.
    chainObj.chain.port.postMessage({ type: 'enabled', on: !light && chainOn });
    function setGain(node, v) {
      try { node.gain.setTargetAtTime(v, t, 0.01); } catch (e) { node.gain.value = v; }
    }
    // The frequency is set DIRECTLY, not with setTargetAtTime:
    // a probe (Nov 25) proved that in this Chromium a
    // BiquadFilterNode frequency's `.value` never moves after
    // setTargetAtTime — a fresh biquad read 90 Hz 500 ms after
    // setTargetAtTime(10), while a gain param on the same context
    // moved 3 -> 0 as expected. A direct assignment is immediate,
    // deterministic, and readable — and the 90 -> 10 Hz park is
    // inaudible as a step (the filter barely touches the passband
    // either way), so nothing is lost by skipping the glide.
    function setFreq(node, v) {
      node.frequency.value = v;
    }
    // Light keeps the corrective cut + the low cut (native biquads,
    // ~free, and the low cut keeps rumble out of YIN) and parks the
    // tone biquads + the echo at 0 — the graph stays wired, so the
    // switch itself is silent.
    setGain(chainObj.eq.corrective, ((light || chainOn) && !bypass.tonefix) ? -2 : 0);
    setFreq(chainObj.eq.lowCut1, ((light || chainOn) && !bypass.lowcut) ? tc.lowCutHz : 10);
    setFreq(chainObj.eq.lowCut2, ((light || chainOn) && !bypass.lowcut) ? tc.lowCutHz : 10);
    setGain(chainObj.eq.lowShelf, (light || !chainOn || bypass.tone) ? 0 : c.lowShelfDb);
    setGain(chainObj.eq.presence, (light || !chainOn || bypass.tone) ? 0 : c.presenceDb + tc.presenceDb);
    setGain(chainObj.eq.highShelf, (light || !chainOn || bypass.tone) ? 0 : c.shelfDb + tc.shelfDb);
    setGain(chainObj.delay.wet, (light || !chainOn || bypass.echo) ? 0 : c.delayWet);
    setGain(chainObj.delay.fb, (light || !chainOn || bypass.echo) ? 0 : 0.25);
    chainObj.macros = macros;
    chainObj.bypass = bypass;
    chainObj.tone = tone;
    chainObj.chainOn = chainOn;
  }

  /* Live node values of the playback chain (or the monitor chain),
   * for the tests: what the app actually set on the biquads, the
   * echo, and the worklet — not what the knobs say. Null when no
   * chain exists yet. The worklet row is the mapped setting that
   * was posted (the worklet itself keeps no readable state).
   */
  function chainProbe(which) {
    var ch = which === 'monitor' ? (state.monitor && state.monitor.chain) : state.playbackChain;
    if (!ch) return null;
    var c = macrosToChain(ch.macros);
    var b = clampBypass(ch.bypass);
    var tc = toneToChain(ch.tone);
    var light = !!ch.light; // v13.8-light: what applyChainSettings actually parked
    return {
      chainOn: ch.chainOn,
      light: light,
      macros: ch.macros,
      bypass: b,
      tone: ch.tone,
      correctiveDb: ch.eq.corrective.gain.value,
      lowCutHz: ch.eq.lowCut1.frequency.value,
      lowShelfDb: ch.eq.lowShelf.gain.value,
      presenceDb: ch.eq.presence.gain.value,
      highShelfDb: ch.eq.highShelf.gain.value,
      delayWet: ch.delay.wet.gain.value,
      delaySeconds: ch.delay.seconds,
      delayBpm: ch.delay.bpm,
      worklet: {
        ratio: (light || b.even) ? 1 : c.ratio,
        diffDb: c.diffDb,
        attackMs: c.attackMs,
        releaseMs: c.releaseMs,
        makeupDb: (light || b.even) ? 0 : c.makeupDb,
        satMix: (light || b.tone) ? 0 : c.satMix,
        reverbWet: (light || !ch.chainOn || b.room) ? 0 : c.reverbWet,
        nrOn: !light && ch.chainOn && !b.nr,
        deessOn: !light && ch.chainOn && !b.deess
      }
    };
  }

  /* The chain as the app wired it, for the tests (and the later
   * effects screen): the stages in order with their switches,
   * the macro values, the Bluetooth call, and the live round-trip
   * numbers. The stage list is what the app actually built — not
   * a claim about what the browser did with it.
   */
  function chainInfo() {
    var sr = PS.audio.sampleRate();
    // Step 4B (v13.5): each stage reports its own switch. The
    // tune and the room-noise cut are not part of the chainOn
    // switch (the tune still tunes with the chain off; the gate
    // is its own switch), so they report only their bypass.
    var bypass = copySessionBypass();
    var chainOn = state.session.chainOn;
    var lightLive = state.session.lightLive !== false; // v13.8-light
    return {
      stages: [
        { name: 'Room noise cut', on: !bypass.nr },
        { name: 'Tone fix', on: chainOn && !bypass.tonefix },
        { name: 'Low cut', on: chainOn && !bypass.lowcut },
        { name: 'Tune', on: !bypass.tune },
        { name: 'Even out', on: chainOn && !bypass.even },
        { name: 'Sizzle cut', on: chainOn && !bypass.deess },
        { name: 'Tone', on: chainOn && !bypass.tone },
        { name: 'Echo', on: chainOn && !bypass.echo },
        { name: 'Room', on: chainOn && !bypass.room }
      ],
      // The stages above are the song's sound (what playback
      // plays). What he hears LIVE while singing is narrower
      // when lightLive is on: tune + tone fix + low cut only.
      lightLive: lightLive,
      liveStages: lightLive ?
        ['Tone fix', 'Low cut', 'Tune'] :
        ['Tone fix', 'Low cut', 'Tune', 'Even out', 'Sizzle cut', 'Tone', 'Echo', 'Room'],
      chainOn: chainOn,
      macros: copySessionMacros(),
      bypass: bypass,
      tone: copySessionTone(),
      nrOn: !bypass.nr,
      slowRoute: routeIsSlow(),
      monitorAllowed: !routeIsSlow(),
      monitorOn: state.monitorOn,
      monitorRunning: !!state.monitor,
      monitorChainOn: !!(state.monitor && state.monitor.chain && state.monitor.chain.chainOn),
      playbackMacros: state.playbackChain ? state.playbackChain.macros : null,
      playbackChainOn: state.playbackChain ? state.playbackChain.chainOn : null,
      tuneLatencyMs: 8, // the tune worklet's documented fixed delay
      chainBlockMs: sr ? Math.round(128 / sr * 1000 * 10) / 10 : null, // one worklet render block
      baseLatencyMs: PS.audio.baseLatency() !== null ? Math.round(PS.audio.baseLatency() * 1000 * 10) / 10 : null,
      outputLatencyMs: PS.audio.outputLatency() !== null ? Math.round(PS.audio.outputLatency() * 1000 * 10) / 10 : null,
      sampleRate: sr
    };
  }

  /* The monitor branch: mic -> tune -> headphones, live. It runs
   * only when the toggle is on AND headphones are the output AND
   * calibration is not running (the monitor would loop the clicks
   * back into the measurement).
   */
  function monitorWanted() {
    return state.monitorOn &&
      PS.store.outputMode() === 'headphones' &&
      !state.calibrating &&
      // Step 4A (v13.4): a slow (Bluetooth-like) route never runs
      // the live monitor — hearing yourself late throws a take off.
      !routeIsSlow();
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
          // Step 4A (v13.4): the monitor runs through the full
          // vocal chain (live mode: chorus renders 4 voices) —
          // the chain object owns the tune, the EQ, the echo and
          // the room, and its input is where the mic goes. The
          // chain's output is already wired to the monitor gain.
          var chainObj = makeVocalChain(ctx, true, null, PS.audio.monitorNode() || ctx.destination);
          source.connect(gain);
          gain.connect(chainObj.input);
          state.monitor = { source: source, gain: gain, chain: chainObj, tune: chainObj.tune };
          gain.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
          // Step 5 (v13.6): the sound panel's live wave needs the
          // mic's level while the monitor runs — a passive analyser
          // tap on the monitor gain (it hears the signal, it never
          // changes it). A 100 ms tick feeds the same rolling peaks
          // the record strip draws, so the panel's wave moves while
          // he sings into the monitor.
          var analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          gain.connect(analyser);
          var waveBuf = new Uint8Array(analyser.fftSize);
          state.monitor.analyser = analyser;
          state.monitor.waveTimer = setInterval(function () {
            analyser.getByteTimeDomainData(waveBuf);
            var peak = 0;
            for (var i = 0; i < waveBuf.length; i++) {
              var v = Math.abs(waveBuf[i] - 128) / 128;
              if (v > peak) peak = v;
            }
            livePeaks.push(peak);
            if (livePeaks.length > 90) livePeaks.shift();
            drawLiveWave();
            drawFxWave();
          }, 100);
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
    // Step 5 (v13.6): stop the panel wave's tick with the monitor,
    // and drop the peaks it fed — the next record starts clean.
    if (mon.waveTimer) clearInterval(mon.waveTimer);
    livePeaks = [];
    livePeakAccum = 0;
    drawLiveWave();
    PS.audio.ensureContext().then(function (ctx) {
      try { mon.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.01); } catch (e) { /* ignore */ }
      setTimeout(function () {
        try { mon.source.disconnect(); } catch (e) { /* ignore */ }
        try { mon.gain.disconnect(); } catch (e) { /* ignore */ }
        try { if (mon.analyser) mon.analyser.disconnect(); } catch (e) { /* ignore */ }
        // Step 4A (v13.4): one call drops the whole chain
        // (tune, worklet, EQ, echo) with the monitor.
        try { mon.chain.disconnect(); } catch (e) { /* ignore */ }
        maybeCloseMic(); // nothing needs the mic now — review plays at full quality
      }, 120);
    }).catch(function () {
      try { if (mon.waveTimer) clearInterval(mon.waveTimer); } catch (e) { /* ignore */ }
      try { mon.source.disconnect(); } catch (e) { /* ignore */ }
      try { mon.gain.disconnect(); } catch (e) { /* ignore */ }
      try { if (mon.analyser) mon.analyser.disconnect(); } catch (e) { /* ignore */ }
      try { mon.chain.disconnect(); } catch (e) { /* ignore */ }
      maybeCloseMic();
    });
  }

  function toggleMonitor() {
    if (PS.store.outputMode() !== 'headphones') {
      showError('Put your headphones on to hear yourself while you sing — through the speaker it would feed back.');
      return;
    }
    // Step 4A (v13.4): a measured slow route is a Bluetooth-like
    // path — hearing yourself late throws a take off, so the
    // monitor stays off (Voloco's own rule). The tune still works
    // on playback; wired headphones hear the full sound live.
    if (routeIsSlow()) {
      showError('These headphones add too much delay to hear yourself live — the tune still works on playback. Try wired headphones to hear the full sound while you sing.');
      return;
    }
    state.monitorOn = !state.monitorOn;
    updateMonitor();
    updateTransport();
    // Step 5 (v13.6): the panel's wave switches source with the
    // monitor — live peaks while it runs, the take when it stops.
    drawFxWave();
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
  function playTakeTuned(takeBuffer, beatBuffer, onEnded, opts, takeDelaySeconds, layerKind) {
    return ensureTuneModule().then(function (ctx) {
      // Step 3 — `opts` is the TAKE's sound; without it, the song's
      // current sound (the old behaviour). Step 4A (v13.4): the
      // take plays through the persistent playback CHAIN (tune +
      // chain worklet + EQ + echo), not just the tune node — the
      // chain is built once and re-sounded per take, with the tune
      // + chain state reset so the last take's tail never bleeds
      // into the next one.
      // v40 (QUEUE #124): the chain's output runs through the
      // take's layer gain (layerKind), the beat through the beat's
      // — the chain is shared across layers, so a take on another
      // layer re-points its output before it plays.
      var layerGain = PS.audio.layerGainFor(layerKind || state.selectedTrack) ||
        PS.audio.outputNode() || ctx.destination;
      var beatGain = PS.audio.layerGainFor('beat') ||
        PS.audio.outputNode() || ctx.destination;
      var sound = opts || {
        key: state.session.key,
        preset: state.session.preset,
        strength: state.session.strength,
        speed: null,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone()
      };
      if (!state.playbackChain) {
        state.playbackChain = makeVocalChain(ctx, false, sound, layerGain);
        state.playbackTune = state.playbackChain.tune; // full 7-voice chorus on playback
      } else {
        state.playbackChain.setSound(sound, true);
        state.playbackChain.setOutput(layerGain);
      }
      var anchor = PS.audio.currentTime() + 0.1;
      var players = [];
      var takePlayer = ctx.createBufferSource();
      takePlayer.buffer = takeBuffer;
      takePlayer.connect(state.playbackChain.input);
      // Step 6C (v13.3): a pass or a best-of take starts late —
      // it joins in when the playhead reaches its place in the
      // song, while the beat starts at the anchor.
      takePlayer.start(anchor + (takeDelaySeconds || 0));
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
        beatPlayer.connect(beatGain);
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
      showError('The tune could not start — playing the take without the tune instead.');
      return PS.audio.playTake(takeBuffer, beatBuffer, onEnded, takeDelaySeconds || 0, layerKind);
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
        var take = findTake(takeId);
        var entry = {
          peaks: computePeaks(audioBuffer.getChannelData(0), PEAK_BUCKETS),
          duration: audioBuffer.duration,
          // Step 6C (v13.3): where the take sits in the song, so
          // its wave draws at the right place on the lane.
          offsetSeconds: take ? (take.songOffsetSeconds || 0) : 0
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
    trackKinds().forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      if (!vocal) return;
      // v29: the timeline covers every take's audible window, not
      // just the active take — a block's end is its place in the
      // song plus its audible length (trimmed, if it was trimmed).
      (vocal.takes || []).forEach(function (take) {
        var end = (take.songOffsetSeconds || 0) + takeAudibleDuration(take);
        if (end > longest) longest = end;
      });
    });
    if (Math.abs(longest - state.timelineSeconds) > 0.01) {
      state.timelineSeconds = longest;
      drawAllWaves();
      renderPlayhead();
      renderRuler();
    }
  }

  /* Draws one lane: real bars where the audio is, clean dark
   * everywhere else — like the approved photo, where a lane is a
   * solid dark row with solid blocks on it. v31 removed the dotted
   * baseline: on an empty lane it read as unfinished, and the
   * mockup has no dots. No wave means nothing is drawn. */
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
    if (!wave || !wave.peaks) return;
    // Step 6C (v13.3): a pass or a best-of take draws at its place
    // in the song, not at 0 — the bars start where the take does.
    var x0 = ((wave.offsetSeconds || 0) / state.timelineSeconds) * w;
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
      var bx = x0 + b * step;
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
      var canvas = row.querySelector(':scope > .wave-lane > canvas');
      if (!canvas) return;
      var kind = row.getAttribute('data-track');
      var color = getComputedStyle(row).getPropertyValue('--track-accent').trim() || '#8b5cf6';
      if (kind === 'beat') {
        drawWave(canvas, getBeatWave(), '#e5e5e5');
        return;
      }
      // v29: a vocal lane's canvas draws nothing now — the takes
      // draw as BLOCKS on top of it (renderTakeBlocks /
      // drawBlockWaves), so the lane never paints a take twice.
      // v31: and no dotted baseline either — an empty lane is clean
      // solid dark, like the approved photo.
      drawWave(canvas, null, color);
    });
  }

  // ---------------------------------------------------------------- playhead

  function fmtPlayhead() {
    $('time-label').textContent = fmtClock(state.playheadSeconds);
  }

  function laneRect() {
    // v29: the lane's own canvas — the first canvas in a row is
    // the lane canvas, but the blocks each carry one too, so the
    // selector names the lane's directly.
    var canvas = document.querySelector('.track-row .wave-lane > canvas');
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
    // v29: the overview window follows the line.
    renderOverviewWindow();
  }

  function setPlayhead(seconds) {
    state.playheadSeconds = Math.max(0, Math.min(state.timelineSeconds, seconds));
    renderPlayhead();
  }

  /* v31 (mockup 12 fix): the time ruler — tick marks + 0:00 / 0:02 /
   * 0:04 / 0:06 / 0:08 labels, aligned to the lanes. The ticks live
   * in #ruler-ticks, positioned from the lane canvas geometry (the
   * same geometry the playhead uses), so a tick sits exactly over
   * its second on every lane. At least 0:00–0:08 always shows; a
   * longer song extends the ruler in 2s steps. Called after layout
   * (renderTracks), when the song gets longer (updateTimeline) and
   * on resize — never on every playhead move (the ticks do not move). */
  function renderRuler() {
    var ticks = $('ruler-ticks');
    var ruler = $('ruler');
    if (!ticks || !ruler) return;
    var canvas = document.querySelector('.track-row .wave-lane > canvas');
    if (!canvas) return;
    var c = canvas.getBoundingClientRect();
    var r = ruler.getBoundingClientRect();
    if (c.width <= 0 || r.width <= 0) return;
    ticks.style.left = (c.left - r.left) + 'px';
    ticks.style.width = c.width + 'px';
    var end = Math.max(8, Math.floor(state.timelineSeconds / 2) * 2);
    // v31: the labels thin out on a long song so they never run
    // together — a 30s song labels every 6s, an 8s song every 2s
    // (the mockup's ruler), always at least ~44px apart.
    var pxPerSec = state.timelineSeconds > 0 ? c.width / state.timelineSeconds : 0;
    var step = 2;
    var steps = [2, 4, 6, 10, 15, 30, 60];
    for (var si = 0; si < steps.length; si++) {
      if (steps[si] * pxPerSec >= 44 || si === steps.length - 1) { step = steps[si]; break; }
    }
    var html = '';
    for (var t = 0; t <= end; t += step) {
      var pct = state.timelineSeconds > 0 ? (t / state.timelineSeconds) * 100 : 0;
      if (pct > 100) break;
      html += '<div class="ruler-tick" style="left:' + pct.toFixed(2) + '%">' + fmtClock(t) + '</div>';
    }
    ticks.innerHTML = html;
  }

  /* v29 (mockup 12): the overview strip — the whole song at a
   * glance, above the transport bar. The beat's wave fills it
   * (the longest vocal take's wave if there is no beat yet); a
   * blue window shows the quarter of the song the playhead is in
   * and follows it. Tap the strip to jump the line there. */
  function renderOverview() {
    var canvas = $('overview-canvas');
    var win = $('overview-window');
    if (!canvas || !win) return;
    var wave = getBeatWave();
    if (!wave) {
      // No beat yet — the longest vocal take stands in.
      var best = null;
      trackKinds().forEach(function (kind) {
        (state.session.tracks[kind].takes || []).forEach(function (t) {
          if (!best || takeAudibleDuration(t) > takeAudibleDuration(best)) best = t;
        });
      });
      if (best) wave = state.waveCache[best.id] || null;
    }
    var color = wave ? '#e5e5e5' : null;
    if (wave) {
      drawWave(canvas, wave, color);
      win.style.display = '';
    } else {
      // v31 (mockup 12 fix): no beat and no takes means no wave to
      // overview — the strip is an empty dark bar, and the blue
      // window on it read as a stray empty box on Denasse's phone.
      // Hide the window until there is something to show.
      var ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      win.style.display = 'none';
      return;
    }
    renderOverviewWindow();
  }

  function renderOverviewWindow() {
    var win = $('overview-window');
    if (!win) return;
    // The window is a quarter of the song, centred on the line.
    var frac = state.timelineSeconds > 0 ? state.playheadSeconds / state.timelineSeconds : 0;
    var w = 0.25;
    var left = Math.max(0, Math.min(1 - w, frac - w / 2));
    win.style.left = (left * 100) + '%';
    win.style.width = (w * 100) + '%';
  }

  function tickPlayhead() {
    if (state.recording) {
      var pos = PS.audio.currentTime() - state.recording.anchorTime;
      if (state.recording.loop) {
        // Step 6C (v13.3): while looping, the playhead wraps
        // inside the loop region — it shows where in the part he
        // is, not how far past it the capture has run.
        var loopLen = state.recording.loop.end - state.recording.loop.start;
        pos = state.recording.loop.start + (((pos % loopLen) + loopLen) % loopLen);
      }
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

  /* v29 (mockup 12): a press on a BLOCK works the block — tap to
   * select it (handles + Delete appear, and it becomes the lane's
   * take), drag it to move it along the song, drag a round handle
   * to trim it. A press on empty lane scrubs (moves the line), as
   * before. A press on a vocal row selects the layer; on the beat
   * row with no beat it opens the import. A swipe UP on the lanes
   * opens the sound panel (the Voloco gesture, moved here from the
   * sound strip, which lives in the panel now).
   */
  function onTracksPointerDown(event) {
    if (event.target.closest('button')) return;
    var block = event.target.closest('.take-block');
    if (block && !state.recording) {
      var take = findTake(block.getAttribute('data-take-id'));
      if (take) {
        var handle = event.target.closest('.block-handle');
        var rect = laneRect();
        state.blockDrag = {
          takeId: take.id,
          track: block.getAttribute('data-track'),
          mode: handle ? (handle.getAttribute('data-handle') === 'start' ? 'trim-start' : 'trim-end') : 'move',
          startX: event.clientX,
          startY: event.clientY,
          startOffset: take.songOffsetSeconds || 0,
          startTrimStart: takeTrimStart(take),
          startTrimEnd: takeTrimEnd(take),
          secondsPerPixel: rect && rect.width > 0 ? state.timelineSeconds / rect.width : 0,
          moved: false,
          el: block
        };
        // A handle press is a trim from the first pixel; a body
        // press waits for real movement (a tap selects instead).
        return;
      }
    }
    var row = event.target.closest('.track-row');
    if (row) {
      var kind = row.getAttribute('data-track');
      if (kind === 'beat') {
        if (!state.beat) {
          // v27 (QUEUE #87): the row tap is the Import button's other
          // door — shut it while an import is loading too.
          // v31: and while a take is live (v22 #45) — the row's own
          // click handler already guards both; this pointerdown
          // path is the first door a real tap hits, so it must
          // guard both too, or the picker opens mid-take.
          if (!state.beatLoading && !state.recording) $('beat-file').click();
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
    state.swipeStart = { x: event.clientX, y: event.clientY, opened: false };
    scrubFromEvent(event);
  }

  function onTracksPointerMove(event) {
    var drag = state.blockDrag;
    if (drag) {
      var dxSec = (event.clientX - drag.startX) * drag.secondsPerPixel;
      if (Math.abs(event.clientX - drag.startX) > 2) drag.moved = true;
      if (!drag.moved && drag.mode === 'move') return;
      var take = findTake(drag.takeId);
      if (!take) return;
      var dur = takeAudibleDuration(take);
      var minDur = 0.25;
      if (drag.mode === 'move') {
        var newOffset = Math.max(0, Math.min(state.timelineSeconds - dur, drag.startOffset + dxSec));
        drag.el.style.left = (newOffset / state.timelineSeconds * 100) + '%';
        drag.newOffset = newOffset;
      } else if (drag.mode === 'trim-start') {
        // The right edge stays fixed; the left edge (songOffset)
        // and the audio start (trimStart) move together.
        var rightEdge = drag.startOffset + dur;
        var newLeft = Math.max(0, Math.min(rightEdge - minDur, drag.startOffset + dxSec));
        var delta = newLeft - drag.startOffset;
        drag.el.style.left = (newLeft / state.timelineSeconds * 100) + '%';
        drag.el.style.width = ((dur - delta) / state.timelineSeconds * 100) + '%';
        drag.newOffset = newLeft;
        drag.newTrimStart = drag.startTrimStart + delta;
      } else if (drag.mode === 'trim-end') {
        // The left edge (songOffset) stays; the audio end moves.
        var newRight = Math.max(drag.startOffset + minDur, Math.min(state.timelineSeconds, drag.startOffset + dur + dxSec));
        var newTrimEnd = Math.min(take.durationSeconds || 0, drag.startTrimStart + (newRight - drag.startOffset));
        newTrimEnd = Math.max(drag.startTrimStart + minDur, newTrimEnd);
        drag.el.style.width = ((newTrimEnd - drag.startTrimStart) / state.timelineSeconds * 100) + '%';
        drag.newTrimEnd = newTrimEnd;
      }
      return;
    }
    if (!state.scrubbing) return;
    // v29: a mostly-upward swipe on the lanes opens the sound
    // panel (the Voloco gesture) — a sideways scrub never opens it.
    if (state.swipeStart && !state.swipeStart.opened) {
      var dy = event.clientY - state.swipeStart.y;
      var dx = event.clientX - state.swipeStart.x;
      if (dy <= -50 && Math.abs(dx) <= 40) {
        state.swipeStart.opened = true;
        state.scrubbing = false;
        openFxPanel();
        return;
      }
    }
    scrubFromEvent(event);
  }

  function onTracksPointerUp() {
    var drag = state.blockDrag;
    state.blockDrag = null;
    state.swipeStart = null;
    if (drag) {
      var take = findTake(drag.takeId);
      if (take) {
        if (drag.moved) {
          // Commit the drag: move, trim-start, or trim-end.
          if (drag.mode === 'move' && typeof drag.newOffset === 'number') {
            take.songOffsetSeconds = drag.newOffset;
          } else if (drag.mode === 'trim-start' && typeof drag.newOffset === 'number') {
            take.songOffsetSeconds = drag.newOffset;
            take.trimStartSeconds = Math.max(0, drag.newTrimStart);
          } else if (drag.mode === 'trim-end' && typeof drag.newTrimEnd === 'number') {
            take.trimEndSeconds = drag.newTrimEnd;
          }
          saveSessions();
          renderTracks();
          updateTransport();
        } else {
          // A tap: select the block (handles appear) and make it
          // the lane's take, so Play plays the take that was tapped.
          state.selectedBlockId = take.id;
          if (activeTakeOf(drag.track) !== take) setActiveTake(drag.track, take.id);
          renderTracks();
        }
      }
      return;
    }
    state.scrubbing = false;
  }

  // ---------------------------------------------------------------- rendering

  function renderSession() {
    // v33 (QUEUE #115): #song-name (input) and #session-select
    // (dropdown) are gone from Setup — the song name is plain text
    // (#setup-song-name). Song-switching needs a home on the
    // timeline screen (follow-up); Setup only shows the name.
    var nameEl = $('setup-song-name');
    if (nameEl) nameEl.textContent = state.session.name;
    $('topbar-song-name').textContent = state.session.name;
    // v13.2 (item 7): the top bar shows the word "Key", never the
    // key's name — Denasse never has to read "D minor" / "A minor"
    // on the record screen. The key itself still lives in the
    // session (and in the key sheet, which stays Jim-only); tapping
    // the button still opens it.
    $('topbar-song-key').textContent = 'Key';
  }

  /* The song key — set from the key picker (top bar) or from the
   * beat's detected key (Step 9A). `manual` is true when Denasse
   * picked it himself — his pick always wins over the beat's guess
   * from then on. Retunes every live tune node at once (monitor +
   * playback).
   */
  function applyKey(key, manual) {
    // v22 (QUEUE #48): the key cannot change under a live take.
    // The freeze protects the stamp; this keeps the session (and
    // the monitor tune, via broadcastTune) from moving under it.
    // No legitimate caller runs mid-take: the beat Import button
    // is disabled while recording, and the key sheet cannot open.
    if (state.recording) return;
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

  /* v32 (QUEUE #110) — Setup simplify: the mode is two big buttons
   * now (not radios), the cal list + measure box + new-device
   * banner are gone, and the only calibration line left is one
   * short status line (#cal-status-line). The lab test is the
   * measurement — when it saves a calibration, this line says so;
   * when a pair of headphones the app has never seen appears, it
   * points at the test instead of a banner. Called on boot, on
   * every Setup open (showSetup), after a lab run, on a mode
   * change, and when a new device appears.
   */
  function renderCalibration() {
    var mode = PS.store.outputMode();
    var hpBtn = $('mode-headphones-btn');
    var spBtn = $('mode-speaker-btn');
    if (hpBtn) hpBtn.setAttribute('aria-pressed', mode === 'headphones' ? 'true' : 'false');
    if (spBtn) spBtn.setAttribute('aria-pressed', mode === 'speaker' ? 'true' : 'false');
    if (hpBtn) hpBtn.classList.toggle('active', mode === 'headphones');
    if (spBtn) spBtn.classList.toggle('active', mode === 'speaker');
    var note = $('speaker-note');
    if (note) note.style.display = mode === 'speaker' ? '' : 'none';

    var line = $('cal-status-line');
    if (!line) return;
    if (mode === 'speaker') {
      line.textContent = '';
      return;
    }
    // Step 0C — a pair of headphones the app has never seen appeared.
    // One calibration per pair: point at the test that measures it.
    if (state.newDeviceDetected) {
      line.textContent = 'New headphones — tap Test my headphones so your voice lands in time.';
      return;
    }
    var active = activeCalibration();
    line.textContent = active
      ? 'Using ' + active.label + ' — your voice will land in time.'
      : 'Not measured yet — tap Test my headphones.';
  }

  function selectTrack(kind) {
    if (state.selectedTrack === kind) return;
    state.selectedTrack = kind;
    renderTracks();
    updateTransport();
  }

  /* v29 (mockup 12): the timeline — vocal lanes on top (named like
   * a song, colored to match), the beat lane darker and thinner at
   * the bottom, a + Add layer button under the last vocal lane.
   * Every take on a lane is a BLOCK (a DOM region in the lane's
   * color, positioned by its place in the song); tap one to select
   * it, drag it to move it, drag its round handles to trim it.
   * No three-dot menus on the rows — the takes live on their own
   * screen (the Takes button up top), and a block's Delete is on
   * the block itself. */
  /* v40 (QUEUE #124): per-layer volume — a + / − step control ON
   * the layer row itself, tap-based, NOT a slider (Denasse: "that's
   * for you, that's not for me"). One tap moves the layer 25
   * (0..150, default 100 — 100% is the level the layer recorded
   * at). The level lives in the session (session.layerVolumes) so
   * it survives a reload with the layer, and the engine applies it
   * to the layer's own gain node live — a tap while a take plays
   * rebalances what he hears right now. The buttons are real
   * <button>s, so the lane's pointerdown handler (which returns
   * early for buttons) never treats a volume tap as a select or a
   * scrub, and the beat row's import-click never fires from one.
   * PLACEMENT (v40 fix, after the v163 batch caught it): the
   * control is a narrow column at the row's RIGHT edge, AFTER the
   * lane — NOT in the label. The first build stacked it in the
   * label and the label ran ~86 px in a 64 px row, clipping the
   * row name by 11 px (cdp-v133 check 0, in-batch). The label
   * stays at its v13.3 ~60 px (icon + name + sub), and the side
   * column's stacked + / value / − (~52 px) fits the row height
   * without touching the label.
   */
  function layerVolumeControl(kind) {
    var wrap = el('div', 'layer-vol');
    wrap.setAttribute('data-track', kind);
    var name = kind === 'beat' ? 'Beat' : trackName(kind);
    var minus = el('button', 'layer-vol-btn', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', name + ' quieter');
    minus.setAttribute('data-track', kind);
    minus.setAttribute('data-dir', '-1');
    var value = el('span', 'layer-vol-value', String(PS.store.layerVolume(state.session, kind)) + '%');
    value.setAttribute('data-track', kind);
    var plus = el('button', 'layer-vol-btn', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', name + ' louder');
    plus.setAttribute('data-track', kind);
    plus.setAttribute('data-dir', '1');
    [minus, plus].forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        changeLayerVolume(kind, Number(btn.getAttribute('data-dir')));
      });
    });
    wrap.appendChild(minus);
    wrap.appendChild(value);
    wrap.appendChild(plus);
    return wrap;
  }

  function changeLayerVolume(kind, dir) {
    var cur = PS.store.layerVolume(state.session, kind);
    var next = PS.store.setLayerVolume(state.session, kind, cur + dir * 25);
    saveSessions();
    PS.audio.setLayerLevel(kind, next);
    renderTracks();
  }

  /* v40 (QUEUE #124): hand the session's stored per-layer levels
   * to the engine — at boot and on every song switch (renderAll
   * runs both). Levels are remembered before any audio exists, so
   * a layer gain built later starts at its stored level.
   */
  function applyLayerVolumes() {
    PS.audio.setLayerLevels(PS.store.layerVolumes(state.session));
  }

  function renderTracks() {
    var container = $('tracks');
    container.innerHTML = '';
    // v29: the timeline length first — the block positions below
    // are fractions of it, so a take that extends the song must
    // extend the timeline BEFORE the blocks are placed (the old
    // code called updateTimeline after, and the blocks landed on
    // the stale length).
    updateTimeline();
    trackKinds().forEach(function (kind) {
      var vocal = state.session.tracks[kind];
      if (!vocal) return;
      var color = trackColor(kind);
      var row = el('div', 'track-row' + (kind === state.selectedTrack ? ' selected' : ''));
      row.setAttribute('data-track', kind);
      row.style.setProperty('--track-accent', color);
      var label = el('div', 'row-label');
      var name = el('div', 'row-name');
      name.innerHTML = MIC_SVG;
      name.appendChild(document.createTextNode(trackName(kind)));
      label.appendChild(name);
      var active = activeTakeOf(kind);
      label.appendChild(el('div', 'row-sub', active ? takeLabel(active) : ''));
      row.appendChild(label);
      var lane = el('div', 'wave-lane');
      lane.setAttribute('data-lane', kind);
      lane.appendChild(document.createElement('canvas'));
      renderTakeBlocks(lane, kind);
      row.appendChild(lane);
      // v40 (QUEUE #124): the layer's own volume, on the layer row
      // (right edge — NOT in the label; see layerVolumeControl).
      row.appendChild(layerVolumeControl(kind));
      container.appendChild(row);
    });

    // v29: the + Add layer button sits in the lane column, under
    // the last vocal layer — "another voice row here". It adds a
    // vocal lane (Doubles, Harmony, ...) already armed, ready to
    // record. Capped at MAX_TRACKS lanes.
    var addRow = el('div', 'add-layer-row');
    var addBtn = el('button', 'add-layer-btn');
    addBtn.setAttribute('aria-label', 'Add a vocal layer');
    var plus = el('span', 'plus', '+');
    addBtn.appendChild(plus);
    addBtn.appendChild(document.createTextNode('Add layer.'));
    addBtn.disabled = trackKinds().length >= PS.store.MAX_TRACKS;
    addBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      addLayer();
    });
    addRow.appendChild(addBtn);
    container.appendChild(addRow);

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
      // v13.2 (item 7): the tempo shows ("120 BPM" is a number,
      // not theory) but the KEY never shows here — the key lives in
      // the session and the key sheet (Jim-only), never on the
      // record screen. The detector still stores beatKey; the row
      // just does not print it.
      if (typeof state.session.bpm === 'number') beatSub += ' — ' + state.session.bpm + ' BPM';
    } else if (state.beatLoading) {
      beatSub = 'Loading…';
    } else if (state.session.beatOriginalName) {
      beatSub = state.session.beatOriginalName + ' — loading…';
    } else {
      // v29 (mockup 12): the import is obvious — it says MP3.
      beatSub = 'tap to import MP3';
    }
    beatLabel.appendChild(el('div', 'row-sub', beatSub));
    beatRow.appendChild(beatLabel);
    var beatLane = el('div', 'wave-lane');
    beatLane.appendChild(document.createElement('canvas'));
    beatRow.appendChild(beatLane);
    // v40 (QUEUE #124): the beat's own volume, on the beat row —
    // the beat is a layer like the vocals (right edge, not the
    // label — see layerVolumeControl).
    beatRow.appendChild(layerVolumeControl('beat'));
    if (!state.beat) {
      // v31 (mockup 12 fix): no floating "Import a beat" pill over
      // the lane — it covered the beat wave on Denasse's phone. The
      // row's own "tap to import MP3" label is the affordance, and
      // the WHOLE row is the button now: tap anywhere on it to pick
      // a beat. Same guards as the old button (v22 #45: not under a
      // live take; v27 #87: not while another import is loading).
      beatRow.classList.add('no-beat');
      beatRow.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (state.recording || state.beatLoading) return;
        $('beat-file').click();
      });
    }
    if (state.beat) {
      var remove = el('button', 'row-more', '×');
      // v22 (QUEUE #45): the beat cannot change under a live take.
      remove.disabled = !!state.recording;
      remove.setAttribute('aria-label', 'Remove beat');
      remove.addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeBeat();
      });
      beatRow.appendChild(remove);
    }
    container.appendChild(beatRow);

    requestAnimationFrame(function () {
      drawAllWaves();
      drawBlockWaves();
      renderPlayhead();
      renderOverview();
      renderRuler();
    });
    renderLoop(); // the band + ruler text for the loop region, if any
  }

  /* v29: add a vocal lane (the + Add layer button). The new lane
   * gets a song-part name (Doubles, Harmony, ...) and a color, is
   * armed at once (selected, ready to record), and persists in the
   * session. Returns the new kind, or null at the lane cap. */
  function addLayer() {
    if (state.recording) return null;
    var kind = PS.store.addExtraTrack(state.session);
    if (!kind) return null;
    saveSessions();
    state.selectedTrack = kind;
    renderTracks();
    updateTransport();
    return kind;
  }

  /* v29: one block per take on a lane. A block sits at the take's
   * place in the song (songOffsetSeconds) and spans its audible
   * window (trimStart..trimEnd); it carries the take's waveform in
   * the lane's color. The selected block (state.selectedBlockId)
   * grows round trim handles and a Delete button — handles only
   * ever show on the selected block. */
  function renderTakeBlocks(lane, kind) {
    var vocal = state.session.tracks[kind];
    if (!vocal) return;
    var color = trackColor(kind);
    (vocal.takes || []).forEach(function (take) {
      var dur = takeAudibleDuration(take);
      if (dur <= 0) return;
      var block = el('div', 'take-block' + (take.id === state.selectedBlockId ? ' selected' : ''));
      block.setAttribute('data-take-id', take.id);
      block.setAttribute('data-track', kind);
      block.setAttribute('aria-label', trackName(kind) + ' take, ' + fmtClock(take.songOffsetSeconds || 0));
      var leftPct = ((take.songOffsetSeconds || 0) / state.timelineSeconds) * 100;
      var widthPct = (dur / state.timelineSeconds) * 100;
      leftPct = Math.max(0, Math.min(96, leftPct));
      widthPct = Math.max(2, Math.min(100 - leftPct, widthPct));
      block.style.left = leftPct + '%';
      block.style.width = widthPct + '%';
      block.style.background = hexToRgba(color, 0.55);
      block.style.borderColor = color;
      block.appendChild(document.createElement('canvas'));
      if (take.id === state.selectedBlockId) {
        var hL = el('span', 'block-handle left');
        hL.setAttribute('data-handle', 'start');
        var hR = el('span', 'block-handle right');
        hR.setAttribute('data-handle', 'end');
        block.appendChild(hL);
        block.appendChild(hR);
        var menu = el('span', 'block-menu');
        var del = el('button', 'btn-small danger', 'Delete');
        del.setAttribute('aria-label', 'Delete this take');
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          deleteTake(kind, take.id);
        });
        menu.appendChild(del);
        block.appendChild(menu);
      }
      lane.appendChild(block);
    });
  }

  /* v29: draw every block's waveform (the take's peaks for its
   * audible window only — a trimmed block shows only what plays).
   * The lane canvas underneath draws just the dotted baseline now
   * (see drawAllWaves); the blocks carry the sound. */
  function drawBlockWaves() {
    var blocks = document.querySelectorAll('.take-block');
    blocks.forEach(function (block) {
      var take = findTake(block.getAttribute('data-take-id'));
      if (!take) return;
      var canvas = block.querySelector('canvas');
      if (!canvas) return;
      var color = trackColor(block.getAttribute('data-track'));
      var cached = state.waveCache[take.id];
      if (cached) {
        drawBlockWave(canvas, take, cached, color);
      } else {
        getTakeWave(take.id).then(function (entry) {
          if (!entry) return;
          var live = document.querySelector('.take-block[data-take-id="' + take.id + '"] canvas');
          if (live) drawBlockWave(live, take, entry, color);
        });
      }
    });
  }

  function drawBlockWave(canvas, take, wave, color) {
    if (!canvas || !wave || !wave.peaks) return;
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
    var full = wave.duration || 0;
    if (full <= 0) return;
    // Slice the peaks to the audible window [trimStart, trimEnd].
    var from = Math.floor((takeTrimStart(take) / full) * PEAK_BUCKETS);
    var to = Math.max(from + 1, Math.ceil((takeTrimEnd(take) / full) * PEAK_BUCKETS));
    from = Math.max(0, Math.min(PEAK_BUCKETS - 1, from));
    to = Math.max(from + 1, Math.min(PEAK_BUCKETS, to));
    var barW = 2;
    var gap = 1;
    var step = barW + gap;
    var bars = Math.max(1, Math.floor(w / step));
    ctx.fillStyle = color;
    for (var b = 0; b < bars; b++) {
      var pFrom = Math.floor(from + (b / bars) * (to - from));
      var pTo = Math.max(pFrom + 1, Math.floor(from + ((b + 1) / bars) * (to - from)));
      var peak = 0;
      for (var i = pFrom; i < pTo && i < PEAK_BUCKETS; i++) {
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

  // ---------------------------------------------------------------- take sheet

  /* v29 (mockup 12): the takes live on their OWN SCREEN now — a
   * full-screen view, one layer at a time (a tab per vocal lane),
   * opened from the Takes button up top. The ids are unchanged
   * (take-sheet / sheet-title / sheet-list / sheet-close) so the
   * take rows, the "Make a best take" button, and the per-track
   * take counts all work exactly as they did on the sheet. */
  function openTakeSheet(track) {
    // Step 5 (v13.6): one sheet at a time — the takes view takes
    // over from the sound panel (the key sheet is the exception:
    // it opens on top of the panel from the panel's Key button).
    closeFxPanel();
    state.sheetTrack = track || state.selectedTrack || 'lead';
    renderSheet();
    $('take-sheet').style.display = 'flex';
  }

  function closeTakeSheet() {
    state.sheetTrack = null;
    $('take-sheet').style.display = 'none';
  }

  /* Step 3 — the post-record analysis as one plain-words line.
   * v13.2 (item 7): no note names, no key names — "Sings around
   * A3 — most of the notes fit D minor" named both. The take
   * either fits the beat or it does not, and that is all the line
   * says. The stored analysis still carries the dominant note and
   * the key in the metadata (Jim data, in the backup) — the screen
   * never prints them.
   */
  function analysisLine(a) {
    if (!a || !a.dominantNote) {
      if (a && typeof a.voicedFraction === 'number' && a.voicedFraction < 0.1) {
        return 'Mostly quiet — not enough singing to check.';
      }
      return null;
    }
    if (a.inKeyFraction !== null && a.inKeyFraction !== undefined) {
      if (a.inKeyFraction >= 0.95) return 'All of the notes fit the beat.';
      if (a.inKeyFraction >= 0.75) return 'Most of the notes fit the beat.';
      if (a.inKeyFraction >= 0.5) return 'About half the notes fit the beat.';
      return 'Most of the notes fall outside the beat.';
    }
    return null;
  }

  /* Step 3 — this take's own sound, changeable right in its row.
   * The preset and strength save with the take at once; if the
   * take is playing, its sound changes at once, in place (B8,
   * v13.1 — it used to stop and restart from the beginning, so
   * two sounds could never be compared mid-take). The recorded
   * file never changes — these only steer playback.
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
      retuneTakeIfPlaying(take);
    });
    box.appendChild(presetSel);
    var strRow = el('div', 'strength-row');
    strRow.appendChild(el('label', '', 'How much'));
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
      retuneTakeIfPlaying(take);
    });
    strRow.appendChild(strSlider);
    strRow.appendChild(strVal);
    box.appendChild(strRow);
    // Step 4A (v13.4) — the take's own studio sound: five
    // plain-words knobs. They save with the take at once and
    // retune in place while it plays, like the preset and the
    // strength. A take saved before v13.4 shows the song's
    // current knobs until one is moved (takeSound falls back).
    var macroBox = el('div', 'take-macros');
    macroBox.appendChild(el('div', 'take-sound-label', 'Studio sound for this take'));
    MACRO_KEYS.forEach(function (key) {
      var row = el('div', 'strength-row macro-row');
      row.appendChild(el('label', '', MACRO_LABELS[key]));
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(sound.macros[key]);
      slider.setAttribute('aria-label', MACRO_LABELS[key] + ' for Take ' + take.takeNumber);
      var val = el('span', '', sound.macros[key] + '%');
      slider.addEventListener('input', function () {
        if (!take.macros) take.macros = copySessionMacros();
        take.macros[key] = Number(slider.value);
        val.textContent = take.macros[key] + '%';
      });
      slider.addEventListener('change', function () {
        if (!take.macros) take.macros = copySessionMacros();
        take.macros[key] = Number(slider.value);
        saveSessions();
        retuneTakeIfPlaying(take);
      });
      row.appendChild(slider);
      row.appendChild(val);
      macroBox.appendChild(row);
      macroBox.appendChild(el('p', 'muted small macro-hint', MACRO_HINTS[key]));
    });
    box.appendChild(macroBox);
    // Step 4B (v13.5) — "More sound choices": the fine tone
    // controls + one switch per sound part. Collapsed by default
    // so the sheet stays short — the five knobs are the everyday
    // controls; these are for shaping. Everything here saves
    // with the take at once and retunes in place while it plays,
    // like the knobs. The open/closed state survives re-renders
    // (renderSheet rebuilds the list) — one open box per take.
    var moreBtn = el('button', 'btn-small take-more-sound', 'More sound choices');
    moreBtn.setAttribute('aria-expanded', moreSoundOpen[take.id] ? 'true' : 'false');
    moreBtn.setAttribute('aria-label', 'More sound choices for Take ' + take.takeNumber);
    var moreBox = el('div', 'take-more-sound-box');
    moreBox.style.display = moreSoundOpen[take.id] ? 'flex' : 'none';
    moreBtn.addEventListener('click', function () {
      var open = moreBox.style.display === 'none';
      moreBox.style.display = open ? 'flex' : 'none';
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      moreSoundOpen[take.id] = open;
    });
    box.appendChild(moreBtn);
    moreBox.appendChild(el('div', 'take-sound-label', 'Fine tone'));
    TONE_KEYS.forEach(function (key) {
      var row = el('div', 'strength-row macro-row');
      row.appendChild(el('label', '', TONE_LABELS[key]));
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'take-tone-slider';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(sound.tone[key]);
      slider.setAttribute('aria-label', TONE_LABELS[key] + ' for Take ' + take.takeNumber);
      var val = el('span', '', sound.tone[key] + '%');
      slider.addEventListener('input', function () {
        if (!take.tone) take.tone = copySessionTone();
        take.tone[key] = Number(slider.value);
        val.textContent = take.tone[key] + '%';
      });
      slider.addEventListener('change', function () {
        if (!take.tone) take.tone = copySessionTone();
        take.tone[key] = Number(slider.value);
        saveSessions();
        retuneTakeIfPlaying(take);
      });
      row.appendChild(slider);
      row.appendChild(val);
      moreBox.appendChild(row);
      moreBox.appendChild(el('p', 'muted small macro-hint', TONE_HINTS[key]));
    });
    moreBox.appendChild(el('div', 'take-sound-label', 'Sound parts'));
    BYPASS_KEYS.forEach(function (key) {
      var label = el('label', 'chain-toggle take-bypass');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      // Checked = the part is ON (unchecked = bypassed/off).
      cb.checked = !sound.bypass[key];
      cb.setAttribute('aria-label', BYPASS_LABELS[key] + ' for Take ' + take.takeNumber);
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + BYPASS_LABELS[key] + ' '));
      label.appendChild(el('span', 'muted', '— ' + BYPASS_HINTS[key]));
      cb.addEventListener('change', function () {
        if (!take.bypass) take.bypass = copySessionBypass();
        take.bypass[key] = !cb.checked;
        saveSessions();
        retuneTakeIfPlaying(take);
      });
      moreBox.appendChild(label);
    });
    box.appendChild(moreBox);
    // v13 — no Speed row here: the tune always runs at the preset's
    // own retune time (Auto), on every take.
    return box;
  }

  // Step 4B (v13.5): which takes have their "More sound choices"
  // box open. Module-level, not on the take — UI state, not sound.
  var moreSoundOpen = {};

  /* B8 (v13.1): a take's sound changes in place while it plays.
   * The live playback node is retuned the way broadcastTune()
   * retunes the song sound — key, preset, strength, speed — so
   * he hears the change at once, mid-take, with no restart and
   * no jump back to the beginning. The worklet only resets its
   * state when the preset actually changes, so a strength tweak
   * is smooth; a preset change gets the B1 10 ms fade, not a
   * click. A take that is not playing needs nothing: its sound
   * is read when playback starts.
   */
  function retuneTakeIfPlaying(take) {
    if (take.id !== state.playingTakeId) return;
    if (!state.playbackTune) return;
    var sound = takeSound(take);
    state.playbackTune.port.postMessage({ type: 'key', key: sound.key });
    state.playbackTune.port.postMessage({ type: 'preset', preset: sound.preset });
    // Step 4B (v13.5): a bypassed Tune posts strength 0 — the
    // same rule as applyChainSettings, so the take plays raw.
    state.playbackTune.port.postMessage({ type: 'strength', value: sound.bypass.tune ? 0 : sound.strength });
    state.playbackTune.port.postMessage({ type: 'speed', value: sound.speed });
    // Step 4A (v13.4): a macro tweak retunes the chain in place
    // too — no reset, the worklet glides to the new settings.
    // Step 4B (v13.5): a bypass or fine-tone tweak rides the same
    // way (setSound carries the take's bypass + tone).
    if (state.playbackChain) state.playbackChain.setSound(sound, false);
  }

  /* v13.2 (item 5) — timestamped notes on a take. A manual "Mark
   * this moment" button shows only while THIS take is playing; the
   * moment is the playhead position at the tap (tickPlayhead keeps
   * it live during playback). Each note is its time + a text box
   * the singer fills in by hand — no automatic judgments, no pitch
   * or performance verdicts. Notes live on the take (localStorage)
   * AND in its stored record (IndexedDB), so the backup carries
   * them and they survive a reload.
   */
  function takeNotesBlock(kind, take) {
    var box = el('div', 'take-notes');
    if (!Array.isArray(take.notes)) take.notes = [];
    var isPlaying = take.id === state.playingTakeId;
    if (isPlaying) {
      var mark = el('button', 'btn-small', 'Mark this moment');
      mark.setAttribute('aria-label', 'Mark this moment in Take ' + take.takeNumber);
      mark.addEventListener('click', function () { markNote(take); });
      box.appendChild(mark);
    }
    take.notes.forEach(function (note) {
      var row = el('div', 'take-note');
      row.appendChild(el('span', 'take-note-time', fmtClock(note.timeSeconds)));
      var input = document.createElement('input');
      input.type = 'text';
      input.value = note.text || '';
      input.placeholder = 'What happened here?';
      input.setAttribute('aria-label', 'Note at ' + fmtClock(note.timeSeconds));
      input.addEventListener('change', function () {
        note.text = input.value;
        saveSessions();
        persistNotesToDb(take);
      });
      row.appendChild(input);
      var del = el('button', 'btn-small danger take-note-del', '×');
      del.setAttribute('aria-label', 'Delete note at ' + fmtClock(note.timeSeconds));
      del.addEventListener('click', function () {
        take.notes = take.notes.filter(function (n) { return n !== note; });
        saveSessions();
        persistNotesToDb(take);
        renderSheet();
      });
      row.appendChild(del);
      box.appendChild(row);
    });
    return box;
  }

  function markNote(take) {
    if (!Array.isArray(take.notes)) take.notes = [];
    take.notes.push({ timeSeconds: Math.round(state.playheadSeconds * 100) / 100, text: '' });
    saveSessions();
    persistNotesToDb(take);
    renderSheet();
  }

  /* The take's notes, written back into its stored record so the
   * backup carries them. Fire-and-forget: a failed write leaves
   * the localStorage copy (the live record) untouched.
   */
  function persistNotesToDb(take) {
    if (!take || !take.id) return;
    PS.db.getTake(take.id).then(function (record) {
      if (!record) return;
      record.metadata = record.metadata || {};
      record.metadata.notes = take.notes || [];
      return PS.db.saveTake(record);
    }).catch(function () { /* the localStorage copy is the live one */ });
  }

  /* v28 (QUEUE #66) — the take's own frozen beat + key, in plain
   * words, for its row: "Beat HURDLE — Key E minor", or "No beat —
   * Key E minor" when the take was sung to silence. Read from the
   * take's OWN stamp (frozen at record/arm time), never from live
   * session state — a beat swap or key-pill tap after the take must
   * not rewrite what the row says (the #48 hole, in display form).
   * The display name is beatOriginalName: beatFileName is the
   * normalized 'beat.wav' and can never tell two beats apart, so
   * it is not shown. A take saved before v28 carries no frozen beat
   * identity at all (no beatFileName / beatOriginalName / beatless
   * keys on the list entry) — for those the song's stored beat name
   * is the best available label, as the queue item allows; a v28
   * take with a null name is truthfully beatless and says so.
   */
  function displayBeatName(name) {
    return String(name).replace(/\.(wav|mp3|m4a|aac|ogg|flac)$/i, '');
  }

  function takeIdentityLine(take) {
    var key = take.key || state.session.key;
    var frozen = ('beatFileName' in take) || ('beatOriginalName' in take) || ('beatless' in take);
    var name = take.beatOriginalName || null;
    if (!name && !frozen) name = state.session.beatOriginalName || null;
    // Corner: a frozen take whose name never landed (orphan beat
    // re-attached without one) — the file name is all there is.
    if (!name && take.beatFileName) name = take.beatFileName;
    var beatPart = name ? 'Beat ' + displayBeatName(name) : 'No beat';
    return key ? beatPart + ' — Key ' + key : beatPart;
  }

  function renderSheet() {
    if (!state.sheetTrack) return;
    var kind = state.sheetTrack;
    var vocal = state.session.tracks[kind];
    if (!vocal) return;
    // v29: the takes view has a tab per vocal lane — one layer at
    // a time, like the old sheet, but every lane is one tap away.
    var tabs = $('sheet-tabs');
    if (tabs) {
      tabs.innerHTML = '';
      trackKinds().forEach(function (k) {
        var tab = el('button', 'takes-tab' + (k === kind ? ' active' : ''), trackName(k));
        tab.setAttribute('data-track', k);
        tab.addEventListener('click', function () {
          state.sheetTrack = k;
          renderSheet();
        });
        tabs.appendChild(tab);
      });
    }
    $('sheet-title').textContent = trackName(kind) + ' — Takes';
    var list = $('sheet-list');
    list.innerHTML = '';
    if (vocal.takes.length === 0) {
      list.appendChild(el('p', 'muted', 'No takes yet.'));
      return;
    }
    // Step 6C (v13.3): with two or more takes, offer the best-of
    // editor — pick the best line from each part, stitch one take.
    if (vocal.takes.length >= 2) {
      var compBtn = el('button', 'btn', 'Make a best take');
      compBtn.style.width = '100%';
      compBtn.style.marginBottom = '12px';
      compBtn.addEventListener('click', function () { openCompSheet(kind); });
      list.appendChild(compBtn);
    }
    vocal.takes.slice().reverse().forEach(function (take) {
      var row = el('div', 'take-row');
      var isActive = take.id === vocal.activeTakeId;
      var isPlaying = take.id === state.playingTakeId;
      var isStarred = take.id === vocal.starredTakeId;
      var info = el('div', 'take-info');
      info.appendChild(el('strong', '', takeLabel(take) + (isActive ? ' ✓' : '') + (isStarred ? ' ★' : '')));
      // v13 — the sub-line is plain words only: when it was
      // recorded, whether it was cut short or recovered after the
      // app closed, and whether it sounds muffled. The builder
      // flags (not measured, timing drift, the residual verdict)
      // stay in the take's saved details — a singer does not need
      // to read them on a take.
      var subBits = [fmtTime(take.recordedAt)];
      // v28 (QUEUE #66): the take's own frozen beat + key, first —
      // so two takes sung to different beats/keys can be told apart
      // in the list.
      subBits.push(takeIdentityLine(take));
      // v19 (QUEUE #25): a sent take says so, with the date it went
      // out — so he can tell it from a take that never left the phone.
      // v27 (QUEUE #64): a send older than a day with nothing back
      // says so in plain words — the loop is open at the far end.
      if (take.sentAt) {
        if (isStaleSent(take)) {
          subBits.push('Sent ' + fmtTime(take.sentAt) + ' — nothing came back yet. Re-send it?');
        } else {
          subBits.push('Sent ✓ ' + fmtTime(take.sentAt));
        }
      }
      // Step 6C (v13.3): where the take sits in the song, and what
      // a best-of take was made from — plain words, no segment or
      // sample talk.
      if (take.loopPass) subBits.push('Loop ' + fmtClock(take.songOffsetSeconds || 0) + ' – ' + fmtClock((take.songOffsetSeconds || 0) + (take.durationSeconds || 0)));
      if (take.comp && take.compSources) subBits.push('Made from ' + take.compSources.join(', '));
      if (take.partial) subBits.push(PS.safety.fmtSavedUpTo(take.savedUpToSeconds || 0) + ' — interrupted');
      if (take.recovered) subBits.push('recovered after the app closed');
      if (take.narrowbandWarn) subBits.push('Sounds muffled — your headphones dropped to phone-call mode');
      // v37 (QUEUE #23): a clipped take says so on its own row, next
      // to the muffled line — with the count, so the damage is concrete.
      if (take.clipped) subBits.push('Clipped' + (typeof take.takeClippedSamples === 'number' ? ' — ' + take.takeClippedSamples + ' samples hit the limit' : '') + ' — back off the mic a little');
      // v25 (QUEUE #70): a take with no sound in it says so on
      // its own row — it must never list as an ordinary take.
      if (take.silentTake) subBits.push('No sound in this take — the mic heard nothing');
      // v25 (QUEUE #82): storage failed mid-take — the safety copy
      // is partial, even though the take itself saved from memory.
      if (take.chunkWriteFailed) subBits.push('Storage failed while recording — the safety copy is incomplete');
      // v25 (QUEUE #59): recovered without an at-record sound
      // stamp (old chunks) — the key/preset may not be what he
      // sang in; check before sending.
      if (take.recoveredUnstamped) subBits.push('Recovered without its sound stamp — check the key before sending');
      // v26 (QUEUE #91): the recovered take has a hole — a second
      // went missing mid-take and was filled with silence so the
      // rest stays in time.
      if (take.recoveredGapped) {
        var gapCount = (take.gapSeconds && take.gapSeconds.length) || 1;
        subBits.push('Recovered with a gap in the middle — ' + gapCount +
          (gapCount === 1 ? ' second' : ' seconds') +
          ' missing, filled with silence so the rest stays in time');
      }
      // B9 (v13.1) — the phone processed the mic despite the raw
      // constraints, so the take may sound different from what the
      // app asked for. Said plainly, on the take, not in a log.
      if (take.micProcessed) subBits.push('The phone processed this take — it may sound different');
      if (take.recoveredLate) subBits.push('recovered — may sit slightly late, re-record if it sounds off');
      if (take.unfinished) subBits.push('Saved raw — the finish check failed, re-trim or re-record if it sounds off');
      // v13.2 (item 4) — what mic recorded the take, when the app
      // could tell. Takes saved before v13.2 carry no label and
      // show no Mic line (nothing guessed after the fact).
      if (take.micLabel) subBits.push('Mic: ' + take.micLabel);
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
      // v13.2 (item 5) — timestamped notes on the take.
      row.appendChild(takeNotesBlock(kind, take));
      var actions = el('div', 'take-actions');
      var play = el('button', 'btn-small', isPlaying ? 'Stop' : 'Play');
      play.addEventListener('click', function () {
        if (isPlaying) stopPlayback(); else playTake(take.id);
      });
      var send = el('button', 'btn-small', 'Send');
      send.addEventListener('click', function () { openSendSheet(take.id); }); // v13.7: the choice sheet
      // v27 (QUEUE #64): a stale send gets its own one-tap re-send —
      // the same Send flow (openSendSheet), which re-stamps sentAt
      // on resolve; the server dedupes by take-sha (#1).
      var resend = null;
      if (isStaleSent(take)) {
        resend = el('button', 'btn-small', 'Re-send');
        resend.addEventListener('click', function () { openSendSheet(take.id); });
      }
      // Step 6C (v13.3): one tap keeps this take as the best on
      // the track — the starred take is the default pick for every
      // part of a best-of take. The star is separate from "Use
      // this" (the take in the mix): a best take can be starred
      // without being in use, and vice versa.
      var star = el('button', 'take-star' + (isStarred ? ' starred' : ''), isStarred ? '★ Best' : '☆ Best');
      star.setAttribute('aria-label', 'Keep this ' + (take.loopPass ? 'pass' : 'take') + ' — mark it the best');
      star.addEventListener('click', function () { setStarredTake(kind, take.id); });
      // v13 — no Raw button: the untrimmed recording still ships
      // with the one-tap backup (see backupAllTakes); the button
      // was a builder tool on a singer's screen.
      var use = el('button', 'btn-small', isActive ? 'In use' : 'Use this');
      use.disabled = isActive;
      use.addEventListener('click', function () { setActiveTake(kind, take.id); });
      var del = el('button', 'btn-small danger', 'Delete');
      del.addEventListener('click', function () { deleteTake(kind, take.id); });
      var actionBtns = [play, send];
      if (resend) actionBtns.push(resend);
      actionBtns.push(star, use, del);
      actionBtns.forEach(function (b) { actions.appendChild(b); });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------- Step 6C: comping
  /* The best-of editor: pick the best take for each part of a
   * region, and the app stitches them into one take. The parts are
   * bars when the beat's tempo is known (a bar is 4 beats),
   * otherwise 2-second slices. The region is the loop when one is
   * on, otherwise the whole overlap of the takes. The best take is
   * the default pick for every part; a take only shows on a part
   * it covers end to end. Nothing here touches the original
   * takes — the best-of take is a new take, and he can make as
   * many as he likes and keep the best.
   */

  function compRegion(track) {
    var vocal = state.session.tracks[track];
    var takes = vocal ? vocal.takes : [];
    var start = 0;
    var end = 0;
    if (loopOn()) {
      start = state.session.loop.start;
      end = state.session.loop.end;
    } else {
      takes.forEach(function (t) {
        var tEnd = (t.songOffsetSeconds || 0) + (t.durationSeconds || 0);
        if (tEnd > end) end = tEnd;
      });
    }
    return { start: start, end: end };
  }

  function compSegments(track) {
    var region = compRegion(track);
    var segLen = 2;
    if (typeof state.session.bpm === 'number' && state.session.bpm > 0) {
      segLen = 4 * 60 / state.session.bpm;
    }
    var segments = [];
    var n = Math.max(1, Math.ceil((region.end - region.start) / segLen));
    for (var i = 0; i < n; i++) {
      var a = region.start + i * segLen;
      var b = Math.min(region.start + (i + 1) * segLen, region.end);
      if (b - a < 0.1) break;
      segments.push({ start: a, end: b });
    }
    // The region is rarely an exact number of bars (120.2 BPM
    // makes a 4 s loop 2.003 bars) — the last bar would stop a few
    // milliseconds short of the region's end and the comp would
    // lose them. Stretch the last part to the end instead.
    if (segments.length && region.end - segments[segments.length - 1].end < 0.1) {
      segments[segments.length - 1].end = region.end;
    }
    return segments;
  }

  /* A take covers a part when it spans the whole part. The
   * tolerance is the residual check's own worst case (up to
   * 300 ms trimmed off a pass) — a pass trimmed a little short
   * still covers the part it was sung over; the stitch clamps the
   * slice to what the take actually holds.
   */
  function takeCovers(take, segment) {
    var start = take.songOffsetSeconds || 0;
    var end = start + (take.durationSeconds || 0);
    return start <= segment.start + 0.001 && end >= segment.end - 0.35;
  }

  function defaultCompPick(track, segment) {
    var vocal = state.session.tracks[track];
    if (!vocal) return null;
    var starred = vocal.starredTakeId
      ? vocal.takes.find(function (t) { return t.id === vocal.starredTakeId; }) : null;
    if (starred && takeCovers(starred, segment)) return starred.id;
    var covering = vocal.takes.filter(function (t) { return takeCovers(t, segment); });
    return covering.length ? covering[covering.length - 1].id : null;
  }

  function openCompSheet(track) {
    closeFxPanel();
    state.compTrack = track;
    state.compPicks = {};
    compSegments(track).forEach(function (segment, i) {
      var pick = defaultCompPick(track, segment);
      if (pick) state.compPicks[i] = pick;
    });
    renderCompSheet();
    $('comp-sheet').style.display = 'flex';
  }

  function closeCompSheet() {
    state.compTrack = null;
    state.compPicks = {};
    $('comp-sheet').style.display = 'none';
  }

  function renderCompSheet() {
    var track = state.compTrack;
    if (!track) return;
    var vocal = state.session.tracks[track];
    $('comp-title').textContent = 'Best of — ' + trackName(track);
    var region = compRegion(track);
    $('comp-intro').textContent = 'Pick the best take for each part — the app stitches them into one take. Your takes stay exactly as they are. Part of the song: ' + fmtClock(region.start) + ' – ' + fmtClock(region.end) + '.';
    var list = $('comp-list');
    list.innerHTML = '';
    compSegments(track).forEach(function (segment, i) {
      var part = el('div', 'comp-part');
      var label = el('div', 'comp-part-label', 'Part ' + (i + 1) + ' ');
      label.appendChild(el('span', '', fmtClock(segment.start) + ' – ' + fmtClock(segment.end)));
      part.appendChild(label);
      var picks = el('div', 'comp-picks');
      var covering = vocal.takes.filter(function (t) { return takeCovers(t, segment); });
      if (!covering.length) {
        picks.appendChild(el('p', 'muted small', 'No take covers this part yet.'));
      }
      covering.forEach(function (take) {
        var btn = el('button', 'btn-small comp-pick' + (state.compPicks[i] === take.id ? ' current' : ''), takeLabel(take));
        btn.setAttribute('aria-label', 'Use ' + takeLabel(take) + ' for part ' + (i + 1));
        btn.addEventListener('click', function () {
          state.compPicks[i] = take.id;
          renderCompSheet();
        });
        picks.appendChild(btn);
      });
      part.appendChild(picks);
      list.appendChild(part);
    });
  }

  /* Stitches one sample array per part into a single take, with a
   * 10 ms equal-power crossfade at every join so the seams do not
   * click. Pure (no audio context, no DOM) so the CDP test can
   * call it directly on synthetic parts. pieces: [{ samples:
   * Float32Array }] in part order. Returns a Float32Array.
   */
  function buildCompSamples(pieces, sampleRate) {
    var fade = Math.max(0, Math.round(0.01 * sampleRate));
    var total = 0;
    pieces.forEach(function (p, i) {
      total += p.samples.length;
      if (i > 0) total -= Math.min(fade, p.samples.length);
    });
    var out = new Float32Array(Math.max(0, total));
    var pos = 0;
    pieces.forEach(function (p, i) {
      var samples = p.samples;
      if (i === 0) {
        out.set(samples, 0);
        pos = samples.length;
        return;
      }
      var n = Math.min(fade, samples.length, pos);
      // Crossfade the first n samples of this part with the last
      // n of what is already written (equal-power: cos/sin).
      for (var j = 0; j < n; j++) {
        var t = n <= 1 ? 1 : j / (n - 1);
        var gOut = Math.cos(t * Math.PI / 2);
        var gIn = Math.sin(t * Math.PI / 2);
        out[pos - n + j] = out[pos - n + j] * gOut + samples[j] * gIn;
      }
      out.set(samples.subarray(n), pos);
      pos += samples.length - n;
    });
    return out.subarray(0, pos);
  }

  /* Builds the best-of take from the editor's picks: loads each
   * picked take's aligned audio, slices the part out of it (a pass
   * starts at its place in the song, so the part's samples are
   * offset by songOffsetSeconds), stitches, and saves the result
   * as a new take. The originals are never touched — a best-of
   * take is a take like any other, and he can make several and
   * keep the best. The new take becomes the take in use, like the
   * newest take after a record.
   */
  function buildComp(track) {
    if (!track) track = state.compTrack;
    if (!track) return Promise.resolve(null);
    var vocal = state.session.tracks[track];
    var segments = compSegments(track);
    var sr = PS.audio.sampleRate();
    var jobs = segments.map(function (segment, i) {
      var takeId = state.compPicks[i];
      var take = takeId ? vocal.takes.find(function (t) { return t.id === takeId; }) : null;
      if (!take) return Promise.resolve(null);
      return PS.db.getTake(takeId).then(function (record) {
        if (!record || !record.alignedWav) return null;
        return record.alignedWav.arrayBuffer().then(function (buf) {
          return PS.audio.decodeAudio(buf);
        }).then(function (buffer) {
          var offset = take.songOffsetSeconds || 0;
          var from = Math.max(0, Math.round((segment.start - offset) * sr));
          var to = Math.min(buffer.length, Math.round((segment.end - offset) * sr));
          if (to - from < Math.round(0.1 * sr)) return null;
          // v22 (QUEUE #45/#46/#48): carry the piece's stamped
          // metadata so the comp can inherit its beat/key from the
          // takes it is made of, never from live session state.
          return { samples: buffer.getChannelData(0).subarray(from, to), take: take, meta: record.metadata };
        });
      }).catch(function () { return null; }); // a missing take never kills the comp
    });
    return Promise.all(jobs).then(function (pieces) {
      var good = pieces.filter(function (p) { return p !== null; });
      if (!good.length) {
        showError('Nothing to stitch yet — pick a take for at least one part.');
        return null;
      }
      // v22 (QUEUE #45/#46/#48): the comp's beat + sound come from
      // its pieces' own stamps when EVERY piece agrees — the pieces
      // are saved takes, each frozen at its own record start. When
      // the pieces disagree (different beats/keys across takes) there
      // is no single truthful value, so the comp keeps the song's
      // current stamp (today's behavior) — a first-piece or majority
      // pick would be a guess, and the stamp must never guess.
      // beatless is true only when every piece carries the marker.
      function unanimousPiece(field) {
        var val = (good[0].meta || {})[field];
        for (var i = 1; i < good.length; i++) {
          if (((good[i].meta || {})[field]) !== val) return { agree: false, value: null };
        }
        return { agree: true, value: (val === undefined ? null : val) };
      }
      function pieceStamp(field, fallback) {
        var u = unanimousPiece(field);
        return u.agree ? u.value : fallback;
      }
      var compBeatFileName = pieceStamp('beatFileName', state.session.beatFileName || null);
      var compBeatOriginalName = pieceStamp('beatOriginalName', state.session.beatOriginalName || null);
      var compBeatSha256 = pieceStamp('beatSha256', state.session.beatSha256 || null);
      var compBeatBpm = pieceStamp('beatBpm', state.session.beatBpm || null);
      var compBeatBpmAlt = pieceStamp('beatBpmAlt', state.session.beatBpmAlt || null);
      // v24 (QUEUE #53): the beat's rate, from the pieces when they
      // agree, else the song's currently loaded beat (or null).
      var compBeatSampleRate = pieceStamp('beatSampleRate', state.beat ? state.beat.sampleRate : null);
      var compKey = pieceStamp('key', state.session.key);
      var compPreset = pieceStamp('preset', state.session.preset);
      var compStrength = pieceStamp('strength', state.session.strength);
      var compBeatless = good.every(function (p) { return (p.meta || {}).beatless === true; });
      var composite = buildCompSamples(good, sr);
      var durationSeconds = composite.length / sr;
      var region = compRegion(track);
      var compNumber = 1;
      vocal.takes.forEach(function (t) {
        if (t.comp && t.compNumber >= compNumber) compNumber = t.compNumber + 1;
      });
      var takeNumber = vocal.takes.length + 1;
      var takeId = PS.store.newId();
      var baseName = takeFileBase(state.session.name, track, takeNumber, takeId);
      var sources = good.map(function (p) {
        return { takeId: p.take.id, takeNumber: p.take.takeNumber, label: takeLabel(p.take) };
      });
      var metadata = {
        trackKind: track,
        rawFileName: baseName + '-raw.wav',
        alignedFileName: baseName + '.wav',
        sampleRate: sr,
        // v13.8-light: the comp inherits its song's beat — the
        // server render matches on this, never guesses.
        // v22 (QUEUE #45/#46): from the pieces' own stamps when
        // they agree, else the song's current stamp (see above).
        beatFileName: compBeatFileName,
        beatSha256: compBeatSha256,
        beatOriginalName: compBeatOriginalName,
        beatless: compBeatless,
        // v20 (QUEUE #41): the beat's tempo travels with the take —
        // the server renders the echo on this grid, never the
        // hardcoded 135. Nulls when there was no beat (or no tempo
        // detected yet); beatBpmAlt is the half/double partner.
        beatBpm: compBeatBpm,
        beatBpmAlt: compBeatBpmAlt,
        // v24 (QUEUE #53): the beat's rate.
        beatSampleRate: compBeatSampleRate,
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
        residualVerdict: 'comp',
        calibrationDeviceUID: null,
        calibrationLabel: null,
        calibrationDeviceName: null,
        calibrationDate: null,
        calibrated: false,
        compensationSource: 'comp',
        interrupted: false,
        chunkCount: 0,
        savedUpToSeconds: durationSeconds,
        micSettings: null,
        echoCancellationOff: null,
        micProcessed: false,
        micLabel: null,
        narrowbandWarn: false,
        narrowbandFractionAbove7k5: null,
        takeBandwidthHz: null,
        takeRmsDb: null,
        outputLatencySeconds: null,
        outputLatencyAtStartSeconds: null,
        calibrationOutputLatencySeconds: null,
        outputLatencyDrift: false,
        recordedAt: new Date().toISOString(),
        appVersion: 'pwa-1.1',
        // v22 (QUEUE #48): from the pieces' stamps when they agree.
        preset: compPreset,
        strength: compStrength,
        speed: state.session.speed,
        key: compKey,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        notes: [],
        // Step 6C (v13.3): a best-of take lives at the region it
        // was made from, and remembers what it was made from.
        songOffsetSeconds: region.start,
        loopPass: false,
        comp: true,
        compNumber: compNumber,
        compSources: sources,
        compRegionStart: region.start,
        compRegionEnd: region.end
      };
      var wav = new Blob([PS.wav.encodeWavFloat32(composite, sr)], { type: 'audio/wav' });
      var takeMeta = {
        id: takeId,
        takeNumber: takeNumber,
        rawFileName: metadata.rawFileName,
        alignedFileName: metadata.alignedFileName,
        recordedAt: metadata.recordedAt,
        calibrated: false,
        delayMilliseconds: 0,
        durationSeconds: durationSeconds,
        residualVerdict: 'comp',
        partial: false,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: false,
        micProcessed: false,
        micLabel: null,
        outputLatencyDrift: false,
        // v22 (QUEUE #48): from the pieces' stamps when they agree.
        // v28 (QUEUE #66): the frozen beat identity rides on the
        // list entry too (comp — the pieces' name when they agree).
        preset: compPreset,
        strength: compStrength,
        speed: state.session.speed,
        key: compKey,
        beatFileName: compBeatFileName,
        beatOriginalName: compBeatOriginalName,
        beatless: compBeatless,
        macros: copySessionMacros(),
        chainOn: state.session.chainOn,
        bypass: copySessionBypass(),
        tone: copySessionTone(),
        analysis: null,
        notes: [],
        songOffsetSeconds: region.start,
        loopPass: false,
        comp: true,
        compNumber: compNumber,
        compSources: sources.map(function (s) { return s.label; })
      };
      return PS.db.saveTake({
        id: takeId,
        sessionId: state.session.id,
        track: track,
        takeNumber: takeNumber,
        rawWav: wav,
        alignedWav: wav,
        metadata: metadata,
        recordedAt: metadata.recordedAt
      }).then(function () {
        vocal.takes.push(takeMeta);
        vocal.activeTakeId = takeId;
        saveSessions();
        closeCompSheet();
        renderTracks();
        renderSheet();
        updateTransport();
        runTakeAnalysis(takeMeta, metadata, composite, sr, track, takeId, wav, wav);
        if (durationSeconds >= 2) playTake(takeId);
        return takeMeta;
      });
    }).catch(function (err) {
      console.warn('Best-of take failed:', err);
      showError('That best-of take could not be made — try again.');
      return null;
    });
  }

  // ---------------------------------------------------------------- key picker

  /* The key, one tap from the studio screen: tap the key in the top
   * bar, tap a key, done. (Voloco puts Key top-right on the effects
   * screen; ours is in the top bar, always visible.)
   */
  function openKeySheet() {
    // v22 (QUEUE #48): the key cannot change under a live take —
    // the pills go quiet while recording too (updateTransport);
    // the freeze is the real fix, this keeps the session from
    // moving under it (and the monitor from retuning mid-take).
    if (state.recording) return;
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
    // B7 (v13.1): the grid-offset nudge is hidden until the Phase 4
    // mixer exists — it stored a number nothing used yet, and the
    // "First hit lands 0.123s in." readout was builder notation on
    // a singer's screen. The offset is still detected and stored
    // (see detectBeatKeyTempo) for the mixer to use later.
  }

  /* Step 9A — nudge where the grid starts, 10 ms at a time. The
   * mixer in Phase 4 lines the vocals up to it; v12 only stores
   * the choice. v13.1: no UI calls this until the mixer exists.
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
  /* v13.2 (item 7) — the sound strip is plain words now: three
   * full-phrase sound buttons, a "Fun sounds" row, and "How much".
   * The buttons keep the .preset-pill class (and all five stay
   * inside #preset-pills) so the existing boot checks still count
   * five. Each button carries data-preset so a test (or a finger)
   * picks by sound, not by label text.
   */
  function renderPresetStrip() {
    var pills = $('preset-pills');
    pills.innerHTML = '';
    SOUND_MAIN.forEach(function (sound) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'preset-pill sound-btn' + (state.session.preset === sound.id ? ' current' : '');
      pill.textContent = sound.text;
      pill.setAttribute('data-preset', sound.id);
      pill.setAttribute('aria-label', sound.text);
      pill.setAttribute('aria-pressed', state.session.preset === sound.id ? 'true' : 'false');
      pill.addEventListener('click', function () { setSound(sound.id); });
      pills.appendChild(pill);
    });
    pills.appendChild(el('span', 'fun-label', 'Fun sounds'));
    SOUND_FUN.forEach(function (sound) {
      var preset = PRESETS.filter(function (p) { return p.id === sound.id; })[0];
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'preset-pill' + (state.session.preset === sound.id ? ' current' : '');
      pill.textContent = sound.text;
      pill.setAttribute('data-preset', sound.id);
      pill.setAttribute('aria-label', preset ? preset.label : sound.text);
      pill.setAttribute('aria-pressed', state.session.preset === sound.id ? 'true' : 'false');
      pill.addEventListener('click', function () { setPreset(sound.id); });
      pills.appendChild(pill);
    });
    var slider = $('strength-slider');
    slider.value = String(state.session.strength);
    slider.disabled = state.session.preset === 'clean';
    $('strength-value').textContent = state.session.strength + '%';
    // v40 (QUEUE #124): the master Volume slider is gone — Denasse
    // refuses sliders, and the phone's hardware buttons are the
    // overall volume now. (Speed is gone — the tune always runs at
    // the preset's own retune time now.)
  }

  /* v13.2 (item 7) — one tap sets the whole sound: the preset AND
   * full strength (Hard and Natural are the full sound; Clean
   * leaves strength alone — its slider is greyed out anyway).
   * Tapping the sound he is already on still applies the strength,
   * so "Hard" always means the full hard sound.
   */
  function setSound(id) {
    if (PRESET_IDS.indexOf(id) === -1) return;
    if (id === 'hard' || id === 'natural') state.session.strength = 100;
    if (state.session.preset === id) {
      saveSessions();
      broadcastTune();
      renderPresetStrip();
      return;
    }
    setPreset(id);
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
    // Step 5 (v13.6): the record screen's slider follows too —
    // the panel's slider sets the same strength, and the two
    // sliders must never disagree about it.
    $('strength-slider').value = String(v);
    broadcastTune();
  }

  // v40 (QUEUE #124): setVolume is gone with the master slider —
  // per-layer volume lives in changeLayerVolume / the layer gains.
  // ---------------------------------------------------------------- effects screen (Step 5, v13.6)
  //
  // One screen where the whole sound lives — the preset row, the
  // 5-slot chain strip, the live waveform, the strength slider,
  // the Key button, and the One Knob macros. It slides up over the
  // studio like Voloco's Edit sheet (see voloco-effects-hardtune).
  // Everything here edits the SONG's sound (the next take); a take
  // already made keeps its own stamped sound. Changes retune the
  // live chains at once through broadcastTune, same as Setup, so
  // he hears them while he sings. The Key button opens the key
  // sheet on top of the panel; closing the key sheet drops back
  // to the panel.

  function fxModuleOn(mod) {
    var bypass = state.session.bypass;
    return mod.stages.every(function (s) { return !bypass[s]; });
  }

  function buildFxStrip() {
    var strip = $('fx-strip');
    strip.innerHTML = '';
    fxSlots = [];
    FX_MODULES.forEach(function (mod) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fx-slot';
      btn.setAttribute('data-module', mod.id);
      btn.innerHTML = mod.icon + '<span>' + mod.label + '</span>';
      btn.setAttribute('aria-label', mod.label + ' — turn the whole part off or on');
      btn.addEventListener('click', function () { toggleFxModule(mod); });
      strip.appendChild(btn);
      fxSlots.push(btn);
    });
  }

  function toggleFxModule(mod) {
    // With the whole sound off the parts are inert — the switch
    // above the strip is the way back on, and every part keeps
    // its settings underneath.
    if (!state.session.chainOn) return;
    var on = fxModuleOn(mod);
    mod.stages.forEach(function (s) { state.session.bypass[s] = on; });
    saveSessions();
    broadcastTune();
    renderFxPanel();
  }

  /* v29: renderFxPills is gone — it was a copy of renderPresetStrip
   * (same pills, same order). The sound strip lives in the fx
   * panel now, so the panel renders the one strip (pills +
   * strength + volume) through renderPresetStrip. */
  function renderFxPanel() {
    var panel = $('fx-panel');
    if (!panel) return;
    renderPresetStrip();
    // v13.2 (item 7): the button reads "Key", never the key's
    // name — same rule as the top bar. The key sheet itself is
    // the only place the name shows.
    $('fx-chain-on').checked = state.session.chainOn;
    // The room-noise cut is its own switch (checked = the cut is
    // ON, bypass off) — same as Setup's.
    $('fx-nr').checked = !state.session.bypass.nr;
    FX_MODULES.forEach(function (mod, i) {
      var btn = fxSlots[i];
      if (!btn) return;
      var on = state.session.chainOn && fxModuleOn(mod);
      btn.classList.toggle('off', !on);
      btn.disabled = !state.session.chainOn;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    MACRO_KEYS.forEach(function (key) {
      var s2 = $('fx-macro-' + key);
      var val = $('fx-macro-' + key + '-value');
      if (!s2) return;
      s2.value = String(state.session.macros[key]);
      if (val) val.textContent = state.session.macros[key] + '%';
    });
    TONE_KEYS.forEach(function (key) {
      var s2 = $('fx-tone-' + key);
      var val = $('fx-tone-' + key + '-value');
      if (!s2) return;
      s2.value = String(state.session.tone[key]);
      if (val) val.textContent = state.session.tone[key] + '%';
    });
  }

  /* The panel's wave: live while he sings (record or monitor —
   * the same rolling peaks as the record strip), otherwise the
   * selected track's take, otherwise a flat line that says so.
   * The mic is never opened for the panel — it only draws what
   * the app is already hearing or has already saved (v11: the
   * mic opens only while a take is recording).
   */
  function drawFxWave() {
    var panel = $('fx-panel');
    if (!panel || panel.style.display === 'none') return;
    var canvas = $('fx-wave');
    if (!canvas) return;
    if (state.recording || state.monitorOn) {
      drawLivePeaksInto(canvas);
      $('fx-wave-hint').textContent = 'Your voice, live.';
      return;
    }
    var take = activeTakeOf(state.selectedTrack);
    if (!take) {
      drawWave(canvas, null, '#a78bfa');
      $('fx-wave-hint').textContent = 'Sing to see your voice move here.';
      return;
    }
    var label = trackName(state.selectedTrack);
    $('fx-wave-hint').textContent = 'Your last take on ' + label + '.';
    drawWave(canvas, null, '#a78bfa'); // baseline until the peaks arrive
    getTakeWave(take.id).then(function (wave) {
      if ($('fx-panel').style.display === 'none') return;
      if (state.recording || state.monitorOn) {
        drawLivePeaksInto(canvas);
        return;
      }
      if (wave) drawWave(canvas, wave, '#a78bfa');
    });
  }

  function openFxPanel() {
    renderFxPanel();
    $('fx-panel').style.display = 'flex';
    drawFxWave();
  }

  function closeFxPanel() {
    $('fx-panel').style.display = 'none';
  }

  function renderAll() {
    renderSession();
    renderCalibration();
    renderTracks();
    renderPresetStrip();
    applyLayerVolumes(); // v40 (QUEUE #124): the song's per-layer levels to the engine — boot + song switch
    updateIdeasUI();
    // v33 (QUEUE #115): #wake-note (the screen-lock warning) is
    // gone from Setup — Setup shows only the song, the sound and
    // the headphones. Guard it so a missing element can't break
    // the whole render (renderAll runs on boot and every session
    // change).
    var wakeNote = $('wake-note');
    if (wakeNote) wakeNote.style.display = state.wakeLockSupported ? 'none' : '';
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
    // v25 (QUEUE #85): the record button stays greyed out while a
    // beat is loading (boot or song switch) — a tap in that window
    // used to sing with no beat while the take stamped the beat.
    rec.disabled = busy || state.startingTake || state.beatLoading;
    rec.classList.toggle('recording', !!state.recording);
    rec.setAttribute('aria-label', state.recording ? 'Stop' : 'Record');
    // v39 (QUEUE #123): Play stays tappable with no take and no beat —
    // a tap while the beat loads waits for it, a tap on a beatless
    // song says so in plain words (playSelected). A disabled button
    // can never explain itself, and that was the dead Play on first
    // start. It still disables while recording, calibrating, or
    // while a Play tap is waiting for the load (transient).
    play.disabled = busy || !!state.recording || !!state.playWaiting;
    play.innerHTML = playing ? STOP_SVG : PLAY_SVG;
    play.setAttribute('aria-label', playing ? 'Stop' : 'Play');
    // v31 (mockup 12 fix): the Send button left the transport bar
    // (Send lives on the takes screen now) — the share element is
    // gone, so guard the reference instead of throwing on null.
    if (share) share.disabled = !take;
    rewind.disabled = !!state.recording;
    // v22 (QUEUE #48): the key sheet cannot open mid-take.
    $('topbar-key').disabled = !!state.recording;
    $('fx-key').disabled = !!state.recording;
    phones.classList.toggle('active', state.monitorOn);
    updateIdeasUI();
  }

  // ---------------------------------------------------------------- views

  /* Step 4A (v13.4): the song's studio sound — five knobs + the
   * chain switch + the room-noise cut. Values always show the
   * song's current settings. The slow-route note appears only
   * when the measured headphones are Bluetooth-like (the live
   * monitor stays off on those — the tune still works on
   * playback, and the card says so in plain words).
   */
  /* v33 (QUEUE #115) — renderChainCard is gone with the Setup
   * controls: it synced the three sound toggles (#chain-on /
   * #chain-nr / #light-live) that Denasse rejected ("I don't want
   * to see no buttons at all"). Its only caller was showSetup.
   * The sound is always the champion recipe now (macros/tone all
   * 50, all 8 parts on, noise cut off — the session defaults),
   * and the pipeline reads the session, not the DOM. The per-part
   * controls still exist on the studio screen's sound strip
   * (renderFxPanel) and the take sheet.
   */

  function showSetup() {
    $('studio-view').style.display = 'none';
    $('setup-view').style.display = 'flex';
    // v33 (QUEUE #115): Setup is one read-only screen — no
    // controls, no scroll. The song name, the sound and the
    // headphones are plain text; the system handles them. Nothing
    // here is tappable except Back. (Denasse, Nov 27: "I don't
    // want to see no buttons at all... You go to Voloco on the
    // studio there's no scrolling.")
    var nameEl = $('setup-song-name');
    if (nameEl) nameEl.textContent = state.session.name || 'New Song';
    var soundEl = $('setup-sound-status');
    if (soundEl) soundEl.textContent = state.session.chainOn ? 'Full studio sound' : 'Light live sound';
    var hpEl = $('setup-headphones-status');
    if (hpEl) hpEl.textContent = PS.store.outputMode() === 'speaker' ? 'Phone speaker' : 'Headphones';
  }

  /* v32 (QUEUE #110) — renderPerfReadout is gone with the Setup
   * simplify: the diagnostic "Speed check" line is not something
   * he reads (he is not an engineer), and the perf probe itself
   * (PS.perfReport, for the CDP harness) is untouched.
   */

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
    // v33 (QUEUE #115) — the Setup sound toggles (#chain-on /
    // #chain-nr / #light-live) are gone: Denasse rejected every
    // button and check on Setup. The sound is always the champion
    // recipe (macros/tone all 50, all 8 parts on, noise cut off —
    // the session defaults) and the pipeline reads the session.
    // An unguarded .addEventListener on a null element throws and
    // would kill the whole wire(), so these listeners go with the
    // elements. The same controls still exist on the studio
    // screen's sound strip and the take sheet, wired by their own
    // builders. (The v32 fine-tone/macro wire loops were already
    // removed the same way.)
    $('transport-record').addEventListener('click', function () {
      if (window.PSPerf) PSPerf.mark('record-tap');
      if (state.recording) stopTakeRequest();
      else startTakeRequest(state.selectedTrack);
    });
    $('transport-play').addEventListener('click', playSelected);
    $('transport-rewind').addEventListener('click', function () {
      if (state.playingStop) stopPlayback();
      setPlayhead(0);
    });
    // v31 (mockup 12 fix): the Send button left the transport bar —
    // the element is gone, so only bind it if it exists. (The
    // per-take Send on the takes screen is the Send flow now.)
    var shareBtn = $('transport-share');
    if (shareBtn) shareBtn.addEventListener('click', shareSelected);
    $('transport-headphones').addEventListener('click', toggleMonitor);
    // v29: tap the overview strip to jump the line there — the
    // whole song at a glance, one tap to anywhere in it.
    $('overview-strip').addEventListener('pointerdown', function (event) {
      if (state.recording) return;
      var rect = $('overview-strip').getBoundingClientRect();
      if (rect.width <= 0) return;
      var frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      if (state.playingStop) stopPlayback();
      setPlayhead(frac * state.timelineSeconds);
    });
    // Strength slider: live while dragging (he hears it change),
    // saved when he lets go.
    $('strength-slider').addEventListener('input', function () {
      setStrength(Number(this.value));
    });
    $('strength-slider').addEventListener('change', function () {
      setStrength(Number(this.value));
      saveSessions();
    });
    // v40 (QUEUE #124): the master Volume slider is gone — no
    // listeners, no element. Per-layer volume is the + / − on
    // each layer row (changeLayerVolume), and the overall volume
    // is the phone's hardware buttons.
    $('sheet-close').addEventListener('click', closeTakeSheet);
    // v29: the takes view is a full screen, not a sheet — there is
    // no backdrop to tap, so the backdrop-click-to-close listener
    // is gone (tapping empty space in the view must not close it).
    // The Takes button up top opens it, on the selected layer.
    $('takes-open').addEventListener('click', function () {
      openTakeSheet(state.selectedTrack);
    });
    // v13.7 — the send choice sheet: the X, a tap on the dimmed
    // backdrop, and the two choices. The buttons read the take the
    // sheet was opened for; tapping either twice is safe (the
    // buttons disable while the smaller copy is being made).
    $('send-close').addEventListener('click', closeSendSheet);
    $('send-sheet').addEventListener('click', function (event) {
      if (event.target === $('send-sheet')) closeSendSheet();
    });
    $('send-small').addEventListener('click', function () {
      if (pendingSendTakeId) sendSmallCopy(pendingSendTakeId);
    });
    $('send-full').addEventListener('click', function () {
      if (pendingSendTakeId) sendFullQuality(pendingSendTakeId);
    });
    $('topbar-key').addEventListener('click', openKeySheet);
    $('key-sheet-close').addEventListener('click', closeKeySheet);
    // Step 5 (v13.6): the sound panel — the Sound button in the
    // top bar, the close button, a tap on the dimmed backdrop, and
    // a swipe down on the panel's head. The Key button opens the
    // key sheet on top of the panel.
    buildFxStrip();
    $('fx-open').addEventListener('click', openFxPanel);
    $('fx-close').addEventListener('click', closeFxPanel);
    $('fx-panel').addEventListener('click', function (event) {
      if (event.target === $('fx-panel')) closeFxPanel();
    });
    $('fx-key').addEventListener('click', openKeySheet);
    // v29: the panel's strength slider is the record screen's
    // #strength-slider now (the strip moved into the panel, and
    // the panel's own #fx-strength is gone) — its listeners are
    // the record screen's ones, which keep working (same ids, new
    // home). No separate panel slider to wire.
    // The whole-sound switch: same as Setup's — off parks the
    // chain, and the five parts go quiet with it (their settings
    // stay underneath).
    $('fx-chain-on').addEventListener('change', function () {
      state.session.chainOn = $('fx-chain-on').checked;
      saveSessions();
      broadcastTune();
      renderFxPanel();
    });
    // The room-noise cut: its own switch, same as Setup's —
    // checked means the cut is ON (bypass off).
    $('fx-nr').addEventListener('change', function () {
      state.session.bypass.nr = !$('fx-nr').checked;
      saveSessions();
      broadcastTune();
    });
    MACRO_KEYS.forEach(function (key) {
      var slider = $('fx-macro-' + key);
      var val = $('fx-macro-' + key + '-value');
      slider.addEventListener('input', function () {
        state.session.macros[key] = Number(slider.value);
        if (val) val.textContent = slider.value + '%';
      });
      slider.addEventListener('change', function () {
        state.session.macros[key] = Number(slider.value);
        saveSessions();
        broadcastTune();
      });
    });
    TONE_KEYS.forEach(function (key) {
      var slider = $('fx-tone-' + key);
      var val = $('fx-tone-' + key + '-value');
      slider.addEventListener('input', function () {
        state.session.tone[key] = Number(slider.value);
        if (val) val.textContent = slider.value + '%';
      });
      slider.addEventListener('change', function () {
        state.session.tone[key] = Number(slider.value);
        saveSessions();
        broadcastTune();
      });
    });
    // v29: the swipe-up gesture moved to the lanes — a swipe up
    // on the timeline (onTracksPointerMove) opens the panel. The
    // old strip-swipe IIFE is gone with the strip from the main
    // screen.
    // Swipe down on the panel's head closes it.
    (function () {
      var start = null;
      var head = $('fx-head');
      head.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button')) return;
        start = { x: e.clientX, y: e.clientY, closed: false };
      });
      head.addEventListener('pointermove', function (e) {
        if (!start || start.closed) return;
        var dy = e.clientY - start.y;
        var dx = e.clientX - start.x;
        if (dy >= 50 && Math.abs(dx) <= 40) {
          start.closed = true;
          closeFxPanel();
        }
      });
      window.addEventListener('pointerup', function () { start = null; });
      window.addEventListener('pointercancel', function () { start = null; });
    })();
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
    // Step 6C (v13.3): the loop — tap the button to turn it on or
    // off, drag across the ruler to pick the part.
    $('loop-toggle').addEventListener('click', toggleLoop);
    var ruler = document.querySelector('.ruler');
    ruler.addEventListener('pointerdown', onRulerPointerDown);
    ruler.addEventListener('pointermove', onRulerPointerMove);
    window.addEventListener('pointerup', onRulerPointerUp);
    window.addEventListener('pointercancel', onRulerPointerUp);
    // Step 6C (v13.3): the best-of editor.
    $('comp-close').addEventListener('click', closeCompSheet);
    $('comp-sheet').addEventListener('click', function (event) {
      if (event.target === $('comp-sheet')) closeCompSheet();
    });
    $('comp-make').addEventListener('click', function () {
      buildComp(state.compTrack);
    });

    // v33 (QUEUE #115) — the Setup song controls (#song-name
    // input, #session-select dropdown, #new-song button) are gone:
    // Setup shows the song name as plain text and nothing here is
    // tappable. Song-switching needs a home on the timeline screen
    // (follow-up). The session still switches via switchSession()
    // (called from boot / the take sheet); renderSession() keeps
    // the plain-text name in sync.
    $('beat-file').addEventListener('change', function () {
      onBeatFilePicked($('beat-file').files[0]);
      $('beat-file').value = '';
    });
    // v33 (QUEUE #115) — the Setup headphone buttons
    // (#mode-headphones-btn / #mode-speaker-btn) are gone: Setup
    // shows the mode as plain text ("Headphones" / "Phone
    // speaker") and nothing here is tappable. The mode stays
    // whatever is stored (PS.store.outputMode(), default
    // 'headphones'); the audio routing reads it. (The v32
    // two-big-buttons wiring is removed the same way.)
    $('error-dismiss').addEventListener('click', dismissError);
    $('error-retry').addEventListener('click', retryFailedTakeSave);
    // Phase 0 wiring.
    $('lab-back').addEventListener('click', closeLab);
    $('lab-run').addEventListener('click', startLabRun);
    $('ideas-btn').addEventListener('click', toggleIdeas);
    // v33 (QUEUE #115) — #lab-open, #backup-btn and
    // #clear-sent-btn are gone from Setup (no buttons on Setup).
    // The lab view itself stays (openLab/closeLab/startLabRun
    // still exist); backupAllTakes stays in app.js (the Drive
    // auto-return still backs up rendered masters); clearSentTakes
    // stays exposed as PS.clearSentTakes for the CDP tests.
    $('home-banner-dismiss').addEventListener('click', function () {
      PS.store.dismissBanner('home-screen');
      $('home-banner').style.display = 'none';
    });
    $('recover-keep').addEventListener('click', function () { recoverOrphan(true); });
    $('recover-delete').addEventListener('click', function () { recoverOrphan(false); });
    // v32 (QUEUE #110) — the new-device banner is gone; the
    // status line in the headphones card carries the prompt now
    // (renderCalibration), so there is no dismiss button to wire.

    var resizeTimer = null;
    window.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        drawAllWaves();
        renderPlayhead();
        renderLoop();
        renderRuler();
      }, 150);
    });
  }

  function switchSession(id) {
    if (state.recording || state.calibrating) return;
    stopPlayback();
    var session = state.sessions.find(function (s) { return s.id === id; });
    if (!session) return;
    state.session = session;
    state.overdubCache = {}; // v13.8-light: cached overdubs belong to the old song
    PS.store.setCurrentSessionId(id);
    setPlayhead(0);
    broadcastTune(); // the new song may be in a different key, preset, or strength — retune the monitor + playback
    loadBeatForSession().then(function () {
      renderAll();
    });
  }
  PS.switchSession = switchSession; // v33: exposed for the CDP tests (the Setup song dropdown is gone; tests switch songs programmatically)
  PS.newSong = function (name) { // v33: what the Setup #new-song button did — create a song and switch to it live (the button is gone; tests call this)
    var s = PS.store.makeSession(name || 'New Song');
    state.sessions.push(s);
    saveSessions();
    switchSession(s.id);
    return s.id;
  };

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
            // v37 (QUEUE #23): clipping, backfilled from the stored
            // record like the rest — a take whose list entry was
            // lost in a forced close keeps its clip flag on the row.
            clipped: !!m.clipped,
            takePeakDbfs: typeof m.takePeakDbfs === 'number' ? m.takePeakDbfs : null,
            takeClippedSamples: typeof m.takeClippedSamples === 'number' ? m.takeClippedSamples : null,
            outputLatencyDrift: !!m.outputLatencyDrift,
            recovered: !!m.recovered,
            // v28 (QUEUE #66): the frozen beat identity, backfilled
            // from the stored record like the rest — a take whose
            // list entry was lost in a forced close keeps its beat
            // + key on the row after a reload.
            beatFileName: m.beatFileName || null,
            beatOriginalName: m.beatOriginalName || null,
            beatless: !!m.beatless,
            // v21 (QUEUE #19): a take saved raw/unchecked keeps
            // its flag across a reload, so the sheet still says so.
            unfinished: !!m.unfinished,
            loggerRecovery: !!m.loggerRecovery,
            // v25 (QUEUE #70/#82/#59): the finish flags, backfilled
            // from the stored record like the rest.
            silentTake: !!m.silentTake,
            chunkWriteFailed: !!m.chunkWriteFailed,
            recoveredUnstamped: !!m.recoveredUnstamped,
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
            // v25 (QUEUE #59): the take's own macros + chain switch,
            // backfilled from the stored record — a recovered take
            // rebuilt from IDB keeps its sound, not the song's.
            macros: m.macros || null,
            chainOn: typeof m.chainOn === 'boolean' ? m.chainOn : null,
            // Step 4B (v13.5) — the take's own bypasses + fine
            // tone, backfilled from the stored record. Takes saved
            // before v13.5 have none: null means "fall back to the
            // song's sound" (see takeSound).
            bypass: m.bypass || null,
            tone: m.tone || null,
            analysis: m.analysis || null,
            // v13.2 (item 4) — the mic label, backfilled from the
            // stored record. Takes saved before v13.2 have none:
            // null means "unknown, show no Mic line" — nothing
            // guessed after the fact. (item 5) — the notes,
            // backfilled the same way; old takes have none.
            micLabel: m.micLabel || null,
            notes: Array.isArray(m.notes) ? m.notes : [],
            // Step 6C (v13.3) — where the take sits in the song,
            // backfilled from the stored record. Old takes are
            // plain takes at 0. A best-of take keeps its sources
            // as plain labels for the sheet line.
            songOffsetSeconds: typeof m.songOffsetSeconds === 'number' ? m.songOffsetSeconds : 0,
            loopPass: !!m.loopPass,
            passIndex: typeof m.passIndex === 'number' ? m.passIndex : null,
            comp: !!m.comp,
            compNumber: typeof m.compNumber === 'number' ? m.compNumber : null,
            compSources: Array.isArray(m.compSources)
              ? m.compSources.map(function (s) { return typeof s === 'string' ? s : (s.label || ''); }).filter(function (s) { return !!s; })
              : null,
            // v19 (QUEUE #25): the sent stamp, backfilled from the
            // stored record — a take whose list entry was lost in a
            // forced close gets its badge back from IDB on boot.
            sentAt: m.sentAt || null,
            sentVia: m.sentVia || null
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
            // Step 6C (v13.3): the star must point at a take that
            // is still here — a starred take deleted while the app
            // was closed leaves no star behind.
            if (v.starredTakeId && !v.takes.some(function (t) { return t.id === v.starredTakeId; })) {
              v.starredTakeId = null;
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
          if (take) return null;
          // v25 (QUEUE #59): the at-record sound identity, if the
          // take got far enough to write it (first chunk). Absent
          // for takes recorded before v25 — the recovery falls back
          // to the session's fields + flags the take.
          return PS.db.getTakeRecovery(takeId).catch(function () { return null; }).then(function (rec) {
            return {
              takeId: takeId,
              sessionId: byTake[takeId][0].sessionId,
              track: byTake[takeId][0].track,
              rows: byTake[takeId],
              recovery: rec || null
            };
          });
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
    // v26 (QUEUE #91): the span is the first chunk through the
    // last chunk, not the count of chunks present — a hole in the
    // middle used to understate the span by the missing seconds.
    var lastIndex = next.rows[0].index;
    next.rows.forEach(function (r) { if (r.index > lastIndex) lastIndex = r.index; });
    var seconds = PS.safety.chunkedSeconds(lastIndex + 1, sr);
    var gaps = PS.safety.findChunkGaps(next.rows);
    var label = 'Recovered a take from before the app closed — ' +
      PS.safety.fmtSavedUpTo(seconds);
    if (gaps.length) {
      label += ' — ' + gaps.length + (gaps.length === 1 ? ' second' : ' seconds') +
        ' missing in the middle, filled with silence so the rest stays in time';
    }
    $('recover-text').textContent = label + '.';
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
      PS.db.deleteTakeRecovery(next.takeId).catch(function () { /* ignore */ });
      showRecoverBar();
      return;
    }
    var sr = next.rows[0].sampleRate || 48000;
    // v21 (QUEUE #19): the recovery path used to run with zero
    // try/catch — a throw here killed the recovery itself. The
    // chunks stay in IndexedDB, so a failure that cannot be
    // worked around puts this orphan back at the head of the queue
    // and lets Keep try again, instead of dropping it.
    // v26 (QUEUE #91): a hole in the middle of the chunks used to
    // splice silently — the rows after the hole landed one second
    // early against the beat and nothing flagged it.
    // reassembleChunks now fills each missing index with silence
    // so the vocal stays in time; the take is flagged with the gap
    // position (in seconds into the reassembled audio), the same
    // way recoveredUnstamped is flagged.
    var chunkGaps = PS.safety.findChunkGaps(next.rows);
    var recoveredGapped = chunkGaps.length > 0;
    var nominalChunkLen = (next.rows[0] && next.rows[0].data.length) || PS.safety.CHUNK_SAMPLES;
    var gapSeconds = chunkGaps.map(function (idx) { return idx * nominalChunkLen / sr; });
    var samples;
    try {
      samples = PS.safety.reassembleChunks(next.rows.map(function (r) {
        return { index: r.index, data: r.data };
      }));
    } catch (e) {
      state.recoverQueue.unshift(next);
      showError('The recovered take could not be put back together — it is still saved as a recovery. Tap "Keep" to try again.');
      showRecoverBar();
      return;
    }
    var session = state.sessions.find(function (s) { return s.id === next.sessionId; }) || state.session;
    var vocal = session.tracks[next.track];
    if (!vocal) {
      PS.db.deleteTakeChunks(next.takeId).catch(function () { /* ignore */ });
      PS.db.deleteTakeRecovery(next.takeId).catch(function () { /* ignore */ });
      showRecoverBar();
      return;
    }
    var takeNumber = vocal.takes.length + 1;
    // v25 (QUEUE #59): the at-record sound identity for this take
    // (written when the first chunk landed), or null for takes
    // recorded before v25.
    var recovery = next.recovery || null;
    // B4 (v13.1) — a recovered take gets the SAME timing fix a
    // finished take gets, instead of shipping the untrimmed chunks
    // as the "aligned" file (1.2 s of silence up front, the vocal
    // landing late against the beat). The chunks start at the
    // take's first sample, so the lead-in is the fixed 1.2 s
    // anchor delay. Whether pre-comp was on is unknown after a
    // crash, so the base trim is the lead-in only and the residual
    // check measures whatever delay is left — exactly the mechanism
    // finishTake uses for an uncalibrated take. The beat may not
    // be loaded yet, or the orphan may belong to another song —
    // then the timing cannot be verified and the take is flagged
    // in plain words instead of guessed.
    var leadInSamples = Math.round(PS.audio.ANCHOR_DELAY * sr);
    // v21 (QUEUE #19): guarded like finishTake — a failed check
    // falls back to saving the raw chunks untrimmed (flagged
    // unfinished), it never kills the recovery.
    var recoverError = null;
    var residual;
    if (state.beat && state.beat.mono && session.id === state.session.id) {
      // v24 (QUEUE #53): same rate guard as finishTake — a beat at
      // the wrong rate must refuse the check, never verify on
      // mismatched arrays.
      if (state.beat.sampleRate !== sr) {
        residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'unverified-rate-mismatch' };
      } else {
        try {
          residual = PS.residual.verify(samples, state.beat.mono, leadInSamples, sr);
        } catch (e) {
          recoverError = e;
          residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
        }
      }
    } else {
      residual = { trimSamples: 0, residualSeconds: null, onsetCount: 0, verdict: 'no-beat' };
    }
    var trimSamples = Math.max(0, Math.min(leadInSamples + residual.trimSamples, samples.length));
    // Never trim a recovery to nothing: a take killed 1-2 s in has
    // a single chunk, and the lead-in alone would eat it. Keep at
    // least 0.3 s and flag the timing instead — losing the take
    // would defeat the recovery.
    var minKeep = Math.round(0.3 * sr);
    var recoveredLate = residual.verdict === 'no-beat';
    if (trimSamples > samples.length - minKeep) {
      trimSamples = Math.max(0, samples.length - minKeep);
      recoveredLate = true;
    }
    var alignedSamples = samples.subarray(trimSamples);
    var durationSeconds = alignedSamples.length / sr;
    var takeAnalysis;
    try {
      takeAnalysis = PS.routelab.analyzeTake(samples, sr);
    } catch (e) {
      if (!recoverError) recoverError = e;
      takeAnalysis = { narrowbandWarn: false, fractionAbove7k5: null, bandwidthHz: null, rmsDb: null, peakDbfs: null, clippedSamples: null, clipped: false };
    }
    // v25 (QUEUE #70): a recovered take with no sound in it warns
    // the same way — the save .then below reads this after the
    // unfinished case (a failed analysis is unfinished, never silent).
    var silentTake = takeIsSilent(takeAnalysis);
    if (recoverError) {
      // A check failed — save the raw chunks untrimmed.
      trimSamples = 0;
      alignedSamples = samples;
      durationSeconds = alignedSamples.length / sr;
      recoveredLate = true;
    }
    // v18 (QUEUE #20): the recovered take reuses its original take
    // id (the orphan chunks are keyed by it), so its filename is
    // unique to this take even though the take number is recomputed.
    var baseName = takeFileBase(session.name, next.track, takeNumber, next.takeId);
    var metadata = {
      trackKind: next.track,
      rawFileName: baseName + '-raw.wav',
      alignedFileName: baseName + '.wav',
      sampleRate: sr,
      // v25 (QUEUE #59): a recovered take keeps the sound it was
      // recorded with — the at-record recovery record when it
      // exists, the owning session's live fields when it doesn't
      // (old chunks), flagged below so the render never silently
      // tunes it to E minor. The beat leg is the same: the
      // record's beat, not whatever beat the song has now.
      beatFileName: recovery ? recovery.beatFileName : (session.beatFileName || null),
      beatSha256: recovery ? recovery.beatSha256 : (session.beatSha256 || null),
      // v28 (QUEUE #66): the display name rides with the file name —
      // the record's when it exists, the session's when it doesn't
      // (same fallback the beat leg already uses above).
      beatOriginalName: recovery ? recovery.beatOriginalName : (session.beatOriginalName || null),
      // v20 (QUEUE #41): the beat's tempo travels with the take —
      // the server renders the echo on this grid, never the
      // hardcoded 135. Nulls when there was no beat (or no tempo
      // detected yet); beatBpmAlt is the half/double partner.
      beatBpm: recovery ? recovery.beatBpm : (session.beatBpm || null),
      beatBpmAlt: recovery ? recovery.beatBpmAlt : (session.beatBpmAlt || null),
      // v24 (QUEUE #53): the beat's rate at record start — from
      // the record when it exists; the loaded beat's rate
      // otherwise (null when no beat is loaded — the recovery's
      // residual check is 'no-beat' then).
      beatSampleRate: recovery ? recovery.beatSampleRate : (state.beat ? state.beat.sampleRate : null),
      // v25 (QUEUE #59): whether a beat played at all — the
      // record knows; the session fallback is the beat-name test
      // the v22 freeze uses.
      beatless: recovery ? !!recovery.beatless : !session.beatFileName,
      durationSeconds: durationSeconds,
      leadInSamples: leadInSamples,
      delaySamples: residual.trimSamples,
      delayMilliseconds: residual.trimSamples / sr * 1000,
      trimSamples: trimSamples,
      preCompensationActive: null, // unknown after a crash — the trim starts from the lead-in and the residual check measures the rest
      preCompensationDelayMilliseconds: null,
      residualTrimSamples: recoverError ? 0 : residual.trimSamples,
      residualMilliseconds: recoverError ? null : (residual.residualSeconds !== null ? residual.residualSeconds * 1000 : null),
      residualOnsets: recoverError ? 0 : residual.onsetCount,
      residualVerdict: recoverError ? 'unfinished' : residual.verdict,
      // v21 (QUEUE #19): a recovery saved raw because a finish
      // check threw — the sheet says so in plain words.
      unfinished: !!recoverError,
      finishError: recoverError ? String(recoverError && recoverError.message || recoverError) : null,
      calibrationDeviceUID: null,
      calibrationLabel: null,
      calibrationDeviceName: null,
      calibrationDate: null,
      calibrated: false,
      compensationSource: 'recovery',
      interrupted: true,
      recovered: true,
      recoveredLate: recoveredLate,
      chunkCount: next.rows.length,
      savedUpToSeconds: durationSeconds,
      micSettings: null,
      echoCancellationOff: null,
      micProcessed: null, // unknown after a crash — the mic settings were never captured
      // v13.2 (item 4) — what mic recorded the take is unknown
      // after a crash too.
      micLabel: 'input unknown',
      narrowbandWarn: takeAnalysis.narrowbandWarn,
      narrowbandFractionAbove7k5: takeAnalysis.fractionAbove7k5,
      takeBandwidthHz: takeAnalysis.bandwidthHz,
      takeRmsDb: takeAnalysis.rmsDb,
      // v37 (QUEUE #23): clipping at capture — the recovery runs the same analysis.
      takePeakDbfs: takeAnalysis.peakDbfs,
      takeClippedSamples: takeAnalysis.clippedSamples,
      clipped: takeAnalysis.clipped,
      // v25 (QUEUE #70): no sound in the recovered take.
      silentTake: silentTake,
      outputLatencySeconds: null,
      outputLatencyAtStartSeconds: null,
      calibrationOutputLatencySeconds: null,
      outputLatencyDrift: false,
      // v25 (QUEUE #59): the sound this take was sung with — the
      // seven fields the other builders stamp. From the at-record
      // recovery record when it exists; the owning session's
      // fields when it doesn't (flagged below).
      key: recovery ? recovery.key : (session.key || null),
      preset: recovery ? recovery.preset : (session.preset || null),
      strength: recovery ? recovery.strength : (typeof session.strength === 'number' ? session.strength : null),
      macros: recovery ? recovery.macros : (session.macros || null),
      chainOn: recovery ? recovery.chainOn : (typeof session.chainOn === 'boolean' ? session.chainOn : null),
      bypass: recovery ? recovery.bypass : (session.bypass || null),
      tone: recovery ? recovery.tone : (session.tone || null),
      // v25 (QUEUE #59): no at-record stamp survived (old
      // chunks) — the sound + beat fields above are the session's,
      // and the render must never silently tune this take to
      // E minor on their say-so.
      recoveredUnstamped: !recovery,
      // v26 (QUEUE #91): a hole in the chunks — the missing
      // second(s) were filled with silence so the rest of the vocal
      // stays in time; gapSeconds names where each hole starts.
      recoveredGapped: recoveredGapped,
      gapSeconds: gapSeconds,
      recordedAt: new Date().toISOString(),
      appVersion: 'pwa-1.1'
    };
    // v13.2 (item 5) — a recovered take starts with no notes.
    metadata.notes = [];
    // The raw recording stays whole; the lined-up take is the
    // trimmed one (before v13.1 both files were the same
    // untrimmed chunks).
    // v21 (QUEUE #19): the encode allocates ~2× the take in fresh
    // ArrayBuffers — if it throws, the chunks are still in
    // IndexedDB, so put this orphan back at the head of the queue
    // and let Keep try again.
    var rawWav;
    var wav;
    try {
      rawWav = new Blob([PS.wav.encodeWavFloat32(samples, sr)], { type: 'audio/wav' });
      wav = new Blob([PS.wav.encodeWavFloat32(alignedSamples, sr)], { type: 'audio/wav' });
    } catch (encodeErr) {
      state.recoverQueue.unshift(next);
      showError('The recovered take could not be finished — your audio is still saved as a recovery. Tap "Keep" to try again.');
      showRecoverBar();
      return;
    }
    PS.db.saveTake({
      id: next.takeId,
      sessionId: session.id,
      track: next.track,
      takeNumber: takeNumber,
      rawWav: rawWav,
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
        delayMilliseconds: metadata.delayMilliseconds,
        durationSeconds: durationSeconds,
        residualVerdict: recoverError ? 'unfinished' : residual.verdict,
        unfinished: !!recoverError,
        partial: true,
        savedUpToSeconds: durationSeconds,
        narrowbandWarn: takeAnalysis.narrowbandWarn,
        // v37 (QUEUE #23): clipping — the row reads it from here.
        clipped: takeAnalysis.clipped,
        takePeakDbfs: takeAnalysis.peakDbfs,
        takeClippedSamples: takeAnalysis.clippedSamples,
        // v25 (QUEUE #70): no sound in the recovered take.
        // (QUEUE #59): recovered without an at-record stamp.
        silentTake: silentTake,
        recoveredUnstamped: !recovery,
        recoveredGapped: recoveredGapped,
        gapSeconds: gapSeconds,
        micProcessed: null,
        outputLatencyDrift: false,
        recovered: true,
        recoveredLate: recoveredLate,
        // v28 (QUEUE #66): the frozen beat identity, from the
        // recovery metadata — the row reads it from here.
        beatFileName: metadata.beatFileName,
        beatOriginalName: metadata.beatOriginalName,
        beatless: !!metadata.beatless,
        // v25 (QUEUE #59): the sound this take was sung with, so
        // playback uses the frozen sound, not the song's current one.
        preset: metadata.preset,
        strength: metadata.strength,
        key: metadata.key,
        macros: metadata.macros,
        chainOn: metadata.chainOn,
        bypass: metadata.bypass,
        tone: metadata.tone,
        // v13.2 (item 4) — what mic recorded the take is unknown
        // after a crash; (item 5) a recovered take has no notes.
        micLabel: 'input unknown',
        notes: []
      });
      vocal.activeTakeId = next.takeId;
      saveSessions();
      PS.db.deleteTakeChunks(next.takeId).catch(function () { /* ignore */ });
      PS.db.deleteTakeRecovery(next.takeId).catch(function () { /* ignore */ });
      renderTracks();
      renderSheet();
      updateTransport();
      // v25 (QUEUE #70): a silent recovered take warns in plain
      // words, the same as a silent finished take — saved, flagged,
      // never dropped.
      if (silentTake) {
        showError('That take has no sound in it — the mic heard nothing. Check the mic and record it again.');
      }
      // v37 (QUEUE #23): a clipped recovered take warns the same way.
      if (takeAnalysis.clipped) {
        showError('That take clipped — the loudest peaks hit the limit. Back off the mic a little and record it again.');
      }
      showRecoverBar();
    }).catch(function (err) {
      console.warn('Recovery save failed:', err);
      showError('The recovered take could not be saved.');
      showRecoverBar();
    });
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
    // v13.8-light: the heavy modules (tune DSP, key/tempo detect,
    // offline re-tune) parse AFTER first paint, on idle — and the
    // worklets warm up (fetch + compile) off the record tap.
    // Neither blocks the first screen; neither opens the mic.
    if (window.requestIdleCallback) {
      requestIdleCallback(function () { loadHeavyModules().then(function () { warmWorklets(); }); }, { timeout: 2000 });
    } else {
      setTimeout(function () { loadHeavyModules().then(function () { warmWorklets(); }); }, 800);
    }
    // v40 (QUEUE #124): no master volume to hand the engine at
    // boot — the master is fixed at full, and the per-layer levels
    // ride with the session (applyLayerVolumes in renderAll, which
    // runs above). The phone's hardware buttons are the overall
    // volume now.
    // v13.2 (item 8) — read the reference voice when one is
    // present (voice-reference.json next to the app). The loader
    // never throws: no file yet means null. v16: the wiring is
    // DONE — the note landed and EC1/EC2/EC3 passed, so new songs
    // open on Natural / E minor from his voice (store.js +
    // loadSessions backfill). The reference is still held in
    // state.voiceReference for later use.
    if (window.PS && PS.voiceRef) {
      PS.voiceRef.load().then(function (ref) { state.voiceReference = ref; });
    }
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
    // exempt. One non-intrusive banner, dismissible once.
    // v13.2 (item 1) — the first-run headphone-lab banner is gone:
    // record first, check later. The lab still lives in Setup
    // under "Check my setup", and nothing here blocks a take.
    if (!isStandalone() && !PS.store.bannerDismissed('home-screen')) {
      $('home-banner').style.display = 'flex';
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
