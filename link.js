// The link: the page's address, then '#', then the room's invite (ADR 0016): one link for
// everyone in the call. A person's own token still works in its place, as older links have it.
// '&tone' after it sends a 440 Hz tone instead of the microphone, for testing, and '&webaudio'
// leaves out what keeps a call going in Safari's background (background.js, ADR 0019).
// Tested by link.test.js (`node --test web/*.test.js`).

export function hexBytes(hex) {
  const clean = hex.trim().toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g), (pair) => parseInt(pair, 16));
}

// What the fragment after '#' says: the invite or token, alone or as 'invite=' or 'token=', and
// the options; or null when it is neither.
export function readLink(fragment) {
  const params = new URLSearchParams(fragment);
  const given = (params.get('invite') ?? params.get('token') ?? fragment.split('&')[0] ?? '').trim();
  const link = { tone: params.has('tone'), webaudio: params.has('webaudio'), invite: null, token: null, room: null, me: null, expires: null };
  const fields = hexBytes(given);
  if (!fields) return null;
  const view = new DataView(fields.buffer);
  // An invite's fields: format 2, room 8, expiry 8, then the signature (crates/voice-token,
  // invite). Numbers are big-endian; the expiry is in seconds since the Unix epoch.
  if (fields.length === 81 && fields[0] === 2) {
    return { ...link, invite: given, room: view.getBigUint64(1), expires: view.getBigUint64(9) };
  }
  // A token's: format 1, user 8, room 8, speaks 1, seat 1, the grant's version 8, expiry 8, then
  // the signature.
  if (fields.length === 99 && fields[0] === 1) {
    return { ...link, token: given, me: view.getBigUint64(1), room: view.getBigUint64(9), expires: view.getBigUint64(27) };
  }
  return null;
}

// Whether the link has expired at `now`, in milliseconds since the Unix epoch: the relay refuses
// it once its expiry has passed, by the relay's clock.
export function expired(link, now) {
  return link.expires !== null && BigInt(Math.floor(now / 1000)) > link.expires;
}

export const EXPIRED = 'This link has expired. Ask whoever set up the call for a new one.';

// What to say when no relay lets the page in: an expired link, which every relay refuses, or
// else the network.
export function cantGetIn(link, now) {
  if (expired(link, now)) return EXPIRED;
  return 'Can’t reach the voice servers. Your network may block calls: try another network, such as your phone’s hotspot. Still trying…';
}
