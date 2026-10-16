// A call's refusals and its backoff from the relays that gave them (ADR 0023, ADR 0024): a relay
// that will not have the page takes its session, then closes it at once with a code. From the
// relay the call is in, or before the call has been in anywhere, a refusal ends the call; anywhere
// else it is a failed join, that relay asked again 3 s on, doubling to 30 s, and, out of the room,
// why the call says it is still trying, until a try fails for a reason of its own. A locked room
// (ADR 0028) is such a refusal. Moderation's endings, a kick, a ban and the room ended, end the
// call from any relay, whenever it comes (ENDINGS).
// Tested by refusals.test.js, and through calls by relays.test.js and voice.test.js
// (`node --test 'web/**/*.test.js'`).

import { EXPIRED } from './link.js';
import { RUN_OUT } from './tokens.js';

const BACKOFF_MS = 3000;         // a refusing relay is asked again after this, doubling each time
const BACKOFF_MOST_MS = 30_000;  // up to this

// The refusals this page knows: each with the call's reason, what the page says as it ends the
// call, what it says while it goes on trying, and what the log says.
const REFUSALS = new Map([
  [0x1001, {
    reason: 'room-full',
    ends: 'The room is full. Try again once someone leaves.',
    trying: 'The room is full right now. Still trying…',
    words: 'the room is full',
  }],
  [0x1002, {
    reason: 'too-many-sessions',
    ends: 'You are in this call from too many tabs or devices. Close one, then join again.',
    trying: 'You are in this call from too many tabs or devices right now. Still trying…',
    words: 'there are too many sessions',
  }],
  // A locked room lets in no newcomer below moderator, and puts nobody in out (ADR 0028).
  [0x1023, {
    reason: 'locked',
    ends: 'The room is locked: nobody new may join now. Try again later.',
    trying: 'The room is locked right now. Still trying…',
    words: 'the room is locked',
  }],
]);
// A relay's verdict on the token a session carried (ADR 0027), whichever relay gives it: the
// token's fault, never the relay's, so no relay is backed off for it. Each with the reason and
// words the call ends with, or, with a token function asked for a fresh one, goes on trying with.
export const TOKEN_EXPIRED = 0x1010;
export const TOKEN_REFUSED = 0x1011;
export const SUSPENDED = 0x1012;
export const TOKEN_VERDICTS = new Map([
  [TOKEN_EXPIRED, {
    reason: 'expired',
    ends: EXPIRED,
    trying: RUN_OUT,
    words: 'the token has expired',
  }],
  [TOKEN_REFUSED, {
    reason: 'token-refused',
    ends: 'The voice server refused this call’s link. Ask whoever set up the call for a new one.',
    trying: 'The voice server refused this call’s link. Asking for a fresh one…',
    words: 'it refuses the token',
  }],
  [SUSPENDED, {
    reason: 'suspended',
    ends: 'This app’s account with the voice service is suspended, so the call cannot connect.',
    words: 'the app’s account is suspended',
  }],
]);

// Moderation's endings (ADR 0028): kicked, banned, the room ended. Whichever relay closes a session
// with one, the relay the call is in, one it moves to or probes, or one it rejoins, it ends the
// call: the origin has put this person out of the room, and every relay keeps them out. Each with
// the reason and words the call ends with, and what the log says.
export const ENDINGS = new Map([
  [0x1020, { reason: 'kicked', ends: 'A moderator removed you from the call.', words: 'you were removed from the call' }],
  [0x1021, { reason: 'banned', ends: 'A moderator banned you from this room.', words: 'you are banned from the room' }],
  [0x1022, { reason: 'ended', ends: 'The call was ended.', words: 'the room was ended' }],
]);

// Any other code a relay closes a session with before its room state, which this page does not
// know. The page backs off it as a refusal, never ending the call for it.
const REFUSED = {
  reason: 'refused',
  trying: 'The voice server would not let you in right now. Still trying…',
  words: 'it would not let the page in',
};

// What a session's end means to the call: the relay is gone after letting the page in, or a join
// failed. A refusal that ends the call is the refusal itself.
export const CLOSED = 0;
export const FAILED = 1;

export class Refusals {
  #now;
  #note;
  #refusal = null;               // the last refusal met out of the room, since no other failure
  #waits = new Map();            // relays that refused the page lately, by key: { wait, until }, ms

  // `now()`: the page's clock, in ms. `note(line)`: the log.
  constructor(now, note) {
    this.#now = now;
    this.#note = note;
  }

  // A session at `key` ended, `ended` its close code and reason, or null with none. `admitted`:
  // it had brought room state. `current`: the relay the client is joined at, or null. `everIn`:
  // whether the call has been in anywhere. `out`: the call is out of the room. Returns the refusal
  // that ends the call, CLOSED or FAILED.
  closed(key, ended, { admitted, current, everIn, out }) {
    const known = ended ? REFUSALS.get(ended.code) : undefined;
    if (known) {
      // From the relay the call is in, or before the call has been in anywhere, a refusal ends it.
      if ((key === current && admitted) || !everIn) return known;
      return this.#refused(key, known, out);
    }
    if (admitted) return CLOSED;
    // Before its first room state, any end is a failed join. A code this page does not know is a
    // refusal of a kind it cannot name, backed off and said as one; 0 says nothing of why, and is
    // backed off alone; none, as when a relay drops its connection right after a refusal's
    // capsule, is a relay gone before it let the page in.
    if (ended && ended.code !== 0) {
      return this.#refused(key, { ...REFUSED, words: `${REFUSED.words} (code 0x${ended.code.toString(16)})` }, out);
    }
    if (ended) this.#backOff(key);
    this.forget();
    return FAILED;
  }

  // Why the call is still trying, out of the room: the refusal remembered, or null.
  trying() { return this.#refusal; }

  // How long the relay at `key` has refused the page for, if it is not to be asked yet: its wait
  // in ms, or 0.
  blocked(key) {
    const back = this.#waits.get(key);
    return back && this.#now() < back.until ? back.wait : 0;
  }

  // A try failed for a reason of its own, or the call is in, or a relay holds the page without
  // room state: the refusal remembered is no longer why it is out.
  forget() { this.#refusal = null; }

  // Out of the room, why the call is still trying is `refusal`, a token's verdict, which backs
  // no relay off.
  remember(refusal) { this.#refusal = refusal; }

  // Let in anywhere: relays that refused are asked at once again, should it come to that.
  admitted() { this.#waits.clear(); }

  // A relay that would not have the page: asked again later and later, and, out of the room, why
  // the call is still trying. One met by a move or a probe while the call stays in is not why it
  // later leaves, and is forgotten.
  #refused(key, refusal, out) {
    this.#note(`${key} says ${refusal.words}: the call goes on`);
    this.#backOff(key);
    if (out) this.#refusal = refusal;
    return FAILED;
  }

  // The relay at `key` is asked again 3 s on, doubling each time it would not have the page.
  #backOff(key) {
    const back = this.#waits.get(key);
    const wait = back ? Math.min(back.wait * 2, BACKOFF_MOST_MS) : BACKOFF_MS;
    this.#waits.set(key, { wait, until: this.#now() + wait });
  }
}
