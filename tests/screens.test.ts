/**
 * View models for the full-screen panels.
 *
 * These assert the job screen tells the truth: every job present with the right
 * lock state, learnables priced from the job table the JP is actually charged
 * against, and a job change that really moves the derived stat line.
 */

import { describe, expect, it } from 'vitest';

import { allJobs, getJob } from '../src/core/jobs';
import { jobLevelOf, unlockStatus } from '../src/core/jobs/tree';
import { canSwitchToJob } from '../src/core/party';
import { createCampaign, unitToPersisted } from '../src/core/campaign';
import { deriveStats, gainJp, jobProgress, learnAbility, setJob } from '../src/core/unit';
import { bootstrapContent } from '../src/state/content';
import { buildScenario, getScenario } from '../src/state/scenarios';
import {
  abilitySlotVMs,
  campaignFormationScreenVM,
  formationScreenVM,
  jobNodeVMs,
  jobScreenVM,
  jobTier,
  learnableVMs,
  recruitScreenVM,
  rosterScreenVM,
} from '../src/state/screens';
import type { BattleState, Unit } from '../src/core/types';
import { WORLD_NODES } from '../src/core/world';

bootstrapContent();

function battle(): BattleState {
  return buildScenario(getScenario('battle-open')).state;
}

function player(state: BattleState, id = 'p-aldric'): Unit {
  const unit = state.units.get(id);
  if (!unit) throw new Error(`missing test unit ${id}`);
  return unit;
}

describe('job tree geometry', () => {
  it('places every prerequisite in a strictly lower tier', () => {
    for (const job of allJobs()) {
      for (const req of job.requires) {
        expect(jobTier(req.job), `${job.id} <- ${req.job}`).toBeLessThan(jobTier(job.id));
      }
    }
  });

  it('puts the starting jobs at the root', () => {
    expect(jobTier('squire')).toBe(0);
    expect(jobTier('chemist')).toBe(0);
  });
});

describe('recruitment and grown-company view models', () => {
  it('shows three stable candidates, live terms, and the explicit roster cap', () => {
    const state = battle();
    const campaign = createCampaign(77, 1_000);
    campaign.roster = [...state.units.values()]
      .filter((unit) => unit.team === 'player')
      .map(unitToPersisted);
    campaign.gil = 5_000;
    const town = WORLD_NODES.find((node) => node.id === 'gariland-camp')!;

    const first = recruitScreenVM(campaign, {
      nodeId: town.id,
      townName: town.name,
    });
    const second = recruitScreenVM(campaign, {
      nodeId: town.id,
      townName: town.name,
    });

    expect(first.offers).toHaveLength(3);
    expect(second.offers).toEqual(first.offers);
    expect(first.rosterCap).toBe(16);
    expect(first.rosterCount).toBe(campaign.roster.length);
    expect(first.unavailableReason).toBeUndefined();
    expect(first.jobs.male.some((job) => job.id === 'squire')).toBe(true);
    expect(first.jobs.female.some((job) => job.id === 'chemist')).toBe(true);

    while (campaign.roster.length < 16) {
      const base = campaign.roster[0]!;
      campaign.roster.push({
        ...base,
        id: `bench-${campaign.roster.length}`,
        name: `Bench ${campaign.roster.length}`,
      });
    }
    const full = recruitScreenVM(campaign, {
      nodeId: town.id,
      townName: town.name,
    });
    expect(full.unavailableReason).toBe(
      'Roster full (16/16). Dismiss a unit before hiring.',
    );
  });

  it('lists a seven-member roster while keeping deployment to authored slots', () => {
    const state = battle();
    const campaign = createCampaign(88, 1_000);
    campaign.roster = [...state.units.values()]
      .filter((unit) => unit.team === 'player')
      .map(unitToPersisted);
    const base = campaign.roster[0]!;
    campaign.roster.push({ ...base, id: 'recruit:bench', name: 'New Recruit' });
    campaign.formation = campaign.roster.slice(0, 4).map((unit, startIndex) => ({
      unitId: unit.id,
      startIndex,
    }));

    const vm = campaignFormationScreenVM(campaign, {
      startTiles: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
        { x: 3, y: 0 },
      ],
    });

    expect(vm.roster).toHaveLength(7);
    expect(vm.slots).toHaveLength(4);
    expect(vm.maxDeployed).toBe(4);
    expect(vm.slots.filter((slot) => slot.unitId !== undefined)).toHaveLength(4);
  });
});

describe('jobNodeVMs', () => {
  it('lists every job in the registry exactly once', () => {
    const nodes = jobNodeVMs(player(battle()));
    expect(nodes).toHaveLength(allJobs().length);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    for (const job of allJobs()) {
      expect(nodes.some((n) => n.id === job.id), job.id).toBe(true);
    }
  });

  it('agrees with core about which jobs are unlocked', () => {
    const unit = player(battle());
    // Same UnlockContext must flow into both predicates (kills/gender gates).
    const ctx = { kills: 0 };
    for (const node of jobNodeVMs(unit, ctx)) {
      // UI predicate and mutation gate must share canSwitchToJob (unlockStatus + held).
      expect(node.unlocked, node.id).toBe(canSwitchToJob(unit, node.id, ctx));
    }
  });

  it('marks exactly one node current without bypassing unlockStatus', () => {
    const unit = player(battle());
    const nodes = jobNodeVMs(unit);
    const current = nodes.filter((n) => n.current);
    expect(current).toHaveLength(1);
    expect(current[0]?.id).toBe(unit.currentJob);
    expect(current[0]?.unlocked).toBe(unlockStatus(unit, unit.currentJob).unlocked);
  });

  it('names the missing prerequisites of a locked job', () => {
    const unit = player(battle());
    const locked = jobNodeVMs(unit).find((n) => !n.unlocked && n.parents.length > 0);
    expect(locked, 'no locked job on a level-14 unit').toBeDefined();
    expect(locked?.requirement).toBeTruthy();
    // The requirement names a real job the unit has not levelled.
    const parentNames = locked?.parents.map((p) => getJob(p).name) ?? [];
    expect(parentNames.some((name) => locked?.requirement?.includes(name))).toBe(true);
  });

  it("reports the unit's real JP and job level in its own job", () => {
    const state = battle();
    const unit = player(state);
    const progress = jobProgress(unit, unit.currentJob);
    const node = jobNodeVMs(unit).find((n) => n.current);
    expect(node?.jp).toBe(progress.jp);
    expect(node?.totalJp).toBe(progress.totalJp);
    expect(node?.jobLevel).toBe(jobLevelOf(unit, unit.currentJob));
    expect(progress.jp).toBeGreaterThan(0);
  });

  it('counts learned abilities against the job table', () => {
    const unit = player(battle());
    const node = jobNodeVMs(unit).find((n) => n.current);
    const job = getJob(unit.currentJob);
    expect(node?.learnable).toBe(job.learnable.length);
    expect(node?.learned).toBeGreaterThan(0);
    expect(node?.learned).toBeLessThanOrEqual(node?.learnable ?? 0);
  });
});

describe('learnableVMs', () => {
  it('prices every entry from the job table', () => {
    const unit = player(battle());
    const job = getJob(unit.currentJob);
    for (const vm of learnableVMs(unit, unit.currentJob)) {
      const entry = job.learnable.find((l) => l.ability === vm.id);
      expect(entry, vm.id).toBeDefined();
      expect(vm.jp).toBe(entry?.jp);
    }
  });

  it('reflects what the unit has already learned', () => {
    const unit = player(battle());
    const learned = jobProgress(unit, unit.currentJob).learned;
    for (const vm of learnableVMs(unit, unit.currentJob)) {
      expect(vm.learned, vm.id).toBe(learned.has(vm.id));
      // A learned ability is never offered for purchase again.
      if (vm.learned) expect(vm.affordable).toBe(false);
    }
  });

  it('marks an ability unaffordable when the balance is short', () => {
    // A job the unit has never entered: nothing learned, no JP banked.
    const unit = player(battle(), 'p-nessa');
    const progress = jobProgress(unit, 'knight');
    const unlearned = learnableVMs(unit, 'knight').filter((v) => !v.learned);
    expect(unlearned.length, 'nothing left to learn').toBeGreaterThan(0);
    for (const vm of learnableVMs(unit, 'knight')) {
      expect(vm.affordable, vm.id).toBe(false);
    }

    const target = unlearned[0];
    if (!target) throw new Error('unreachable');
    // One JP short is still unaffordable; the exact price is not.
    progress.jp = target.jp - 1;
    expect(learnableVMs(unit, 'knight').find((v) => v.id === target.id)?.affordable).toBe(false);
    progress.jp = target.jp;
    expect(learnableVMs(unit, 'knight').find((v) => v.id === target.id)?.affordable).toBe(true);

    // And the price the screen quoted is the price core charges.
    expect(learnAbility(unit, target.id, 'knight')).toEqual({ learned: true, cost: target.jp });
    expect(progress.jp).toBe(0);
    const after = learnableVMs(unit, 'knight').find((v) => v.id === target.id);
    expect(after?.learned).toBe(true);
    expect(after?.affordable).toBe(false);
  });

  it('is empty for an unknown job id', () => {
    expect(learnableVMs(player(battle()), 'no-such-job')).toEqual([]);
  });
});

describe('abilitySlotVMs', () => {
  it("reports the four loadout slots with the unit's current assignments", () => {
    const unit = player(battle());
    const slots = abilitySlotVMs(unit);
    expect(slots.map((s) => s.slot)).toEqual(['secondary', 'reaction', 'support', 'movement']);
    expect(slots[0]?.assignedId).toBe(unit.secondaryAction);
    expect(slots[1]?.assignedId).toBe(unit.reaction);
    expect(slots[2]?.assignedId).toBe(unit.support);
    expect(slots[3]?.assignedId).toBe(unit.movement);
    for (const slot of slots) {
      expect(slot.label.length).toBeGreaterThan(0);
      if (slot.assignedId) {
        expect(slot.options.some((o) => o.id === slot.assignedId), slot.slot).toBe(true);
      }
    }
  });

  it('never offers the unit its own job as a secondary command', () => {
    const unit = player(battle());
    const own = getJob(unit.currentJob).actionSet;
    const secondary = abilitySlotVMs(unit)[0];
    expect(secondary?.options.some((o) => o.id === own)).toBe(false);
  });
});

describe('jobScreenVM', () => {
  it("defaults the selection to the unit's own job", () => {
    const state = battle();
    const unit = player(state);
    const vm = jobScreenVM(state, unit);
    expect(vm.selectedJob).toBe(unit.currentJob);
    expect(vm.unit.id).toBe(unit.id);
    expect(vm.unit.job).toBe(getJob(unit.currentJob).name);
    expect(vm.learnables.length).toBeGreaterThan(0);
  });

  it('follows the tree cursor onto another job', () => {
    const state = battle();
    const unit = player(state);
    const vm = jobScreenVM(state, unit, 'black-mage');
    expect(vm.selectedJob).toBe('black-mage');
    const ids = new Set(getJob('black-mage').learnable.map((l) => l.ability));
    for (const l of vm.learnables) expect(ids.has(l.id)).toBe(true);
  });

  it('falls back to the current job for a bogus selection', () => {
    const state = battle();
    const unit = player(state);
    expect(jobScreenVM(state, unit, 'not-a-job').selectedJob).toBe(unit.currentJob);
  });
});

describe('changing job', () => {
  it('moves the derived stat line, Move/Jump and the sprite', () => {
    const state = battle();
    const unit = player(state);
    const before = deriveStats(unit);
    const beforeSheet = unit.sprite.sheet;

    setJob(unit, 'black-mage');

    const after = deriveStats(unit);
    expect(unit.currentJob).toBe('black-mage');
    expect(unit.sprite.sheet).not.toBe(beforeSheet);
    expect(after.maxMp).not.toBe(before.maxMp);
    expect(after.move).toBe(getJob('black-mage').move);
    expect(after.jump).toBe(getJob('black-mage').jump);

    // And the screen reports the change without being told about it.
    const vm = jobScreenVM(state, unit);
    expect(vm.selectedJob).toBe('black-mage');
    expect(vm.unit.job).toBe(getJob('black-mage').name);
    expect(vm.unit.move).toBe(after.move);
    expect(vm.jobs.find((n) => n.current)?.id).toBe('black-mage');
    // The job menu keeps using the same canonical predicate after a job change.
    const vmAfter = jobScreenVM(state, unit);
    const knight = vmAfter.jobs.find((n) => n.id === 'knight');
    const knightStatus = unlockStatus(unit, 'knight');
    expect(knight?.unlocked).toBe(knightStatus.unlocked);
    expect(knight?.requirement === undefined).toBe(knightStatus.unlocked);
  });

  it('unlocks a job once its prerequisite is levelled', () => {
    const state = battle();
    const unit = player(state);
    expect(jobNodeVMs(unit).find((n) => n.id === 'knight')?.unlocked).toBe(
      unlockStatus(unit, 'knight').unlocked,
    );

    const nessa = player(state, 'p-nessa');
    const monkBefore = jobNodeVMs(nessa).find((n) => n.id === 'monk');
    expect(monkBefore?.unlocked).toBe(false);
    expect(monkBefore?.requirement).toContain('Knight');

    // Knight Lv 2 is 100 lifetime JP.
    gainJp(nessa, 2000, 'knight');
    const monkAfter = jobNodeVMs(nessa).find((n) => n.id === 'monk');
    expect(monkAfter?.unlocked).toBe(true);
    expect(monkAfter?.requirement).toBeUndefined();
  });
});

describe('roster and formation', () => {
  it('lists the whole player party with live HP', () => {
    const state = battle();
    const vm = rosterScreenVM(state, { gil: 1200 });
    const party = [...state.units.values()].filter((u) => u.team === 'player');
    expect(vm.units).toHaveLength(party.length);
    expect(vm.gil).toBe(1200);
    for (const u of vm.units) {
      expect(u.maxHp).toBeGreaterThan(0);
      expect(vm.notes?.[u.id]).toMatch(/JP/);
    }
  });

  it('reports one locked slate cell per deployed unit', () => {
    const state = battle();
    const vm = formationScreenVM(state);
    const party = [...state.units.values()].filter((u) => u.team === 'player');
    const filled = vm.slots.filter((s) => s.unitId !== undefined);
    expect(filled).toHaveLength(party.length);
    expect(vm.slots.every((s) => s.locked === true)).toBe(true);
    for (const slot of filled) expect(slot.tile).toMatch(/^[A-Z]\d+$/);
    expect(vm.maxDeployed).toBeGreaterThanOrEqual(party.length);
  });
});
