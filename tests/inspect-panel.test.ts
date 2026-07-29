import { describe, expect, it } from 'vitest';

import { ITEMS } from '../src/state/items';

describe('inspect panel item-name budget', () => {
  it('tracks the actual longest display names in the item table', () => {
    const maxLength = Math.max(...ITEMS.map((item) => item.name.length));
    const longestNames = ITEMS
      .filter((item) => item.name.length === maxLength)
      .map((item) => item.name);

    expect(maxLength).toBe(15);
    expect(longestNames).toEqual(['Assassin Dagger']);
  });
});
