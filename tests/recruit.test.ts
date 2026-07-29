/**
 * v0.2 recruitment — deterministic generic hires and durable town offers.
 *
 * These tests stay on the public core boundary. No UI fixtures, clock reads, or
 * mocked RNG paths stand in for the campaign behavior they claim to verify.
 */
import { describe, expect, it } from 'vitest';

import {
  deserialize,
  serialize,
  unitFromPersisted,
  type CampaignState,
  type PersistedUnit,
} from '../src/core/campaign';
import { sellPrice } from '../src/core/economy';
import { allJobs, getJob } from '../src/core/jobs';
import { GENDER_LOCKED, unlockStatus } from '../src/core/jobs/tree';
import {
  RECRUIT_OFFER_COUNT,
  ROSTER_CAP,
  availableRecruitJobs,
  hireRecruit,
  recruitPrice,
  rollRecruit,
  rosterRecruitLevel,
  townRecruitOffers,
} from '../src/core/recruit';
import { createRng } from '../src/core/rng';
import type { Gender, JobId } from '../src/core/types';
import { WORLD_NODES } from '../src/core/world';
import { bootstrapContent } from '../src/state/content';
import { findItem } from '../src/state/items';
import { getScenario, newGameCampaign } from '../src/state/scenarios';

bootstrapContent();

const GARILAND = WORLD_NODES.find((node) => node.id === 'gariland-camp')!;
const DORTER = WORLD_NODES.find((node) => node.id === 'dorter-market')!;

function fundedCampaign(seed = 20_260_729): CampaignState {
  const campaign = newGameCampaign(getScenario('first-lesson'), 1_000);
  campaign.seed = seed;
  campaign.gil = 50_000;
  return campaign;
}

function hireFirst(campaign: CampaignState, timestamp = 2_000): CampaignState {
  const offer = townRecruitOffers(campaign, GARILAND.id)[0]!;
  const result = hireRecruit(
    campaign,
    GARILAND.id,
    {
      offerIndex: offer.index,
      job: offer.unit.currentJob,
      gender: offer.unit.gender as Exclude<Gender, 'monster'>,
      name: '',
    },
    timestamp,
  );
  if (!result.ok) throw new Error(`expected hire to succeed, received ${result.reason}`);
  return result.campaign;
}

describe('rollRecruit', () => {
  it('returns the same complete persisted unit for the same seed and choices', () => {
    const first = rollRecruit(createRng(73), { job: 'knight', gender: 'female' });
    const replayed = rollRecruit(createRng(73), { job: 'knight', gender: 'female' });

    expect(replayed).toEqual(first);
    expect(first.currentJob).toBe('knight');
    expect(first.gender).toBe('female');
    expect(first.jobs).toEqual({
      squire: { level: 2, jp: 0, totalJp: 100, learned: [] },
      knight: { level: 1, jp: 0, totalJp: 0, learned: [] },
    });
    expect(first.level).toBe(1);
    expect(first.exp).toBe(0);
    expect(first.totalExp).toBe(0);
    expect(first.brave).toBeGreaterThanOrEqual(40);
    expect(first.brave).toBeLessThanOrEqual(70);
    expect(first.faith).toBeGreaterThanOrEqual(40);
    expect(first.faith).toBeLessThanOrEqual(70);
    expect(first.raw.hp).toBeGreaterThanOrEqual(90);
    expect(first.raw.hp).toBeLessThanOrEqual(110);
    expect(first.raw.mp).toBeGreaterThanOrEqual(34);
    expect(first.raw.mp).toBeLessThanOrEqual(46);
    expect(first.raw.pa).toBeGreaterThanOrEqual(7);
    expect(first.raw.pa).toBeLessThanOrEqual(9);
    expect(first.raw.ma).toBeGreaterThanOrEqual(7);
    expect(first.raw.ma).toBeLessThanOrEqual(9);
    expect(first.raw.spd).toBeGreaterThanOrEqual(7);
    expect(first.raw.spd).toBeLessThanOrEqual(9);
  });

  it('equips every job only with categories that job may use', () => {
    const choices: readonly {
      job: JobId;
      gender: Exclude<Gender, 'monster'>;
    }[] = allJobs().map((job) => ({
      job: job.id,
      gender: GENDER_LOCKED.get(job.id) === 'female' ? 'female' : 'male',
    }));

    choices.forEach((choice, index) => {
      const unit = rollRecruit(createRng(100 + index), choice);
      const job = getJob(choice.job);
      for (const itemId of Object.values(unit.equipment)) {
        const item = findItem(itemId);
        expect(item, `${choice.job} starter item ${itemId}`).toBeDefined();
        expect(job.equip, `${choice.job} cannot equip ${itemId}`).toContain(item?.category);
      }
    });
  });
});

describe('town recruit offers', () => {
  it('keeps exactly three offers stable across visits and save/load', () => {
    const campaign = fundedCampaign();
    const firstVisit = townRecruitOffers(campaign, GARILAND.id);
    const secondVisit = townRecruitOffers(campaign, GARILAND.id);
    const restored = deserialize(serialize(campaign));
    const afterLoad = townRecruitOffers(restored, GARILAND.id);
    campaign.roster[0]!.level += 4;
    campaign.roster[0]!.jobs.squire = {
      level: 8,
      jp: 0,
      totalJp: 6_000,
      learned: [],
    };
    const afterCompanyProgress = townRecruitOffers(campaign, GARILAND.id);

    expect(firstVisit).toHaveLength(RECRUIT_OFFER_COUNT);
    expect(secondVisit).toEqual(firstVisit);
    expect(afterLoad).toEqual(firstVisit);
    expect(afterCompanyProgress.map((offer) => offer.unit)).toEqual(
      firstVisit.map((offer) => offer.unit),
    );
    expect(new Set(firstVisit.map((offer) => offer.unit.id)).size).toBe(RECRUIT_OFFER_COUNT);
  });

  it('isolates each town and advances only the town where a hire occurred', () => {
    const campaign = fundedCampaign();
    const garilandBefore = townRecruitOffers(campaign, GARILAND.id);
    const dorterBefore = townRecruitOffers(campaign, DORTER.id);
    const hired = hireFirst(campaign);

    expect(townRecruitOffers(hired, GARILAND.id).map((offer) => offer.unit))
      .not.toEqual(garilandBefore.map((offer) => offer.unit));
    expect(townRecruitOffers(hired, DORTER.id).map((offer) => offer.unit))
      .toEqual(dorterBefore.map((offer) => offer.unit));
  });

  it('offers only company-held or company-unlocked jobs, filtered by recruit gender', () => {
    const campaign = fundedCampaign();
    const maleJobs = availableRecruitJobs(campaign, 'male');
    const femaleJobs = availableRecruitJobs(campaign, 'female');

    expect(maleJobs).toContain('squire');
    expect(maleJobs).toContain('chemist');
    expect(maleJobs).toContain('knight');
    expect(femaleJobs).toContain('black-mage');
    expect(maleJobs).not.toContain('dancer');
    expect(femaleJobs).not.toContain('bard');
    expect(maleJobs).not.toContain('samurai');
    expect(maleJobs).not.toContain('dark-knight');
  });
});

describe('hireRecruit', () => {
  it('debits the tuneable roster-level price, appends the named unit, and survives save/load', () => {
    const campaign = fundedCampaign();
    const offer = townRecruitOffers(campaign, GARILAND.id)[0]!;
    const expectedPrice = recruitPrice(
      rosterRecruitLevel(campaign.roster),
      offer.unit.currentJob,
    );
    const beforeGil = campaign.gil;

    const result = hireRecruit(
      campaign,
      GARILAND.id,
      {
        offerIndex: offer.index,
        job: offer.unit.currentJob,
        gender: offer.unit.gender as Exclude<Gender, 'monster'>,
        name: '  Maren  ',
      },
      2_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected hire to succeed');
    expect(result.price).toBe(expectedPrice);
    expect(result.campaign.gil).toBe(beforeGil - expectedPrice);
    expect(result.campaign.roster).toHaveLength(campaign.roster.length + 1);
    expect(result.unit.name).toBe('Maren');
    expect(result.unit.id).toBe(`recruit:${campaign.seed}:${GARILAND.id}:0:0`);
    expect(result.campaign.roster.at(-1)).toEqual(result.unit);

    const restored = deserialize(serialize(result.campaign));
    expect(restored.roster).toEqual(result.campaign.roster);
    expect(restored.roster.at(-1)).toEqual(result.unit);
    expect(townRecruitOffers(restored, GARILAND.id)).toEqual(
      townRecruitOffers(result.campaign, GARILAND.id),
    );
  });

  it('uses the offered default name when the player does not type', () => {
    const campaign = fundedCampaign();
    const offer = townRecruitOffers(campaign, GARILAND.id)[0]!;
    const hired = hireFirst(campaign);

    expect(hired.roster.at(-1)?.name).toBe(offer.unit.name);
  });

  it('mints distinct structural ids after save/load continuation', () => {
    const first = hireFirst(fundedCampaign(), 2_000);
    const restored = deserialize(serialize(first));
    const second = hireFirst(restored, 3_000);
    const ids = second.roster.map((unit) => unit.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-2)).toBe(`recruit:${second.seed}:${GARILAND.id}:0:0`);
    expect(ids.at(-1)).toBe(`recruit:${second.seed}:${GARILAND.id}:1:0`);
  });

  it('keeps an advanced starting job legally re-enterable', () => {
    const campaign = fundedCampaign();
    expect(availableRecruitJobs(campaign, 'male')).toContain('knight');

    const result = hireRecruit(
      campaign,
      GARILAND.id,
      {
        offerIndex: 0,
        job: 'knight',
        gender: 'male',
        name: 'Trainee',
      },
      2_000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected advanced hire');

    const recruit = result.campaign.roster.at(-1)!;
    const live = unitFromPersisted(recruit, {
      team: 'player',
      pos: { x: 0, y: 0, z: 0 },
      facing: 'S',
    });
    expect(unlockStatus(live, 'knight').unlocked).toBe(true);
  });

  it('prices every starter kit above its dismissal resale value', () => {
    const level = 1;
    for (const job of allJobs()) {
      const gender: Exclude<Gender, 'monster'> =
        GENDER_LOCKED.get(job.id) === 'female' ? 'female' : 'male';
      const recruit = rollRecruit(createRng(300), {
        job: job.id,
        gender,
      });
      const resale = Object.values(recruit.equipment).reduce((total, itemId) => {
        const item = findItem(itemId);
        expect(item, itemId).toBeDefined();
        return total + sellPrice(item?.price ?? 0);
      }, 0);
      expect(recruitPrice(level, job.id) - resale, job.id).toBe(150);
    }
  });

  it('refuses unaffordable, locked-job, and full-roster hires without mutation', () => {
    const poor = fundedCampaign();
    poor.gil = 0;
    const poorBefore = serialize(poor);
    expect(
      hireRecruit(
        poor,
        GARILAND.id,
        { offerIndex: 0, job: 'squire', gender: 'male', name: 'Poor' },
        2_000,
      ),
    ).toEqual({ ok: false, reason: 'cannot-afford' });
    expect(serialize(poor)).toBe(poorBefore);

    const locked = fundedCampaign();
    const lockedBefore = serialize(locked);
    expect(
      hireRecruit(
        locked,
        GARILAND.id,
        { offerIndex: 0, job: 'samurai', gender: 'male', name: 'Too Soon' },
        2_000,
      ),
    ).toEqual({ ok: false, reason: 'job-locked' });
    expect(serialize(locked)).toBe(lockedBefore);

    const full = fundedCampaign();
    const template = full.roster[0]!;
    while (full.roster.length < ROSTER_CAP) {
      full.roster.push({
        ...template,
        id: `cap-${full.roster.length}`,
        jobs: structuredClone(template.jobs),
        equipment: { ...template.equipment },
        raw: { ...template.raw },
      } satisfies PersistedUnit);
    }
    const fullBefore = serialize(full);
    expect(
      hireRecruit(
        full,
        GARILAND.id,
        { offerIndex: 0, job: 'squire', gender: 'male', name: 'No Room' },
        2_000,
      ),
    ).toEqual({ ok: false, reason: 'roster-full' });
    expect(serialize(full)).toBe(fullBefore);
  });
});
