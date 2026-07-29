import { describe, expect, it } from 'vitest';

import { explicitUnitPalette } from '../src/render/sprites';

describe('unit sprite team palettes', () => {
  it('lets the ACT sheet choose a genuine team row for legacy defaults', () => {
    expect(explicitUnitPalette('player', 0)).toBeUndefined();
    expect(explicitUnitPalette('enemy', 1)).toBeUndefined();
    expect(explicitUnitPalette('ally', 2)).toBeUndefined();
    expect(explicitUnitPalette('neutral', 3)).toBeUndefined();
  });

  it('preserves deliberate palette overrides, including slot zero', () => {
    expect(explicitUnitPalette('enemy', 0)).toBe(0);
    expect(explicitUnitPalette('player', 2)).toBe(2);
  });
});
