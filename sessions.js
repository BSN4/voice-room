// The page's sessions, one per relay it is joining or joined at, by "ip:port". The client in
// the WebAssembly decides which to open and which to leave; this keeps track of each, tells
// the page when one is ready, fails or ends, and closes them. Tested by sessions.test.js
// (`node --test web/*.test.js`), with a stand-in for the browser's WebTransport.
//
// A session is never closed while it connects. Safari ignores that close and connects anyway,
// and the relay then holds a session the page has forgotten: in a call, one page left dozens in
// the room until its tab closed. One left while it connects is closed once it is ready.

export class Sessions {
  // connect(url, hash): a WebTransport to `url`, pinning the certificate `hash`.
  // now(): milliseconds. note(text): a line for the log.
  // ready(session), failed(session), closed(session): what happened, for the page to say.
  constructor({ connect, now, note, ready, failed, closed }) {
    Object.assign(this, { connect, now, note, ready, failed, closed });
    this.open_ = new Map();
  }

  has(key) { return this.open_.has(key); }
  get(key) { return this.open_.get(key); }
  keys() { return [...this.open_.keys()]; }

  // Opens a session at `relay` ({ key, hash, … }) by `url`: the join.
  open(relay, url) {
    if (this.open_.has(relay.key)) return;
    this.note(`connecting to ${relay.key}`);
    let transport;
    try {
      transport = this.connect(url, relay.hash);
    } catch (error) {
      this.note(`could not start a connection to ${relay.key}: ${why(error)}`);
      this.failed(relay);
      return;
    }
    const session = { ...relay, transport, writer: null, connected: false, opened: 0, started: this.now() };
    this.open_.set(relay.key, session);
    transport.ready.then(() => {
      session.connected = true;
      session.opened = this.now();
      if (this.open_.get(relay.key) !== session) {
        this.note(`connected to ${relay.key}, which was given up: closing it`);
        shut(session);
        return;
      }
      this.note(`connected to ${relay.key}`);
      this.ready(session);
    }, (error) => {
      this.note(`could not connect to ${relay.key}: ${why(error)}`);
      if (this.open_.get(relay.key) !== session) return;
      this.open_.delete(relay.key);
      this.failed(session);
    });
    transport.closed.then(
      (info) => this.note(`session at ${relay.key} closed${this.lasted(session)}: code ${info.closeCode}${info.reason ? `, ${info.reason}` : ''}`),
      (error) => this.note(session.connected
        ? `session at ${relay.key} broke${this.lasted(session)}: ${why(error)}`
        : `session at ${relay.key} never became ready: ${why(error)}`),
    ).finally(() => {
      if (this.open_.get(relay.key) !== session) return;
      this.open_.delete(relay.key);
      this.closed(session);
    });
  }

  // Leaves the session at `key`, or stops opening it.
  close(key) {
    const session = this.open_.get(key);
    if (!session) return;
    const waited = ((this.now() - session.started) / 1000).toFixed(1);
    this.note(session.connected ? `closing ${key}` : `giving up on ${key}: not ready after ${waited} s`);
    this.open_.delete(key);
    if (session.connected) shut(session);
  }

  lasted(session) {
    return session.connected ? ` after ${((this.now() - session.opened) / 1000).toFixed(1)} s` : '';
  }
}

function shut(session) {
  try { session.transport.close({ closeCode: 0, reason: 'moved' }); } catch (_) { /* already closed */ }
}

export const why = (error) => (error && (error.message || error.name)) || String(error);
