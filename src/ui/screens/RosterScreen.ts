/**
 * Roster screen — the party ledger.
 *
 * A grid of unit cards (portrait, name, job, level, HP/MP meters, status pips)
 * with a detail panel that follows the cursor. Confirming a card opens the job
 * screen for that unit.
 */

import { add, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import { portrait } from '../portraits';
import type { RosterScreenVM, UIIntent, UnitVM } from '../types';
import { MenuList } from '../components/MenuList';
import { Meter } from '../components/Meter';
import { UnitInfoPanel } from '../components/UnitInfoPanel';
import { Panel } from '../components/Panel';
import { Screen } from './Screen';

export class RosterScreen extends Screen {
  readonly name = 'roster-screen';

  private readonly gridPanel: Panel;
  private readonly grid: MenuList<UnitVM>;
  private readonly detail: UnitInfoPanel;
  private readonly funds: HTMLSpanElement;
  private vm: RosterScreenVM | null = null;

  constructor(private readonly emit: (i: UIIntent) => void) {
    super({ title: 'Roster', className: 'et-rosterscreen' });

    this.funds = el('span', 'et-rosterscreen__funds');
    this.rail().insertBefore(this.funds, this.rail().firstChild);

    this.gridPanel = new Panel({ title: 'Party', className: 'et-rosterscreen__grid-panel', from: 'left' });
    this.grid = new MenuList<UnitVM>({
      className: 'et-rosterscreen__grid',
      columns: 2,
      render: (u, row) => {
        row.classList.add('et-unitcard');
        row.dataset['team'] = u.team;
        row.appendChild(portrait(u.portrait, { size: 'md', className: 'et-unitcard__face' }));
        const main = div('et-unitcard__main');
        const head = div('et-unitcard__head');
        add(head, el('span', 'et-unitcard__name', u.name), el('span', 'et-unitcard__level', `Lv ${u.level}`));
        const hp = new Meter({ tone: 'hp', label: 'HP', compact: true });
        hp.set(u.hp, u.maxHp, false);
        const mp = new Meter({ tone: 'mp', label: 'MP', compact: true });
        mp.set(u.mp, u.maxMp, false);
        add(main, head, el('span', 'et-unitcard__job', u.job), hp.root, mp.root);
        const pips = div('et-unitcard__statuses');
        for (const s of u.statuses.slice(0, 5)) {
          const pip = div(`et-statuspip et-statuspip--${s.tone}`);
          pip.title = s.name;
          pip.appendChild(icon(s.id));
          pips.appendChild(pip);
        }
        main.appendChild(pips);
        row.appendChild(main);
        const note = this.vm?.notes?.[u.id];
        if (note) row.appendChild(el('span', 'et-unitcard__note', note));
      },
      onHighlight: (u) => this.detail.set(u ?? null),
      onConfirm: (u) => this.emit({ kind: 'open-job-screen', unitId: u.id }),
    });
    this.gridPanel.body.appendChild(this.grid.root);

    this.detail = new UnitInfoPanel({ variant: 'full', side: 'right', title: 'Details' });

    add(this.content, this.gridPanel.root, this.detail.root);
    this.gridPanel.root.classList.add('et-entered');
    this.detail.root.classList.add('et-entered');
  }

  set(vm: RosterScreenVM): void {
    this.vm = vm;
    this.setHeading(vm.title, `${vm.units.length} members`);
    this.funds.textContent = vm.gil !== undefined ? `${vm.gil.toLocaleString()} gil` : '';
    this.grid.setItems(vm.units, true);
    this.grid.onFocusChange(true);
  }

  protected handleKey(key: UIKey): boolean {
    return this.grid.onKey(key);
  }
}
