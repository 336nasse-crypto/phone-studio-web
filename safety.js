/* safety.js — take-safety helpers (Step 1B, Phase 0).
 *
 * Pure logic, no DOM, no audio APIs: every function here runs in
 * Node (the self-test uses the Node form) and in the browser as
 * window.PS.safety.
 *
 * - RingBuffer: the 60 s Audio Logger — a circular Float32 buffer
 *   that keeps the last N seconds of mic input while the record
 *   screen is armed. One tap saves it. ~11 MB RAM at 48 kHz mono.
 * - Chunked takes: takes are written to storage in 48,000-sample
 *   chunks while recording (one record per chunk, keyed by song /
 *   track / take / index). If the app is killed mid-take, the chunks
 *   on disk are the take up to the last full second — at most 1 s
 *   is ever lost.
 * - Storage gate: refuse to arm with less than 500 MB free.
 * - iOS version + Wake Lock: Wake Lock works in home-screen apps
 *   only from iOS 18.4 — warn below it.
 * - outputLatency drift: recalibrate when it moves more than 20 ms
 *   (ESTIMATED) from the calibration's value.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.safety = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHUNK_SAMPLES = 48000; // 1 s at 48 kHz — one chunk per second
  var MIN_FREE_BYTES = 500 * 1024 * 1024; // refuse to arm below 500 MB free
  var LOGGER_SECONDS = 60; // the Audio Logger keeps the last 60 s
  var DRIFT_THRESHOLD_MS = 20; // recalibrate when outputLatency moves > 20 ms

  /* Circular Float32 buffer. push() appends samples, dropping the
   * oldest when full. snapshot() returns the contents in
   * chronological order (oldest first), up to capacity.
   */
  function RingBuffer(capacitySamples) {
    this.capacity = Math.max(1, Math.floor(capacitySamples));
    this.buf = new Float32Array(this.capacity);
    this.write = 0; // next slot to write
    this.count = 0; // samples held (<= capacity)
  }
  RingBuffer.prototype.push = function (samples) {
    for (var i = 0; i < samples.length; i++) {
      this.buf[this.write] = samples[i];
      this.write = (this.write + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
    }
  };
  RingBuffer.prototype.snapshot = function () {
    var out = new Float32Array(this.count);
    if (this.count === 0) return out;
    var start = (this.write - this.count + this.capacity) % this.capacity;
    for (var i = 0; i < this.count; i++) {
      out[i] = this.buf[(start + i) % this.capacity];
    }
    return out;
  };
  RingBuffer.prototype.secondsHeld = function (sampleRate) {
    return this.count / sampleRate;
  };
  RingBuffer.prototype.clear = function () {
    this.write = 0;
    this.count = 0;
  };

  /* Chunk key: song / track / take / index. */
  function chunkKey(sessionId, track, takeId, index) {
    return sessionId + '/' + track + '/' + takeId + '/' + index;
  }

  /* How many whole seconds of audio a set of chunks holds. */
  function chunkedSeconds(chunkCount, sampleRate) {
    return chunkCount * CHUNK_SAMPLES / sampleRate;
  }

  /* Reassemble chunk rows (each { index, data: Float32Array }) into
   * one Float32Array, in index order. Rows may arrive unsorted.
   */
  function reassembleChunks(rows) {
    var sorted = rows.slice().sort(function (a, b) { return a.index - b.index; });
    var total = 0;
    for (var i = 0; i < sorted.length; i++) total += sorted[i].data.length;
    var out = new Float32Array(total);
    var offset = 0;
    for (var j = 0; j < sorted.length; j++) {
      out.set(sorted[j].data, offset);
      offset += sorted[j].data.length;
    }
    return out;
  }

  /* Storage gate: estimate is navigator.storage.estimate()'s
   * { quota, usage } (bytes). Returns { ok, freeBytes, freeMB }.
   * Missing numbers mean "unknown" — arm anyway (the gate only
   * refuses on a measured shortage, never on a missing reading).
   */
  function hasEnoughFree(estimate) {
    if (!estimate || typeof estimate.quota !== 'number' || typeof estimate.usage !== 'number') {
      return { ok: true, freeBytes: null, freeMB: null, unknown: true };
    }
    var free = Math.max(0, estimate.quota - estimate.usage);
    return {
      ok: free >= MIN_FREE_BYTES,
      freeBytes: free,
      freeMB: Math.round(free / (1024 * 1024)),
      unknown: false
    };
  }

  /* iOS version from a user-agent string: "OS 18_4" -> { major: 18,
   * minor: 4 }. Returns null when the UA is not iOS.
   */
  function parseIOSVersion(userAgent) {
    var m = /(?:iPhone|iPad|iPod).*?OS (\d+)[_.](\d+)/.exec(userAgent || '');
    if (!m) return null;
    return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
  }

  /* Wake Lock works in home-screen apps only from iOS 18.4 — warn
   * when the app runs as a home-screen app (standalone) on older
   * iOS. In a regular Safari tab Wake Lock has worked since 16.4,
   * so no warning there.
   */
  function wakeLockWarnNeeded(iosVersion, isStandalone) {
    if (!iosVersion || !isStandalone) return false;
    if (iosVersion.major < 18) return true;
    if (iosVersion.major === 18 && iosVersion.minor < 4) return true;
    return false;
  }

  /* outputLatency drift: true when the current outputLatency has
   * moved more than DRIFT_THRESHOLD_MS from the calibration's value.
   * Nulls mean "unknown" — never flag on a missing reading.
   */
  function outputLatencyDrifted(calibrationSeconds, currentSeconds, thresholdMs) {
    if (calibrationSeconds === null || calibrationSeconds === undefined ||
        currentSeconds === null || currentSeconds === undefined) return false;
    var threshold = (typeof thresholdMs === 'number' ? thresholdMs : DRIFT_THRESHOLD_MS) / 1000;
    return Math.abs(currentSeconds - calibrationSeconds) > threshold;
  }

  /* "Saved up to 2:13" — the partial-take label from a duration in
   * seconds. Same clock format as the rest of the app (m:ss).
   */
  function fmtSavedUpTo(seconds) {
    var s = Math.max(0, Math.floor(seconds || 0));
    return 'Saved up to ' + Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  return {
    CHUNK_SAMPLES: CHUNK_SAMPLES,
    MIN_FREE_BYTES: MIN_FREE_BYTES,
    LOGGER_SECONDS: LOGGER_SECONDS,
    DRIFT_THRESHOLD_MS: DRIFT_THRESHOLD_MS,
    RingBuffer: RingBuffer,
    chunkKey: chunkKey,
    chunkedSeconds: chunkedSeconds,
    reassembleChunks: reassembleChunks,
    hasEnoughFree: hasEnoughFree,
    parseIOSVersion: parseIOSVersion,
    wakeLockWarnNeeded: wakeLockWarnNeeded,
    outputLatencyDrifted: outputLatencyDrifted,
    fmtSavedUpTo: fmtSavedUpTo
  };
});
