import type { PersonalityId } from '@core/ai';
import type {
  AbilityId,
  Equipment,
  Facing,
  Gender,
  JobId,
  Objective,
  Team,
  UnitId,
  Zodiac,
} from '@core/types';
import type { LightingPreset, LightingPresetName } from '@render/lighting';

/** A complete authored combatant slot before it is materialised as a live Unit. */
export interface UnitPlacement {
  readonly id: UnitId;
  readonly name: string;
  readonly job: JobId;
  readonly gender: Gender;
  readonly team: Team;
  readonly level: number;
  readonly zodiac: Zodiac;
  readonly brave: number;
  readonly faith: number;
  readonly at: { readonly x: number; readonly y: number };
  readonly facing: Facing;
  readonly equipment: Equipment;
  readonly learn?: readonly AbilityId[];
  readonly secondary?: JobId;
  readonly reaction?: AbilityId;
  readonly support?: AbilityId;
  readonly movement?: AbilityId;
  readonly personality?: PersonalityId;
  readonly ct?: number;
}

/** An authored opponent must belong to the enemy side and have an AI policy. */
export type EnemyPlacement = Omit<UnitPlacement, 'team' | 'personality'> & {
  readonly team: 'enemy';
  readonly personality: PersonalityId;
};

export interface EncounterCamera {
  readonly yawIndex: 0 | 1 | 2 | 3;
  readonly frameField: boolean;
  readonly pixelScale?: number;
  readonly focusTile?: { readonly x: number; readonly y: number; readonly z: number };
  readonly pitchDegrees?: number;
  readonly fitWholeField?: boolean;
}

export interface EncounterPost {
  readonly exposure?: number;
  readonly dof?: number;
  readonly ao?: number;
  readonly bloom?: number;
  readonly vignette?: number;
}

export interface EncounterBanner {
  readonly title: string;
  readonly subtitle?: string;
}

/**
 * One campaign battle, including both deterministic combat data and the
 * presentation needed to launch or render it without a second scenario table.
 */
export interface Encounter {
  readonly id: string;
  readonly chapter: 1 | 2;
  readonly name: string;
  readonly blurb: string;
  readonly mapId: string;
  readonly seed: number;
  readonly enemies: readonly EnemyPlacement[];
  readonly objective: Objective;
  readonly rewards: {
    readonly exp: number;
    readonly jp: number;
  };
  readonly lighting: LightingPresetName;
  readonly grade: string;
  readonly lightingTune?: Partial<LightingPreset>;
  readonly camera?: EncounterCamera;
  readonly post?: EncounterPost;
  readonly banner: EncounterBanner;
}
