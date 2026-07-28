/**
 * Party management — formation, equip, job spend, rename/dismiss.
 *
 * Asserts the behaviour the v0.1 step-2 brief requires, not whatever the
 * implementation happens to do today. Each case is written from the brief;
 * fixtures are not pre-sorted or relaxed to hide a broken contract.
 */
import { describe, expect, it } from 'vitest';

import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import {
  battleToCampaign,
  createCampaign,
  deserialize,
  serialize,
  unitFromPersisted,
  type CampaignState,
  type PersistedUnit,
} from '../src/core/campaign';
import {
  applyResolution,
  type AbilityResolution,
} from '../src/core/combat/formulas';
import { applyStatus } from '../src/core/combat/status';
import { getMapDef } from '../src/core/grid';
import {
  assignAbilitySlot,
  canEquipItem,
  canSwitchToJob,
  changeJob,
  derivedStatsOf,
  dismissUnit,
  equipItem,
  renameUnit,
  setFormation,
  setFormationByTiles,
  spendJpToLearn,
  unequipItem,
} from '../src/core/party';
import {
  equipmentMods,
  getJob,
  jobUnlocked,
  reconcileGearStatuses,
} from '../src/core/unit';
import { bootstrapContent } from '../src/state/content';
import {
  dispatchPartyIntent,
  type PartyMutationIntent,
} from '../src/state/partyEdit';
import {
  campaignToBattle,
  getScenario,
  newGameCampaign,
  STARTER_CAMPAIGN_INVENTORY,
} from '../src/state/scenarios';
import { jobNodeVMs } from '../src/state/screens';

bootstrapContent();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — minimal, intentional. Never pre-sorted to dodge a mutation check.
// ─────────────────────────────────────────────────────────────────────────────

function unit(
  overrides: Partial<PersistedUnit> & Pick<PersistedUnit, 'id' | 'name' | 'currentJob'>,
): PersistedUnit {
  const job = overrides.currentJob;
  const { jobs: jobOverrides, ...rest } = overrides;
  return {
    gender: 'male',
    zodiac: 'aries',
    level: 5,
    exp: 0,
    totalExp: 0,
    equipment: {},
    raw: { hp: 120, mp: 50, pa: 10, ma: 8, spd: 8 },
    brave: 70,
    faith: 70,
    ...rest,
    // Squire banked so basic prereqs stay reachable; overrides.jobs win on conflict.
    jobs: {
      squire: { level: 2, jp: 100, totalJp: 200, learned: [] },
      [job]: { level: 2, jp: 500, totalJp: 600, learned: [] },
      ...jobOverrides,
    },
  };
}

function campaignOf(
  roster: PersistedUnit[],
  inventory: Record<string, number> = {},
  seed = 1,
): CampaignState {
  const c = createCampaign(seed, 1_000);
  c.roster = roster;
  c.inventory = { ...inventory };
  c.gil = 500;
  return c;
}

/** Round-trip through serialize/deserialize — the brief's persistence gate. */
function roundTrip(c: CampaignState): CampaignState {
  return deserialize(serialize(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// Formation
// ─────────────────────────────────────────────────────────────────────────────

describe('formation', () => {
  const roster = [
    unit({ id: 'a', name: 'Aldric', currentJob: 'knight' }),
    unit({ id: 'b', name: 'Bran', currentJob: 'archer' }),
    unit({ id: 'c', name: 'Cora', currentJob: 'black-mage' }),
    unit({ id: 'd', name: 'Dara', currentJob: 'white-mage' }),
  ];

  it('enforces the deploy limit — over the limit is rejected', () => {
    const c = campaignOf(roster);
    const result = setFormation(
      c,
      [
        { unitId: 'a', startIndex: 0 },
        { unitId: 'b', startIndex: 1 },
        { unitId: 'c', startIndex: 2 },
      ],
      { startTileCount: 4, maxDeployed: 2, timestamp: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('over-limit');
    // Campaign must be untouched on failure.
    expect(c.formation).toEqual([]);
  });

  it('rejects a duplicate start tile', () => {
    const c = campaignOf(roster);
    const result = setFormation(
      c,
      [
        { unitId: 'a', startIndex: 0 },
        { unitId: 'b', startIndex: 0 },
      ],
      { startTileCount: 4, maxDeployed: 4, timestamp: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('duplicate-tile');
  });

  it('rejects a tile that is not a legal start', () => {
    const c = campaignOf(roster);
    // startIndex 9 is outside [0, 4)
    const byIndex = setFormation(
      c,
      [{ unitId: 'a', startIndex: 9 }],
      { startTileCount: 4, maxDeployed: 4, timestamp: 10 },
    );
    expect(byIndex.ok).toBe(false);
    if (!byIndex.ok) expect(byIndex.reason).toBe('illegal-tile');

    const byTile = setFormationByTiles(
      c,
      [{ unitId: 'a', x: 99, y: 99 }],
      {
        startTiles: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        maxDeployed: 2,
        timestamp: 10,
      },
    );
    expect(byTile.ok).toBe(false);
    if (!byTile.ok) expect(byTile.reason).toBe('illegal-tile');
  });

  it('rejects deploying zero units', () => {
    const c = campaignOf(roster);
    const result = setFormation(c, [], {
      startTileCount: 4,
      maxDeployed: 4,
      timestamp: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('accepts a legal formation and persists it through serialize/deserialize', () => {
    const c = campaignOf(roster);
    const result = setFormation(
      c,
      [
        { unitId: 'c', startIndex: 1 },
        { unitId: 'a', startIndex: 0 },
      ],
      { startTileCount: 4, maxDeployed: 4, timestamp: 42 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Order is preserved as given — not silently re-sorted by roster order.
    expect(result.campaign.formation).toEqual([
      { unitId: 'c', startIndex: 1 },
      { unitId: 'a', startIndex: 0 },
    ]);
    expect(result.campaign.updatedAt).toBe(42);

    const restored = roundTrip(result.campaign);
    expect(restored.formation).toEqual(result.campaign.formation);

    // campaignToBattle places units on the map's legal playerStarts — not the
    // scenario cast's combat positions.
    const scenario = getScenario('battle-open');
    const mapStarts = getMapDef(scenario.mapId)!.playerStarts;
    expect(mapStarts.length).toBeGreaterThanOrEqual(2);
    // Guard: map starts must differ from the scenario cast positions so this
    // test would fail if placement silently fell back to scenario units.
    const castStarts = scenario.units
      .filter((u) => u.team === 'player')
      .map((u) => ({ x: u.at.x, y: u.at.y }));
    expect(
      mapStarts[0]!.x !== castStarts[0]?.x || mapStarts[0]!.y !== castStarts[0]?.y,
    ).toBe(true);

    const built = campaignToBattle(restored, scenario);
    const deployed = [...built.state.units.values()].filter((u) => u.team === 'player');
    expect(deployed.map((u) => u.id).sort()).toEqual(['a', 'c']);
    const unitA = built.state.units.get('a')!;
    const unitC = built.state.units.get('c')!;
    expect(unitA.pos.x).toBe(mapStarts[0]!.x);
    expect(unitA.pos.y).toBe(mapStarts[0]!.y);
    expect(unitC.pos.x).toBe(mapStarts[1]!.x);
    expect(unitC.pos.y).toBe(mapStarts[1]!.y);
    // Bench units stay out of the fight.
    expect(built.state.units.has('b')).toBe(false);
    expect(built.state.units.has('d')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Equip / unequip
// ─────────────────────────────────────────────────────────────────────────────

describe('equip and unequip', () => {
  it('equip moves the item out of inventory; unequip returns it', () => {
    const c = campaignOf(
      [unit({ id: 'k', name: 'Knight', currentJob: 'knight' })],
      { 'long-sword': 1, buckler: 1 },
    );

    const equipped = equipItem(c, 'k', 'long-sword', 20);
    expect(equipped.ok).toBe(true);
    if (!equipped.ok) throw new Error('unreachable');
    expect(equipped.campaign.inventory['long-sword']).toBeUndefined();
    expect(equipped.campaign.roster[0]!.equipment.rightHand).toBe('long-sword');
    // Unrelated inventory is untouched.
    expect(equipped.campaign.inventory.buckler).toBe(1);

    // Equipped state itself must survive serialize/deserialize — not only after unequip.
    const stillWorn = roundTrip(equipped.campaign);
    expect(stillWorn.roster[0]!.equipment.rightHand).toBe('long-sword');
    expect(stillWorn.inventory['long-sword']).toBeUndefined();
    expect(stillWorn.inventory.buckler).toBe(1);

    const stripped = unequipItem(stillWorn, 'k', 'rightHand', 21);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) throw new Error('unreachable');
    expect(stripped.campaign.roster[0]!.equipment.rightHand).toBeUndefined();
    expect(stripped.campaign.inventory['long-sword']).toBe(1);

    const restored = roundTrip(stripped.campaign);
    expect(restored.roster[0]!.equipment).toEqual({});
    expect(restored.inventory['long-sword']).toBe(1);
    expect(restored.inventory.buckler).toBe(1);
  });

  it("honours a job's equip restrictions", () => {
    // Black mage cannot equip swords natively; can equip rods.
    const mage = unit({ id: 'm', name: 'Mage', currentJob: 'black-mage' });
    const c = campaignOf([mage], { 'long-sword': 1, rod: 1 });

    const live = unitFromPersisted(mage, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(getJob('black-mage').equip.includes('sword')).toBe(false);
    expect(getJob('black-mage').equip.includes('rod')).toBe(true);
    expect(canEquipItem(live, 'long-sword')).toBe(false);
    expect(canEquipItem(live, 'rod')).toBe(true);

    const denied = equipItem(c, 'm', 'long-sword', 5);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('cannot-equip');
    // Inventory and unit unchanged on refusal.
    expect(c.inventory['long-sword']).toBe(1);
    expect(c.roster[0]!.equipment.rightHand).toBeUndefined();

    const allowed = equipItem(c, 'm', 'rod', 6);
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error('unreachable');
    expect(allowed.campaign.roster[0]!.equipment.rightHand).toBe('rod');
    expect(allowed.campaign.inventory.rod).toBeUndefined();
    // The rejected sword is still in stock.
    expect(allowed.campaign.inventory['long-sword']).toBe(1);
  });

  it('two-handed weapons clear the off-hand and return it to inventory', () => {
    const c = campaignOf(
      [
        unit({
          id: 'k',
          name: 'Knight',
          currentJob: 'knight',
          equipment: { rightHand: 'long-sword', leftHand: 'buckler' },
        }),
      ],
      { defender: 1 },
    );

    const result = equipItem(c, 'k', 'defender', 7);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.campaign.roster[0]!.equipment.rightHand).toBe('defender');
    expect(result.campaign.roster[0]!.equipment.leftHand).toBeUndefined();
    // Both displaced pieces return; defender leaves stock.
    expect(result.campaign.inventory['long-sword']).toBe(1);
    expect(result.campaign.inventory.buckler).toBe(1);
    expect(result.campaign.inventory.defender).toBeUndefined();
  });

  it('consumed potions stay gone when the battle folds back into the campaign', () => {
    // Brief: consume a Potion via applyCommand, end the battle through the same
    // evaluateObjective path the reducer uses, then battleToCampaign (what
    // Game.onBattleOver calls). No direct phase assignment, no HP hacking.
    const base = campaignOf(
      [
        unit({
          id: 'k',
          name: 'Knight',
          currentJob: 'chemist',
          jobs: {
            chemist: {
              level: 2,
              jp: 100,
              totalJp: 200,
              learned: ['use-potion'],
            },
          },
        }),
      ],
      { 'use-potion': 3, 'long-sword': 1 },
    );
    const formed = setFormation(base, [{ unitId: 'k', startIndex: 0 }], {
      startTileCount: 6,
      maxDeployed: 6,
      timestamp: 1,
    });
    expect(formed.ok).toBe(true);
    if (!formed.ok) throw new Error('unreachable');

    const scenario = getScenario('battle-open');
    const built = campaignToBattle(formed.campaign, scenario);
    const stockBefore = built.state.inventories?.get('player')?.get('use-potion') ?? 0;
    expect(stockBefore).toBe(3);

    // Run the clock until the player unit holds the turn, then drink a Potion
    // through the command reducer — stock falls whether or not HP was missing.
    for (let i = 0; i < 80; i++) {
      if (built.state.phase !== 'awaiting-command') advance(built.state);
      if (built.state.active === 'k') break;
      if (built.state.active === undefined) continue;
      applyCommand(built.state, { kind: 'wait', unit: built.state.active });
    }
    expect(built.state.active).toBe('k');
    const drinker = built.state.units.get('k')!;
    applyCommand(built.state, {
      kind: 'item',
      unit: 'k',
      item: 'use-potion',
      target: { ...drinker.pos },
    });
    expect(built.state.inventories?.get('player')?.get('use-potion')).toBe(2);

    // End the fight the way applyCommand does: KO every enemy, then
    // evaluateObjective (not `phase = 'victory'`).
    for (const u of built.state.units.values()) {
      if (u.team !== 'enemy') continue;
      u.stats.hp = 0;
      applyStatus(u, 'ko', { duration: 3 });
    }
    expect(evaluateObjective(built.state)).toBe(true);
    expect(built.state.phase).toBe('victory');

    // Same fold Game.onBattleOver uses.
    const written = battleToCampaign(formed.campaign, built.state, 99);
    expect(written.inventory['use-potion']).toBe(2);
    expect(written.inventory['long-sword']).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mid-battle edit gate — campaign only; live battle is read-only
// ─────────────────────────────────────────────────────────────────────────────

describe('party edit gate (mid-battle)', () => {
  it('refuses party UIIntents while a battle is live; allows them between battles', () => {
    // Production path: Game routes every equip / job / rename intent through
    // dispatchPartyIntent. Removing the live guard there must break this test.
    const c = campaignOf(
      [unit({ id: 'k', name: 'Knight', currentJob: 'knight' })],
      { 'long-sword': 1 },
    );
    const before = serialize(c);

    const intents: PartyMutationIntent[] = [
      { kind: 'equip-item', unitId: 'k', itemId: 'long-sword' },
      { kind: 'set-job', unitId: 'k', jobId: 'squire' },
      { kind: 'rename-unit', unitId: 'k', name: 'Hacked' },
      { kind: 'dismiss-unit', unitId: 'k' },
      { kind: 'learn-ability', unitId: 'k', jobId: 'knight', abilityId: 'counter' },
      {
        kind: 'formation-confirm',
      },
    ];

    for (const intent of intents) {
      const refused = dispatchPartyIntent(c, /* battleLive */ true, intent, {
        timestamp: 1,
        startTileCount: 4,
        maxDeployed: 4,
        formation: [{ unitId: 'k', startIndex: 0 }],
      });
      expect(refused.ok, intent.kind).toBe(false);
      if (!refused.ok) expect(refused.reason).toBe('battle-live');
    }
    // Campaign bytes untouched — the equip branch must not land inventory writes.
    expect(serialize(c)).toBe(before);
    expect(c.inventory['long-sword']).toBe(1);
    expect(c.roster[0]!.equipment.rightHand).toBeUndefined();
    expect(c.roster[0]!.name).toBe('Knight');

    // Same equip intent between battles succeeds and moves the item.
    const allowed = dispatchPartyIntent(
      c,
      /* battleLive */ false,
      { kind: 'equip-item', unitId: 'k', itemId: 'long-sword' },
      { timestamp: 2 },
    );
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) throw new Error('unreachable');
    expect(allowed.campaign.inventory['long-sword']).toBeUndefined();
    expect(allowed.campaign.roster[0]!.equipment.rightHand).toBe('long-sword');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Job screen — spend JP / change job
// ─────────────────────────────────────────────────────────────────────────────

describe('job screen actions', () => {
  it('learning an ability deducts JP and refuses when unaffordable', () => {
    // Pick a real knight learnable and price it from the job table — never hardcode
    // a cost the engine does not charge.
    const job = getJob('knight');
    const learnable = job.learnable.find((l) => l.jp > 0);
    if (!learnable) throw new Error('knight has no priced learnable — fixture broken');

    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          knight: {
            level: 2,
            jp: learnable.jp, // exact price — one point less must fail
            totalJp: learnable.jp + 100,
            learned: [],
          },
        },
      }),
    ]);

    // One short of the price: refuse, no mutation.
    const poor = createCampaign(1, 1);
    poor.roster = [
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          knight: {
            level: 2,
            jp: learnable.jp - 1,
            totalJp: learnable.jp + 100,
            learned: [],
          },
        },
      }),
    ];
    const unaffordable = spendJpToLearn(poor, 'k', 'knight', learnable.ability, 8);
    expect(unaffordable.ok).toBe(false);
    if (!unaffordable.ok) {
      expect(unaffordable.reason).toBe('learn-failed');
      expect(unaffordable.detail).toBe('insufficient-jp');
    }
    expect(poor.roster[0]!.jobs.knight!.jp).toBe(learnable.jp - 1);
    expect(poor.roster[0]!.jobs.knight!.learned).toEqual([]);

    // Exact price: learn, JP hits zero, ability is recorded.
    const learned = spendJpToLearn(c, 'k', 'knight', learnable.ability, 9);
    expect(learned.ok).toBe(true);
    if (!learned.ok) throw new Error('unreachable');
    expect(learned.campaign.roster[0]!.jobs.knight!.jp).toBe(0);
    expect(learned.campaign.roster[0]!.jobs.knight!.learned).toContain(learnable.ability);

    // Already known: refuse without refunding.
    const again = spendJpToLearn(
      learned.campaign,
      'k',
      'knight',
      learnable.ability,
      10,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.detail).toBe('already-known');
    expect(learned.campaign.roster[0]!.jobs.knight!.jp).toBe(0);

    const restored = roundTrip(learned.campaign);
    expect(restored.roster[0]!.jobs.knight!.learned).toContain(learnable.ability);
    expect(restored.roster[0]!.jobs.knight!.jp).toBe(0);
  });

  it('changing job updates derived stats, Move/Jump and sprite sheet', () => {
    // Black mage requires Chemist Lv 2. Bank that progress so the job is unlocked.
    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          knight: { level: 3, jp: 200, totalJp: 400, learned: [] },
          squire: { level: 2, jp: 100, totalJp: 200, learned: [] },
          chemist: { level: 2, jp: 100, totalJp: 200, learned: [] },
          'black-mage': { level: 1, jp: 0, totalJp: 0, learned: [] },
        },
      }),
    ]);

    const beforeLive = unitFromPersisted(c.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(jobUnlocked(beforeLive, 'black-mage')).toBe(true);
    expect(jobUnlocked(beforeLive, 'samurai')).toBe(false);

    const before = derivedStatsOf(c.roster[0]!);
    const beforeJob = getJob('knight');
    expect(before.move).toBe(beforeJob.move);

    const result = changeJob(c, 'k', 'black-mage', 11);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.campaign.roster[0]!.currentJob).toBe('black-mage');

    const after = derivedStatsOf(result.campaign.roster[0]!);
    const bm = getJob('black-mage');
    expect(after.move).toBe(bm.move);
    expect(after.jump).toBe(bm.jump);
    // Magical job should not share the knight's max-MP line.
    expect(after.maxMp).not.toBe(before.maxMp);

    const live = unitFromPersisted(result.campaign.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(live.sprite.sheet).toBe(bm.sprite.male);
    expect(live.sprite.sheet).not.toBe(beforeJob.sprite.male);

    // Samurai needs Knight 4 + Monk 5 — locked for this unit.
    const denied = changeJob(result.campaign, 'k', 'samurai', 13);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('job-locked');
    expect(result.campaign.roster[0]!.currentJob).toBe('black-mage');

    // Return to knight: prereqs are met (Squire Lv 2 in the fixture). Banked
    // JP alone is not a gate — canSwitchToJob is exactly unlockStatus.
    const back = changeJob(result.campaign, 'k', 'knight', 14);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('unreachable');
    expect(back.campaign.roster[0]!.currentJob).toBe('knight');
    const liveBack = unitFromPersisted(back.campaign.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(canSwitchToJob(liveBack, 'knight')).toBe(true);
    expect(canSwitchToJob(liveBack, 'samurai')).toBe(false);

    const restored = roundTrip(back.campaign);
    expect(restored.roster[0]!.currentJob).toBe('knight');
    const restoredStats = derivedStatsOf(restored.roster[0]!);
    expect(restoredStats.move).toBe(getJob('knight').move);
  });

  it('refuses gender-locked jobs — a female unit cannot become a Bard', () => {
    // unlockStatus enforces GENDER_LOCKED; canSwitchToJob and changeJob must
    // share that canonical gate, not the weaker jobUnlocked prereq check.
    const female = campaignOf([
      unit({
        id: 'f',
        name: 'Fara',
        gender: 'female',
        currentJob: 'squire',
        jobs: {
          squire: { level: 5, jp: 0, totalJp: 500, learned: [] },
          summoner: { level: 5, jp: 0, totalJp: 500, learned: [] },
          orator: { level: 5, jp: 0, totalJp: 500, learned: [] },
          // Banked JP must NOT override the gender lock.
          bard: { level: 1, jp: 0, totalJp: 100, learned: [] },
        },
      }),
    ]);
    const live = unitFromPersisted(female.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    // jobUnlocked only checks job levels — it would wrongly say yes.
    expect(jobUnlocked(live, 'bard')).toBe(true);
    // Canonical gate: gender blocks Bard for women.
    expect(canSwitchToJob(live, 'bard')).toBe(false);

    const denied = changeJob(female, 'f', 'bard', 20);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('job-locked');
    expect(female.roster[0]!.currentJob).toBe('squire');

    // A male with the same prereqs may take Bard.
    const male = campaignOf([
      unit({
        id: 'm',
        name: 'Marc',
        gender: 'male',
        currentJob: 'squire',
        jobs: {
          squire: { level: 5, jp: 0, totalJp: 500, learned: [] },
          summoner: { level: 5, jp: 0, totalJp: 500, learned: [] },
          orator: { level: 5, jp: 0, totalJp: 500, learned: [] },
        },
      }),
    ]);
    const maleLive = unitFromPersisted(male.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(canSwitchToJob(maleLive, 'bard')).toBe(true);
    const ok = changeJob(male, 'm', 'bard', 21);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.campaign.roster[0]!.currentJob).toBe('bard');
    expect(roundTrip(ok.campaign).roster[0]!.currentJob).toBe('bard');
  });

  it('refuses kill-gated jobs even with banked JP — Dark Knight needs 20 kills', () => {
    // Historical-JP re-entry must not bypass SPECIAL_CONDITIONS. A unit with
    // dark-knight JP and full job prereqs still cannot switch without kills.
    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          squire: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          knight: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          chemist: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          'black-mage': { level: 8, jp: 0, totalJp: 3000, learned: [] },
          // Banked JP that previously bypassed the kill gate.
          'dark-knight': { level: 1, jp: 0, totalJp: 500, learned: [] },
        },
      }),
    ]);
    const live = unitFromPersisted(c.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });

    // No kills in context: locked, even with banked JP.
    expect(canSwitchToJob(live, 'dark-knight', { kills: 0 })).toBe(false);
    expect(canSwitchToJob(live, 'dark-knight', {})).toBe(false);
    const denied = changeJob(c, 'k', 'dark-knight', 22, { kills: 0 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('job-locked');
    expect(c.roster[0]!.currentJob).toBe('knight');

    // UI node must agree with the mutation gate under the same UnlockContext.
    const nodesZero = jobNodeVMs(live, { kills: 0 });
    const darkZero = nodesZero.find((n) => n.id === 'dark-knight');
    expect(darkZero?.unlocked).toBe(false);

    // With 20 kills: open.
    expect(canSwitchToJob(live, 'dark-knight', { kills: 20 })).toBe(true);
    const nodesOk = jobNodeVMs(live, { kills: 20 });
    expect(nodesOk.find((n) => n.id === 'dark-knight')?.unlocked).toBe(true);
    const ok = changeJob(c, 'k', 'dark-knight', 23, { kills: 20 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.campaign.roster[0]!.currentJob).toBe('dark-knight');

    // Death Knight: 30 kills, same rule — banked JP alone is not enough.
    const deathLive = unitFromPersisted(
      unit({
        id: 'd',
        name: 'Dark',
        currentJob: 'dark-knight',
        jobs: {
          'dark-knight': { level: 3, jp: 0, totalJp: 700, learned: [] },
          mystic: { level: 3, jp: 0, totalJp: 700, learned: [] },
          'death-knight': { level: 1, jp: 0, totalJp: 200, learned: [] },
        },
      }),
      { team: 'player', pos: { x: 0, y: 0, z: 0 }, facing: 'S' },
    );
    expect(canSwitchToJob(deathLive, 'death-knight', { kills: 29 })).toBe(false);
    expect(canSwitchToJob(deathLive, 'death-knight', { kills: 30 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rename / dismiss
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Ability slots — only from what the unit has learned / unlocked
// ─────────────────────────────────────────────────────────────────────────────

describe('ability slots', () => {
  it('refuses reaction/support/movement that are not learned', () => {
    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          knight: { level: 2, jp: 100, totalJp: 200, learned: [] },
        },
      }),
    ]);

    // Counter is a real reaction, but this unit has not learned it.
    const denied = assignAbilitySlot(c, 'k', 'reaction', 'counter', 30);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('not-learned');
    expect(c.roster[0]!.reaction).toBeUndefined();

    // Empty string / garbage must not slip through a length>0 gate.
    const garbage = assignAbilitySlot(c, 'k', 'support', 'not-a-real-ability', 31);
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.reason).toBe('not-learned');
  });

  it('assigns a learned reaction and persists through serialize/deserialize', () => {
    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        jobs: {
          knight: { level: 3, jp: 50, totalJp: 400, learned: ['counter'] },
        },
      }),
    ]);

    const assigned = assignAbilitySlot(c, 'k', 'reaction', 'counter', 32);
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) throw new Error('unreachable');
    expect(assigned.campaign.roster[0]!.reaction).toBe('counter');

    const restored = roundTrip(assigned.campaign);
    expect(restored.roster[0]!.reaction).toBe('counter');

    const cleared = assignAbilitySlot(restored, 'k', 'reaction', null, 33);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error('unreachable');
    expect(cleared.campaign.roster[0]!.reaction).toBeUndefined();
  });

  it('secondary requires a learned ability from that skillset — not mere banking', () => {
    // Brief: secondary comes from what the unit has *learned*. An empty banked
    // job row must not unlock the skillset.
    const chemistSet = getJob('chemist').actionSet;
    const bankedOnly = campaignOf([
      unit({
        id: 's',
        name: 'Squire',
        currentJob: 'squire',
        jobs: {
          squire: { level: 2, jp: 50, totalJp: 100, learned: [] },
          chemist: { level: 1, jp: 0, totalJp: 0, learned: [] },
        },
      }),
    ]);
    const emptyBank = assignAbilitySlot(bankedOnly, 's', 'secondary', chemistSet, 34);
    expect(emptyBank.ok).toBe(false);
    if (!emptyBank.ok) expect(emptyBank.reason).toBe('not-learned');
    expect(bankedOnly.roster[0]!.secondaryAction).toBeUndefined();

    // Summoner skillset is not available without learned summon abilities.
    const denied = assignAbilitySlot(bankedOnly, 's', 'secondary', 'summon-magick', 35);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('not-learned');

    // After learning a chemist ability, the Item skillset is assignable.
    const chemist = getJob('chemist');
    const learnable = chemist.learnable.find((l) => l.jp > 0);
    if (!learnable) throw new Error('chemist has no priced learnable — fixture broken');
    const withJp = campaignOf([
      unit({
        id: 's',
        name: 'Squire',
        currentJob: 'squire',
        jobs: {
          squire: { level: 2, jp: 50, totalJp: 100, learned: [] },
          chemist: {
            level: 1,
            jp: learnable.jp,
            totalJp: learnable.jp,
            learned: [],
          },
        },
      }),
    ]);
    const learned = spendJpToLearn(withJp, 's', 'chemist', learnable.ability, 36);
    expect(learned.ok).toBe(true);
    if (!learned.ok) throw new Error('unreachable');

    const ok = assignAbilitySlot(learned.campaign, 's', 'secondary', chemistSet, 37);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.campaign.roster[0]!.secondaryAction).toBe(chemistSet);
    expect(roundTrip(ok.campaign).roster[0]!.secondaryAction).toBe(chemistSet);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gear-granted statuses (mirror path)
// ─────────────────────────────────────────────────────────────────────────────

describe('gear-granted statuses', () => {
  it('equipping and unequipping a Reflect Ring grants and removes Reflect', () => {
    const c = campaignOf(
      [unit({ id: 'k', name: 'Knight', currentJob: 'knight', equipment: {} })],
      { 'reflect-ring': 1 },
    );

    const equipped = equipItem(c, 'k', 'reflect-ring', 40);
    expect(equipped.ok).toBe(true);
    if (!equipped.ok) throw new Error('unreachable');

    // Fresh hydrate (unitFromPersisted) applies gear statuses.
    const live = unitFromPersisted(equipped.campaign.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(live.statuses.some((s) => s.status === 'reflect' && s.remaining === -1)).toBe(
      true,
    );

    // Mid-battle mirror path: start without gear statuses, then reconcile.
    const bare = unitFromPersisted(
      unit({ id: 'k', name: 'Knight', currentJob: 'knight', equipment: {} }),
      { team: 'player', pos: { x: 0, y: 0, z: 0 }, facing: 'S' },
    );
    expect(bare.statuses.some((s) => s.status === 'reflect')).toBe(false);
    const previousGranted = equipmentMods(bare).granted;
    bare.equipment = { ...equipped.campaign.roster[0]!.equipment };
    reconcileGearStatuses(bare, previousGranted);
    expect(bare.statuses.some((s) => s.status === 'reflect' && s.remaining === -1)).toBe(
      true,
    );

    // Unequip removes the permanent grant.
    const stripped = unequipItem(equipped.campaign, 'k', 'accessory', 41);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) throw new Error('unreachable');
    const afterPrev = equipmentMods(bare).granted;
    bare.equipment = { ...stripped.campaign.roster[0]!.equipment };
    reconcileGearStatuses(bare, afterPrev);
    expect(bare.statuses.some((s) => s.status === 'reflect')).toBe(false);
  });
});

describe('rename and dismiss', () => {
  it('renames a unit and persists the new name', () => {
    const c = campaignOf([
      unit({ id: 'a', name: 'Old', currentJob: 'squire' }),
      unit({ id: 'b', name: 'Other', currentJob: 'squire' }),
    ]);
    const result = renameUnit(c, 'a', '  New Name  ', 14);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.campaign.roster[0]!.name).toBe('New Name');
    expect(roundTrip(result.campaign).roster[0]!.name).toBe('New Name');
  });

  it('dismisses a unit but never drops the roster below one member', () => {
    const two = campaignOf([
      unit({
        id: 'a',
        name: 'Keep',
        currentJob: 'squire',
      }),
      unit({
        id: 'b',
        name: 'Go',
        currentJob: 'squire',
        equipment: { rightHand: 'dagger' },
      }),
    ]);
    // Gear on the dismissed unit returns to inventory.
    const gone = dismissUnit(two, 'b', 15);
    expect(gone.ok).toBe(true);
    if (!gone.ok) throw new Error('unreachable');
    expect(gone.campaign.roster).toHaveLength(1);
    expect(gone.campaign.roster[0]!.id).toBe('a');
    expect(gone.campaign.inventory.dagger).toBe(1);

    const last = dismissUnit(gone.campaign, 'a', 16);
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.reason).toBe('last-member');
    expect(gone.campaign.roster).toHaveLength(1);

    expect(roundTrip(gone.campaign).roster).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v0.1 step 3 — route every battle through the campaign
// ─────────────────────────────────────────────────────────────────────────────

describe('campaign launch path (v0.1 step 3)', () => {
  it('a new game boots through campaignToBattle with the seeded three Potions', () => {
    // Brief: first battle inventory equals campaign stock (three, not eight).
    const scenario = getScenario('battle-open');
    const campaign = newGameCampaign(scenario, 1_000);
    expect(campaign.inventory['use-potion']).toBe(3);
    expect(campaign.inventory['use-potion']).toBe(STARTER_CAMPAIGN_INVENTORY['use-potion']);
    // Eight is the battle-default STARTING_STOCK — must not appear on this path.
    expect(campaign.inventory['use-potion']).not.toBe(8);

    const built = campaignToBattle(campaign, scenario);
    const stock = built.state.inventories?.get('player')?.get('use-potion') ?? 0;
    expect(stock).toBe(3);
    expect(built.campaign.progress.current).toBe(scenario.id);
  });

  it('winning the first battle of a new game records it in progress.completed', () => {
    // Launch path itself pins progress.current — victory must credit that id.
    const scenario = getScenario('battle-open');
    const campaign = newGameCampaign(scenario, 1_000);
    expect(campaign.progress.completed).toEqual([]);
    expect(campaign.progress.current).toBeUndefined();

    const built = campaignToBattle(campaign, scenario);
    // progress.current is set at launch on the caller's object, not by the caller.
    expect(campaign.progress.current).toBe(scenario.id);

    built.state.phase = 'victory';
    const after = battleToCampaign(campaign, built.state, 2_000);
    expect(after.progress.completed).toContain(scenario.id);
    expect(after.progress.completed).toHaveLength(1);
  });

  it('a unit that scores knockdowns accumulates a persisted kill count', () => {
    // applyResolution is the sole combat commit path that credits kills.
    const scenario = getScenario('battle-open');
    const campaign = newGameCampaign(scenario, 1_000);
    const built = campaignToBattle(campaign, scenario);
    const state = built.state;

    const actor = [...state.units.values()].find((u) => u.team === 'player');
    const victim = [...state.units.values()].find((u) => u.team === 'enemy' && !u.removed);
    expect(actor).toBeDefined();
    expect(victim).toBeDefined();
    if (!actor || !victim) throw new Error('unreachable');

    expect(actor.kills ?? 0).toBe(0);
    victim.stats.hp = 1;

    const lethal: AbilityResolution = {
      caster: actor.id,
      ability: 'throw-stone',
      mpCost: 0,
      casterHpDelta: 0,
      casterMpDelta: 0,
      casterStatusesBroken: [],
      events: [],
      targets: [
        {
          unit: victim.id,
          hit: {
            hit: true,
            chance: 100,
            roll: -1,
            category: 'physical',
            direction: 'front',
            evade: {
              classEvade: 0,
              weaponEvade: 0,
              shieldEvade: 0,
              accessoryEvade: 0,
              magicEvade: 0,
            },
            evadeNullified: true,
            consumedEvadeCharge: false,
            zodiac: 1,
            breakdown: [],
          },
          direction: 'front',
          damage: {
            target: victim.id,
            kind: 'damage',
            amount: 999,
            hpDelta: -999,
            mpDelta: 0,
            attackerHpDelta: 0,
            attackerMpDelta: 0,
            wardAbsorbed: 0,
            element: 'none',
            crit: false,
            direction: 'front',
            affinity: 'normal',
            zodiac: 1,
            lethal: true,
            breakdown: [],
          },
          applied: [],
          removed: [],
          ko: true,
          revived: false,
          events: [],
        },
      ],
    };
    applyResolution(state, lethal);

    expect(victim.stats.hp).toBe(0);
    expect(actor.kills).toBe(1);

    const victim2 = [...state.units.values()].find(
      (u) => u.team === 'enemy' && u.id !== victim.id && !u.removed && u.stats.hp > 0,
    );
    if (victim2) {
      victim2.stats.hp = 1;
      applyResolution(state, {
        ...lethal,
        targets: [{ ...lethal.targets[0]!, unit: victim2.id, damage: { ...lethal.targets[0]!.damage!, target: victim2.id } }],
      });
      expect(actor.kills).toBe(2);
    }

    const killsBefore = actor.kills ?? 0;
    expect(killsBefore).toBeGreaterThanOrEqual(1);

    state.phase = 'victory';
    const after = battleToCampaign(campaign, state, 3_000);
    const persisted = after.roster.find((u) => u.id === actor.id);
    expect(persisted).toBeDefined();
    expect(persisted!.kills).toBe(killsBefore);

    const restored = roundTrip(after);
    const roundTripped = restored.roster.find((u) => u.id === actor.id);
    expect(roundTripped!.kills).toBe(killsBefore);

    const live = unitFromPersisted(roundTripped!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(live.kills).toBe(killsBefore);
  });

  it('Dark Knight unlocks through the real path with no injected UnlockContext', () => {
    // kills live on the unit; unlockStatus reads them when ctx is {}.
    const c = campaignOf([
      unit({
        id: 'k',
        name: 'Knight',
        currentJob: 'knight',
        kills: 20,
        jobs: {
          squire: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          knight: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          chemist: { level: 8, jp: 0, totalJp: 3000, learned: [] },
          'black-mage': { level: 8, jp: 0, totalJp: 3000, learned: [] },
        },
      }),
    ]);
    const live = unitFromPersisted(c.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(live.kills).toBe(20);
    // Real path: empty context, unit carries the kills.
    expect(canSwitchToJob(live, 'dark-knight')).toBe(true);
    expect(canSwitchToJob(live, 'dark-knight', {})).toBe(true);
    const nodes = jobNodeVMs(live, {});
    expect(nodes.find((n) => n.id === 'dark-knight')?.unlocked).toBe(true);

    const ok = changeJob(c, 'k', 'dark-knight', 40);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.campaign.roster[0]!.currentJob).toBe('dark-knight');
  });

  it('a monster with banked JP cannot switch to an ordinary job', () => {
    // canSwitchToJob is exactly unlockStatus — banked JP is not a bypass.
    const c = campaignOf([
      unit({
        id: 'm',
        name: 'Goblin',
        gender: 'monster',
        currentJob: 'squire',
        jobs: {
          squire: { level: 2, jp: 0, totalJp: 200, learned: [] },
          // Banked JP that previously opened knight despite gender === monster.
          knight: { level: 3, jp: 100, totalJp: 500, learned: [] },
        },
      }),
    ]);
    const live = unitFromPersisted(c.roster[0]!, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(canSwitchToJob(live, 'knight')).toBe(false);
    const denied = changeJob(c, 'm', 'knight', 50);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('job-locked');
    expect(c.roster[0]!.currentJob).toBe('squire');
  });
});
