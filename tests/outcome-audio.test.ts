import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.values.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class FakeElement extends EventTarget {
  className = '';
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  textContent = '';
  private children: FakeElement[] = [];

  get offsetWidth(): number {
    return 0;
  }

  setAttribute(): void {}

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    this.parentElement = null;
  }
}

class FakeWindow extends EventTarget {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
}

class FakeAudioParam {
  value = 0;
  readonly changes: { kind: string; value: number; time: number }[] = [];

  cancelScheduledValues(): this {
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    this.changes.push({ kind: 'hold', value: this.value, time });
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    this.changes.push({ kind: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.changes.push({ kind: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    this.changes.push({ kind: 'exponential', value, time });
    return this;
  }
}

class FakeAudioNode {
  readonly connections: unknown[] = [];

  connect<T>(destination: T): T {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {}
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
  readonly Q = { value: 0 };
}

class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  readonly detune = new FakeAudioParam();
  readonly starts: number[] = [];
  readonly stops: number[] = [];

  start(time: number): void {
    this.starts.push(time);
  }

  stop(time: number): void {
    this.stops.push(time);
  }
}

class FakeAudioContext {
  static readonly instances: FakeAudioContext[] = [];

  readonly currentTime = 10;
  readonly state = 'running';
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly filters: FakeBiquadFilterNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  suspendCalls = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    const node = new FakeBiquadFilterNode();
    this.filters.push(node);
    return node;
  }

  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.suspendCalls++;
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeAudioContext.instances.length = 0;
});

describe('outcome audio lifecycle', () => {
  it('stops the live sting when player input skips the outcome beat', async () => {
    const fakeWindow = new FakeWindow();
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('document', {
      createElement: () => new FakeElement(),
    });
    const { BattlePresentationScreen } = await import(
      '../src/ui/screens/BattlePresentationScreen'
    );
    const stop = vi.fn();
    const screen = new BattlePresentationScreen(() => ({ duration: 2.65, stop }));
    const parent = new FakeElement();

    const finished = screen.showOutcome(
      parent as unknown as HTMLElement,
      { outcome: 'victory', subtitle: 'The field is yours.' },
      10_000,
    );
    fakeWindow.dispatchEvent(new Event('keydown', { cancelable: true }));
    await finished;

    expect(stop).toHaveBeenCalledOnce();
    expect(screen.root.classList.contains('is-open')).toBe(false);
  });

  it('schedules the authored phrase, ducks SFX, and restores them on stop', async () => {
    vi.useFakeTimers();
    const fakeWindow = new FakeWindow();
    fakeWindow.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    vi.stubGlobal('window', fakeWindow);
    const { playOutcomeSting } = await import('../src/ui/audio');
    fakeWindow.dispatchEvent(new Event('keydown'));

    const playback = playOutcomeSting('victory');
    const context = FakeAudioContext.instances[0]!;
    const effectsGain = context.gains[1]!.gain;

    expect(context.oscillators).toHaveLength(8);
    expect(context.filters[0]!.connections).toContain(context.gains[0]);
    expect(
      effectsGain.changes.some(
        (change) => change.kind === 'linear' && change.value === 0.055,
      ),
    ).toBe(true);

    playback.stop();
    const stopCounts = context.oscillators.map((oscillator) => oscillator.stops.length);
    playback.stop();

    expect(stopCounts).toEqual(Array(8).fill(2));
    expect(context.oscillators.map((oscillator) => oscillator.stops.length)).toEqual(
      stopCounts,
    );
    expect(
      effectsGain.changes.some(
        (change) => change.kind === 'hold' && change.value === 0.055,
      ),
    ).toBe(true);
    expect(effectsGain.changes.at(-1)).toMatchObject({
      kind: 'linear',
      value: 1,
    });
    vi.runAllTimers();
  });

  it('stops an active sting immediately when the master mute is engaged', async () => {
    vi.useFakeTimers();
    const fakeWindow = new FakeWindow();
    fakeWindow.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    vi.stubGlobal('window', fakeWindow);
    const { playOutcomeSting, setSoundEnabled } = await import('../src/ui/audio');
    fakeWindow.dispatchEvent(new Event('pointerdown'));

    const playback = playOutcomeSting('defeat');
    const context = FakeAudioContext.instances[0]!;
    setSoundEnabled(false);
    const stopCounts = context.oscillators.map((oscillator) => oscillator.stops.length);
    playback.stop();

    expect(context.oscillators).toHaveLength(6);
    expect(stopCounts).toEqual(Array(6).fill(2));
    expect(context.oscillators.map((oscillator) => oscillator.stops.length)).toEqual(
      stopCounts,
    );
    expect(context.suspendCalls).toBe(1);
    vi.runAllTimers();
  });
});
