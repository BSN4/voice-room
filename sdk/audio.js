// A call's audio: the audio context, the playout worklet that plays everyone else and keeps the
// call's beat, and the microphone: the capture worklet with its noise filter (ADR 0022), and the
// Opus encoder. Where WebKit lets it, the call plays through an audio element and the lock screen
// (background.js, ADR 0019). The call (call.js) decides what is sent and what is played.

import { Output, leaveLockScreen, lockScreen, sayItIsACall, sayTheCallIsOver } from './background.js';
import { FRAME } from './frames.js';
import { VoiceError, ignore, why } from './shared.js';

const RATE = 48000;
const BACK = 4;                  // capture buffers given back at a time
const MODULES_MS = 10_000;       // the worklets' modules load within this, or the call fails
const LOST = -1, GONE = -2;      // the playout worklet's words for a frame lost and a seat let go
const OPUS_MOST = 5760;          // Opus's longest frame, 120 ms
// A beat's news, before it goes early: 16 frames, and Opus's longest.
const NEWS = 16 * (FRAME + 2);
const PLANE = { planeIndex: 0 };

// The worklets' modules, beside this one.
export const WORKLETS = {
  capture: new URL('./capture-worklet.js', import.meta.url).href,
  playout: new URL('./playout-worklet.js', import.meta.url).href,
};

// In the click that starts a call, before anything waits, so it is still the click's: where
// WebKit lets it, the page is a call, played through an audio element that iOS keeps playing in
// the background (ADR 0019).
export function openAudio(env, { webaudio, note }) {
  const call = !webaudio && sayItIsACall(env.navigator, note);
  let context;
  try {
    context = new env.AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
  } catch (error) {
    // No audio, so no call: WebKit hears so at once.
    if (call) sayTheCallIsOver(env.navigator);
    note(`audio did not start: ${why(error)}`);
    throw trouble(error);
  }
  context.onstatechange = () => note(`audio: ${context.state}`);
  // Resumed now, while it is the click's. Never waited on: iOS can leave the promise unsettled.
  context.resume().catch(ignore);
  const output = call ? new Output({ context, makeAudio: () => new env.Audio(), note }) : null;
  return { call, locked: false, context, output };
}

// The audio opened for a call let go. The call is over for WebKit too: the lock screen's pause
// would otherwise mute the next one. Each is undone only if this call did it.
export function closeAudio(env, { call, locked, context, output }) {
  if (output) output.stop();
  context.close().catch(ignore);
  if (locked) leaveLockScreen(env.navigator.mediaSession);
  if (call) sayTheCallIsOver(env.navigator);
}

// Why the microphone, or audio at all, did not start.
export function trouble(error) {
  if (error instanceof VoiceError) return error;
  const name = error && error.name;
  if (name === 'NotAllowedError') return new VoiceError('microphone-blocked', 'Your browser blocked the microphone. Click the icon left of the address, allow the microphone, then press Join again.');
  if (name === 'NotFoundError') return new VoiceError('no-microphone', 'No microphone found. Connect one, then press Join again.');
  if (name === 'NotReadableError') return new VoiceError('microphone-busy', 'Another app is using the microphone. Close it, then press Join again.');
  return new VoiceError('audio', `Could not start audio: ${(error && error.message) || error}`);
}

// The microphone, into the call's 48 kHz context. Browsers resample a microphone at another rate
// (Gecko 152 does, measured); a Firefox from before that throws NotSupportedError instead.
const RATE_REFUSED = 'Your browser can’t take your microphone at its sample rate. Update the browser, or open the link in Chrome or Edge.';
function sourceOf(context, stream) {
  try {
    return context.createMediaStreamSource(stream);
  } catch (error) {
    if (error && error.name === 'NotSupportedError') throw new VoiceError('microphone-rate', RATE_REFUSED);
    throw error;
  }
}

// The microphone as the page asks for it: echo cancellation and gain control on, one channel, and
// the browser's own noise suppression on only while ours does not run, so the two never work on
// the same sound.
const constraintsFor = (ours) => ({ echoCancellation: true, noiseSuppression: !ours, autoGainControl: true, channelCount: 1 });

// dB below full scale of a frame, 0 to 127 (RFC 6464): 0 is the loudest.
function levelOf(pcm) {
  let sum = 0;
  for (let i = 0; i < FRAME; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / FRAME);
  if (rms <= 0) return 127;
  return Math.max(0, Math.min(127, Math.round(-20 * Math.log10(rms))));
}

export class CallAudio {
  #env;
  #note;
  #opened;
  #hooks;
  #playout = null;
  #capture = null;
  #stream = null;
  #encoder = null;
  #filterOn;
  #filterReady = false;
  // Whether the browser's own noise suppression is on, as the track last said, or as asked where
  // it says nothing. Ours applies only while it is off: two suppressors in a row leave a voice
  // metallic, robotic.
  #ownOn = true;
  #stopped = false;
  #landed = null;                // a denoiser's module that landed mid-call, not yet switched on
  #switching = null;             // when it was, until the worklet says it is ready
  #back = new Array(BACK).fill(null); // frames' buffers to give back to the capture worklet
  #backMoving = new Array(BACK).fill(null); // and their transfer list, both made once
  #backs = 0;                    // how many wait
  #moving = [null];              // the beat's news's transfer list, made once
  #news = new Float32Array(NEWS); // the beat's news so far, for the playout worklet (flush)
  #told = 0;                     // how much of it
  // A decoded frame, copied out of its AudioData into arrays made once: a 20 ms one whole, as
  // nearly all are, and any other length, or 16-bit samples as some browsers give, into scratch
  // as long as Opus's longest.
  #pcm = new Float32Array(FRAME);
  #floats = new Float32Array(OPUS_MOST);
  #ints = new Int16Array(OPUS_MOST);

  // `opened`: what openAudio() opened, in the click. `hooks`: what the call hears:
  // beat() every 20 ms of audio, and silent() once the beat has stopped; frame(pcm, voice, db) for
  // each 20 ms the microphone gives; running(on) when the audio clock starts or stops;
  // encoded(chunk) for each Opus packet; restarted() when a new encoder takes over, without the
  // frames the old one held; problem(reason, message), something wrong that leaves the call as it
  // is; fail(reason, message), something that ends it; filter() when the filter changes.
  constructor(env, opened, note, filterOn, hooks) {
    this.#env = env;
    this.#opened = opened;
    this.#note = note;
    this.#filterOn = filterOn;
    this.#hooks = hooks;
    const { context } = opened;
    context.onstatechange = () => {
      note(`audio: ${context.state}`);
      hooks.running(context.state === 'running');
    };
  }

  // The noise filter: whether it runs here, and whether it is switched on.
  get filter() { return { available: this.#filterReady, on: this.#filterOn }; }

  // Whether a frame given now would be encoded.
  get encoding() { return !!this.#encoder && this.#encoder.state === 'configured'; }

  // Starts the playout and, unless `microphone` is false (a listener's), the microphone or the
  // test tone. `title` names the call on the lock screen, whose pause and play are `mute` and
  // `unmute`. `denoiser` is prepare's: the denoiser's module as `bytes` once it has landed, and
  // `landing`, which resolves to them, or to null without one.
  //
  // The worklets' modules and the microphone are asked for together. The playout, which beats
  // the call, starts as soon as the modules are in; only the capture waits for the microphone. A
  // microphone that comes after the call has stopped, as when its prompt was answered late, is
  // let go at once.
  async start({ title, microphone, tone, denoiser, mute, unmute }) {
    const env = this.#env;
    const note = this.#note;
    const { context, output } = this.#opened;
    const modules = microphone ? [WORKLETS.capture, WORKLETS.playout] : [WORKLETS.playout];
    const adding = Promise.all(modules.map((url) => context.audioWorklet.addModule(url)));
    // While our noise filter runs, the browser's own suppression stays off, so the two never work
    // on the same sound; echo cancellation and gain control stay on.
    const landed = denoiser ? denoiser.bytes : null;
    const ours = !!landed && this.#filterOn;
    const asking = microphone && !tone
      ? env.navigator.mediaDevices.getUserMedia({ audio: constraintsFor(ours) })
      : Promise.resolve(null);
    asking.then((stream) => {
      if (!stream) return;
      if (this.#stopped) stream.getTracks().forEach((track) => track.stop());
      else this.#stream = stream;
    }, ignore);
    adding.catch(ignore);
    await this.#inTime(adding);
    if (this.#stopped) throw new Error('the call stopped as it started');
    const playout = new env.AudioWorkletNode(context, 'playout', { outputChannelCount: [1] });
    if (output) output.play(playout);
    else playout.connect(context.destination);
    // Every 20 ms on the audio clock: the call's beat. A background tab's timers run as seldom as
    // once a second; the audio thread's messages keep coming.
    playout.port.onmessage = () => this.#hooks.beat();
    // A playout that stops beats no more: the call's slow timer steps it instead.
    playout.onprocessorerror = () => {
      note('the playout’s worklet stopped: nothing more plays');
      this.#hooks.silent();
    };
    this.#playout = playout;
    const stream = await asking;
    if (this.#stopped) throw new Error('the call stopped as it started');
    this.#lockScreen(title, mute, unmute);
    // A listener only hears: no microphone is asked for, captured or encoded, until a mute by force
    // is lifted (openMicrophone).
    if (microphone) this.#startCapture(stream, tone, landed, denoiser);
  }

  // The microphone, asked for mid-call, as when a mute by force is lifted (ADR 0028): the
  // microphone itself, asked for at once, so an ask made in a click is the click's, and the capture
  // worklet's module beside it; then the capture and an encoder, as start() makes them. Rejects as
  // start() does for the microphone, or once the call has stopped, any microphone answered later
  // let go.
  async openMicrophone({ tone, denoiser }) {
    const env = this.#env;
    const landed = denoiser ? denoiser.bytes : null;
    const ours = !!landed && this.#filterOn;
    const asking = tone ? Promise.resolve(null) : env.navigator.mediaDevices.getUserMedia({ audio: constraintsFor(ours) });
    asking.then((stream) => {
      if (!stream) return;
      if (this.#stopped) stream.getTracks().forEach((track) => track.stop());
      else this.#stream = stream;
    }, ignore);
    const adding = this.#opened.context.audioWorklet.addModule(WORKLETS.capture);
    adding.catch(ignore);
    const [stream] = await Promise.all([asking, this.#inTime(adding)]);
    if (this.#stopped) throw new Error('the call stopped as its microphone opened');
    this.#startCapture(stream, tone, landed, denoiser);
  }

  // `adding`, the worklets' modules loading, within MODULES_MS: one whose load never settles would
  // hold the call up for good.
  async #inTime(adding) {
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = this.#env.setTimeout(() => reject(new Error('the audio worklets did not load in time')), MODULES_MS);
    });
    try {
      await Promise.race([adding, late]);
    } finally {
      this.#env.clearTimeout(timer);
    }
  }

  // The capture of `stream`, or of the test tone, into its worklet, with an encoder for its frames,
  // and the denoiser: `landed`, its module as it was when the microphone was asked for, whose
  // constraints left the browser's suppression to it, or once it lands, switched on mid-call.
  #startCapture(stream, tone, landed, denoiser) {
    const env = this.#env;
    const note = this.#note;
    const { context } = this.#opened;
    const ours = !!landed && this.#filterOn;
    let source;
    if (tone) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      const gain = context.createGain();
      gain.gain.value = 0.1;
      oscillator.connect(gain);
      oscillator.start();
      source = gain;
    } else {
      // What the browser does to the microphone, in the background above all, goes in the log.
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onmute = () => note('the browser stopped the microphone for now');
        track.onunmute = () => note('the microphone is back');
        track.onended = () => note('the microphone ended');
        // What the browser made of the ask: iOS keeps its voice processing on whatever is asked,
        // and then both filters work on the same sound.
        const settings = track.getSettings ? track.getSettings() : null;
        const told = settings ? settings.noiseSuppression : undefined;
        this.#ownOn = told === undefined ? !ours : told;
        if (ours && this.#ownOn) note('the browser kept its own noise suppression on: ours stands aside');
      }
      source = sourceOf(context, stream);
    }
    const capture = new env.AudioWorkletNode(context, 'capture', { numberOfInputs: 1, numberOfOutputs: 0 });
    capture.onprocessorerror = () => {
      note('the microphone’s worklet stopped: nothing more goes out');
      this.#hooks.problem('capture', 'Your microphone stopped: nothing more goes out. Leave and join again.');
    };
    source.connect(capture);
    this.#capture = capture;
    // The denoiser runs in the worklet, on the audio thread, as its own module; not on the test
    // tone, which is no speech and would be filtered away.
    if (denoiser && !tone) {
      if (landed) this.#useDenoiser(landed, false);
      else denoiser.landing.then((bytes) => { if (bytes && !this.#stopped) this.#landed = bytes; }, ignore);
    }

    this.#encoder = this.#makeEncoder();
    capture.port.onmessage = (e) => this.#captured(e.data);
  }

  // The denoiser's module, to the capture worklet. One that lands after the microphone was asked
  // for waits (`landed`) for the call to switch it on at a quiet moment: the worklet compiles it
  // on the audio thread, which plays everyone too. Then the browser's own suppression goes off,
  // while the filter is on, and the call hears the filter is here.
  #useDenoiser(bytes, late) {
    this.#capture.port.postMessage({ bytes, apply: this.#applies() });
    this.#filterReady = true;
    if (!late) return;
    this.#switching = this.#env.now();
    if (this.#filterOn) this.#browserSuppression(false);
    this.#hooks.filter();
  }

  // Whether a denoiser that landed mid-call waits to be switched on.
  get landed() { return this.#landed !== null; }

  // Switches on the denoiser that landed mid-call: now is a quiet moment.
  switchOn() {
    const bytes = this.#landed;
    this.#landed = null;
    if (bytes && !this.#stopped) this.#useDenoiser(bytes, true);
  }

  // An Opus encoder. One that fails has closed for good (WebCodecs): if it had given packets, a
  // new one takes over and the frames' numbers go on; one that fails before its first packet
  // would only fail again, and the call fails.
  #makeEncoder() {
    let worked = false;
    const encoder = new this.#env.AudioEncoder({
      output: (chunk) => {
        worked = true;
        this.#hooks.encoded(chunk);
      },
      error: (error) => {
        if (encoder !== this.#encoder) return;
        if (!worked) {
          this.#hooks.fail('encoder', `Your browser’s audio encoder failed: ${error.message}`);
          return;
        }
        this.#note(`the audio encoder failed (${why(error)}): a new one takes over`);
        this.#hooks.restarted();
        this.#encoder = this.#makeEncoder();
      },
    });
    encoder.configure({
      codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 32000,
      opus: { frameDuration: 20000, useinbandfec: true, packetlossperc: 5 },
    });
    return encoder;
  }

  // Where WebKit was told this is a call, the lock screen names it, and its pause and play mute
  // and unmute.
  #lockScreen(title, mute, unmute) {
    if (!this.#opened.call) return;
    lockScreen(this.#env.navigator.mediaSession, this.#env.MediaMetadata, { title, mute, unmute });
    this.#opened.locked = true;
  }

  // What the capture worklet says: the denoiser is ready or stopped, or a 20 ms frame.
  // A frame comes as a bare array of FRAME + 1, its speech score last (NaN for none).
  #captured(data) {
    // What the worklet still posts after the call stopped is nobody's.
    if (this.#stopped) return;
    if (data instanceof Float32Array) {
      const score = data[FRAME];
      this.#hooks.frame(data, Number.isNaN(score) ? null : score, levelOf(data));
      this.#giveBack(data);
      return;
    }
    const { ready, failed } = data;
    if (ready) {
      const late = this.#switching === null ? '' : `: it came in mid-call, in ${Math.round(this.#env.now() - this.#switching)} ms`;
      this.#switching = null;
      this.#note(`noise filter ${this.#filterOn ? 'on' : 'off'}${late}`);
    } else if (failed) {
      // Without ours, the browser's own suppression comes back where it lets a call change it.
      this.#filterReady = false;
      this.#ownOn = true;
      this.#hooks.filter();
      this.#note(`the noise filter stopped (${failed}): the browser's own is back where it can be`);
      this.#browserSuppression(true);
    }
  }

  // The encoder's AudioData has copied a frame: its buffer goes back for the frames to come, moved,
  // four at a time so the pool costs fewer messages than it saves.
  #giveBack(pcm) {
    this.#back[this.#backs] = pcm;
    this.#backMoving[this.#backs] = pcm.buffer;
    this.#backs++;
    if (this.#backs < BACK) return;
    this.#backs = 0;
    if (this.#capture) this.#capture.port.postMessage(this.#back, this.#backMoving);
  }

  // The noise filter's switch: the worklet applies it at once. Off, the browser's own suppression
  // comes back where the browser lets a call change it.
  setFilter(on) {
    this.#filterOn = on;
    if (this.#capture) this.#capture.port.postMessage({ apply: this.#applies() });
    if (this.#filterReady) this.#browserSuppression(!on);
  }

  // Whether ours applies: switched on, and the browser's own off, so never both on one sound.
  #applies() { return this.#filterOn && !this.#ownOn; }

  // Asks the browser for its own noise suppression `on`, with every other constraint as first
  // asked (applyConstraints replaces the whole set), and says what it did: where getSettings()
  // tells, a browser may keep its suppression as it was mid-call.
  #browserSuppression(on) {
    const track = this.#stream && this.#stream.getAudioTracks()[0];
    if (!track) return;
    const words = (yes) => (yes ? 'on' : 'off');
    // Ours waits for the browser's answer before it applies, and goes aside if it kept its own on;
    // the browser's own counts as on from the moment it is asked for.
    if (on) this.#ownOn = true;
    const answered = () => {
      if (this.#capture && this.#filterReady) this.#capture.port.postMessage({ apply: this.#applies() });
    };
    track.applyConstraints(constraintsFor(!on)).then(() => {
      const did = track.getSettings ? track.getSettings().noiseSuppression : undefined;
      this.#ownOn = did === undefined ? on : did;
      if (did === undefined || did === on) this.#note(`the browser’s own noise suppression ${words(on)}`);
      else if (did && this.#filterOn) this.#note('the browser kept its own noise suppression on: ours stands aside');
      else this.#note(`the browser kept its own noise suppression ${words(did)}`);
      answered();
    }, (error) => {
      this.#note(`the browser would not change its own noise suppression: ${why(error)}`);
      answered();
    });
  }

  // A captured frame to the encoder, as frame number `seq`. The AudioData copies the samples, and
  // is closed once the encoder has it.
  encode(pcm, seq) {
    const data = new this.#env.AudioData({
      format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME, numberOfChannels: 1,
      timestamp: seq * 20000, data: pcm,
    });
    try {
      this.#encoder.encode(data);
    } catch (error) {
      // Closed since it was asked whether it encodes: its error callback replaces it.
      this.#note(`a frame the encoder refused: ${why(error)}`);
    } finally {
      data.close();
    }
  }

  // A decoded frame, into the beat's news for the playout worklet, in one copy: a 20 ms frame of
  // floats whole, any other sample by sample, 16-bit ones made floats on their way in. One longer
  // than Opus makes is let go.
  play(seat, decoded) {
    const samples = decoded.numberOfFrames;
    const floats = decoded.format.startsWith('f32');
    const into = !floats ? this.#ints : samples === FRAME ? this.#pcm : this.#floats;
    if (samples > into.length) {
      decoded.close();
      this.#note(`seat ${seat + 1}: a decoded frame of ${samples} samples, longer than Opus makes, let go`);
      return;
    }
    decoded.copyTo(into, PLANE);
    decoded.close();
    const at = this.#tell(seat, samples);
    if (at < 0) return;
    const news = this.#news;
    if (into === this.#pcm) {
      news.set(into, at);
    } else if (floats) {
      for (let i = 0; i < samples; i++) news[at + i] = into[i];
    } else {
      for (let i = 0; i < samples; i++) news[at + i] = into[i] / 32768;
    }
  }

  // A frame lost: the worklet plays 20 ms of silence for it, for now.
  lost(seat) { this.#tell(seat, LOST); }

  // The person on `seat` left it: the worklet lets their audio go.
  gone(seat) { this.#tell(seat, GONE); }

  // One piece of the beat's news: [seat, n], then room for n samples. Where they go, or -1 with no
  // playout to tell.
  #tell(seat, n) {
    if (!this.#playout || this.#stopped) return -1;
    const size = 2 + Math.max(n, 0);
    if (this.#told + size > this.#news.length) this.flush();
    const news = this.#news;
    const at = this.#told;
    news[at] = seat;
    news[at + 1] = n;
    this.#told = at + size;
    return at + 2;
  }

  // The beat's news, to the playout worklet in one message: the one array a beat makes for it,
  // moved. Each beat, once the call has popped every speaker (call.js).
  flush() {
    if (this.#told === 0) return;
    const message = this.#news.slice(0, this.#told);
    this.#told = 0;
    this.#moving[0] = message.buffer;
    this.#playout.port.postMessage(message, this.#moving);
  }

  // The page is shown again: audio picks up where the browser stopped it.
  resume() {
    const { output, context } = this.#opened;
    if (output) output.resume();
    else if (context.state !== 'running') context.resume().catch(ignore);
  }

  stop() {
    this.#stopped = true;
    // Neither worklet's error is the call's once it has stopped.
    if (this.#capture) this.#capture.onprocessorerror = null;
    if (this.#playout) this.#playout.onprocessorerror = null;
    if (this.#encoder && this.#encoder.state !== 'closed') this.#encoder.close();
    if (this.#stream) this.#stream.getTracks().forEach((track) => track.stop());
    closeAudio(this.#env, this.#opened);
    this.#encoder = null;
    this.#stream = null;
    this.#capture = null;
    this.#playout = null;
    this.#filterReady = false;
  }
}
