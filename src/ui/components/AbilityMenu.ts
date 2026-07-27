/**
 * Ability / item submenu.
 *
 * Left: the scrolling framed list with MP cost and charge-time columns.
 * Right: a live detail panel that repaints as the cursor moves — element crest,
 * range / area / vertical read-out, formula stats, and the flavour description.
 */

import { add, div, el, reflow } from '../dom';
import { elementColor, elementIcon, icon } from '../icons';
import type { FocusLayer, UIKey } from '../input';
import type { AbilityItemVM } from '../types';
import { MenuList } from './MenuList';
import { divider, Panel } from './Panel';

export interface AbilityMenuCallbacks {
  onConfirm(id: string): void;
  onHighlight(id: string | null): void;
  onCancel(): void;
}

export class AbilityMenu implements FocusLayer {
  readonly name = 'ability-menu';
  readonly root: HTMLDivElement;

  private readonly listPanel: Panel;
  private readonly detailPanel: Panel;
  private readonly list: MenuList<AbilityItemVM>;
  private readonly detail: HTMLDivElement;
  private readonly mpTotal: HTMLSpanElement;
  private open = false;

  constructor(private readonly cb: AbilityMenuCallbacks) {
    this.root = div('et-abilities');

    this.listPanel = new Panel({ title: 'Abilities', className: 'et-abilities__list-panel', from: 'left' });
    this.list = new MenuList<AbilityItemVM>({
      className: 'et-abilities__list',
      enabled: (a) => a.enabled,
      render: (a, row) => {
        row.classList.add('et-ability-row');
        const crest = div('et-ability-row__crest');
        crest.style.color = elementColor(a.element);
        crest.appendChild(icon(elementIcon(a.element)));
        row.appendChild(crest);
        row.appendChild(el('span', 'et-ability-row__name', a.name));
        const cost = div('et-ability-row__cost');
        if (a.mp > 0) add(cost, el('span', 'et-ability-row__mp', String(a.mp)), el('span', 'et-ability-row__unit', 'MP'));
        if (a.ct > 0) add(cost, el('span', 'et-ability-row__ct', String(a.ct)), el('span', 'et-ability-row__unit', 'CT'));
        row.appendChild(cost);
        if (!a.enabled && a.reason) row.appendChild(el('span', 'et-ability-row__reason', a.reason));
      },
      onHighlight: (a) => {
        this.renderDetail(a);
        this.cb.onHighlight(a?.id ?? null);
      },
      onConfirm: (a) => this.cb.onConfirm(a.id),
      onCancel: () => this.cb.onCancel(),
    });
    this.listPanel.body.appendChild(this.list.root);
    this.mpTotal = el('span', 'et-abilities__mp-total');
    add(this.listPanel.footer(), this.mpTotal);

    this.detailPanel = new Panel({ tone: 'parchment', className: 'et-abilities__detail-panel', from: 'right' });
    this.detail = div('et-abilities__detail');
    this.detailPanel.body.appendChild(this.detail);

    add(this.root, this.listPanel.root, this.detailPanel.root);
  }

  setItems(items: readonly AbilityItemVM[], opts: { title?: string; mp?: number; maxMp?: number } = {}): void {
    this.listPanel.setTitle(opts.title ?? 'Abilities');
    this.mpTotal.textContent =
      opts.mp !== undefined && opts.maxMp !== undefined ? `MP  ${opts.mp} / ${opts.maxMp}` : '';
    this.list.setItems(items, false);
  }

  private renderDetail(a: AbilityItemVM | undefined): void {
    const box = this.detail;
    box.replaceChildren();
    if (!a) {
      box.appendChild(el('p', 'et-abilities__empty', 'No abilities available.'));
      return;
    }
    const head = div('et-abilities__detail-head');
    const crest = div('et-abilities__detail-crest');
    crest.style.color = elementColor(a.element);
    crest.appendChild(icon(elementIcon(a.element)));
    add(head, crest, el('h3', 'et-abilities__detail-name', a.name));
    box.appendChild(head);

    const chips = div('et-chips');
    chips.appendChild(chip('MP', a.mp > 0 ? String(a.mp) : '—'));
    chips.appendChild(chip('CT', a.ct > 0 ? String(a.ct) : 'Instant'));
    chips.appendChild(chip('Range', a.range === 0 ? 'Self' : String(a.range)));
    chips.appendChild(chip('Area', a.radius === 0 ? 'Single' : `${a.radius * 2 + 1}×${a.radius * 2 + 1}`));
    if (a.vertical !== undefined && Number.isFinite(a.vertical)) chips.appendChild(chip('Vert', String(a.vertical)));
    box.appendChild(chips);

    box.appendChild(divider());
    box.appendChild(el('p', 'et-abilities__desc', a.description));

    if (a.stats && a.stats.length > 0) {
      const table = div('et-abilities__stats');
      for (const s of a.stats) {
        const r = div('et-stat');
        add(r, el('span', 'et-stat__label', s.label), el('span', 'et-stat__value', s.value));
        table.appendChild(r);
      }
      box.appendChild(table);
    }
    if (!a.enabled && a.reason) {
      box.appendChild(el('p', 'et-abilities__blocked', a.reason));
    }
  }

  show(parent: HTMLElement): void {
    if (this.open) return;
    this.open = true;
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    reflow(this.root);
    this.root.classList.add('is-open');
    this.listPanel.root.classList.add('et-entered');
    this.detailPanel.root.classList.add('et-entered');
    requestAnimationFrame(() => this.list.refreshCaret());
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open');
    this.listPanel.root.classList.remove('et-entered');
    this.detailPanel.root.classList.remove('et-entered');
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Re-measure the caret after a layout or font change. */
  refreshLayout(): void {
    this.list.refreshCaret();
  }

  onKey(key: UIKey): boolean {
    if (!this.open) return false;
    return this.list.onKey(key);
  }

  onFocusChange(active: boolean): void {
    this.list.onFocusChange(active);
    this.root.classList.toggle('is-dim', !active);
  }
}

function chip(label: string, value: string): HTMLDivElement {
  const c = div('et-chip');
  add(c, el('span', 'et-chip__label', label), el('span', 'et-chip__value', value));
  return c;
}
