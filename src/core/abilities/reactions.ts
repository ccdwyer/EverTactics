/**
 * EverTactics — reaction abilities.
 *
 * Reactions live in `Unit.reaction` and fire when the unit is targeted or hit.
 * `accuracy` is the *base* trigger chance before the Bravery scaling that
 * `combat/` applies (FFT convention: trigger% = accuracy * Brave / 100), so a
 * reaction with accuracy 100 fires at Brave% and one with accuracy 50 at half that.
 *
 * `power` carries the reaction's magnitude — a multiplier, a percentage or a flat
 * value depending on `formula` — and `REACTION_TRIGGERS` says *when* each one fires.
 */

import type { Ability, AbilityId } from '../types';
import { defineAbilities, inf, MEDIUM, R, SELF, SHORT, type AbilitySpec } from './sets';

/** What has to happen for a reaction to get its roll. */
export type ReactionTrigger =
  | 'physical-hit'     // struck by a physical attack that connected
  | 'magical-hit'      // struck by a spell that connected
  | 'any-hit'          // struck by anything that connected
  | 'targeted'         // targeted at all, before the hit roll resolves
  | 'damage-taken'     // took damage from any source, including a DoT tick
  | 'hp-critical'      // dropped below 25% HP
  | 'ko'               // reduced to 0 HP
  | 'status-applied'   // an ailment landed
  | 'ally-hit';        // an adjacent ally was struck

export interface ReactionMeta {
  readonly ability: AbilityId;
  readonly trigger: ReactionTrigger;
  /** Reaction resolves before the incoming hit rather than after it. */
  readonly preemptive?: boolean;
  /** Cancels the incoming attack entirely when it fires. */
  readonly negates?: boolean;
}

const REACTION_META_LIST: readonly ReactionMeta[] = [
  { ability: 'counter', trigger: 'physical-hit' },
  { ability: 'counter-tackle', trigger: 'physical-hit' },
  { ability: 'counter-magick', trigger: 'magical-hit' },
  { ability: 'blade-grasp', trigger: 'targeted', preemptive: true, negates: true },
  { ability: 'hamedo', trigger: 'targeted', preemptive: true, negates: true },
  { ability: 'reflexes', trigger: 'targeted', preemptive: true, negates: true },
  { ability: 'arrow-guard', trigger: 'targeted', preemptive: true, negates: true },
  { ability: 'riposte', trigger: 'targeted', preemptive: true },
  { ability: 'auto-potion', trigger: 'damage-taken' },
  { ability: 'damage-split', trigger: 'physical-hit' },
  { ability: 'absorb-mp', trigger: 'magical-hit' },
  { ability: 'mp-switch', trigger: 'any-hit' },
  { ability: 'regenerator', trigger: 'damage-taken' },
  { ability: 'dragon-spirit', trigger: 'ko' },
  { ability: 'critical-quick', trigger: 'hp-critical' },
  { ability: 'brave-up', trigger: 'damage-taken' },
  { ability: 'meatbone-slash', trigger: 'hp-critical' },
  { ability: 'pa-save', trigger: 'damage-taken' },
  { ability: 'ma-save', trigger: 'magical-hit' },
  { ability: 'speed-save', trigger: 'damage-taken' },
  { ability: 'sunken-state', trigger: 'any-hit' },
  { ability: 'caution', trigger: 'damage-taken' },
  { ability: 'distribute', trigger: 'damage-taken' },
  { ability: 'face-up', trigger: 'status-applied' },
  { ability: 'retaliation', trigger: 'any-hit' },
  { ability: 'vengeance', trigger: 'damage-taken' },
  { ability: 'guardian-angel', trigger: 'ally-hit' },
  { ability: 'last-word', trigger: 'ko' },
  { ability: 'thorned-hide', trigger: 'physical-hit' },
  { ability: 'shadow-recoil', trigger: 'any-hit' },
];

export const REACTION_TRIGGERS: ReadonlyMap<AbilityId, ReactionMeta> = new Map(
  REACTION_META_LIST.map((m) => [m.ability, m]),
);

const SPECS: readonly AbilitySpec[] = [
  // ── FFT canon ────────────────────────────────────────────────────────────
  { id: 'counter', name: 'Counter', description: 'Answer a physical blow with one of your own, at full weapon power. The oldest habit a soldier has.',
    range: MELEE_R(), formula: 'physical', power: 1, accuracy: 100, vfx: 'react/counter', castAnim: 'attack' },
  { id: 'counter-tackle', name: 'Counter Tackle', description: 'No blade — just your whole weight, driven back into whoever hit you.',
    range: MELEE_R(), formula: 'physical', power: 2, accuracy: 75, vfx: 'react/tackle', castAnim: 'attack' },
  { id: 'counter-magick', name: 'Counter Magick', description: 'Return a spell for a spell. Whatever they cast on you, you cast back at half force.',
    range: R(4), formula: 'magical', power: 12, accuracy: 60, vfx: 'react/counter-magick', castAnim: 'cast' },
  { id: 'blade-grasp', name: 'Blade Grasp', description: 'Catch the incoming weapon between your palms. Works absurdly often, on absurdly large weapons.',
    range: SELF, formula: 'special', power: 0, accuracy: 100, vfx: 'react/blade-grasp', castAnim: 'defend' },
  { id: 'hamedo', name: 'Hamedo', description: 'Strike first, and strike so decisively that their attack never happens at all.',
    range: MELEE_R(), formula: 'physical', power: 1, accuracy: 75, vfx: 'react/hamedo', castAnim: 'attack' },
  { id: 'reflexes', name: 'Reflexes', description: 'Not a block — simply not being there. Evasion rises steeply against attacks you can see.',
    range: SELF, formula: 'special', power: 0, accuracy: 80, vfx: 'react/reflexes', castAnim: 'defend' },
  { id: 'arrow-guard', name: 'Arrow Guard', description: 'Read the shot off the draw and turn it aside with the shield edge.',
    range: SELF, formula: 'special', power: 0, accuracy: 90, vfx: 'react/arrow-guard', castAnim: 'defend' },
  { id: 'auto-potion', name: 'Auto-Potion', description: 'Reach for the belt without thinking. Consumes the weakest healing item you carry.',
    range: SELF, formula: 'heal', power: 30, accuracy: 100, vfx: 'react/auto-potion', castAnim: 'item' },
  { id: 'damage-split', name: 'Damage Split', description: 'Share the blow evenly with whoever landed it. They rarely expect the arrangement.',
    range: MELEE_R(), formula: 'special', power: 50, accuracy: 75, vfx: 'react/damage-split', castAnim: 'defend' },
  { id: 'absorb-mp', name: 'Absorb MP', description: 'Catch the spell\'s aether as it lands and keep it. Silence is only a problem for them.',
    range: SELF, formula: 'drain', power: 100, accuracy: 75, vfx: 'react/absorb-mp', castAnim: 'defend' },
  { id: 'mp-switch', name: 'MP Switch', description: 'Take the damage out of your aether instead of your body. Expensive; occasionally decisive.',
    range: SELF, formula: 'special', power: 100, accuracy: 80, vfx: 'react/mp-switch', castAnim: 'defend' },
  { id: 'regenerator', name: 'Regenerator', description: 'Wounds start closing the instant they open. Applies Regen whenever you are hurt.',
    range: SELF, formula: 'buff', power: 0, accuracy: 100, vfx: 'react/regenerator', castAnim: 'defend',
    inflicts: [inf('regen', 100, MEDIUM)] },
  { id: 'dragon-spirit', name: 'Dragon Spirit', description: 'The blood of wyrms refuses a first death. Auto-Reraise, permanently, at no cost.',
    range: SELF, formula: 'buff', power: 0, accuracy: 100, vfx: 'react/dragon-spirit', castAnim: 'defend',
    inflicts: [inf('reraise', 100)] },
  { id: 'critical-quick', name: 'Critical: Quick', description: 'Cornered and bleeding, you get your turn immediately. Some of the best plays start here.',
    range: SELF, formula: 'special', power: 100, accuracy: 100, vfx: 'react/critical-quick', castAnim: 'defend' },
  { id: 'brave-up', name: 'Brave Up', description: 'Being hit only makes you steadier. Bravery rises, and with it every other reaction you own.',
    range: SELF, formula: 'buff', power: 8, accuracy: 60, vfx: 'react/brave-up', castAnim: 'defend' },
  { id: 'meatbone-slash', name: 'Meatbone Slash', description: 'On the edge of death, hit back for exactly as much life as you have left.',
    range: MELEE_R(), formula: 'special', power: 100, accuracy: 50, vfx: 'react/meatbone', castAnim: 'attack' },
  { id: 'pa-save', name: 'PA Save', description: 'Every wound taken makes the arm harder. Attack rises permanently each time you are hurt.',
    range: SELF, formula: 'buff', power: 1, accuracy: 60, vfx: 'react/pa-save', castAnim: 'defend' },
  { id: 'ma-save', name: 'MA Save', description: 'Spells that land teach you something. Magick rises permanently each time one does.',
    range: SELF, formula: 'buff', power: 1, accuracy: 60, vfx: 'react/ma-save', castAnim: 'defend' },
  { id: 'speed-save', name: 'Speed Save', description: 'Pain sharpens the reflexes. Speed rises permanently whenever you take damage.',
    range: SELF, formula: 'buff', power: 1, accuracy: 40, vfx: 'react/speed-save', castAnim: 'defend' },
  { id: 'sunken-state', name: 'Sunken State', description: 'Vanish the moment you are struck. Transparent until you act, and untouchable meanwhile.',
    range: SELF, formula: 'buff', power: 0, accuracy: 60, vfx: 'react/sunken-state', castAnim: 'defend',
    inflicts: [inf('transparent', 100, SHORT)] },
  { id: 'caution', name: 'Caution', description: 'Being hurt puts you on your guard for the rest of the turn.',
    range: SELF, formula: 'buff', power: 0, accuracy: 80, vfx: 'react/caution', castAnim: 'defend',
    inflicts: [inf('defending', 100, SHORT)] },
  { id: 'distribute', name: 'Distribute', description: 'Any healing beyond what you needed is passed along to the allies around you.',
    range: SELF, formula: 'heal', power: 100, accuracy: 100, vfx: 'react/distribute', castAnim: 'cast' },
  { id: 'face-up', name: 'Face Up', description: 'Shake off an ailment the instant it takes hold — sometimes.',
    range: SELF, formula: 'status-only', power: 0, accuracy: 50, vfx: 'react/face-up', castAnim: 'defend',
    cures: ['sleep', 'confuse', 'charm', 'berserk', 'blind', 'silence', 'frog', 'chicken', 'taunted', 'rooted'] },

  // ── EQ2 / WoW lineage ────────────────────────────────────────────────────
  { id: 'retaliation', name: 'Retaliation', description: 'A guardian\'s reflex: every attacker who reaches you leaves with a shield-shaped wound.',
    range: MELEE_R(), formula: 'physical', power: 1, accuracy: 85, vfx: 'react/retaliation', castAnim: 'attack',
    inflicts: [inf('taunted', 50, SHORT)] },
  { id: 'vengeance', name: 'Vengeance', description: 'Damage taken is stored and added to your next strike. Patience is a weapon.',
    range: SELF, formula: 'buff', power: 50, accuracy: 100, vfx: 'react/vengeance', castAnim: 'defend',
    inflicts: [inf('empowered', 100, SHORT)] },
  { id: 'riposte', name: 'Riposte', description: 'Parry on the blade, then answer along the same line before they recover it.',
    range: MELEE_R(), formula: 'physical', power: 2, accuracy: 55, vfx: 'react/riposte', castAnim: 'attack',
    inflicts: [inf('bleeding', 40, SHORT)] },
  { id: 'guardian-angel', name: 'Guardian Angel', description: 'When an adjacent ally is struck, step in and take it instead. You always could.',
    range: R(1, 0, { vertical: 2 }), formula: 'special', power: 100, accuracy: 70,
    vfx: 'react/guardian-angel', castAnim: 'defend' },
  { id: 'last-word', name: 'Last Word', description: 'You do not fall quietly. On death, everything adjacent takes a parting blow.',
    range: R(0, 1, { self: true, los: false, vertical: 2 }), formula: 'physical', power: 3, accuracy: 100,
    element: 'dark', vfx: 'react/last-word', castAnim: 'attack' },
  { id: 'thorned-hide', name: 'Thorned Hide', description: 'A warden\'s bark-skin. Melee attackers cut themselves open on you.',
    range: MELEE_R(), formula: 'fixed', power: 14, accuracy: 100, element: 'earth',
    vfx: 'react/thorns', castAnim: 'defend', inflicts: [inf('bleeding', 30, SHORT)] },
  { id: 'shadow-recoil', name: 'Shadow Recoil', description: 'Slip a step out of the world when hit, reappearing behind your attacker.',
    range: SELF, formula: 'move', power: 2, accuracy: 55, vfx: 'react/shadow-recoil', castAnim: 'run',
    inflicts: [inf('stealth', 100, SHORT)] },
];

/** Adjacent-tile range for counter-flavoured reactions. */
function MELEE_R() {
  return R(1, 0, { vertical: 2 });
}

export const REACTION_ABILITIES: readonly Ability[] = defineAbilities('reaction', 'reaction', SPECS);
