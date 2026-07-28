import { battleOpenEncounter } from './battle-open';
import { dorterStorehouseEncounter } from './dorter-storehouse';
import { firstLessonEncounter } from './first-lesson';
import { garilandBridgeEncounter } from './gariland-bridge';
import { lionelGateEncounter } from './lionel-gate';
import { lionelReckoningEncounter } from './lionel-reckoning';
import { mandaliaAmbushEncounter } from './mandalia-ambush';
import { mandaliaSkirmishEncounter } from './mandalia-skirmish';
import { orbonneReturnEncounter } from './orbonne-return';
import type { Encounter } from './types';
import { zeircheleChargeEncounter } from './zeirchele-charge';

export type {
  Encounter,
  EncounterBanner,
  EncounterCamera,
  EncounterPost,
  EnemyPlacement,
  UnitPlacement,
} from './types';

/** Explicit campaign registry: duplicate or mismatched ids are visible in review. */
export const ENCOUNTERS = {
  'orbonne-vanguard': battleOpenEncounter,
  'first-lesson': firstLessonEncounter,
  'mandalia-skirmish': mandaliaSkirmishEncounter,
  'gariland-bridge': garilandBridgeEncounter,
  'zeirchele-charge': zeircheleChargeEncounter,
  'lionel-gate': lionelGateEncounter,
  'dorter-storehouse': dorterStorehouseEncounter,
  'mandalia-ambush': mandaliaAmbushEncounter,
  'orbonne-return': orbonneReturnEncounter,
  'lionel-reckoning': lionelReckoningEncounter,
} as const satisfies Readonly<Record<string, Encounter>>;

export type EncounterId = keyof typeof ENCOUNTERS;

export function listEncounters(): readonly Encounter[] {
  return Object.values(ENCOUNTERS);
}

export function getEncounter(id: string | null | undefined): Encounter | undefined {
  return id ? (ENCOUNTERS as Readonly<Record<string, Encounter>>)[id] : undefined;
}
