/**
 * The vertical framed list with a bobbing cursor — the interaction primitive the
 * whole battle UI is built out of. Keyboard and mouse drive the same cursor, and
 * disabled rows are skipped by navigation but still hoverable so the player can
 * read why they are unavailable.
 */

import { play } from '../audio';
import { clamp, div, wrapIndex } from '../dom';
import type { FocusLayer, UIKey } from '../input';

export interface MenuListOptions<T> {
  className?: string;
  /** Fill a row element for an item. Called once per rebuild. */
  render: (item: T, row: HTMLDivElement, index: number) => void;
  enabled?: (item: T) => boolean;
  onHighlight?: (item: T | undefined, index: number) => void;
  onConfirm?: (item: T, index: number) => void;
  onCancel?: () => void;
  /** Grid navigation: >1 makes left/right move by one and up/down by `columns`. */
  columns?: number;
  /** Wrap navigation at the ends. Default true. */
  wrap?: boolean;
  /** Show the animated cursor caret. Default true. */
  cursor?: boolean;
  /** Emit sound on navigation. Default true. */
  sound?: boolean;
}

export class MenuList<T> implements FocusLayer {
  readonly root: HTMLDivElement;
  readonly name = 'menu-list';

  private readonly rows: HTMLDivElement[] = [];
  private readonly caret: HTMLDivElement;
  private items: readonly T[] = [];
  private index = -1;
  private focused = false;

  constructor(private readonly opts: MenuListOptions<T>) {
    this.root = div(`et-menu${opts.className ? ` ${opts.className}` : ''}`);
    if (opts.columns && opts.columns > 1) {
      this.root.classList.add('et-menu--grid');
      this.root.style.setProperty('--menu-columns', String(opts.columns));
    }
    this.caret = div('et-menu__caret');
    if (opts.cursor !== false) this.root.appendChild(this.caret);
    else this.caret.style.display = 'none';
  }

  setItems(items: readonly T[], keepIndex = true): void {
    const prev = this.index;
    this.items = items;
    this.rows.length = 0;
    // Remove all rows but keep the caret node.
    for (const child of Array.from(this.root.children)) {
      if (child !== this.caret) child.remove();
    }
    items.forEach((item, i) => {
      const row = div('et-menu__row');
      row.dataset['index'] = String(i);
      if (!this.isEnabled(item)) row.classList.add('is-disabled');
      this.opts.render(item, row, i);
      row.addEventListener('mouseenter', () => this.highlight(i, { silent: false, fromMouse: true }));
      row.addEventListener('click', () => {
        this.highlight(i, { silent: true });
        this.confirm();
      });
      this.root.appendChild(row);
      this.rows.push(row);
    });
    const target = keepIndex && prev >= 0 ? clamp(prev, 0, Math.max(0, items.length - 1)) : 0;
    this.index = -1;
    if (items.length > 0) this.highlight(this.firstSelectable(target), { silent: true });
    else this.opts.onHighlight?.(undefined, -1);
  }

  get selectedIndex(): number {
    return this.index;
  }

  get selected(): T | undefined {
    return this.items[this.index];
  }

  get length(): number {
    return this.items.length;
  }

  private isEnabled(item: T): boolean {
    return this.opts.enabled ? this.opts.enabled(item) : true;
  }

  /** Nearest selectable index at or after `start`, falling back to `start`. */
  private firstSelectable(start: number): number {
    if (this.items.length === 0) return -1;
    for (let d = 0; d < this.items.length; d++) {
      const i = wrapIndex(start + d, this.items.length);
      const item = this.items[i];
      if (item !== undefined && this.isEnabled(item)) return i;
    }
    return start;
  }

  highlight(index: number, opts: { silent?: boolean; fromMouse?: boolean } = {}): void {
    if (index === this.index || index < 0 || index >= this.items.length) {
      if (index === this.index && opts.fromMouse) return;
      if (index < 0 || index >= this.items.length) return;
    }
    const changed = index !== this.index;
    const prevRow = this.rows[this.index];
    if (prevRow) prevRow.classList.remove('is-active');
    this.index = index;
    const row = this.rows[index];
    if (row) {
      row.classList.add('is-active');
      this.moveCaret(row);
      this.scrollIntoView(row);
    }
    if (changed) {
      if (!opts.silent && this.opts.sound !== false) play('cursor');
      this.opts.onHighlight?.(this.items[index], index);
    }
  }

  private moveCaret(row: HTMLDivElement): void {
    if (this.opts.cursor === false) return;
    this.caret.style.transform = `translate3d(${row.offsetLeft - 18}px, ${
      row.offsetTop + row.offsetHeight / 2 - 9
    }px, 0)`;
    this.caret.classList.add('is-visible');
  }

  private scrollIntoView(row: HTMLDivElement): void {
    const box = this.root;
    if (box.scrollHeight <= box.clientHeight) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < box.scrollTop) box.scrollTo({ top: top - 8, behavior: 'smooth' });
    else if (bottom > box.scrollTop + box.clientHeight) {
      box.scrollTo({ top: bottom - box.clientHeight + 8, behavior: 'smooth' });
    }
  }

  /** Re-place the caret after a layout change (panel resize, font load). */
  refreshCaret(): void {
    const row = this.rows[this.index];
    if (row) this.moveCaret(row);
  }

  private step(delta: number): void {
    if (this.items.length === 0) return;
    const wrap = this.opts.wrap !== false;
    let next = this.index;
    for (let n = 0; n < this.items.length; n++) {
      next = wrap
        ? wrapIndex(next + delta, this.items.length)
        : clamp(next + delta, 0, this.items.length - 1);
      const item = this.items[next];
      if (item !== undefined && this.isEnabled(item)) break;
      if (!wrap && (next === 0 || next === this.items.length - 1)) break;
    }
    this.highlight(next);
  }

  confirm(): void {
    const item = this.selected;
    if (item === undefined) return;
    if (!this.isEnabled(item)) {
      play('error');
      const row = this.rows[this.index];
      if (row) {
        row.classList.remove('et-shake');
        void row.offsetWidth;
        row.classList.add('et-shake');
      }
      return;
    }
    play('confirm');
    const row = this.rows[this.index];
    if (row) {
      row.classList.remove('is-pressed');
      void row.offsetWidth;
      row.classList.add('is-pressed');
      window.setTimeout(() => row.classList.remove('is-pressed'), 260);
    }
    this.opts.onConfirm?.(item, this.index);
  }

  onKey(key: UIKey): boolean {
    const cols = this.opts.columns ?? 1;
    switch (key) {
      case 'up':
        this.step(-cols);
        return true;
      case 'down':
        this.step(cols);
        return true;
      case 'left':
        if (cols > 1) {
          this.step(-1);
          return true;
        }
        return false;
      case 'right':
        if (cols > 1) {
          this.step(1);
          return true;
        }
        return false;
      case 'next':
        this.step(1);
        return true;
      case 'prev':
        this.step(-1);
        return true;
      case 'page-down':
        this.step(cols * 4);
        return true;
      case 'page-up':
        this.step(-cols * 4);
        return true;
      case 'home':
        this.highlight(this.firstSelectable(0));
        return true;
      case 'end':
        this.highlight(this.firstSelectable(this.items.length - 1));
        return true;
      case 'confirm':
        this.confirm();
        return true;
      case 'cancel':
        if (this.opts.onCancel) {
          play('cancel');
          this.opts.onCancel();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  onFocusChange(active: boolean): void {
    this.focused = active;
    this.root.classList.toggle('is-focused', active);
    this.caret.classList.toggle('is-dim', !active);
  }

  get isFocused(): boolean {
    return this.focused;
  }
}
