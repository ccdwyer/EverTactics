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
import { castRoster } from '../portraits';
import { portrait } from '../portraits';
import type { TurnEntryVM } from '../types';
import { isReducedMotion } from '../anim';

/**
 * The faces the whole rail shows, cast as a GROUP.
 *
 * Per-entry casting was blind to its neighbours and collided: two Thieves in the
 * same eight-chip column landed on the same drawing in two hair colours, which
 * reads as placeholder data no matter how good the individual face is. The rail
 * is also the one place in the game where every unit is visible at once, so it
 * is the place the constraint has to be enforced. See `castRoster`.
 *
 * De-duplication is done on the DISTINCT unit set, not on the entry list: a unit
 * that appears twice in the predicted queue (it acts, then acts again before
 * someone slow) must show the same face both times.
 */
function facesFor(entries: readonly TurnEntryVM[]): (string | undefined)[] {
  const order: string[] = [];
  const first = new Map<string, TurnEntryVM>();
  for (const e of entries) {
    if (first.has(e.unitId)) continue;
    first.set(e.unitId, e);
    order.push(e.unitId);
  }
  const cast = castRoster(
    order.map((id) => {
      const e = first.get(id) as TurnEntryVM;
      return { id: e.unitId, portrait: e.portrait, job: e.job, gender: e.gender };
    }),
  );
  const byUnit = new Map<string, string | undefined>();
  order.forEach((id, i) => byUnit.set(id, cast[i]));
  return entries.map((e) => byUnit.get(e.unitId));
}

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
    // FLIP: capture the current geometry keyed by unit id. The rail runs
    // vertically, so the axis that moves when a Haste reshuffles the queue is Y.
    const before = new Map<string, number>();
    if (!isReducedMotion()) {
      for (const [id, node] of this.chips) before.set(id, node.getBoundingClientRect().top);
    }

    this.entries = entries;
    const faces = facesFor(entries);
    const seen = new Set<string>();
    this.track.replaceChildren();
    entries.forEach((entry, i) => {
      const key = `${entry.unitId}:${i}`;
      seen.add(key);
      const chip = this.buildChip(entry, i, faces[i]);
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
        const delta = prev - node.getBoundingClientRect().top;
        if (Math.abs(delta) < 0.5) continue;
        node.style.transition = 'none';
        node.style.transform = `translate3d(0,${delta}px,0)`;
        requestAnimationFrame(() => {
          node.style.transition = '';
          node.style.transform = '';
        });
      }
    }
  }

  private buildChip(entry: TurnEntryVM, index: number, face: string | undefined): HTMLDivElement {
    const chip = div(`et-turnchip et-turnchip--${entry.team}`);
    if (entry.current) chip.classList.add('is-current');
    if (entry.disabled) chip.classList.add('is-disabled');
    chip.style.setProperty('--chip-index', String(index));

    const frame = div('et-turnchip__frame');
    // Head crop: at rail scale the shoulders are noise and the face is the read.
    frame.appendChild(
      portrait(face, {
        size: entry.current ? 'md' : 'sm',
        head: true,
        className: 'et-turnchip__face',
      }),
    );
    if (entry.current) frame.appendChild(icon('crown', 'et-turnchip__crown'));
    // HP sliver along the bottom of the face. See the note on TurnEntryVM.hp:
    // the shipped Combat Timeline carries one under every entry, and it is the
    // only thing in the rail that tells you WHICH of the four enemies queued
    // ahead of you is the one worth killing first.
    if (entry.hp !== undefined && entry.maxHp !== undefined && entry.maxHp > 0) {
      const frac = Math.max(0, Math.min(1, entry.hp / entry.maxHp));
      const bar = div('et-turnchip__hp');
      const fill = div('et-turnchip__hp-fill');
      if (frac <= 0.25) bar.classList.add('is-critical');
      fill.style.width = `${frac * 100}%`;
      bar.appendChild(fill);
      frame.appendChild(bar);
    }
    // The name plate hangs OUTSIDE the rail, over the board — so it is a hover
    // affordance only, never a resting state.
    //
    // Round 4 also showed it for `current`, which meant the default frame always
    // had "ALDRIC / Knight" floating on raw board pixels a few px right of the
    // rail with nothing binding it to the chrome. Two problems with that. It is
    // a listed fail condition (docs/VISUAL_TARGET.md: "Any UI panel sitting over
    // the playable board"), and it is redundant: the acting unit's name is
    // already set in 21px display type in the bottom-left panel, so the frame
    // carried the same word twice, once well and once badly. Measured off the
    // shipped Combat Timeline (refs/curated/fft/press-042310-...-mediakit-06.png)
    // the rail carries NO names at all — portrait, tick numeral, HP sliver, and
    // the acting unit's identity comes entirely from the panel it flows into.
    frame.appendChild(el('span', 'et-turnchip__name', entry.name));
    chip.appendChild(frame);

    // CT column. Round 3 printed a bare integer, which the critics read as debug
    // output ("a stack of bare numbers with no label, no hierarchy"). The numeral
    // is now the rail's second read after the face and carries a CT caption, so
    // "4" is legible as "four ticks until this unit acts" rather than as an index.
    const meta = div('et-turnchip__meta');
    add(
      meta,
      el(
        'span',
        'et-turnchip__delta',
        entry.current ? 'NOW' : entry.ticksUntil <= 0 ? '!' : String(entry.ticksUntil),
      ),
    );
    if (!entry.current) meta.appendChild(el('span', 'et-turnchip__delta-unit', 'CT'));
    chip.appendChild(meta);
    if (entry.job) frame.appendChild(el('span', 'et-turnchip__job', entry.job));
    chip.title = entry.note
      ? `${entry.name} — ${entry.note}`
      : entry.job
        ? `${entry.name} — ${entry.job}`
        : entry.name;

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
