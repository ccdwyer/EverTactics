/**
 * Title-screen campaign choices and boot-route selection.
 *
 * This module is the state boundary between the UI and persistence. The title
 * screen itself receives a plain view model and emits intents; it never reads a
 * save or creates campaign state.
 */

import type { CampaignState } from '@core/campaign';
import type { TitleScreenVM } from '@ui/types';

import { hasSave, loadCampaign, saveCampaign } from './save';
import {
  CAMPAIGN_START_SCENARIO_ID,
  getScenario,
  newGameCampaign,
} from './scenarios';

export type BootRoute =
  | { kind: 'title' }
  | { kind: 'scene'; scenarioId: string }
  | { kind: 'shot'; scenarioId: string };

export type NewCampaignResult =
  | { kind: 'confirmation-required' }
  | { kind: 'world-map'; campaign: CampaignState };

export type ContinueCampaignResult =
  | { kind: 'unavailable' }
  | { kind: 'world-map'; campaign: CampaignState };

export interface NewCampaignOptions {
  timestamp: number;
  confirmOverwrite: boolean;
}

/** Resolve boot precedence without importing the side-effectful main module. */
export function resolveBootRoute(search: string | URLSearchParams): BootRoute {
  const params = typeof search === 'string'
    ? new URLSearchParams(search)
    : search;
  const shotScenario = params.get('shot');
  if (shotScenario !== null) return { kind: 'shot', scenarioId: shotScenario };
  const sceneScenario = params.get('scene');
  if (sceneScenario !== null) return { kind: 'scene', scenarioId: sceneScenario };
  return { kind: 'title' };
}

/** Plain data consumed by TitleScreen. */
export function titleScreenVM(): TitleScreenVM {
  const savePresent = hasSave();
  return {
    title: 'EverTactics',
    subtitle: 'A Chronicle of Steel and Starlight',
    continueAvailable: savePresent,
    overwriteConfirmationRequired: savePresent,
  };
}

/**
 * Create and persist the canonical starting company.
 *
 * An existing save is untouched until the caller carries an explicit
 * confirmation from the title screen.
 */
export function startNewCampaign(options: NewCampaignOptions): NewCampaignResult {
  if (hasSave() && !options.confirmOverwrite) {
    return { kind: 'confirmation-required' };
  }
  const campaign = newGameCampaign(
    getScenario(CAMPAIGN_START_SCENARIO_ID),
    options.timestamp,
  );
  saveCampaign(campaign);
  return { kind: 'world-map', campaign };
}

/** Load the exact durable campaign selected by Continue. */
export function continueCampaign(): ContinueCampaignResult {
  const campaign = loadCampaign();
  return campaign === null
    ? { kind: 'unavailable' }
    : { kind: 'world-map', campaign };
}
