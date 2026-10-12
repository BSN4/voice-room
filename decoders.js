// Each person's audio decoder, by seat: WebCodecs' AudioDecoder, made when their first frame
// comes. A payload it cannot decode closes a decoder for good, and the relay never looks inside
// one: so a decoder that errored or was closed is replaced at the seat's next frame, or one bad
// frame would silence the seat, and whoever is given it next, until this page joined again.
// Tested by decoders.test.js (`node --test web/*.test.js`), with a stand-in decoder.

export class Decoders {
  // AudioDecoder, EncodedAudioChunk: the browser's. play(seat, audio): a decoded AudioData.
  // note(text): a line for the log.
  constructor({ AudioDecoder, EncodedAudioChunk, play, note }) {
    Object.assign(this, { AudioDecoder, EncodedAudioChunk, play, note });
    this.speakers = new Map();   // seat -> { decoder, count }, or null until its next frame
  }

  seats() { return this.speakers.keys(); }

  // A seat heard from: it gets a decoder.
  add(seat) {
    if (!this.speakers.has(seat)) this.speakers.set(seat, this.make(seat));
  }

  // Seat `seat`'s next frame, Opus bytes. A decoder that failed or was closed gives way to a
  // new one first.
  decode(seat, opus) {
    if (!this.speakers.has(seat)) return;
    let speaker = this.speakers.get(seat);
    if (!speaker || speaker.decoder.state !== 'configured') {
      if (speaker && speaker.decoder.state !== 'closed') speaker.decoder.close();
      speaker = this.make(seat);
      this.speakers.set(seat, speaker);
      if (!speaker) return;
    }
    try {
      speaker.decoder.decode(new this.EncodedAudioChunk({
        type: 'key', timestamp: (speaker.count++) * 20000, data: opus,
      }));
    } catch (error) {
      this.note(`seat ${seat + 1}: the audio decoder refused a frame (${why(error)}): a new one takes the next`);
      if (speaker.decoder.state !== 'closed') speaker.decoder.close();
      this.speakers.set(seat, null);
    }
  }

  // The page left: every decoder goes.
  close() {
    for (const speaker of this.speakers.values()) {
      if (speaker && speaker.decoder.state !== 'closed') speaker.decoder.close();
    }
    this.speakers.clear();
  }

  // A decoder for `seat`, or null if the browser would not make one: the next frame tries again.
  make(seat) {
    try {
      const decoder = new this.AudioDecoder({
        output: (audio) => this.play(seat, audio),
        error: (error) => this.note(`seat ${seat + 1}: the audio decoder failed (${why(error)}): a new one takes the next frame`),
      });
      decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      return { decoder, count: 0 };
    } catch (error) {
      this.note(`seat ${seat + 1}: could not make an audio decoder: ${why(error)}`);
      return null;
    }
  }
}

const why = (error) => (error && (error.message || error.name)) || String(error);
