/**
 * Party-edit gate and intent dispatch — campaign mutations are between-battle only.
 *
 * Formation / Roster / Job screens display mid-battle as read-only viewers.
 * Every mutation goes through {@link dispatchPartyIntent}, which refuses when a
 * battle is live. Nothing here (or the party editors) writes into a live
 * `BattleState`; the campaign is the only write target, and battle stock
 * re-enters the campaign once via {@link battleToCampaign} at battle end.
 *
 * `Game.onIntent` must route party UIIntents here. Tests hit this function with
 * the same intent shapes the UI emits — if the mid-battle guard is removed,
 * those tests fail.
 */

import {
  assignAbilitySlot,
  changeJob,
  dismissUnit,
  equipItem,
  renameUnit,
  setFormation,
  spendJpToLearn,
  unequipItem,
  type EquipSlot,
} from '@core/party';
import type { CampaignState, FormationEntry } from '@core/campaign';
import type { UnlockContext } from '@core/jobs/tree';
import type { AbilityId, JobId, UnitId } from '@core/types';
import type { UIIntent } from '@ui/types';

export type PartyEditBlock = { ok: false; reason: 'battle-live' };

/** UIIntent kinds that mutate the campaign roster / formation / inventory. */
export type PartyMutationIntent = Extract<
  UIIntent,
  | { kind: 'set-job' }
  | { kind: 'learn-ability' }
  | { kind: 'assign-slot' }
  | { kind: 'formation-confirm' }
  | { kind: 'equip-item' }
  | { kind: 'unequip-item' }
  | { kind: 'rename-unit' }
  | { kind: 'dismiss-unit' }
>;

export type PartyDispatchOpts = {
  timestamp: number;
  /** Required for formation-confirm. */
  startTileCount?: number;
  maxDeployed?: number;
  formation?: readonly FormationEntry[];
  unlockCtx?: UnlockContext;
};

export type PartyDispatchResult =
  | { ok: true; campaign: CampaignState }
  | { ok: false; reason: string; detail?: string };

/**
 * `true` when party editors may mutate the campaign.
 * `battleLive` is true from battle start until victory/defeat is folded back.
 */
export function partyEditAllowed(battleLive: boolean): boolean {
  return !battleLive;
}

/** Unlock facts sourced from the persisted roster, never from a UI fixture. */
export function unlockContextForUnit(
  campaign: CampaignState,
  unitId: UnitId,
): UnlockContext {
  return {
    kills: campaign.roster.find((unit) => unit.id === unitId)?.kills ?? 0,
  };
}

/** Gate used by every party mutation path. */
export function assertPartyEditAllowed(
  battleLive: boolean,
): true | PartyEditBlock {
  if (battleLive) return { ok: false, reason: 'battle-live' };
  return true;
}

/**
 * Apply a party-screen UIIntent to the campaign, or refuse when a battle is live.
 *
 * This is the production path `Game` uses for every equip / job / formation /
 * rename / dismiss mutation. Callers must not bypass it with a direct core call
 * while a fight is in progress.
 */
export function dispatchPartyIntent(
  campaign: CampaignState,
  battleLive: boolean,
  intent: PartyMutationIntent,
  opts: PartyDispatchOpts,
): PartyDispatchResult {
  const gate = assertPartyEditAllowed(battleLive);
  if (gate !== true) {
    return { ok: false, reason: gate.reason };
  }

  const ts = opts.timestamp;
  const ctx = opts.unlockCtx ?? {};

  switch (intent.kind) {
    case 'equip-item': {
      const result = equipItem(campaign, intent.unitId as UnitId, intent.itemId, ts);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, campaign: result.campaign };
    }
    case 'unequip-item': {
      const result = unequipItem(
        campaign,
        intent.unitId as UnitId,
        intent.slot as EquipSlot,
        ts,
      );
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, campaign: result.campaign };
    }
    case 'set-job': {
      const result = changeJob(
        campaign,
        intent.unitId as UnitId,
        intent.jobId as JobId,
        ts,
        ctx,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        };
      }
      return { ok: true, campaign: result.campaign };
    }
    case 'learn-ability': {
      const result = spendJpToLearn(
        campaign,
        intent.unitId as UnitId,
        intent.jobId as JobId,
        intent.abilityId as AbilityId,
        ts,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        };
      }
      return { ok: true, campaign: result.campaign };
    }
    case 'assign-slot': {
      const result = assignAbilitySlot(
        campaign,
        intent.unitId as UnitId,
        intent.slot,
        intent.abilityId,
        ts,
      );
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        };
      }
      return { ok: true, campaign: result.campaign };
    }
    case 'rename-unit': {
      const result = renameUnit(campaign, intent.unitId as UnitId, intent.name, ts);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, campaign: result.campaign };
    }
    case 'dismiss-unit': {
      const result = dismissUnit(campaign, intent.unitId as UnitId, ts);
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, campaign: result.campaign };
    }
    case 'formation-confirm': {
      const entries = opts.formation ?? campaign.formation ?? [];
      const startTileCount = opts.startTileCount ?? 0;
      const maxDeployed = opts.maxDeployed ?? startTileCount;
      const result = setFormation(campaign, entries, {
        startTileCount,
        maxDeployed,
        timestamp: ts,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, campaign: result.campaign };
    }
  }
}
