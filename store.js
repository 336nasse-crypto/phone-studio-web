/* store.js — localStorage for sessions, take lists, and calibrations.
 *
 * Sessions (songs): one beat + three vocal tracks, like the native
 * SessionStore. Take WAVs live in IndexedDB (see db.js); this file
 * holds only the lightweight metadata.
 *
 * Calibrations: Safari exposes no Bluetooth device identity, so a
 * calibration is stored under a LABEL THE USER TYPES ("my AirPods"),
 * not a device UID. The user picks which headphones they are wearing
 * before a take; the app uses that pair's measured delay.
 *
 * Loads in the browser as window.PS.store.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.store = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SESSIONS_KEY = 'ps.sessions.v1';
  var CURRENT_KEY = 'ps.currentSession.v1';
  var CALIBRATIONS_KEY = 'ps.calibrations.v1';
  var ACTIVE_CAL_KEY = 'ps.activeCalibration.v1';
  var MODE_KEY = 'ps.outputMode.v1'; // 'headphones' | 'speaker'
  var VOLUME_KEY = 'ps.volume.v1'; // playback volume 0-100 (v13)
  var LAB_REPORTS_KEY = 'ps.labReports.v1'; // route-lab reports, keyed by label
  var SEEN_DEVICES_KEY = 'ps.seenDevices.v1'; // audioinput deviceIds seen (Step 0C)
  var BANNER_KEY = 'ps.bannerDismissed.v1'; // which one-time banners were dismissed

  var TRACKS = ['lead', 'adlibs', 'harmonies'];
  var TRACK_NAMES = { lead: 'Lead', adlibs: 'Ad-libs', harmonies: 'Harmonies' };

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // Storage full or unavailable — the caller shows the error.
      throw e;
    }
  }

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  function makeSession(name) {
    var tracks = {};
    TRACKS.forEach(function (kind) {
      // Step 6C (v13.3): starredTakeId is the take marked the best
      // on this track — the default source for every part of a
      // best-of take. One star per track; null means none yet.
      tracks[kind] = { takes: [], activeTakeId: null, starredTakeId: null };
    });
    return {
      id: newId(),
      name: name || 'New Song',
      // v16 (QUEUE #3) — HIS voice defaults. The v13.2 gate is MET:
      // the voice note landed (voice-reference.json, take-2) and
      // EC1/EC2/EC3 settled Natural + E minor (subtle beat hard in
      // both keys; E minor beat D minor in both; take-2 ladder in-key
      // E minor 69.2% vs D minor 60.7%). A new song opens on HIS
      // sound now — never the old Hard / D minor placeholder.
      // The key is settled from the start (keySource 'voice'), so a
      // beat import can never override his voice's key. Strength
      // stays 100; tone and macros are untouched (the reference tone
      // is mic-limited: mid 96.7%, air 0% — it must NOT set EQ).
      key: 'E minor',
      preset: 'natural', // Natural Tune — smooth, keeps his vibrato
      strength: 100, // pitch-correction strength 0-100 (100 = the full snap)
      speed: null, // tune speed 0-100; null = Auto (the preset's own retune time — v11's exact sound)
      // Step 4A (v13.4) — the live chain's One Knob macros, 0-100
      // each. Plain words on screen: Even (keeps loud and quiet
      // parts level), Bright (makes the voice shine), Space (how
      // much room you hear), Punch (makes words hit harder), Warm
      // (rounds the voice out). 50 is the sensible middle. A take
      // stamps the song's macros when it records, like the preset.
      macros: { even: 50, bright: 50, space: 50, punch: 50, warm: 50 },
      chainOn: true, // the full studio sound (not just the tune) — on by default, off on a slow (Bluetooth-like) route
      // Step 4B (v13.5) — per-stage bypasses (true = that part of
      // the studio sound is off) + fine tone controls (0-100,
      // 50 = no change from the macros). A take stamps both when
      // it records, like the macros — so changing the song's sound
      // later never rewrites what a take sounds like. The room-
      // noise cut is off by default (bypass.nr true) — the v13.4
      // nrOn switch, now one entry in the bypass set.
      bypass: { nr: true, tonefix: false, lowcut: false, tune: false, even: false, deess: false, tone: false, echo: false, room: false },
      tone: { rumble: 50, presence: 50, air: 50 },
      keyManuallySet: true, // v16: his voice's key is settled from the start — a beat import never overrides it (QUEUE #3)
      // Step 6C (v13.3): the loop region in song seconds
      // { start, end, on } — null until he drags one on the top
      // bar. Recording with the loop on cycles the part and
      // saves one take per pass.
      loop: null,
      bpm: null,
      beatKey: null, // the key the beat detector heard (Step 9A)
      beatKeyConfidence: 0, // 0..1 — below 0.25 the app says it is not sure
      beatBpm: null, // the tempo the beat detector heard
      beatBpmAlt: null, // its half/double partner (68 <-> 136)
      beatGridOffset: null, // where the first real hit lands, seconds (Step 9A; the mixer uses it in Phase 4)
      keySource: 'voice', // v16: the key came from his measured voice (EC1/EC2/EC3) — 'beat' when from the beat, 'manual' when picked by hand
      beatFileName: null,
      beatSha256: null, // v13.8-light: SHA-256 of the beat file as imported — the take JSON carries it so the server render knows which beat a take belongs to
      beatOriginalName: null,
      beatDuration: null,
      tracks: tracks,
      createdAt: new Date().toISOString()
    };
  }

  function loadSessions() {
    var sessions = readJSON(SESSIONS_KEY, null);
    if (!Array.isArray(sessions) || sessions.length === 0) {
      sessions = [makeSession('New Song')];
      writeJSON(SESSIONS_KEY, sessions);
    }
    return sessions;
  }

  function saveSessions(sessions) {
    writeJSON(SESSIONS_KEY, sessions);
  }

  function currentSessionId() {
    return localStorage.getItem(CURRENT_KEY);
  }

  function setCurrentSessionId(id) {
    try { localStorage.setItem(CURRENT_KEY, id); } catch (e) { /* ignore */ }
  }

  // --- Calibrations (keyed by user-typed label) ---

  function loadCalibrations() {
    var cals = readJSON(CALIBRATIONS_KEY, null);
    return cals && typeof cals === 'object' ? cals : {};
  }

  function saveCalibration(label, calibration) {
    var cals = loadCalibrations();
    cals[label] = calibration;
    writeJSON(CALIBRATIONS_KEY, cals);
  }

  function deleteCalibration(label) {
    var cals = loadCalibrations();
    delete cals[label];
    writeJSON(CALIBRATIONS_KEY, cals);
    if (activeCalibrationLabel() === label) setActiveCalibrationLabel(null);
  }

  function activeCalibrationLabel() {
    try { return localStorage.getItem(ACTIVE_CAL_KEY); } catch (e) { return null; }
  }

  function setActiveCalibrationLabel(label) {
    try {
      if (label) localStorage.setItem(ACTIVE_CAL_KEY, label);
      else localStorage.removeItem(ACTIVE_CAL_KEY);
    } catch (e) { /* ignore */ }
  }

  function outputMode() {
    try { return localStorage.getItem(MODE_KEY) || 'headphones'; } catch (e) { return 'headphones'; }
  }

  function setOutputMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* ignore */ }
  }

  // --- Playback volume (v13) — beat + take playback, 0-100, default 100 ---

  function volume() {
    try {
      var raw = localStorage.getItem(VOLUME_KEY);
      // v13 FIX: Number(null) is 0, not NaN — a fresh install with
      // nothing stored read as volume 0 (silent). An absent value
      // is the default 100, not 0.
      if (raw === null || raw === undefined || raw === '') return 100;
      var v = Number(raw);
      if (isFinite(v) && v >= 0 && v <= 100) return Math.round(v);
    } catch (e) { /* ignore */ }
    return 100;
  }

  function setVolume(v) {
    try {
      localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(100, Math.round(Number(v) || 0)))));
    } catch (e) { /* ignore */ }
  }

  // --- Route-lab reports (Step 0, keyed by user-typed label) ---

  function loadLabReports() {
    var reports = readJSON(LAB_REPORTS_KEY, null);
    return reports && typeof reports === 'object' ? reports : {};
  }

  function saveLabReport(label, report) {
    var reports = loadLabReports();
    reports[label] = report;
    writeJSON(LAB_REPORTS_KEY, reports);
  }

  function deleteLabReport(label) {
    var reports = loadLabReports();
    delete reports[label];
    writeJSON(LAB_REPORTS_KEY, reports);
  }

  // --- Seen audio input devices (Step 0C) ---
  // Safari exposes no Bluetooth device identity, but after the mic
  // is granted, enumerateDevices gives each input a deviceId. A
  // deviceId never seen before is a new pair of headphones — the app
  // re-prompts for a measurement.

  function loadSeenDevices() {
    var list = readJSON(SEEN_DEVICES_KEY, null);
    return Array.isArray(list) ? list : [];
  }

  function markDeviceSeen(deviceId) {
    if (!deviceId) return;
    var list = loadSeenDevices();
    if (list.indexOf(deviceId) === -1) {
      list.push(deviceId);
      writeJSON(SEEN_DEVICES_KEY, list);
    }
  }

  function hasSeenDevice(deviceId) {
    if (!deviceId) return true; // an unidentified input is not "new"
    return loadSeenDevices().indexOf(deviceId) !== -1;
  }

  // --- One-time banners ---

  function bannerDismissed(name) {
    var dismissed = readJSON(BANNER_KEY, null);
    return !!(dismissed && dismissed[name]);
  }

  function dismissBanner(name) {
    var dismissed = readJSON(BANNER_KEY, null) || {};
    dismissed[name] = true;
    writeJSON(BANNER_KEY, dismissed);
  }

  return {
    TRACKS: TRACKS,
    TRACK_NAMES: TRACK_NAMES,
    newId: newId,
    makeSession: makeSession,
    loadSessions: loadSessions,
    saveSessions: saveSessions,
    currentSessionId: currentSessionId,
    setCurrentSessionId: setCurrentSessionId,
    loadCalibrations: loadCalibrations,
    saveCalibration: saveCalibration,
    deleteCalibration: deleteCalibration,
    activeCalibrationLabel: activeCalibrationLabel,
    setActiveCalibrationLabel: setActiveCalibrationLabel,
    outputMode: outputMode,
    setOutputMode: setOutputMode,
    volume: volume,
    setVolume: setVolume,
    loadLabReports: loadLabReports,
    saveLabReport: saveLabReport,
    deleteLabReport: deleteLabReport,
    loadSeenDevices: loadSeenDevices,
    markDeviceSeen: markDeviceSeen,
    hasSeenDevice: hasSeenDevice,
    bannerDismissed: bannerDismissed,
    dismissBanner: dismissBanner
  };
});
