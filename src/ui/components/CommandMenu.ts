/**
 * The command menu — Move / Act / Item / Wait / Status.
 *
 * Opens with a short slide-and-scale, keeps a bobbing cursor on the highlighted
 * row, and prints the highlighted row's hint in the frame footer.
 */

import { add, div, el, reflow } from '../dom';
import { icon } from '../icons';
import type { FocusLayer, UIKey } from '../input';
import type { CommandItemVM } from '../types';
import { MenuList } from './MenuList';
import { Panel } from './Panel';

export interface CommandMenuCallbacks {
  onConfirm(id: string): void;
  onHighlight(id: string | null): void;
  onCancel(): void;
}

export class CommandMenu implements FocusLayer {
  readonly name = 'command-menu';
  readonly root: HTMLDivElement;

  private readonly panel: Panel;
  private readonly list: MenuList<CommandItemVM>;
  private readonly hint: HTMLSpanElement;
  private open = false;

  constructor(private readonly cb: CommandMenuCallbacks) {
    this.root = div('et-command');
    this.panel = new Panel({ className: 'et-command__panel', from: 'left', tone: 'default' });
    this.list = new MenuList<CommandItemVM>({
      className: 'et-command__list',
      enabled: (item) => item.enabled,
      render: (item, row) => {
        row.classList.add('et-command__row');
        if (item.icon) row.appendChild(icon(item.icon, 'et-command__icon'));
        row.appendChild(el('span', 'et-command__label', item.label));
        if (item.detail) row.appendChild(el('span', 'et-command__detail', item.detail));
        if (item.opensSubmenu) row.appendChild(icon('chevron', 'et-command__chevron'));
      },
      onHighlight: (item) => {
        this.hint.textContent = item?.hint ?? '';
        this.cb.onHighlight(item?.id ?? null);
      },
      onConfirm: (item) => this.cb.onConfirm(item.id),
      onCancel: () => this.cb.onCancel(),
    });
    this.panel.body.appendChild(this.list.root);
    this.hint = el('span', 'et-command__hint');
    add(this.panel.footer(), this.hint);
    this.root.appendChild(this.panel.root);
  }

  setItems(items: readonly CommandItemVM[]): void {
    this.list.setItems(items, false);
  }

  /** Position the menu near a screen point (usually the active unit). */
  placeAt(x: number, y: number): void {
    this.root.style.setProperty('--anchor-x', `${Math.round(x)}px`);
    this.root.style.setProperty('--anchor-y', `${Math.round(y)}px`);
    this.root.classList.add('is-anchored');
  }

  clearAnchor(): void {
    this.root.classList.remove('is-anchored');
  }

  show(parent: HTMLElement): void {
    if (this.open) return;
    this.open = true;
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    reflow(this.root);
    this.root.classList.add('is-open');
    this.panel.root.classList.add('et-entered');
    requestAnimationFrame(() => this.list.refreshCaret());
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('is-open');
    this.panel.root.classList.remove('et-entered');
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
