// This page's seat (ADR 0028). Seats go to whoever talks: a page holds none at join, and when its
// speech gate opens (frames.js) with no seat, and no mute by force, it asks the room's origin for
// one with a `Talk`. Meanwhile it holds what it encodes, the last second at most, so the first
// words are not cut; once seated, it writes the seat's epoch into each held header and sends them
// at once, in order, then goes on live. With every seat busy, the app hears it waits, and it asks
// again every 500 ms while the gate stays open. The gate shutting with no seat, or a mute by
// force, drops what it holds.
//
// One ask is out at a time, on the session the call is in; one whose session the call is no
// longer in, as one that ended, is asked again on the one it is. Room state and holders say the seat as well: the
// origin alone gives seats, and the page writes the epoch the last of them names.
// Tested by seats.test.js, and through calls by seats-call.test.js
// (`node --test 'web/**/*.test.js'`).

// How the origin answered a talk.
export const SEATED = 0, ALL_BUSY = 1, MUTED = 2, NOT_NOW = 3;
// Frames held while it asks: the last second of 20 ms frames.
export const HELD_MOST = 50;
const ASK_AGAIN_MS = 500;        // all busy, or not now: asked again this long after

// A datagram's flags: its seat epoch's low two bits, in bits 2 and 3.
const EPOCH_BITS = 0b1100;
function stamp(datagram, epoch) {
  datagram[8] = (datagram[8] & ~EPOCH_BITS) | ((epoch & 3) << 2);
}

export class OwnSeat {
  seat = null;                   // the seat this page holds, or null
  epoch = 0;                     // and its epoch
  waiting = false;               // every seat was busy at the last answer, and the gate is open
  #hooks;
  #held = new Array(HELD_MOST).fill(null); // the words held while it asks, oldest at #first
  #first = 0;
  #count = 0;
  #asks = 0;                     // asks made, which number them
  #out = null;                   // the ask out: { ask, session }, the session as the hooks give it
  #again = -Infinity;            // when the next ask may go, after all busy

  // Hooks: talk(ask), a Talk numbered `ask` on the session the call is in, which it returns, or
  // null with none; current(), that session, or null, compared as itself, so a session again at
  // the same relay is another; send(datagram), a datagram to it; now(), ms;
  // mine(seat), the client core told the page's own seat, or null; told(seat, waiting), the app
  // told, which says whether the call still goes; forced(), the origin answered that the page is
  // muted by force; note(line), the log.
  constructor(hooks) { this.#hooks = hooks; }

  // A datagram of speech the gate let through, its header written: sent under the seat's epoch,
  // or, with no seat, held while it asks.
  speech(datagram) {
    if (this.seat !== null) {
      stamp(datagram, this.epoch);
      this.#hooks.send(datagram);
      return;
    }
    this.#hold(datagram);
    const out = this.#out;
    if (out && out.session === this.#hooks.current()) return;
    if (!out && this.#hooks.now() < this.#again) return;
    this.#ask();
  }

  // The gate shut, the page was muted, or it could not send: what it holds goes, and it waits on no
  // seat. An ask still out stands.
  quiet() {
    this.#drop();
    this.#again = -Infinity;
    if (this.waiting) this.#tell(this.seat, false);
  }

  // The origin's answer to a talk: { ask, outcome, seat, epoch }. Any but the ask out's is none.
  answered({ ask, outcome, seat, epoch }) {
    if (!this.#out || this.#out.ask !== ask) return;
    this.#out = null;
    if (outcome === SEATED) {
      this.#note(`seat ${seat + 1} is yours`);
      this.holds(seat, epoch);
      return;
    }
    if (outcome === MUTED) {
      this.#note('no seat: you are muted by a moderator');
      this.#drop();
      this.#hooks.forced();
      if (this.waiting) this.#tell(this.seat, false);
      return;
    }
    // All busy, or nobody answers for the room now: asked again shortly, while the gate is open.
    this.#again = this.#hooks.now() + ASK_AGAIN_MS;
    this.#note(outcome === ALL_BUSY ? 'every seat is busy: asking again shortly' : 'no seat to be had now: asking again shortly');
    if (!this.waiting) this.#tell(null, true);
  }

  // Room state, a holder or an answer says this page holds `seat` under `epoch`, or no seat
  // (null). Seated, what it holds goes at once, before the app hears.
  holds(seat, epoch) {
    if (seat === this.seat && (seat === null || epoch === this.epoch)) return;
    const changed = seat !== this.seat;
    this.seat = seat;
    this.epoch = seat === null ? 0 : epoch;
    if (changed) this.#hooks.mine(seat);
    if (seat !== null) {
      // Seated, whatever an ask still out would have said.
      this.#out = null;
      this.#flush();
    }
    // A page waiting holds no seat, so a seat that changes nothing ends no wait.
    if (changed) this.#tell(seat, false);
  }

  // The call left the room for good: nothing held, asked or waited on.
  clear() {
    this.#drop();
    this.seat = null;
    this.epoch = 0;
    this.waiting = false;
    this.#out = null;
    this.#again = -Infinity;
  }

  #ask() {
    const ask = (this.#asks + 1) >>> 0;
    const session = this.#hooks.talk(ask);
    this.#out = null;
    if (session === null) return;
    this.#asks = ask;
    this.#out = { ask, session };
    this.#note('asking for a seat');
  }

  #hold(datagram) {
    if (this.#count === HELD_MOST) {
      this.#held[this.#first] = null;
      this.#first = (this.#first + 1) % HELD_MOST;
      this.#count--;
    }
    this.#held[(this.#first + this.#count) % HELD_MOST] = datagram;
    this.#count++;
  }

  // What it holds, under the seat's epoch, oldest first.
  #flush() {
    if (this.#count > 0) this.#note(`sending the ${this.#count} frames held while asking`);
    for (let k = 0; k < this.#count; k++) {
      const at = (this.#first + k) % HELD_MOST;
      const datagram = this.#held[at];
      this.#held[at] = null;
      stamp(datagram, this.epoch);
      this.#hooks.send(datagram);
    }
    this.#first = 0;
    this.#count = 0;
  }

  #drop() {
    this.#held.fill(null);
    this.#first = 0;
    this.#count = 0;
  }

  #tell(seat, waiting) {
    this.waiting = waiting;
    return this.#hooks.told(seat, waiting);
  }

  #note(line) { this.#hooks.note(line); }
}
