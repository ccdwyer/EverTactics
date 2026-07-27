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

/**
 * The step prompt — one line of instruction, centred on the top edge.
 *
 * Measured off refs/curated/fft/press-042310-...-mediakit-06.png: the shipped
 * frame carries a rounded translucent pill at the top centre reading "Select a
 * tile and press ⨂ to move.", with the button glyph set INLINE in the sentence.
 * It is the piece of HUD grammar the critics kept naming by shape — "a rounded
 * tooltip pill with icon and body copy" — and the reason the reference reads as
 * a game being played rather than as a render: it states what the player is
 * being asked for right now, which no other element in either HUD does.
 *
 * It is distinct from the hint rail in the opposite corner, and the reference
 * runs both at once: the rail is the button legend (what the keys do), the pill
 * is the instruction (what you are doing). Ours had the legend and not the
 * instruction, so the frame described its controls and never its state.
 *
 * `%k` in the text is replaced by a keycap, so the glyph sits mid-sentence the
 * way the reference sets it rather than being bolted to one end.
 */
export class PromptBar {
  readonly root: HTMLDivElement;
  private text = '';
  private key = '';

  constructor() {
    this.root = div('et-prompt');
    this.root.setAttribute('role', 'status');
    this.setVisible(false);
  }

  /** `null` hides the pill. Re-setting the same text does not re-animate. */
  set(text: string | null, key = ''): void {
    if (!text) {
      this.text = '';
      this.setVisible(false);
      return;
    }
    if (text === this.text && key === this.key) {
      this.setVisible(true);
      return;
    }
    this.text = text;
    this.key = key;
    const inner = div('et-prompt__inner');
    inner.appendChild(div('et-prompt__pip'));
    const line = el('span', 'et-prompt__text');
    for (const [i, part] of text.split('%k').entries()) {
      if (i > 0) line.appendChild(el('kbd', 'et-key et-key--inline', key || '↵'));
      if (part) line.appendChild(el('span', 'et-prompt__frag', part));
    }
    inner.appendChild(line);
    inner.appendChild(div('et-prompt__pip'));
    this.root.replaceChildren(inner);
    // Re-trigger the entrance so a changed instruction reads as a new one.
    this.root.classList.remove('is-in');
    reflow(this.root);
    this.setVisible(true);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('is-hidden', !v);
    if (v) this.root.classList.add('is-in');
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
