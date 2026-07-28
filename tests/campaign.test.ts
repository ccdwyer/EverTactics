/**
 * Campaign persistence — the state layer under the meta-loop.
 *
 * Nothing in the game currently survives a refresh without this module. These
 * tests pin the contract: round-trip fidelity, migration, corrupt-safe load,
 * battle-scoped fields excluded, determinism across a save/load boundary, and
 * battle write-back of earned JP/exp/completion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAMPAIGN_VERSION,
  battleToCampaign,
  createCampaign,
  deserialize,
  migrate,
  serialize,
  unitFromPersisted,
  unitToPersisted,
  type CampaignState,
  type PersistedUnit,
} from '../src/core/campaign';
import { advance, applyCommand, evaluateObjective } from '../src/core/battle';
import { decideTurn } from '../src/core/ai';
import { gainExp, gainJp } from '../src/core/unit';
import type { BattleEvent, BattleState, Unit } from '../src/core/types';
import {
  CAMPAIGN_STORAGE_KEY,
  clearCampaign,
  hasSave,
  loadCampaign,
  saveCampaign,
} from '../src/state/save';
import { buildScenario, campaignToBattle, getScenario } from '../src/state/scenarios';

/** Minimal valid v1 roster unit for negative validation cases. */
function validPersistedUnit(overrides: Partial<PersistedUnit> = {}): PersistedUnit {
  return {
    id: 'p1',
    name: 'Hero',
    gender: 'male',
    zodiac: 'leo',
    level: 3,
    exp: 10,
    totalExp: 10,
    currentJob: 'squire',
    jobs: { squire: { level: 1, jp: 0, totalJp: 0, learned: [] } },
    equipment: {},
    raw: { hp: 100, mp: 40, pa: 8, ma: 8, spd: 8 },
    brave: 70,
    faith: 70,
    ...overrides,
  };
}

function validV1Shell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    seed: 1,
    gil: 100,
    roster: [],
    inventory: {},
    progress: { completed: [] },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isFinished(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

/** Play a battle AI-vs-AI and collect the event stream. */
function playBattle(state: BattleState, maxTurns = 400): {
  state: BattleState;
  events: BattleEvent[];
  turns: number;
} {
  const events: BattleEvent[] = [];
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

    const id = state.active;
    if (!id) break;

    for (const cmd of decideTurn(state, id)) {
      if (state.phase !== 'awaiting-command') break;
      events.push(...applyCommand(state, cmd));
    }
    if (state.phase === 'awaiting-command' && state.active === id) {
      events.push(...applyCommand(state, { kind: 'wait', unit: id }));
    }
    turns++;
  }

  return { state, events, turns };
}

/** Campaign whose roster is the battle-open player squad, freshly built. */
function campaignFromBattleOpen(seed = 20260727, timestamp = 1_700_000_000_000): CampaignState {
  const scenario = getScenario('battle-open');
  const built = buildScenario({ ...scenario, seed });
  const campaign = createCampaign(seed, timestamp);

  for (const unit of built.state.units.values()) {
    if (unit.team === 'player') {
      campaign.roster.push(unitToPersisted(unit));
    }
  }

  // Mirror the party stock the scenario path installs lazily.
  campaign.inventory = {
    'use-potion': 8,
    'use-hi-potion': 4,
    'use-phoenix-down': 4,
  };

  return campaign;
}

/** In-memory localStorage so save.ts can be exercised in node. */
function installMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
  vi.stubGlobal('localStorage', storage);
  return storage;
}

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip / migration / pure model
// ─────────────────────────────────────────────────────────────────────────────

describe('campaign serialize / deserialize', () => {
  it('round-trips: deserialize(serialize(s)) deep-equals s', () => {
    const original = campaignFromBattleOpen(42, 100);
    // Put some earned progress on so the blob is non-trivial.
    original.gil = 1500;
    original.progress.completed = ['tutorial-skirmish'];
    original.roster[0]!.exp = 47;
    original.roster[0]!.jobs['knight'] = {
      level: 3,
      jp: 120,
      totalJp: 320,
      learned: ['accumulate', 'throw-stone'].sort(),
    };

    const restored = deserialize(serialize(original));
    expect(restored).toEqual(original);
    expect(restored.version).toBe(CAMPAIGN_VERSION);
  });

  it('migrate upgrades a hand-written v0 blob without throwing', () => {
    // v0 shape: no version field, `gold` instead of `gil`, flat raw stats, incomplete progress.
    const v0 = {
      seed: 99,
      gold: 250,
      roster: [
        {
          id: 'p-hero',
          name: 'Hero',
          gender: 'male',
          zodiac: 'leo',
          level: 5,
          exp: 20,
          currentJob: 'squire',
          jobs: {
            squire: { level: 2, jp: 50, totalJp: 150, learned: ['accumulate'] },
          },
          equipment: { rightHand: 'dagger' },
          rawHp: 140,
          rawMp: 50,
          pa: 10,
          ma: 8,
          spd: 9,
          brave: 70,
          faith: 65,
        },
      ],
      inventory: { 'use-potion': 3 },
      progress: { completed: ['old-fight'] },
      createdAt: 1000,
      updatedAt: 2000,
    };

    const upgraded = migrate(v0);
    expect(upgraded.version).toBe(CAMPAIGN_VERSION);
    expect(upgraded.gil).toBe(250);
    expect(upgraded.seed).toBe(99);
    expect(upgraded.roster).toHaveLength(1);
    expect(upgraded.roster[0]!.id).toBe('p-hero');
    expect(upgraded.roster[0]!.raw.hp).toBe(140);
    expect(upgraded.roster[0]!.raw.pa).toBe(10);
    expect(upgraded.roster[0]!.totalExp).toBe(0);
    expect(upgraded.inventory['use-potion']).toBe(3);
    expect(upgraded.progress.completed).toEqual(['old-fight']);
    // Round-trip after migrate is stable.
    expect(deserialize(serialize(upgraded))).toEqual(upgraded);
  });

  it('migrate rejects a save newer than the supported version', () => {
    expect(() => migrate({ version: 999, seed: 1, gil: 0, roster: [], inventory: {}, progress: { completed: [] }, createdAt: 0, updatedAt: 0 }))
      .toThrow(/newer than supported/);
  });

  it('migrate rejects current-version saves with structurally corrupt fields', () => {
    // Numeric fields present (the old silent-accept case) but roster/inventory/progress wiped.
    const corruptRoster = {
      version: 1,
      seed: 1,
      gil: 100,
      roster: 'not-an-array',
      inventory: {},
      progress: { completed: [] },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => migrate(corruptRoster)).toThrow(/roster/);

    const corruptInventory = {
      version: 1,
      seed: 1,
      gil: 100,
      roster: [],
      inventory: null,
      progress: { completed: [] },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => migrate(corruptInventory)).toThrow(/inventory/);

    const corruptProgress = {
      version: 1,
      seed: 1,
      gil: 100,
      roster: [],
      inventory: {},
      progress: { completed: 'nope' },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => migrate(corruptProgress)).toThrow(/progress/);

    const missingRoster = {
      version: 1,
      seed: 1,
      gil: 100,
      inventory: {},
      progress: { completed: [] },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => migrate(missingRoster)).toThrow(/roster/);
  });

  it('migrate rejects current-version saves with corrupt *contents* (not just shape)', () => {
    // Invalid inventory count — previously dropped silently, leaving a plausible save
    // with missing potions. Must fail loudly.
    expect(() =>
      migrate(validV1Shell({ inventory: { 'use-potion': 'three' } })),
    ).toThrow(/inventory/);

    expect(() =>
      migrate(validV1Shell({ inventory: { 'use-potion': -2 } })),
    ).toThrow(/inventory/);

    // Malformed job progress — previously reset to defaults / dropped.
    expect(() =>
      migrate(
        validV1Shell({
          gil: 0,
          roster: [{ ...validPersistedUnit(), jobs: { squire: 'not-a-progress-object' } }],
        }),
      ),
    ).toThrow(/jobs/);

    // Missing raw stats — previously filled with defaults, rewriting the unit.
    const { raw: _raw, ...missingRaw } = validPersistedUnit();
    void _raw;
    expect(() => migrate(validV1Shell({ gil: 0, roster: [missingRaw] }))).toThrow(/raw/);

    // Non-string entry in progress.completed.
    expect(() =>
      migrate(validV1Shell({ gil: 0, progress: { completed: [42] } })),
    ).toThrow(/completed/);
  });

  it('migrate rejects fractional seed/gil/inventory (never floors into a plausible save)', () => {
    // Runtime probe from review: seed 1.75, gil 10.9, inventory 2.8 must fail.
    expect(() => migrate(validV1Shell({ seed: 1.75, gil: 10, inventory: {} }))).toThrow(/seed/);
    expect(() => migrate(validV1Shell({ seed: 1, gil: 10.9, inventory: {} }))).toThrow(/gil/);
    expect(() =>
      migrate(validV1Shell({ inventory: { 'use-potion': 2.8 } })),
    ).toThrow(/inventory/);

    // Fractional job/stat fields also reject.
    expect(() =>
      migrate(
        validV1Shell({
          gil: 0,
          roster: [validPersistedUnit({ exp: 10.5 })],
        }),
      ),
    ).toThrow(/exp/);
    expect(() =>
      migrate(
        validV1Shell({
          gil: 0,
          roster: [
            validPersistedUnit({
              jobs: { squire: { level: 1, jp: 3.2, totalJp: 0, learned: [] } },
            }),
          ],
        }),
      ),
    ).toThrow(/jp/);
  });

  it('migrate rejects missing totalExp and currentJob absent from jobs', () => {
    const { totalExp: _te, ...noTotalExp } = validPersistedUnit();
    void _te;
    expect(() => migrate(validV1Shell({ gil: 0, roster: [noTotalExp] }))).toThrow(/totalExp/);

    expect(() =>
      migrate(
        validV1Shell({
          gil: 0,
          roster: [
            validPersistedUnit({
              currentJob: 'knight',
              jobs: { squire: { level: 1, jp: 0, totalJp: 0, learned: [] } },
            }),
          ],
        }),
      ),
    ).toThrow(/currentJob/);
  });

  it('migrate rejects a present but non-integer version (does not treat as v0)', () => {
    // A corrupt version field must not fall through to lenient migration.
    expect(() =>
      migrate({
        version: '1',
        seed: 1,
        gil: 100,
        roster: [],
        inventory: {},
        progress: { completed: [] },
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toThrow(/version/);
    expect(() =>
      migrate({
        version: 1.5,
        seed: 1,
        gil: 100,
        roster: [],
        inventory: {},
        progress: { completed: [] },
        createdAt: 0,
        updatedAt: 0,
      }),
    ).toThrow(/version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Battle-scoped fields are not persisted
// ─────────────────────────────────────────────────────────────────────────────

describe('persisted unit shape', () => {
  it('does not persist position, CT, statuses, or turn flags', () => {
    const built = buildScenario(getScenario('battle-open'));
    const unit = [...built.state.units.values()].find((u) => u.team === 'player')!;
    // Dirty the battle-scoped fields so a leak would be obvious.
    unit.ct = 87;
    unit.pos = { x: 3, y: 4, z: 2 };
    unit.facing = 'E';
    unit.statuses = [{ status: 'poison', remaining: 12 }];
    unit.turn = { moved: true, acted: true, origin: { x: 1, y: 1, z: 0 }, originFacing: 'N' };
    unit.removed = true;

    const persisted: PersistedUnit = unitToPersisted(unit);
    const json = JSON.stringify(persisted);

    expect(json).not.toMatch(/"ct"/);
    expect(json).not.toMatch(/"pos"/);
    expect(json).not.toMatch(/"facing"/);
    expect(json).not.toMatch(/"statuses"/);
    expect(json).not.toMatch(/"turn"/);
    expect(json).not.toMatch(/"removed"/);
    expect(json).not.toMatch(/"team"/);
    expect(json).not.toMatch(/"sprite"/);

    // Hydrated unit starts a fresh battle life.
    const live = unitFromPersisted(persisted, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(live.ct).toBe(0);
    expect(live.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(live.facing).toBe('S');
    expect(live.turn.moved).toBe(false);
    expect(live.turn.acted).toBe(false);
    expect(live.removed).toBe(false);
    // Poison from the dirty unit did not come back.
    expect(live.statuses.every((s) => s.status !== 'poison')).toBe(true);
    // Durable fields survived.
    expect(live.level).toBe(unit.level);
    expect(live.exp).toBe(unit.exp);
    expect(live.currentJob).toBe(unit.currentJob);
    expect(live.name).toBe(unit.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localStorage adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('save / load (localStorage)', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saveCampaign + loadCampaign round-trips a campaign', () => {
    const original = campaignFromBattleOpen(7, 500);
    saveCampaign(original);
    expect(hasSave()).toBe(true);
    const loaded = loadCampaign();
    expect(loaded).toEqual(original);
  });

  it('corrupt blob: loadCampaign returns null rather than throwing', () => {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, '{not valid json!!!');
    expect(() => loadCampaign()).not.toThrow();
    expect(loadCampaign()).toBeNull();

    // Invalid seed type.
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify({ version: 1, seed: 'nope' }));
    expect(loadCampaign()).toBeNull();

    // Structurally corrupt v1 with valid numbers but missing roster — must not
    // silently return a wiped campaign.
    localStorage.setItem(
      CAMPAIGN_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        seed: 42,
        gil: 100,
        inventory: {},
        progress: { completed: [] },
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    expect(loadCampaign()).toBeNull();
  });

  it('clearCampaign removes the save', () => {
    saveCampaign(createCampaign(1, 1));
    expect(hasSave()).toBe(true);
    clearCampaign();
    expect(hasSave()).toBe(false);
    expect(loadCampaign()).toBeNull();
  });

  it('returns null when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadCampaign()).toBeNull();
    expect(hasSave()).toBe(false);
    // save must not throw either
    expect(() => saveCampaign(createCampaign(1, 1))).not.toThrow();
  });

  it('logs when storage is unavailable on load (private mode / missing storage)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', undefined);
    expect(loadCampaign()).toBeNull();
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /localStorage unavailable/i.test(m))).toBe(true);
    warn.mockRestore();
  });

  it('logs when storage access throws on load', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError: storage blocked');
      },
      setItem() {
        throw new Error('SecurityError: storage blocked');
      },
      removeItem() {
        throw new Error('SecurityError: storage blocked');
      },
      clear() {},
      key() {
        return null;
      },
      length: 0,
    });
    expect(loadCampaign()).toBeNull();
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /localStorage unavailable|failed to read/i.test(m))).toBe(true);
    warn.mockRestore();
  });

  it('uses only the namespaced campaign key (no probe keys)', () => {
    const storage = installMemoryStorage();
    // Pre-seed an unrelated key; save ops must not create/remove others.
    storage.setItem('unrelated.user-data', 'keep-me');
    saveCampaign(createCampaign(9, 1));
    const keys = [storage.key(0), storage.key(1)].filter(Boolean).sort();
    expect(keys).toEqual(['evertactics.campaign', 'unrelated.user-data'].sort());
    expect(storage.getItem('unrelated.user-data')).toBe('keep-me');
    clearCampaign();
    expect(storage.getItem('unrelated.user-data')).toBe('keep-me');
    expect(storage.getItem(CAMPAIGN_STORAGE_KEY)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism across a save/load boundary — the point of the whole task
// ─────────────────────────────────────────────────────────────────────────────

describe('determinism across save/load', () => {
  it('produces identical event streams from a live campaign and its deserialized twin', () => {
    const seed = 1234;
    const live = campaignFromBattleOpen(seed, 9_000);
    const restored = deserialize(serialize(live));

    // Campaigns match first.
    expect(restored).toEqual(live);

    // Use the stock scenario definition — battle RNG comes from campaign.seed,
    // so we must NOT overwrite scenario.seed to paper over seed usage.
    const scenario = getScenario('battle-open');
    const battleA = campaignToBattle(live, scenario).state;
    const battleB = campaignToBattle(restored, scenario).state;

    // Opening state must already agree on the durable bits that drive combat.
    const snap = (state: BattleState) =>
      [...state.units.values()]
        .map((u: Unit) => ({
          id: u.id,
          team: u.team,
          level: u.level,
          exp: u.exp,
          job: u.currentJob,
          hp: u.stats.hp,
          maxHp: u.stats.maxHp,
          pa: u.stats.pa,
          ma: u.stats.ma,
          spd: u.stats.spd,
          ct: u.ct,
          pos: u.pos,
          brave: u.stats.brave,
          faith: u.stats.faith,
          learned: [...(u.jobs.get(u.currentJob)?.learned ?? [])].sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

    expect(snap(battleB)).toEqual(snap(battleA));
    expect(battleB.rngState).toBe(battleA.rngState);

    const playedA = playBattle(battleA);
    const playedB = playBattle(battleB);

    expect(playedA.turns).toBe(playedB.turns);
    expect(playedA.state.phase).toBe(playedB.state.phase);
    expect(JSON.stringify(playedB.events)).toBe(JSON.stringify(playedA.events));
    // A real fight, not a trivial empty stream.
    expect(playedA.events.length).toBeGreaterThan(50);
  });

  it('campaign.seed changes battle RNG (seed is not dead weight)', () => {
    const base = campaignFromBattleOpen(100, 1);
    const alt = { ...base, seed: 999 };
    const scenario = getScenario('battle-open');

    const a = campaignToBattle(base, scenario).state;
    const b = campaignToBattle(alt, scenario).state;

    expect(a.rngState).not.toBe(b.rngState);
    // CT stagger also draws from campaign-seeded RNG when placement.ct is unset.
    const ctsA = [...a.units.values()].map((u) => u.ct).sort((x, y) => x - y);
    const ctsB = [...b.units.values()].map((u) => u.ct).sort((x, y) => x - y);
    // At least one unit's CT should differ under different seeds (placements
    // without fixed ct draw from rng). If all placements have fixed ct this
    // still fails on rngState above.
    expect(ctsA.join(',') === ctsB.join(',') && a.rngState === b.rngState).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// battleToCampaign write-back
// ─────────────────────────────────────────────────────────────────────────────

describe('battleToCampaign', () => {
  it('writes back earned JP/exp and marks the scenario completed on victory (3-arg form)', () => {
    const base = campaignFromBattleOpen(55, 100);
    const scenario = getScenario('battle-open');
    // Launch is campaignToBattle itself — no separate beginScenario step.
    expect(base.progress.current).toBeUndefined();

    const before = base.roster.map((u) => ({
      id: u.id,
      exp: u.exp,
      totalExp: u.totalExp,
      level: u.level,
      jobJp: Object.fromEntries(
        Object.entries(u.jobs).map(([j, p]) => [j, { jp: p.jp, totalJp: p.totalJp, level: p.level }]),
      ),
    }));

    const built = campaignToBattle(base, scenario);
    expect(built.campaign.progress.current).toBe(scenario.id);
    const state = built.state;

    // Award known gains without playing a full fight.
    for (const unit of state.units.values()) {
      if (unit.team !== 'player') continue;
      gainExp(unit, 40);
      gainJp(unit, 25);
    }
    // Consume an item so inventory write-back is visible.
    const potionsBefore = base.inventory['use-potion'] ?? 0;
    const playerInv = state.inventories?.get('player');
    expect(playerInv?.get('use-potion')).toBe(potionsBefore);
    playerInv?.set('use-potion', Math.max(0, potionsBefore - 2));

    state.phase = 'victory';

    // Three-arg form with the campaign returned from campaignToBattle.
    const after = battleToCampaign(built.campaign, state, 200);
    expect(after.updatedAt).toBe(200);
    expect(after.createdAt).toBe(base.createdAt);
    expect(after.progress.completed).toContain(scenario.id);
    expect(after.progress.current).toBe(scenario.id);
    expect(after.inventory['use-potion']).toBe(potionsBefore - 2);

    for (const prior of before) {
      const next = after.roster.find((u) => u.id === prior.id);
      expect(next, prior.id).toBeDefined();
      const expGained = next!.totalExp - prior.totalExp;
      expect(expGained).toBe(40);

      const jobId = next!.currentJob;
      const jobBefore = prior.jobJp[jobId];
      const jobAfter = next!.jobs[jobId];
      expect(jobAfter).toBeDefined();
      expect(jobAfter!.totalJp).toBe((jobBefore?.totalJp ?? 0) + 25);
    }

    // Original campaign was not mutated.
    expect(base.progress.completed).not.toContain(scenario.id);
    expect(base.progress.current).toBeUndefined();
    expect(base.updatedAt).toBe(100);
  });

  it('campaignToBattle pins progress.current so battleToCampaign completes without a separate step', () => {
    const base = campaignFromBattleOpen(8, 10);
    const scenario = getScenario('battle-open');

    // The bridge is two calls: campaignToBattle → battleToCampaign.
    // Feeding the *input* campaign (no current) must not complete — that would
    // only work if someone invented a fourth scenarioId arg.
    const built = campaignToBattle(base, scenario);
    expect(base.progress.current).toBeUndefined();
    expect(built.campaign.progress.current).toBe(scenario.id);

    built.state.phase = 'victory';
    const forgotLaunch = battleToCampaign(base, built.state, 20);
    expect(forgotLaunch.progress.completed).not.toContain(scenario.id);

    const after = battleToCampaign(built.campaign, built.state, 20);
    expect(after.progress.completed).toContain(scenario.id);
    expect(after.progress.current).toBe(scenario.id);
  });

  it('campaignToBattle overwrites a stale progress.current so the previous scenario is not credited', () => {
    const base = campaignFromBattleOpen(3, 10);
    base.progress.current = 'old-stale-fight';
    const scenario = getScenario('battle-open');

    const built = campaignToBattle(base, scenario);
    expect(built.campaign.progress.current).toBe(scenario.id);
    expect(built.campaign.progress.current).not.toBe('old-stale-fight');

    built.state.phase = 'victory';
    const after = battleToCampaign(built.campaign, built.state, 20);
    expect(after.progress.completed).toContain(scenario.id);
    expect(after.progress.completed).not.toContain('old-stale-fight');
  });

  it('does not mark completion on defeat', () => {
    const base = campaignFromBattleOpen(3, 10);
    const built = campaignToBattle(base, getScenario('battle-open'));
    built.state.phase = 'defeat';
    const after = battleToCampaign(built.campaign, built.state, 20);
    expect(after.progress.completed).not.toContain('battle-open');
    // current still records where the player was.
    expect(after.progress.current).toBe('battle-open');
  });

  it('does not mutate battle when inventory is absent, and keeps campaign stock', () => {
    const base = campaignFromBattleOpen(11, 50);
    base.inventory = { 'use-potion': 5 };
    // Simulate a launch that already pinned current (e.g. a custom scenario id).
    const launched = {
      ...base,
      inventory: { ...base.inventory },
      progress: { completed: [...base.progress.completed], current: 'some-fight' },
    };

    // Minimal battle with no inventories map.
    const battle: BattleState = {
      field: buildScenario(getScenario('battle-open')).state.field,
      units: new Map(),
      order: [],
      active: undefined,
      phase: 'victory',
      tick: 0,
      rngState: 0,
      log: [],
      objective: { kind: 'defeat-all' },
    };
    expect(battle.inventories).toBeUndefined();

    const after = battleToCampaign(launched, battle, 99);
    // Pure: battle still has no inventories.
    expect(battle.inventories).toBeUndefined();
    // Campaign stock preserved (not replaced with default starting pile).
    expect(after.inventory).toEqual({ 'use-potion': 5 });
    expect(after.progress.completed).toContain('some-fight');
  });
});
