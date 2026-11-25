/* voice-ref.js — the reference-voice loader (v13.2 item 8, scaffolding).
 *
 * Denasse's voice is the missing test material: the tune, the
 * presets and the mic model are all unproven on his real voice.
 * When his voice note lands, Jim measures it (test/voice-measure.js)
 * and writes the result to voice-reference.json next to this app.
 * This loader reads that file when it is present — and returns null
 * when it is not, so the app behaves exactly as v13.1 until then.
 *
 * SCAFFOLDING ONLY: the loaded reference is held for the later
 * wiring (defaults from HIS voice, test signals from HIS voice).
 * Nothing in the app reads it for sound yet — the defaults stay
 * v13 (Hard + Auto) until the voice note lands and the ear check
 * passes. A failed or missing file is never an error: the loader
 * resolves null and the app carries on.
 *
 * Reference format (schemaVersion 1, written by
 * test/voice-measure.js --ref):
 *   { schemaVersion: 1, measuredAt, source,
 *     pitch: { medianHz, medianNote, minHz, maxHz, rangeSemitones, voicedFraction },
 *     vibrato: { present, rateHz, depthCents },
 *     tone: { centroidHz, bandShares: { low, mid, high, air } },
 *     dynamics: { rmsDbfs, peakDbfs, crestDb } }
 *
 * Loads in the browser as window.PS.voiceRef. Pure fetch + cache.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.voiceRef = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_URL = 'voice-reference.json';
  var cached = null; // the loaded reference, or null when absent/invalid
  var loaded = false; // true once a load attempt has finished

  /* Fetch + parse the reference. `url` is only for tests (the
   * fixture lives under test/fixtures/); the app always loads the
   * default path. Resolves the reference object, or null when the
   * file is absent, unparsable, or the wrong shape — never throws,
   * never rejects: a missing reference is a normal state, not a
   * failure, and must never break the record screen.
   */
  function load(url) {
    var target = url || DEFAULT_URL;
    var fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
    if (!fetchFn) return Promise.resolve(null);
    return fetchFn(target).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json().catch(function () { return null; });
    }).then(function (ref) {
      if (!ref || typeof ref !== 'object') return null;
      if (ref.schemaVersion !== 1) return null;
      if (!ref.pitch || typeof ref.pitch.medianHz !== 'number') return null;
      cached = ref;
      loaded = true;
      return ref;
    }).catch(function () {
      return null;
    });
  }

  function get() {
    return cached;
  }

  function isLoaded() {
    return loaded;
  }

  return {
    load: load,
    get: get,
    isLoaded: isLoaded,
    DEFAULT_URL: DEFAULT_URL
  };
});
