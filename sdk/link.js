// The link: the page's address, then '#', then what lets its holder into the room. That is one
// of:
// - the room's invite (ADR 0016): one link for everyone in a demo call;
// - a person's own token, format 1, as older links have it;
// - a tenant's join token, format 3 (ADR 0023), which names the tenant's room, user and role.
// '&tone' after it sends a 440 Hz tone instead of the microphone, for testing, and '&webaudio'
// leaves out what keeps a call going in Safari's background (background.js, ADR 0019).
// Tested by link.test.js (`node --test 'web/**/*.test.js'`).

export function hexBytes(hex) {
  const clean = hex.trim().toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g), (pair) => parseInt(pair, 16));
}

// A format-3 token's role byte, by number; any other is refused by the relays.
const ROLES = ['listener', 'speaker', 'moderator', 'admin'];

// What the fragment after '#' says: the invite or token, alone or as 'invite=', 'token=' or
// 'join=', and the options; or null when it is none of them.
export function readLink(fragment) {
  if (typeof fragment !== 'string') return null;
  const params = new URLSearchParams(fragment);
  const given = (params.get('invite') ?? params.get('token') ?? params.get('join') ?? fragment.split('&')[0] ?? '').trim();
  const link = {
    test: { tone: params.has('tone'), webaudio: params.has('webaudio') },
    invite: null, token: null, join: null, tenant: null, room: null, me: null, role: null, speaks: true, expires: null,
  };
  const fields = hexBytes(given);
  if (!fields) return null;
  const view = new DataView(fields.buffer);
  // An invite's fields: format 2, room 8, expiry 8, then the signature (crates/voice-token,
  // invite). Numbers are big-endian; the expiry is in seconds since the Unix epoch.
  if (fields.length === 81 && fields[0] === 2) {
    return { ...link, invite: given, room: view.getBigUint64(1), expires: view.getBigUint64(9) };
  }
  // A token's: format 1, user 8, room 8, speaks 1, seat 1, the grant's version 8, expiry 8, then
  // the signature. One that does not speak is a listener's.
  if (fields.length === 99 && fields[0] === 1) {
    return {
      ...link, token: given, me: view.getBigUint64(1), room: view.getBigUint64(9), speaks: fields[17] !== 0,
      expires: view.getBigUint64(27),
    };
  }
  // A tenant's join token (ADR 0023): format 3, key id 8, tenant 8, room 8, user 8, role 1, expiry
  // 8, then the signature. The room and user are the tenant's own numbers, and room state shows
  // the user. The tenant lets the page work out the room the relays hold (ids.js).
  if (fields.length === 106 && fields[0] === 3) {
    const role = ROLES[view.getUint8(33)];
    if (!role) return null;
    return {
      ...link, join: given, tenant: view.getBigUint64(9), room: view.getBigUint64(17), me: view.getBigUint64(25),
      role, speaks: role !== 'listener', expires: view.getBigUint64(34),
    };
  }
  return null;
}

// The URL of the CONNECT that joins the relay at `key` ("ip:port") with `link`, the relay list's
// `epoch` going with it. An invite brings the tab's person id (person.js); tokens name their user.
export function connectUrl(key, link, person, epoch) {
  let who = `token=${link.token}`;
  if (link.invite) who = `invite=${link.invite}&user=${person}`;
  else if (link.join) who = `join=${link.join}`;
  return `https://${key}/?${who}&epoch=${epoch}`;
}

// Whether the link has expired at `now`, in milliseconds since the Unix epoch: the relay refuses
// it once its expiry has passed, by the relay's clock.
function expired(link, now) {
  return link.expires !== null && BigInt(Math.floor(now / 1000)) > link.expires;
}

// The longest a relay lets a format-3 token last from when it checks it: a day (ADR 0023).
const LONGEST = 24n * 3600n;
// How far this device's clock may run from the relays' before the page says so.
const SLACK = 5n * 60n;

// Whether a format-3 token lasts so long past `now` that the relays will refuse it.
function tooLong(link, now) {
  return link.join !== null && link.expires > BigInt(Math.floor(now / 1000)) + LONGEST + SLACK;
}

export const EXPIRED = 'This link has expired. Ask whoever set up the call for a new one.';
export const TOO_LONG = 'This link lasts more than a day, which the voice servers refuse. Ask whoever set up the call for a new one.';

// Why the relays will refuse the link at `now`, by this device's clock, or null: { reason,
// message }. The page still lets its holder try, in case the clock is wrong.
export function warning(link, now) {
  if (expired(link, now)) return { reason: 'expired', message: EXPIRED };
  if (tooLong(link, now)) return { reason: 'too-long', message: TOO_LONG };
  return null;
}

// What to say when no relay lets the page in for the network's sake.
export const UNREACHABLE = 'Can’t reach the voice servers. Your network may block calls: try another network, such as your phone’s hotspot. Still trying…';

