// The frames this page sends, each 20 ms of Opus behind ADR 0003's 9-byte header:
//   0 seat (the relay writes it) | 1-2 seq | 3-6 ts, 48 kHz | 7 level, dB below full scale |
//   8 flags: bit 0 silence, bit 1 error correction, bits 4-7 codec (0 Opus)
// Every 20 ms the microphone gives takes the next number, sent or not: muted, quiet, or with no
// relay to send to, the numbers go on, so a listener's jitter buffer (ADR 0014) sees from the
// numbers that time passed, not a frame suddenly seconds late.
//
// Silence is not sent (ADR 0021). A frame the denoiser scores SPEECH or more holds speech (ADR
// 0022); without its score, as with the test tone, a frame louder than VOICE_DB does. The page
// sends speech,
// the HOLD frames after it, so the end of a word is not cut off, and the one frame before it, so
// its first sound is not either. The encoder still gets every frame, so it never starts cold.
// A frame the page sends is never marked silent: the relay copies a silent frame to no one.
// Tested by frames.test.js (`node --test web/*.test.js`).

export const HEADER = 9;
export const FRAME = 960;        // 20 ms at 48 kHz
export const SILENT_DB = 60;     // a frame quieter than -60 dBFS is silence, for the level meter
export const VOICE_DB = 50;      // a frame louder than -50 dBFS is speech
export const HOLD = 12;          // frames sent on after the last speech: 240 ms
export const SPEECH = 0.5;       // the denoiser's score from which a frame holds speech

export class Outgoing {
  constructor() {
    this.seq = 0;                // the next frame's number, counted on past 16 bits
    this.pending = [];           // { seq, db, send } of each frame the encoder has, oldest first
    this.quiet = HOLD + 1;       // frames since the last speech: past HOLD, nothing is sent
    this.held = null;            // the last frame not sent, to go first when speech starts
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
      this.held = null;
      return null;
    }
    const speech = voice === null ? db < VOICE_DB : voice >= SPEECH;
    this.quiet = speech ? 0 : Math.min(this.quiet + 1, HOLD + 1);
    this.pending.push({ seq, db, send: this.quiet <= HOLD });
    return seq;
  }

  // The datagrams to send for the encoder's next packet, oldest first: none while quiet; as
  // speech starts, the frame before it and then its own.
  encoded(chunk) {
    const frame = this.pending.shift();
    if (!frame) return [];
    const { seq, db, send } = frame;
    const datagram = new Uint8Array(HEADER + chunk.byteLength);
    const view = new DataView(datagram.buffer);
    view.setUint8(0, 0);
    view.setUint16(1, seq & 0xffff);
    view.setUint32(3, (seq * FRAME) >>> 0);
    view.setUint8(7, db);
    view.setUint8(8, 2);
    chunk.copyTo(datagram.subarray(HEADER));
    if (!send) {
      this.held = datagram;
      return [];
    }
    const out = this.held ? [this.held, datagram] : [datagram];
    this.held = null;
    return out;
  }

  // A new encoder: what the old one held is gone. The numbers go on.
  restart() {
    this.pending = [];
    this.held = null;
  }
}
