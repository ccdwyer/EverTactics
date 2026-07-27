/**
 * Full-width announcement banner ("Battle Start", "Naruk's Turn", "Victory") and
 * the persistent control-hint rail along the bottom edge.
 */

import { add, div, el, removeAfterTransition, reflow } from '../dom';
import { play } from '../audio';

export type BannerTone = 'neutral' | 'player' | 'enemy' | 'victory' | 'defeat';

export class BannerLayer {
  readonly root: HTMLDivElement;
  private active: HTMLDivElement | null = null;
  private timer = 0;

  constructor() {
    this.root = div('et-banners');
  }

  /** Show a banner for `duration` ms. Showing a new one replaces the old. */
  show(title: string, opts: { subtitle?: string; tone?: BannerTone; duration?: number } = {}): void {
    this.dismiss();
    const node = div(`et-banner et-banner--${opts.tone ?? 'neutral'}`);
    const inner = div('et-banner__inner');
    add(inner, el('span', 'et-banner__title', title));
    if (opts.subtitle) inner.appendChild(el('span', 'et-banner__subtitle', opts.subtitle));
    add(node, div('et-banner__rule et-banner__rule--top'), inner, div('et-banner__rule et-banner__rule--bottom'));
    this.root.appendChild(node);
    reflow(node);
    node.classList.add('is-in');
    this.active = node;
    play(opts.tone === 'defeat' ? 'error' : 'open');
    this.timer = window.setTimeout(() => this.dismiss(), opts.duration ?? 1800);
  }

  dismiss(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    const node = this.active;
    this.active = null;
    if (!node) return;
    node.classList.remove('is-in');
    node.classList.add('is-out');
    removeAfterTransition(node, 700);
  }
}

export interface HintDef {
  keys: readonly string[];
  label: string;
}

export class HintBar {
  readonly root: HTMLDivElement;

  constructor() {
    this.root = div('et-hints');
  }

  set(hints: readonly HintDef[]): void {
    this.root.replaceChildren();
    for (const h of hints) {
      const item = div('et-hint');
      const keys = div('et-hint__keys');
      for (const k of h.keys) keys.appendChild(el('kbd', 'et-key', k));
      add(item, keys, el('span', 'et-hint__label', h.label));
      this.root.appendChild(item);
    }
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('is-hidden', !v);
  }
}
