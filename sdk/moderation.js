// Moderators' and admins' actions (ADRs 0025, 0028): mute by force and lift it, kick, ban, promote,
// demote, lock and unlock, and end the room. Each is an `Act` on the page's own stream, numbered,
// and a promise the origin's `Acted` settles: done, or rejected with why. The SDK decides nothing:
// roles only show or hide an app's buttons, and the origin checks every act against the actor's
// verified role.
// - Not now (an edge serving the room alone) is asked again each second, under the same number.
// - No answer within 5 s rejects, `no-answer`.
// - Each goes on the session the call is in, and again on the next if that one is gone unanswered.
// - A call not in the room, or one that ends while an act waits, rejects it `not-in`.
// Tested through calls by moderation.test.js (`node --test 'web/**/*.test.js'`).

import { VoiceError, personName } from './shared.js';

// An act's byte, by name, as voice-proto has them.
export const ACTIONS = { mute: 1, lift: 2, kick: 3, ban: 4, promote: 5, demote: 6, lock: 7, unlock: 8, end: 9 };
// How the origin answered.
const DONE = 0, NOT_NOW = 4;
const NO_ANSWER_MS = 5000;       // an act unanswered this long is rejected
const AGAIN_MS = 1000;           // not now: asked again this long after

// The words the log has for each act.
const WORDS = {
  [ACTIONS.mute]: 'mute', [ACTIONS.lift]: 'lift the mute of', [ACTIONS.kick]: 'kick', [ACTIONS.ban]: 'ban',
  [ACTIONS.promote]: 'promote', [ACTIONS.demote]: 'demote', [ACTIONS.lock]: 'lock the room',
  [ACTIONS.unlock]: 'unlock the room', [ACTIONS.end]: 'end the room',
};
// What a refusal rejects with: a reason, and the page's words for people.
const REFUSED = new Map([
  [1, ['not-allowed', 'Your role does not allow that.']],
  [2, ['no-such-person', 'That person is not in the room.']],
  [3, ['slow-down', 'Too many actions at once. Try again in a moment.']],
]);
export const NOT_IN = 'You are not in the call.';
const NO_ANSWER = 'The voice server did not answer. Try again.';

export class Moderation {
  #hooks;
  #waiting = new Map();          // acts sent and not yet settled, by number
  #numbers = 0;                  // acts made, which number them

  // Hooks: now(), ms; act(number, action, user), the act's bytes; send(bytes), sent on the session
  // the call is in, which it returns, or null with none; current(), that session, or null,
  // compared as itself; note(line), the log.
  constructor(hooks) { this.#hooks = hooks; }

  // Asks the origin for `action` (ACTIONS's byte) on `user`, a BigInt (0 for the room's own): a
  // promise of its answer.
  ask(action, user) {
    const number = (this.#numbers + 1) >>> 0;
    this.#numbers = number;
    const target = action === ACTIONS.lock || action === ACTIONS.unlock || action === ACTIONS.end ? '' : ` ${personName(user)}`;
    this.#hooks.note(`asking to ${WORDS[action]}${target}`);
    return new Promise((resolve, reject) => {
      const act = { action, user, resolve, reject, since: this.#hooks.now(), session: null, again: Infinity };
      this.#waiting.set(number, act);
      this.#send(number, act);
    });
  }

  // The origin's answer: { number, outcome }. Not now is asked again in a second; any other
  // settles its act. An answer to no act waiting is none.
  answered({ number, outcome }) {
    const act = this.#waiting.get(number);
    if (!act) return;
    if (outcome === NOT_NOW) {
      act.again = this.#hooks.now() + AGAIN_MS;
      return;
    }
    this.#waiting.delete(number);
    if (outcome === DONE) {
      act.resolve();
      return;
    }
    const [reason, message] = REFUSED.get(outcome) ?? ['refused', 'The voice server refused that.'];
    this.#hooks.note(`act ${number} refused: ${reason}`);
    act.reject(new VoiceError(reason, message));
  }

  // The call's step: each act unanswered 5 s rejected; each not now due asked again; and each whose
  // session the call is no longer in sent again on the one it is, if any.
  step() {
    if (this.#waiting.size === 0) return;
    const now = this.#hooks.now();
    const current = this.#hooks.current();
    for (const [number, act] of this.#waiting) {
      if (now - act.since >= NO_ANSWER_MS) {
        this.#waiting.delete(number);
        this.#hooks.note(`act ${number}: no answer`);
        act.reject(new VoiceError('no-answer', NO_ANSWER));
      } else if (now >= act.again || (current !== null && act.session !== current)) {
        act.again = Infinity;
        this.#send(number, act);
      }
    }
  }

  // The call ended, or left the room for good: every act waiting is rejected, not-in.
  end() {
    const waiting = [...this.#waiting.values()];
    this.#waiting.clear();
    for (const act of waiting) act.reject(new VoiceError('not-in', NOT_IN));
  }

  #send(number, act) {
    act.session = this.#hooks.send(this.#hooks.act(number, act.action, act.user));
  }
}
