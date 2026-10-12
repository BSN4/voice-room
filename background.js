// Keeping a call going with the page in the background, as far as a browser lets it (ADR 0019).
// iPhone Safari pauses a page in the background: its code, its audio and its connections. Where
// WebKit offers them, three things may keep a call going:
// - the page tells it this is a call (navigator.audioSession), so iOS treats its audio as a
//   call's, both ways;
// - the call plays through an <audio> element, which iOS lets play on in the background, rather
//   than straight to Web Audio's output;
// - the lock screen names the call, and its pause and play mute and unmute.
// Leaving the call undoes the first and the last, so the next call starts as the first did.
// Whether iOS then keeps the microphone and the connection going, a call on an iPhone shows:
// the page notes each change (hidden, shown, audio interrupted, microphone muted).
// Tested by background.test.js (`node --test web/*.test.js`), with stand-ins for the browser.

// Tells WebKit this page is a call: true if it could. Before any audio starts.
export function sayItIsACall(nav, note) {
  if (!nav.audioSession) return false;
  try {
    nav.audioSession.type = 'play-and-record';
    note('told the browser this is a call (audio session: play-and-record)');
    return true;
  } catch (error) {
    note(`could not tell the browser this is a call: ${why(error)}`);
    return false;
  }
}

// Tells WebKit the call is over: its audio session back to what a page has by default.
export function sayTheCallIsOver(nav) {
  if (!nav.audioSession) return;
  try { nav.audioSession.type = 'auto'; } catch (_) { /* left as it is */ }
}

// Where the call plays: an <audio> element fed from Web Audio, or Web Audio's own output where
// the element may not play.
export class Output {
  // Made in the click that starts the call, before anything waits, so the element may play.
  constructor({ context, makeAudio, note }) {
    Object.assign(this, { context, note, source: null, refused: false });
    this.sink = context.createMediaStreamDestination();
    this.element = makeAudio();
    this.element.srcObject = this.sink.stream;
    this.element.play().then(
      () => note('playing the call through an audio element, which iOS lets play in the background'),
      (error) => {
        this.refused = true;
        note(`the audio element may not play (${why(error)}): playing the call through Web Audio`);
        if (this.source) {
          this.source.disconnect();
          this.source.connect(context.destination);
        }
      },
    );
  }

  // Plays `node`, the call's audio: through the element, or Web Audio's output once refused.
  play(node) {
    this.source = node;
    node.connect(this.refused ? this.context.destination : this.sink);
  }

  // The page is shown again: audio picks up where the browser stopped it.
  resume() {
    if (this.context.state !== 'running') {
      this.context.resume().catch((error) => this.note(`could not resume audio: ${why(error)}`));
    }
    if (!this.refused && this.element.paused) {
      this.element.play().catch((error) => this.note(`could not play the call again: ${why(error)}`));
    }
  }

  stop() {
    this.element.pause();
    this.element.srcObject = null;
  }
}

// The lock screen's controls: the call's name, and pause and play to mute and unmute.
export function lockScreen(mediaSession, Metadata, { title, mute, unmute }) {
  if (!mediaSession) return;
  if (Metadata) mediaSession.metadata = new Metadata({ title, artist: 'Voice room' });
  const handle = (action, handler) => {
    // A browser that does not know an action throws: that control is left out.
    try { mediaSession.setActionHandler(action, handler); } catch (_) { /* unknown action */ }
  };
  handle('pause', () => { mute(); mediaSession.playbackState = 'paused'; });
  handle('play', () => { unmute(); mediaSession.playbackState = 'playing'; });
  mediaSession.playbackState = 'playing';
}

// The call is over: the lock screen's controls go, so its pause no longer mutes the next call.
export function leaveLockScreen(mediaSession) {
  if (!mediaSession) return;
  for (const action of ['pause', 'play']) {
    try { mediaSession.setActionHandler(action, null); } catch (_) { /* unknown action */ }
  }
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
}

const why = (error) => (error && (error.message || error.name)) || String(error);
