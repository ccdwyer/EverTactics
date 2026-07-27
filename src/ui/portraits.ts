/**
 * Portrait rendering.
 *
 * The shipped face textures are 520x388 atlases; the assembled 128x192 portrait
 * sits at (391, 1). We display it by background-cropping the atlas at an integer
 * scale so the pixel art never resamples softly.
 */

import { div } from './dom';
import { PORTRAIT_ATLAS, PORTRAIT_FILES } from './portraitCatalog';

let base = '/assets/portraits/';

export function setPortraitBase(url: string): void {
  base = url.endsWith('/') ? url : `${url}/`;
}

export function portraitUrl(file: string): string {
  return `${base}${file}`;
}

/** All portrait filenames available on disk. */
export function portraitFiles(): readonly string[] {
  return PORTRAIT_FILES;
}

/**
 * Deterministic portrait pick for a unit that has no explicit one assigned.
 * Same id always yields the same face, so rosters stay stable across sessions.
 */
export function portraitForId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % PORTRAIT_FILES.length;
  return PORTRAIT_FILES[idx] ?? PORTRAIT_FILES[0] ?? '';
}

export type PortraitSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Displayed widths in CSS pixels; heights follow the 128:192 (2:3) aspect.
 *
 * Sized against the reference games at 1080p, where a unit-panel face is roughly
 * 150px wide and a turn-order face roughly 60px — the portrait is a primary read,
 * not a decoration beside the name.
 */
const SIZES: Record<PortraitSize, number> = { xs: 36, sm: 58, md: 80, lg: 132 };

export interface PortraitOptions {
  size?: PortraitSize;
  /** Crop to the head only — used by the compact turn-order chips. */
  head?: boolean;
  /** Extra classes on the wrapper. */
  className?: string;
}

/**
 * Build a framed portrait element. The frame is CSS; the inner node is a scaled
 * crop of the atlas. Falls back to an engraved silhouette when no file is given.
 */
export function portrait(file: string | undefined, opts: PortraitOptions = {}): HTMLDivElement {
  const size = opts.size ?? 'md';
  const w = SIZES[size];
  const wrap = div(`et-portrait et-portrait--${size}${opts.className ? ` ${opts.className}` : ''}`);
  const frameH = opts.head ? Math.round((w * 5) / 6) : Math.round((w * 3) / 2);
  wrap.style.width = `${w}px`;
  wrap.style.height = `${frameH}px`;

  const img = div('et-portrait__img');
  if (file) {
    const cell = PORTRAIT_ATLAS.full;
    // Scale so the 128px-wide crop exactly fills the frame width.
    const scale = w / cell.w;
    img.style.backgroundImage = `url("${portraitUrl(file)}")`;
    img.style.backgroundSize = `${PORTRAIT_ATLAS.sheetWidth * scale}px ${PORTRAIT_ATLAS.sheetHeight * scale}px`;
    img.style.backgroundPosition = `${-cell.x * scale}px ${-cell.y * scale}px`;
    img.style.width = `${w}px`;
    img.style.height = `${cell.h * scale}px`;
  } else {
    img.classList.add('et-portrait__img--empty');
  }
  wrap.appendChild(img);
  wrap.appendChild(div('et-portrait__gloss'));
  return wrap;
}
