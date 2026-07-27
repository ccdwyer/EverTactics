/**
 * Tiny tween layer. Everything numeric in the UI (HP bars, counters, meters)
 * animates through here so timing and easing stay consistent across components.
 */

export type Easing = (t: number) => number;

/** Snappy in, long settle — the house curve for menus. */
export const easeOutExpo: Easing = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic: Easing = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
/** Slight overshoot; used by numbers that "land". */
export const easeOutBack: Easing = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

let reducedMotion = false;

export function setReducedMotion(v: boolean): void {
  reducedMotion = v;
}

export function isReducedMotion(): boolean {
  return reducedMotion;
}

interface Tween {
  start: number;
  duration: number;
  from: number;
  to: number;
  ease: Easing;
  step: (v: number) => void;
  done?: () => void;
  cancelled: boolean;
}

const active = new Set<Tween>();
let rafId = 0;

function pump(now: number): void {
  rafId = 0;
  for (const t of Array.from(active)) {
    if (t.cancelled) {
      active.delete(t);
      continue;
    }
    const raw = t.duration <= 0 ? 1 : (now - t.start) / t.duration;
    const p = raw >= 1 ? 1 : raw < 0 ? 0 : raw;
    t.step(t.from + (t.to - t.from) * t.ease(p));
    if (p >= 1) {
      active.delete(t);
      t.done?.();
    }
  }
  if (active.size > 0) rafId = requestAnimationFrame(pump);
}

function schedule(): void {
  if (rafId === 0 && active.size > 0) rafId = requestAnimationFrame(pump);
}

export interface TweenHandle {
  cancel(): void;
  /** Jump to the end value immediately and fire the completion callback. */
  finish(): void;
}

export function tween(opts: {
  from: number;
  to: number;
  duration: number;
  ease?: Easing;
  delay?: number;
  step: (v: number) => void;
  done?: () => void;
}): TweenHandle {
  const { from, to, step, done } = opts;
  if (reducedMotion || opts.duration <= 0) {
    step(to);
    done?.();
    return { cancel: () => {}, finish: () => {} };
  }
  const t: Tween = {
    start: performance.now() + (opts.delay ?? 0),
    duration: opts.duration,
    from,
    to,
    ease: opts.ease ?? easeOutCubic,
    step,
    done,
    cancelled: false,
  };
  active.add(t);
  schedule();
  return {
    cancel: () => {
      t.cancelled = true;
    },
    finish: () => {
      if (t.cancelled) return;
      t.cancelled = true;
      active.delete(t);
      step(to);
      done?.();
    },
  };
}

/**
 * Count a number up (or down) into a text node. Large deltas take longer, but
 * the duration is capped so a 9999 damage roll does not stall the flow.
 */
export function countTo(
  node: HTMLElement,
  from: number,
  to: number,
  opts: { duration?: number; delay?: number; format?: (v: number) => string; done?: () => void } = {},
): TweenHandle {
  const format = opts.format ?? ((v: number) => String(Math.round(v)));
  const span = Math.abs(to - from);
  const duration = opts.duration ?? Math.min(900, 220 + span * 6);
  node.textContent = format(from);
  return tween({
    from,
    to,
    duration,
    delay: opts.delay,
    ease: easeOutExpo,
    step: (v) => {
      node.textContent = format(v);
    },
    done: () => {
      node.textContent = format(to);
      opts.done?.();
    },
  });
}

/** Await the next animation frame; used to sequence enter transitions. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
