/* worklet.js — AudioWorklet processor that captures raw mic PCM.
 *
 * Runs on the audio render thread. Collects the mono mic input into
 * ~4096-frame batches and posts them to the main thread with the
 * render-clock time of the first sample in the batch. The main thread
 * uses those times to place every sample on the render timeline —
 * the same timeline the beat is scheduled on — so the calibration
 * measurement and the pre-compensation math need no wall clock.
 *
 * Loaded with ctx.audioWorklet.addModule('worklet.js'). Messages:
 *   main -> worklet: { type: 'start' } / { type: 'stop' } / { type: 'reset' }
 *   worklet -> main: { type: 'block', time, samples, peak }
 *     time: AudioWorkletGlobalScope.currentTime of the first sample
 *     samples: Float32Array of mono PCM (transferable)
 *     peak: max absolute value in the batch (level meter)
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.batchFrames = 4096;
    this.batch = new Float32Array(this.batchFrames);
    this.batchLength = 0;
    this.batchTime = 0;
    this.batchPeak = 0;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'start') {
        this.batchLength = 0;
        this.batchPeak = 0;
        this.recording = true;
      } else if (data.type === 'stop') {
        this.recording = false;
        this.flush();
      } else if (data.type === 'reset') {
        this.batchLength = 0;
        this.batchPeak = 0;
        this.recording = false;
      }
    };
  }

  flush() {
    if (this.batchLength === 0) return;
    const out = this.batch.slice(0, this.batchLength);
    this.port.postMessage(
      { type: 'block', time: this.batchTime, samples: out, peak: this.batchPeak },
      [out.buffer]
    );
    this.batchLength = 0;
    this.batchPeak = 0;
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0]; // mono mic — channel 0 is the signal
    if (!channel || channel.length === 0) return true;

    let offset = 0;
    while (offset < channel.length) {
      if (this.batchLength === 0) {
        // currentTime is the render time of this 128-frame block's
        // first sample; offset inside the block shifts it.
        this.batchTime = currentTime + offset / sampleRate;
        this.batchPeak = 0;
      }
      const take = Math.min(channel.length - offset, this.batchFrames - this.batchLength);
      for (let i = 0; i < take; i++) {
        const v = channel[offset + i];
        this.batch[this.batchLength + i] = v;
        const a = v < 0 ? -v : v;
        if (a > this.batchPeak) this.batchPeak = a;
      }
      this.batchLength += take;
      offset += take;
      if (this.batchLength >= this.batchFrames) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
