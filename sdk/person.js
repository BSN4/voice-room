// This tab's person id, sent with the invite (ADR 0016): random, kept for the tab in
// sessionStorage, so a reload is the same person and gets their seat back, and another tab is
// another. Where the browser keeps nothing, a new one each load.
//
// A duplicated tab copies the first one's sessionStorage, id and all: both would be one person,
// on one seat. So a tab that finds an id kept asks the page's other tabs, over a
// BroadcastChannel, whether one of them holds it, and takes a new one if so. They ask by a hash
// of the id (ids.js, tabHash), never the id itself, which with the invite lets anyone in as this
// person: the page's origin may be shared with other sites. A reload finds no
// one: the page before it is gone. Two tabs that ask at once both take new ones. A tab the
// browser froze in the background cannot answer, and then the two still share the id.
// Tested by person.test.js (`node --test 'web/**/*.test.js'`).

const KEY = 'voice-person';

// storage(): the tab's sessionStorage, which may throw. channel: a BroadcastChannel the page's
// tabs share, kept open for the page's life, or null. random(): a random u64, as a BigInt.
// wait(): resolves once another tab has had time to answer. note(text): a line for the log.
// hash(id): what the tabs compare instead of the id, resolving to a value they can match.
export async function personId({ storage, channel, random, wait, note, hash }) {
  const kept = read(storage);
  let id = kept ?? keep(storage, random());
  if (!channel) return id;
  let mine = String(await hash(id));
  let taken = false;
  channel.onmessage = ({ data }) => {
    if (!data) return;
    if (data.ask === mine) channel.postMessage({ taken: data.ask });
    else if (data.taken === mine) taken = true;
  };
  if (kept === null) return id;
  channel.postMessage({ ask: mine });
  await wait();
  if (taken) {
    note('another tab of this page has this tab’s person id, as a duplicated tab does: a new one');
    id = keep(storage, random());
    mine = String(await hash(id));
  }
  return id;
}

function read(storage) {
  try {
    const kept = storage().getItem(KEY);
    if (kept && /^[0-9]{1,20}$/.test(kept) && BigInt(kept) < 2n ** 64n) return BigInt(kept);
  } catch (_) { /* nothing kept */ }
  return null;
}

function keep(storage, id) {
  try { storage().setItem(KEY, id.toString()); } catch (_) { /* kept for this load only */ }
  return id;
}
