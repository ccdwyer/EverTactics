/**
 * Deterministic generic recruitment.
 *
 * Pure campaign logic only: no renderer, DOM, storage, clock, Math.random(), or
 * Date.now(). Town batches are derived from durable campaign data and advance
 * only after a successful hire.
 */

import {
  type CampaignState,
  type PersistedUnit,
  unitFromPersisted,
} from './campaign';
import { canAfford } from './economy';
import { allJobs, getJob } from './jobs';
import {
  GENDER_LOCKED,
  SPECIAL_CONDITIONS,
  jpForJobLevel,
  prerequisiteClosure,
  unlockStatus,
} from './jobs/tree';
import { createRng, rangeInt, seedFromString } from './rng';
import type {
  Equipment,
  EquipCategory,
  Gender,
  ItemId,
  Job,
  JobId,
  Rng,
  UnitId,
} from './types';
import { ZODIAC_WHEEL } from './combat/zodiac';
import type { WorldNodeId } from './ids';

export const RECRUIT_OFFER_COUNT = 3;
export const ROSTER_CAP = 16;

const MALE_NAMES: readonly string[] = [
  'Aren',
  'Bastian',
  'Cedric',
  'Dain',
  'Edrin',
  'Ferran',
  'Garrick',
  'Hadrian',
  'Lucan',
  'Merek',
  'Orrin',
  'Tavian',
] as const;

const FEMALE_NAMES: readonly string[] = [
  'Anwen',
  'Brienne',
  'Celia',
  'Elowen',
  'Ilyra',
  'Jessamine',
  'Maren',
  'Nerys',
  'Rhea',
  'Sabine',
  'Talia',
  'Ysabet',
] as const;

/**
 * Lowest authored item ids keyed by the categories jobs already declare.
 *
 * The recruitment layer deliberately owns only ids, not the item table. That
 * keeps core independent from state/content while making the selected kit a
 * deterministic function of the job's canonical equip list. Katana and
 * instrument currently have one authored item each, so those are necessarily
 * the starter choices for Samurai and Bard.
 */
const STARTER_ITEM_BY_CATEGORY: Readonly<Partial<Record<EquipCategory, ItemId>>> = {
  knife: 'dagger',
  sword: 'broadsword',
  katana: 'asura-knife',
  spear: 'javelin',
  staff: 'oak-staff',
  rod: 'rod',
  bow: 'long-bow',
  instrument: 'ramia-harp',
  shield: 'buckler',
  helm: 'leather-helm',
  hat: 'feather-hat',
  armor: 'leather-armor',
  robe: 'linen-robe',
  clothing: 'leather-outfit',
};

/**
 * Sell value of the low-tier kit above.
 *
 * Kept beside the ids so the hire price can always exceed the gil recovered by
 * hiring, dismissing, and selling the issued gear. A regression test pins these
 * values to the real shop prices.
 */
const STARTER_ITEM_RESALE: Readonly<Partial<Record<ItemId, number>>> = {
  dagger: 100,
  broadsword: 250,
  'asura-knife': 1_500,
  javelin: 600,
  'oak-staff': 100,
  rod: 100,
  'long-bow': 600,
  'ramia-harp': 1_500,
  buckler: 400,
  'leather-helm': 150,
  'feather-hat': 200,
  'leather-armor': 200,
  'linen-robe': 250,
  'leather-outfit': 300,
};

const WEAPON_PRIORITY: readonly EquipCategory[] = [
  'sword',
  'katana',
  'spear',
  'bow',
  'staff',
  'rod',
  'instrument',
  'knife',
] as const;

export interface RecruitOffer {
  readonly index: number;
  readonly unit: PersistedUnit;
  readonly price: number;
}

export type RecruitFailure =
  | 'invalid-offer'
  | 'job-locked'
  | 'cannot-afford'
  | 'roster-full'
  | 'duplicate-id';

export type RecruitResult =
  | {
      ok: true;
      campaign: CampaignState;
      unit: PersistedUnit;
      price: number;
    }
  | { ok: false; reason: RecruitFailure };

/** One complete generic unit rolled only from the supplied stream and choices. */
export function rollRecruit(
  rng: Rng,
  opts: { job: JobId; gender: Gender },
): PersistedUnit {
  if (opts.gender === 'monster') {
    throw new Error('rollRecruit: generic recruits must be male or female');
  }
  const job = getJob(opts.job);
  const initialState = rng.state();
  const names = opts.gender === 'female' ? FEMALE_NAMES : MALE_NAMES;
  const name = names[rng.int(names.length)] ?? names[0]!;
  const zodiac = ZODIAC_WHEEL[rng.int(ZODIAC_WHEEL.length)] ?? 'aries';
  const raw = {
    hp: rangeInt(rng, 90, 110),
    mp: rangeInt(rng, 34, 46),
    pa: rangeInt(rng, 7, 9),
    ma: rangeInt(rng, 7, 9),
    spd: rangeInt(rng, 7, 9),
  };
  const brave = rangeInt(rng, 40, 70);
  const faith = rangeInt(rng, 40, 70);
  const candidateHash = seedFromString(
    `${initialState >>> 0}:${opts.job}:${opts.gender}`,
  ).toString(36);

  return {
    id: `candidate:${candidateHash}`,
    name,
    gender: opts.gender,
    zodiac,
    level: 1,
    exp: 0,
    totalExp: 0,
    kills: 0,
    currentJob: opts.job,
    jobs: startingJobProgress(opts.job),
    equipment: starterEquipment(job),
    raw,
    brave,
    faith,
  };
}

/** Rounded current company level used by the one tuneable hiring-price formula. */
export function rosterRecruitLevel(roster: readonly PersistedUnit[]): number {
  if (roster.length === 0) return 1;
  const total = roster.reduce(
    (sum, unit) => sum + Math.max(1, Math.floor(unit.level)),
    0,
  );
  return Math.max(1, Math.round(total / roster.length));
}

/**
 * Hiring cost: 100 gil base plus 50 gil per current company level, plus the
 * issued kit's exact resale value.
 */
export function recruitPrice(level: number, jobId: JobId): number {
  const normalized = Number.isFinite(level)
    ? Math.max(1, Math.min(99, Math.floor(level)))
    : 1;
  const equipment = starterEquipment(getJob(jobId));
  const resale = Object.values(equipment).reduce(
    (total, itemId) => total + (STARTER_ITEM_RESALE[itemId] ?? 0),
    0,
  );
  return 100 + normalized * 50 + resale;
}

/**
 * Jobs represented or unlocked anywhere in the current company, then filtered
 * by the chosen recruit's gender.
 */
export function availableRecruitJobs(
  campaign: CampaignState,
  gender: Exclude<Gender, 'monster'>,
): JobId[] {
  const out: JobId[] = [];
  for (const job of allJobs()) {
    const genderLock = GENDER_LOCKED.get(job.id);
    if (genderLock !== undefined && genderLock !== gender) continue;
    // Personal KO gates cannot be truthfully granted to a fresh generic.
    if (SPECIAL_CONDITIONS.has(job.id)) continue;
    if (
      job.requires.length === 0 ||
      campaign.roster.some((persisted) => companyMemberUnlocks(persisted, job.id))
    ) {
      out.push(job.id);
    }
  }
  return out;
}

/** Generate the stable three-card batch currently visible at one town. */
export function townRecruitOffers(
  campaign: CampaignState,
  nodeId: WorldNodeId,
): RecruitOffer[] {
  const cycle = townCycle(campaign, nodeId);
  const offers: RecruitOffer[] = [];

  for (let index = 0; index < RECRUIT_OFFER_COUNT; index++) {
    const defaults = createRng(
      campaign.seed ^ seedFromString(`${nodeId}:${cycle}:${index}:defaults`),
    );
    const gender: Exclude<Gender, 'monster'> =
      defaults.int(2) === 0 ? 'male' : 'female';
    // Candidate identity may not drift when the company unlocks another job
    // between town visits. Both roots are always legal; the player chooses any
    // currently unlocked job in the recruitment screen.
    const job: JobId = defaults.int(2) === 0 ? 'squire' : 'chemist';
    offers.push({
      index,
      unit: recruitCandidate(campaign, nodeId, index, { job, gender }),
      price: recruitPrice(rosterRecruitLevel(campaign.roster), job),
    });
  }

  return offers;
}

/**
 * Resolve one offer slot for a player-selected job and gender.
 *
 * The slot stream excludes those choices, so zodiac/raw/Brave/Faith identify the
 * same candidate while the chosen job changes the kit and gender changes the
 * offered default name.
 */
export function recruitCandidate(
  campaign: CampaignState,
  nodeId: WorldNodeId,
  offerIndex: number,
  opts: { job: JobId; gender: Exclude<Gender, 'monster'> },
): PersistedUnit {
  const cycle = townCycle(campaign, nodeId);
  const rng = createRng(
    campaign.seed ^ seedFromString(`${nodeId}:${cycle}:${offerIndex}:candidate`),
  );
  const unit = rollRecruit(rng, opts);
  return {
    ...unit,
    id: recruitId(campaign.seed, nodeId, cycle, offerIndex),
  };
}

/** Atomically debit gil, append the unit, and advance only this town's batch. */
export function hireRecruit(
  campaign: CampaignState,
  nodeId: WorldNodeId,
  choice: {
    offerIndex: number;
    job: JobId;
    gender: Exclude<Gender, 'monster'>;
    name: string;
  },
  timestamp: number,
): RecruitResult {
  if (campaign.roster.length >= ROSTER_CAP) {
    return { ok: false, reason: 'roster-full' };
  }
  if (
    !Number.isInteger(choice.offerIndex) ||
    choice.offerIndex < 0 ||
    choice.offerIndex >= RECRUIT_OFFER_COUNT
  ) {
    return { ok: false, reason: 'invalid-offer' };
  }
  if (!availableRecruitJobs(campaign, choice.gender).includes(choice.job)) {
    return { ok: false, reason: 'job-locked' };
  }

  const price = recruitPrice(
    rosterRecruitLevel(campaign.roster),
    choice.job,
  );
  if (!canAfford(campaign.gil, price)) {
    return { ok: false, reason: 'cannot-afford' };
  }

  const offered = recruitCandidate(campaign, nodeId, choice.offerIndex, {
    job: choice.job,
    gender: choice.gender,
  });
  if (campaign.roster.some((unit) => unit.id === offered.id)) {
    return { ok: false, reason: 'duplicate-id' };
  }
  const name = choice.name.trim() || offered.name;
  const unit: PersistedUnit = { ...offered, name };
  const cycle = townCycle(campaign, nodeId);

  return {
    ok: true,
    unit,
    price,
    campaign: {
      ...campaign,
      gil: campaign.gil - price,
      roster: [...campaign.roster, unit],
      inventory: { ...campaign.inventory },
      formation: campaign.formation.map((entry) => ({ ...entry })),
      recruitment: {
        townCycles: {
          ...campaign.recruitment.townCycles,
          [nodeId]: cycle + 1,
        },
      },
      progress: {
        ...campaign.progress,
        completed: [...campaign.progress.completed],
      },
      updatedAt: timestamp,
    },
  };
}

function companyMemberUnlocks(
  persisted: PersistedUnit,
  jobId: JobId,
): boolean {
  if (persisted.currentJob === jobId) return true;
  const unit = unitFromPersisted(persisted, {
    team: 'player',
    pos: { x: 0, y: 0, z: 0 },
    facing: 'S',
  });
  return unlockStatus(unit, jobId, { kills: persisted.kills ?? 0 }).unlocked;
}

function townCycle(campaign: CampaignState, nodeId: WorldNodeId): number {
  return campaign.recruitment.townCycles[nodeId] ?? 0;
}

function recruitId(
  campaignSeed: number,
  nodeId: WorldNodeId,
  cycle: number,
  offerIndex: number,
): UnitId {
  return `recruit:${campaignSeed}:${nodeId}:${cycle}:${offerIndex}`;
}

function starterEquipment(job: Job): Equipment {
  const equipment: Equipment = {};
  const weaponCategory = WEAPON_PRIORITY.find((category) =>
    job.equip.includes(category),
  );
  if (weaponCategory !== undefined) {
    const weapon = STARTER_ITEM_BY_CATEGORY[weaponCategory];
    if (weapon !== undefined) equipment.rightHand = weapon;
  }

  const twoHanded = weaponCategory === 'bow';
  if (!twoHanded && job.equip.includes('shield')) {
    equipment.leftHand = STARTER_ITEM_BY_CATEGORY.shield;
  }

  if (job.equip.includes('helm')) {
    equipment.head = STARTER_ITEM_BY_CATEGORY.helm;
  } else if (job.equip.includes('hat')) {
    equipment.head = STARTER_ITEM_BY_CATEGORY.hat;
  }

  if (job.equip.includes('armor')) {
    equipment.body = STARTER_ITEM_BY_CATEGORY.armor;
  } else if (job.equip.includes('robe')) {
    equipment.body = STARTER_ITEM_BY_CATEGORY.robe;
  } else if (job.equip.includes('clothing')) {
    equipment.body = STARTER_ITEM_BY_CATEGORY.clothing;
  }

  return equipment;
}

function startingJobProgress(jobId: JobId): PersistedUnit['jobs'] {
  const jobs: PersistedUnit['jobs'] = {};
  for (const [requiredJob, requiredLevel] of prerequisiteClosure(jobId)) {
    jobs[requiredJob] = {
      level: requiredLevel,
      jp: 0,
      totalJp: jpForJobLevel(requiredLevel),
      learned: [],
    };
  }
  jobs[jobId] = { level: 1, jp: 0, totalJp: 0, learned: [] };
  return jobs;
}
