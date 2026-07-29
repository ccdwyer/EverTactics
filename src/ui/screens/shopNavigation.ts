import type { UIKey } from '../input';

export type ShopPane = 'stock' | 'inventory' | 'recruit';

const PANE_ORDER: readonly ShopPane[] = ['stock', 'inventory', 'recruit'];

export function shopPaneTransition(pane: ShopPane, key: UIKey): ShopPane | null {
  if (key === 'next' || key === 'prev') {
    const current = PANE_ORDER.indexOf(pane);
    const direction = key === 'next' ? 1 : -1;
    return PANE_ORDER[
      (current + direction + PANE_ORDER.length) % PANE_ORDER.length
    ]!;
  }

  if (pane === 'stock' && key === 'right') return 'inventory';
  if (pane === 'inventory' && key === 'left') return 'stock';
  if (pane === 'inventory' && key === 'right') return 'recruit';
  if (pane === 'recruit' && (key === 'left' || key === 'up')) return 'inventory';
  return null;
}
