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
      tracks[kind] = { takes: [], activeTakeId: null };
    });
    return {
      id: newId(),
      name: name || 'New Song',
      key: 'D minor',
      preset: 'hard', // the vocal effect (Voloco's Starter pack) — Hard Tune, Denasse's choice
      strength: 100, // pitch-correction strength 0-100 (100 = the full snap)
      speed: null, // tune speed 0-100; null = Auto (the preset's own retune time — v11's exact sound)
      keyManuallySet: false, // true once Denasse picks a key himself; the beat's detected key only auto-applies before that
      bpm: null,
      beatKey: null, // the key the beat detector heard (Step 9A)
      beatKeyConfidence: 0, // 0..1 — below 0.25 the app says it is not sure
      beatBpm: null, // the tempo the beat detector heard
      beatBpmAlt: null, // its half/double partner (68 <-> 136)
      beatGridOffset: null, // where the first real hit lands, seconds (Step 9A; the mixer uses it in Phase 4)
      keySource: null, // 'beat' when the key came from the beat, 'manual' when picked by hand
      beatFileName: null,
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
