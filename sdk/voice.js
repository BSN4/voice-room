// The web SDK (ADR 0024): voice calls through our relays, headless, in one module. No DOM and no
// UI: an app draws what the call tells it.
//
//   import { prepare } from './sdk/voice.js';
//   const ready = await prepare({ link: location.hash.slice(1), log });
//   // later, in a click:
//   const call = await ready.join();
//   call.addEventListener('state', (e) => show(e.detail.message));
//   call.addEventListener('people', (e) => draw(e.detail.people));
//   call.mute(true); call.setFilter(false); call.leave();
//
// Or both at once: `const call = await join({ token, relays })`.
//
// prepare(options) loads what a call needs, so joining is quick:
// - one of `link` (what follows '#' in a call's link: an invite or a token, and '&tone' or
//   '&webaudio'), `token` (format 1, or a tenant's format 3, ADR 0023) or `invite`. `token` may
//   be a function, `() => Promise<string>`, that asks the app's backend for a fresh format-3
//   token: the call then renews its token in the background (tokens.js);
// - `relays` ([{ at: 'ip:port', name: 'dns.name' }] or [{ at: 'ip:port', hash: 'hex' }]) or
//   `relaysUrl`, for a lab's own list. Without either, the SDK fetches ours,
//   https://ax.fr.sa/relays.json, and after 3 s or a failure uses the list built into it
//   (relays-builtin.js). A relay with a name is reached by it, nothing pinned; one without, by
//   its address with its certificate's hash pinned;
// - `log(line)`: every line of the call's log, from the first step on; a function or left out;
// - `env`: the browser's objects, for tests (stand-ins.js); the page's own globals by default.
// It rejects with a VoiceError: 'bad-option', 'unsupported', 'no-link', 'no-token' (a token
// function that failed, did not answer within 10 s, or gave no format-3 token), 'denied' (it
// answered null), 'no-client' or 'no-relays'. It resolves to what it read: `room`, `role`,
// `speaks`, `me` (who room state shows as you), `expires` (seconds since the Unix epoch),
// `warning` (null, or why the relays will refuse the link by this device's clock; null for a
// token function's), `test` (the link's '&tone' and '&webaudio'), `relays`, and `join(options)`.
// The link itself and the tab's person id stay inside.
//
// 64-bit numbers are BigInts: `room`, `me` and `expires` here, and each person's `user` in the
// call's people. JSON.stringify(ready) writes them as decimal strings, which BigInt() reads back.
//
// join(options) starts a call: `filter` (the noise filter, ADR 0022; default: this device's last
// choice) and `test`: `{ tone, webaudio }`, `tone` sending a 440 Hz tone instead of the
// microphone and `webaudio` leaving out Safari's call mode (ADR 0019), each defaulting to the
// link's. Call it in the click that starts the call: WebKit must be told before anything waits.
// It rejects with a VoiceError when audio cannot start ('microphone-blocked', 'no-microphone',
// 'microphone-busy', 'microphone-rate', 'audio'), the client cannot ('no-client'), or a token
// function asked first, with no token held or less than a minute of it left, gives none, or one
// naming another tenant, room or user than its first ('no-token', 'denied'), or with
// 'already-joined' while a call from the same prepare starts or goes on, and resolves to the
// call, connecting (call.js), or already in: the relay is joined while the microphone is asked
// for, so read call.state and call.people once you have the call, then listen.
//
// Also: readLink(fragment), what a link says without loading anything, and supported(), what
// this browser lacks for a call.

import { WORKLETS, closeAudio, openAudio } from './audio.js';
import { Call, remembered, start } from './call.js';
import { Outgoing } from './frames.js';
import { personHash, tabHash, tenantRoom } from './ids.js';
import { hexBytes, readLink, warning } from './link.js';
import { personId } from './person.js';
import { rankRegions, regionOf } from './regions.js';
import { NO_CLIENT, VoiceError, ignore, ipNumber, why } from './shared.js';
import { BUILT_IN } from './relays-builtin.js';
import { Tokens } from './tokens.js';

export { VoiceError, readLink };

const UNSUPPORTED = 'This browser can’t make the call. Open the link in Chrome or Edge on a computer.';
const NO_LINK = 'This page needs the room’s link. Ask whoever set up the call for it.';
const NOT_SET_UP = 'The call isn’t set up right now: no voice servers are listed. Ask whoever set it up.';
const ALREADY_JOINED = 'You are already in this call.';

// The page's own browser, looked up as each is used.
const page = (() => {
  const g = globalThis;
  return {
    get WebTransport() { return g.WebTransport; },
    get AudioContext() { return g.AudioContext; },
    get AudioWorkletNode() { return g.AudioWorkletNode; },
    get AudioEncoder() { return g.AudioEncoder; },
    get AudioDecoder() { return g.AudioDecoder; },
    get AudioData() { return g.AudioData; },
    get EncodedAudioChunk() { return g.EncodedAudioChunk; },
    get MediaMetadata() { return g.MediaMetadata; },
    get Audio() { return g.Audio; },
    get BroadcastChannel() { return g.BroadcastChannel; },
    get WebAssembly() { return g.WebAssembly; },
    get crypto() { return g.crypto; },
    get navigator() { return g.navigator; },
    get document() { return g.document; },
    sessionStorage: () => g.sessionStorage,
    localStorage: () => g.localStorage,
    fetch: (...args) => g.fetch(...args),
    now: () => g.performance.now(),
    date: () => Date.now(),
    setInterval: (fn, ms) => g.setInterval(fn, ms),
    clearInterval: (id) => g.clearInterval(id),
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (id) => g.clearTimeout(id),
  };
})();

// What this browser lacks for a call with the link in `options`, by name: none, or the call cannot
// be made. A listener needs no encoder; with no link, a speaker's call is assumed.
export function supported(given) {
  const options = given ?? {};
  const env = options.env ?? page;
  const link = linkOf(options);
  const needs = ['WebTransport', 'AudioEncoder', 'AudioDecoder', 'AudioWorkletNode'];
  const missing = needs.filter((name) => !env[name] && (name !== 'AudioEncoder' || !link || link.speaks));
  if (!(env.crypto && env.crypto.subtle)) missing.push('crypto.subtle');
  return missing;
}

// The app's log, or none: anything else is a VoiceError. A log that throws is the app's
// trouble, and never stops the call.
function logOf(options) {
  if (!('log' in options) || options.log === undefined) return () => {};
  if (typeof options.log !== 'function') throw new VoiceError('bad-option', 'log must be a function, or left out.');
  const log = options.log;
  return (line) => {
    try { log(line); } catch (_) { /* the app's log broke: the call goes on */ }
  };
}

// The link given, read; none for a token function (asking).
function linkOf({ link, token, invite }) {
  const given = link ?? token ?? invite;
  return given && typeof given !== 'function' ? readLink(String(given)) : null;
}

// The app's function for fresh tokens, when `token` is one and no `link` is given.
const asking = ({ link, token }) => (link === undefined || link === null) && typeof token === 'function';

// This tab's person id (person.js), asked for once per page: a second ask would find the first's
// channel holding it, as if another tab did.
const persons = new WeakMap();
function personFor(env, log) {
  if (!persons.has(env)) {
    persons.set(env, personId({
      storage: env.sessionStorage,
      channel: env.BroadcastChannel ? new env.BroadcastChannel('voice-person') : null,
      random: () => env.crypto.getRandomValues(new BigUint64Array(1))[0],
      // Another tab answers within milliseconds; this holds up only a reload with an invite.
      wait: () => new Promise((done) => env.setTimeout(done, 50)),
      note: log,
      hash: (id) => tabHash(id, env.crypto.subtle),
    }));
  }
  return persons.get(env);
}

// A relay as the list names it: an IPv4 address and port, and either a name, reached with a real
// certificate and nothing pinned, or its certificate's SHA-256 in hex, pinned (ADR 0030). A named
// relay's hash is never read: the client core's relay record holds zeros there.
const ADDRESS = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;
const NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function relayOf(entry) {
  const found = ADDRESS.exec(typeof entry?.at === 'string' ? entry.at : '');
  const name = entry?.name === undefined || entry?.name === null ? null : entry.name;
  if (name !== null && (typeof name !== 'string' || !NAME.test(name))) throw new Error(`not a relay's name: ${JSON.stringify(entry)}`);
  const hash = name ? new Uint8Array(32) : typeof entry?.hash === 'string' ? hexBytes(entry.hash) : null;
  if (!found || !hash || hash.length !== 32) throw new Error(`not an IPv4 relay with its name or hash: ${JSON.stringify(entry)}`);
  const parts = found.slice(1, 5).map(Number);
  const port = Number(found[5]);
  if (parts.some((part) => part > 255) || port < 1 || port > 65535) throw new Error(`no such address: ${entry.at}`);
  const ip = parts.join('.');
  return { ip, port, key: `${ip}:${port}`, address: ipNumber(ip), hash, name: name && name.toLowerCase(), region: regionOf(entry) };
}

// Our relay list, which the SDK starts from unless told otherwise, and how long it waits for it
// before it takes the list built in (relays-builtin.js).
export const RELAYS_URL = 'https://ax.fr.sa/relays.json';
const RELAYS_WAIT_MS = 3000;

// The list at `url`, fresh each time.
async function fetchRelays(env, url) {
  const response = await env.fetch(`${url}${url.includes('?') ? '&' : '?'}at=${env.date()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`no ${url}: HTTP ${response.status}`);
  return (await response.json()).relays;
}

// `listed`, read: a list of at least one relay, each as relayOf reads it, or it throws.
function readRelays(listed) {
  if (!Array.isArray(listed) || !listed.length) throw new Error('no relay is listed');
  return listed.map(relayOf);
}

// The relays to start from: as given; from relaysUrl, which must answer; or ours, waited for
// 3 s, then the list built in. A late answer is dropped.
async function loadRelays(env, log, { relays, relaysUrl }) {
  if (relays) return readRelays(relays);
  if (relaysUrl !== undefined) {
    if (typeof relaysUrl !== 'string') throw new Error('relaysUrl must be a URL');
    return readRelays(await fetchRelays(env, relaysUrl));
  }
  let timer;
  const waited = new Promise((_, fail) => {
    timer = env.setTimeout(() => fail(new Error(`not answered within ${RELAYS_WAIT_MS / 1000} s`)), RELAYS_WAIT_MS);
  });
  try {
    return await Promise.race([fetchRelays(env, RELAYS_URL).then(readRelays), waited]);
  } catch (error) {
    log(`our relay list (${RELAYS_URL}): ${why(error)}; using the list built in`);
    return readRelays(BUILT_IN);
  } finally {
    env.clearTimeout(timer);
  }
}

// Each named relay's IP, to its name: a relay the relays' own list or a redirect names at one of
// these IPs is reached by name too, and any other by its pinned hash.
function namesOf(relays) {
  return new Map(relays.filter((relay) => relay.name).map((relay) => [relay.ip, relay.name]));
}

// The denoiser's module as bytes, checked here and compiled in the capture worklet (ADR 0022);
// null without it, or in a browser without WebAssembly SIMD, and the call goes on as before.
async function loadDenoiser(env, log) {
  try {
    const response = await env.fetch(new URL('./denoise.wasm', import.meta.url).href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (!env.WebAssembly.validate(bytes)) throw new Error('this browser cannot run it');
    return bytes;
  } catch (error) {
    log(`no noise filter: ${why(error)}`);
    return null;
  }
}

// What prepare() resolves to: what it read, shown, and what it loaded, the link and person id
// among it, in a private field out of an app's reach. Only join() below reads that field.
let insideOf;

class Prepared {
  #inside;

  static {
    insideOf = (prepared) => prepared.#inside;
  }

  constructor(shown, inside) {
    Object.assign(this, shown);
    this.#inside = inside;
    // Starts a call: see the top of this file. Bound, so it can be taken off on its own.
    this.join = (options) => startCall(inside, options ?? {}, null);
  }

  // The 64-bit numbers (room, me, expires) as decimal strings, which BigInt() reads back: JSON
  // has no BigInts.
  toJSON() {
    const json = {};
    for (const [name, value] of Object.entries(this)) json[name] = typeof value === 'bigint' ? value.toString() : value;
    return json;
  }
}

export async function prepare(given) {
  const options = given ?? {};
  const env = options.env ?? page;
  const log = logOf(options);
  if (supported(options).length) throw new VoiceError('unsupported', UNSUPPORTED);
  const ask = asking(options) ? options.token : null;
  const read = ask ? null : linkOf(options);
  if (!ask && !read) throw new VoiceError('no-link', NO_LINK);
  log(`${env.navigator.userAgent}`);
  // Everything a call loads starts now, before anything waits: the app's first token, when it
  // gives a function; the client's module, beside this one, compiled once for every call this
  // prepares; the relay list; the denoiser; and the worklets, fetched into the cache for joining
  // to add.
  const tokens = new Tokens(read, ask, env, log);
  const first = tokens.ready();
  const compiling = env.WebAssembly.compileStreaming(env.fetch(new URL('./voice.wasm', import.meta.url).href));
  compiling.catch(ignore);
  const listing = loadRelays(env, log, options);
  listing.catch(ignore);
  // With relays in more than one region, each region is measured as soon as the list is in.
  const ranking = listing.then((relays) => rankRegions(env, log, relays));
  ranking.catch(ignore);
  // The denoiser is not waited for: a call that starts before it lands switches it on then.
  const denoiser = { bytes: null, landing: loadDenoiser(env, log) };
  denoiser.landing.then((bytes) => { denoiser.bytes = bytes; });
  for (const url of Object.values(WORKLETS)) env.fetch(url).then((response) => response.arrayBuffer()).catch(ignore);
  await first;
  const link = tokens.link;
  // With an invite, the page keeps a random person id for this tab (person.js), so a reload is
  // the same person and gets their seat back, and sends it with the invite. The relay knows the
  // person by a hash of it, which room state shows: the page works out the same hash to find
  // itself there. A token names its user.
  let person = null;
  let me = link.me;
  if (link.invite) {
    person = await personFor(env, log);
    me = await personHash(person, env.crypto.subtle);
    log(`room ${link.room}, by its invite: you are ${me.toString(16).padStart(16, '0')} in its room state`);
  } else if (link.join) {
    log(`room ${link.room}, by a join token, as ${link.role}: you are user ${me}`);
  } else {
    log(`room ${link.room}, by a token: you are user ${me}`);
  }
  // The room the relays hold: a tenant's room hashed with the token's tenant (ADR 0023).
  const relayRoom = link.join ? await tenantRoom(link.tenant, link.room, env.crypto.subtle) : link.room;
  let module;
  let relays;
  try {
    module = await compiling;
  } catch (error) {
    log(`the voice client did not load: ${why(error)}`);
    throw new VoiceError('no-client', NO_CLIENT);
  }
  try {
    relays = await listing;
  } catch (error) {
    log(`no relay list: ${why(error)}`);
    throw new VoiceError('no-relays', NOT_SET_UP);
  }
  log(`voice servers: ${relays.map((relay) => relay.key).join(', ')}`);
  const ranked = await ranking.catch(() => []);
  return new Prepared({
    room: link.room, role: link.role, speaks: link.speaks, me, expires: link.expires,
    // A function's token is the app's to keep fresh: this device's clock judges none of them.
    warning: ask ? null : warning(link, env.date()),
    test: { ...link.test }, relays: relays.map((relay) => relay.key),
  }, {
    env, log, person, me, role: link.role, speaks: link.speaks, room: link.room, relayRoom, relays, module, denoiser,
    ranking: ranked,             // the regions, nearest first (ADR 0036)
    names: namesOf(relays),
    test: link.test,
    // The token held, renewed in the background when the app gave a function for it.
    tokens,
    once: false,                 // whether this is the one-step join's, which no join follows
    // The frames this page sends, numbered as captured, sent or not (frames.js). The numbers go
    // on counting across a leave: a listener's jitter buffer would take a speaker who starts
    // again from 0 for frames long played, until it saw them start over.
    outgoing: new Outgoing(),
    epoch: 0n,                   // the relay list's, which goes with every join
    live: false,                 // whether a call from this is starting or going on
  });
}

async function startCall(inside, options, audio) {
  // One call at a time from one prepare: two would share its frame numbers and epoch.
  if (inside.live) throw new VoiceError('already-joined', ALREADY_JOINED);
  inside.live = true;
  const webaudio = options.test?.webaudio ?? inside.test.webaudio;
  let opened;
  try {
    opened = audio ?? openAudio(inside.env, { webaudio, note: inside.log });
  } catch (error) {
    inside.live = false;
    throw error;
  }
  // A renewed token forgotten as the last call ended, or with less than a minute left, is asked
  // for before the first CONNECT (tokens.js), with WebKit already told in the click; one merely
  // due is renewed by the call's watch.
  try {
    await inside.tokens.ready();
  } catch (error) {
    // A join that ends here ends its ask's claim too, as a call's end would: an answer still to
    // come for it is dropped.
    inside.tokens.forget(inside.once);
    inside.live = false;
    closeAudio(inside.env, opened);
    throw error;
  }
  const call = new Call(inside, {
    tone: options.test?.tone ?? inside.test.tone,
    filter: options.filter ?? remembered(inside.env),
  }, opened);
  return start(call);
}

// The call join() alone makes on each page, as its prepared state: one at a time, as prepare's.
const shortcuts = new WeakMap();

// Prepares and joins at once. WebKit is told it is a call first, before anything waits, so call
// it in the click that starts the call. A second while one starts or goes on is refused, before it
// touches any audio.
export async function join(given) {
  const options = given ?? {};
  const env = options.env ?? page;
  const log = logOf(options);
  if (shortcuts.get(env)?.live) throw new VoiceError('already-joined', ALREADY_JOINED);
  const holding = { live: true };
  shortcuts.set(env, holding);
  let audio = null;
  let prepared;
  try {
    const link = supported(options).length ? null : linkOf(options);
    // With a token function, the link comes once the app's backend answers: a speaker's call, its
    // audio opened now.
    const fresh = !link && !supported(options).length && asking(options);
    audio = link || fresh ? openAudio(env, { webaudio: options.test?.webaudio ?? link?.test.webaudio ?? false, note: log }) : null;
    prepared = await prepare(options);
  } catch (error) {
    holding.live = false;
    if (audio) closeAudio(env, audio);
    throw error;
  }
  // From here the call's own state says whether it goes on. Once it has ended, nothing here keeps
  // what it joined with: no token outlives its call.
  const inside = insideOf(prepared);
  inside.once = true;
  shortcuts.set(env, inside);
  const ended = () => { if (shortcuts.get(env) === inside) shortcuts.set(env, { live: false }); };
  let call;
  try {
    call = await startCall(inside, options, audio);
  } catch (error) {
    ended();
    throw error;
  }
  call.addEventListener('state', ({ detail }) => { if (detail.state === 'left' || detail.state === 'failed') ended(); });
  return call;
}
