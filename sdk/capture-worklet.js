// The capture worklet, on the audio thread: 128-sample blocks from the microphone, gathered into
// 20 ms frames, each filtered and scored for speech by the denoiser (crates/voice-denoise,
// ADR 0022). It is its own module, loaded by the SDK from beside itself, so it names its numbers
// here: FRAME is frames.js's.
//
// Messages, kept to what is cheapest on the audio thread (ADR 0024):
// - out: each frame as a bare Float32Array of FRAME + 1, its speech score last (NaN for none),
//   its buffer transferred; and, now and then, { ready } or { failed }.
// - in: the frames' buffers back, as an array of them, once the page's encoder has copied them,
//   which the next frames are gathered in: a frame is made new only while none has come back;
//   { bytes, apply } with the denoiser's module, and { apply } to switch it.
// Tested by worklets.test.js (`node --test 'web/**/*.test.js'`).

const FRAME = 960;     // 20 ms at 48 kHz
const SAMPLES = 480;   // the denoiser's 10 ms a call
const POOL = 8;        // buffers kept for the frames to come

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pool = [];
    this.frame = new Float32Array(FRAME + 1);
    this.at = 0;
    this.moving = [null];           // the transfer list, made once
    // The denoiser, once the page sends its module: none for the test tone, or where it cannot
    // run. Its samples' view is made again if its memory grows.
    this.denoiser = null;
    this.view = null;
    this.apply = true;
    // The module comes as its bytes, compiled here: Chrome will not pass a compiled module into
    // an audio worklet, and says so only with a messageerror.
    this.port.onmessage = (e) => {
      const data = e.data;
      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const back = data[i];
          if (back instanceof Float32Array && back.length === FRAME + 1 && this.pool.length < POOL) this.pool.push(back);
        }
        return;
      }
      const { bytes, apply } = data;
      if (apply !== undefined) this.apply = apply;
      if (!bytes) return;
      try {
        this.denoiser = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports;
        this.port.postMessage({ ready: true });
      } catch (error) {
        this.port.postMessage({ failed: String(error) });
      }
    };
    this.port.onmessageerror = () => this.port.postMessage({ failed: 'a message the audio thread could not read' });
  }

  // The denoiser's samples, as a view made again whenever its memory has grown: a call can grow
  // it, as the first does, and the old view then reads nothing. Asked for again after each call.
  samples() {
    const d = this.denoiser;
    if (!this.view || this.view.buffer !== d.memory.buffer) {
      this.view = new Float32Array(d.memory.buffer, d.samples(), SAMPLES);
    }
    return this.view;
  }

  // Each half of a frame through the denoiser: denoised in place when it is on, and scored for
  // speech either way. The frame's score, its likelier half's (NaN without a denoiser), goes in
  // its last place from here: returned, a score is a number box a frame, as this is not inlined.
  // A denoiser that fails is let go, and the call goes on without it.
  clean(frame) {
    frame[FRAME] = NaN;
    if (!this.denoiser) return;
    try {
      let voice = 0;
      for (let half = 0; half < FRAME; half += SAMPLES) {
        const into = this.samples();
        for (let i = 0; i < SAMPLES; i++) into[i] = frame[half + i];
        voice = Math.max(voice, this.denoiser.denoise(this.apply ? 1 : 0));
        if (this.apply) {
          const out = this.samples();
          for (let i = 0; i < SAMPLES; i++) frame[half + i] = out[i];
        }
      }
      frame[FRAME] = voice;
    } catch (error) {
      this.denoiser = null;
      this.port.postMessage({ failed: String(error) });
    }
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.frame[this.at++] = input[i];
      if (this.at === FRAME) {
        this.clean(this.frame);
        this.moving[0] = this.frame.buffer;
        this.port.postMessage(this.frame, this.moving);
        this.frame = this.pool.pop() ?? new Float32Array(FRAME + 1);
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
