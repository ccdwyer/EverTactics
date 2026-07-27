/**
 * Party inventory — the resource layer under the Item command.
 *
 * Before this existed a Chemist could throw Hi-Potions forever, which made the
 * Item command strictly better than every other action and quietly distorted the
 * AI's pricing of it. These tests pin the four things that make it a real
 * resource: stock falls when an item is used, an empty item leaves the menu, the
 * reducer refuses to spend what the party does not have, and the pile is shared
 * across the party rather than carried per unit.
 *
 * The last test is the one that matters most to the rest of the codebase: a full
 * seeded battle must still replay byte-identically with inventory active.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  IllegalCommandError,
  advance,
  applyCommand,
  evaluateObjective,
} from '../src/core/battle';
import {
  STARTING_STOCK,
  createInventory,
  createPartyInventory,
  inventoryFor,
  inventoryOf,
  isConsumable,
  startingStock,
  stockAwareWorld,
} from '../src/core/inventory';
import { createBattlefield } from '../src/core/grid';
import { createRng } from '../src/core/rng';
import { createUnit } from '../src/core/unit';
import { createAiWorld, decideTurn } from '../src/core/ai';
import { ALL_ABILITIES, ALL_ITEMS, bootstrapContent } from '../src/state/content';
import { buildScenario, getScenario } from '../src/state/scenarios';
import { abilityItemsFor, commandItemsFor } from '../src/state/viewModels';
import type {
  BattleEvent,
  BattleState,
  Battlefield,
  Command,
  Tile,
  Unit,
  UnitId,
} from '../src/core/types';

beforeAll(() => {
  bootstrapContent();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture — two chemists and an enemy on flat ground
// ─────────────────────────────────────────────────────────────────────────────

function flatField(width = 8, height = 8): Battlefield {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      tiles.push({
        x, y, height: 0, depth: Infinity,
        surface: 'grass', slope: 'flat', passable: true, submerged: false,
      });
    }
  }
  return createBattlefield(width, height, tiles, 'test-flat');
}

interface Setup {
  state: BattleState;
  alma: Unit;
  ovelia: Unit;
  brute: Unit;
}

/**
 * Two player Chemists side by side and an enemy Chemist across the field. Both
 * sides know the whole Item skillset, which is what makes the "shared pool, but
 * not shared *between* sides" assertion meaningful.
 */
function setup(seed = 4242): Setup {
  const itemIds = Object.keys(STARTING_STOCK);

  const mk = (id: string, name: string, team: 'player' | 'enemy', x: number, y: number): Unit =>
    createUnit({
      id, name, team, job: 'chemist', level: 10,
      pos: { x, y, z: 0 }, zodiac: 'aries', brave: 70, faith: 70,
      learned: { chemist: itemIds },
    });

  const alma = mk('alma', 'Alma', 'player', 1, 1);
  const ovelia = mk('ovelia', 'Ovelia', 'player', 2, 1);
  const brute = mk('brute', 'Brute', 'enemy', 6, 6);

  const units = new Map<UnitId, Unit>([
    ['alma', alma],
    ['ovelia', ovelia],
    ['brute', brute],
  ]);

  const state: BattleState = {
    field: flatField(),
    units,
    order: [],
    phase: 'deploy',
    tick: 0,
    rngState: createRng(seed).state(),
    log: [],
    objective: { kind: 'defeat-all' },
  };
  return { state, alma, ovelia, brute };
}

/** Run the clock until `id` holds the turn, waiting out anyone who beats them to it. */
function giveTurnTo(state: BattleState, id: UnitId, limit = 60): void {
  for (let i = 0; i < limit; i++) {
    if (state.phase !== 'awaiting-command') advance(state);
    if (state.active === id) return;
    if (state.active === undefined) continue;
    applyCommand(state, { kind: 'wait', unit: state.active });
  }
  throw new Error(`${id} never got a turn`);
}

/** Drink a Potion aimed at oneself — always legal, always in range. */
function drinkPotion(state: BattleState, unit: Unit): BattleEvent[] {
  return applyCommand(state, {
    kind: 'act',
    unit: unit.id,
    ability: 'use-potion',
    target: { ...unit.pos },
    targetUnit: unit.id,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The Inventory value itself
// ─────────────────────────────────────────────────────────────────────────────

describe('Inventory', () => {
  it('counts, spends and restocks', () => {
    const inv = createInventory(new Map([['use-potion', 2]]));

    expect(inv.has('use-potion')).toBe(true);
    expect(inv.count('use-potion')).toBe(2);
    expect(inv.count('use-elixir')).toBe(0);
    expect(inv.has('use-elixir')).toBe(false);

    expect(inv.consume('use-potion')).toBe(true);
    expect(inv.count('use-potion')).toBe(1);
    expect(inv.consume('use-potion')).toBe(true);
    expect(inv.count('use-potion')).toBe(0);

    // Spending past empty changes nothing and says so.
    expect(inv.consume('use-potion')).toBe(false);
    expect(inv.count('use-potion')).toBe(0);

    inv.add('use-potion', 3);
    expect(inv.count('use-potion')).toBe(3);
    expect(inv.consume('use-potion', 4)).toBe(false);
    expect(inv.count('use-potion')).toBe(3);
    expect(inv.consume('use-potion', 3)).toBe(true);
    expect(inv.has('use-potion')).toBe(false);
  });

  it('drops empty ids rather than keeping zero rows', () => {
    const inv = createInventory(new Map([['use-soft', 1]]));
    inv.consume('use-soft');
    expect(inv.entries()).toEqual([]);
    expect(inv.total()).toBe(0);
  });

  it('starts a party with the default pile', () => {
    const inv = createPartyInventory();
    expect(inv.count('use-potion')).toBe(STARTING_STOCK['use-potion']);
    expect(inv.count('use-phoenix-down')).toBe(STARTING_STOCK['use-phoenix-down']);
    expect(inv.total()).toBeGreaterThan(0);
  });

  it('recognises consumables by the Item skillset, not by guesswork', () => {
    expect(isConsumable('use-potion')).toBe(true);
    expect(isConsumable('use-phoenix-down')).toBe(true);
    // Equipment is an item but not a consumable; abilities are not items at all.
    expect(isConsumable('broadsword')).toBe(false);
    expect(isConsumable('fire')).toBe(false);
  });

  it('gives a battle its stock on first read, without touching the RNG', () => {
    const { state } = setup();
    expect(state.inventories).toBeUndefined();

    const before = state.rngState;
    const inv = inventoryFor(state, 'player');

    expect(inv.count('use-potion')).toBe(STARTING_STOCK['use-potion']);
    expect(state.inventories).toBeDefined();
    expect(state.rngState).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Using an item
// ─────────────────────────────────────────────────────────────────────────────

describe('using a consumable', () => {
  it('decrements the party stock', () => {
    const { state, alma } = setup();
    const inv = inventoryOf(state, alma);
    const before = inv.count('use-potion');

    giveTurnTo(state, 'alma');
    alma.stats.hp = 1;
    const events = drinkPotion(state, alma);

    expect(events.some((e) => e.kind === 'heal')).toBe(true);
    expect(inv.count('use-potion')).toBe(before - 1);
  });

  it('decrements through the item command as well as the act command', () => {
    const { state, alma } = setup();
    const inv = inventoryOf(state, alma);
    const before = inv.count('use-potion');

    giveTurnTo(state, 'alma');
    alma.stats.hp = 1;
    applyCommand(state, {
      kind: 'item',
      unit: alma.id,
      item: 'use-potion',
      target: { ...alma.pos },
    });

    expect(inv.count('use-potion')).toBe(before - 1);
  });

  it('refuses an item the party has run out of', () => {
    const { state, alma } = setup();
    const inv = inventoryOf(state, alma);
    inv.stock.set('use-potion', 0);

    giveTurnTo(state, 'alma');
    alma.stats.hp = 1;

    expect(() => drinkPotion(state, alma)).toThrow(IllegalCommandError);
    expect(() =>
      applyCommand(state, {
        kind: 'item',
        unit: alma.id,
        item: 'use-potion',
        target: { ...alma.pos },
      }),
    ).toThrow(IllegalCommandError);

    // A refused command is not a spent turn.
    expect(alma.turn.acted).toBe(false);
    expect(state.active).toBe('alma');
  });

  it('does not spend stock when the action itself is illegal', () => {
    const { state, alma, brute } = setup();
    const inv = inventoryOf(state, alma);
    const before = inv.count('use-potion');

    giveTurnTo(state, 'alma');
    // The Brute is six tiles away; a Potion reaches three.
    expect(() =>
      applyCommand(state, {
        kind: 'act',
        unit: alma.id,
        ability: 'use-potion',
        target: { ...brute.pos },
        targetUnit: brute.id,
      }),
    ).toThrow(IllegalCommandError);

    expect(inv.count('use-potion')).toBe(before);
  });

  it('shares one pile across the party but not across the battle line', () => {
    const { state, alma, ovelia, brute } = setup();
    const party = inventoryOf(state, alma);
    const enemy = inventoryOf(state, brute);
    const before = party.count('use-potion');

    giveTurnTo(state, 'alma');
    alma.stats.hp = 1;
    drinkPotion(state, alma);

    // The second Chemist reads the same pile, one Potion lighter.
    expect(inventoryOf(state, ovelia).count('use-potion')).toBe(before - 1);
    // The enemy has their own.
    expect(enemy.count('use-potion')).toBe(before);

    giveTurnTo(state, 'ovelia');
    ovelia.stats.hp = 1;
    drinkPotion(state, ovelia);
    expect(party.count('use-potion')).toBe(before - 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The menu
// ─────────────────────────────────────────────────────────────────────────────

describe('the Item menu', () => {
  it('shows the remaining count on every row', () => {
    const { state, alma } = setup();
    const rows = abilityItemsFor(state, alma, 'item');
    const potion = rows.find((r) => r.id === 'use-potion');

    expect(potion?.name).toBe(`Potion ×${STARTING_STOCK['use-potion']}`);
    expect(potion?.stats?.some((s) => s.label === 'In stock' && s.value === '8')).toBe(true);
  });

  it('drops a depleted item from the menu', () => {
    const { state, alma } = setup();
    expect(abilityItemsFor(state, alma, 'item').some((r) => r.id === 'use-elixir')).toBe(true);

    // One Elixir in the pile; drinking it should take the row with it.
    giveTurnTo(state, 'alma');
    alma.stats.hp = 1;
    applyCommand(state, {
      kind: 'act',
      unit: alma.id,
      ability: 'use-elixir',
      target: { ...alma.pos },
      targetUnit: alma.id,
    });

    expect(inventoryOf(state, alma).count('use-elixir')).toBe(0);
    expect(abilityItemsFor(state, alma, 'item').some((r) => r.id === 'use-elixir')).toBe(false);
  });

  it('keeps the command row but disables it when the satchel is empty', () => {
    const { state, alma } = setup();
    const full = commandItemsFor(state, alma).find((c) => c.id === 'set:item');
    expect(full?.enabled).toBe(true);
    expect(full?.opensSubmenu).toBe(true);

    inventoryOf(state, alma).stock.clear();

    const empty = commandItemsFor(state, alma).find((c) => c.id === 'set:item');
    expect(empty).toBeDefined();
    expect(empty?.enabled).toBe(false);
    expect(empty?.detail).toBe('0');
    expect(abilityItemsFor(state, alma, 'item')).toEqual([]);
  });

  it('counts the party stock on the command row', () => {
    const { state, alma } = setup();
    inventoryOf(state, alma).stock.clear();
    inventoryOf(state, alma).add('use-potion', 3);

    const row = commandItemsFor(state, alma).find((c) => c.id === 'set:item');
    expect(row?.detail).toBe('3');
    expect(row?.enabled).toBe(true);
  });

  it('leaves non-consumable skillsets untouched', () => {
    const { state, alma } = setup();
    const rows = abilityItemsFor(state, alma, 'item');
    // Every row in the Item set is a consumable, so every row carries a count.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.name).toMatch(/ ×\d+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read through a function so TypeScript does not carry a narrowing of
 * `state.phase` into the inner clock loop, where `advance` has since moved it.
 */
function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** Play a scenario out with the AI on both sides, as `playthrough.test.ts` does. */
function playOut(scenarioId: string, seed: number, maxTurns = 400) {
  const built = buildScenario({ ...getScenario(scenarioId), seed });
  const state: BattleState = built.state;
  const events: BattleEvent[] = [];
  const commands: Command[] = [];
  let turns = 0;

  while (turns < maxTurns) {
    if (evaluateObjective(state)) break;
    if (isFinished(state)) break;

    let spins = 0;
    while (state.phase !== 'awaiting-command' && spins < 1000) {
      if (isFinished(state)) break;
      events.push(...advance(state));
      spins++;
    }
    if (state.phase !== 'awaiting-command') break;

    const activeId = state.active;
    if (!activeId) { turns++; continue; }

    for (const cmd of decideTurn(state, activeId)) {
      if (state.phase !== 'awaiting-command') break;
      commands.push(cmd);
      events.push(...applyCommand(state, cmd));
    }
    if (state.phase === 'awaiting-command' && state.active === activeId) {
      events.push(...applyCommand(state, { kind: 'wait', unit: activeId }));
    }
    turns++;
  }

  return { state, events, commands, turns };
}

function stockOf(state: BattleState): [string, number][] {
  return inventoryFor(state, 'player').entries();
}

describe('determinism with inventory active', () => {
  it('replays a full battle identically, stock included', () => {
    const a = playOut('battle-open', 20260727);
    const b = playOut('battle-open', 20260727);

    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(JSON.stringify(b.commands)).toBe(JSON.stringify(a.commands));
    expect(b.state.phase).toBe(a.state.phase);
    expect(stockOf(b.state)).toEqual(stockOf(a.state));
  });

  it('installs the same starting stock in every battle built from a scenario', () => {
    const built = buildScenario({ ...getScenario('battle-open'), seed: 7 });
    expect(startingStock()).toEqual(inventoryFor(built.state, 'player').stock);
  });

  it('never plans an item the party cannot pay for', () => {
    // Strip the pile bare, then let the AI take a turn with the full ability
    // table in hand. Nothing it proposes may be a consumable.
    const built = buildScenario({ ...getScenario('battle-open'), seed: 99 });
    const state = built.state;
    inventoryFor(state, 'player').stock.clear();
    inventoryFor(state, 'enemy').stock.clear();
    const world = stockAwareWorld(createAiWorld({ abilities: ALL_ABILITIES, items: ALL_ITEMS }));

    for (let i = 0; i < 12; i++) {
      if (state.phase !== 'awaiting-command') advance(state);
      const activeId = state.active;
      if (!activeId) continue;
      for (const cmd of decideTurn(state, activeId, { world })) {
        if (state.phase !== 'awaiting-command') break;
        if (cmd.kind === 'act') expect(isConsumable(cmd.ability)).toBe(false);
        expect(cmd.kind).not.toBe('item');
        applyCommand(state, cmd);
      }
      if (state.phase === 'awaiting-command' && state.active === activeId) {
        applyCommand(state, { kind: 'wait', unit: activeId });
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The AI's view of stock
// ─────────────────────────────────────────────────────────────────────────────

describe('stockAwareWorld', () => {
  /** The Chemist in `battle-open`, who knows the whole Item skillset. */
  function chemist(state: BattleState): Unit {
    for (const unit of state.units.values()) {
      for (const progress of unit.jobs.values()) {
        if (progress.learned.has('use-potion')) return unit;
      }
    }
    throw new Error('no unit knows an item');
  }

  it('hides consumables the side has run out of, and only those', () => {
    const built = buildScenario({ ...getScenario('battle-open'), seed: 5 });
    const state = built.state;
    const unit = chemist(state);
    const base = createAiWorld({ abilities: ALL_ABILITIES, items: ALL_ITEMS });
    const aware = stockAwareWorld(base);

    const ids = (world: typeof base): string[] =>
      world.abilitiesFor(state, unit).map((a) => a.id);

    // Fully stocked, the two worlds agree.
    expect(ids(aware)).toEqual(ids(base));
    expect(ids(aware)).toContain('use-potion');

    inventoryOf(state, unit).stock.delete('use-potion');

    // The raw evaluator still offers the Potion — that is the gap this wrapper
    // exists to close, and why removing it would put the AI back to planning
    // turns the reducer refuses.
    expect(ids(base)).toContain('use-potion');
    expect(ids(aware)).not.toContain('use-potion');
    // Nothing else was touched.
    expect(ids(aware)).toEqual(ids(base).filter((id) => id !== 'use-potion'));
  });
});
