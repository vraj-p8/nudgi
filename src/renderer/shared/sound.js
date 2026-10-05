// Nudgi sound kit. Every effect is synthesized live with WebAudio (no audio files):
// oscillators, short envelopes and filtered noise. Pitched cues use C major pentatonic around C6 so
// they sound like one soft, musical family. All voices share a master bus (volume -> gentle limiter)
// plus a small synthetic room reverb that glues them together.
//
//   import { sfx, speak } from '../shared/sound.js';
//   sfx.enabled = settings.sound; sfx.volume = settings.volume;
//   sfx.play('chime');                 // pop chime happy sad giggle step whoosh tap sparkle thunder
//   sfx.play('step', { pan: -0.4 });   // optional stereo position (-1 left .. 1 right)
//   await speak('Hey Vraj. Did you drink water?', { enabled: settings.voice, volume: settings.volume });

const NOTE = {
  C4: 261.63, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760,
  C7: 2093, D7: 2349.32, E7: 2637.02, G7: 3135.96, A7: 3520,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

let ctx = null;
let bus = null;
let room = null;
let enabled = true;
let volume = 0.6;
const noiseCache = {};

// Perceptual-ish volume curve; even 1.0 stays well below clipping.
const level = () => Math.pow(volume, 1.6) * 0.85;

// Master chain on any context: bus (volume) -> gentle limiter -> out, plus a small room reverb send.
function buildBus(c, gain) {
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -18;
  limiter.knee.value = 12;
  limiter.ratio.value = 5;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.2;
  const master = c.createGain();
  master.gain.value = gain;
  master.connect(limiter).connect(c.destination);
  const verb = c.createConvolver();
  verb.buffer = roomImpulse(c, 1.5);
  const darken = c.createBiquadFilter();
  darken.type = 'lowpass';
  darken.frequency.value = 4800;
  const send = c.createGain();
  send.gain.value = 0.55;
  send.connect(verb).connect(darken).connect(master);
  return { master, send };
}

function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC({ latencyHint: 'interactive' });
    ({ master: bus, send: room } = buildBus(ctx, level()));
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Decaying stereo noise = a soft, small room.
function roomImpulse(c, seconds) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4);
  }
  return buf;
}

function noiseBuffer(kind) {
  const key = `${kind}@${ctx.sampleRate}`;
  if (noiseCache[key]) return noiseCache[key];
  const len = ctx.sampleRate * 2.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02; // integrated noise: deep and soft
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return (noiseCache[key] = buf);
}

// Output stage for one voice: gain -> (pan) -> bus, plus a reverb send. Returns the input gain and a
// cleanup that disconnects the chain once the voice's sources have ended.
function output({ pan = 0, send = 0.2, movable = false }) {
  const nodes = [];
  const g = ctx.createGain();
  nodes.push(g);
  let tail = g;
  if (pan || movable) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    g.connect(p);
    nodes.push(p);
    tail = p;
  }
  tail.connect(bus);
  if (send > 0) {
    const s = ctx.createGain();
    s.gain.value = send;
    tail.connect(s).connect(room);
    nodes.push(s);
  }
  return { input: g, panner: tail === g ? null : tail, nodes };
}

function release(sources, nodes) {
  let left = sources.length;
  for (const s of sources) {
    s.onended = () => {
      if (--left > 0) return;
      for (const n of nodes) n.disconnect();
    };
  }
}

// Linear attack (no click), exponential decay (natural). Returns the time the envelope ends.
function envelope(param, t, { a = 0.005, peak = 0.2, hold = 0, d = 0.25 }) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + a);
  if (hold) param.setValueAtTime(peak, t + a + hold);
  param.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  return t + a + hold + d;
}

function tone(t, o) {
  const { freq, type = 'sine', a, d, hold, peak, to = 0, glide = 0.06, pan = 0, send = 0.15, lowpass = 0 } = o;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + glide);
  const amp = ctx.createGain();
  const end = envelope(amp.gain, t, { a, d, hold, peak });
  const out = output({ pan, send });
  const nodes = [amp, ...out.nodes];
  if (lowpass) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    osc.connect(f).connect(amp);
    nodes.push(f);
  } else osc.connect(amp);
  amp.connect(out.input);
  osc.start(t);
  osc.stop(end + 0.03);
  release([osc], nodes);
  return osc;
}

// Soft FM bell: harmonic modulator (ratio 2) whose brightness fades faster than the body.
function bell(t, freq, { peak = 0.12, d = 1, pan = 0, send = 0.35, index = 0.9 } = {}) {
  const car = ctx.createOscillator();
  car.frequency.value = freq;
  const mod = ctx.createOscillator();
  mod.frequency.value = freq * 2;
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(freq * index, t);
  depth.gain.exponentialRampToValueAtTime(freq * 0.02, t + d * 0.5);
  mod.connect(depth).connect(car.frequency);
  const amp = ctx.createGain();
  const end = envelope(amp.gain, t, { a: 0.003, peak, d });
  const out = output({ pan, send });
  car.connect(amp).connect(out.input);
  // A quiet inharmonic partial gives the "glass" shimmer without harshness.
  const part = ctx.createOscillator();
  part.frequency.value = freq * 3.01;
  const pAmp = ctx.createGain();
  envelope(pAmp.gain, t, { a: 0.002, peak: peak * 0.18, d: d * 0.35 });
  part.connect(pAmp).connect(out.input);
  for (const s of [car, mod, part]) {
    s.start(t);
    s.stop(end + 0.03);
  }
  release([car, mod, part], [depth, amp, pAmp, ...out.nodes]);
}

function pluck(t, freq, { peak = 0.14, d = 0.22, pan = 0, send = 0.25 } = {}) {
  tone(t, { freq, type: 'triangle', a: 0.003, d, peak, pan, send, lowpass: 3600 });
  tone(t, { freq: freq * 2, a: 0.002, d: d * 0.45, peak: peak * 0.22, pan, send });
}

function noise(t, o) {
  const { kind = 'white', dur, type = 'bandpass', freq, path = null, q = 1, a = 0.01, peak = 0.1, pan = 0, panTo = null, send = 0.1 } = o;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(kind);
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (path) for (const [hz, at] of path) f.frequency.exponentialRampToValueAtTime(hz, t + at);
  const amp = ctx.createGain();
  envelope(amp.gain, t, { a, peak, d: Math.max(0.01, dur - a) });
  const out = output({ pan, send, movable: panTo !== null });
  if (panTo !== null) {
    out.panner.pan.setValueAtTime(clamp(pan, -1, 1), t);
    out.panner.pan.linearRampToValueAtTime(clamp(panTo, -1, 1), t + dur);
  }
  src.connect(f).connect(amp).connect(out.input);
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.05);
  release([src], [f, amp, ...out.nodes]);
  return amp;
}

// ---- the kit ---------------------------------------------------------------------------------
// Every builder receives the start time and a base pan, and stays short and quiet by design.
const SOUNDS = {
  // Bubble appearing: a rising "bloop".
  pop(t, p) {
    tone(t, { freq: 420, to: 1150, glide: 0.07, a: 0.003, d: 0.12, peak: 0.32, pan: p, send: 0.12 });
    tone(t + 0.01, { freq: 1046.5, to: 2093, glide: 0.05, type: 'triangle', a: 0.002, d: 0.05, peak: 0.035, pan: p, send: 0 });
  },
  // Arrival: three glassy bells, E6 G6 C7.
  chime(t, p) {
    bell(t, NOTE.E6, { peak: 0.12, d: 1.0, pan: p - 0.15 });
    bell(t + 0.085, NOTE.G6, { peak: 0.105, d: 1.0, pan: p + 0.05 });
    bell(t + 0.17, NOTE.C7, { peak: 0.1, d: 1.35, pan: p + 0.2 });
  },
  // YES: bright rising arpeggio with a little twinkle on top.
  happy(t, p) {
    [NOTE.C6, NOTE.E6, NOTE.G6].forEach((f, i) => pluck(t + i * 0.075, f, { pan: p + (i - 1) * 0.12 }));
    bell(t + 0.225, NOTE.C7, { peak: 0.12, d: 0.8, pan: p + 0.15 });
    bell(t + 0.34, NOTE.E7, { peak: 0.04, d: 0.5, pan: p + 0.3, send: 0.5 });
  },
  // LATER: a soft, vocal-ish "aww" that droops from E5 to C5 with a little vibrato.
  sad(t, p) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(NOTE.E5, t);
    osc.frequency.setValueAtTime(NOTE.E5, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(NOTE.C5, t + 0.62);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, t);
    vibDepth.gain.linearRampToValueAtTime(7, t + 0.45);
    vib.connect(vibDepth).connect(osc.frequency);
    const wah = ctx.createBiquadFilter(); // the vowel: "aa" opening, closing to "oo"
    wah.type = 'lowpass';
    wah.Q.value = 4;
    wah.frequency.setValueAtTime(900, t);
    wah.frequency.linearRampToValueAtTime(2300, t + 0.12);
    wah.frequency.exponentialRampToValueAtTime(650, t + 0.75);
    const amp = ctx.createGain();
    const end = envelope(amp.gain, t, { a: 0.07, peak: 0.07, hold: 0.22, d: 0.5 });
    const out = output({ pan: p, send: 0.25 });
    osc.connect(wah).connect(amp).connect(out.input);
    for (const s of [osc, vib]) {
      s.start(t);
      s.stop(end + 0.03);
    }
    release([osc, vib], [vibDepth, wah, amp, ...out.nodes]);
    tone(t, { freq: NOTE.E5, to: NOTE.C5, glide: 0.62, a: 0.08, hold: 0.2, d: 0.45, peak: 0.025, pan: p, send: 0.2 });
  },
  // Poke / petting: five tiny "hee" syllables bouncing around A5-E6.
  giggle(t, p) {
    [NOTE.C6, NOTE.A5, NOTE.D6, NOTE.C6, NOTE.E6].forEach((f, i) => {
      const at = t + i * 0.082 + rand(-0.006, 0.006);
      const peak = 0.13 - i * 0.012;
      tone(at, { freq: f * 1.2, to: f, glide: 0.045, a: 0.004, d: 0.07, peak, pan: p + (i % 2 ? 0.12 : -0.12), send: 0.15 });
      tone(at, { freq: f * 2.4, to: f * 2, glide: 0.04, type: 'triangle', a: 0.003, d: 0.04, peak: peak * 0.18, pan: p, send: 0 });
    });
  },
  // Footstep: a barely-there felt thump, slightly varied so a walk never sounds mechanical.
  step(t, p) {
    const r = rand(0.9, 1.1);
    tone(t, { freq: 150 * r, to: 72 * r, glide: 0.05, a: 0.003, d: 0.07, peak: 0.07, pan: p, send: 0 });
    noise(t, { dur: 0.035, type: 'lowpass', freq: 900 * r, q: 0.7, a: 0.002, peak: 0.018, pan: p, send: 0 });
  },
  // Exit / quick move: airy band-passed noise sweeping across the stereo field.
  whoosh(t, p) {
    noise(t, {
      dur: 0.55, freq: 320, path: [[2100, 0.24], [520, 0.55]], q: 1.1, a: 0.16, peak: 0.16,
      pan: clamp(p - 0.5, -1, 1), panTo: p + 0.5, send: 0.2,
    });
  },
  // UI press: a soft wooden tick.
  tap(t, p) {
    tone(t, { freq: NOTE.G6, a: 0.001, d: 0.045, peak: 0.09, pan: p, send: 0.05 });
    tone(t, { freq: NOTE.G5, type: 'triangle', a: 0.001, d: 0.06, peak: 0.05, pan: p, send: 0 });
    noise(t, { dur: 0.014, freq: 3200, q: 1.4, a: 0.001, peak: 0.02, pan: p, send: 0 });
  },
  // Hearts / goal: scattered high pentatonic twinkles.
  sparkle(t, p) {
    const notes = [NOTE.C7, NOTE.E7, NOTE.G7, NOTE.D7, NOTE.A7, NOTE.G7];
    notes.forEach((f, i) => {
      bell(t + i * 0.058 + rand(0, 0.02), f, { peak: rand(0.035, 0.055), d: 0.42, pan: p + rand(-0.6, 0.6), send: 0.6, index: 0.6 });
    });
  },
  // Storm cloud: a distant, low, rolling rumble (kept quiet).
  thunder(t, p) {
    noise(t, { dur: 0.09, type: 'highpass', freq: 1400, q: 0.7, a: 0.004, peak: 0.018, pan: p + 0.2, send: 0.4 });
    const amp = noise(t, {
      kind: 'brown', dur: 2.3, type: 'lowpass', freq: 260, path: [[150, 0.8], [90, 2.2]], q: 0.9,
      a: 0.06, peak: 0.34, pan: p, send: 0.35,
    });
    // Re-shape into rolling swells: crack, settle, second roll, long fade.
    const g = amp.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(0.22, t + 0.07);
    g.exponentialRampToValueAtTime(0.09, t + 0.42);
    g.linearRampToValueAtTime(0.19, t + 0.68);
    g.exponentialRampToValueAtTime(0.0001, t + 2.3);
  },
};

export const SFX_NAMES = Object.freeze(Object.keys(SOUNDS));

export const sfx = {
  get enabled() {
    return enabled;
  },
  set enabled(v) {
    enabled = !!v;
  },
  get volume() {
    return volume;
  },
  set volume(v) {
    volume = clamp(Number(v) || 0, 0, 1);
    if (bus) bus.gain.setTargetAtTime(level(), ctx.currentTime, 0.03);
  },
  play(name, { pan = 0 } = {}) {
    const build = SOUNDS[name];
    if (!enabled || volume <= 0 || !build) return;
    try {
      if (!context()) return;
      build(ctx.currentTime + 0.01, clamp(Number(pan) || 0, -1, 1));
    } catch (err) {
      console.warn('[sfx]', name, err);
    }
  },
  // Renders one effect offline at the current volume (used by the dev lab for waveforms/levels).
  async render(name, seconds = 2.6) {
    const build = SOUNDS[name];
    if (!build || typeof OfflineAudioContext === 'undefined') return null;
    const off = new OfflineAudioContext(2, Math.ceil(48000 * seconds), 48000);
    const live = [ctx, bus, room];
    try {
      ctx = off;
      ({ master: bus, send: room } = buildBus(off, level()));
      build(0.01, 0);
    } finally {
      [ctx, bus, room] = live;
    }
    return off.startRendering();
  },
};

// ---- voice -----------------------------------------------------------------------------------
let speakSeq = 0;
let voiceWait = null;

function loadVoices(synth) {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  if (!voiceWait) {
    voiceWait = new Promise((resolve) => {
      const done = () => {
        synth.removeEventListener('voiceschanged', done);
        voiceWait = null;
        resolve(synth.getVoices());
      };
      synth.addEventListener('voiceschanged', done);
      setTimeout(done, 1500);
    });
  }
  return voiceWait;
}

// Prefer warm, natural-sounding English voices; fall back to any en-US, then any English voice.
function pickVoice(list) {
  let best = null;
  let bestScore = -1;
  for (const v of list) {
    if (!/^en([-_]|$)/i.test(v.lang)) continue;
    let score = 0;
    if (/natural/i.test(v.name)) score += 8;
    if (/\b(aria|jenny)\b/i.test(v.name)) score += 4;
    if (/\bzira\b/i.test(v.name)) score += 3;
    if (/samantha|google us english/i.test(v.name)) score += 2;
    if (/^en[-_]us/i.test(v.lang)) score += 1;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

// The voice speak() will use (null when speech is unavailable), e.g. for showing it in settings.
export async function preferredVoice() {
  const synth = window.speechSynthesis;
  return synth ? pickVoice(await loadVoices(synth)) : null;
}

const SPEECH_STRIP = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F\u20E3]/gu;

// Reads text aloud (emoji removed). Cancels anything already speaking; resolves when finished.
export async function speak(text, { enabled: on = true, volume: vol = 1 } = {}) {
  const synth = window.speechSynthesis;
  const clean = String(text ?? '').replace(SPEECH_STRIP, '').replace(/\s+/g, ' ').trim();
  const my = ++speakSeq;
  if (!synth) return;
  synth.cancel();
  if (!on || !clean) return;
  const voice = pickVoice(await loadVoices(synth));
  if (my !== speakSeq) return;
  const u = new SpeechSynthesisUtterance(clean);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-US';
  u.rate = 1.02;
  u.pitch = 1.1;
  u.volume = clamp(Number(vol) || 0, 0, 1);
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000 + clean.length * 120);
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    synth.speak(u);
  });
}

export function stopSpeaking() {
  speakSeq++;
  window.speechSynthesis?.cancel();
}
