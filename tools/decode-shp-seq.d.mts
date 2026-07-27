/**
 * Types for `tools/decode-shp-seq.mjs`.
 *
 * The decoder is plain ESM JavaScript so it can run from `node` with no build
 * step (the whole asset pipeline works that way — see `tools/build-assets.mjs`).
 * This declaration exists so `tests/animation.test.ts` can import it under
 * `strict` without spraying `any` through the test.
 */

/** A single blit: source rect on the sheet, offset from the unit origin. */
export interface DecodedPart {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  w: number;
  h: number;
  flipX: boolean;
  flipY: boolean;
  sizeIndex: number;
}

export interface DecodedFrame {
  index: number;
  /** High 5 bits of the frame header — an index into the Y-rotation table. */
  yRotation: number;
  /** Second header byte: VRAM / transparency flags. */
  flags: number;
  parts: DecodedPart[];
}

export interface DecodedShpFile {
  name: string;
  swimPtr: number;
  atk: number;
  blockSize: number;
  frameCount: number;
  frames: DecodedFrame[];
  chainEnd: number;
  warnings: string[];
}

export type DecodedOp =
  | { op: 'LoadFrameAndWait'; frame: number; wait: number; code?: undefined; args?: undefined }
  | { op: string; code: number; args: number[]; frame?: undefined; wait?: undefined };

export interface DecodedAnim {
  index: number;
  ops: DecodedOp[];
  terminated: boolean;
  byteLength: number;
}

export interface DecodedSeqFile {
  name: string;
  animCount: number;
  anims: DecodedAnim[];
  warnings: string[];
}

export interface DecodedClip {
  index: number;
  frames: number[];
  durations: number[];
  offsets: [number, number][];
  loop: boolean;
  impactAt: number | null;
}

export interface DecodeResult {
  shp: Record<string, DecodedShpFile>;
  seq: Record<string, DecodedSeqFile>;
  warnings: string[];
}

/** Graphic size table, in tiles, as `[width, height]`, indexed 0-15. */
export const SIZE_TABLE: Record<number, [number, number]>;
export const SIZE_TABLE_SAMPLES: Record<number, number>;
/** `0xFF <opcode>` instruction table: `[name, parameterCount]`. */
export const SEQ_OPS: Record<number, [string, number]>;
export const SPRITE_TYPES: Record<string, { shp: string; seq: string }>;
export const TICK_MS: number;

export function decodeShp(buf: Buffer, name: string): DecodedShpFile;
export function decodeSeq(buf: Buffer, name: string): DecodedSeqFile;
export function decodeAll(dir?: string): DecodeResult;
export function toClip(anim: DecodedAnim): DecodedClip;
export function buildAnimationsJson(decoded: DecodeResult): unknown;
export function scoreShpAgainstSheet(
  shp: DecodedShpFile,
  sheet: { width: number; height: number; data: Uint8Array | Buffer },
): number;
