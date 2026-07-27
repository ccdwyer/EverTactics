/**
 * Predicted turn order.
 *
 * A ribbon of portrait chips: the acting unit sits proud at the head of the
 * ribbon, upcoming turns trail off to the right with a delta label. Reordering
 * is animated with a FLIP pass so a Haste or a Slow visibly reshuffles the
 * queue instead of teleporting — that legibility is the whole point of the bar.
 */

import { add, div, el } from '../dom';
import { icon } from '../icons';
import { portrait } from '../portraits';
import type { TurnEntryVM } from '../types';
import { isReducedMotion } from '../anim';

export interface TurnOrderCallbacks {
  onFocus(unitId: string): void;
  onSelect(unitId: string): void;
}

export class TurnOrderBar {
  readonly root: HTMLDivElement;
  private readonly track: HTMLDivElement;
  private readonly chips = new Map<string, HTMLDivElement>();
  private entries: readonly TurnEntryVM[] = [];

  constructor(private readonly cb: TurnOrderCallbacks) {
    this.root = div('et-turnorder');
    const label = div('et-turnorder__label');
    add(label, el('span', 'et-turnorder__label-text', 'Order of Battle'));
    this.track = div('et-turnorder__track');
    add(this.root, label, this.track);
  }

  setEntries(entries: readonly TurnEntryVM[]): void {
    // FLIP: capture the current geometry keyed by unit id.
    const before = new Map<string, number>();
    if (!isReducedMotion()) {
      for (const [id, node] of this.chips) before.set(id, node.getBoundingClientRect().left);
    }

    this.entries = entries;
    const seen = new Set<string>();
    this.track.replaceChildren();
    entries.forEach((entry, i) => {
      const key = `${entry.unitId}:${i}`;
      seen.add(key);
      const chip = this.buildChip(entry, i);
      this.track.appendChild(chip);
      this.chips.set(key, chip);
    });
    for (const key of Array.from(this.chips.keys())) if (!seen.has(key)) this.chips.delete(key);

    if (before.size > 0) {
      for (const [key, node] of this.chips) {
        const prev = before.get(key);
        if (prev === undefined) {
          node.classList.add('is-new');
          continue;
        }
        const delta = prev - node.getBoundingClientRect().left;
        if (Math.abs(delta) < 0.5) continue;
        node.style.transition = 'none';
        node.style.transform = `translate3d(${delta}px,0,0)`;
        requestAnimationFrame(() => {
          node.style.transition = '';
          node.style.transform = '';
        });
      }
    }
  }

  private buildChip(entry: TurnEntryVM, index: number): HTMLDivElement {
    const chip = div(`et-turnchip et-turnchip--${entry.team}`);
    if (entry.current) chip.classList.add('is-current');
    if (entry.disabled) chip.classList.add('is-disabled');
    chip.style.setProperty('--chip-index', String(index));

    const frame = div('et-turnchip__frame');
    frame.appendChild(portrait(entry.portrait, { size: entry.current ? 'md' : 'sm', className: 'et-turnchip__face' }));
    if (entry.current) frame.appendChild(icon('crown', 'et-turnchip__crown'));
    chip.appendChild(frame);

    const meta = div('et-turnchip__meta');
    add(
      meta,
      el('span', 'et-turnchip__name', entry.name),
      el(
        'span',
        'et-turnchip__delta',
        entry.current ? 'NOW' : entry.ticksUntil <= 0 ? 'NEXT' : `+${entry.ticksUntil}`,
      ),
    );
    if (entry.note) meta.appendChild(el('span', 'et-turnchip__note', entry.note));
    chip.appendChild(meta);

    chip.addEventListener('mouseenter', () => this.cb.onFocus(entry.unitId));
    chip.addEventListener('click', () => this.cb.onSelect(entry.unitId));
    return chip;
  }

  get length(): number {
    return this.entries.length;
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('is-hidden', !v);
  }
}
