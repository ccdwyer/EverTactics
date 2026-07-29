/**
 * UI view-model and intent contracts.
 *
 * The UI never reads `BattleState` and never mutates it. The game layer pushes
 * plain view-models in (`UIRoot.set*`) and subscribes to intents coming out
 * (`UIRoot.on`). Every type here is serialisable data — no live core objects.
 */

import type { Element, Facing, StatusId, Team } from '@core/types';

// ─────────────────────────────────────────────────────────────────────────────
// View models
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusVM {
  id: StatusId;
  name: string;
  /** Remaining CT ticks; -1 for permanent. */
  remaining: number;
  /** Positive statuses render in gold, negative in ember red. */
  tone: 'buff' | 'debuff' | 'neutral';
  description?: string;
}

export interface UnitLoadoutVM {
  equipment: readonly { slot: string; name: string }[];
  actionGroups: readonly { name: string; abilities: readonly string[] }[];
  passives: readonly { slot: string; name: string }[];
}

export interface UnitVM {
  id: string;
  name: string;
  team: Team;
  /** Display name of the current job, e.g. "Black Mage". */
  job: string;
  jobId: string;
  /**
   * Optional. When present the HUD casts the portrait on job + gender instead of
   * inferring gender from the auto-cast face — see `castPortrait` in
   * `portraits.ts`.
   */
  gender?: 'male' | 'female' | 'monster';
  level: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  brave: number;
  faith: number;
  /** Current charge time, 0-100. */
  ct: number;
  statuses: readonly StatusVM[];
  /** Portrait file name inside public/assets/portraits, e.g. `wldface_001_08_uitx.png`. */
  portrait?: string;
  /** Derived combat stats for the info panel's expanded read-out. */
  pa?: number;
  ma?: number;
  spd?: number;
  move?: number;
  jump?: number;
  /** Total experience toward the next level, 0-99 in FFT convention. */
  exp?: number;
  /** Spendable JP in the current job. */
  jp?: number;
  /** Read-only tactical loadout shown when inspecting allies or hostiles. */
  loadout?: UnitLoadoutVM;
}

export interface TurnEntryVM {
  unitId: string;
  name: string;
  team: Team;
  portrait?: string;
  /**
   * Job and gender of the unit. Only used when `portrait` is absent, to cast a
   * face that matches the unit instead of hashing across the whole catalogue —
   * see the casting note in `portraits.ts`. Producers are encouraged to pass
   * these (or a correct `portrait`) so the rail never disagrees with the field.
   */
  job?: string;
  gender?: 'male' | 'female' | 'monster';
  /** True for the unit taking its turn right now. */
  current: boolean;
  /** Predicted ticks until this turn begins. Used for the delta labels. */
  ticksUntil: number;
  /**
   * Current / maximum HP, for the sliver drawn under the rail portrait.
   *
   * Optional because the rail has to keep working for producers that do not
   * track HP (the formation preview, replays of a partial log). When both are
   * present the chip grows a team-tinted health bar along its lower edge — the
   * shipped Combat Timeline carries exactly this
   * (refs/curated/fft/press-042310-cfaa9b3e-fft-tic-mediakit-06.png: every
   * timeline entry has a coloured HP sliver under the face, which is how a
   * player picks the wounded enemy out of a queue without hovering anything).
   * Omit both and the chip renders as before.
   */
  hp?: number;
  maxHp?: number;
  /** Optional annotation, e.g. "Fire II" while charging. */
  note?: string;
  /** Rendered faded when the unit is KO'd or otherwise unable to act. */
  disabled?: boolean;
}

export interface CommandItemVM {
  id: string;
  label: string;
  enabled: boolean;
  /** Right-aligned annotation, e.g. "4" for remaining moves. */
  detail?: string;
  /** One-line explanation shown in the footer while highlighted. */
  hint?: string;
  /** Draws the "opens a submenu" chevron. */
  opensSubmenu?: boolean;
  /** Icon key from `icons.ts`. */
  icon?: string;
}

export interface AbilityItemVM {
  id: string;
  name: string;
  description: string;
  mp: number;
  /** Charge time in ticks; 0 = instant. */
  ct: number;
  range: number;
  /** Area of effect radius; 0 = single tile. */
  radius: number;
  vertical?: number;
  element: Element;
  enabled: boolean;
  /** Why the ability is unavailable — shown greyed in the row. */
  reason?: string;
  /** Power/accuracy read-out lines for the detail panel. */
  stats?: readonly { label: string; value: string }[];
}

export interface TargetPreviewVM {
  attackerName: string;
  targetName: string;
  actionName: string;
  /** 0-100. */
  hitChance: number;
  /** Which side of the target the attacker is on. */
  facing: Facing | 'front' | 'side' | 'back';
  /** Relative angle of attack; used for the compass rosette. */
  relative: 'front' | 'side' | 'back';
  targetHp: number;
  targetMaxHp: number;
  /** Damage is positive, healing is negative. Undefined when the action deals neither. */
  amountMin?: number;
  amountMax?: number;
  element?: Element;
  /** Chance of a critical hit, percent. Omitted when criticals cannot occur. */
  critChance?: number;
  /** Post-resolution HP band, already clamped by the caller. */
  resultHpMin?: number;
  resultHpMax?: number;
  statusChances?: readonly { name: string; chance: number; cures?: boolean }[];
  /** Evade / accuracy breakdown lines shown under the hit chance. */
  breakdown?: readonly { label: string; value: string }[];
  /** Rendered in ember red — e.g. "Target is out of range". */
  warning?: string;
}

export type FloatKind =
  | 'damage'
  | 'crit'
  | 'heal'
  | 'miss'
  | 'status'
  | 'status-cure'
  | 'jp'
  | 'exp'
  | 'mp';

export interface FloatTextVM {
  kind: FloatKind;
  /** Numeric payload for damage/heal/jp/exp; ignored for miss/status. */
  value?: number;
  /** Free text for status names and one-off callouts. */
  text?: string;
  element?: Element;
  /** Screen-space anchor in CSS pixels, produced by the renderer's projection. */
  x: number;
  y: number;
  /** Stagger in milliseconds so a multi-hit burst reads as a sequence. */
  delay?: number;
}

export interface JobNodeVM {
  id: string;
  name: string;
  /** Design lineage badge: fft / eq2 / wow / original. */
  origin: string;
  blurb: string;
  /** Job level 1-8. */
  jobLevel: number;
  /** Unspent JP in this job. */
  jp: number;
  totalJp: number;
  unlocked: boolean;
  /** Human-readable unlock requirement when locked. */
  requirement?: string;
  current: boolean;
  /** Tier column in the tree, 0 = Squire/Chemist root. */
  tier: number;
  /** Prerequisite job ids, used to draw the connective tracery. */
  parents: readonly string[];
  /** Learned / learnable count for the progress pip row. */
  learned: number;
  learnable: number;
}

export interface LearnableVM {
  id: string;
  name: string;
  description: string;
  jp: number;
  learned: boolean;
  /** Enough JP banked to learn it right now. */
  affordable: boolean;
  slot: 'action' | 'reaction' | 'support' | 'movement';
}

export interface AbilitySlotVM {
  slot: 'secondary' | 'reaction' | 'support' | 'movement';
  label: string;
  /** Currently assigned ability/ability-set name, or undefined for an empty slot. */
  assignedName?: string;
  assignedId?: string;
  options: readonly { id: string; name: string; description: string }[];
}

export interface JobScreenVM {
  unit: UnitVM;
  jobs: readonly JobNodeVM[];
  /** Abilities of the job currently highlighted in the tree. */
  learnables: readonly LearnableVM[];
  slots: readonly AbilitySlotVM[];
  /** Job id the panel is focused on. */
  selectedJob: string;
  /**
   * When false the screen is a mid-battle viewer: job change, learn and slot
   * assign intents are not emitted. Omitted / true means editable.
   */
  editable?: boolean;
}

export interface FormationSlotVM {
  index: number;
  unitId?: string;
  /** Deployment tile label, e.g. "A3". */
  tile?: string;
  locked?: boolean;
}

export interface FormationScreenVM {
  title: string;
  subtitle?: string;
  slots: readonly FormationSlotVM[];
  roster: readonly UnitVM[];
  /** Deploy limit shown as "4 / 5". */
  maxDeployed: number;
}

export interface WorldNodeVM {
  id: string;
  name: string;
  kind: 'battle' | 'town' | 'event';
  chapter: number;
  position: { x: number; y: number };
  requires: readonly string[];
  state: 'locked' | 'available' | 'completed';
}

export interface WorldMapScreenVM {
  title: string;
  subtitle?: string;
  nodes: readonly WorldNodeVM[];
  objective?: {
    id: string;
    name: string;
    kind: WorldNodeVM['kind'];
    chapter: number;
  };
  gil: number;
}

export interface TitleScreenVM {
  title: string;
  subtitle?: string;
  continueAvailable: boolean;
  overwriteConfirmationRequired: boolean;
}

export interface ShopStockItemVM {
  id: string;
  name: string;
  description: string;
  category: string;
  price: number;
  owned: number;
  affordable: boolean;
}

export interface ShopInventoryItemVM {
  id: string;
  name: string;
  description: string;
  price: number;
  count: number;
}

export interface ShopScreenVM {
  title: string;
  subtitle?: string;
  chapter: number;
  gil: number;
  stock: readonly ShopStockItemVM[];
  inventory: readonly ShopInventoryItemVM[];
}

export type EquipSlotName =
  | 'rightHand'
  | 'leftHand'
  | 'head'
  | 'body'
  | 'accessory';

export interface RosterEquipSlotVM {
  slot: EquipSlotName;
  label: string;
  itemId?: string;
  itemName?: string;
}

export interface RosterInventoryItemVM {
  id: string;
  name: string;
  count: number;
  /** True when the currently focused unit may equip this item. */
  canEquip: boolean;
}

/** Per-unit gear and actions for the roster editor pane. */
export interface RosterUnitEditVM {
  unitId: string;
  equipment: readonly RosterEquipSlotVM[];
  /** Inventory rows with canEquip evaluated for this unit. */
  inventory: readonly RosterInventoryItemVM[];
  /** False when dismissing would empty the company. */
  canDismiss: boolean;
}

export interface RosterScreenVM {
  title: string;
  units: readonly UnitVM[];
  /** Party funds, shown in the header rail. */
  gil?: number;
  /** Optional per-unit footnote, keyed by unit id. */
  notes?: Readonly<Record<string, string>>;
  /**
   * Editable company data. When present the roster is a two-way editor
   * (equip / unequip / rename / dismiss); when absent it is a read-only ledger.
   */
  edits?: Readonly<Record<string, RosterUnitEditVM>>;
}

export interface ResultUnitVM {
  unitId: string;
  name: string;
  portrait?: string;
  job: string;
  expGained: number;
  jpGained: number;
  levelBefore: number;
  levelAfter: number;
  jobLevelBefore: number;
  jobLevelAfter: number;
  /** Abilities auto-learned during the battle, if any. */
  learned?: readonly string[];
  /** True when the unit ended the battle KO'd — greys the row. */
  incapacitated?: boolean;
}

export interface ResultScreenVM {
  outcome: 'victory' | 'defeat';
  title: string;
  subtitle?: string;
  units: readonly ResultUnitVM[];
  loot?: readonly { name: string; count: number; rarity?: 'common' | 'fine' | 'rare' }[];
  gil?: number;
  turns?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intents — everything the UI asks the game layer to do
// ─────────────────────────────────────────────────────────────────────────────

export type UIIntent =
  /** Title screen: create a fresh campaign after any required overwrite confirmation. */
  | { kind: 'title-new-game'; overwriteConfirmed: boolean }
  /** Title screen: load the durable campaign exactly as saved. */
  | { kind: 'title-continue' }
  /** A top-level command row was chosen (`move`, `act`, `item`, `wait`, `status`, …). */
  | { kind: 'command'; id: string }
  /** An ability row was confirmed in the ability submenu. */
  | { kind: 'ability'; id: string }
  /** An item row was confirmed. */
  | { kind: 'item'; id: string }
  /** The highlighted ability changed — the game layer repaints the range overlay. */
  | { kind: 'ability-highlight'; id: string | null }
  /** The highlighted command changed. */
  | { kind: 'command-highlight'; id: string | null }
  /** Back / cancel at the current menu depth. */
  | { kind: 'cancel' }
  /** A turn-order portrait was clicked or focused. */
  | { kind: 'inspect-unit'; unitId: string; focus: boolean }
  /** Camera nudges the UI owns keybinds for. */
  | {
      kind: 'camera';
      action:
        | 'rotate-cw'
        | 'rotate-ccw'
        | 'zoom-in'
        | 'zoom-out'
        | 'reset'
        | 'pan-up'
        | 'pan-down'
        | 'pan-left'
        | 'pan-right';
    }
  /** Job screen: set the unit's current job. */
  | { kind: 'set-job'; unitId: string; jobId: string }
  /** Job screen: the tree cursor moved — the game layer resends `learnables`. */
  | { kind: 'inspect-job'; unitId: string; jobId: string }
  /** Job screen: spend JP to learn an ability. */
  | { kind: 'learn-ability'; unitId: string; jobId: string; abilityId: string }
  /** Job screen: assign a secondary/reaction/support/movement slot. */
  | { kind: 'assign-slot'; unitId: string; slot: AbilitySlotVM['slot']; abilityId: string | null }
  /** Formation screen: place or clear a deployment slot. */
  | { kind: 'formation-assign'; index: number; unitId: string | null }
  /** Formation screen: confirm and start. */
  | { kind: 'formation-confirm' }
  /** World map: travel to an unlocked destination. */
  | { kind: 'world-node-select'; nodeId: string }
  /** World map: open the first roster member's job and JP screen. */
  | { kind: 'world-open-jobs' }
  /** World map: open the company roster. */
  | { kind: 'world-open-roster' }
  /** Shop: buy one stocked item. */
  | { kind: 'shop-buy'; itemId: string }
  /** Shop: sell one item from campaign inventory. */
  | { kind: 'shop-sell'; itemId: string }
  /** Roster screen: open the job screen for a unit. */
  | { kind: 'open-job-screen'; unitId: string }
  /** Roster: equip an inventory item onto a unit. */
  | { kind: 'equip-item'; unitId: string; itemId: string }
  /** Roster: strip an equipment slot back into inventory. */
  | {
      kind: 'unequip-item';
      unitId: string;
      slot: 'rightHand' | 'leftHand' | 'head' | 'body' | 'accessory';
    }
  /** Roster: rename a unit. */
  | { kind: 'rename-unit'; unitId: string; name: string }
  /** Roster: dismiss a unit (refused if it would empty the company). */
  | { kind: 'dismiss-unit'; unitId: string }
  /** A full-screen panel was dismissed. */
  | { kind: 'close-screen'; screen: ScreenName }
  /** Battle results acknowledged. */
  | { kind: 'result-dismiss' };

export type ScreenName =
  | 'title'
  | 'world'
  | 'shop'
  | 'job'
  | 'formation'
  | 'roster'
  | 'result';

export type IntentHandler = (intent: UIIntent) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Root configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface UIOptions {
  /** Base URL for portrait textures. Defaults to `/assets/portraits/`. */
  portraitBase?: string;
  /** Master switch for the synthesised menu sounds. Defaults to true. */
  sound?: boolean;
  /** Honour `prefers-reduced-motion`. Defaults to true. */
  respectReducedMotion?: boolean;
}
