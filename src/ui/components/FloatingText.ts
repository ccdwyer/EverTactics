/**
 * Floating combat text.
 *
 * Numbers are built digit by digit so each character can land on its own beat —
 * that stagger is what gives a hit weight instead of the flat fade a single
 * animated `<span>` produces. Criticals get an extra impact ring and a wider
 * arc; misses tumble sideways; JP/EXP awards drift up slowly in gold.
 */

import { isReducedMotion } from '../anim';
import { div, el } from '../dom';
import { elementColor } from '../icons';
import type { FloatTextVM } from '../types';

/** Lifetime per kind, in ms. Must stay in sync with the CSS animation durations. */
const LIFETIME: Record<FloatTextVM['kind'], number> = {
  damage: 1100,
  crit: 1400,
  heal: 1200,
  miss: 1000,
  status: 1400,
  'status-cure': 1400,
  jp: 1600,
  exp: 1600,
  mp: 1200,
};

/** Clear space kept between two live floats, in px. */
const FLOAT_GAP = 6;
/** How far up a float may be pushed before it gives up and just overlaps. */
const MAX_PUSH = 240;

interface LiveFloat {
  node: HTMLDivElement;
  left: number;
  top: number;
  w: number;
  h: number;
}

export class FloatingTextLayer {
  readonly root: HTMLDivElement;
  /** Small horizontal jitter so simultaneous hits do not stack exactly. */
  private spawnCounter = 0;
  /** Boxes currently on screen, for collision avoidance. */
  private readonly live: LiveFloat[] = [];

  constructor() {
    this.root = div('et-floats');
  }

  clear(): void {
    this.root.replaceChildren();
    this.live.length = 0;
  }

  spawn(vm: FloatTextVM): void {
    const node = div(`et-float et-float--${vm.kind}`);
    const n = this.spawnCounter++;
    const drift = ((n % 5) - 2) * 17;
    const lift = ((n % 3) - 1) * 13;
    node.style.left = `${vm.x + drift}px`;
    node.style.top = `${vm.y + lift}px`;
    if (vm.delay) node.style.animationDelay = `${vm.delay}ms`;
    if (vm.element && vm.element !== 'none') {
      node.style.setProperty('--float-element', elementColor(vm.element));
      node.classList.add('has-element');
    }

    if (vm.kind === 'crit') {
      node.appendChild(div('et-float__ring'));
      node.appendChild(el('span', 'et-float__tag', 'CRITICAL'));
    }

    const text = this.textFor(vm);
    const glyphs = div('et-float__glyphs');
    let i = 0;
    for (const ch of text) {
      const span = el('span', 'et-float__ch', ch);
      const stagger = isReducedMotion() ? 0 : i * 34;
      span.style.animationDelay = `${(vm.delay ?? 0) + stagger}ms`;
      glyphs.appendChild(span);
      i++;
    }
    node.appendChild(glyphs);

    if (vm.kind === 'jp' || vm.kind === 'exp') {
      node.appendChild(el('span', 'et-float__suffix', vm.kind === 'jp' ? 'JP' : 'EXP'));
    }

    this.root.appendChild(node);
    const entry = this.place(node, vm.x + drift, vm.y + lift);
    const life = LIFETIME[vm.kind] + (vm.delay ?? 0) + i * 34;
    window.setTimeout(() => {
      node.remove();
      const at = this.live.indexOf(entry);
      if (at >= 0) this.live.splice(at, 1);
    }, life + 120);
  }

  /**
   * Push a freshly spawned float clear of every other live float.
   *
   * "Damage numbers physically collide — 224 overlaps 208, both overlap the
   * sprites they belong to, so the readout is illegible at the exact moment it
   * matters" was filed against round 6, and the modulo jitter it replaced was
   * never a fix: `(n % 5 - 2) * 17` gives the same offset to every fifth float,
   * so two hits on the same target one beat apart could land byte-identical. It
   * also could not know how WIDE the numbers were, and a four-digit crit is
   * three times the width of "8".
   *
   * So: measure, then walk UP until the box is clear. Up rather than sideways
   * because a float's whole motion is a rise — pushing it up puts it earlier in
   * the same path the eye is already following, whereas pushing it sideways
   * detaches it from the unit it belongs to. The layer is `position: absolute`
   * over the scene and floats never wrap, so one measure per spawn is enough;
   * their animations run on `transform`, which does not disturb the layout box
   * we measured.
   */
  private place(node: HTMLDivElement, left: number, top: number): LiveFloat {
    const r = node.getBoundingClientRect();
    const host = this.root.getBoundingClientRect();
    const w = r.width || 40;
    const h = r.height || 24;
    // getBoundingClientRect is viewport-space; the float is positioned in the
    // layer's own space, so compare in layer space or a scrolled/offset HUD
    // silently stops colliding.
    let y = r.top - host.top;
    const x = r.left - host.left;
    const limit = y - MAX_PUSH;
    let guard = 0;
    for (;;) {
      const hit = this.live.find(
        (o) =>
          x < o.left + o.w + FLOAT_GAP &&
          x + w + FLOAT_GAP > o.left &&
          y < o.top + o.h + FLOAT_GAP &&
          y + h + FLOAT_GAP > o.top,
      );
      if (!hit || y <= limit || guard++ > 24) break;
      y = hit.top - h - FLOAT_GAP;
    }
    const shift = y - (r.top - host.top);
    if (shift !== 0) node.style.top = `${top + shift}px`;
    const entry: LiveFloat = { node, left: x, top: y, w, h };
    this.live.push(entry);
    return entry;
  }

  /** Convenience for a burst of hits landing on one target. */
  spawnBurst(items: readonly FloatTextVM[], stepMs = 130): void {
    items.forEach((item, i) => this.spawn({ ...item, delay: (item.delay ?? 0) + i * stepMs }));
  }

  private textFor(vm: FloatTextVM): string {
    switch (vm.kind) {
      case 'miss':
        return vm.text ?? 'MISS';
      case 'status':
      case 'status-cure':
        return vm.text ?? '';
      case 'heal':
        return `+${Math.round(Math.abs(vm.value ?? 0))}`;
      case 'mp':
        return `${(vm.value ?? 0) >= 0 ? '+' : ''}${Math.round(vm.value ?? 0)}`;
      case 'jp':
      case 'exp':
        return `+${Math.round(vm.value ?? 0)}`;
      default:
        return String(Math.round(Math.abs(vm.value ?? 0)));
    }
  }
}
