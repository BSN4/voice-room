// What the relays say about the room, on their control streams (ADR 0004): each control frame is
// a 2-byte length, then its kind and fields (crates/voice-proto, control). The call hands every
// frame to the client core first, which reads it whole with voice-proto and says its kind: a
// relay list (2) or redirect (3) it takes itself, and the frames below are the call's, their
// fields read here where voice-proto found them (ADR 0028):
// - 4, room state: room u64, others u32, flags u8 (bit 0 locked), count u16, then each person:
//   user u64, role u8, flags u8 (bit 0 muted by force, bit 1 holds a seat), seat u8, seat epoch u8;
// - 5, a seat's holder: room u64, seat u8, seat epoch u8, user u64, role u8;
// - 6, the answer to a talk: ask u32, outcome u8, seat u8, seat epoch u8;
// - 7, the answer to an act: number u32, outcome u8.
// The page reads the relay list's epoch and relays too, for its numbers.
// Tested by room.test.js (`node --test 'web/**/*.test.js'`).

import { ipText, jsonable, personName } from './shared.js';

// A role's byte, as room state and a holder carry it: 0 in a demo room, which has none.
const ROLES = [null, 'speaker', 'moderator', 'admin'];

// Control frames cut from one stream, however its bytes arrive.
export class ControlFrames {
  constructor() { this.buffer = new Uint8Array(0); }

  // The next bytes off the stream: the bodies of the frames they complete, in order.
  push(bytes) {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
    const bodies = [];
    for (;;) {
      if (this.buffer.length < 2) break;
      const len = (this.buffer[0] << 8) | this.buffer[1];
      if (this.buffer.length < 2 + len) break;
      bodies.push(this.buffer.slice(2, 2 + len));
      this.buffer = this.buffer.slice(2 + len);
    }
    return bodies;
  }
}

const viewOf = (body) => new DataView(body.buffer, body.byteOffset, body.byteLength);

// Room state, kind 4, as voice-proto read it whole: { room, others, locked, people }, each person
// { user, role, muted, seated, seat, epoch }, seat holders first by seat, then moderators and
// admins, then the rest.
export function readRoomState(body) {
  const view = viewOf(body);
  const people = [];
  const count = view.getUint16(14);
  for (let i = 0, at = 16; i < count; i++, at += 12) {
    const flags = body[at + 9];
    people.push({
      user: view.getBigUint64(at), role: ROLES[body[at + 8]] ?? null, muted: (flags & 1) !== 0,
      seated: (flags & 2) !== 0, seat: body[at + 10], epoch: body[at + 11],
    });
  }
  return { room: view.getBigUint64(1), others: view.getUint32(9), locked: (body[13] & 1) !== 0, people };
}

// A seat's holder, kind 5: { room, seat, epoch, user, role }.
export function readHolder(body) {
  const view = viewOf(body);
  return { room: view.getBigUint64(1), seat: body[9], epoch: body[10], user: view.getBigUint64(11), role: ROLES[body[19]] ?? null };
}

// The answer to a talk, kind 6: { ask, outcome, seat, epoch }, outcome 0 seated, 1 all busy, 2 muted
// by force, 3 not now.
export function readSeated(body) {
  return { ask: viewOf(body).getUint32(1), outcome: body[5], seat: body[6], epoch: body[7] };
}

// The answer to an act, kind 7: { number, outcome }, outcome 0 done, 1 not allowed, 2 no such
// person, 3 slow down, 4 not now.
export function readActed(body) {
  return { number: viewOf(body).getUint32(1), outcome: body[5] };
}

// The relay list's epoch, which goes with every join, and its relays as "ip:port", for the
// details: kind 2, epoch u64, count u8, then per relay: id u64, address u32, port u16, draining
// u8, certificate hash 32. Null for any other frame.
export function readRelayList(body) {
  const view = viewOf(body);
  if (body.length < 10 || view.getUint8(0) !== 2) return null;
  const relays = [];
  for (let i = 0, at = 10; i < body[9] && at + 47 <= body.length; i++, at += 47) {
    relays.push(`${ipText(view.getUint32(at + 8))}:${view.getUint16(at + 12)}${body[at + 14] ? ' (draining)' : ''}`);
  }
  return { epoch: view.getBigUint64(1), relays };
}

// The room as room state last showed it, and each holder since, for the person room state names
// `me`.
export class People {
  constructor(me) {
    this.me = me;
    this.room = null;            // the last room state read, as holders since changed it, or null
    this.holders = [];           // { seat, user } of each seat held, by seat, rebuilt only on a change
  }

  // A person as the app sees them: { user, role, muted, seat, you, name }, seat null with none.
  shown(person) {
    const { user, role, muted, seated, seat } = person;
    return jsonable({ user, role, muted, seat: seated ? seat : null, you: user === this.me, name: personName(user) });
  }

  // Everyone room state names, as the app sees them.
  list() { return (this.room?.people ?? []).map((person) => this.shown(person)); }

  // This page's own person, as room state names them, or null.
  mine() { return this.room?.people.find(({ user }) => user === this.me) ?? null; }

  // A new room state, whole. Who came and who left since the last, as the app sees them; the
  // seats someone holds under another holder or epoch than before, { seat, epoch }, and the seats
  // nobody holds now that someone did.
  update(state) {
    const before = this.room?.people ?? [];
    const was = new Set(before.map(({ user }) => user));
    const now = new Set(state.people.map(({ user }) => user));
    const came = state.people.filter(({ user }) => !was.has(user)).map((person) => this.shown(person));
    const left = before.filter(({ user }) => !now.has(user)).map((person) => this.shown(person));
    const seats = this.#seats();
    this.room = state;
    return { came, left, ...this.#changed(seats) };
  }

  // A seat's new holder, from a Holder: they hold `seat` under `epoch`, and whoever held it does
  // not; a holder not yet named joins the people. As update() says, of the seats.
  holder({ seat, epoch, user, role }) {
    const seats = this.#seats();
    const people = (this.room?.people ?? []).map((person) => (person.seated && person.seat === seat && person.user !== user
      ? { ...person, seated: false, seat: 0, epoch: 0 }
      : person));
    const at = people.findIndex((person) => person.user === user);
    const holding = { user, muted: false, ...(at >= 0 ? people[at] : {}), role, seated: true, seat, epoch };
    if (at >= 0) people[at] = holding;
    else people.push(holding);
    this.room = { room: this.room?.room ?? 0n, others: this.room?.others ?? 0, locked: this.room?.locked ?? false, people };
    return this.#changed(seats);
  }

  // Out of the room: the next room state shows everyone as new.
  clear() {
    this.room = null;
    this.holders = [];
  }

  // Each seat held now, by seat: who and under which epoch.
  #seats() {
    const held = new Map();
    for (const { seated, seat, user, epoch } of this.room?.people ?? []) if (seated) held.set(seat, { user, epoch });
    return held;
  }

  // The seats taken and freed since `before`, and the holders' list again if any changed.
  #changed(before) {
    const after = this.#seats();
    const taken = [];
    const freed = [];
    for (const [seat, { user, epoch }] of after) {
      const was = before.get(seat);
      if (!was || was.user !== user || was.epoch !== epoch) taken.push({ seat, epoch });
    }
    for (const seat of before.keys()) if (!after.has(seat)) freed.push(seat);
    if (taken.length || freed.length || after.size !== this.holders.length) {
      this.holders = [...after].sort(([x], [y]) => x - y).map(([seat, { user }]) => ({ seat, user }));
    }
    return { taken, freed };
  }
}
