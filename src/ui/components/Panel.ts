/**
 * The framed panel — the single most identity-defining piece of chrome in the UI.
 *
 * Structure (all styling lives in styles.css):
 *   .et-panel                 outer frame: gold rule, corner filigree, drop shadow
 *     .et-panel__vellum       parchment/vellum grain layer
 *     .et-panel__head         optional titled header with a rule underneath
 *     .et-panel__body         content
 *     .et-panel__foot         optional footer (hints, totals)
 */

import { add, div, el, reflow, removeAfterTransition } from '../dom';

export type PanelTone = 'default' | 'dark' | 'parchment' | 'danger';

export interface PanelOptions {
  title?: string;
  /** Small text to the right of the title, e.g. "3 / 5". */
  badge?: string;
  tone?: PanelTone;
  className?: string;
  /** Adds the ornate corner marks. Default true. */
  ornate?: boolean;
  /** Enter animation direction. */
  from?: 'left' | 'right' | 'bottom' | 'top' | 'scale' | 'none';
}

export class Panel {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  private head: HTMLDivElement | null = null;
  private titleNode: HTMLSpanElement | null = null;
  private badgeNode: HTMLSpanElement | null = null;
  private foot: HTMLDivElement | null = null;
  private readonly from: NonNullable<PanelOptions['from']>;

  constructor(opts: PanelOptions = {}) {
    const tone = opts.tone ?? 'default';
    this.from = opts.from ?? 'scale';
    this.root = div(
      `et-panel et-panel--${tone} et-enter-${this.from}${opts.ornate === false ? '' : ' et-panel--ornate'}${
        opts.className ? ` ${opts.className}` : ''
      }`,
    );
    this.root.appendChild(div('et-panel__vellum'));
    if (opts.ornate !== false) {
      for (const c of ['tl', 'tr', 'bl', 'br']) {
        this.root.appendChild(div(`et-panel__corner et-panel__corner--${c}`));
      }
    }
    if (opts.title !== undefined) this.setTitle(opts.title, opts.badge);
    this.body = div('et-panel__body');
    this.root.appendChild(this.body);
  }

  setTitle(title: string, badge?: string): void {
    if (!this.head) {
      this.head = div('et-panel__head');
      this.titleNode = el('span', 'et-panel__title');
      this.badgeNode = el('span', 'et-panel__badge');
      add(this.head, this.titleNode, this.badgeNode);
      // Header always precedes the body.
      if (this.body?.parentNode === this.root) this.root.insertBefore(this.head, this.body);
      else this.root.appendChild(this.head);
    }
    if (this.titleNode) this.titleNode.textContent = title;
    if (this.badgeNode) this.badgeNode.textContent = badge ?? '';
  }

  /** Footer strip; created lazily. Returns it so callers can fill it. */
  footer(): HTMLDivElement {
    if (!this.foot) {
      this.foot = div('et-panel__foot');
      this.root.appendChild(this.foot);
    }
    return this.foot;
  }

  /** Mount and run the enter transition. */
  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
    reflow(this.root);
    this.root.classList.add('et-entered');
  }

  /** Run the exit transition, then detach. */
  unmount(): void {
    if (!this.root.isConnected) return;
    this.root.classList.remove('et-entered');
    this.root.classList.add('et-exiting');
    removeAfterTransition(this.root, 520);
  }

  /** Flash the frame — used for invalid input. */
  shake(): void {
    this.root.classList.remove('et-shake');
    reflow(this.root);
    this.root.classList.add('et-shake');
    window.setTimeout(() => this.root.classList.remove('et-shake'), 420);
  }
}

/** Convenience: a labelled key/value row used across the info panels. */
export function statRow(label: string, value: string, className?: string): HTMLDivElement {
  const row = div(`et-stat${className ? ` ${className}` : ''}`);
  add(row, el('span', 'et-stat__label', label), el('span', 'et-stat__value', value));
  return row;
}

/** A horizontal rule with a diamond centre — used to break up dense panels. */
export function divider(label?: string): HTMLDivElement {
  const d = div('et-divider');
  if (label) d.appendChild(el('span', 'et-divider__label', label));
  return d;
}
