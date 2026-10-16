// The client core in the page (ADRs 0010, 0011): which relay to join, whether it is there, and
// when to move are voice-client's, the Rust the simulator runs, compiled to WebAssembly
// (crates/voice-web), with each speaker's jitter buffer (ADR 0014). This wraps its plain exports:
// integers, and one buffer in the module's memory that carries a relay (address 4, port 2,
// certificate hash 32, big-endian) or a frame's bytes. One instance per call. A frame plays only
// under its seat's holder (ADR 0028): the call tells each holder and seat epoch, and each frame
// carries its epoch's two bits.
// Tested by client.test.js (`node --test 'web/**/*.test.js'`).

import { HEADER } from './frames.js';
import { ipText } from './shared.js';

// What `poll` says, besides nothing (0): join a relay (open a session there), leave one, ping one.
export const JOIN = 1, LEAVE = 2, PING = 3;
// What a push says the jitter buffer did with a frame, besides kept (0) and a repeat (1); or that
// it waits aside for the seat's next holder (ASIDE), or is nobody's now (STALE).
export const LATE = 2, REFUSED = 3, MINE = 4, ASIDE = 5, STALE = 6;
// What a pop says.
export const WAITING = 0, FRAME_OUT = 1, LOST = 2, LOST_WITH_NEXT = 3;
// What joinedId says when the client is joined nowhere.
export const NONE = -1;
// What frame() says of a control frame: the client took it (a relay list or a redirect), or it is
// one the call reads itself, read whole by voice-proto; or 0 for anything else.
export const TAKEN = 1, ROOM_STATE = 4, HOLDER = 5, SEATED = 6, ACTED = 7;

const RELAY_BYTES = 38;
const OPUS_MAX = 1275;           // the most bytes an Opus frame has (RFC 6716)
const BUFFER = 6162;             // the shared buffer: the longest room state frame (crates/voice-proto)
const FRAME_MAX = BUFFER - 2;    // and its body, without its length
const NO_SEAT = 256;             // own_seat's "none": no seat is past 255
const AFRESH = 1 << 20;          // in what a pop says: the seat started afresh first
const POPPED = 0x3ffff;          // and the bytes it wrote, above its kind

export class Client {
  #wasm;
  #base;
  #memory = null;
  #bytes = null;
  #view = null;
  #lengths = [];                 // a view over the buffer's first n bytes, by n, made once each
  #keys = new Map();             // a relay's number -> its "ip:port", made once
  opus = null;                   // the last frame popped: a view, good until the next call
  afresh = false;                // whether the last pop's seat started afresh first

  // `exports`: a voice-web instance's.
  constructor(exports) {
    this.#wasm = exports;
    this.#base = exports.buffer();
  }

  // The shared buffer's views, made again whenever the module's memory has grown: growing moves
  // it and detaches the old buffer, and any call into the module may grow it.
  #fresh() {
    const buffer = this.#wasm.memory.buffer;
    if (buffer === this.#memory) return;
    this.#memory = buffer;
    this.#bytes = new Uint8Array(buffer, this.#base, BUFFER);
    this.#view = new DataView(buffer, this.#base, RELAY_BYTES);
    this.#lengths = [];
  }

  // Starts the client for `room` at `first` ({ address, port, hash }), its random waits from
  // `seed`.
  start(room, first, seed, now) {
    this.#fresh();
    this.#view.setUint32(0, first.address);
    this.#view.setUint16(4, first.port);
    this.#bytes.set(first.hash, 6);
    this.#wasm.start(room, 0, seed, now, 1);
  }

  // The regions the page measured, nearest first (ADR 0036), each a name of up to 8 bytes: the
  // client chooses among the nearest region's relays first. Said again after every start.
  rank(regions) {
    this.#fresh();
    this.#bytes.fill(0, 0, regions.length * 8);
    regions.forEach((region, at) => {
      for (let i = 0; i < region.length; i++) this.#bytes[at * 8 + i] = region.charCodeAt(i);
    });
    this.#wasm.rank(regions.length);
  }

  // How strongly `room` (a BigInt) claims `relay` ({ address, port }), as the call orders the
  // relays it starts from within a region: a BigInt.
  score(room, relay) { return this.#wasm.score(room, relay.address, relay.port); }

  // What happened at `session` ({ address, port }): 'joined', 'ready', 'failed', 'closed' or
  // 'heard'.
  tell(what, session, now) { this.#wasm[what](now, session.address, session.port); }

  tick(now) { this.#wasm.tick(now); }

  // The person on `seat` let it go: their jitter buffer empties, and the next starts afresh.
  clearSeat(seat) { this.#wasm.jitter_clear_seat(seat); }

  // A frame went out to the relay.
  sent(now) { this.#wasm.sent(now); }

  // What the client says to do next: JOIN, LEAVE, PING, or 0 for nothing. Its relay is then read
  // with relay() or key().
  poll() { return this.#wasm.poll(); }

  // The relay the last poll named, with its certificate hash, for a join.
  relay() {
    this.#fresh();
    const address = this.#view.getUint32(0);
    const port = this.#view.getUint16(4);
    const ip = ipText(address);
    return { ip, port, address, key: `${ip}:${port}`, hash: this.#bytes.slice(6, RELAY_BYTES) };
  }

  // The relay the last poll or joinedId named, as "ip:port", made once per relay.
  key() {
    this.#fresh();
    const address = this.#view.getUint32(0);
    const port = this.#view.getUint16(4);
    const id = address * 65536 + port;
    let key = this.#keys.get(id);
    if (key === undefined) {
      key = `${ipText(address)}:${port}`;
      this.#keys.set(id, key);
    }
    return key;
  }

  // The relay the client is joined at, as one number (address and port), or NONE. key() then
  // names it.
  joinedId() {
    if (this.#wasm.relay() !== 1) return NONE;
    this.#fresh();
    return this.#view.getUint32(0) * 65536 + this.#view.getUint16(4);
  }

  // A control frame's body from `session`: TAKEN, the client took it; ROOM_STATE, HOLDER, SEATED
  // or ACTED, read whole, for the call to read; or 0.
  frame(body, session, now) {
    if (body.length > FRAME_MAX) return 0;
    this.#fresh();
    this.#bytes.set(body);
    return this.#wasm.frame(now, session.address, session.port, body.length);
  }

  // Seat `seat`'s holder holds it under `epoch` (ADR 0028): true if the seat starts afresh, a new
  // holder, whose frames waiting aside play and nothing of the last one's.
  holder(seat, epoch, now) { return this.#wasm.holder(seat, epoch, now) === 1; }

  // The page's own control frames, for its stream, each a copy: a Talk numbered `ask`, and an Act
  // numbered `number`, `action` on `user` (a BigInt), or null for an action no byte names.
  talk(ask) { return this.#copy(this.#wasm.talk(ask)); }
  act(number, action, user) { return this.#copy(this.#wasm.act(number, action, user)); }

  #copy(length) {
    if (length === 0) return null;
    this.#fresh();
    return this.#bytes.slice(0, length);
  }

  // A speaker's datagram's Opus bytes into their jitter buffer, by the seat epoch its header's
  // flags carry in bits 2 and 3: kept, a repeat, LATE, REFUSED, MINE, ASIDE or STALE.
  push(seat, seq, datagram, now) {
    const len = datagram.length - HEADER;
    if (len > OPUS_MAX) return REFUSED;
    this.#fresh();
    const bytes = this.#bytes;
    for (let i = 0; i < len; i++) bytes[i] = datagram[HEADER + i];
    return this.#wasm.jitter_push(seat, seq, (datagram[8] >>> 2) & 3, len, now);
  }

  // A speaker's next frame, at the beat: FRAME_OUT (its bytes in `opus`), LOST, LOST_WITH_NEXT,
  // or waiting; `afresh` says whether the seat started afresh first, under its next holder.
  pop(seat, now) {
    const said = this.#wasm.jitter_pop(seat, now);
    const kind = said & 3;
    this.afresh = (said & AFRESH) !== 0;
    if (kind === FRAME_OUT) {
      this.#fresh();
      const length = (said >>> 2) & POPPED;
      this.opus = this.#lengths[length] ??= new Uint8Array(this.#memory, this.#base, length);
    }
    return kind;
  }

  // The page's own seat, or null: the client never plays it (ADR 0017).
  ownSeat(seat) { this.#wasm.own_seat(seat ?? NO_SEAT); }
}
