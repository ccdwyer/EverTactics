import type { MapDef } from '../../core/grid';
import { DORTER_STOREHOUSE } from './dorter-storehouse';
import { GARILAND_BRIDGE } from './gariland-bridge';
import { LIONEL_GATE } from './lionel-gate';
import { MANDALIA_PLAINS } from './mandalia-plains';
import { ORBONNE_COURTYARD } from './orbonne-courtyard';
import { ZEIRCHELE_RIDGE } from './zeirchele-ridge';

export {
  DORTER_STOREHOUSE,
  GARILAND_BRIDGE,
  LIONEL_GATE,
  MANDALIA_PLAINS,
  ORBONNE_COURTYARD,
  ZEIRCHELE_RIDGE,
};

/**
 * Explicit order is intentional: it keeps listMaps and unknown-id diagnostics
 * deterministic, while making duplicate ids visible during review.
 */
export const MAPS: Readonly<Record<string, MapDef>> = {
  [ORBONNE_COURTYARD.id]: ORBONNE_COURTYARD,
  [MANDALIA_PLAINS.id]: MANDALIA_PLAINS,
  [GARILAND_BRIDGE.id]: GARILAND_BRIDGE,
  [ZEIRCHELE_RIDGE.id]: ZEIRCHELE_RIDGE,
  [LIONEL_GATE.id]: LIONEL_GATE,
  [DORTER_STOREHOUSE.id]: DORTER_STOREHOUSE,
};
