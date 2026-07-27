/**
 * Unit info panel — portrait, name, job, level, HP/MP meters, Brave/Faith and the
 * active status strip with durations.
 *
 * Swapping to a different unit cross-fades the panel and snaps the meters;
 * updating the *same* unit animates them, so a hit visibly drains the bar.
 */

import { add, div, el } from '../dom';
import { icon } from '../icons';
import { castPortrait, portrait } from '../portraits';
import type { StatusVM, UnitVM } from '../types';
import { Meter } from './Meter';
import { divider, Panel } from './Panel';

export interface UnitInfoOptions {
  /** 'full' shows derived stats and the status strip; 'compact' omits stats. */
  variant?: 'full' | 'compact';
  side?: 'left' | 'right';
  title?: string;
}

export class UnitInfoPanel {
  readonly root: HTMLDivElement;
  private readonly panel: Panel;
  private readonly faceSlot: HTMLDivElement;
  private readonly nameNode: HTMLSpanElement;
  private readonly jobNode: HTMLSpanElement;
  private readonly levelNode: HTMLSpanElement;
  private readonly teamNode: HTMLSpanElement;
  private readonly hp: Meter;
  private readonly mp: Meter;
  private readonly braveNode: HTMLSpanElement;
  private readonly faithNode: HTMLSpanElement;
  private readonly statStrip: HTMLDivElement;
  private readonly statusStrip: HTMLDivElement;
  private readonly variant: 'full' | 'compact';
  private currentId: string | null = null;

  constructor(opts: UnitInfoOptions = {}) {
    this.variant = opts.variant ?? 'full';
    this.panel = new Panel({
      className: `et-unitinfo et-unitinfo--${this.variant}`,
      from: opts.side === 'right' ? 'right' : 'left',
      title: opts.title,
    });
    this.root = this.panel.root;

    const head = div('et-unitinfo__head');
    this.faceSlot = div('et-unitinfo__face');
    const ident = div('et-unitinfo__ident');
    this.nameNode = el('span', 'et-unitinfo__name');
    const sub = div('et-unitinfo__sub');
    this.jobNode = el('span', 'et-unitinfo__job');
    this.levelNode = el('span', 'et-unitinfo__level');
    add(sub, this.jobNode, this.levelNode);
    add(ident, this.nameNode, sub);
    // Allegiance is set in the head, not derived from the reader noticing the
    // panel's tint. Two Knights of the same level are otherwise the same card.
    this.teamNode = el('span', 'et-unitinfo__team');
    add(head, this.faceSlot, ident, this.teamNode);

    this.hp = new Meter({ tone: 'hp', label: 'HP' });
    this.mp = new Meter({ tone: 'mp', label: 'MP' });
    const meters = div('et-unitinfo__meters');
    add(meters, this.hp.root, this.mp.root);

    const bf = div('et-unitinfo__bf');
    this.braveNode = el('span', 'et-bf__value');
    this.faithNode = el('span', 'et-bf__value');
    add(
      bf,
      bfBlock('Brave', this.braveNode),
      div('et-bf__sep'),
      bfBlock('Faith', this.faithNode),
    );

    this.statStrip = div('et-unitinfo__stats');
    this.statusStrip = div('et-unitinfo__statuses');

    add(this.panel.body, head, meters, bf);
    if (this.variant === 'full') {
      this.panel.body.appendChild(divider());
      this.panel.body.appendChild(this.statStrip);
    }
    this.panel.body.appendChild(this.statusStrip);
  }

  mount(parent: HTMLElement): void {
    this.panel.mount(parent);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('is-hidden', !v);
    this.root.classList.toggle('et-entered', v);
  }

  set(unit: UnitVM | null): void {
    if (!unit) {
      this.setVisible(false);
      this.currentId = null;
      return;
    }
    const swapped = this.currentId !== unit.id;
    this.currentId = unit.id;
    if (swapped) {
      this.root.classList.remove('is-swapping');
      void this.root.offsetWidth;
      this.root.classList.add('is-swapping');
      // Cast on the job the unit is actually doing — a Knight must not turn up
      // in a Time Mage's hat just because the id hashed that way.
      const face = castPortrait(unit.id, unit.portrait, { job: unit.job, gender: unit.gender });
      this.faceSlot.replaceChildren(portrait(face, { size: 'lg' }));
    }
    this.root.dataset['team'] = unit.team;
    this.teamNode.textContent = TEAM_WORD[unit.team] ?? '';
    this.nameNode.textContent = unit.name;
    this.jobNode.textContent = unit.job;
    this.levelNode.textContent = `Lv ${unit.level}`;
    this.hp.set(unit.hp, unit.maxHp, !swapped);
    this.mp.set(unit.mp, unit.maxMp, !swapped);
    this.braveNode.textContent = String(unit.brave);
    this.faithNode.textContent = String(unit.faith);

    if (this.variant === 'full') {
      this.statStrip.replaceChildren();
      const pairs: [string, number | undefined][] = [
        ['PA', unit.pa],
        ['MA', unit.ma],
        ['SPD', unit.spd],
        ['MOVE', unit.move],
        ['JUMP', unit.jump],
      ];
      for (const [label, value] of pairs) {
        if (value === undefined) continue;
        const cell = div('et-statcell');
        add(cell, el('span', 'et-statcell__label', label), el('span', 'et-statcell__value', String(value)));
        this.statStrip.appendChild(cell);
      }
      if (unit.jp !== undefined) {
        const cell = div('et-statcell et-statcell--jp');
        add(cell, el('span', 'et-statcell__label', 'JP'), el('span', 'et-statcell__value', String(unit.jp)));
        this.statStrip.appendChild(cell);
      }
    }

    this.setStatuses(unit.statuses);
    this.setVisible(true);
  }

  setStatuses(statuses: readonly StatusVM[]): void {
    this.statusStrip.replaceChildren();
    if (statuses.length === 0) {
      this.statusStrip.classList.add('is-empty');
      return;
    }
    this.statusStrip.classList.remove('is-empty');
    for (const s of statuses) {
      const pip = div(`et-status et-status--${s.tone}`);
      pip.appendChild(icon(s.id, 'et-status__icon'));
      pip.appendChild(el('span', 'et-status__name', s.name));
      pip.appendChild(
        el('span', 'et-status__time', s.remaining < 0 ? '∞' : String(s.remaining)),
      );
      pip.title = s.description ? `${s.name} — ${s.description}` : s.name;
      this.statusStrip.appendChild(pip);
    }
  }
}

/** Allegiance words. Kept short — this is a 8px tracked label, not a sentence. */
const TEAM_WORD: Readonly<Record<string, string>> = {
  player: 'Your Company',
  enemy: 'Hostile',
  ally: 'Allied',
  neutral: 'Neutral',
};

function bfBlock(label: string, valueNode: HTMLSpanElement): HTMLDivElement {
  const b = div('et-bf');
  add(b, el('span', 'et-bf__label', label), valueNode);
  return b;
}
