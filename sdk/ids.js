// Numbers the page works out with SHA-256, as crates/voice-token does: who room state says a
// person with an invite is, and which room a relay holds for a tenant's room; and what a tab says
// of its person id to the page's other tabs, which is the page's own. Each is the first 8
// bytes of SHA-256 over a context and 8-byte big-endian numbers, read big-endian. `subtle` is the
// browser's crypto.subtle. Tested by ids.test.js (`node --test 'web/**/*.test.js'`).

async function hash(subtle, context, numbers) {
  const text = new TextEncoder().encode(context);
  const bytes = new Uint8Array(text.length + numbers.length * 8);
  bytes.set(text);
  const view = new DataView(bytes.buffer);
  numbers.forEach((number, i) => view.setBigUint64(text.length + i * 8, number));
  return new DataView(await subtle.digest('SHA-256', bytes)).getBigUint64(0);
}

// Who room state says the holder of person id `id` is (ADR 0016; voice-token's `person`).
export function personHash(id, subtle) {
  return hash(subtle, 'voice person v1', [id]);
}

// What a tab says of its person id to the page's other tabs (person.js), so the id itself never
// crosses their channel: the page's origin may be shared, as every GitHub Pages site of one
// account shares one. Not the hash room state shows either, which names the person in the room.
export function tabHash(id, subtle) {
  return hash(subtle, 'voice tab v1', [id]);
}

// The room a relay holds for `tenant`'s own room `room` (ADR 0023). The client ranks relays by it
// to find the room's origin, and a redirect names it.
export function tenantRoom(tenant, room, subtle) {
  return hash(subtle, 'voice room v1', [tenant, room]);
}
