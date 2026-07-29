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
import { Panel } from './Panel';

export interface UnitInfoOptions {
  /** 'full' shows derived stats and the status strip; 'compact' omits stats. */
  variant?: 'full' | 'compact';
  side?: 'left' | 'right';
  title?: string;
  /**
   * Lay the card out as a wide, short BAND — portrait column beside a data
   * column — instead of stacking everything under the head.
   *
   * On for the battle HUD, off everywhere else. The band trades height for
   * width, which is exactly right for a card pinned to a screen corner over a
   * board and exactly wrong for one dropped into a 390px sidebar on the roster
   * screen, where it squeezed the meters to 70px and the stat cells to 26.
   */
  band?: boolean;
  /** Show the full derived stat line, equipment and learned ability loadout. */
  showLoadout?: boolean;
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
  private readonly loadout: HTMLDivElement;
  private readonly variant: 'full' | 'compact';
  private readonly band: boolean;
  private readonly showLoadout: boolean;
  private currentId: string | null = null;

  constructor(opts: UnitInfoOptions = {}) {
    this.variant = opts.variant ?? 'full';
    this.band = opts.band ?? false;
    this.showLoadout = opts.showLoadout ?? false;
    this.panel = new Panel({
      className: `et-unitinfo et-unitinfo--${this.variant}${this.band ? ' et-unitinfo--band' : ''}`,
      from: opts.side === 'right' ? 'right' : 'left',
      title: opts.title,
    });
    this.root = this.panel.root;

    // TWO-COLUMN BAND (full variant).
    //
    // The face used to be the first flex child of the head row, so the panel was
    // a stack: [face + name] / [HP] / [MP] / [Brave-Faith] / [stats]. That stacks
    // to a near-square 362x389 block — 36% of the frame height sitting in the
    // corner — and it left a ~150x100px void of empty navy to the right of the
    // name, because nothing else in the panel was as tall as the portrait.
    //
    // The shipped acting panel is a wide short band: portrait on the left running
    // the panel's full height, everything else in one column beside it with the
    // two resource bars SIDE BY SIDE. Same information, ~190px shorter, and the
    // void disappears because the portrait column now has content next to it all
    // the way down.
    const layout = div('et-unitinfo__layout');
    const column = div('et-unitinfo__column');
    const head = div('et-unitinfo__head');
    this.faceSlot = div('et-unitinfo__face');
    const ident = div('et-unitinfo__ident');
    this.nameNode = el('span', 'et-unitinfo__name');
    const sub = div('et-unitinfo__sub');
    this.jobNode = el('span', 'et-unitinfo__job');
    this.levelNode = el('span', 'et-unitinfo__level');
    // Allegiance is set in the head, not derived from the reader noticing the
    // panel's tint. Two Knights of the same level are otherwise the same card.
    //
    // It rides the job/level line rather than being absolutely positioned in the
    // panel's top-right corner. Out of flow it had nothing to negotiate with, so
    // once the head moved into the narrower data column "HOSTILE" printed
    // straight through "CORVIN". On the sub line it is a flex sibling that the
    // browser can keep out of the way of the job name.
    this.teamNode = el('span', 'et-unitinfo__team');
    add(sub, this.jobNode, this.levelNode, this.teamNode);
    add(ident, this.nameNode, sub);
    if (this.band) add(head, ident);
    else add(head, this.faceSlot, ident);

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
    this.loadout = div('et-unitinfo__loadout');

    // Both variants use the same band, the compact one only narrower and without
    // the derived stats. The compact card carried the same defect the full one
    // did — a 104px portrait beside a two-line ident block, so the lower two
    // thirds of the portrait column faced nothing but flat panel navy.
    const rows =
      this.variant === 'full' || this.showLoadout
        ? [head, meters, bf, this.statStrip, this.statusStrip]
        : [head, meters, bf, this.statusStrip];
    if (this.band) {
      add(column, ...rows);
      add(layout, this.faceSlot, column);
      this.panel.body.appendChild(layout);
      if (this.showLoadout) this.panel.body.appendChild(this.loadout);
    } else {
      add(this.panel.body, ...rows);
      if (this.showLoadout) this.panel.body.appendChild(this.loadout);
    }
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
      this.faceSlot.replaceChildren(
        portrait(face, { size: this.band && this.variant === 'full' ? 'xl' : 'lg' }),
      );
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

    if (this.variant === 'full' || this.showLoadout) {
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

    if (this.showLoadout) this.setLoadout(unit);
    this.setStatuses(unit.statuses);
    this.setVisible(true);
  }

  private setLoadout(unit: UnitVM): void {
    this.loadout.replaceChildren();
    const loadout = unit.loadout;
    if (!loadout) {
      this.loadout.classList.add('is-empty');
      return;
    }
    this.loadout.classList.remove('is-empty');

    const equipment = div('et-loadout__section');
    equipment.appendChild(el('span', 'et-loadout__heading', 'Equipment'));
    const equipmentGrid = div('et-loadout__equipment');
    for (const entry of loadout.equipment) {
      const row = div('et-loadout__equipment-row');
      add(
        row,
        el('span', 'et-loadout__label', entry.slot),
        el('span', 'et-loadout__value', entry.name),
      );
      equipmentGrid.appendChild(row);
    }
    equipment.appendChild(equipmentGrid);

    const abilities = div('et-loadout__section');
    abilities.appendChild(el('span', 'et-loadout__heading', 'Abilities'));
    for (const group of loadout.actionGroups) {
      const row = div('et-loadout__ability-group');
      const names = group.abilities.length > 0 ? group.abilities.join(' · ') : 'None learned';
      add(
        row,
        el('span', 'et-loadout__label', group.name),
        el('span', 'et-loadout__ability-list', names),
      );
      row.title = names;
      abilities.appendChild(row);
    }
    for (const passive of loadout.passives) {
      const row = div('et-loadout__ability-group et-loadout__ability-group--passive');
      add(
        row,
        el('span', 'et-loadout__label', passive.slot),
        el('span', 'et-loadout__ability-list', passive.name),
      );
      abilities.appendChild(row);
    }

    add(this.loadout, equipment, abilities);
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
