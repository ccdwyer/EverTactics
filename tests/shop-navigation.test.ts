import { describe, expect, it } from 'vitest';

import { shopPaneTransition } from '../src/ui/screens/shopNavigation';

describe('shop keyboard and controller navigation', () => {
  it('reaches recruitment from either pane-navigation path', () => {
    expect(shopPaneTransition('inventory', 'right')).toBe('recruit');
    expect(shopPaneTransition('inventory', 'next')).toBe('recruit');
  });

  it('leaves vertical keys to the buy and sell lists', () => {
    expect(shopPaneTransition('stock', 'down')).toBeNull();
    expect(shopPaneTransition('inventory', 'down')).toBeNull();
    expect(shopPaneTransition('stock', 'up')).toBeNull();
    expect(shopPaneTransition('inventory', 'up')).toBeNull();
  });

  it('cycles all three panes in both directions', () => {
    expect(shopPaneTransition('stock', 'next')).toBe('inventory');
    expect(shopPaneTransition('inventory', 'next')).toBe('recruit');
    expect(shopPaneTransition('recruit', 'next')).toBe('stock');
    expect(shopPaneTransition('stock', 'prev')).toBe('recruit');
    expect(shopPaneTransition('recruit', 'prev')).toBe('inventory');
  });
});
