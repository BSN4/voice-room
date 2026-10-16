// A call: one person's time in a room through the SDK, from join to leave, across every relay and
// session it uses. It carries out what the client core says (client.js), sends what the
// microphone gives and plays everyone else (audio.js), and tells the app what happens as events.
// It touches the browser only through `env` (voice.js), so node runs it on stand-ins.
//
// The wire (ADR 0003): each 20 ms Opus frame is one datagram behind a 9-byte header (frames.js).
// Control frames (ADR 0004) arrive on one-way streams (room.js): room state, holders and answers
// are the call's to tell, the relay list and redirects the client's. A frame plays only under its
// seat's holder, by the seat epoch in its header (ADR 0028): the client core keeps the rule, told
// each holder by the call.

import { CallAudio, trouble } from './audio.js';
import {
  ACTED, ASIDE, Client, FRAME_OUT, HOLDER, JOIN, LATE, LEAVE, LOST, LOST_WITH_NEXT, MINE, NONE, PING, ROOM_STATE, SEATED, STALE,
  TAKEN,
} from './client.js';
import { Decoders } from './decoders.js';
import { HEADER } from './frames.js';
import { UNREACHABLE, connectUrl, warning } from './link.js';
import { CLOSED, ENDINGS, FAILED, Refusals, SUSPENDED, TOKEN_EXPIRED, TOKEN_REFUSED, TOKEN_VERDICTS } from './refusals.js';
import { ACTIONS, Moderation, NOT_IN } from './moderation.js';
import { startOrder } from './regions.js';
import { ControlFrames, People, readActed, readHolder, readRelayList, readRoomState, readSeated } from './room.js';
import { OwnSeat } from './seats.js';
import { Sessions } from './sessions.js';
import { NO_CLIENT, VoiceError, ignore, jsonable, why } from './shared.js';
import { DENIED, RUN_OUT } from './tokens.js';

const TALKING_DB = 45;           // louder than -45 dBFS lights a person up
const GIVE_UP_MS = 6000;         // a relay that has not let us in by then: try the next
// A denoiser that lands mid-call waits this long for quiet, then for this page's own, and this
// long at most.
const FILTER_WAIT_MS = 10_000;
const FILTER_WAIT_MOST_MS = 30_000;
const FALLBACK_MS = 250;         // steps without the audio clock, as while its context is suspended
const WATCH_MS = 100;            // who is talking, this often
const COUNTS_MS = 5000;          // the numbers into the log, this often
const OUT_TOLD_MS = 60_000;      // out of the room, the app hears so this often at most

const SAID = {
  connecting: 'Connecting…',
  in: 'You are in the call. Talk away.',
  reconnecting: 'Reconnecting…',
  left: 'You left the call.',
};
// Whether this device last had the noise filter on (ADR 0022): on unless it was turned off.
export function remembered(env) {
  try { return env.localStorage().getItem('voice-filter') !== 'off'; } catch (_) { return true; }
}

function remember(env, on) {
  try { env.localStorage().setItem('voice-filter', on ? 'on' : 'off'); } catch (_) { /* kept for this call only */ }
}

// Starts `call` (voice.js does, once): not the call's own to start again, or an app could reopen
// a session after leaving.
let startOf;
export function start(call) { return startOf(call); }

export class Call extends EventTarget {
  static {
    startOf = (call) => call.#start();
  }

  #p;                            // what prepare() loaded (voice.js), link and person id among it
  #env;
  #note;
  #tone;
  #speaks;                       // whether the call asks for a microphone at join: a listener's does not
  #hasMic;                       // whether it has one now: a listener's once its mute by force is lifted
  #opening = null;               // the microphone being asked for mid-call, as a promise of its detail
  #audio;
  #client = null;
  #sessions;
  #decoders;
  #room;
  #said = null;                  // the last state told
  #muted = false;
  #own;                          // this page's own seat, asked for as it talks (seats.js)
  #moderation;                   // the acts asked of the room's origin (moderation.js)
  #role;                         // this page's role in the call, as room state last said, or its token's
  #forced;                       // muted by force, as room state last said, or as its token joins
  #locked = false;               // the room is locked, as room state last said
  #level = 127;                  // this page's own last frame's level
  #filterOn;
  #counts = { sent: 0, received: 0, played: 0, lost: 0, late: 0, moves: 0 };
  #levelDb = new Uint8Array(256).fill(127);        // by seat: the last frame's level
  #levelAt = new Float64Array(256).fill(-Infinity); // and when it came
  #speaking = [];                // the seats talking, as last told
  #current = null;               // the relay the client is joined at, by key
  #currentId = NONE;             // and as the client's number for it
  #listed = [];                  // the newest relay list this call heard, for the numbers
  #listedAt = 0n;                // and its epoch
  #everIn = false;               // whether the call has been in, at any relay
  #trouble = null;               // why the call cannot send, { reason, message }, kept across moves
  #refusals;                     // what relays that refused the page said, and their waits
  #shown = null;                 // the room state the app was last told
  #rejectStart = null;           // ends start() with the call's own reason, if it ends as it starts
  #tried = 0;
  #since = 0;
  #t0 = 0;
  #going = false;                // between start and stop
  #decoding = 0;                 // frames this beat gave the decoders, still to come back
  #filterWaits = null;           // since when a denoiser that landed mid-call waits for quiet
  #fallback = null;              // the slow timer for while the audio clock stands still
  #lastWatch = 0;
  #lastCounts = 0;
  #ended = false;
  #expires;                      // when the token held runs out, as last told
  #urging = false;               // out of the room, no refusal saying why: a token is urged
  #tokenSeq = 0;                 // counts the tokens taken in the call: each session carries its count
  #refusedSeq = -1;              // the newest token a relay refused (0x1011), by count, or -1
  #retrying = false;             // a relay refused the token: the next one taken is tried at once
  #outAt = 0;                    // when the call last fell out of the room, or started
  #toldOut = -Infinity;          // when the app last heard the call is out, this spell out of the room
  #onVisibility = () => this.#visibility();

  // `inside`: what prepare() loaded. `audio`: what openAudio() opened, in the click.
  constructor(inside, { tone, filter }, opened) {
    super();
    this.#p = inside;
    this.#env = inside.env;
    this.#note = inside.log;
    this.#tone = tone;
    this.#speaks = inside.speaks;
    this.#hasMic = inside.speaks;
    // A token's listener shows in room state as a speaker muted by force (ADR 0028).
    this.#role = inside.role === 'listener' ? 'speaker' : inside.role;
    this.#forced = !inside.speaks;
    this.#expires = inside.tokens.link.expires;
    inside.tokens.listen((outcome) => this.#renewed(outcome));
    this.#filterOn = filter;
    this.#refusals = new Refusals(() => this.#env.now(), this.#note);
    this.#room = new People(inside.me);
    this.#audio = new CallAudio(this.#env, opened, this.#note, filter, {
      beat: () => this.#beat(),
      // A clock that stops beats no more; one that runs again is trusted once it beats.
      running: (on) => { if (!on) this.#arm(); },
      silent: () => this.#arm(),
      frame: (pcm, voice, db) => this.#captured(pcm, voice, db),
      encoded: (chunk) => this.#send(chunk),
      restarted: () => this.#p.outgoing.restart(),
      problem: (reason, message) => this.#cannotSend(reason, message),
      fail: (reason, message) => this.#stop('failed', reason, message, true),
      filter: () => this.#dispatch('filter', this.filter),
    });
    this.#sessions = new Sessions({
      // A relay reached by name shows a real certificate: nothing is pinned (ADR 0030).
      connect: (url, hash) => (hash
        ? new this.#env.WebTransport(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }] })
        : new this.#env.WebTransport(url)),
      now: () => this.#env.now(),
      note: this.#note,
      ready: (session) => this.#ready(session),
      failed: (session) => this.#failed(session),
      closed: (session, ended) => this.#closed(session, ended),
    });
    this.#own = new OwnSeat({
      talk: (ask) => this.#talk(ask),
      current: () => this.#sendable(),
      send: (datagram) => this.#write(datagram),
      now: () => this.#env.now(),
      // The WebAssembly never plays this page's own seat (ADR 0017).
      mine: (seat) => {
        this.#client.ownSeat(seat);
        this.#note(seat === null ? 'you hold no seat' : `you hold seat ${seat + 1}`);
      },
      told: (seat, waiting) => this.#dispatch('seat', { seat, waiting }),
      forced: () => this.#setForced(true),
      note: this.#note,
    });
    this.#moderation = new Moderation({
      now: () => this.#env.now(),
      act: (number, action, user) => this.#client.act(number, action, user),
      send: (bytes) => {
        const session = this.#sendable();
        if (session) this.#control(session, bytes);
        return session;
      },
      current: () => this.#sendable(),
      note: this.#note,
    });
    // Each person's decoder (decoders.js): one that failed on a bad frame gives way to a new one.
    this.#decoders = new Decoders({
      AudioDecoder: this.#env.AudioDecoder, EncodedAudioChunk: this.#env.EncodedAudioChunk, note: this.#note,
      play: (seat, decoded) => this.#audio.play(seat, decoded),
      lose: (seat) => this.#audio.lost(seat),
      settled: () => this.#settled(),
    });
  }

  // ---- What the app reads ----------------------------------------------------------------

  // { state, reason, message, bad }: connecting, in, reconnecting, left or failed.
  get state() { return this.#said ? { ...this.#said } : null; }

  // Everyone room state names: { user, role, muted, seat, you, name }, in its order, seat holders
  // first. `role` is null in a demo room, `muted` is by force, and `seat` null for none.
  get people() { return this.#room.list(); }

  // Everyone in the room that room state does not name: past its 512, and a demo room's listeners
  // behind edges.
  get others() { return this.#room.room?.others ?? 0; }

  // This page's role in the call: speaker, moderator or admin, or null in a demo room. The SDK
  // decides nothing by it: it only shows or hides an app's buttons (ADR 0025).
  get role() { return this.#role; }

  // Whether a moderator, an admin or the token has muted this page by force: nothing it says is
  // sent, and only they lift it.
  get forcedMute() { return this.#forced; }

  // Whether the room lets in no newcomer below moderator.
  get locked() { return this.#locked; }

  // The seats talking now.
  get talking() { return [...this.#speaking]; }

  get muted() { return this.#muted; }

  // Whether the call has a microphone: a listener's token (format 3's role 0, or format 1 that
  // does not speak) only hears, until a moderator lifts its mute by force (ADR 0028).
  get microphone() { return this.#hasMic; }

  // This page's own seat, or null.
  get seat() { return this.#own.seat; }

  // When the token held expires, in seconds since the Unix epoch: later with each renewal.
  get expires() { return this.#expires; }

  // The microphone's last frame, in dB below full scale (127 is silence), for a meter.
  get level() { return this.#level; }

  // The noise filter: whether it runs here, and whether it is switched on.
  get filter() { return this.#audio.filter; }

  // The numbers, for a details panel.
  get stats() {
    return {
      relay: this.#current, ...this.#counts, listed: [...this.#listed],
      relays: this.#p.relays.map((relay) => relay.key),
    };
  }

  // ---- What the app does -----------------------------------------------------------------

  // Mutes or unmutes: muted, nothing is encoded or sent, but every frame still takes its number.
  // A listener has nothing to mute.
  mute(muted = true) {
    if (!this.#hasMic) return;
    const now = !!muted;
    if (now === this.#muted) return;
    this.#muted = now;
    // Muted, the words held for a seat go, and the app may leave inside the wait's end.
    if (now) {
      this.#own.quiet();
      if (!this.#going) return;
    }
    this.#dispatch('mute', { muted: now });
  }

  // The noise filter's switch (ADR 0022): it takes effect at once, and this device remembers it.
  setFilter(on = true) {
    this.#filterOn = !!on;
    remember(this.#env, this.#filterOn);
    this.#audio.setFilter(this.#filterOn);
    this.#note(`noise filter ${this.#filterOn ? 'on' : 'off'}`);
    this.#dispatch('filter', this.filter);
  }

  leave() { this.#stop('left'); }

  // ---- Moderation (ADR 0028) --------------------------------------------------------------

  // Each asks the room's origin, which alone decides, by the actor's verified role: a promise, done
  // once it is, or rejected with a VoiceError: not-allowed, no-such-person, slow-down, not-in,
  // no-answer, or bad-option for a user that is no 64-bit number (moderation.js). `user` is a
  // BigInt, or a number or string BigInt() reads.
  forceMute(user, muted = true) { return this.#ask(muted ? ACTIONS.mute : ACTIONS.lift, user); }
  kick(user) { return this.#ask(ACTIONS.kick, user); }
  ban(user) { return this.#ask(ACTIONS.ban, user); }
  promote(user) { return this.#ask(ACTIONS.promote, user); }
  demote(user) { return this.#ask(ACTIONS.demote, user); }
  lock(locked = true) { return this.#ask(locked ? ACTIONS.lock : ACTIONS.unlock, 0n); }
  endRoom() { return this.#ask(ACTIONS.end, 0n); }

  #ask(action, user) {
    let id = -1n;
    try { id = BigInt(user); } catch (_) { /* no number: refused below */ }
    if (id < 0n || id >= 1n << 64n) return Promise.reject(new VoiceError('bad-option', 'A user is a 64-bit number: a BigInt, or a number or string that BigInt() reads.'));
    if (this.#ended || this.#said.state !== 'in') return Promise.reject(new VoiceError('not-in', NOT_IN));
    return this.#moderation.ask(action, id);
  }

  // ---- Starting ---------------------------------------------------------------------------

  // Starts audio and the client: resolves to this call, connecting, or rejects with a
  // VoiceError when audio cannot start. For voice.js alone.
  // The client and its sessions start beside the audio: the relay's handshake never waits behind
  // the microphone's prompt. Whatever fails, the whole call unwinds, its sessions closed.
  async #start() {
    const env = this.#env;
    const inside = this.#p;
    // A frame the last call's encoder still held went with it; the numbers go on.
    inside.outgoing.restart();
    this.#set('connecting');
    this.#t0 = env.now();
    this.#outAt = this.#t0;
    this.#tried = 0;
    this.#lastWatch = this.#t0;
    this.#lastCounts = this.#t0;
    this.#going = true;
    const client = this.#startCore();
    const audio = this.#audio.start({
      title: `Room ${inside.room}`, microphone: this.#speaks, tone: this.#tone, denoiser: inside.denoiser,
      mute: () => this.mute(true), unmute: () => this.mute(false),
    }).catch((error) => { throw trouble(error); });
    client.catch(ignore);
    audio.catch(ignore);
    // A call that ends as it starts, as in a full room while the microphone's prompt is up, ends
    // the join at once with its own reason.
    const ended = new Promise((_, reject) => { this.#rejectStart = reject; });
    ended.catch(ignore);
    try {
      await Promise.race([Promise.all([client, audio]), ended]);
    } catch (error) {
      const failure = error instanceof VoiceError ? error : new VoiceError('no-client', NO_CLIENT);
      if (!this.#ended) {
        this.#note(`the call did not start: ${why(error)}`);
        this.#stop('failed', failure.reason, failure.message, true);
      }
      throw failure;
    }
    // Not the microphone's name: people are asked to copy the log and send it.
    this.#note(!this.#speaks ? 'listening only' : this.#tone ? 'sending a 440 Hz test tone' : 'microphone on');
    return this;
  }

  // The client core, from the module prepare compiled, started at the first relay; then the
  // call's timer and its watch on the page being shown.
  async #startCore() {
    const env = this.#env;
    let instance;
    try {
      instance = await env.WebAssembly.instantiate(this.#p.module, {});
    } catch (error) {
      this.#note(`the voice client did not start: ${why(error)}`);
      throw new VoiceError('no-client', NO_CLIENT);
    }
    if (!this.#going) return;
    this.#client = new Client(instance.exports);
    // The relays it starts from, the nearest region's first (ADR 0036).
    this.#p.relays = startOrder(this.#p.relays, this.#p.ranking ?? [], (relay) => this.#client.score(this.#p.relayRoom, relay));
    // The call steps on the audio clock's beat (#beat), which a background tab does not slow. A
    // slow timer steps it until the first beat, as while the microphone's prompt is up, and
    // whenever the beat stops.
    this.#arm();
    if (env.document) env.document.addEventListener('visibilitychange', this.#onVisibility);
    this.#startClient();
  }

  // ---- The microphone ---------------------------------------------------------------------

  // A 20 ms frame the microphone gave. Every frame takes a number, muted or not: listeners see
  // from the numbers how long the page was quiet.
  #captured(pcm, voice, db) {
    this.#level = db;
    const seq = this.#p.outgoing.captured(db, !this.#muted && !this.#forced && this.#audio.encoding, voice);
    if (seq !== null) this.#audio.encode(pcm, seq);
  }

  // A frame goes to the relay the client is joined at. While it moves or probes, that is still the
  // old one until the new relay has let the page in (#ready), so no speech is lost on the way.
  // With no relay it goes nowhere, its number spent. Silence goes nowhere either (frames.js, ADR
  // 0021): with nothing to send, the client keeps the relay hearing from it with its keepalives.
  // Speech goes through the page's seat, which holds it while it asks for one (seats.js); the gate
  // shutting, or nowhere to send, drops what it holds.
  #send(chunk) {
    // Only to a relay that has let the page into the room; with none, nothing is made.
    if (!this.#p.outgoing.encoded(chunk, this.#sendable() ? this.#speech : null)) this.#own.quiet();
  }

  #speech = (datagram) => this.#own.speech(datagram);

  // The session of the relay the client is joined at, once it has let the page into the room and
  // can take datagrams; or null.
  #sendable() {
    const session = this.#current && this.#sessions.get(this.#current);
    return session && session.writer && session.admitted ? session : null;
  }

  // A datagram to that relay, or nowhere with none.
  #write(datagram) {
    const session = this.#sendable();
    if (!session) return;
    this.#counts.sent++;
    session.writer.write(datagram).catch(ignore);
    this.#client.sent(this.#clock());
  }

  // A Talk numbered `ask`, on the session the call is in (ADR 0028): that session, or null with
  // none.
  #talk(ask) {
    const session = this.#sendable();
    if (!session) return null;
    this.#control(session, this.#client.talk(ask));
    return session;
  }

  // The page's own control frames go on one one-way stream per session, opened with its first, in
  // order (ADR 0028).
  #control(session, bytes) {
    session.out ??= session.transport.createUnidirectionalStream().then((stream) => stream.getWriter());
    session.out.then((writer) => writer.write(bytes)).catch((error) => {
      this.#note(`a control frame to ${session.key} could not go: ${why(error)}`);
    });
  }

  // ---- The client and its sessions --------------------------------------------------------

  #clock() { return this.#clockAt(this.#env.now()); }

  // The client's clock at `now`, the page's: milliseconds since the call started.
  #clockAt(now) { return Math.floor(now - this.#t0) >>> 0; }

  // Tells the client what happened at a session, then does what it says.
  #tell(what, session) {
    if (!this.#client || !this.#going) return;
    this.#client.tell(what, session, this.#clock());
    this.#act();
  }

  // Does what the client says, then tells the app where the call stands: whether the call still
  // goes once the app has heard, as an app may leave inside any event (#dispatch).
  #act() {
    const client = this.#client;
    for (let kind = client.poll(); kind !== 0; kind = client.poll()) {
      if (kind === JOIN) {
        const relay = client.relay();
        // A relay that refused the page lately is not asked again before its wait is over: the
        // core hears the join failed, with no handshake. Each try at an edge costs its room's
        // origin an Admit.
        const wait = this.#refusals.blocked(relay.key);
        if (wait > 0) {
          this.#note(`client: join ${relay.key}, which refused the page: not before ${Math.round(wait / 1000)} s are up`);
          client.tell('failed', relay, this.#clock());
          continue;
        }
        // At an IP the starting list named, by that name, as the relay's certificate is a real
        // one for it; elsewhere by address, its hash pinned.
        const name = this.#p.names.get(relay.ip) ?? null;
        this.#note(`client: join ${relay.key}${name ? `, as ${name}` : ''}`);
        this.#sessions.open({ ...relay, name, tokenSeq: this.#tokenSeq }, connectUrl(name ? `${name}:${relay.port}` : relay.key, this.#p.tokens.link, this.#p.person, this.#p.epoch));
      } else if (kind === LEAVE) {
        const key = client.key();
        this.#note(`client: leave ${key}`);
        // A join given up, its relay silent: a reason of its own, which a refusal is not.
        const leaving = this.#sessions.get(key);
        if (leaving && !leaving.admitted) this.#refusals.forget();
        this.#sessions.close(key);
      } else if (kind === PING) {
        this.#ping(client.key());
      }
    }
    // Where the client is joined, as a number: its "ip:port" is made only when it changes.
    const id = client.joinedId();
    if (id === this.#currentId) return this.#going;
    const joined = id === NONE ? null : client.key();
    this.#currentId = id;
    if (this.#current && joined) this.#counts.moves++;
    this.#current = joined;
    // The watch on getting in runs from when the call started, or last fell out of the room.
    if (this.#said.state === 'in' && !this.#inRoom()) {
      this.#since = this.#env.now();
      this.#outAt = this.#since;
      this.#toldOut = -Infinity;
    }
    if (!joined) {
      // Trying to get back in, in words that hold while the cause does: a refusal, or the network.
      const refusal = this.#refusals.trying();
      if (this.#everIn && !this.#set('reconnecting', refusal?.reason ?? null, refusal?.trying ?? SAID.reconnecting, !!refusal)) return false;
      this.#joinWaiting();
      return this.#going;
    }
    // In only once that relay has sent the room's state (#controlFrame); then the app is shown it.
    return this.#inRoom() ? this.#show(this.#sessions.get(joined)) : this.#going;
  }

  // Joined nowhere: a session the client core moved to or probed, open but waiting for its room
  // state, is its join now. The core takes it, or says to leave it. It has one join under way at
  // most, so at most one session waits.
  #joinWaiting() {
    for (const key of this.#sessions.keys()) {
      const session = this.#sessions.get(key);
      if (!session.waiting) continue;
      session.waiting = false;
      this.#tell('joined', session);
    }
  }

  // In at `session`: the call is in, and the app shown the room as that relay last said it.
  // Whether the call still goes.
  #show(session) {
    if (this.#said.state !== 'in' && !this.#arrive()) return false;
    if (!session.state || session.state === this.#shown) return this.#going;
    this.#shown = session.state;
    return this.#roomState(session.state);
  }

  // Whether the relay the client is joined at has let the page into the room: its session has
  // brought the room's state. A full room's never does (ADR 0023).
  #inRoom() {
    return this.#current !== null && !!this.#sessions.get(this.#current)?.admitted;
  }

  // In the room: with what keeps it from sending, if anything does. Whether the call still goes.
  #arrive() {
    this.#tried = 0;
    this.#everIn = true;
    this.#refusals.forget();
    this.#urging = false;
    this.#refusedSeq = -1;
    this.#p.tokens.arrived();
    const trouble = this.#trouble;
    return trouble ? this.#set('in', trouble.reason, trouble.message, true) : this.#set('in');
  }

  // Something that leaves the call unable to send, as its capture worklet stopping: said now, and
  // again whenever the call is in, through moves and reconnects.
  #cannotSend(reason, message) {
    // A worklet's error on its way as the call left is nobody's.
    if (!this.#going) return;
    this.#trouble = { reason, message };
    this.#problem(reason, message);
  }

  // Starts the client at the next relay from the list it was given: the first, then the others
  // in turn while none lets us in. Once in, the relays' own list takes over.
  #startClient() {
    for (const key of this.#sessions.keys()) this.#sessions.close(key);
    const relays = this.#p.relays;
    const relay = relays[this.#tried % relays.length];
    this.#note(`starting from ${relay.key}`);
    const seed = this.#env.crypto.getRandomValues(new BigUint64Array(1))[0];
    this.#client.start(this.#p.relayRoom, relay, seed, this.#clock());
    // A ranking of one region measured nothing, and would keep the client in that region's relays
    // while any is up, though the room's relay by the relays' own list is elsewhere: given only
    // with two regions or more, as the start order is.
    const ranking = this.#p.ranking ?? [];
    this.#client.rank(ranking.length >= 2 ? ranking : []);
    this.#since = this.#env.now();
    // Its first step at once: it joins on a step, and none may come for a while.
    this.#client.tick(this.#clock());
    this.#act();
  }

  // The beat (CONTEXT.md), every 20 ms of audio: each person's next frame, and the call's step.
  // What the last beat still holds goes first: a decoder that took its frame and never answers,
  // with no error either, holds the other seats' news back one beat at most.
  #beat() {
    if (!this.#going) return;
    if (this.#fallback !== null) this.#disarm();
    if (this.#decoding > 0) this.#audio.flush();
    this.#decoders.beat();
    this.#decoding = 0;
    this.#play();
    this.#step();
    // The beat's news to the playout, in one message: what it found lost or let go, and the frames
    // it popped, sent once the last of them is decoded (#settled), a later task. A beat with none
    // to wait for sends now, with anything decoded late from the beat before.
    if (this.#going && this.#decoding === 0) this.#audio.flush();
  }

  // One of this beat's frames came back decoded, into the beat's news, or never will, its decoder
  // failed or closed with its seat: the last of them sends the news, so no frame waits a beat. A
  // frame from a beat before goes with the next message.
  #settled() {
    if (this.#decoding > 0 && --this.#decoding === 0) this.#audio.flush();
  }

  // The slow timer, for while the audio clock does not beat.
  #arm() {
    if (this.#fallback !== null || !this.#going || !this.#client) return;
    this.#fallback = this.#env.setInterval(() => this.#step(), FALLBACK_MS);
  }

  #disarm() {
    this.#env.clearInterval(this.#fallback);
    this.#fallback = null;
  }

  // The client's clock, who is talking, the numbers now and then, and the watch on getting in.
  // Once no relay has let the page in, a link the relays refuse by this device's clock ends the
  // call; else the page goes on trying, reconnecting. An app may leave inside any event the step
  // sends: each that tells the app something says whether the call still goes, and the step stops
  // when it does not.
  #step() {
    if (!this.#client) return;
    const now = this.#env.now();
    this.#client.tick(this.#clock());
    if (!this.#act()) return;
    this.#moderation.step();
    if (now - this.#lastWatch >= WATCH_MS) {
      this.#lastWatch = now;
      if (!this.#watchTalking()) return;
      if (this.#audio.landed && !this.#switchFilter(now)) return;
      this.#renew();
    }
    if (now - this.#lastCounts >= COUNTS_MS) {
      this.#lastCounts = now;
      this.#noteCounts();
    }
    if (this.#inRoom() || now - this.#since < GIVE_UP_MS) return;
    // Out of the room for 6 s: the client starts again at the next relay, whatever kept it out,
    // and the app hears the call is out, once a minute at most.
    // A link the relays refuse by this device's clock ends the call once every relay has had its
    // turn, or while refusals keep it out. A renewed token never does: with no refusal to say why
    // the page is out, the app is asked for a fresh one, backing off (tokens.js); and once this
    // device reads the token held as run out, the page says so, not the network.
    // Joined at a relay that holds the page without room state, the page is out for no refusal
    // remembered, which is forgotten; joined nowhere, as while refusing relays' waits run, it is.
    this.#tried++;
    if (this.#current !== null) this.#refusals.forget();
    const refusal = this.#refusals.trying();
    const tokens = this.#p.tokens;
    if (!tokens.renews && (refusal || this.#tried >= this.#p.relays.length)) {
      const refused = warning(tokens.link, this.#env.date());
      if (refused) {
        this.#stop('failed', refused.reason, refused.message, true);
        return;
      }
    }
    this.#urging = !refusal;
    if (now - this.#toldOut >= OUT_TOLD_MS) {
      this.#toldOut = now;
      if (!this.#dispatch('out-of-room', { outFor: now - this.#outAt })) return;
    }
    let going;
    if (refusal) going = this.#set(this.#said.state, refusal.reason, refusal.trying, true);
    else if (this.#tried < this.#p.relays.length) going = this.#set(this.#said.state, 'trying-another', 'Trying another voice server…');
    else if (tokens.spent) going = this.#set('reconnecting', 'expired', RUN_OUT, true);
    else going = this.#set('reconnecting', 'unreachable', UNREACHABLE, true);
    if (going) this.#startClient();
  }

  // A renewal of the token, when one is due, or out of the room (tokens.js).
  #renew() {
    this.#p.tokens.step(this.#urging);
  }

  // What a renewal came to, told to the app: a token taken, one that failed, or the app saying this
  // person may no longer join, which ends the call. Never once the call has ended: tokens.js stops
  // telling it then.
  #renewed({ link, failed, denied }) {
    if (denied) {
      this.#stop('failed', 'denied', DENIED, true);
    } else if (failed) {
      this.#dispatch('renewal-failed', { ...failed });
    } else {
      this.#expires = link.expires;
      this.#tokenSeq++;
      if (!this.#dispatch('renewed', jsonable({ expires: link.expires }))) return;
      // A relay refused the token before: out of the room, the fresh one is tried at once.
      if (this.#retrying && this.#client) {
        this.#retrying = false;
        if (!this.#inRoom()) this.#startClient();
      }
    }
  }

  #ready(session) {
    try {
      // Today's WebTransport makes a datagram writer with createWritable(), which is all Safari
      // has; Chrome also keeps the older writable.
      const datagrams = session.transport.datagrams;
      session.writer = (datagrams.createWritable ? datagrams.createWritable() : datagrams.writable).getWriter();
      this.#readDatagrams(session);
      this.#readStreams(session);
    } catch (error) {
      this.#note(`could not use the session at ${session.key}: ${why(error)}`);
      return;
    }
    // Joined nowhere, as at a first join or a rejoin, the client core hears of the join now, so its
    // own join timeout runs as designed. A relay it moves to or probes, while joined elsewhere, it
    // hears of only at that session's first room state (#controlFrame): a refusing relay takes the
    // session, then closes it, and a core told at once would already have left the relay it is in.
    // The call is in, and sends, only once a session brings the room's state.
    // It hears the session opened, though, so the room has 2 s more to let the page in (ADR 0012
    // as ADR 0024 amends it).
    if (this.#current === null) {
      this.#tell('joined', session);
    } else {
      session.waiting = true;
      this.#tell('ready', session);
    }
  }

  // A session failed to open: a reason of its own, which a refusal met before it is not.
  #failed(session) {
    this.#refusals.forget();
    this.#tell('failed', session);
  }

  // A session ended. A refusal (ADR 0023: a full room, or too many sessions for the person) ends
  // the call when it comes from the relay the page is in (it brought the room's state), or before
  // the call has been in anywhere. Anywhere else, as a relay the page moves to, probes or rejoins,
  // it is a failed join: the client core skips that relay a while, and the call stays where it
  // is, or, joined nowhere, says why it is still trying. Told the session closed, the core would
  // join that relay again at once, a handshake every round trip (refusals.js).
  #closed(session, ended) {
    // Relays judge a token only at CONNECT, so a verdict comes before room state.
    const verdict = ended ? TOKEN_VERDICTS.get(ended.code) : undefined;
    if (verdict) return this.#tokenRefused(session, ended.code, verdict);
    // Kicked, banned or the room ended (ADR 0028): from any relay, the call is over.
    const ending = ended ? ENDINGS.get(ended.code) : undefined;
    if (ending) {
      this.#note(`${session.key} says ${ending.words}`);
      return this.#stop('failed', ending.reason, ending.ends, true);
    }
    const what = this.#refusals.closed(session.key, ended, {
      admitted: !!session.admitted, current: this.#current, everIn: this.#everIn,
      out: this.#said.state !== 'in',
    });
    if (what === CLOSED) this.#tell('closed', session);
    else if (what === FAILED) this.#tell('failed', session);
    else this.#stop('failed', what.reason, what.ends, true);
  }

  // A relay's verdict on the token `session` carried, before its room state (ADR 0027). A token
  // function's call asks the app for a fresh token at once and tries it as it comes: on 0x1010, and
  // on 0x1011 once, as the key may have been rotated; a token taken after that refused too is
  // final. A final verdict, and any on a plain token, ends the call once it is out of the room;
  // from a move or probe while it is in, it is a failed join. No relay is backed off for any: the
  // token is at fault, not the relay.
  #tokenRefused(session, code, verdict) {
    const tokens = this.#p.tokens;
    this.#note(`${session.key} says ${verdict.words}`);
    const final = code === SUSPENDED || !tokens.renews
      || (code === TOKEN_REFUSED && this.#refusedSeq >= 0 && session.tokenSeq > this.#refusedSeq);
    const out = this.#said.state !== 'in';
    if (final && out) return this.#stop('failed', verdict.reason, verdict.ends, true);
    if (!final) {
      const ask = code === TOKEN_EXPIRED || session.tokenSeq > this.#refusedSeq;
      if (code === TOKEN_REFUSED) this.#refusedSeq = Math.max(this.#refusedSeq, session.tokenSeq);
      if (ask) {
        this.#retrying = true;
        tokens.refused(code === TOKEN_REFUSED);
      }
      if (out) this.#refusals.remember(verdict);
    }
    this.#tell('failed', session);
  }

  // A ping: a datagram shorter than an audio header, which the relay sends straight back.
  #ping(key) {
    const session = this.#sessions.get(key);
    if (session && session.writer) session.writer.write(new Uint8Array([0])).catch(ignore);
  }

  // Reads a session's stream until it ends: `each(value)` for what comes. Only the stream ending,
  // or breaking with its session, stops it; anything `each` throws is noted, and reading goes on,
  // or one bad datagram would silence its relay for good.
  async #read(session, readable, what, each) {
    const reader = readable.getReader();
    for (;;) {
      let next;
      try {
        next = await reader.read();
      } catch (_) {
        return; // the session ended
      }
      if (next.done) return;
      try {
        each(next.value);
      } catch (error) {
        this.#note(`${what} from ${session.key} went wrong: ${why(error)}`);
      }
    }
  }

  #readDatagrams(session) {
    this.#read(session, session.transport.datagrams.readable, 'a datagram', (datagram) => {
      // Anything from the relay shows it is there, a ping's echo included. One clock read for both.
      const now = this.#env.now();
      if (this.#client && this.#going) {
        this.#client.tell('heard', session, this.#clockAt(now));
        this.#act();
      }
      this.#receive(datagram, now);
    });
  }

  // A speaker's frames go through their jitter buffer in the WebAssembly (ADR 0014): put back in
  // order, repeats dropped, and played at a delay that follows the network's jitter. While the
  // client moves, the same frame can come from both relays: the second is a repeat, or too late.
  // The seat epoch in its flags says whose it is (ADR 0028): its seat's holder's plays, the next
  // holder's waits aside for them, and any other, as an old holder's still on its way, is dropped.
  #receive(datagram, now) {
    if (!this.#going || datagram.length < HEADER) return;
    // The header by its bytes (ADR 0003): seat, then the number, big-endian, and the level at 7.
    const seat = datagram[0];
    const seq = (datagram[1] << 8) | datagram[2];
    const pushed = this.#client.push(seat, seq, datagram, this.#clockAt(now));
    // This page's own audio, come back on another of its sessions while it moves, and anyone's
    // who holds the seat no more: never played.
    if (pushed === MINE || pushed === STALE) return;
    if (pushed === LATE) this.#counts.late++;
    this.#counts.received++;
    // Popped from now, so the seat starts afresh once the frame has waited aside long enough.
    this.#decoders.add(seat);
    // Not yet its holder's to light up.
    if (pushed === ASIDE) return;
    this.#levelDb[seat] = datagram[7];
    this.#levelAt[seat] = now;
  }

  // Each beat, each person's next frame: one to decode, or one lost, played silent for
  // now (rebuilding it from the next frame's FEC needs our own Opus decoder), or nothing yet.
  // Before the call starts and after it stops, no seat has a decoder.
  #play() {
    const now = this.#clock();
    const decoders = this.#decoders;
    for (let k = 0; k < decoders.count; k++) {
      const seat = decoders.seatAt(k);
      const kind = this.#client.pop(seat, now);
      // Its next holder's frames waited aside for them long enough, and are theirs now.
      if (this.#client.afresh) this.#afresh(seat);
      if (kind === FRAME_OUT && this.#client.opus.length > 0) {
        this.#counts.played++;
        // A view over the module's memory, copied by the chunk the decoder is given.
        if (decoders.decode(seat, this.#client.opus)) this.#decoding++;
      } else if (kind === FRAME_OUT || kind === LOST || kind === LOST_WITH_NEXT) {
        // A frame with no payload is a frame lost: a decoder is never handed one (decoders.js).
        this.#counts.lost++;
        decoders.lost(seat);
      }
    }
  }

  // The person on `seat` left it, or moved: their decoder closed, their jitter buffer emptied,
  // their playout let go, and frames still on their way dropped. The next person on it starts
  // afresh.
  #letGo(seat) {
    this.#decoders.drop(seat);
    this.#client.clearSeat(seat);
    this.#levelAt[seat] = -Infinity;
    this.#audio.gone(seat);
  }

  // Someone holds `seat` under `epoch`, as room state or a holder says: if they are new to it, the
  // seat starts afresh in the client core, and here.
  #taken(seat, epoch) {
    if (this.#client.holder(seat, epoch, this.#clock())) this.#afresh(seat);
  }

  // A seat's new holder starts afresh: their talking theirs alone, and, on a seat heard from, a new
  // decoder at their first frame and the last holder's audio let go in the playout.
  #afresh(seat) {
    this.#levelAt[seat] = -Infinity;
    if (!this.#decoders.has(seat)) return;
    this.#decoders.renew(seat);
    this.#audio.gone(seat);
  }

  #readStreams(session) {
    this.#read(session, session.transport.incomingUnidirectionalStreams, 'a stream', (stream) => {
      // One stream's control frames, cut whole however its reads split them.
      const frames = new ControlFrames();
      this.#read(session, stream, 'a control frame', (bytes) => {
        this.#tell('heard', session);
        for (const body of frames.push(bytes)) {
          try {
            this.#controlFrame(session, body);
          } catch (error) {
            this.#note(`a control frame from ${session.key} went wrong: ${why(error)}`);
          }
        }
      });
    });
  }

  // Every control frame goes to the client core first, which reads it whole. The relay list (kind
  // 2) and redirects (kind 3) are the client's, and the list's epoch goes with every join; room
  // state and holders are the call's to tell.
  #controlFrame(session, body) {
    if (!this.#going) return;
    const kind = this.#client.frame(body, session, this.#clock());
    if (kind === TAKEN) {
      const list = readRelayList(body);
      if (list && list.epoch >= this.#listedAt) {
        this.#listed = list.relays;
        this.#listedAt = list.epoch;
        if (list.epoch > this.#p.epoch) this.#p.epoch = list.epoch;
      }
      this.#act();
      return;
    }
    if (kind === HOLDER) {
      this.#holder(session, readHolder(body));
      return;
    }
    // The answer to a talk, from whichever session it went on: its number says which.
    if (kind === SEATED) {
      this.#own.answered(readSeated(body));
      return;
    }
    // The answer to an act, likewise.
    if (kind === ACTED) {
      this.#moderation.answered(readActed(body));
      return;
    }
    if (kind !== ROOM_STATE) return;
    const state = readRoomState(body);
    // A session's room state shows the relay has let the page into the room. A relay the client
    // core moves to or probes, it hears of now (#ready).
    session.admitted = true;
    session.state = state;
    // Let in anywhere: relays that refused are asked at once again, should it come to that.
    this.#refusals.admitted();
    if (session.waiting) {
      session.waiting = false;
      this.#tell('joined', session);
    }
    // The room is as the relay the client is joined at says.
    if (session.key === this.#current) this.#show(session);
  }

  // A room state from the relay the client is joined at, whole: the seats let go and taken, who
  // came and left, and this page's own place, each told the app. Whether the call still goes.
  #roomState(state) {
    const { came, left, taken, freed } = this.#room.update(state);
    this.#seats(taken, freed);
    for (const person of came) this.#note(person.you ? 'you are in the room' : `${person.name} came in`);
    for (const person of left) this.#note(person.you ? 'you are out of the room' : `${person.name} left`);
    if (!this.#dispatch('people', { people: this.people, others: state.others, came, left })) return false;
    if (state.locked !== this.#locked) {
      this.#locked = state.locked;
      this.#note(state.locked ? 'the room is locked' : 'the room is unlocked');
      if (!this.#dispatch('room', { locked: state.locked })) return false;
    }
    return this.#mine();
  }

  // A seat's new holder, said before any of their audio (ADR 0028), from the relay the client is
  // joined at once it has let the page in: the room is as that relay says.
  #holder(session, holder) {
    if (session.key !== this.#current || !session.admitted) return;
    const { taken, freed } = this.#room.holder(holder);
    this.#seats(taken, freed);
    if (!this.#dispatch('people', { people: this.people, others: this.others, came: [], left: [] })) return;
    this.#mine();
  }

  // Seats let go, and seats someone holds anew.
  #seats(taken, freed) {
    for (const seat of freed) this.#letGo(seat);
    for (const { seat, epoch } of taken) this.#taken(seat, epoch);
  }

  // This page's own place in the room, as room state or a holder last named it: its seat, its role
  // and its mute by force, each told the app as it changes. Not named, as in a room past room
  // state's 512, it stays as it was. Whether the call still goes.
  #mine() {
    const me = this.#room.mine();
    if (!me) return this.#going;
    this.#own.holds(me.seated ? me.seat : null, me.epoch);
    if (!this.#going) return false;
    if (me.role !== this.#role) {
      this.#role = me.role;
      this.#note(`your role is ${me.role}`);
      if (!this.#dispatch('role', { role: me.role })) return false;
    }
    return this.#setForced(me.muted);
  }

  // Muted by force, or lifted, as room state or the origin's answer says: the app hears, and a mute
  // drops what the seat holds. Whether the call still goes.
  // A lift leaves the page self-muted, so nobody is heard by surprise, and asks for the microphone
  // if it has none: a listener's is asked for now, never at join (ADR 0028).
  #setForced(muted) {
    if (muted === this.#forced) return this.#going;
    this.#forced = muted;
    if (muted) {
      this.#own.quiet();
      if (!this.#going) return false;
    }
    this.#note(muted ? 'you are muted by a moderator' : 'your mute by a moderator is lifted');
    if (!this.#dispatch('forced-mute', { muted })) return false;
    if (muted) return this.#going;
    if (!this.#muted) {
      this.#muted = true;
      if (!this.#dispatch('mute', { muted: true })) return false;
    }
    if (!this.#hasMic) this.#askMicrophone(false);
    return this.#going;
  }

  // The microphone, from a click, where the browser wanted one (`microphone` said needs-click), or
  // to ask again after a refusal: a promise of { available, reason }, as the event says. Capture
  // starts self-muted. One open already is asked for no more.
  openMicrophone() {
    if (this.#hasMic || !this.#going) return Promise.resolve({ available: this.#hasMic, reason: null });
    return this.#askMicrophone(true);
  }

  // Asks for the microphone mid-call, `click` saying whether from one, and tells the app what came
  // of it. Refused outside a click, it says needs-click: the browser may want one. Refused in one,
  // or for any other trouble, it says why, and the call goes on listening.
  #askMicrophone(click) {
    if (this.#opening) return this.#opening;
    this.#note(click ? 'asking for the microphone, from a click' : 'asking for the microphone');
    const opening = this.#audio.openMicrophone({ tone: this.#tone, denoiser: this.#p.denoiser }).then(
      () => {
        this.#hasMic = true;
        this.#note('microphone on, muted');
        return { available: true, reason: null };
      },
      (error) => {
        const reason = !click && error && error.name === 'NotAllowedError' ? 'needs-click' : trouble(error).reason;
        this.#note(`no microphone: ${reason} (${why(error)})`);
        return { available: false, reason };
      },
    ).then((detail) => {
      this.#opening = null;
      if (this.#going) this.#dispatch('microphone', detail);
      return detail;
    });
    this.#opening = opening;
    return opening;
  }

  // ---- What the app is told ---------------------------------------------------------------

  // Every event the app hears goes through here. An app may leave inside any of them, so it says
  // whether the call still goes, and what the call was doing goes on only while it does.
  #dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    return this.#going;
  }

  // The call's state, told when anything about it changes, and noted in the log when its message
  // does. Whether the call still goes.
  #set(state, reason = null, message = SAID[state], bad = false) {
    const was = this.#said;
    if (was && was.state === state && was.reason === reason && was.message === message && was.bad === bad) return this.#going;
    if (!was || was.message !== message) this.#note(message);
    this.#said = { state, reason, message, bad };
    return this.#dispatch('state', { ...this.#said });
  }

  // Something wrong that leaves the call as it is.
  #problem(reason, message) { this.#set(this.#said.state, reason, message, true); }

  // A denoiser that landed mid-call comes in at a quiet moment (#quiet). A room that never falls
  // quiet keeps it waiting FILTER_WAIT_MS at most: then it comes in at this page's own quiet,
  // whoever else talks, and after FILTER_WAIT_MOST_MS at once. Switched on, the app hears `filter`
  // (#dispatch, through the audio's hook): whether the call still goes.
  #switchFilter(now) {
    if (this.#filterWaits === null) this.#filterWaits = now;
    const waited = now - this.#filterWaits;
    const ownQuiet = this.#muted || this.#level >= TALKING_DB;
    if (!this.#quiet(now) && !(waited >= FILTER_WAIT_MS && ownQuiet) && waited < FILTER_WAIT_MOST_MS) return this.#going;
    if (waited >= FILTER_WAIT_MS) this.#note(`the noise filter waited ${Math.round(waited / 1000)} s for a quiet moment`);
    this.#audio.switchOn();
    return this.#going;
  }

  // Whether nobody here speaks now: neither this page, unmuted and loud, nor anyone it hears.
  #quiet(now) {
    if (!this.#muted && this.#level < TALKING_DB) return false;
    const decoders = this.#decoders;
    for (let k = 0; k < decoders.count; k++) {
      const seat = decoders.seatAt(k);
      if (now - this.#levelAt[seat] < 300 && this.#levelDb[seat] < TALKING_DB) return false;
    }
    return true;
  }

  // Who is talking, each WATCH_MS, from each frame's level: neither the relay nor the call decodes
  // for it. The page's own seat goes by its microphone, while unmuted.
  // Nothing is made unless who talks has changed. Whether the call still goes.
  #watchTalking() {
    const seats = this.#room.holders;
    const now = this.#env.now();
    const was = this.#speaking;
    let k = 0;
    let same = true;
    for (let i = 0; i < seats.length; i++) {
      if (!this.#talks(seats[i], now)) continue;
      if (k >= was.length || was[k] !== seats[i].seat) same = false;
      k++;
    }
    if (same && k === was.length) return this.#going;
    const talking = [];
    for (let i = 0; i < seats.length; i++) if (this.#talks(seats[i], now)) talking.push(seats[i].seat);
    this.#speaking = talking;
    return this.#dispatch('talking', { seats: talking.slice() });
  }

  // Whether the person on a seat of room state talks now: by their frames' level, or for this
  // page, its microphone's while unmuted.
  #talks({ seat, user }, now) {
    if (user === this.#p.me) return !this.#muted && !this.#forced && this.#level < TALKING_DB;
    return now - this.#levelAt[seat] < 300 && this.#levelDb[seat] < TALKING_DB;
  }

  // Each COUNTS_MS in a call, the numbers into the log.
  #noteCounts() {
    const s = this.#counts;
    this.#note(`in ${this.#current ?? 'no relay'}: sent ${s.sent}, received ${s.received}, played ${s.played}, lost ${s.lost}, late ${s.late}`);
  }

  // In a call, the page going to the background and coming back goes in the log: what iOS does
  // to a call then is still being learned (ADR 0019). Back in front, audio the browser stopped
  // picks up again.
  #visibility() {
    const hidden = this.#env.document.hidden;
    this.#note(hidden ? 'the page is in the background' : 'the page is in front again');
    if (!hidden) this.#audio.resume();
  }

  // ---- Ending -----------------------------------------------------------------------------

  // Ends the call as `state` says: left, or failed for `reason`.
  #stop(state, reason = null, message = SAID[state], bad = false) {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#rejectStart) this.#rejectStart(new VoiceError(reason ?? state, message));
    this.#disarm();
    this.#going = false;
    if (this.#env.document) this.#env.document.removeEventListener('visibilitychange', this.#onVisibility);
    for (const key of this.#sessions.keys()) this.#sessions.close(key);
    this.#decoders.close();
    this.#audio.stop();
    this.#current = null;
    const left = this.#room.list();
    this.#room.clear();
    this.#shown = null;
    this.#p.tokens.forget(this.#p.once);
    this.#own.clear();
    this.#moderation.end();
    this.#level = 127;
    this.#speaking = [];
    this.#p.live = false;
    // The state first, so what follows reads the call as ended; then an app that draws from events
    // clears: nobody is there, nobody talks, no filter runs.
    this.#set(state, reason, message, bad);
    this.#dispatch('people', { people: [], others: 0, came: [], left });
    this.#dispatch('talking', { seats: [] });
    this.#dispatch('filter', this.filter);
  }
}
