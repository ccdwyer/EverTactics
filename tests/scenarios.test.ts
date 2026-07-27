/**
 * Integration tests for the app layer: content registration, scenario building,
 * and the core loop the renderer drives (advance → command → events).
 *
 * These are the tests that would have caught the contract mismatches between the
 * parallel subsystems — a job whose learnable list points at abilities that do
 * not exist, a unit placed on an impassable tile, an AI that emits a command the
 * reducer rejects.
 */

import { describe, expect, it } from 'vitest';

import { decideTurn } from '../src/core/ai';
import { advance, applyCommand } from '../src/core/battle';
import { getAbility } from '../src/core/unit';
import { allJobs } from '../src/core/jobs';
import { reachableDestinations, pathTo, buildOccupancy } from '../src/core/grid';
import { ALL_ABILITIES, ATTACK, bootstrapContent } from '../src/state/content';
import { jobActions, jobSkillset } from '../src/state/abilityIndex';
import { SCENARIOS, buildScenario, getScenario } from '../src/state/scenarios';
import { commandItemsFor, unitVM, turnOrderVM } from '../src/state/viewModels';
import type { BattleState, Command } from '../src/core/types';

bootstrapContent();

describe('content registry', () => {
  it('registers every job, ability and item into core', () => {
    expect(getAbility('attack')).toBeDefined();
    expect(getAbility('fire')).toBeDefined();
    expect(getAbility('use-potion')).toBeDefined();
    expect(ALL_ABILITIES.get(ATTACK.id)).toBe(ATTACK);
  });

  it('gives every job a non-empty, fully resolvable skillset', () => {
    for (const job of allJobs()) {
      const skills = jobSkillset(job);
      expect(skills.length, `${job.id} has no learnable abilities`).toBeGreaterThan(0);
      for (const skill of skills) {
        expect(getAbility(skill.ability.id), `${job.id} → ${skill.ability.id}`).toBeDefined();
      }
      expect(jobActions(job).length, `${job.id} has no action abilities`).toBeGreaterThan(0);
    }
  });

  it('resolves every sprite sheet a job names to a real file stem', () => {
    for (const job of allJobs()) {
      expect(job.sprite.male).toMatch(/^\d+_[A-Za-z_0-9]+_hd$/);
      expect(job.sprite.female).toMatch(/^\d+_[A-Za-z_0-9]+_hd$/);
    }
  });
});

describe('scenarios', () => {
  it('builds every registered scenario', () => {
    for (const id of Object.keys(SCENARIOS)) {
      const built = buildScenario(getScenario(id));
      expect(built.state.field.width).toBeGreaterThan(0);
      for (const unit of built.state.units.values()) {
        const tile = built.state.field.tileAt(unit.pos.x, unit.pos.y);
        expect(tile, `${id}: ${unit.name} is off the map`).toBeDefined();
        expect(tile?.passable, `${id}: ${unit.name} is inside a wall`).toBe(true);
        expect(unit.pos.z, `${id}: ${unit.name} is not standing on the surface`).toBe(tile?.height);
        expect(unit.stats.hp).toBeGreaterThan(0);
        expect(unit.stats.hp).toBe(unit.stats.maxHp);
      }
    }
  });

  it('places twelve units on distinct tiles across several elevations', () => {
    const { state } = buildScenario(getScenario('battle-open'));
    expect(state.units.size).toBe(12);
    const cells = new Set([...state.units.values()].map((u) => `${u.pos.x},${u.pos.y}`));
    expect(cells.size).toBe(12);
    const heights = new Set([...state.units.values()].map((u) => u.pos.z));
    expect(heights.size).toBeGreaterThanOrEqual(3);
  });

  it('gives every unit a populated command menu', () => {
    const { state } = buildScenario(getScenario('battle-open'));
    for (const unit of state.units.values()) {
      const items = commandItemsFor(state, unit);
      expect(items.some((i) => i.id === 'move'), `${unit.name} cannot move`).toBe(true);
      expect(items.some((i) => i.id === 'attack'), `${unit.name} cannot attack`).toBe(true);
      const primary = items.find((i) => i.id.startsWith('set:'));
      expect(primary, `${unit.name} has no primary skillset`).toBeDefined();
      expect(primary?.enabled).toBe(true);
    }
  });

  it('produces view models the UI can render', () => {
    const { state } = buildScenario(getScenario('battle-open'));
    advance(state);
    const active = state.units.get(state.active ?? '');
    expect(active).toBeDefined();
    const vm = unitVM(state, active!);
    expect(vm.maxHp).toBeGreaterThan(0);
    expect(vm.job.length).toBeGreaterThan(0);
    expect(vm.portrait).toBeTruthy();
    const order = turnOrderVM(state);
    expect(order.length).toBeGreaterThan(0);
    expect(order[0]?.current).toBe(true);
  });
});

describe('the loop', () => {
  function firstTurn(): BattleState {
    const { state } = buildScenario(getScenario('battle-open'));
    advance(state);
    return state;
  }

  it('reaches a first turn and hands it to a real unit', () => {
    const state = firstTurn();
    expect(state.phase).toBe('awaiting-command');
    expect(state.active).toBeDefined();
    expect(state.units.get(state.active!)).toBeDefined();
  });

  it('accepts a move built from grid.pathTo', () => {
    const state = firstTurn();
    const unit = state.units.get(state.active!)!;
    const occupied = buildOccupancy(state.units.values());
    const destinations = [...reachableDestinations(state.field, unit, occupied).values()];
    expect(destinations.length).toBeGreaterThan(1);
    const target = destinations.find((d) => d.pos.x !== unit.pos.x || d.pos.y !== unit.pos.y)!.pos;
    const path = pathTo(state.field, unit, occupied, target);
    expect(path.length).toBeGreaterThan(1);
    const events = applyCommand(state, { kind: 'move', unit: unit.id, path });
    expect(events.some((e) => e.kind === 'moved')).toBe(true);
    expect(unit.pos.x).toBe(target.x);
  });

  it('runs twenty AI turns without the reducer rejecting a command', () => {
    const { state, personalities } = buildScenario(getScenario('battle-open'));
    for (let i = 0; i < 20; i++) {
      advance(state);
      if (state.phase === 'victory' || state.phase === 'defeat') break;
      const id = state.active;
      if (id === undefined) break;
      const commands: Command[] = decideTurn(state, id, {
        abilities: ALL_ABILITIES,
        personalities,
      });
      expect(commands.length, 'AI produced no commands').toBeGreaterThan(0);
      for (const command of commands) {
        if (state.active !== id) break; // the turn ended early (charge, KO)
        applyCommand(state, command);
      }
    }
    expect(state.tick).toBeGreaterThan(0);
  });

  it('replays identically from the same seed', () => {
    const run = (): string => {
      const { state, personalities } = buildScenario(getScenario('battle-open'));
      const log: string[] = [];
      for (let i = 0; i < 12; i++) {
        log.push(...advance(state).map((e) => e.kind));
        const id = state.active;
        if (id === undefined) break;
        for (const command of decideTurn(state, id, { abilities: ALL_ABILITIES, personalities })) {
          if (state.active !== id) break;
          log.push(...applyCommand(state, command).map((e) => e.kind));
        }
      }
      return log.join(',');
    };
    expect(run()).toBe(run());
  });
});
