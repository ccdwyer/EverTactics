import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decideTurn: vi.fn(),
}));

vi.mock('../src/core/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/ai')>();
  return {
    ...actual,
    decideTurn: mocks.decideTurn,
  };
});

import { runAiBattle } from './helpers/aiBattle';

describe('AI battle rejection reporting', () => {
  beforeEach(() => {
    mocks.decideTurn.mockImplementation((_state, unit: string) => [
      { kind: 'move', unit, path: [] },
      { kind: 'move', unit, path: [] },
      { kind: 'wait', unit },
    ]);
  });

  it('keeps fail-fast rejection diagnostics as the default', () => {
    expect(() => runAiBattle(73, 'battle-open', {
      productionAi: true,
      maxTurns: 1,
      collectEvents: false,
    })).toThrow(
      'AI proposed an illegal command in battle-open, seed 73, turn 0',
    );
  });

  it('collects every rejected proposal and continues the sweep when requested', () => {
    const result = runAiBattle(73, 'battle-open', {
      productionAi: true,
      maxTurns: 1,
      collectEvents: false,
      rejectionMode: 'collect',
    });

    expect(result.rejections).toEqual([
      expect.objectContaining({
        scenarioId: 'battle-open',
        seed: 73,
        turn: 0,
        command: { kind: 'move', unit: expect.any(String), path: [] },
        message: 'move: empty path',
      }),
      expect.objectContaining({
        scenarioId: 'battle-open',
        seed: 73,
        turn: 0,
        command: { kind: 'move', unit: expect.any(String), path: [] },
        message: 'move: empty path',
      }),
    ]);
    expect(result.rejectedCommands).toBe(2);
    expect(result.commands).toBe(3);
    expect(result.turns).toBe(1);
  });
});
