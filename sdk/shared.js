// Small things the SDK's modules share.

// A promise's failure that changes nothing, as a datagram that could not be written.
export const ignore = () => {};

// An error in words, for the log: its message, or its name. A browser's error can quote the URL
// it was given, whose query holds the token or invite and the person id: that is cut out.
export const why = (error) => String((error && (error.message || error.name)) || error).replace(/\?[^\s'"]*/g, '?…');

// An IPv4 address as text, from its number, and back.
export const ipText = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
export const ipNumber = (ip) => ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0) >>> 0;

// A person as the SDK names them: by their user's last four hex digits, the same on every page.
// Seats change hands as people talk (ADR 0028), so a seat names nobody for long.
export const personName = (user) => `Person ${(user & 0xffffn).toString(16).toUpperCase().padStart(4, '0')}`;

// `fields`, as an event or a person the call shows: its BigInts, as a person's `user`, turn into
// JSON as decimal strings, as BigInt() reads them back. The object stays a plain one: its toJSON
// is not one of its fields.
export function jsonable(fields) {
  return Object.defineProperty(fields, 'toJSON', { value: bigintsJSON });
}
function bigintsJSON() {
  const json = {};
  for (const [name, value] of Object.entries(this)) json[name] = typeof value === 'bigint' ? value.toString() : value;
  return json;
}

// The page's voice client, voice.wasm, did not load or start.
export const NO_CLIENT = 'The page’s voice client didn’t load. Check your connection and reload the page.';

// What went wrong, as a reason for code and a message for people.
export class VoiceError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'VoiceError';
    this.reason = reason;
  }
}
