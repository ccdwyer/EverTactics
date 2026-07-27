/**
 * Formation screen — assign roster members to deployment slots before a battle.
 *
 * Left: the deployment slate, one framed cell per slot with the tile label
 * engraved beneath it. Right: the available roster. Confirming a slot arms it;
 * confirming a roster entry fills the armed slot and advances.
 */

import { play } from '../audio';
import { add, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import { portrait } from '../portraits';
import type { FormationScreenVM, FormationSlotVM, UIIntent, UnitVM } from '../types';
import { MenuList } from '../components/MenuList';
import { Panel } from '../components/Panel';
import { Screen } from './Screen';

export class FormationScreen extends Screen {
  readonly name = 'formation-screen';

  private readonly slatePanel: Panel;
  private readonly slate: HTMLDivElement;
  private readonly rosterPanel: Panel;
  private readonly rosterList: MenuList<UnitVM>;
  private readonly counter: HTMLSpanElement;
  private readonly confirmBtn: HTMLButtonElement;

  private vm: FormationScreenVM | null = null;
  private slotEls: HTMLDivElement[] = [];
  private slotCursor = 0;
  private pane: 'slate' | 'roster' = 'slate';

  constructor(private readonly emit: (i: UIIntent) => void) {
    super({ title: 'Formation', className: 'et-formation' });

    this.slatePanel = new Panel({ title: 'Deployment', className: 'et-formation__slate-panel', from: 'left' });
    this.slate = div('et-formation__slate');
    this.slatePanel.body.appendChild(this.slate);
    this.counter = el('span', 'et-formation__counter');
    this.confirmBtn = el('button', 'et-formation__confirm', 'Begin Battle');
    this.confirmBtn.type = 'button';
    this.confirmBtn.addEventListener('click', () => {
      play('confirm');
      this.emit({ kind: 'formation-confirm' });
    });
    add(this.slatePanel.footer(), this.counter, this.confirmBtn);

    this.rosterPanel = new Panel({ title: 'Roster', className: 'et-formation__roster-panel', from: 'right' });
    this.rosterList = new MenuList<UnitVM>({
      className: 'et-formation__roster',
      render: (u, row) => {
        row.classList.add('et-roster-row');
        row.appendChild(portrait(u.portrait, { size: 'sm' }));
        const main = div('et-roster-row__main');
        add(main, el('span', 'et-roster-row__name', u.name), el('span', 'et-roster-row__job', `${u.job} · Lv ${u.level}`));
        row.appendChild(main);
        if (this.isDeployed(u.id)) row.appendChild(icon('check', 'et-roster-row__mark'));
      },
      onConfirm: (u) => this.assign(u.id),
    });
    this.rosterPanel.body.appendChild(this.rosterList.root);

    add(this.content, this.slatePanel.root, this.rosterPanel.root);
    this.slatePanel.root.classList.add('et-entered');
    this.rosterPanel.root.classList.add('et-entered');
  }

  set(vm: FormationScreenVM): void {
    this.vm = vm;
    this.setHeading(vm.title, vm.subtitle);
    this.buildSlate();
    this.rosterList.setItems(vm.roster, true);
    const used = vm.slots.filter((s) => s.unitId).length;
    this.counter.textContent = `${used} / ${vm.maxDeployed} deployed`;
    this.confirmBtn.disabled = used === 0;
    this.applyPane();
  }

  private isDeployed(unitId: string): boolean {
    return this.vm?.slots.some((s) => s.unitId === unitId) ?? false;
  }

  private buildSlate(): void {
    const vm = this.vm;
    this.slate.replaceChildren();
    this.slotEls = [];
    if (!vm) return;
    vm.slots.forEach((slot, i) => {
      const cell = div('et-slot');
      cell.classList.toggle('is-locked', slot.locked === true);
      cell.classList.toggle('is-empty', !slot.unitId);
      const unit = slot.unitId ? vm.roster.find((u) => u.id === slot.unitId) : undefined;
      const frame = div('et-slot__frame');
      if (unit) frame.appendChild(portrait(unit.portrait, { size: 'md' }));
      else frame.appendChild(icon(slot.locked ? 'lock' : 'cursor', 'et-slot__placeholder'));
      add(
        cell,
        frame,
        el('span', 'et-slot__name', unit ? unit.name : slot.locked ? 'Locked' : 'Empty'),
        el('span', 'et-slot__tile', slot.tile ?? ''),
      );
      cell.addEventListener('mouseenter', () => this.moveSlot(i));
      cell.addEventListener('click', () => {
        this.pane = 'slate';
        this.moveSlot(i);
        this.armSlot();
      });
      this.slate.appendChild(cell);
      this.slotEls.push(cell);
    });
    this.syncSlotCursor();
  }

  private moveSlot(i: number): void {
    const vm = this.vm;
    if (!vm || vm.slots.length === 0) return;
    const next = ((i % vm.slots.length) + vm.slots.length) % vm.slots.length;
    if (next === this.slotCursor) return;
    this.slotCursor = next;
    play('cursor');
    this.syncSlotCursor();
  }

  private syncSlotCursor(): void {
    this.slotEls.forEach((elm, i) => elm.classList.toggle('is-active', i === this.slotCursor));
  }

  private currentSlot(): FormationSlotVM | undefined {
    return this.vm?.slots[this.slotCursor];
  }

  /** Confirming a slot either clears it or hands focus to the roster to fill it. */
  private armSlot(): void {
    const slot = this.currentSlot();
    if (!slot || slot.locked) {
      play('error');
      this.slatePanel.shake();
      return;
    }
    if (slot.unitId) {
      play('cancel');
      this.emit({ kind: 'formation-assign', index: slot.index, unitId: null });
      return;
    }
    play('confirm');
    this.pane = 'roster';
    this.applyPane();
  }

  private assign(unitId: string): void {
    const slot = this.currentSlot();
    if (!slot || slot.locked) {
      play('error');
      return;
    }
    this.emit({ kind: 'formation-assign', index: slot.index, unitId });
    this.pane = 'slate';
    const vm = this.vm;
    if (vm) this.moveSlot(Math.min(this.slotCursor + 1, vm.slots.length - 1));
    this.applyPane();
  }

  private applyPane(): void {
    this.slatePanel.root.classList.toggle('is-focused', this.pane === 'slate');
    this.rosterPanel.root.classList.toggle('is-focused', this.pane === 'roster');
    this.rosterList.onFocusChange(this.pane === 'roster');
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'next' || key === 'prev') {
      this.pane = this.pane === 'slate' ? 'roster' : 'slate';
      play('page');
      this.applyPane();
      return true;
    }
    if (this.pane === 'roster') {
      if (key === 'cancel') {
        play('cancel');
        this.pane = 'slate';
        this.applyPane();
        return true;
      }
      if (key === 'left') {
        this.pane = 'slate';
        this.applyPane();
        return true;
      }
      return this.rosterList.onKey(key);
    }
    const cols = 4;
    switch (key) {
      case 'left':
        this.moveSlot(this.slotCursor - 1);
        return true;
      case 'right':
        this.moveSlot(this.slotCursor + 1);
        return true;
      case 'up':
        this.moveSlot(Math.max(0, this.slotCursor - cols));
        return true;
      case 'down':
        this.moveSlot(this.slotCursor + cols);
        return true;
      case 'confirm':
        this.armSlot();
        return true;
      default:
        return false;
    }
  }
}
