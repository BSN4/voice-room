// The frames this page sends, each 20 ms of Opus behind ADR 0003's 9-byte header:
//   0 seat (the relay writes it) | 1-2 seq | 3-6 ts, 48 kHz | 7 level, dB below full scale |
//   8 flags: bit 0 silence, bit 1 error correction, bits 2-3 the seat epoch's low two bits
//   (seats.js writes them, ADR 0028), bits 4-7 codec (0 Opus)
// Every 20 ms the microphone gives takes the next number, sent or not: muted, quiet, or with no
// relay to send to, the numbers go on, so a listener's jitter buffer (ADR 0014) sees from the
// numbers that time passed, not a frame suddenly seconds late.
//
// Silence is not sent (ADR 0021). A frame the denoiser scores SPEECH or more holds speech (ADR
// 0022); without its score, as with the test tone, a frame louder than VOICE_DB does. The page
// sends speech, the HOLD frames after it, so the end of a word is not cut off, and the one frame
// before it, so its first sound is not either. The encoder still gets every frame, so it never
// starts cold. A frame the page sends is never marked silent: the relay copies a silent frame to
// no one.
//
// Per frame, nothing is made but the datagrams sent: the frames in the encoder wait in a ring of
// typed arrays, headers are written by index, and the frame held before speech is copied into a
// buffer made once.
// Tested by frames.test.js (`node --test 'web/**/*.test.js'`).

export const HEADER = 9;
export const FRAME = 960;        // 20 ms at 48 kHz
const VOICE_DB = 50;             // a frame louder than -50 dBFS is speech
export const HOLD = 12;          // frames sent on after the last speech: 240 ms
export const SPEECH = 0.5;       // the denoiser's score from which a frame holds speech

const OPUS_MAX = 1275;           // the most bytes an Opus frame has (RFC 6716)
const WAITING = 64;              // frames the encoder may hold at once, and more

// A frame's header, written into `bytes`: its number, its time, its level, and error correction.
function header(bytes, seq, db) {
  const ts = seq * FRAME;          // its bytes, taken by >>> and &, are its low 32 bits
  bytes[0] = 0;
  bytes[1] = (seq >>> 8) & 255;
  bytes[2] = seq & 255;
  bytes[3] = ts >>> 24;
  bytes[4] = (ts >>> 16) & 255;
  bytes[5] = (ts >>> 8) & 255;
  bytes[6] = ts & 255;
  bytes[7] = db;
  bytes[8] = 2;
}

export class Outgoing {
  constructor() {
    this.seq = 0;                // the next frame's number, counted on past 16 bits
    // Each frame the encoder has, oldest first: its number, level, and whether it goes out.
    this.seqs = new Uint32Array(WAITING);
    this.dbs = new Uint8Array(WAITING);
    this.sends = new Uint8Array(WAITING);
    this.first = 0;
    this.count = 0;
    this.quiet = HOLD + 1;       // frames since the last speech: past HOLD, nothing is sent
    // The last frame not sent, to go first when speech starts: its datagram, and its length or 0.
    this.held = new Uint8Array(HEADER + OPUS_MAX);
    this.heldBody = this.held.subarray(HEADER);
    this.heldLength = 0;
    // Where a frame sent is put together before its datagram is cut.
    this.scratch = new Uint8Array(HEADER + OPUS_MAX);
    this.scratchBody = this.scratch.subarray(HEADER);
  }

  // A frame the microphone gave, `db` loud, and the denoiser's score of how likely it holds
  // speech, or null without one: it takes the next number. Returns the number, for the encoder,
  // or null when the encoder is not to have it (`encode` false: muted, or no encoder), which ends
  // any talking.
  captured(db, encode, voice = null) {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    if (!encode) {
      this.quiet = HOLD + 1;
      this.heldLength = 0;
      return null;
    }
    const speech = voice === null ? db < VOICE_DB : voice >= SPEECH;
    this.quiet = speech ? 0 : Math.min(this.quiet + 1, HOLD + 1);
    if (this.count === WAITING) {
      this.first = (this.first + 1) % WAITING;
      this.count--;
    }
    const at = (this.first + this.count) % WAITING;
    this.seqs[at] = seq;
    this.dbs[at] = db;
    this.sends[at] = this.quiet <= HOLD ? 1 : 0;
    this.count++;
    return seq;
  }

  // The encoder's next packet: its datagrams go to `emit`, oldest first. None while quiet; as
  // speech starts, the frame before it and then its own. With no `emit`, no relay to send to,
  // nothing is made, and the frame's number is spent. Whether the gate let it through: false while
  // quiet, or with nothing sent.
  encoded(chunk, emit = null) {
    if (this.count === 0) return false;
    const at = this.first;
    this.first = (this.first + 1) % WAITING;
    this.count--;
    const length = HEADER + chunk.byteLength;
    if (length > this.scratch.length || !emit) {
      this.heldLength = 0;
      return false;
    }
    if (!this.sends[at]) {
      header(this.held, this.seqs[at], this.dbs[at]);
      chunk.copyTo(this.heldBody);
      this.heldLength = length;
      return false;
    }
    if (this.heldLength) {
      emit(this.held.slice(0, this.heldLength));
      this.heldLength = 0;
    }
    header(this.scratch, this.seqs[at], this.dbs[at]);
    chunk.copyTo(this.scratchBody);
    emit(this.scratch.slice(0, length));
    return true;
  }

  // A new encoder: what the old one held is gone. The numbers go on.
  restart() {
    this.count = 0;
    this.heldLength = 0;
  }
}
