/* db.js — IndexedDB storage for takes and beats (the big Blobs).
 *
 * Lightweight metadata (sessions, take lists, calibrations) lives in
 * localStorage (see store.js). The audio itself lives here:
 *   takes: keyed by take id — raw + aligned WAV Blobs + metadata
 *   beats: keyed by session id — the original imported beat file
 *   misc:  keyed by name — the mic-test recording
 *   takeChunks: one record per 48,000-sample chunk written WHILE a
 *     take is recording (Step 1B). Keyed by
 *     `${sessionId}/${track}/${takeId}/${index}` with an index on
 *     takeId, so a take killed mid-record can be rebuilt from its
 *     chunks on the next boot — at most the last partial second is
 *     lost. Chunk rows are deleted once the take is saved.
 *
 * Loads in the browser as window.PS.db. Promise-based.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.db = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'phone-studio';
  var DB_VERSION = 2;
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('takes')) {
          var takes = db.createObjectStore('takes', { keyPath: 'id' });
          takes.createIndex('sessionId', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('beats')) {
          db.createObjectStore('beats', { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains('misc')) {
          db.createObjectStore('misc', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('takeChunks')) {
          var chunks = db.createObjectStore('takeChunks', { keyPath: 'key' });
          chunks.createIndex('takeId', 'takeId', { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Database is blocked.')); };
    });
    return dbPromise;
  }

  function run(storeName, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(result && result.result !== undefined ? result.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted.')); };
      });
    });
  }

  function put(storeName, value) {
    return run(storeName, 'readwrite', function (store) { return store.put(value); });
  }

  function get(storeName, key) {
    return run(storeName, 'readonly', function (store) { return store.get(key); });
  }

  function remove(storeName, key) {
    return run(storeName, 'readwrite', function (store) { return store.delete(key); });
  }

  function getAllByIndex(storeName, indexName, key) {
    return run(storeName, 'readonly', function (store) {
      return store.index(indexName).getAll(key);
    });
  }

  return {
    open: open,
    saveTake: function (take) { return put('takes', take); },
    getTake: function (id) { return get('takes', id); },
    getTakesBySession: function (sessionId) { return getAllByIndex('takes', 'sessionId', sessionId); },
    deleteTake: function (id) { return remove('takes', id); },
    saveBeat: function (beat) { return put('beats', beat); },
    getBeat: function (sessionId) { return get('beats', sessionId); },
    deleteBeat: function (sessionId) { return remove('beats', sessionId); },
    saveMisc: function (key, value) { return put('misc', { key: key, value: value }); },
    getMisc: function (key) {
      return get('misc', key).then(function (row) { return row ? row.value : undefined; });
    },
    deleteMisc: function (key) { return remove('misc', key); },
    // --- Take chunks (Step 1B): one row per 48,000-sample chunk. ---
    saveTakeChunk: function (chunk) { return put('takeChunks', chunk); },
    getTakeChunks: function (takeId) { return getAllByIndex('takeChunks', 'takeId', takeId); },
    getAllTakeChunks: function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('takeChunks', 'readonly');
          var req = tx.objectStore('takeChunks').getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      });
    },
    deleteTakeChunks: function (takeId) {
      return getAllByIndex('takeChunks', 'takeId', takeId).then(function (rows) {
        if (!rows || rows.length === 0) return;
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var tx = db.transaction('takeChunks', 'readwrite');
            var store = tx.objectStore('takeChunks');
            rows.forEach(function (r) { store.delete(r.key); });
            tx.oncomplete = function () { resolve(); };
            tx.onerror = function () { reject(tx.error); };
          });
        });
      });
    }
  };
});
