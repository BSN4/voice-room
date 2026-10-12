// The frames this page sends, each 20 ms of Opus behind ADR 0003's 9-byte header:
//   0 seat (the relay writes it) | 1-2 seq | 3-6 ts, 48 kHz | 7 level, dB below full scale |
//   8 flags: bit 0 silence, bit 1 error correction, bits 4-7 codec (0 Opus)
// Every 20 ms the microphone gives takes the next number, sent or not: muted, or with no relay
// to send to, the numbers go on, so a listener's jitter buffer (ADR 0014) sees from the numbers
// that time passed, not a frame suddenly seconds late.
// Tested by frames.test.js (`node --test web/*.test.js`).

export const HEADER = 9;
export const FRAME = 960;        // 20 ms at 48 kHz
export const SILENT_DB = 60;     // a frame quieter than -60 dBFS is silence

export class Outgoing {
  constructor() {
    this.seq = 0;                // the next frame's number, counted on past 16 bits
    this.pending = [];           // { seq, db } of each frame the encoder has, oldest first
  }

  // A frame the microphone gave, `db` loud: it takes the next number. Returns the number, for
  // the encoder, or null when it is not to be sent (`send` false: muted, or no encoder).
  captured(db, send) {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    if (!send) return null;
    this.pending.push({ seq, db });
    return seq;
  }

  // The encoder's next packet as a datagram, or null for one it was never given a frame for.
  encoded(chunk) {
    const frame = this.pending.shift();
    if (!frame) return null;
    const { seq, db } = frame;
    const datagram = new Uint8Array(HEADER + chunk.byteLength);
    const view = new DataView(datagram.buffer);
    view.setUint8(0, 0);
    view.setUint16(1, seq & 0xffff);
    view.setUint32(3, (seq * FRAME) >>> 0);
    view.setUint8(7, db);
    view.setUint8(8, (db >= SILENT_DB ? 1 : 0) | 2);
    chunk.copyTo(datagram.subarray(HEADER));
    return datagram;
  }

  // A new encoder: what the old one held is gone. The numbers go on.
  restart() {
    this.pending = [];
  }
}
