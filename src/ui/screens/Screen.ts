/**
 * Base for the full-screen overlays (job, formation, roster, results).
 *
 * A screen owns a scrim, a heading rail, and a content region. It is a focus
 * layer: while open it swallows cancel and routes navigation to whichever pane
 * is currently active.
 */

import { play } from '../audio';
import { add, div, el, reflow } from '../dom';
import type { FocusLayer, UIKey } from '../input';

export interface ScreenOptions {
  title: string;
  subtitle?: string;
  /** Adds a "close" affordance in the rail. Default true. */
  closable?: boolean;
  className?: string;
}

export abstract class Screen implements FocusLayer {
  readonly root: HTMLDivElement;
  readonly content: HTMLDivElement;
  abstract readonly name: string;

  private readonly titleNode: HTMLSpanElement;
  private readonly subtitleNode: HTMLSpanElement;
  private readonly railExtra: HTMLDivElement;
  protected open = false;
  protected onClose: (() => void) | null = null;

  constructor(opts: ScreenOptions) {
    this.root = div(`et-screen${opts.className ? ` ${opts.className}` : ''}`);
    this.root.appendChild(div('et-screen__scrim'));

    const rail = div('et-screen__rail');
    const heading = div('et-screen__heading');
    this.titleNode = el('span', 'et-screen__title', opts.title);
    this.subtitleNode = el('span', 'et-screen__subtitle', opts.subtitle ?? '');
    add(heading, this.titleNode, this.subtitleNode);
    this.railExtra = div('et-screen__rail-extra');
    add(rail, heading, this.railExtra);

    if (opts.closable !== false) {
      const close = el('button', 'et-screen__close', 'Close');
      close.type = 'button';
      close.addEventListener('click', () => {
        play('cancel');
        this.onClose?.();
      });
      this.railExtra.appendChild(close);
    }

    this.content = div('et-screen__content');
    add(this.root, rail, this.content);
  }

  setHeading(title: string, subtitle?: string): void {
    this.titleNode.textContent = title;
    this.subtitleNode.textContent = subtitle ?? '';
  }

  /** Extra rail content (totals, funds, deploy counters). */
  protected rail(): HTMLDivElement {
    return this.railExtra;
  }

  show(parent: HTMLElement, onClose: () => void): void {
    this.onClose = onClose;
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    reflow(this.root);
    this.root.classList.add('is-open');
    this.open = true;
    play('open');
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open');
    play('close');
  }

  get isOpen(): boolean {
    return this.open;
  }

  onKey(key: UIKey, ev: KeyboardEvent): boolean {
    if (!this.open) return false;
    if (this.handleKey(key, ev)) return true;
    if (key === 'cancel') {
      play('cancel');
      this.onClose?.();
      return true;
    }
    // A screen is modal: never let keys fall through to the battle UI.
    return true;
  }

  protected abstract handleKey(key: UIKey, ev: KeyboardEvent): boolean;
}
