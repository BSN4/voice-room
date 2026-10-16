// The token a call joins with, and its renewal (ADR 0024). An app that issues short tokens, of
// about 10 minutes, gives join() a function that asks its backend for a fresh format-3 one. A
// relay checks a token only at CONNECT, so the sessions already open go on; each new one (a probe,
// a move, a reconnect) takes the freshest token held, and so never waits on the app's backend.
//
// When the page asks:
// - first, as prepare() starts; and as a call joins, only with no token held, or less than a
//   minute of it left;
// - then in the background, from the call's watch: at about two thirds of the held token's life,
//   or at once with less than a minute of it left;
// - out of the room, with no refusal to say why, at once, or 30 s after the last ask, in case this
//   device's clock ran slow and the relays found the token run out before the page thought it
//   would; then 30 s on, doubling to 5 minutes, so an outage of ours never floods a tenant's token
//   endpoint, and back to the start once a relay lets the page in again. An ask that fails is
//   asked again as below, whatever the room.
// One call to the app's function at a time, from the app's side too: an ask it does not answer
// within 10 s has failed, but the next waits until that call settles, or has been pending a
// minute. Asks come no sooner than 30 s apart while the held token is good by this device's clock,
// with 5 minutes of slack for a clock that runs fast; a failed one is asked again 2 s later,
// doubling to 30 s, once the held token has run out.
//
// What the page takes: any format-3 token naming the tenant, room and user of prepare's first one,
// whatever its expiry: every token a CONNECT carries is checked so, the first, a renewal, or one
// for a second join. Its role may differ: only new sessions carry it, and what a role change means
// mid-call is P3's (ADR 0025). The very token held, given back as from an app that caches its
// tokens, the same bytes but for its letters' case, is no renewal but a failed ask; one minted
// again with the same expiry, as after a key rotated, is taken.
// This device's clock refuses no token: one it reads as run out, or as lasting more than a day, is
// logged and taken, as the relays judge time by their own. Only the latest ask's answer counts: one
// that comes once a later ask has started, or once the call it was asked for has ended (a join
// that failed included), is dropped, never held, whether it came in time or after its 10 s; so no
// token outlives its call.
//
// The app's function may answer null: this person may no longer join. The call then ends, `denied`,
// and the app is asked no more: how a ban made in the app reaches a call whose sessions need a
// fresh token (ADR 0025).
// Tested by tokens.test.js, and through calls by renewal.test.js and renewal-asks.test.js
// (`node --test 'web/**/*.test.js'`).

import { readLink, warning } from './link.js';
import { VoiceError, why } from './shared.js';

const SOON_MS = 60_000;        // with less than this left, a token is due at once
const SPACED_MS = 30_000;      // asks are this far apart while the held token is good
const RETRY_MS = 2000;         // a failed ask is tried again after this, doubling
const RETRY_MOST_MS = 30_000;  // up to this
const ASK_MS = 10_000;         // the app's function answers within this, or the ask failed
const HUNG_MS = 60_000;        // a call to it unsettled this long is waited for no more
const OUT_MS = 30_000;         // out of the room, asks after the first are this far apart, doubling
const OUT_MOST_MS = 300_000;   // up to this
const SLACK_S = 300n;          // this device's clock may run this far ahead of the relays'

const NO_TOKEN = 'Couldn’t get a token to join the call. Try again in a moment.';
export const DENIED = 'You can no longer join this call.';
export const RUN_OUT = 'The link may have run out, and the app has not given a fresh one. Still trying…';

export class Tokens {
  #link;
  #first = null;      // the first token taken: every one after must name its tenant, room and user
  #ask;
  #env;
  #note;
  #heard = null;      // the call that hears each ask's outcome
  #generation = 0;    // counts the calls that ended: an answer for an older one is dropped
  #asked = 0;         // counts the asks started: only the latest's answer counts
  #at = Infinity;     // when the next ask is due, ms since the epoch
  #last = -Infinity;  // when the last ask started
  #wait = RETRY_MS;   // how long a failed one waits before the next, once the token has run out
  #failures = 0;      // asks failed since the last token taken
  #asking = null;     // the ask under way: a promise of its outcome, at its answer or its 10 s
  #calling = null;    // the app's call still unsettled, past its 10 s: when it started
  #urgeAt = -Infinity; // out of the room, when the next ask may be urged
  #urgeWait = OUT_MS;  // and how long the one after waits
  #denied = false;

  // `link`: a link, read, that never renews; or null, and `ask`, the app's function. `env`: date(),
  // setTimeout(fn, ms) and clearTimeout(id). `note(line)`: the log.
  constructor(link, ask, env, note) {
    this.#link = link;
    this.#ask = ask;
    this.#env = env;
    this.#note = note;
  }

  // The token held: a link, read; null before the first, or once a renewed one is forgotten.
  get link() { return this.#link; }

  // Whether the held token is renewed, so that its running out ends nothing by itself.
  get renews() { return this.#ask !== null; }

  // Whether this device's clock reads the held token as run out, past the slack it may run fast.
  get spent() { return this.#link !== null && this.#spent(this.#link, this.#env.date()); }

  // A token to join with, as prepare() starts or a call joins: asked for first with none held, or
  // less than a minute of it left (unless asked for in the last 30 s); otherwise the one held, its
  // renewal left to the call's watch. Throws a VoiceError, 'denied' or 'no-token', if there is
  // none.
  async ready() {
    if (this.#ask) {
      if (this.#asking) await this.#asking;
      const now = this.#env.date();
      const soon = this.#link && Number(this.#link.expires) * 1000 - now < SOON_MS && now - this.#last >= SPACED_MS;
      if (!this.#denied && !this.#hung(now) && (!this.#link || soon)) await this.#renew();
    }
    if (this.#denied) throw new VoiceError('denied', DENIED);
    if (!this.#link) throw new VoiceError('no-token', NO_TOKEN);
  }

  // A call starts on this token: `heard(outcome)` hears what each ask comes to while it lasts,
  // { link }, { failed: { attempts, retryIn } } or { denied }.
  listen(heard) {
    this.#heard = heard;
  }

  // Each 100 ms of a call: an ask, when one is due, none is under way and the app's last call has
  // settled. Out of the room (`out`), one urged at once, and then backing off.
  step(out) {
    if (!this.#ask || this.#asking || !this.#heard) return;
    const now = this.#env.date();
    if (out && now >= this.#urgeAt) {
      this.#urgeAt = now + this.#urgeWait;
      this.#urgeWait = Math.min(this.#urgeWait * 2, OUT_MOST_MS);
      this.#at = Math.min(this.#at, Math.max(now, this.#last + SPACED_MS));
    }
    if (now < this.#at || this.#hung(now)) return;
    this.#renew().then((outcome) => { if (outcome) this.#heard?.(outcome); });
  }

  // A relay refused the held token (ADR 0027): the app is asked at once, whatever the spacing, unless
  // an ask is under way. Each time after, as urged asks out of the room do, 30 s on, doubling to 5
  // minutes, so a token the relays keep finding expired never floods the app's endpoint. An ask made
  // `once`, as for a token refused outright, skips that wait and has no guard of its own: the call
  // makes it once for each token refused (call.js, #tokenRefused), and a failed one is asked again
  // as any failed ask is.
  refused(once) {
    const now = this.#env.date();
    if (!once) {
      if (now < this.#urgeAt) return;
      this.#urgeAt = now + this.#urgeWait;
      this.#urgeWait = Math.min(this.#urgeWait * 2, OUT_MOST_MS);
    }
    this.#at = now;
    this.step(false);
  }

  // The call is in the room: asks urged out of it start over.
  arrived() {
    this.#urgeAt = -Infinity;
    this.#urgeWait = OUT_MS;
  }

  // The call ended: what it was told stops, an answer still to come for it is dropped, and a
  // renewed token is forgotten, so none outlives its call, and the next join asks; a link the app
  // gave is kept for that join, unless `all`, as no join follows.
  forget(all) {
    this.#heard = null;
    this.#generation++;
    this.arrived();
    if (this.#ask || all) this.#link = null;
  }

  // Whether the app's last call, past its 10 s, has not settled yet and has had less than a minute.
  #hung(now) {
    return this.#calling !== null && now - this.#calling < HUNG_MS;
  }

  // One ask: a promise of its outcome, at the app's answer or after 10 s, whichever comes first.
  // An answer after its 10 s is used all the same while the call it was asked for lasts.
  #renew() {
    const generation = this.#generation;
    const ask = ++this.#asked;
    const started = this.#env.date();
    this.#last = started;
    let late = false;
    this.#asking = new Promise((resolve) => {
      const timer = this.#env.setTimeout(() => {
        late = true;
        this.#calling = started;
        resolve(this.#missed('the app did not answer within 10 s', generation, ask, false));
      }, ASK_MS);
      const answered = (outcome) => {
        this.#env.clearTimeout(timer);
        if (late) {
          if (this.#calling === started) this.#calling = null;
          if (outcome) this.#heard?.(outcome);
        } else {
          resolve(outcome);
        }
      };
      Promise.resolve().then(() => this.#ask()).then(
        (given) => answered(this.#answer(given, generation, ask, late)),
        (error) => answered(this.#missed(`asking for a token failed (${why(error)})`, generation, ask, late)),
      );
    }).finally(() => { this.#asking = null; });
    return this.#asking;
  }

  // The app's answer to the `ask`th ask, made for the call `generation`: its outcome, or null when
  // that call has ended or a later ask has started, or when it came after the ask had failed and
  // says nothing new.
  #answer(given, generation, ask, late) {
    if (this.#stale(generation, ask)) return null;
    if (given === null) {
      this.#denied = true;
      this.#at = Infinity;
      this.#note('the app says this person may no longer join');
      return { denied: true };
    }
    const link = typeof given === 'string' ? readLink(given) : null;
    const first = this.#first;
    let refused = null;
    if (!link || !link.join) refused = 'it is not a format-3 token';
    else if (first && (link.tenant !== first.tenant || link.room !== first.room || link.me !== first.me)) refused = 'it names another tenant, room or user';
    else if (this.#link && link.join.trim().toLowerCase() === this.#link.join.trim().toLowerCase()) refused = 'the app gave back the same token';
    if (refused) return this.#missed(this.#link ? `a renewed token refused: ${refused}; keeping the one held` : `the app’s token refused: ${refused}`, generation, ask, late);
    return this.#take(link);
  }

  // Whether what the `ask`th ask, made for the call `generation`, came to is past counting: that
  // call has ended, or a later ask has started. Then it is only noted.
  #stale(generation, ask) {
    if (generation !== this.#generation) this.#note('an answer that came after its call ended: dropped');
    else if (ask !== this.#asked) this.#note('an answer to an ask a later one took over from: dropped');
    else return false;
    return true;
  }

  // An ask that came to nothing, said in `words`: a failed one, asked again later; or, once its
  // 10 s have failed it already, or it is past counting, only noted.
  #missed(words, generation, ask, late) {
    if (this.#stale(generation, ask)) return null;
    if (!late) return this.#failed(words);
    this.#note(`${words}, after its 10 s`);
    return null;
  }

  #take(link) {
    const now = this.#env.date();
    if (this.#link && link.role !== this.#link.role) {
      this.#note(`the renewed token's role is ${link.role}, not ${this.#link.role}: only new sessions carry it`);
    }
    if (this.#spent(link, now)) this.#note('this device’s clock reads the token as run out: its clock may be fast, and the token is taken all the same');
    else if (warning(link, now)?.reason === 'too-long') this.#note('this device’s clock reads the token as lasting more than a day, which the relays refuse: taken all the same');
    const renewed = this.#link !== null;
    this.#link = link;
    this.#first ??= link;
    this.#wait = RETRY_MS;
    this.#failures = 0;
    this.#at = Math.max(this.#plan(now), this.#last + SPACED_MS);
    this.#note(`token ${renewed ? 'renewed' : 'taken'}: it runs out at ${new Date(Number(link.expires) * 1000).toISOString()}`);
    return { link };
  }

  #failed(words) {
    const now = this.#env.date();
    const good = this.#link !== null && !this.#spent(this.#link, now);
    const next = this.#last + (good ? Math.max(this.#wait, SPACED_MS) : this.#wait);
    this.#at = next;
    this.#wait = Math.min(this.#wait * 2, RETRY_MOST_MS);
    this.#failures++;
    // With the app's call still pending, the next waits for it, a minute after it started at most.
    const hung = this.#calling === null ? next : Math.max(next, this.#calling + HUNG_MS);
    const retryIn = Math.max(0, hung - now);
    this.#note(`${words}: asking again in ${Math.round(retryIn / 1000)} s`);
    return { failed: { attempts: this.#failures, retryIn } };
  }

  // When the held token is due: at two thirds of its life from `now`, or a minute before it runs
  // out, whichever is sooner.
  #plan(now) {
    const ends = Number(this.#link.expires) * 1000;
    return Math.min(now + ((ends - now) * 2) / 3, ends - SOON_MS);
  }

  // Whether `link` has run out at `now` by this device's clock, past the slack its clock may run
  // fast by.
  #spent(link, now) {
    return BigInt(Math.floor(now / 1000)) > link.expires + SLACK_S;
  }
}
