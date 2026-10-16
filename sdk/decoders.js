// Each person's audio decoder, by seat: WebCodecs' AudioDecoder, made when their first frame
// comes. A payload it cannot decode closes a decoder for good, and the relay never looks inside
// one: so a decoder that errored or was closed is replaced at the seat's next frame, or one bad
// frame would silence the seat, and whoever is given it next, until this page joined again.
// The seats are 256 fixed slots, and the seats heard from a packed list, walked by index each beat.
//
// The call waits for each beat's frames to come back before it sends the beat's news (call.js). A
// decoder gives one output for each chunk it is given, in order, so the beat's frames are settled
// by count: each output while the decoder owes a chunk given this beat is one of them. None of it
// hangs on outputs' timestamps, which the browsers set differently: Firefox gives each output its
// chunk's, Chromium the first chunk's plus the samples given since, so one sender's 10 ms packets
// would never match theirs. What a decoder still owes from before the beat is not counted
// against it: a frame whose output never comes holds up its own beat's news until the next beat
// starts, when the call sends what that beat still holds, and the count is right again at the
// next; so a decoder that takes frames and never answers delays the other seats one beat at most.
// An older frame that comes back late counts for the beat it comes in, so a decoder slower than a
// beat sends each frame a message late, never stalls the news. A
// chunk with no bytes gives no output in Chromium, so a frame with no payload is never handed to
// a decoder: the call takes it as lost.
// When a decoder fails, or is closed as its seat is let go, nothing more comes (WebCodecs gives
// nothing after), and the call is told this beat's frames are settled, which it would otherwise
// wait for. A frame lost on a seat whose decoder still owes it frames is held back until they have
// come back, by count, so the playout hears it in its place; or until the seat has been quiet two
// beats, or its decoder fails or goes, as those may never come. A seat holds eight back at most.
// Tested by decoders.test.js (`node --test 'web/**/*.test.js'`), with a stand-in decoder.

import { why } from './shared.js';

const EMPTY = 0, MADE = 1, NONE = 2;   // a slot: no seat, a decoder, or one to make at next frame
const FRAME_US = 20_000;               // a frame's length, as its chunk's timestamp counts it
const HELD = 8;                        // lost frames a seat holds back at most

export class Decoders {
  // AudioDecoder, EncodedAudioChunk: the browser's. play(seat, audio): a decoded AudioData.
  // lose(seat): a frame lost, in its place. settled(): a frame given this beat came back, or never
  // will. note(text): a line for the log.
  constructor({ AudioDecoder, EncodedAudioChunk, play, lose, settled, note }) {
    Object.assign(this, { AudioDecoder, EncodedAudioChunk, play, lose, settled, note });
    this.decoders = new Array(256).fill(null);
    this.pending = new Array(256).fill(null); // by seat: what its decoder owes (make)
    this.counts = new Float64Array(256);   // frames given each seat, for timestamps
    this.state = new Uint8Array(256);
    this.list = new Uint8Array(256);       // the seats heard from, packed at the front
    this.count = 0;
    this.beats = 0;
    this.at = new Float64Array(256);       // by seat: the beat of its last frame or loss
    this.after = new Float64Array(256 * HELD); // by seat, a ring: the frame each held loss follows
    this.first = new Uint8Array(256);      // where each seat's ring starts
    this.held = new Uint8Array(256);       // and how many it holds
  }

  // The `k`th seat heard from, k below `count`.
  seatAt(k) { return this.list[k]; }

  // A seat heard from: it gets a decoder.
  add(seat) {
    if (this.state[seat] !== EMPTY) return;
    this.list[this.count++] = seat;
    this.make(seat);
  }

  // Seat `seat`'s next frame, Opus bytes, never none: true once a decoder has it, its output to
  // come. A decoder that failed or was closed gives way to a new one first.
  decode(seat, opus) {
    if (this.state[seat] === EMPTY) return false;
    let decoder = this.decoders[seat];
    if (this.state[seat] === NONE || decoder.state !== 'configured') {
      this.shut(seat);
      if (!this.make(seat)) return false;
      decoder = this.decoders[seat];
    }
    const timestamp = (this.counts[seat]++) * FRAME_US;
    try {
      decoder.decode(new this.EncodedAudioChunk({ type: 'key', timestamp, data: opus }));
      const owed = this.pending[seat];
      owed.now++;
      owed.given++;
      this.at[seat] = this.beats;
      return true;
    } catch (error) {
      this.note(`seat ${seat + 1}: the audio decoder refused a frame (${why(error)}): a new one takes the next`);
      this.shut(seat);
      this.state[seat] = NONE;
      return false;
    }
  }

  // A frame lost on `seat`: told now, or held back behind the frames its decoder still owes.
  lost(seat) {
    this.at[seat] = this.beats;
    const owed = this.pending[seat];
    if (!owed || owed.back === owed.given) {
      this.lose(seat);
      return;
    }
    if (this.held[seat] === HELD) this.tell(seat, Infinity, 1);
    this.after[seat * HELD + ((this.first[seat] + this.held[seat]) % HELD)] = owed.given;
    this.held[seat]++;
  }

  // Seat `seat`'s held losses that follow no more than `back` of its decoder's chunks, told in
  // their order: `most` of them at most.
  tell(seat, back, most = HELD) {
    for (let told = 0; told < most && this.held[seat] > 0; told++) {
      if (this.after[seat * HELD + this.first[seat]] > back) return;
      this.first[seat] = (this.first[seat] + 1) % HELD;
      this.held[seat]--;
      this.lose(seat);
    }
  }

  // Seat `seat`'s decoder closed, if it is not already, and gone: what it still owed never comes.
  shut(seat) {
    const decoder = this.decoders[seat];
    if (decoder && decoder.state !== 'closed') decoder.close();
    this.decoders[seat] = null;
    if (this.pending[seat]) this.forgo(seat, this.pending[seat]);
    this.pending[seat] = null;
  }

  // What seat `seat`'s decoder owed, none of which will come now: its losses held back are told,
  // and this beat's frames settled.
  forgo(seat, owed) {
    const now = owed.now;
    owed.now = 0;
    owed.back = owed.given;
    this.tell(seat, Infinity);
    for (let k = 0; k < now; k++) this.settled();
  }

  // A new beat: frames still to come from the last are counted against it no more, and a seat
  // quiet two beats lets go of what its decoder owes, telling the losses it held back.
  beat() {
    this.beats++;
    for (let k = 0; k < this.count; k++) {
      const seat = this.list[k];
      const owed = this.pending[seat];
      if (!owed) continue;
      owed.now = 0;
      if (this.beats - this.at[seat] < 2) continue;
      owed.back = owed.given;
      this.tell(seat, Infinity);
    }
  }

  // The seat's person left it: their decoder is closed and the seat forgotten.
  drop(seat) {
    if (this.state[seat] === EMPTY) return;
    this.shut(seat);
    this.state[seat] = EMPTY;
    for (let k = 0; k < this.count; k++) {
      if (this.list[k] !== seat) continue;
      this.count--;
      this.list[k] = this.list[this.count];
      return;
    }
  }

  // Whether `seat` has been heard from since it was last let go.
  has(seat) { return this.state[seat] !== EMPTY; }

  // The seat has a new holder (ADR 0028): their decoder goes, and a new one takes their next
  // frame. The seat stays among those heard from, so a beat walking them goes on in its place.
  renew(seat) {
    if (this.state[seat] === EMPTY) return;
    this.shut(seat);
    this.state[seat] = NONE;
  }

  // The page left: every decoder goes.
  close() {
    while (this.count > 0) this.drop(this.list[0]);
  }

  // A decoder for `seat`: true, or false if the browser would not make one, and the next frame
  // tries again.
  make(seat) {
    // Counts: chunks given this beat still to come; chunks given in all; and outputs given back,
    // or let go.
    const owed = { now: 0, given: 0, back: 0 };
    try {
      const decoder = new this.AudioDecoder({
        // A decoder gives its frames back in the order it was given them, one output each: the
        // losses held back behind this one are told after it.
        output: (audio) => {
          const now = owed.now > 0;
          if (now) owed.now--;
          if (owed.back < owed.given) owed.back++;
          this.play(seat, audio);
          this.tell(seat, owed.back);
          if (now) this.settled();
        },
        error: (error) => {
          this.note(`seat ${seat + 1}: the audio decoder failed (${why(error)}): a new one takes the next frame`);
          this.forgo(seat, owed);
        },
      });
      decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      this.decoders[seat] = decoder;
      this.pending[seat] = owed;
      this.state[seat] = MADE;
      return true;
    } catch (error) {
      this.note(`seat ${seat + 1}: could not make an audio decoder: ${why(error)}`);
      this.decoders[seat] = null;
      this.state[seat] = NONE;
      return false;
    }
  }
}
