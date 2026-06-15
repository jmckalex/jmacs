// AudioWorklet processor for the Stella WASM port.
//
// It owns a simple interleaved-stereo Float32 ring buffer.  The main thread
// resamples each emulated frame's audio to the AudioContext's sample rate and
// posts it here via `port.postMessage(float32Interleaved)`; process() drains
// the ring at the hardware rate, emitting silence on underrun.
//
// Keeping the resampling on the main thread (where the emulator's exact output
// rate is known) keeps this processor trivial and avoids any cross-thread
// SharedArrayBuffer requirement (so the page works on any plain static host).

class StellaAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // ~0.5s of stereo headroom; plenty to absorb requestAnimationFrame jitter.
    this.capacity = Math.ceil(sampleRate * 0.5) * 2;
    this.ring = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.available = 0;          // number of floats currently buffered

    // Don't start emitting until we've buffered a little, to avoid an
    // immediate underrun at startup. Tracks a "priming" state.
    this.primed = false;
    this.primeTarget = Math.floor(sampleRate * 0.05) * 2;  // ~50ms

    this.port.onmessage = (e) => {
      const data = e.data;
      if (data === 'reset') {
        this.readPos = this.writePos = this.available = 0;
        this.primed = false;
        return;
      }
      this.push(data);
    };
  }

  push(samples) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      if (this.available >= this.capacity) {
        // Overflow: drop oldest sample to keep latency bounded.
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available--;
      }
      this.ring[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.capacity;
      this.available++;
    }
    if (!this.primed && this.available >= this.primeTarget) this.primed = true;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out.length > 1 ? out[1] : null;
    const frames = left.length;

    if (!this.primed) {
      left.fill(0);
      if (right) right.fill(0);
      return true;
    }

    for (let i = 0; i < frames; i++) {
      if (this.available >= 2) {
        const l = this.ring[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        const r = this.ring[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.available -= 2;
        left[i] = l;
        if (right) right[i] = r;
      } else {
        // Underrun: emit silence for the missing samples but keep playing, so
        // we resume the instant more audio arrives (re-priming here would turn
        // every small underrun into an audible ~50ms dropout).
        left[i] = 0;
        if (right) right[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('stella-audio-processor', StellaAudioProcessor);
