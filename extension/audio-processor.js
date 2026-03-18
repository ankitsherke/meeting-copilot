/**
 * audio-processor.js — AudioWorklet processor
 * Runs in the AudioWorklet thread.
 * Converts Float32 audio samples → Int16 PCM and posts buffers to main thread.
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._active = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') this._active = false;
    };
  }

  process(inputs) {
    if (!this._active) return false;

    const input = inputs[0];
    if (!input || !input[0]) return true;

    const float32 = input[0]; // mono channel
    const int16 = new Int16Array(float32.length);

    for (let i = 0; i < float32.length; i++) {
      // Clamp to [-1, 1] then scale to Int16 range
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = clamped < 0
        ? clamped * 32768
        : clamped * 32767;
    }

    // Transfer buffer to main thread (zero-copy)
    this.port.postMessage(int16.buffer, [int16.buffer]);

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
