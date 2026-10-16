// The relays' regions (ADR 0036): with relays in more than one, the page measures each region
// once, by a probe session at one of its relays, which the relay takes and closes at once with a
// code of its own, and ranks them by how long that took, a handshake and one request. The
// ranking is kept in the tab for 10 minutes, so a reconnect does not measure again; one in which
// a region gave no answer is used for that call only, so one relay down does not rank its region
// last for 10 minutes. The call starts from the room's relay in the nearest region, and its
// client core chooses there first.
// Tested by regions.test.js (`node --test 'web/**/*.test.js'`).

// How long a region has to answer its probe before it is ranked last, and how long a ranking
// is kept.
export const PROBE_WAIT_MS = 1000;
export const KEPT_FOR_MS = 10 * 60 * 1000;
const KEPT = 'voice-regions';
// A region: up to 8 of a to z and 0 to 9; '' for a relay that names none.
const REGION = /^[a-z0-9]{0,8}$/;

// The region a relay list's entry names, or '' for none; it throws for one that is no region.
export function regionOf(entry) {
  const region = entry?.region ?? '';
  if (typeof region !== 'string' || !REGION.test(region)) throw new Error(`not a region: ${JSON.stringify(entry)}`);
  return region;
}

// The regions of `relays`, nearest first: measured, or as kept from a measure in the last 10
// minutes in which every region answered. With fewer than two, nothing is measured.
export async function rankRegions(env, log, relays) {
  const regions = [...new Set(relays.map((relay) => relay.region))];
  if (regions.length < 2) return regions;
  const kept = keptRanking(env, regions);
  if (kept) return kept;
  const timed = await Promise.all(regions.map((region) => probe(env, relays.find((relay) => relay.region === region))));
  const ranked = regions
    .map((region, at) => ({ region, ms: timed[at], at }))
    .sort((x, y) => (x.ms ?? Infinity) - (y.ms ?? Infinity) || x.at - y.at);
  const said = ranked.map(({ region, ms }) => `${region || '(none)'} (${ms === null ? 'no answer' : `${Math.round(ms)} ms`})`);
  log(`regions, nearest first: ${said.join(', ')}`);
  const ranking = ranked.map(({ region }) => region);
  if (timed.every((ms) => ms !== null)) keep(env, regions, ranking);
  return ranking;
}

// How long `relay` took to take a probe and close it, in ms; null when it did not within
// PROBE_WAIT_MS, or failed. A probe still open then is closed.
function probe(env, relay) {
  const url = `https://${relay.name ?? relay.ip}:${relay.port}/?probe`;
  const started = env.now();
  let transport;
  try {
    transport = relay.name
      ? new env.WebTransport(url)
      : new env.WebTransport(url, { serverCertificateHashes: [{ algorithm: 'sha-256', value: relay.hash }] });
  } catch (_) {
    return Promise.resolve(null);
  }
  return new Promise((done) => {
    const timer = env.setTimeout(() => {
      done(null);
      try { transport.close(); } catch (_) { /* gone already */ }
    }, PROBE_WAIT_MS);
    transport.closed.then(
      () => { env.clearTimeout(timer); done(env.now() - started); },
      () => { env.clearTimeout(timer); done(null); },
    );
  });
}

// The ranking kept in the tab for these `regions`, if one is less than 10 minutes old.
function keptRanking(env, regions) {
  try {
    const kept = JSON.parse(env.sessionStorage().getItem(KEPT) ?? 'null');
    const age = env.date() - kept?.at;
    const same = (list) => Array.isArray(list) && list.length === regions.length && regions.every((region) => list.includes(region));
    if (age >= 0 && age < KEPT_FOR_MS && same(kept.regions) && same(kept.ranking)) return kept.ranking;
  } catch (_) { /* none kept, or none readable: measured */ }
  return null;
}

function keep(env, regions, ranking) {
  try {
    env.sessionStorage().setItem(KEPT, JSON.stringify({ at: env.date(), regions, ranking }));
  } catch (_) { /* measured again next time */ }
}

// `relays` in the order a call starts from them: the nearest region's first, each region's by how
// strongly the room claims each relay (`score`, a BigInt), so a room's pages in one region start
// at one relay. With fewer than two regions ranked, as they were.
export function startOrder(relays, ranking, score) {
  if (ranking.length < 2) return relays;
  const near = (relay) => {
    const at = ranking.indexOf(relay.region);
    return at < 0 ? ranking.length : at;
  };
  const scores = new Map(relays.map((relay) => [relay, score(relay)]));
  return [...relays].sort((x, y) => {
    const by = near(x) - near(y);
    if (by !== 0) return by;
    const [sx, sy] = [scores.get(x), scores.get(y)];
    return sx === sy ? 0 : sx > sy ? -1 : 1;
  });
}
