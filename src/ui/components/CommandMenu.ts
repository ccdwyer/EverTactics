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

function numPx(value: string, fallback: number): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : v < lo ? lo : v > hi ? hi : v;
}

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
  /** Raw projected point from the renderer; snapped to a gutter by applyAnchor. */
  private anchor: { x: number; y: number } | null = null;

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

  /**
   * Position the menu with respect to a screen point (usually the acting unit).
   *
   * PLAYABILITY FIX (round 4). This used to write the projected point straight
   * into `--anchor-x/--anchor-y`, so the window materialised wherever the unit
   * happened to be — which in practice meant over the middle of the board, on
   * top of the unit being commanded and whoever was standing near it. Neither
   * reference game does that: FFT and Triangle both park the command window in a
   * side gutter and leave the board clear.
   *
   * So the anchor is now a *hint*, not a position. The point decides which
   * gutter the window uses (always the far one from the unit) and roughly how
   * high it sits; the actual x is snapped to that gutter's safe-area inset and
   * the y is clamped so the whole panel stays on screen. The window can no
   * longer overlap the acting unit, and it can never sit over the centre third.
   */
  placeAt(x: number, y: number): void {
    this.anchor = { x, y };
    this.root.classList.add('is-anchored');
    this.applyAnchor();
  }

  clearAnchor(): void {
    this.anchor = null;
    this.root.classList.remove('is-anchored');
  }

  /** Snap the stored anchor to a gutter. Safe to call before the panel has size. */
  private applyAnchor(): void {
    const a = this.anchor;
    if (!a) return;
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    const cs = getComputedStyle(this.root);
    const safe = numPx(cs.getPropertyValue('--hud-safe'), 32);
    const rail = numPx(cs.getPropertyValue('--hud-rail'), 112);

    const box = this.root.getBoundingClientRect();
    // Before first layout the panel has no size; fall back to its min-width and a
    // plausible height so the first frame is not placed off-screen.
    const w = box.width > 8 ? box.width : 208;
    const h = box.height > 8 ? box.height : 240;

    // Far gutter from the unit. A unit on the left half gets a right-docked
    // window and vice versa, which is what keeps the window off the unit.
    const onLeft = a.x < vw * 0.5;
    const left = onLeft ? vw - safe - w : safe + rail + 16;
    // `transform: translate(0, -50%)` in the stylesheet centres the panel on the
    // anchor's y, so clamp the CENTRE, not the top edge.
    const half = h / 2;
    const top = clamp(a.y, safe + half, vh - safe - half);

    this.root.style.setProperty('--anchor-x', `${Math.round(clamp(left, safe, vw - safe - w))}px`);
    this.root.style.setProperty('--anchor-y', `${Math.round(top)}px`);
  }

  show(parent: HTMLElement): void {
    if (this.open) return;
    this.open = true;
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    reflow(this.root);
    this.root.classList.add('is-open');
    this.panel.root.classList.add('et-entered');
    // Re-snap once the list has real content and the panel has real height —
    // the pre-layout guess above is only good enough to avoid a first-frame pop.
    this.applyAnchor();
    requestAnimationFrame(() => {
      this.applyAnchor();
      this.list.refreshCaret();
    });
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
    this.applyAnchor();
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
