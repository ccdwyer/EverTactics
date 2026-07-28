/**
 * EverTactics — campaign save I/O.
 *
 * The only module that touches storage. `core/campaign.ts` stays pure and
 * unit-testable in node; this file is the thin adapter over localStorage.
 *
 * Failure mode is deliberate: private-mode browsers, quota exceeded, and corrupt
 * blobs all return null / no-op rather than throwing. A missing save is a normal
 * state (title screen → New Game), not a crash.
 *
 * Storage contract: exactly one namespaced key. No probe keys, no side writes.
 */

import {
  deserialize,
  serialize,
  type CampaignState,
} from '@core/campaign';

/** Single namespaced key. Version lives inside the JSON blob, not the key. */
export const CAMPAIGN_STORAGE_KEY = 'evertactics.campaign';

/**
 * Resolve localStorage without writing any secondary key.
 * Some private-mode browsers expose the object but throw on access.
 */
function getStorage(): Storage | null {
  try {
    if (typeof globalThis === 'undefined') return null;
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return null;
    // Touch via the real key only — never invent a probe entry.
    void storage.getItem(CAMPAIGN_STORAGE_KEY);
    return storage;
  } catch {
    return null;
  }
}

/** Persist the campaign. No-op when storage is unavailable. */
export function saveCampaign(state: CampaignState): void {
  const storage = getStorage();
  if (!storage) {
    console.warn('[save] localStorage unavailable; campaign not written');
    return;
  }
  try {
    storage.setItem(CAMPAIGN_STORAGE_KEY, serialize(state));
  } catch (err) {
    console.warn('[save] failed to write campaign', err);
  }
}

/**
 * Load the campaign, or null when missing / corrupt / storage unavailable.
 * Never throws.
 */
export function loadCampaign(): CampaignState | null {
  const storage = getStorage();
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(CAMPAIGN_STORAGE_KEY);
  } catch (err) {
    console.warn('[save] failed to read campaign', err);
    return null;
  }
  if (raw === null || raw === '') return null;
  try {
    return deserialize(raw);
  } catch (err) {
    console.warn('[save] corrupt campaign blob; ignoring', err);
    return null;
  }
}

/** Remove the save. No-op when storage is unavailable. */
export function clearCampaign(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(CAMPAIGN_STORAGE_KEY);
  } catch (err) {
    console.warn('[save] failed to clear campaign', err);
  }
}

/** True when a non-empty blob is present (not necessarily valid). */
export function hasSave(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    const raw = storage.getItem(CAMPAIGN_STORAGE_KEY);
    return raw !== null && raw !== '';
  } catch {
    return false;
  }
}
