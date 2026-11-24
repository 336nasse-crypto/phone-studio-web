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
      bpm: null,
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
    setOutputMode: setOutputMode
  };
});
