/**
 * Hand-authored icon set. Every glyph is a small path in a 24x24 box, drawn with
 * `currentColor` so the palette in styles.css controls tone. Inline SVG keeps the
 * icons crisp at any DPI and costs no extra requests.
 */

import type { Element as GameElement, StatusId } from '@core/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Glyph {
  /** Filled sub-paths. */
  fill?: readonly string[];
  /** Stroked sub-paths. */
  stroke?: readonly string[];
  /** Stroke width override. */
  width?: number;
}

/* eslint-disable @typescript-eslint/naming-convention */
const GLYPHS: Record<string, Glyph> = {
  // ── elements ──────────────────────────────────────────────────────────────
  fire: {
    fill: ['M12 2c2.6 3.4 1.2 5.4.4 6.7-.7 1.2-.2 2.6 1 2.6 1.3 0 1.8-1.4 1.8-2.6 2.4 1.9 3.8 4.3 3.8 6.8 0 3.6-3.1 6.5-7 6.5S5 19.1 5 15.5c0-4.6 4.3-6.9 5.2-10.4.2-.9.9-2.2 1.8-3.1z'],
  },
  ice: {
    stroke: ['M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17', 'M9 4l3 2 3-2M9 20l3-2 3 2'],
    width: 1.6,
  },
  lightning: { fill: ['M13.5 2L5 13.4h5.2L9.6 22 19 10.2h-5.4z'] },
  wind: {
    stroke: ['M3 8h11a3 3 0 100-3M3 13h15a3 3 0 110 3M3 18h8a2.5 2.5 0 110 2.5'],
    width: 1.7,
  },
  earth: {
    fill: ['M12 3l9 7-3.5 10h-11L3 10z'],
    stroke: ['M7.5 20L12 10l4.5 10M3 10h18'],
    width: 1.2,
  },
  water: { fill: ['M12 2.5c4 5.2 6.3 8.3 6.3 11.4A6.3 6.3 0 015.7 14c0-3.1 2.3-6.2 6.3-11.5z'] },
  holy: {
    fill: ['M12 1.6l1.9 5.9 6.2.1-5 3.7 1.8 6-4.9-3.6-4.9 3.6 1.8-6-5-3.7 6.2-.1z'],
  },
  dark: {
    fill: ['M17.5 3.2A9 9 0 1017 20.8 10.5 10.5 0 0117.5 3.2z'],
  },
  none: { stroke: ['M12 4v16M4 12h16'], width: 1.4 },

  // ── resources / meters ────────────────────────────────────────────────────
  hp: { fill: ['M12 21S3.5 14.9 3.5 9.2A4.7 4.7 0 0112 6.4a4.7 4.7 0 018.5 2.8C20.5 14.9 12 21 12 21z'] },
  mp: { fill: ['M12 2.2l2.6 6.5 6.9.5-5.3 4.5 1.7 6.8L12 16.8 6.1 20.5l1.7-6.8-5.3-4.5 6.9-.5z'] },
  jp: {
    stroke: ['M9 4h7v10.5a4.5 4.5 0 11-4.5-4.5'],
    width: 2,
  },
  exp: { stroke: ['M4 18l5-6 3.5 3.5L20 6', 'M14.5 6H20v5.5'], width: 1.8 },
  gil: {
    stroke: ['M12 3.2a8.8 8.8 0 100 17.6 8.8 8.8 0 000-17.6M8.6 9.6h6.8M8.6 13.2h6.8M12 6.5v11'],
    width: 1.5,
  },

  // ── commands ──────────────────────────────────────────────────────────────
  move: {
    fill: ['M12 2l3 3h-2v5h5V8l3 3-3 3v-2h-5v5h2l-3 3-3-3h2v-5H6v2l-3-3 3-3v2h5V5H9z'],
  },
  /* A quill at 16px was two hairlines and a dot. Thickened to a solid nib and
     shaft so it holds a silhouette next to the solid sword/shield/book glyphs. */
  act: {
    fill: [
      'M18.4 2.4l3.2 3.2-10.6 10.6-4.2 1 1-4.2z',
      'M6.2 16.2l1.6 1.6-4.6 2.9z',
    ],
  },
  item: {
    stroke: ['M9 7V5.5A3 3 0 0115 5.5V7', 'M4.8 7h14.4l-1.1 12.4a1.6 1.6 0 01-1.6 1.4H7.5a1.6 1.6 0 01-1.6-1.4z'],
    width: 1.6,
  },
  wait: {
    stroke: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17M12 7v5.4l3.6 2.2'],
    width: 1.6,
  },
  status: {
    stroke: ['M12 3l7.5 3v6c0 4.4-3.1 8-7.5 9-4.4-1-7.5-4.6-7.5-9V6z'],
    width: 1.6,
  },
  job: {
    stroke: ['M12 2.6l8 4.2-8 4.2-8-4.2z', 'M4 11.6l8 4.2 8-4.2M4 16.2l8 4.2 8-4.2'],
    width: 1.5,
  },

  /* THE NAMES THE GAME ACTUALLY PASSES.
     -------------------------------------------------------------------------
     `state/viewModels.ts` builds the command row with icon ids `move`, `sword`,
     `book`, `potion`, `shield`, `hourglass`. Only `move` existed here, so five of
     the six rows fell through `GLYPHS[name] ?? GLYPHS['mark']` and rendered the
     SAME concentric-ring rune. Shot at 1920x1080 that is a six-item menu with
     five identical icons — the interface equivalent of the critics' "props repeat
     as literal duplicates", and visible in every frame we have ever submitted.
     Each glyph below is drawn to read at 15px: one dominant silhouette, no
     interior detail finer than the stroke width. */
  /* Upright, not diagonal. A 45-degree blade at 15px collapses into a bare
     hairline stroke with no readable silhouette (verified in shots/ui-r5-b2);
     stood on its pommel the crossguard gives it a shape the eye resolves
     instantly at any size. */
  sword: {
    fill: [
      'M12 1.6l2 3.6v9.4h-4V5.2z',
      'M6.4 14.8h11.2v2.1H6.4z',
      'M11 17.5h2v2.4h-2z',
      'M12 19.4a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2z',
    ],
  },
  book: {
    stroke: [
      'M4 4.6h5.4A2.6 2.6 0 0112 7.2v12a2.2 2.2 0 00-2.2-1.6H4z',
      'M20 4.6h-5.4A2.6 2.6 0 0012 7.2v12a2.2 2.2 0 012.2-1.6H20z',
      'M12 7.2v12',
    ],
    width: 1.5,
  },
  potion: {
    stroke: ['M9.6 2.8h4.8M10.4 2.8v4.4L6.6 15a4.4 4.4 0 003.9 6.2h3a4.4 4.4 0 003.9-6.2l-3.8-7.8V2.8'],
    width: 1.5,
    fill: ['M7.4 14.2h9.2a4.5 4.5 0 01-4 7 4.5 4.5 0 01-5.2-7z'],
  },
  shield: {
    stroke: ['M12 2.6l7.8 3v6.2c0 4.6-3.2 8.4-7.8 9.6-4.6-1.2-7.8-5-7.8-9.6V5.6z'],
    width: 1.6,
    fill: ['M12 5.6l4.8 1.9v4.2c0 2.9-2 5.3-4.8 6.1z'],
  },
  /* Solid caps and a filled lower bulb. The all-stroke version rendered as four
     spindly hairlines that read as noise beside the solid sword and shield. */
  hourglass: {
    fill: [
      'M5.4 2.2h13.2v2.2H5.4zM5.4 19.6h13.2v2.2H5.4z',
      'M9 16c.7-1.9 3-3 3-4.4.9 1.5 2.3 2.5 3 4.4z',
    ],
    stroke: ['M7.6 4.4v2.4c0 2.4 3.2 3.4 3.2 5.2s-3.2 2.8-3.2 5.2v2.4M16.4 4.4v2.4c0 2.4-3.2 3.4-3.2 5.2s3.2 2.8 3.2 5.2v2.4'],
    width: 1.7,
  },
  bow: {
    stroke: ['M4.6 19.4C13 18 18 13 19.4 4.6', 'M19.4 4.6L4.6 19.4', 'M19.4 4.6h-4.2M19.4 4.6v4.2'],
    width: 1.6,
  },
  staff: {
    stroke: ['M6.4 20.6L15.6 8.2'],
    width: 1.8,
    fill: ['M17.4 2.2l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z'],
  },
  banner: {
    stroke: ['M6 2.6v18.8'],
    width: 1.6,
    fill: ['M7.4 3.4h11.2l-2.6 3.9 2.6 3.9H7.4z'],
  },

  // ── statuses ──────────────────────────────────────────────────────────────
  ko: {
    fill: ['M12 2.4A7.6 7.6 0 004.4 10c0 2.6 1.3 4.6 3.1 5.9V19h9v-3.1c1.8-1.3 3.1-3.3 3.1-5.9A7.6 7.6 0 0012 2.4zM9.2 9.6a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2zm5.6 0a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2z', 'M7.5 20.2h9v1.6h-9z'],
  },
  crystal: { fill: ['M12 1.8l5.6 6.4L12 22.2 6.4 8.2z'], stroke: ['M6.4 8.2h11.2M12 1.8v20.4'], width: 0.9 },
  treasure: { stroke: ['M3.6 9.4h16.8v10.2H3.6zM3.6 9.4l1.8-5h13.2l1.8 5M12 9.4v10.2'], width: 1.5 },
  petrify: { fill: ['M12 2.6l8.4 4.9v9.8L12 22.2l-8.4-4.9V7.5z'], stroke: ['M12 2.6v19.6M3.6 7.5L20.4 17.3M20.4 7.5L3.6 17.3'], width: 0.9 },
  stop: { stroke: ['M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17M12 7.4v4.8l3 2', 'M4.6 4.6l14.8 14.8'], width: 1.6 },
  sleep: {
    stroke: ['M13.4 4.2h5.4l-5.4 6.2h5.4M6.2 13h5l-5 5.6h5'],
    width: 1.5,
  },
  charm: { fill: ['M12 21S3.5 14.9 3.5 9.2A4.7 4.7 0 0112 6.4a4.7 4.7 0 018.5 2.8C20.5 14.9 12 21 12 21z'] },
  confuse: {
    stroke: ['M12 12.2a2.6 2.6 0 112.6-2.6c0 3-4 2.4-4 6'],
    width: 1.8,
    fill: ['M11.6 19.4a1.4 1.4 0 102.8 0 1.4 1.4 0 00-2.8 0z'],
  },
  berserk: {
    fill: ['M4 5l4.4 3.2L12 3l3.6 5.2L20 5l-1.6 13.8H5.6z'],
  },
  blind: {
    stroke: ['M2.6 12S6.4 5.8 12 5.8 21.4 12 21.4 12 17.6 18.2 12 18.2 2.6 12 2.6 12z', 'M4 20L20 4'],
    width: 1.6,
  },
  silence: {
    stroke: ['M9.2 16.4V5.6l8-1.6v10.6', 'M4 20L20 4'],
    width: 1.6,
    fill: ['M6.6 14.4a2.6 2.6 0 102.6 2.6 2.6 2.6 0 00-2.6-2.6z'],
  },
  oil: { fill: ['M12 2.5c4 5.2 6.3 8.3 6.3 11.4A6.3 6.3 0 015.7 14c0-3.1 2.3-6.2 6.3-11.5z'] },
  poison: {
    fill: ['M12 2.4A7.6 7.6 0 004.4 10c0 3.6 3.4 6.6 7.6 11.6 4.2-5 7.6-8 7.6-11.6A7.6 7.6 0 0012 2.4zm-2.6 6a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm5.2 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3z'],
  },
  undead: {
    fill: ['M12 2.4A7.6 7.6 0 004.4 10c0 2.6 1.3 4.6 3.1 5.9V19h9v-3.1c1.8-1.3 3.1-3.3 3.1-5.9A7.6 7.6 0 0012 2.4zM9.2 9.6a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2zm5.6 0a1.6 1.6 0 110 3.2 1.6 1.6 0 010-3.2z'],
  },
  frog: {
    stroke: ['M5 9.5a3 3 0 016 0M13 9.5a3 3 0 016 0M4.4 12.6c0 4 3.4 6.6 7.6 6.6s7.6-2.6 7.6-6.6z'],
    width: 1.6,
  },
  slow: { stroke: ['M6.5 3h11M6.5 21h11M8 3c0 4.5 4 5.8 4 9s-4 4.5-4 9M16 3c0 4.5-4 5.8-4 9s4 4.5 4 9'], width: 1.6 },
  haste: { fill: ['M11 2L4 13h4.6L7.4 22 15 10.6h-4.5z', 'M18.4 2l-4 6.4h2.6l-2.2 5.2 5-7.6h-2.6z'] },
  regen: {
    fill: ['M12 21.4c-.4-6 2.6-10.6 8-12.6-.6 6.6-3.6 10.6-8 12.6z'],
    stroke: ['M12 21.4c0-4.4-1.8-7.6-6-9.6M6 3.4c1.8 2.6 2.4 5 2.2 7.2'],
    width: 1.5,
  },
  protect: { stroke: ['M12 2.8l7.6 3v6.4c0 4.4-3.1 8-7.6 9-4.5-1-7.6-4.6-7.6-9V5.8z'], width: 1.8 },
  shell: {
    stroke: ['M12 2.8l8 4.6v9.2L12 21.2 4 16.6V7.4z', 'M12 7l4 2.3v4.6L12 16.2 8 13.9V9.3z'],
    width: 1.4,
  },
  reraise: {
    fill: ['M12 2.6l1.7 4.8 4.8 1.7-4.8 1.7L12 15.6l-1.7-4.8-4.8-1.7 4.8-1.7z'],
    stroke: ['M12 17.4v4M9 19.6l3 2.4 3-2.4'],
    width: 1.5,
  },
  faith: { stroke: ['M12 2.4v19.2M5.6 8.4h12.8M8 15.6h8'], width: 1.8 },
  innocent: { stroke: ['M12 2.4v19.2M5.6 8.4h12.8', 'M3.6 20.4L20.4 3.6'], width: 1.7 },
  float: {
    stroke: ['M6.6 15.4a3.4 3.4 0 01.4-6.8 5 5 0 019.6-1 3.9 3.9 0 01.8 7.8z', 'M7 19.4h10'],
    width: 1.5,
  },
  reflect: {
    stroke: ['M12 2.6v18.8', 'M9.4 6.4L4 12l5.4 5.6M14.6 6.4L20 12l-5.4 5.6'],
    width: 1.6,
  },
  transparent: {
    stroke: ['M2.6 12S6.4 5.8 12 5.8c1.2 0 2.3.3 3.3.7M21.4 12s-3.8 6.2-9.4 6.2c-1.3 0-2.5-.3-3.6-.8'],
    width: 1.6,
    fill: ['M12 9.2a2.8 2.8 0 102.8 2.8A2.8 2.8 0 0012 9.2z'],
  },
  chicken: {
    fill: ['M15.6 4.4a2.4 2.4 0 11-4 1.8L7 9.6c-2 1.6-2.6 4.6-1 7 1.6 2.2 5 2.8 7.6 1.2l4.8-3-2.2-2.4 2.6-1.4z'],
  },
  'death-sentence': {
    fill: ['M12 3.2A6.6 6.6 0 005.4 9.8c0 2.2 1.1 4 2.6 5.1v2.7h8v-2.7c1.5-1.1 2.6-2.9 2.6-5.1A6.6 6.6 0 0012 3.2z'],
    stroke: ['M8 20.2h8M12 6.6v3.4l2.2 1.4'],
    width: 1.3,
  },
  defending: { stroke: ['M12 2.8l7.6 3v6.4c0 4.4-3.1 8-7.6 9-4.5-1-7.6-4.6-7.6-9V5.8z', 'M8.8 12l2.2 2.4 4.2-4.6'], width: 1.6 },
  performing: {
    stroke: ['M9.4 17V5l8.6-1.8V15'],
    width: 1.6,
    fill: ['M6.8 15a2.6 2.6 0 102.6 2.6A2.6 2.6 0 006.8 15zm8.6-1.8a2.6 2.6 0 102.6 2.6 2.6 2.6 0 00-2.6-2.6z'],
  },
  charging: { fill: ['M13.5 2L5 13.4h5.2L9.6 22 19 10.2h-5.4z'] },
  jumping: {
    stroke: ['M4 20h16M12 17.4V6.6M8 10.2L12 6l4 4.2'],
    width: 1.8,
  },
  taunted: {
    fill: ['M4.2 6.4h15.6v9.2h-9L6 19.6v-4h-1.8z'],
    stroke: ['M12 8.6v3.4M12 13.6v.1'],
    width: 1.4,
  },
  rooted: {
    stroke: ['M12 3v10M12 13c0 4-2.6 5.4-6 6.6M12 13c0 4 2.6 5.4 6 6.6M12 8L8.4 5.4M12 8l3.6-2.6'],
    width: 1.7,
  },
  vulnerable: {
    stroke: ['M12 2.8l7.6 3v6.4c0 4.4-3.1 8-7.6 9-4.5-1-7.6-4.6-7.6-9V5.8z', 'M13.6 6.6l-3.4 5.6h3.6l-2.4 5'],
    width: 1.5,
  },
  empowered: {
    fill: ['M12 1.8l2.3 6.1 6.5.3-5.1 4.1 1.7 6.3L12 15l-5.4 3.6 1.7-6.3-5.1-4.1 6.5-.3z'],
  },
  shielded: {
    stroke: ['M12 2.8l7.6 3v6.4c0 4.4-3.1 8-7.6 9-4.5-1-7.6-4.6-7.6-9V5.8z'],
    width: 1.6,
    fill: ['M12 7.4l4 1.6v3.4c0 2.3-1.6 4.2-4 4.8-2.4-.6-4-2.5-4-4.8V9z'],
  },
  bleeding: {
    fill: ['M9 2.6c3 4 4.7 6.2 4.7 8.5A4.7 4.7 0 014.3 11c0-2.3 1.7-4.5 4.7-8.4z', 'M16.6 12.4c1.8 2.4 2.8 3.7 2.8 5a2.8 2.8 0 11-5.6 0c0-1.3 1-2.6 2.8-5z'],
  },
  burning: {
    fill: ['M12 2c2.6 3.4 1.2 5.4.4 6.7-.7 1.2-.2 2.6 1 2.6 1.3 0 1.8-1.4 1.8-2.6 2.4 1.9 3.8 4.3 3.8 6.8 0 3.6-3.1 6.5-7 6.5S5 19.1 5 15.5c0-4.6 4.3-6.9 5.2-10.4.2-.9.9-2.2 1.8-3.1z'],
  },
  mark: {
    stroke: ['M12 4.4a7.6 7.6 0 100 15.2 7.6 7.6 0 000-15.2M12 8.6a3.4 3.4 0 100 6.8 3.4 3.4 0 000-6.8M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3'],
    width: 1.5,
  },
  stealth: {
    stroke: ['M4 18c1.6-4.4 4.4-6.6 8-6.6s6.4 2.2 8 6.6', 'M8.4 6.6a3.6 3.6 0 107.2 0 3.6 3.6 0 00-7.2 0'],
    width: 1.5,
  },
  'evade-next': {
    stroke: ['M4.6 12.6l4 4L19.4 6.2', 'M4.6 18.6h6'],
    width: 2,
  },

  // ── chrome ────────────────────────────────────────────────────────────────
  chevron: { stroke: ['M9 5.5l6 6.5-6 6.5'], width: 2 },
  cursor: { fill: ['M4 3.2L19.4 12 4 20.8z'] },
  lock: { stroke: ['M7.6 10.4V7.6a4.4 4.4 0 018.8 0v2.8M5.6 10.4h12.8v9.2H5.6z'], width: 1.6 },
  check: { stroke: ['M4.6 12.8l4.6 4.6L19.4 6.6'], width: 2.2 },
  cross: { stroke: ['M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4'], width: 2 },
  arrowUp: { fill: ['M12 4.6l6 8h-4v7h-4v-7H6z'] },
  crown: { fill: ['M3.4 8.2l3.6 3 5-6 5 6 3.6-3-1.8 11.4H5.2z'] },
};
/* eslint-enable @typescript-eslint/naming-convention */

/** Statuses that read as beneficial — used for tone when the caller does not say. */
const POSITIVE: ReadonlySet<StatusId> = new Set<StatusId>([
  'haste', 'regen', 'protect', 'shell', 'reraise', 'faith', 'float', 'reflect',
  'transparent', 'defending', 'performing', 'empowered', 'shielded', 'stealth',
  'evade-next', 'charging',
]);

export function statusTone(id: StatusId): 'buff' | 'debuff' | 'neutral' {
  if (POSITIVE.has(id)) return 'buff';
  if (id === 'crystal' || id === 'treasure' || id === 'undead' || id === 'innocent') return 'neutral';
  return 'debuff';
}

/**
 * Semantic names the game layer uses that map onto an existing drawing.
 *
 * Producers name a command after what it *does* (`attack`, `defend`,
 * `battle-skill`); this sheet names glyphs after what they *are* (`sword`,
 * `shield`, `book`). Without this table every one of those resolved to the
 * fallback rune, which is how six menu rows ended up sharing one icon.
 */
const ALIASES: Readonly<Record<string, string>> = {
  attack: 'sword',
  strike: 'sword',
  weapon: 'sword',
  defend: 'shield',
  guard: 'shield',
  skill: 'book',
  magic: 'book',
  magick: 'book',
  spell: 'book',
  'battle-skill': 'sword',
  'basic-skill': 'book',
  'white-magick': 'staff',
  'black-magick': 'staff',
  sing: 'banner',
  dance: 'banner',
  arrow: 'bow',
  aim: 'bow',
  charge: 'bow',
  flask: 'potion',
  elixir: 'potion',
  clock: 'hourglass',
  end: 'hourglass',
  rest: 'hourglass',
};

function resolveGlyph(name: string): string {
  if (name in GLYPHS) return name;
  const alias = ALIASES[name];
  return alias !== undefined && alias in GLYPHS ? alias : 'mark';
}

export function hasIcon(name: string): boolean {
  return name in GLYPHS || (ALIASES[name] !== undefined && ALIASES[name]! in GLYPHS);
}

/**
 * Build an `<svg>` for the named glyph. Unknown names fall back to a neutral
 * rune so a missing icon degrades to a mark rather than an empty box.
 */
export function icon(name: string, className?: string): SVGSVGElement {
  const glyph = GLYPHS[resolveGlyph(name)];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('et-icon');
  if (className) {
    for (const c of className.split(/\s+/)) if (c) svg.classList.add(c);
  }
  if (!glyph) return svg;
  for (const d of glyph.fill ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
  }
  for (const d of glyph.stroke ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', String(glyph.width ?? 1.6));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
  }
  return svg;
}

/** Element → icon name. Kept separate so the element list can grow independently. */
export function elementIcon(e: GameElement): string {
  return e;
}

/** Element → CSS custom-property colour token used for tints and glows. */
export function elementColor(e: GameElement): string {
  switch (e) {
    case 'fire': return 'var(--el-fire)';
    case 'ice': return 'var(--el-ice)';
    case 'lightning': return 'var(--el-lightning)';
    case 'wind': return 'var(--el-wind)';
    case 'earth': return 'var(--el-earth)';
    case 'water': return 'var(--el-water)';
    case 'holy': return 'var(--el-holy)';
    case 'dark': return 'var(--el-dark)';
    default: return 'var(--ink-bright)';
  }
}
