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

export type BattleSound =
  | 'step'
  | 'swing'
  | 'hit'
  | 'crit'
  | 'miss'
  | 'heal'
  | 'cast'
  | 'ko'
  | 'counter';

export interface BattleSoundOptions {
  /** Damage or healing as a fraction of the target's maximum HP. */
  severity?: number;
  /** WebAudio scheduling offset in seconds. */
  delay?: number;
}

export interface BattleSoundProfile {
  pitch: number;
  pitchTo: number;
  brightness: number;
  decay: number;
  gain: number;
  noiseGain: number;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;
let volume = 0.32;
let userGestureSeen = false;

if (typeof window !== 'undefined') {
  const unlock = (): void => {
    userGestureSeen = true;
    window.removeEventListener('keydown', unlock, true);
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('touchstart', unlock, true);
  };
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('touchstart', unlock, true);
}

function ensure(): AudioContext | null {
  if (!enabled) return null;
  if (typeof window === 'undefined') return null;
  if (!userGestureSeen) return null;
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

function clamp01(value: number | undefined): number {
  return Math.max(0, Math.min(1, value ?? 0.35));
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/**
 * Stable synthesis parameters before playback-only pitch jitter is applied.
 * Keeping this pure makes severity tuning measurable under Node.
 */
export function battleSoundProfile(
  sound: BattleSound,
  opts: BattleSoundOptions = {},
): BattleSoundProfile {
  const severity = clamp01(opts.severity);
  switch (sound) {
    case 'step':
      return {
        pitch: 118,
        pitchTo: 82,
        brightness: 620,
        decay: 0.075,
        gain: 0.07,
        noiseGain: 0.055,
      };
    case 'swing':
      return {
        pitch: 760,
        pitchTo: 230,
        brightness: 2_300,
        decay: 0.14,
        gain: 0.075,
        noiseGain: 0.085,
      };
    case 'hit':
      return {
        pitch: mix(92, 148, severity),
        pitchTo: mix(58, 82, severity),
        brightness: mix(620, 3_400, severity),
        decay: mix(0.085, 0.26, severity),
        gain: mix(0.09, 0.19, severity),
        noiseGain: mix(0.065, 0.15, severity),
      };
    case 'crit':
      return {
        pitch: mix(170, 260, severity),
        pitchTo: mix(72, 104, severity),
        brightness: mix(2_600, 5_200, severity),
        decay: mix(0.18, 0.36, severity),
        gain: mix(0.12, 0.2, severity),
        noiseGain: mix(0.1, 0.17, severity),
      };
    case 'miss':
      return {
        pitch: 690,
        pitchTo: 330,
        brightness: 2_700,
        decay: 0.18,
        gain: 0.06,
        noiseGain: 0.035,
      };
    case 'heal':
      return {
        pitch: 520,
        pitchTo: 1_040,
        brightness: 1_700,
        decay: mix(0.26, 0.42, severity),
        gain: mix(0.085, 0.13, severity),
        noiseGain: 0.025,
      };
    case 'cast':
      return {
        pitch: 180,
        pitchTo: 380,
        brightness: 2_100,
        decay: 0.42,
        gain: 0.095,
        noiseGain: 0.045,
      };
    case 'ko':
      return {
        pitch: 150,
        pitchTo: 48,
        brightness: 440,
        decay: 0.52,
        gain: 0.16,
        noiseGain: 0.11,
      };
    case 'counter':
      return {
        pitch: 430,
        pitchTo: 860,
        brightness: 2_200,
        decay: 0.17,
        gain: 0.11,
        noiseGain: 0.05,
      };
  }
}

interface BattleToneOptions {
  delay?: number;
  pitchScale?: number;
  gainScale?: number;
  decayScale?: number;
  type?: OscillatorType;
}

function battleTone(
  c: AudioContext,
  destination: AudioNode,
  profile: BattleSoundProfile,
  detune: number,
  opts: BattleToneOptions = {},
): void {
  const delay = opts.delay ?? 0;
  const decay = profile.decay * (opts.decayScale ?? 1);
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = opts.type ?? 'triangle';
  osc.detune.setValueAtTime(detune, t0);
  osc.frequency.setValueAtTime(profile.pitch * (opts.pitchScale ?? 1), t0);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(1, profile.pitchTo * (opts.pitchScale ?? 1)),
    t0 + decay,
  );
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(
    profile.gain * (opts.gainScale ?? 1),
    t0 + 0.004,
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(t0);
  osc.stop(t0 + decay + 0.04);
}

function battleNoise(
  c: AudioContext,
  destination: AudioNode,
  profile: BattleSoundProfile,
  detune: number,
  delay = 0,
): void {
  const t0 = c.currentTime + delay;
  const frames = Math.max(1, Math.floor(c.sampleRate * profile.decay));
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x9e3779b9;
  for (let i = 0; i < frames; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 2147483648 - 1) * (1 - i / frames);
  }
  const source = c.createBufferSource();
  const filter = c.createBiquadFilter();
  const gain = c.createGain();
  source.buffer = buffer;
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(
    profile.brightness * 2 ** (detune / 1200),
    t0,
  );
  filter.Q.value = 0.8;
  gain.gain.setValueAtTime(profile.noiseGain, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + profile.decay);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(t0);
}

interface ReservedVoice {
  start: number;
  end: number;
}

export const BATTLE_VOICE_CAP = 8;

export class BattleVoiceLimiter {
  private voices: ReservedVoice[] = [];

  constructor(private readonly cap = BATTLE_VOICE_CAP) {}

  reserve(start: number, end: number): boolean {
    this.voices = this.voices.filter((voice) => voice.end > start);
    let overlapping = 0;
    for (const voice of this.voices) {
      if (voice.start < end && voice.end > start) overlapping++;
    }
    if (overlapping >= this.cap) return false;
    this.voices.push({ start, end });
    return true;
  }
}

const battleVoiceLimiter = new BattleVoiceLimiter();

export function battlePitchDetune(sound: BattleSound, random = Math.random()): number {
  return (random * 2 - 1) * (sound === 'step' ? 14 : 24);
}

/**
 * Synthesise a battle cue on the same lazy AudioContext and master bus as UI audio.
 * Voice reservations are time-windowed so scheduled footsteps do not crowd out
 * later impacts, while genuinely simultaneous multi-target effects are capped.
 */
export function playBattle(sound: BattleSound, opts: BattleSoundOptions = {}): void {
  if (!enabled) return;
  const c = ensure();
  if (!c || !master) return;
  const profile = battleSoundProfile(sound, opts);
  const delay = Math.max(0, opts.delay ?? 0);
  const start = c.currentTime + delay;
  const end = start + profile.decay + 0.18;
  if (!battleVoiceLimiter.reserve(start, end)) return;

  const voice = c.createGain();
  voice.gain.value = 1;
  voice.connect(master);

  // Battle audio is intentionally non-deterministic presentation. Never draw
  // this jitter from the core battle RNG.
  const detune = battlePitchDetune(sound);
  battleNoise(c, voice, profile, detune, delay);
  battleTone(c, voice, profile, detune, { delay });

  if (sound === 'crit') {
    battleTone(c, voice, profile, detune + 7, {
      delay: delay + 0.035,
      pitchScale: 2.05,
      gainScale: 0.42,
      decayScale: 0.72,
      type: 'sine',
    });
  } else if (sound === 'heal') {
    battleTone(c, voice, profile, detune + 5, {
      delay: delay + 0.075,
      pitchScale: 1.5,
      gainScale: 0.62,
      decayScale: 0.78,
      type: 'sine',
    });
  } else if (sound === 'cast') {
    battleTone(c, voice, profile, detune - 6, {
      delay: delay + 0.055,
      pitchScale: 2,
      gainScale: 0.36,
      decayScale: 0.9,
      type: 'sine',
    });
  } else if (sound === 'counter') {
    battleTone(c, voice, profile, detune + 9, {
      delay: delay + 0.055,
      pitchScale: 1.5,
      gainScale: 0.7,
      decayScale: 0.6,
      type: 'square',
    });
  }

  const release = c.createOscillator();
  release.onended = () => voice.disconnect();
  release.start(end);
  release.stop(end + 0.001);
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
