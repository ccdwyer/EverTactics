/**
 * Roster screen — the party ledger, now two-way.
 *
 * Left: unit cards. Right: detail, equipment slots, inventory and company
 * actions (jobs / rename / dismiss). Confirming a card opens the job tree when
 * the edit pane is idle; equipment and inventory rows emit equip intents.
 */

import { play } from '../audio';
import { add, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import { portrait } from '../portraits';
import type {
  RosterEquipSlotVM,
  RosterInventoryItemVM,
  RosterScreenVM,
  RosterUnitEditVM,
  UIIntent,
  UnitVM,
} from '../types';
import { MenuList } from '../components/MenuList';
import { Meter } from '../components/Meter';
import { UnitInfoPanel } from '../components/UnitInfoPanel';
import { Panel } from '../components/Panel';
import { Screen } from './Screen';

type Pane = 'grid' | 'gear' | 'inventory' | 'actions';

export class RosterScreen extends Screen {
  readonly name = 'roster-screen';

  private readonly gridPanel: Panel;
  private readonly grid: MenuList<UnitVM>;
  private readonly detail: UnitInfoPanel;
  private readonly editPanel: Panel;
  private readonly gearList: MenuList<RosterEquipSlotVM>;
  private readonly invList: MenuList<RosterInventoryItemVM>;
  private readonly actionBar: HTMLDivElement;
  private readonly funds: HTMLSpanElement;
  private readonly jobsBtn: HTMLButtonElement;
  private readonly renameBtn: HTMLButtonElement;
  private readonly dismissBtn: HTMLButtonElement;

  private vm: RosterScreenVM | null = null;
  private focusedId: string | null = null;
  private pane: Pane = 'grid';

  constructor(private readonly emit: (i: UIIntent) => void) {
    super({ title: 'Roster', className: 'et-rosterscreen' });

    this.funds = el('span', 'et-rosterscreen__funds');
    this.rail().insertBefore(this.funds, this.rail().firstChild);

    this.gridPanel = new Panel({
      title: 'Party',
      className: 'et-rosterscreen__grid-panel',
      from: 'left',
    });
    this.grid = new MenuList<UnitVM>({
      className: 'et-rosterscreen__grid',
      columns: 2,
      render: (u, row) => {
        row.classList.add('et-unitcard');
        row.dataset['team'] = u.team;
        row.appendChild(portrait(u.portrait, { size: 'md', className: 'et-unitcard__face' }));
        const main = div('et-unitcard__main');
        const head = div('et-unitcard__head');
        add(
          head,
          el('span', 'et-unitcard__name', u.name),
          el('span', 'et-unitcard__level', `Lv ${u.level}`),
        );
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
      onHighlight: (u) => this.focusUnit(u ?? null),
      onConfirm: (u) => {
        if (this.vm?.edits) {
          this.pane = 'gear';
          this.applyPane();
          play('confirm');
        } else {
          this.emit({ kind: 'open-job-screen', unitId: u.id });
        }
      },
    });
    this.gridPanel.body.appendChild(this.grid.root);

    this.detail = new UnitInfoPanel({ variant: 'full', side: 'right', title: 'Details' });

    this.editPanel = new Panel({
      title: 'Loadout',
      className: 'et-rosterscreen__edit-panel',
      from: 'right',
    });
    this.gearList = new MenuList<RosterEquipSlotVM>({
      className: 'et-rosterscreen__gear',
      enabled: (s) => s.itemId !== undefined,
      render: (s, row) => {
        row.classList.add('et-roster-equip-row');
        add(
          row,
          el('span', 'et-roster-equip-row__slot', s.label),
          el('span', 'et-roster-equip-row__item', s.itemName ?? '— empty —'),
        );
        if (s.itemId) row.appendChild(icon('check', 'et-roster-equip-row__mark'));
      },
      onConfirm: (s) => {
        const unitId = this.focusedId;
        if (!unitId || !s.itemId) {
          play('error');
          return;
        }
        this.emit({ kind: 'unequip-item', unitId, slot: s.slot });
      },
    });
    this.invList = new MenuList<RosterInventoryItemVM>({
      className: 'et-rosterscreen__inv',
      enabled: (item) => item.canEquip,
      render: (item, row) => {
        row.classList.add('et-roster-inv-row');
        if (!item.canEquip) row.classList.add('is-locked');
        add(
          row,
          el('span', 'et-roster-inv-row__name', item.name),
          el('span', 'et-roster-inv-row__count', `×${item.count}`),
        );
      },
      onConfirm: (item) => {
        const unitId = this.focusedId;
        if (!unitId || !item.canEquip) {
          play('error');
          return;
        }
        this.emit({ kind: 'equip-item', unitId, itemId: item.id });
      },
    });

    this.actionBar = div('et-rosterscreen__actions');
    this.jobsBtn = el('button', 'et-rosterscreen__btn', 'Jobs');
    this.jobsBtn.type = 'button';
    this.jobsBtn.addEventListener('click', () => this.openJobs());
    this.renameBtn = el('button', 'et-rosterscreen__btn', 'Rename');
    this.renameBtn.type = 'button';
    this.renameBtn.addEventListener('click', () => this.renameFocused());
    this.dismissBtn = el('button', 'et-rosterscreen__btn et-rosterscreen__btn--danger', 'Dismiss');
    this.dismissBtn.type = 'button';
    this.dismissBtn.addEventListener('click', () => this.dismissFocused());
    add(this.actionBar, this.jobsBtn, this.renameBtn, this.dismissBtn);

    const gearHead = el('div', 'et-rosterscreen__section-label', 'Equipment');
    const invHead = el('div', 'et-rosterscreen__section-label', 'Inventory');
    add(this.editPanel.body, gearHead, this.gearList.root, invHead, this.invList.root, this.actionBar);

    const right = div('et-rosterscreen__right');
    add(right, this.detail.root, this.editPanel.root);
    add(this.content, this.gridPanel.root, right);
    this.gridPanel.root.classList.add('et-entered');
    this.detail.root.classList.add('et-entered');
    this.editPanel.root.classList.add('et-entered');
  }

  set(vm: RosterScreenVM): void {
    this.vm = vm;
    this.setHeading(vm.title, `${vm.units.length} members`);
    this.funds.textContent = vm.gil !== undefined ? `${vm.gil.toLocaleString()} gil` : '';
    const keepId = this.focusedId;
    this.grid.setItems(vm.units, true);
    // Restore focus after a refresh so equip/unequip doesn't jump the cursor.
    if (keepId && vm.units.some((u) => u.id === keepId)) {
      const idx = vm.units.findIndex((u) => u.id === keepId);
      if (idx >= 0) this.grid.highlight(idx, { silent: true });
      this.focusUnit(vm.units[idx] ?? null);
    } else {
      this.focusUnit(vm.units[0] ?? null);
    }
    this.grid.onFocusChange(this.pane === 'grid');
    this.applyPane();
  }

  private focusUnit(unit: UnitVM | null): void {
    this.focusedId = unit?.id ?? null;
    this.detail.set(unit);
    this.refreshEditPane();
  }

  private currentEdit(): RosterUnitEditVM | null {
    if (!this.vm?.edits || !this.focusedId) return null;
    return this.vm.edits[this.focusedId] ?? null;
  }

  private refreshEditPane(): void {
    const edit = this.currentEdit();
    const hasEditor = this.vm?.edits !== undefined;
    this.editPanel.root.hidden = !hasEditor;
    if (!edit) {
      this.gearList.setItems([], true);
      this.invList.setItems([], true);
      this.dismissBtn.disabled = true;
      return;
    }
    this.gearList.setItems([...edit.equipment], true);
    this.invList.setItems([...edit.inventory], true);
    this.dismissBtn.disabled = !edit.canDismiss;
  }

  private openJobs(): void {
    if (!this.focusedId) return;
    play('confirm');
    this.emit({ kind: 'open-job-screen', unitId: this.focusedId });
  }

  private renameFocused(): void {
    if (!this.focusedId || !this.vm) return;
    const unit = this.vm.units.find((u) => u.id === this.focusedId);
    const current = unit?.name ?? '';
    const next = window.prompt('Rename unit', current);
    if (next === null) return;
    this.emit({ kind: 'rename-unit', unitId: this.focusedId, name: next });
  }

  private dismissFocused(): void {
    const edit = this.currentEdit();
    if (!edit || !edit.canDismiss || !this.focusedId) {
      play('error');
      return;
    }
    const unit = this.vm?.units.find((u) => u.id === this.focusedId);
    const ok = window.confirm(`Dismiss ${unit?.name ?? 'this unit'} from the company?`);
    if (!ok) return;
    this.emit({ kind: 'dismiss-unit', unitId: this.focusedId });
  }

  private applyPane(): void {
    const editable = this.vm?.edits !== undefined;
    this.gridPanel.root.classList.toggle('is-focused', this.pane === 'grid');
    this.editPanel.root.classList.toggle('is-focused', this.pane !== 'grid' && editable);
    this.grid.onFocusChange(this.pane === 'grid');
    this.gearList.onFocusChange(this.pane === 'gear');
    this.invList.onFocusChange(this.pane === 'inventory');
  }

  protected handleKey(key: UIKey): boolean {
    if (!this.vm?.edits) {
      return this.grid.onKey(key);
    }

    if (key === 'next' || key === 'prev') {
      const order: Pane[] = ['grid', 'gear', 'inventory', 'actions'];
      const i = order.indexOf(this.pane);
      const dir = key === 'next' ? 1 : -1;
      this.pane = order[(i + dir + order.length) % order.length]!;
      play('page');
      this.applyPane();
      return true;
    }

    if (this.pane === 'grid') {
      if (key === 'right') {
        this.pane = 'gear';
        this.applyPane();
        return true;
      }
      return this.grid.onKey(key);
    }

    if (this.pane === 'gear') {
      if (key === 'left' || key === 'cancel') {
        this.pane = 'grid';
        this.applyPane();
        return true;
      }
      return this.gearList.onKey(key);
    }

    if (this.pane === 'inventory') {
      if (key === 'left' || key === 'cancel') {
        this.pane = 'grid';
        this.applyPane();
        return true;
      }
      return this.invList.onKey(key);
    }

    // actions pane — Jobs on confirm; Rename/Dismiss stay on the buttons.
    if (key === 'cancel' || key === 'left') {
      this.pane = 'inventory';
      this.applyPane();
      return true;
    }
    if (key === 'confirm') {
      this.openJobs();
      return true;
    }
    return false;
  }
}
