/**
 * Synthesised interface sounds.
 *
 * The reference games lean hard on menu audio — a dry tick when the cursor moves,
 * a bright chime on confirm, a low thud on cancel. These are generated with
 * WebAudio rather than shipped as samples: no assets, no licensing, and the
 * timbre is tuned right here.
 *
 * Nothing is created until the first user gesture, so autoplay policy is honoured.
 */

export type UISound =
  | 'cursor'
  | 'confirm'
  | 'cancel'
  | 'error'
  | 'open'
  | 'close'
  | 'page'
  | 'award'
  | 'levelup';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let volume = 0.32;

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);
  return ctx;
}

export function setSoundEnabled(v: boolean): void {
  enabled = v;
  if (!v && ctx) void ctx.suspend();
}

export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}

interface ToneSpec {
  freq: number;
  /** Frequency the tone glides to; omit for a steady pitch. */
  to?: number;
  type: OscillatorType;
  attack: number;
  decay: number;
  gain: number;
  delay?: number;
}

function tone(spec: ToneSpec): void {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (spec.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.freq, t0);
  if (spec.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), t0 + spec.decay);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(spec.gain, t0 + spec.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.attack + spec.decay);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + spec.attack + spec.decay + 0.05);
}

/** Short filtered noise burst — the "paper" layer under the menu ticks. */
function noise(gain: number, decay: number, freq: number, delay = 0): void {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const frames = Math.max(1, Math.floor(c.sampleRate * decay));
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic-ish pseudo noise; exact values do not matter for audio.
  let s = 1;
  for (let i = 0; i < frames; i++) {
    s = (s * 1664525 + 1013904223) % 4294967296;
    data[i] = (s / 2147483648 - 1) * (1 - i / frames);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t0);
}

export function play(sound: UISound): void {
  if (!enabled) return;
  switch (sound) {
    case 'cursor':
      tone({ freq: 1180, type: 'triangle', attack: 0.002, decay: 0.045, gain: 0.16 });
      noise(0.05, 0.03, 3200);
      break;
    case 'confirm':
      tone({ freq: 784, type: 'triangle', attack: 0.003, decay: 0.09, gain: 0.2 });
      tone({ freq: 1176, type: 'sine', attack: 0.004, decay: 0.16, gain: 0.13, delay: 0.045 });
      break;
    case 'cancel':
      tone({ freq: 420, to: 250, type: 'triangle', attack: 0.003, decay: 0.13, gain: 0.18 });
      break;
    case 'error':
      tone({ freq: 190, type: 'square', attack: 0.003, decay: 0.1, gain: 0.1 });
      tone({ freq: 178, type: 'square', attack: 0.003, decay: 0.14, gain: 0.09, delay: 0.09 });
      break;
    case 'open':
      tone({ freq: 520, to: 900, type: 'sine', attack: 0.004, decay: 0.14, gain: 0.12 });
      noise(0.07, 0.09, 1800);
      break;
    case 'close':
      tone({ freq: 760, to: 380, type: 'sine', attack: 0.004, decay: 0.12, gain: 0.11 });
      noise(0.05, 0.07, 1400);
      break;
    case 'page':
      noise(0.11, 0.11, 2400);
      tone({ freq: 640, type: 'triangle', attack: 0.002, decay: 0.05, gain: 0.07 });
      break;
    case 'award':
      tone({ freq: 880, type: 'sine', attack: 0.004, decay: 0.1, gain: 0.14 });
      tone({ freq: 1320, type: 'sine', attack: 0.004, decay: 0.14, gain: 0.11, delay: 0.06 });
      break;
    case 'levelup':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone({ freq: f, type: 'triangle', attack: 0.005, decay: 0.28, gain: 0.15, delay: i * 0.085 });
      });
      break;
  }
}
