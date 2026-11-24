/* wav.js — WAV encode/decode for the Phone Studio PWA.
 *
 * The pipeline needs WAV, not compressed audio. Takes are written as
 * 32-bit float WAV, exactly like the native app (TrackRecorder writes
 * float32). The decoder handles float32 and 16/24/32-bit PCM so stored
 * files and imported audio can be read back anywhere.
 *
 * Loads in the browser as window.PS.wav and in Node as module.exports
 * (the self-test uses the Node form).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.PS = root.PS || {};
    root.PS.wav = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Encode mono float32 samples as a WAV file. Returns an ArrayBuffer.
   * Layout: RIFF / fmt (IEEE float, format 3, 1 channel, 32-bit) / data.
   */
  function encodeWavFloat32(samples, sampleRate) {
    var numSamples = samples.length;
    var bytesPerSample = 4;
    var dataBytes = numSamples * bytesPerSample;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);

    function writeString(offset, str) {
      for (var i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true); // chunk size
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 3, true); // audio format: 3 = IEEE float
    view.setUint16(22, 1, true); // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
    view.setUint16(32, bytesPerSample, true); // block align
    view.setUint16(34, 32, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, dataBytes, true);

    var out = new Float32Array(buffer, 44, numSamples);
    out.set(samples);
    return buffer;
  }

  /* Decode a WAV file (ArrayBuffer) to mono float32 samples.
   * Supports format 1 (PCM 8/16/24/32-bit) and format 3 (float32).
   * Stereo (or more channels) is mixed to mono by averaging, exactly
   * like ResidualVerifier.readMonoSamples in the native app.
   * Returns { samples: Float32Array, sampleRate: number, channels: number }
   * or null when the file cannot be read.
   */
  function decodeWavFloat32(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
    var view = new DataView(arrayBuffer);

    function readString(offset, length) {
      var s = '';
      for (var i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
      return s;
    }

    if (readString(0, 4) !== 'RIFF' || readString(8, 4) !== 'WAVE') return null;

    // Walk the chunks: fmt and data may not be in the textbook order.
    var offset = 12;
    var audioFormat = 0;
    var channels = 0;
    var sampleRate = 0;
    var bitsPerSample = 0;
    var dataOffset = -1;
    var dataBytes = 0;
    while (offset + 8 <= arrayBuffer.byteLength) {
      var chunkId = readString(offset, 4);
      var chunkSize = view.getUint32(offset + 4, true);
      var chunkStart = offset + 8;
      if (chunkId === 'fmt ') {
        audioFormat = view.getUint16(chunkStart, true);
        channels = view.getUint16(chunkStart + 2, true);
        sampleRate = view.getUint32(chunkStart + 4, true);
        bitsPerSample = view.getUint16(chunkStart + 14, true);
      } else if (chunkId === 'data') {
        dataOffset = chunkStart;
        dataBytes = chunkSize;
        break;
      }
      offset = chunkStart + chunkSize + (chunkSize % 2); // chunks are word-aligned
    }
    if (dataOffset < 0 || channels === 0 || sampleRate === 0) return null;

    var bytesPerSample = Math.ceil(bitsPerSample / 8);
    var frameCount = Math.floor(dataBytes / (bytesPerSample * channels));
    if (frameCount <= 0) return { samples: new Float32Array(0), sampleRate: sampleRate, channels: channels };
    var samples = new Float32Array(frameCount);

    var i, ch, pos;
    if (audioFormat === 3 && bitsPerSample === 32) {
      var floats = new Float32Array(arrayBuffer, dataOffset, frameCount * channels);
      if (channels === 1) {
        samples.set(floats);
      } else {
        for (i = 0; i < frameCount; i++) {
          var sum = 0;
          for (ch = 0; ch < channels; ch++) sum += floats[i * channels + ch];
          samples[i] = sum / channels;
        }
      }
    } else if (audioFormat === 1) {
      for (i = 0; i < frameCount; i++) {
        var total = 0;
        for (ch = 0; ch < channels; ch++) {
          pos = dataOffset + (i * channels + ch) * bytesPerSample;
          var value = 0;
          if (bitsPerSample === 16) {
            value = view.getInt16(pos, true) / 32768;
          } else if (bitsPerSample === 24) {
            var b0 = view.getUint8(pos);
            var b1 = view.getUint8(pos + 1);
            var b2 = view.getUint8(pos + 2);
            var v = b0 | (b1 << 8) | (b2 << 16);
            if (v & 0x800000) v -= 0x1000000;
            value = v / 8388608;
          } else if (bitsPerSample === 32) {
            value = view.getInt32(pos, true) / 2147483648;
          } else if (bitsPerSample === 8) {
            value = (view.getUint8(pos) - 128) / 128;
          } else {
            return null;
          }
          total += value;
        }
        samples[i] = total / channels;
      }
    } else {
      return null;
    }
    return { samples: samples, sampleRate: sampleRate, channels: channels };
  }

  return {
    encodeWavFloat32: encodeWavFloat32,
    decodeWavFloat32: decodeWavFloat32
  };
});
