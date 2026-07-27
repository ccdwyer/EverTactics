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

export class FloatingTextLayer {
  readonly root: HTMLDivElement;
  /** Small horizontal jitter so simultaneous hits do not stack exactly. */
  private spawnCounter = 0;

  constructor() {
    this.root = div('et-floats');
  }

  clear(): void {
    this.root.replaceChildren();
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
    const life = LIFETIME[vm.kind] + (vm.delay ?? 0) + i * 34;
    window.setTimeout(() => node.remove(), life + 120);
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
