// The playout worklet, on the audio thread: each person's decoded audio, by seat, mixed. It also
// posts the call's beat (0, CONTEXT.md) every 20 ms on the audio clock: a page in a background
// tab has its timers slowed, its audio never (ADR 0018). Each person waits until 40 ms is queued
// before they play, starts over after running dry, and drops their oldest audio past 200 ms. It
// is its own module, loaded by the SDK from beside itself, so it names its numbers here: FRAME is
// frames.js's.
//
// Messages, kept to what is cheapest on the audio thread (ADR 0024): one a beat, a bare
// Float32Array holding that beat's news in order, each as [seat, n, then n samples]: a decoded
// frame's samples; n = LOST for a frame lost, played as 20 ms of silence; n = GONE for a seat its
// person let go. Each seat has a fixed slot with a ring of samples it copies into, and the render
// loop walks only the seats in use, by index: nothing is allocated or hashed per render quantum,
// nor per message once a seat is in use.
// Tested by worklets.test.js (`node --test 'web/**/*.test.js'`).

const FRAME = 960;                     // 20 ms at 48 kHz
const TARGET = FRAME * 2, MOST = FRAME * 10;
const RING = MOST + FRAME;             // samples a seat holds: its most, and a frame coming in
const LOST = -1, GONE = -2;

class Seat {
  constructor() {
    this.samples = new Float32Array(RING);
    this.read = 0;                     // where the next sample to play is
    this.count = 0;                    // samples held
    this.playing = false;
  }

  // `n` samples from `from`, starting at `at`, or silence with `from` null; then the oldest go
  // past MOST.
  push(from, at, n) {
    let write = this.read + this.count;
    if (write >= RING) write -= RING;
    for (let k = 0; k < n; k++) {
      this.samples[write] = from === null ? 0 : from[at + k];
      write = write + 1 === RING ? 0 : write + 1;
    }
    this.count += n;
    if (this.count > MOST) {
      this.read += this.count - MOST;
      if (this.read >= RING) this.read -= RING;
      this.count = MOST;
    }
  }
}

class Playout extends AudioWorkletProcessor {
  constructor() {
    super();
    this.slots = new Array(256).fill(null);
    this.used = new Uint8Array(256);   // the seats with a slot, packed at the front
    this.live = 0;
    this.beat = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  // A beat's news, in order.
  message(data) {
    if (!(data instanceof Float32Array)) return;
    let i = 0;
    while (i + 1 < data.length) {
      const seat = data[i] & 255;
      const n = data[i + 1];
      i += 2;
      if (n === GONE) {
        this.free(seat);
      } else if (n === LOST) {
        this.slot(seat).push(null, 0, FRAME);
      } else {
        const take = Math.min(n, data.length - i, RING);
        this.slot(seat).push(data, i, take);
        i += n;
      }
    }
  }

  slot(seat) {
    let slot = this.slots[seat];
    if (!slot) {
      slot = new Seat();
      this.slots[seat] = slot;
      this.used[this.live++] = seat;
    }
    return slot;
  }

  free(seat) {
    if (!this.slots[seat]) return;
    this.slots[seat] = null;
    for (let k = 0; k < this.live; k++) {
      if (this.used[k] !== seat) continue;
      this.live--;
      this.used[k] = this.used[this.live];
      return;
    }
  }

  process(_, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    for (let k = 0; k < this.live; k++) {
      const s = this.slots[this.used[k]];
      if (!s.playing) {
        if (s.count >= TARGET) s.playing = true;
        else continue;
      }
      for (let i = 0; i < out.length; i++) {
        if (s.count === 0) {
          s.playing = false;
          break;
        }
        out[i] += s.samples[s.read];
        s.read = s.read + 1 === RING ? 0 : s.read + 1;
        s.count--;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
    this.beat += out.length;
    if (this.beat >= FRAME) {
      this.beat -= FRAME;
      this.port.postMessage(0);
    }
    return true;
  }
}
registerProcessor('playout', Playout);
