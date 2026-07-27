/**
 * EverTactics — unit sprites.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SHEET LAYOUT (measured from the shipped assets, not assumed)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every human sheet in `public/assets/sprites/` is 512 texels wide and packs its
 * frames into 64-texel columns. The *first band* — 8 columns x 80 texels — holds
 * the whole-body standing poses; everything below it is the original SHP body-part
 * atlas (heads, limbs, cape segments) that the FFT engine reassembles per frame
 * from the `*_shp.bin` / `*_seq.bin` data in `assets-src/unit/`.
 *
 * Verified on 1000_Knight_Male_hd:
 *   - a fully transparent scanline band sits at y = 80..87, and again around 160,
 *     so the first band is exactly 80 texels tall,
 *   - cells 2 and 4 are the only horizontally symmetric poses (front and back),
 *     and cell 4 carries ~3x the cape pixels of cell 2, identifying which is which,
 *   - cells 0, 1 and 3 all put the cape right of centre and the face left of it —
 *     i.e. all asymmetric art is drawn facing screen-left, so the right-facing
 *     poses come from mirroring, exactly as the original engine did it.
 * The same band structure holds across the human sheets sampled (knight, monk,
 * black mage). **Monster sheets have no whole-body band at all** — a chocobo sheet
 * is parts from the first row down — so monsters need the SHP/SEQ decode before
 * they can be posed. `SpriteSheetOverrides` exists so the asset pipeline can drop
 * real layouts and clips in without touching this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRISPNESS
 * ─────────────────────────────────────────────────────────────────────────────
 * `camera.ts` sizes the orthographic frustum so one world unit is exactly
 * `TEXELS_PER_UNIT * pixelScale` device pixels, and phase-locks the world origin
 * onto a whole device pixel. That is necessary but not sufficient for sprites: a
 * billboard's origin is an arbitrary world point, and once the camera yaw is 45°
 * an on-lattice world position no longer projects to an on-lattice screen
 * position. So every sprite is additionally snapped **in view space** — where the
 * x and y axes are literally screen right and screen up — to a whole device pixel
 * before being written back to world space. Quad half-width is a whole number of
 * texels, so once the origin is on a pixel every texel boundary is too.
 *
 * Because the camera is orthographic, translating along view −Z is a pure depth
 * change with zero screen movement, which is how the sprites get their depth bias
 * without visibly floating.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEPTH
 * ─────────────────────────────────────────────────────────────────────────────
 * Sprites are **opaque**: alpha cut-out by `discard`, full depth write, no
 * blending, no manual sort order. That is the only arrangement in which a unit
 * behind a cliff is correctly occluded, two units correctly occlude each other,
 * and nothing pops when the camera turns. The alpha cut-out is repeated in a
 * matching `MeshDepthMaterial` so the unit casts its real silhouette into the
 * shadow map rather than a rectangle.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GROUNDING
 * ─────────────────────────────────────────────────────────────────────────────
 * Four separate things have to agree before a billboard reads as standing *in*
 * the scene rather than in front of it, and all four live here or in
 * `materials/sprite.ts`:
 *
 *  1. **Position.** `terrain.ts` centres tile (x, y) on world (x, y) — the top
 *     face spans ±TILE_SIZE/2 about the *integer* coordinate. Anchoring a unit
 *     at (x + 0.5, y + 0.5) puts it on the corner where four tiles meet, which
 *     is what every unit was doing.
 *  2. **A real cast shadow.** See `shadowSide` in `materials/sprite.ts`: three
 *     renders the shadow pass back-faces-only for a `FrontSide` material, which
 *     silently discards a camera-facing billboard whenever the light is on the
 *     camera's side.
 *  3. **Contact darkening** — a tight multiply patch on the tile, covering the
 *     hairline the shadow map cannot resolve at the feet.
 *  4. **Exposure parity.** A billboard presents a near-perfect normal to any
 *     light it faces and therefore over-collects direct light compared with the
 *     terrain around it; `uDirectGain` discounts that back down.
 */

import * as THREE from 'three';

import type {
  ActiveStatus,
  AnimName,
  Facing,
  StatusId,
  Team,
  Unit,
  UnitId,
  Vec3,
} from '@core/types';

import { HEIGHT_UNIT, TILE_SIZE, texelsToWorld } from '@render/camera';

import {
  DEFAULT_VIEW_CELL,
  PathWalker,
  SpriteAnimator,
  defaultAnimationSet,
  facingFromDelta,
  resolveView,
  type AnimSet,
  type PathWalkOptions,
  type PlayOptions,
  type ViewKey,
} from '@render/animation';

import {
  TEAM_TARGET_HUE,
  createIndexTexture,
  createPaletteTexture,
  createSpriteMaterial,
  isPaletteEmpty,
  loadActPalette,
  loadIndexedImage,
  pickPaletteSlot,
  type IndexedImage,
  type SpriteMaterialBundle,
} from '@render/materials/sprite';

// ─────────────────────────────────────────────────────────────────────────────
// Asset resolution
// ─────────────────────────────────────────────────────────────────────────────

const SPRITES_DIR = 'assets/sprites';
const PALETTES_DIR = 'assets/palettes';

/**
 * Default asset root. Vite rewrites `import.meta.env.BASE_URL` at build time, so
 * this stays correct when the game is deployed under a sub-path.
 */
function defaultBaseUrl(): string {
  const base = import.meta.env?.BASE_URL;
  return typeof base === 'string' && base.length > 0 ? base : '/';
}

/**
 * Logical sprite key → numeric sheet id, packed as `key:id` pairs.
 *
 * Generated by walking `public/assets/sprites/`, lower-casing the descriptive
 * part of each filename and preferring the generic-class block (ids ≥ 980) when a
 * name appears more than once — so `knight_male` resolves to the job sprite at
 * 1000 rather than to one of the story-event duplicates. The filename rebuilds
 * exactly as `${id}_${TitleCase(key)}_hd.png` for all 290 entries.
 */
const SHEET_ID_TABLE =
  '10yo_female:956 10yo_male:954 20yo_female:960 20yo_male:958 40yo_female:964 40yo_male:962 ' +
  '60yo_female:968 60yo_male:966 adrammelech:946 agrias:880 ahriman:1082 ahriman_2:1131 ajora:909 ' +
  'aliste:1124 alma:907 alma_dead:904 altima:938 altima_second_form:952 apanda:1100 apanda_2:1133 ' +
  'archer_female:1006 archer_male:1004 argath:842 argath_dark_knight:1122 arithmetician_female:1058 ' +
  'arithmetician_male:1056 automaton:1108 automaton_2:1138 automaton_3:1139 automaton_4:1140 ' +
  'automaton_5:1141 balthier:1118 bard_male:1060 barich:902 barrington:878 behemoth:1094 ' +
  'behemoth_2:1132 belias:930 beowulf:882 black_mage_female:1018 black_mage_male:1016 bomb:1072 ' +
  'bomb_2:1134 bremondt:1126 bremondt_dark_dragon:1128 chemist_female:998 chemist_male:996 ' +
  'chocobo:1068 cletienne:898 cloud:910 cockatrice:1084 cockatrice_2:1144 coeurl:1074 coeurl_2:1137 ' +
  'cuchulainn:942 dancer_female:1062 dark_knight_female:1112 dark_knight_male:1110 delacroix:868 ' +
  'delita_ch1:836 delita_ch23:838 delita_ch4:840 demon:1106 demon_2:1135 dragon:1096 ' +
  'dragoon_female:1046 dragoon_male:1044 dycedarg:846 elidibus:1102 elmdore:874 event_001:1146 ' +
  'event_002:1147 event_003:1148 event_004:1149 event_005:1150 event_006:1151 event_007:1152 ' +
  'event_008:1153 event_009:1154 event_010:1155 event_011:1156 event_012:1157 event_013:1158 ' +
  'event_014:1159 event_015:1160 event_016:1161 event_017:1162 event_018:1163 event_019:1164 ' +
  'event_020:1165 event_021:1166 event_022:1167 event_023:1168 event_024:1169 event_025:1170 ' +
  'event_026:1171 event_027:1172 event_028:1173 event_029:1174 event_030:1175 event_031:1176 ' +
  'event_032:1177 event_033:1178 event_034:1179 event_035:1180 event_036:1181 event_037:1182 ' +
  'event_038:1183 event_039:1184 event_040:1185 event_041:1186 event_042:1187 event_043:1188 ' +
  'event_044:1189 event_045:1190 event_046:1191 event_047:1192 event_048:1193 event_049:1194 ' +
  'event_050:1195 event_051:1196 event_052:1197 event_053:1198 event_054:1199 event_055:1200 ' +
  'event_056:1201 event_057:1202 event_058:1203 event_059:1204 event_060:1205 event_061:1206 ' +
  'event_062:1207 event_063:1208 event_064:1209 event_065:1210 event_066:1211 event_067:1212 ' +
  'event_068:1213 event_069:1214 event_070:1215 event_071:1216 event_072:1217 event_073:1218 ' +
  'event_074:1219 event_075:1220 event_076:1221 event_077:1222 event_078:1223 event_079:1224 ' +
  'event_080:1225 event_081:1226 event_082:1227 event_083:1228 event_084:1229 event_085:1230 ' +
  'event_086:1231 event_087:1232 event_088:1233 event_089:1234 event_090:1235 event_091:1236 ' +
  'event_092:1237 event_093:1238 event_094:1239 event_095:1240 event_096:1241 event_097:1242 ' +
  'event_098:1243 event_099:1244 event_100:1245 event_101:1246 event_102:1247 event_103:1248 ' +
  'event_104:1249 event_105:1250 event_106:1251 event_107:1252 event_108:1253 event_109:1254 ' +
  'event_110:1255 event_111:1256 event_112:1257 event_113:1258 event_114:1259 event_115:1260 ' +
  'event_116:1261 event_117:1262 event_118:1263 event_119:1264 event_120:1265 event_121:1266 ' +
  'event_122:1267 event_123:1268 event_124:1269 event_125:1270 event_126:1271 event_127:1272 ' +
  'event_128:1273 event_129:1274 event_130:1275 event_131:1276 event_132:1277 event_133:1278 ' +
  'event_134:1279 event_135:1280 event_136:1281 event_137:1282 event_138:1283 event_139:1284 ' +
  'event_140:1285 event_141:1286 folmarv:892 funebris:856 funeral_man:974 funeral_priest:978 ' +
  'funeral_woman:976 gaffgarion:866 geomancer_female:1042 geomancer_male:1040 ghost:1080 goblin:1070 ' +
  'goltanna:850 hashmal:936 isilud:896 knight_female:1002 knight_male:1000 larg:848 lettie:928 ' +
  'loffrey:894 ludovich:890 luso:1120 malboro:1092 malboro_2:1143 marach:872 master_sword:1130 ' +
  'meliadoul:905 mime_female:1066 mime_male:1064 minotaur:1090 minotaur_2:1142 monk_female:1010 ' +
  'monk_male:1008 mustadio:888 mystic_female:1038 mystic_male:1036 ninja_female:1054 ninja_male:1052 ' +
  'old_funeral_man:970 old_funeral_woman:972 onion_knight_female:1116 onion_knight_male:1114 ' +
  'orator_female:1034 orator_male:1032 orlandeau:854 orran:864 ovelia:852 pig:1086 pig_2:1145 ' +
  'ramuza_ch1:830 ramuza_ch23:832 ramuza_ch4:834 rapha:870 reis:858 reis_dragon_form:950 ' +
  'samurai_female:1050 samurai_male:1048 simon:862 skeleton:1078 squid:1076 squire_female:994 ' +
  'squire_male:980 summoner_female:1026 summoner_male:1024 thief_female:1030 thief_male:1028 ' +
  'tiamat:1098 tiamat_2:1136 tietra:876 time_mage_female:1022 time_mage_male:1020 treant:1088 ' +
  'valmafra:886 white_mage_female:1014 white_mage_male:1012 wiegraf_ch1:884 wiegraf_ch23:900 ' +
  'zalbaag:844 zalbaag_zombie:912 zalmour:860 zelera:932';

/**
 * Sheet id → `.act` palette family, packed as `family=id,id,…`.
 *
 * **Derived, not guessed.** For every sheet the baked PLTE was compared byte-for-byte
 * against every `battle_*_battle_pal*.act`; 416 of the 457 sheets match exactly one
 * family's `pal1`, which is the mapping below. (The 41 unmatched sheets are the
 * War-of-the-Lions additions — Dark Knight, Onion Knight, Balthier, Luso and the
 * Aliste/Bremondt set — for which no `.act` family ships. They render from their
 * baked palette, so their team colour falls back to slot 0.)
 */
const PALETTE_FAMILY_TABLE =
  '10m=954,955,1162 10w=956,957 20m=958,959 20w=960,961,1181 40m=962,963 ' +
  '40w=964,965,966,967,1214 60w=968,969 adora=946,947 aguri=880,881,914,915,1173,1179,1192,1286 ' +
  'ajora=909,1257,1268 arli=1082,1083,1131 aru=842,843,1150,1151,1152,1163,1164,1167 arufu=928,929 ' +
  'aruma=904,907,908,1213,1228,1229 arute=938,939 bariten=878,879,1230,1231 baru=886,887 ' +
  'baruna=866,867,1191,1193 behi=1094,1095,1132 beio=882,883,1280,1281,1282 biburos=1100,1101,1133 ' +
  'bom=1072,1073,1134 cloud=910,911 cyoko=1068,1069 cyomon1=970,971 cyomon2=972,973 cyomon3=974,975 ' +
  'cyomon4=976,977 daisu=846,847,1171,1180,1251,1252,1253 demon=1106,1107,1135 dily=836,837 ' +
  'dily2=838,839,1175,1196,1197,1198,1215,1216,1258,1259 dily3=840,841,1236,1237,1270,1271 ' +
  'dora=868,869,1194,1195 dora1=1096,1097,1104,1105 dora2=1098,1099,1136 eru=874,875,1254 ' +
  'furaia=876,877,1165,1166,1170 fusui_m=1040,1041 fusui_w=1042,1043 fyune=856,857 gando=872,873,1218 ' +
  'garu=888,889,1178,1183,1184,1185,1190 gin_m=1060,1061 gob=1070,1071 goru=850,851,1203 h75=894,895 ' +
  'h76=896,897 h77=898,899 h78=900,901,1222,1223 h79=870,871 h80=905,906,1262 h81=902,903 ' +
  'hasyu=936,937 hebi=1102,1103 hime=852,853,1176,1177 hyou=1074,1075,1137 ika=1076,1077 ' +
  'item_m=996,997 item_w=916,917,998,999 kanzen=952,953 ki=1088,1089 ' +
  'knight_m=1000,1001,1153,1154,1158,1182,1225,1247,1279 knight_w=1002,1003,1156 ' +
  'kuro_m=920,921,940,941,1016,1017 kuro_w=1018,1019 kyuku=942,943 ' +
  'mina_m=924,925,980,981,982,983,984,985,986,987,988,989,990,991,992,993,1217 mina_w=994,995 ' +
  'minota=1090,1091,1142 mol=1092,1093,1143 monk_m=1008,1009 monk_w=1010,1011 mono_m=1064,1065 ' +
  'mono_w=1066,1067 ninja_m=1052,1053 ninja_w=1054,1055 odori_w=926,927,1062,1063 ' +
  'onmyo_m=922,923,948,949,1036,1037 onmyo_w=1038,1039 oran=864,865,1264,1265 oru=854,855,1250 ' +
  'ragu=848,849 ramuza=830,831,1155,1157,1159,1168,1199 ' +
  'ramuza2=832,833,1186,1187,1188,1189,1201,1210,1211,1212,1219,1220,1221,1232,1233,1234,1239 ' +
  'ramuza3=834,835,1202,1204,1205,1226,1238,1240,1241,1244,1245,1246,1248,1249,1274,1275,1276,1283 ' +
  'reze=858,859 reze_d=950,951 rudo=890,891 ryu_m=1044,1045 ryu_w=1046,1047 samu_m=1048,1049 ' +
  'samu_w=1050,1051 san_m=1056,1057 san_w=1058,1059 simon=862,863,1242 siro_m=1012,1013 ' +
  'siro_w=918,919,1014,1015 souryo=978,979 sukeru=1078,1079 syou_m=1024,1025 syou_w=1026,1027 ' +
  'tetsu=1108,1109,1138,1139,1140,1141,1200 thief_m=1028,1029,1160,1161,1174 thief_w=1030,1031 ' +
  'toki_m=1020,1021 toki_w=944,945,1022,1023 tori=1084,1085,1144 uri=1086,1087,1145 veri=930,931 ' +
  'voru=892,893,1255,1272,1273 waju_m=1032,1033 waju_w=1034,1035 wigu=884,885,1172 ' +
  'yumi_m=934,935,1004,1005 yumi_w=1006,1007 yurei=1080,1081 ' +
  'zaru=844,845,1209,1260,1261,1263 zaru2=912,913 zarue=932,933 zarumou=860,861';

let sheetIdByKey: Map<string, number> | null = null;
let familyBySheetId: Map<number, string> | null = null;

function sheetIds(): Map<string, number> {
  if (sheetIdByKey) return sheetIdByKey;
  const map = new Map<string, number>();
  for (const entry of SHEET_ID_TABLE.split(' ')) {
    const split = entry.lastIndexOf(':');
    if (split <= 0) continue;
    map.set(entry.slice(0, split), Number(entry.slice(split + 1)));
  }
  sheetIdByKey = map;
  return map;
}

function paletteFamilies(): Map<number, string> {
  if (familyBySheetId) return familyBySheetId;
  const map = new Map<number, string>();
  for (const entry of PALETTE_FAMILY_TABLE.split(' ')) {
    const split = entry.indexOf('=');
    if (split <= 0) continue;
    const family = entry.slice(0, split);
    for (const id of entry.slice(split + 1).split(',')) map.set(Number(id), family);
  }
  familyBySheetId = map;
  return map;
}

function titleCase(key: string): string {
  return key
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('_');
}

export interface ResolvedSheetAssets {
  /** URL of the indexed PNG. */
  url: string;
  /** URLs of the 8 battle `.act` palettes, in slot order. Empty when unavailable. */
  paletteUrls: string[];
}

/**
 * Turn a logical sprite key (`Unit.sprite.sheet`, e.g. `knight_male`) into asset
 * URLs. Also accepts a raw sheet filename stem (`1000_Knight_Male_hd`), which is
 * what the asset pipeline's manifest is expected to emit.
 */
export function resolveSheetAssets(key: string, baseUrl = defaultBaseUrl()): ResolvedSheetAssets {
  const trimmed = key.replace(/\.png$/i, '');
  let id: number | undefined;
  let stem: string;

  const direct = /^(\d+)_(.+)_hd$/.exec(trimmed);
  if (direct) {
    id = Number(direct[1]);
    stem = trimmed;
  } else {
    const lower = trimmed.toLowerCase();
    id = sheetIds().get(lower);
    if (id === undefined) {
      throw new Error(`sprites: unknown sprite sheet key "${key}".`);
    }
    stem = `${id}_${titleCase(lower)}_hd`;
  }

  const family = id === undefined ? undefined : paletteFamilies().get(id);
  const paletteUrls: string[] = [];
  if (family) {
    for (let slot = 1; slot <= 8; slot++) {
      paletteUrls.push(`${baseUrl}${PALETTES_DIR}/battle_${family}_battle_pal${slot}.act`);
    }
  }
  return { url: `${baseUrl}${SPRITES_DIR}/${stem}.png`, paletteUrls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet
// ─────────────────────────────────────────────────────────────────────────────

export interface SheetLayout {
  /** Frame cell size in texels. */
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  /**
   * Texels from the bottom edge of a frame up to the ground line the art stands
   * on. Measured per sheet from the lowest opaque scanline in the pose band.
   */
  groundOffset: number;
  /**
   * Per-cell horizontal offset, in texels, from the centre of the cell to the
   * centre of the art's **contact patch** — the opaque pixels in the lowest few
   * scanlines of that pose.
   *
   * The FFT poses are not centred in their 64-texel cells: the asymmetric ones
   * are drawn facing screen-left with the body pushed to one side, so a quad
   * centred on the cell plants the figure's feet several texels off the middle
   * of its tile. That shows up immediately as a contact shadow sitting beside
   * the boots instead of under them, and as a cast shadow starting from the
   * wrong place. Subtracting this puts the feet — not the cell — on the tile
   * centre. Empty cells store 0.
   */
  footCenterX: readonly number[];
  /**
   * Per-cell height, in texels, from the bottom edge of the cell to the topmost
   * opaque scanline of that pose — i.e. where the character's head actually is.
   *
   * An FFT cell is 64x80 but a standing figure only fills the lower ~40 texels
   * of it; the rest is headroom for jump and cast poses. Anything that hangs
   * *above* the unit — the turn chevron, the status strip, floating combat text —
   * has to anchor to this and not to `frameHeight`, or it hovers half a tile
   * above the head over an apparently empty square. Empty cells store 0.
   */
  headTopY: readonly number[];
}

export interface SpriteSheetOverrides {
  layout?: Partial<SheetLayout>;
  animations?: AnimSet;
  viewCells?: Readonly<Record<ViewKey, number>>;
}

/** A loaded sheet: index texture, palette LUT, layout and clip table. */
export class SpriteSheet {
  readonly key: string;
  readonly image: IndexedImage;
  readonly indexTexture: THREE.DataTexture;
  readonly paletteTexture: THREE.DataTexture;
  readonly paletteCount: number;
  readonly layout: SheetLayout;
  readonly animations: AnimSet;
  readonly geometry: THREE.PlaneGeometry;

  private readonly palettes: readonly Uint8Array[];
  private readonly teamSlot = new Map<Team, number>();

  constructor(
    key: string,
    image: IndexedImage,
    palettes: readonly Uint8Array[],
    overrides: SpriteSheetOverrides = {},
  ) {
    this.key = key;
    this.image = image;
    this.palettes = palettes;

    const detected = detectLayout(image);
    this.layout = { ...detected, ...overrides.layout };

    this.indexTexture = createIndexTexture(image);
    this.paletteTexture = createPaletteTexture(palettes, image.alpha);
    this.paletteCount = palettes.length;

    this.animations = overrides.animations ?? defaultAnimationSet(overrides.viewCells ?? DEFAULT_VIEW_CELL);

    // Quad geometry: one frame at the shared texel density, translated so the
    // mesh origin sits on the art's ground line. Squash and stretch then pivot at
    // the feet, which is the only place it looks right.
    const width = texelsToWorld(this.layout.frameWidth);
    const height = texelsToWorld(this.layout.frameHeight);
    this.geometry = new THREE.PlaneGeometry(width, height);
    this.geometry.translate(0, height / 2 - texelsToWorld(this.layout.groundOffset), 0);
  }

  /** UV rectangle of a flat cell index, in the bottom-up texture space. */
  frameRect(cell: number, out: THREE.Vector4 = new THREE.Vector4()): THREE.Vector4 {
    const { columns, frameWidth, frameHeight } = this.layout;
    const column = cell % columns;
    const row = Math.floor(cell / columns);
    const du = frameWidth / this.image.width;
    const dv = frameHeight / this.image.height;
    // Row 0 is the top band of the image; V grows upward.
    return out.set(column * du, 1 - (row + 1) * dv, du, dv);
  }

  /**
   * The palette slot that best represents a team's colour on this sheet.
   *
   * Slot ordering is not consistent between sheets — `knight_m` puts red at slot
   * 2 and teal at slot 1, `kuro_m` puts magenta at slot 4 — so the choice is made
   * by scoring the actual colours against a target hue, ignoring the entries that
   * are identical to the baked palette (skin, hair, steel) because those are
   * shared across every variant and would flatten the scores.
   */
  slotForTeam(team: Team): number {
    const cached = this.teamSlot.get(team);
    if (cached !== undefined) return cached;

    this.assignTeamSlots();
    return this.teamSlot.get(team) ?? 0;
  }

  /**
   * Resolve all four team colours at once, greedily and without collisions.
   *
   * Slot 0 is authoritative for the player: the toolkit's `battle_pal1` is the
   * blue player palette and is also the palette baked into the PNG, so a story
   * character with a single slot lands there too. The remaining teams claim the
   * best-matching *unused* slot in priority order, which keeps enemies and allies
   * visually distinct even on sheets whose alternates cluster around one hue.
   */
  private assignTeamSlots(): void {
    if (this.teamSlot.size > 0) return;
    this.teamSlot.set('player', 0);

    const taken = new Set<number>([0]);
    const order: Team[] = ['enemy', 'ally', 'neutral'];
    for (const team of order) {
      const slot = pickPaletteSlot(this.palettes, TEAM_TARGET_HUE[team], this.palettes[0], taken);
      if (slot < 0) {
        // Sheet has no spare palette (story characters, the WotL additions).
        this.teamSlot.set(team, 0);
        continue;
      }
      this.teamSlot.set(team, slot);
      taken.add(slot);
    }
  }

  dispose(): void {
    this.indexTexture.dispose();
    this.paletteTexture.dispose();
    this.geometry.dispose();
  }
}

/**
 * Work out the frame grid and ground line from the pixels.
 *
 * Column pitch is fixed at 64 by the FFT sheet format. Band height is found by
 * looking for the first fully transparent scanline below y = 48 — the gutter the
 * toolkit leaves between the whole-body band and the part atlas. The ground line
 * is the lowest opaque scanline inside that band, so a sheet whose figures sit
 * higher or lower in the cell still plants its feet on the tile.
 */
function detectLayout(image: IndexedImage): SheetLayout {
  const frameWidth = 64;
  const columns = Math.max(1, Math.floor(image.width / frameWidth));

  // The decoded rows are bottom-up; convert to top-down y for readability.
  const rowOpaque = (yTopDown: number): boolean => {
    const row = (image.height - 1 - yTopDown) * image.width;
    for (let x = 0; x < image.width; x++) {
      if ((image.indices[row + x] ?? 0) !== 0) return true;
    }
    return false;
  };

  let frameHeight = 80;
  for (let y = 48; y < Math.min(image.height, 160); y++) {
    if (!rowOpaque(y)) {
      frameHeight = y;
      break;
    }
  }
  frameHeight = Math.max(16, Math.min(frameHeight, image.height));

  let lastOpaque = frameHeight - 1;
  for (let y = frameHeight - 1; y >= 0; y--) {
    if (rowOpaque(y)) {
      lastOpaque = y;
      break;
    }
  }

  const rows = Math.max(1, Math.floor(image.height / frameHeight));
  const extents = measureCellExtents(image, frameWidth, frameHeight, columns, rows);

  return {
    frameWidth,
    frameHeight,
    columns,
    rows,
    groundOffset: frameHeight - 1 - lastOpaque,
    footCenterX: extents.footCenterX,
    headTopY: extents.headTopY,
  };
}

/** How many scanlines up from a pose's lowest opaque row count as its footprint. */
const FOOT_BAND_TEXELS = 6;

/**
 * Measure, per cell, where the art's feet and head actually are.
 *
 * See {@link SheetLayout.footCenterX} and {@link SheetLayout.headTopY}. The foot
 * centre is the midpoint of the *extent* of the opaque pixels in the bottom few
 * rows rather than their mean, because a mean is dragged sideways by a trailing
 * cape or a planted weapon butt while the midpoint tracks the stance.
 *
 * One pass over the sheet, once per sheet at load: 512x512 bytes.
 */
function measureCellExtents(
  image: IndexedImage,
  frameWidth: number,
  frameHeight: number,
  columns: number,
  rows: number,
): { footCenterX: number[]; headTopY: number[] } {
  const footCenterX = new Array<number>(columns * rows).fill(0);
  const headTopY = new Array<number>(columns * rows).fill(0);
  const opaqueAt = (x: number, yTopDown: number): boolean =>
    (image.indices[(image.height - 1 - yTopDown) * image.width + x] ?? 0) !== 0;

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = column * frameWidth;
      const x1 = Math.min(image.width, x0 + frameWidth);
      const y0 = row * frameHeight;
      const y1 = Math.min(image.height, y0 + frameHeight);

      const rowHasArt = (y: number): boolean => {
        for (let x = x0; x < x1; x++) if (opaqueAt(x, y)) return true;
        return false;
      };

      let lowest = -1;
      for (let y = y1 - 1; y >= y0; y--) {
        if (rowHasArt(y)) {
          lowest = y;
          break;
        }
      }
      if (lowest < 0) continue;

      let highest = lowest;
      for (let y = y0; y <= lowest; y++) {
        if (rowHasArt(y)) {
          highest = y;
          break;
        }
      }
      // Texels from the cell's bottom edge up to (and including) the top row.
      headTopY[row * columns + column] = y1 - highest;

      let minX = Infinity;
      let maxX = -Infinity;
      for (let y = lowest; y > Math.max(y0 - 1, lowest - FOOT_BAND_TEXELS); y--) {
        for (let x = x0; x < x1; x++) {
          if (!opaqueAt(x, y)) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      if (minX > maxX) continue;

      footCenterX[row * columns + column] = (minX + maxX) / 2 + 0.5 - (x0 + frameWidth / 2);
    }
  }
  return { footCenterX, headTopY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Procedural decals: contact shadow, selection ring, turn marker
// ─────────────────────────────────────────────────────────────────────────────

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sprites: 2D canvas context unavailable.');
  return { canvas, ctx };
}

function canvasTexture(
  canvas: HTMLCanvasElement,
  srgb = true,
  magFilter: THREE.MagnificationTextureFilter = THREE.NearestFilter,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = magFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Shared constant for de-saturating authored light colours toward white. */
const WHITE = new THREE.Color(0xffffff);

/** How far the contact decal floats above the tile surface, in world units. */
const CONTACT_SHADOW_LIFT = 0.012;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GROUNDED SHADOW — and why the shadow map alone cannot deliver it
 * ─────────────────────────────────────────────────────────────────────────────
 * Measured, not assumed. With the sprites' `customDepthMaterial` in place the
 * units *do* write their real alpha-cut silhouettes into the key's shadow map —
 * 29 880 texels across twelve units, against 81 363 for the same quads with
 * three's default (rectangular) depth material, i.e. the cut-out is working and
 * roughly a third of each quad is opaque. So the map is not the problem.
 *
 * The problem is geometry. `battle-open` keys at 54° elevation, and a *vertical
 * card* under a steep key throws its shadow only `height / tan(54°)` ≈ 0.73
 * body-heights along the ground — and the map's key azimuth puts that direction
 * up-screen, which is exactly where the billboard itself is. Rendering the
 * frame twice, once with `mesh.castShadow` on and once off, and differencing
 * the two, the *entire* delta lands on the sprites themselves (self-shadowing);
 * essentially nothing reaches the terrain, because the unit is standing on its
 * own shadow. That is a property of billboards under a steep key, not a bug to
 * be fixed in the shadow map, and it is why every shipped game in this lineage
 * draws a grounding decal as well as (not instead of) a real cast shadow.
 *
 * So this decal is authored to be the thing the map cannot give us: a shadow
 * that *agrees with the key's azimuth*, anchored at the feet and leaning away
 * from the light, with a tight occlusion core where the boots meet the stone.
 *   • the **core** is the contact term — the hairline of unoccluded ground
 *     directly under the figure that no shadow map resolves, and the single
 *     thing that stops a billboard reading as hovering;
 *   • the **tail** is the directional term — it stretches with `cot(elevation)`
 *     and rotates with the azimuth, so it always points where the terrain's own
 *     cast shadows point. A round blob under every unit regardless of the light
 *     is the "generic dark ellipse" the visual target calls an instant fail.
 *
 * Authored in a canonical space with the feet at v = FOOT_V and the tail running
 * to v = 1; `UnitSprite` does the rotate/stretch. Multiplies, and is cooled
 * toward blue because occluded ground in both reference games picks up sky
 * rather than going neutral grey.
 */

/** Where the feet sit along the decal's long axis, in UV. */
const SHADOW_FOOT_V = 0.24;
/** Decal size in world units, before the per-frame directional stretch. */
const SHADOW_WIDTH = TILE_SIZE * 1.05;
const SHADOW_LENGTH = TILE_SIZE * 1.55;

let groundShadowTexture: THREE.CanvasTexture | null = null;
function getGroundShadowTexture(): THREE.CanvasTexture {
  if (groundShadowTexture) return groundShadowTexture;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);

  for (let py = 0; py < size; py++) {
    // Canvas row 0 is v = 1 (flipY), i.e. the far end of the tail.
    const v = 1 - (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const du = u - 0.5;

      // Contact core: wider than deep, sat right on the feet.
      //
      // Sized by measurement, not taste. The camera looks down the ground plane
      // at ~35°, so the world point under a unit's feet projects to exactly
      // where its boots are drawn — a *tight* core is therefore 100% occluded
      // by the sprite that casts it and contributes nothing. (First pass here
      // used sigma 0.155/0.115 and an A/B of the frame with the decal hidden
      // showed only a vague dimming, never a shape.) The core has to reach
      // clearly past the boot silhouette — roughly half a tile — before any of
      // it is visible, which is also what the FFT frames show: a soft patch
      // spilling around the feet, not a dot beneath them.
      const cu = du / 0.245;
      const cv = (v - SHADOW_FOOT_V) / 0.175;
      const core = Math.exp(-(cu * cu + cv * cv) * 0.85);

      // Directional tail: fades and widens with distance, so the far end
      // dissolves into the ground instead of ending on an edge.
      const t = Math.min(1, Math.max(0, (v - SHADOW_FOOT_V) / (1 - SHADOW_FOOT_V)));
      const width = 0.19 + 0.13 * t;
      const lobe = Math.exp(-((du / width) * (du / width)));
      const tail = lobe * Math.pow(1 - t, 2.0) * 0.85;

      const occlusion = Math.min(1, Math.max(core, tail));
      const value = Math.round(255 * (1 - occlusion * 0.74));
      const o = (py * size + px) * 4;
      image.data[o] = value;
      image.data[o + 1] = Math.round(value * 0.985);
      image.data[o + 2] = Math.round(Math.min(255, value * 1.06 + 4)); // cool it
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  // Linear, not nearest: this is a soft gradient, and the nearest-filter rule
  // that keeps the *art* crisp would turn a 128px falloff into visible banding
  // the moment the decal is magnified past one screen pixel per texel.
  groundShadowTexture = canvasTexture(canvas, true, THREE.LinearFilter);
  return groundShadowTexture;
}

/**
 * Multiply decal material with an explicit strength.
 *
 * `MeshBasicMaterial.opacity` cannot fade a multiply decal: with
 * `premultipliedAlpha` the shader pre-multiplies RGB by alpha, so lowering
 * opacity makes the shadow *darker*, and without it alpha is discarded by
 * `blendFunc(ZERO, SRC_COLOR)` and opacity does nothing at all. Neither is a
 * fade. Four lines of GLSL lerping the sampled darkening back toward white is,
 * and it is what lets the shadow soften as a unit hops rather than flying with it.
 */
function createShadowDecalMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUvDecal;
      void main() {
        vUvDecal = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uStrength;
      varying vec2 vUvDecal;
      void main() {
        vec3 shade = texture2D(uMap, vUvDecal).rgb;
        gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0, 0.0, 0.0), (1.0 - shade.r) * 3.0), 1.0);
      }
    `,
    blending: THREE.MultiplyBlending,
    // three insists on this pairing; the fragment writes alpha 1 and carries the
    // darkening entirely in RGB, so it is bookkeeping rather than behaviour.
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
  material.name = 'UnitGroundShadow';
  return material;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Selection ring: a notched annulus that reads at any zoom. */
let selectionRingTexture: THREE.CanvasTexture | null = null;
function getSelectionRingTexture(): THREE.CanvasTexture {
  if (selectionRingTexture) return selectionRingTexture;
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.translate(c, c);

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.40, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.455, 0, Math.PI * 2);
  ctx.stroke();

  // Four cardinal notches — the detail that makes it read as a targeting reticle
  // rather than a glow, and it stays legible at two device pixels per texel.
  ctx.globalAlpha = 1;
  ctx.lineWidth = 6;
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 2 + Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(size * 0.33, 0);
    ctx.lineTo(size * 0.475, 0);
    ctx.stroke();
    ctx.restore();
  }
  selectionRingTexture = canvasTexture(canvas);
  return selectionRingTexture;
}

/**
 * Active-turn chevron that hovers above the head.
 *
 * **Authored as pixels, not as a path.** It was previously drawn as a vector
 * chevron on a 64px canvas and minified through a mipmap chain, and because the
 * canvas stores un-premultiplied alpha every mip level averaged the dark outline
 * against transparent *black* — the marker rendered as a gold chevron sitting on
 * a dark rectangular plate, which is exactly the "cheap overlay" tell the rest of
 * this file exists to avoid. At the marker's real size, 13 texels, there is no
 * reason to filter at all: draw it at 1:1 and let `NearestFilter` scale it.
 */
const TURN_MARKER_ROWS = [
  '##.........##',
  '###.......###',
  '.###.....###.',
  '..###...###..',
  '...###.###...',
  '....#####....',
  '.....###.....',
  '......#......',
];

/** Texel width of the marker bitmap — the quad is sized from this. */
const TURN_MARKER_TEXELS = TURN_MARKER_ROWS[0]?.length ?? 13;

let turnMarkerTexture: THREE.CanvasTexture | null = null;
function getTurnMarkerTexture(): THREE.CanvasTexture {
  if (turnMarkerTexture) return turnMarkerTexture;

  const w = TURN_MARKER_TEXELS;
  const h = TURN_MARKER_ROWS.length;
  // One texel of margin so the 8-neighbour outline has somewhere to live.
  const cw = w + 2;
  const ch = h + 2;
  const { canvas, ctx } = makeCanvas(Math.max(cw, ch));
  canvas.width = cw;
  canvas.height = ch;
  ctx.clearRect(0, 0, cw, ch);

  const fill = new Array<boolean>(cw * ch).fill(false);
  TURN_MARKER_ROWS.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      if (row[x] === '#') fill[(y + 1) * cw + (x + 1)] = true;
    }
  });

  const put = (x: number, y: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, 1, 1);
  };
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (fill[y * cw + x]) continue;
      let adjacent = false;
      for (let dy = -1; dy <= 1 && !adjacent; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          if (fill[ny * cw + nx]) {
            adjacent = true;
            break;
          }
        }
      }
      if (adjacent) put(x, y, '#1a1408');
    }
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) if (fill[y * cw + x]) put(x, y, '#ffd977');
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  turnMarkerTexture = texture;
  return texture;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pixel font for floating combat text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 5x7 bitmap face. Combat numbers have to be *crisp* at the same texel density
 * as the art — anti-aliased vector text next to nearest-filtered pixel sprites is
 * an instant tell — so the glyphs are authored as pixels rather than rasterised
 * from a font at runtime.
 */
const GLYPHS: Readonly<Record<string, string>> = {
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '#####/...#./..#../...#./....#/#...#/.###.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.####',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#.#.#/#..##/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '-': '...../...../...../#####/...../...../.....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  ' ': '...../...../...../...../...../...../.....',
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_GAP = 1;

interface LabelStyle {
  /** Fill colour, `#rrggbb`. */
  color: string;
  /** Outline colour. A hard 1-texel outline keeps numbers legible over anything. */
  outline: string;
  /** Integer upscale of the 5x7 face. */
  scale: number;
}

const LABEL_STYLES = {
  damage: { color: '#ffffff', outline: '#160c08', scale: 2 },
  crit: { color: '#ffd24a', outline: '#2a1200', scale: 3 },
  heal: { color: '#8ef2a8', outline: '#04220f', scale: 2 },
  mp: { color: '#8ec8ff', outline: '#041426', scale: 2 },
  miss: { color: '#cfd6e2', outline: '#141820', scale: 2 },
  status: { color: '#d9a6ff', outline: '#1b0a26', scale: 2 },
} as const satisfies Record<string, LabelStyle>;

export type LabelKind = keyof typeof LABEL_STYLES;

interface Label {
  texture: THREE.CanvasTexture;
  /** Size in sheet texels. */
  width: number;
  height: number;
}

const labelCache = new Map<string, Label>();

function renderLabel(text: string, kind: LabelKind): Label {
  const cacheKey = `${kind}:${text}`;
  const cached = labelCache.get(cacheKey);
  if (cached) return cached;

  const style: LabelStyle = LABEL_STYLES[kind];
  const glyphs = [...text.toUpperCase()];
  const cellW = GLYPH_W + GLYPH_GAP;
  const innerW = glyphs.length * cellW - GLYPH_GAP;
  // One texel of padding all round for the outline.
  const w = (innerW + 2) * style.scale;
  const h = (GLYPH_H + 2) * style.scale;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sprites: 2D canvas context unavailable.');
  ctx.clearRect(0, 0, w, h);

  const mask: boolean[] = new Array((innerW + 2) * (GLYPH_H + 2)).fill(false);
  const stride = innerW + 2;
  glyphs.forEach((glyph, gi) => {
    const rows = (GLYPHS[glyph] ?? GLYPHS['?'] ?? GLYPHS[' '] ?? '').split('/');
    for (let y = 0; y < GLYPH_H; y++) {
      const row = rows[y] ?? '';
      for (let x = 0; x < GLYPH_W; x++) {
        if (row[x] === '#') mask[(y + 1) * stride + (gi * cellW + x + 1)] = true;
      }
    }
  });

  const put = (x: number, y: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x * style.scale, y * style.scale, style.scale, style.scale);
  };

  // 8-neighbour outline first, then the fill on top.
  for (let y = 0; y < GLYPH_H + 2; y++) {
    for (let x = 0; x < stride; x++) {
      if (mask[y * stride + x]) continue;
      let adjacent = false;
      for (let dy = -1; dy <= 1 && !adjacent; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= stride || ny >= GLYPH_H + 2) continue;
          if (mask[ny * stride + nx]) {
            adjacent = true;
            break;
          }
        }
      }
      if (adjacent) put(x, y, style.outline);
    }
  }
  for (let y = 0; y < GLYPH_H + 2; y++) {
    for (let x = 0; x < stride; x++) {
      if (mask[y * stride + x]) put(x, y, style.color);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const label: Label = { texture, width: w, height: h };
  labelCache.set(cacheKey, label);
  return label;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status icons
// ─────────────────────────────────────────────────────────────────────────────

type GlyphKind =
  | 'skull' | 'crystal' | 'chest' | 'stone' | 'clock' | 'moon' | 'heart' | 'swirl'
  | 'rage' | 'eye' | 'mute' | 'drop' | 'flask' | 'grave' | 'frog' | 'down'
  | 'up' | 'plus' | 'shield' | 'orb' | 'wing' | 'mirror' | 'ghost' | 'feather'
  | 'hourglass' | 'guard' | 'note' | 'spark' | 'flame' | 'chain' | 'target' | 'blade';

interface StatusIconStyle {
  glyph: GlyphKind;
  color: string;
  /** Debuffs get a red-tinted plate, buffs a blue one. */
  tone: 'buff' | 'debuff' | 'neutral';
}

const STATUS_ICONS: Readonly<Record<StatusId, StatusIconStyle>> = {
  ko: { glyph: 'skull', color: '#cfd3da', tone: 'debuff' },
  crystal: { glyph: 'crystal', color: '#9fe8ff', tone: 'neutral' },
  treasure: { glyph: 'chest', color: '#f0c46a', tone: 'neutral' },
  petrify: { glyph: 'stone', color: '#b9b2a4', tone: 'debuff' },
  stop: { glyph: 'clock', color: '#c9a6ff', tone: 'debuff' },
  sleep: { glyph: 'moon', color: '#a9c4ff', tone: 'debuff' },
  charm: { glyph: 'heart', color: '#ff9ad0', tone: 'debuff' },
  confuse: { glyph: 'swirl', color: '#ffb0e8', tone: 'debuff' },
  berserk: { glyph: 'rage', color: '#ff7a52', tone: 'debuff' },
  blind: { glyph: 'eye', color: '#6f7788', tone: 'debuff' },
  silence: { glyph: 'mute', color: '#9aa6bb', tone: 'debuff' },
  oil: { glyph: 'drop', color: '#6a5a3a', tone: 'debuff' },
  poison: { glyph: 'flask', color: '#8ce06a', tone: 'debuff' },
  undead: { glyph: 'grave', color: '#8d7fb0', tone: 'debuff' },
  frog: { glyph: 'frog', color: '#7fd06a', tone: 'debuff' },
  slow: { glyph: 'down', color: '#a0a8d0', tone: 'debuff' },
  haste: { glyph: 'up', color: '#ffe27a', tone: 'buff' },
  regen: { glyph: 'plus', color: '#8ef2a8', tone: 'buff' },
  protect: { glyph: 'shield', color: '#9fd0ff', tone: 'buff' },
  shell: { glyph: 'orb', color: '#d3a6ff', tone: 'buff' },
  reraise: { glyph: 'wing', color: '#ffe9b0', tone: 'buff' },
  faith: { glyph: 'spark', color: '#ffe9b0', tone: 'buff' },
  innocent: { glyph: 'guard', color: '#b0b8c8', tone: 'neutral' },
  float: { glyph: 'feather', color: '#bfe6ff', tone: 'buff' },
  reflect: { glyph: 'mirror', color: '#b6e0ff', tone: 'buff' },
  transparent: { glyph: 'ghost', color: '#c8d8e8', tone: 'buff' },
  chicken: { glyph: 'frog', color: '#e8c46a', tone: 'debuff' },
  'death-sentence': { glyph: 'hourglass', color: '#ff7a7a', tone: 'debuff' },
  defending: { glyph: 'guard', color: '#cfd6e2', tone: 'buff' },
  performing: { glyph: 'note', color: '#ffd9a0', tone: 'neutral' },
  charging: { glyph: 'spark', color: '#ffd97a', tone: 'neutral' },
  jumping: { glyph: 'up', color: '#cfe6ff', tone: 'neutral' },
  taunted: { glyph: 'target', color: '#ff9a6a', tone: 'debuff' },
  rooted: { glyph: 'chain', color: '#a08a6a', tone: 'debuff' },
  vulnerable: { glyph: 'blade', color: '#ff8a8a', tone: 'debuff' },
  empowered: { glyph: 'spark', color: '#ffd24a', tone: 'buff' },
  shielded: { glyph: 'shield', color: '#a6e8ff', tone: 'buff' },
  bleeding: { glyph: 'drop', color: '#e05050', tone: 'debuff' },
  burning: { glyph: 'flame', color: '#ff9a3a', tone: 'debuff' },
  mark: { glyph: 'target', color: '#ff6aa0', tone: 'debuff' },
  stealth: { glyph: 'ghost', color: '#8fa0b8', tone: 'buff' },
  'evade-next': { glyph: 'wing', color: '#a6f0d0', tone: 'buff' },
};

const STATUS_ICON_TEXELS = 13;
const STATUS_ATLAS_COLUMNS = 8;

interface StatusAtlas {
  texture: THREE.CanvasTexture;
  index: Map<StatusId, number>;
  columns: number;
  rows: number;
}

let statusAtlas: StatusAtlas | null = null;

/** Draw one glyph inside the unit square [0,1]² of the current transform. */
function drawGlyph(ctx: CanvasRenderingContext2D, kind: GlyphKind, size: number): void {
  const s = size;
  ctx.lineWidth = Math.max(1.5, s * 0.11);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const stroke = () => ctx.stroke();
  const fill = () => ctx.fill();

  switch (kind) {
    case 'skull':
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.42, s * 0.26, Math.PI, 0);
      ctx.rect(s * 0.24, s * 0.42, s * 0.52, s * 0.2);
      fill();
      ctx.clearRect(s * 0.32, s * 0.36, s * 0.12, s * 0.14);
      ctx.clearRect(s * 0.56, s * 0.36, s * 0.12, s * 0.14);
      ctx.fillRect(s * 0.36, s * 0.66, s * 0.28, s * 0.14);
      break;
    case 'crystal':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.12);
      ctx.lineTo(s * 0.8, s * 0.45);
      ctx.lineTo(s * 0.5, s * 0.88);
      ctx.lineTo(s * 0.2, s * 0.45);
      ctx.closePath();
      fill();
      break;
    case 'chest':
      ctx.fillRect(s * 0.18, s * 0.4, s * 0.64, s * 0.4);
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.4, s * 0.32, Math.PI, 0);
      fill();
      break;
    case 'stone':
      ctx.beginPath();
      ctx.moveTo(s * 0.2, s * 0.72);
      ctx.lineTo(s * 0.3, s * 0.28);
      ctx.lineTo(s * 0.68, s * 0.2);
      ctx.lineTo(s * 0.82, s * 0.6);
      ctx.lineTo(s * 0.56, s * 0.84);
      ctx.closePath();
      fill();
      break;
    case 'clock':
    case 'hourglass':
      if (kind === 'clock') {
        ctx.beginPath();
        ctx.arc(s * 0.5, s * 0.5, s * 0.32, 0, Math.PI * 2);
        stroke();
        ctx.beginPath();
        ctx.moveTo(s * 0.5, s * 0.5);
        ctx.lineTo(s * 0.5, s * 0.28);
        ctx.moveTo(s * 0.5, s * 0.5);
        ctx.lineTo(s * 0.68, s * 0.58);
        stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(s * 0.26, s * 0.16);
        ctx.lineTo(s * 0.74, s * 0.16);
        ctx.lineTo(s * 0.5, s * 0.5);
        ctx.lineTo(s * 0.74, s * 0.84);
        ctx.lineTo(s * 0.26, s * 0.84);
        ctx.lineTo(s * 0.5, s * 0.5);
        ctx.closePath();
        fill();
      }
      break;
    case 'moon':
      ctx.beginPath();
      ctx.arc(s * 0.55, s * 0.5, s * 0.32, 0, Math.PI * 2);
      fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(s * 0.72, s * 0.42, s * 0.28, 0, Math.PI * 2);
      fill();
      ctx.restore();
      break;
    case 'heart':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.82);
      ctx.bezierCurveTo(s * 0.05, s * 0.5, s * 0.22, s * 0.14, s * 0.5, s * 0.36);
      ctx.bezierCurveTo(s * 0.78, s * 0.14, s * 0.95, s * 0.5, s * 0.5, s * 0.82);
      fill();
      break;
    case 'swirl':
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const a = t * Math.PI * 3.4;
        const r = s * 0.06 + t * s * 0.3;
        const x = s * 0.5 + Math.cos(a) * r;
        const y = s * 0.5 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      stroke();
      break;
    case 'rage':
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.3);
      ctx.lineTo(s * 0.44, s * 0.44);
      ctx.lineTo(s * 0.16, s * 0.5);
      ctx.closePath();
      ctx.moveTo(s * 0.84, s * 0.3);
      ctx.lineTo(s * 0.56, s * 0.44);
      ctx.lineTo(s * 0.84, s * 0.5);
      ctx.closePath();
      fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.28, s * 0.76);
      ctx.quadraticCurveTo(s * 0.5, s * 0.58, s * 0.72, s * 0.76);
      stroke();
      break;
    case 'eye':
      ctx.beginPath();
      ctx.moveTo(s * 0.14, s * 0.5);
      ctx.quadraticCurveTo(s * 0.5, s * 0.16, s * 0.86, s * 0.5);
      ctx.quadraticCurveTo(s * 0.5, s * 0.84, s * 0.14, s * 0.5);
      stroke();
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.12, 0, Math.PI * 2);
      fill();
      break;
    case 'mute':
    case 'note':
      ctx.beginPath();
      ctx.ellipse(s * 0.36, s * 0.7, s * 0.16, s * 0.12, -0.4, 0, Math.PI * 2);
      fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.7);
      ctx.lineTo(s * 0.5, s * 0.2);
      ctx.lineTo(s * 0.76, s * 0.28);
      stroke();
      if (kind === 'mute') {
        ctx.beginPath();
        ctx.moveTo(s * 0.16, s * 0.84);
        ctx.lineTo(s * 0.84, s * 0.16);
        ctx.stroke();
      }
      break;
    case 'drop':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.12);
      ctx.bezierCurveTo(s * 0.86, s * 0.52, s * 0.78, s * 0.88, s * 0.5, s * 0.88);
      ctx.bezierCurveTo(s * 0.22, s * 0.88, s * 0.14, s * 0.52, s * 0.5, s * 0.12);
      fill();
      break;
    case 'flask':
      ctx.beginPath();
      ctx.moveTo(s * 0.38, s * 0.14);
      ctx.lineTo(s * 0.62, s * 0.14);
      ctx.lineTo(s * 0.62, s * 0.42);
      ctx.lineTo(s * 0.82, s * 0.82);
      ctx.lineTo(s * 0.18, s * 0.82);
      ctx.lineTo(s * 0.38, s * 0.42);
      ctx.closePath();
      fill();
      break;
    case 'grave':
      ctx.beginPath();
      ctx.moveTo(s * 0.24, s * 0.86);
      ctx.lineTo(s * 0.24, s * 0.4);
      ctx.arc(s * 0.5, s * 0.4, s * 0.26, Math.PI, 0);
      ctx.lineTo(s * 0.76, s * 0.86);
      ctx.closePath();
      fill();
      break;
    case 'frog':
      ctx.beginPath();
      ctx.ellipse(s * 0.5, s * 0.6, s * 0.32, s * 0.24, 0, 0, Math.PI * 2);
      fill();
      ctx.beginPath();
      ctx.arc(s * 0.34, s * 0.34, s * 0.12, 0, Math.PI * 2);
      ctx.arc(s * 0.66, s * 0.34, s * 0.12, 0, Math.PI * 2);
      fill();
      break;
    case 'down':
    case 'up': {
      const flip = kind === 'up';
      ctx.beginPath();
      if (flip) {
        ctx.moveTo(s * 0.5, s * 0.14);
        ctx.lineTo(s * 0.84, s * 0.56);
        ctx.lineTo(s * 0.62, s * 0.56);
        ctx.lineTo(s * 0.62, s * 0.86);
        ctx.lineTo(s * 0.38, s * 0.86);
        ctx.lineTo(s * 0.38, s * 0.56);
        ctx.lineTo(s * 0.16, s * 0.56);
      } else {
        ctx.moveTo(s * 0.5, s * 0.86);
        ctx.lineTo(s * 0.84, s * 0.44);
        ctx.lineTo(s * 0.62, s * 0.44);
        ctx.lineTo(s * 0.62, s * 0.14);
        ctx.lineTo(s * 0.38, s * 0.14);
        ctx.lineTo(s * 0.38, s * 0.44);
        ctx.lineTo(s * 0.16, s * 0.44);
      }
      ctx.closePath();
      fill();
      break;
    }
    case 'plus':
      ctx.fillRect(s * 0.42, s * 0.16, s * 0.16, s * 0.68);
      ctx.fillRect(s * 0.16, s * 0.42, s * 0.68, s * 0.16);
      break;
    case 'shield':
    case 'guard':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.12);
      ctx.lineTo(s * 0.84, s * 0.28);
      ctx.lineTo(s * 0.84, s * 0.54);
      ctx.quadraticCurveTo(s * 0.84, s * 0.8, s * 0.5, s * 0.9);
      ctx.quadraticCurveTo(s * 0.16, s * 0.8, s * 0.16, s * 0.54);
      ctx.lineTo(s * 0.16, s * 0.28);
      ctx.closePath();
      if (kind === 'shield') fill();
      else stroke();
      break;
    case 'orb':
    case 'mirror':
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.3, 0, Math.PI * 2);
      stroke();
      if (kind === 'mirror') {
        ctx.beginPath();
        ctx.moveTo(s * 0.34, s * 0.66);
        ctx.lineTo(s * 0.66, s * 0.34);
        stroke();
      }
      break;
    case 'wing':
    case 'feather':
      ctx.beginPath();
      ctx.moveTo(s * 0.16, s * 0.72);
      ctx.quadraticCurveTo(s * 0.44, s * 0.1, s * 0.86, s * 0.24);
      ctx.quadraticCurveTo(s * 0.6, s * 0.58, s * 0.16, s * 0.72);
      fill();
      if (kind === 'feather') {
        ctx.beginPath();
        ctx.moveTo(s * 0.16, s * 0.74);
        ctx.lineTo(s * 0.84, s * 0.24);
        ctx.stroke();
      }
      break;
    case 'ghost':
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.44, s * 0.3, Math.PI, 0);
      ctx.lineTo(s * 0.8, s * 0.84);
      ctx.lineTo(s * 0.66, s * 0.7);
      ctx.lineTo(s * 0.5, s * 0.84);
      ctx.lineTo(s * 0.34, s * 0.7);
      ctx.lineTo(s * 0.2, s * 0.84);
      ctx.closePath();
      fill();
      break;
    case 'spark':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.08);
      ctx.lineTo(s * 0.6, s * 0.4);
      ctx.lineTo(s * 0.92, s * 0.5);
      ctx.lineTo(s * 0.6, s * 0.6);
      ctx.lineTo(s * 0.5, s * 0.92);
      ctx.lineTo(s * 0.4, s * 0.6);
      ctx.lineTo(s * 0.08, s * 0.5);
      ctx.lineTo(s * 0.4, s * 0.4);
      ctx.closePath();
      fill();
      break;
    case 'flame':
      ctx.beginPath();
      ctx.moveTo(s * 0.5, s * 0.08);
      ctx.bezierCurveTo(s * 0.82, s * 0.36, s * 0.8, s * 0.9, s * 0.5, s * 0.9);
      ctx.bezierCurveTo(s * 0.2, s * 0.9, s * 0.24, s * 0.44, s * 0.42, s * 0.34);
      ctx.bezierCurveTo(s * 0.42, s * 0.54, s * 0.5, s * 0.4, s * 0.5, s * 0.08);
      fill();
      break;
    case 'chain':
      ctx.beginPath();
      ctx.ellipse(s * 0.35, s * 0.35, s * 0.15, s * 0.2, Math.PI / 4, 0, Math.PI * 2);
      ctx.ellipse(s * 0.65, s * 0.65, s * 0.15, s * 0.2, Math.PI / 4, 0, Math.PI * 2);
      stroke();
      break;
    case 'target':
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.32, 0, Math.PI * 2);
      stroke();
      ctx.beginPath();
      ctx.arc(s * 0.5, s * 0.5, s * 0.1, 0, Math.PI * 2);
      fill();
      break;
    case 'blade':
      ctx.beginPath();
      ctx.moveTo(s * 0.2, s * 0.84);
      ctx.lineTo(s * 0.74, s * 0.16);
      ctx.lineTo(s * 0.86, s * 0.3);
      ctx.lineTo(s * 0.32, s * 0.9);
      ctx.closePath();
      fill();
      break;
  }
}

/**
 * Build the status icon atlas.
 *
 * The icons are authored here rather than shipped as art because the asset set
 * has no status iconography in it; they are drawn as a bevelled plate plus a
 * silhouette glyph so they stay readable at 13 texels, and the plate is tinted by
 * buff / debuff so the strip can be parsed at a glance without reading a glyph.
 */
function getStatusAtlas(): StatusAtlas {
  if (statusAtlas) return statusAtlas;

  const ids = Object.keys(STATUS_ICONS) as StatusId[];
  const columns = STATUS_ATLAS_COLUMNS;
  const rows = Math.ceil(ids.length / columns);
  const cell = 32; // 32px source for a 13-texel icon: crisp when minified
  const canvas = document.createElement('canvas');
  canvas.width = columns * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sprites: 2D canvas context unavailable.');

  const index = new Map<StatusId, number>();
  ids.forEach((id, i) => {
    index.set(id, i);
    const style = STATUS_ICONS[id];
    const ox = (i % columns) * cell;
    const oy = Math.floor(i / columns) * cell;
    ctx.save();
    ctx.translate(ox, oy);

    const plate =
      style.tone === 'buff' ? '#16324e' : style.tone === 'debuff' ? '#4a1520' : '#2c2a38';
    const edge =
      style.tone === 'buff' ? '#79c8ff' : style.tone === 'debuff' ? '#ff8a8a' : '#c9c2e0';

    // Plate: 1px dark border, 1px bright bevel, flat fill. Reads at any size.
    ctx.fillStyle = '#0a0a10';
    ctx.fillRect(1, 1, cell - 2, cell - 2);
    ctx.fillStyle = plate;
    ctx.fillRect(3, 3, cell - 6, cell - 6);
    ctx.strokeStyle = edge;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, cell - 6, cell - 6);
    ctx.globalAlpha = 1;

    ctx.translate(cell * 0.16, cell * 0.16);
    ctx.fillStyle = style.color;
    ctx.strokeStyle = style.color;
    drawGlyph(ctx, style.glyph, cell * 0.68);
    ctx.restore();
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  statusAtlas = { texture, index, columns, rows };
  return statusAtlas;
}

/** Statuses that never earn a slot in the strip — they are shown by the art itself. */
const HIDDEN_STATUSES: ReadonlySet<StatusId> = new Set<StatusId>(['ko', 'crystal', 'treasure']);

const MAX_STATUS_ICONS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Floating combat text
// ─────────────────────────────────────────────────────────────────────────────

interface FloatingLabel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** World anchor the label rises from. */
  anchor: THREE.Vector3;
  age: number;
  life: number;
  /** Horizontal drift in texels, so a burst of hits fans out instead of stacking. */
  drift: number;
  rise: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// UnitSprite
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitSpriteOptions {
  /**
   * How far the quad is pushed toward the camera, in world units. With an
   * orthographic camera this is a pure depth change — zero screen movement — so
   * it breaks the z-fight against the tile top without the sprite floating.
   */
  depthBias?: number;
  /** Texels the feet are sunk below the tile surface so they never hover. */
  footSink?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  contactShadow?: boolean;
}

export interface SpriteViewContext {
  /** The three.js camera actually used for rendering. */
  camera: THREE.Camera;
  /** World units covered by one device pixel — from `IsoCamera.worldPerDevicePixel`. */
  worldPerDevicePixel: number;
  /** Current camera yaw in radians — from `IsoCamera.yawRadians`. */
  yawRadians: number;
}

export type SelectionState = 'none' | 'selected' | 'active' | 'target' | 'hostile';

const SELECTION_COLORS: Readonly<Record<Exclude<SelectionState, 'none'>, number>> = {
  selected: 0x8ec8ff,
  active: 0xffd977,
  target: 0x9ef2b8,
  hostile: 0xff7a6a,
};

/**
 * One unit on the field: a Y-locked billboard quad plus its ground decals, turn
 * marker, status strip and floating text.
 */
export class UnitSprite {
  readonly unitId: UnitId;
  readonly sheet: SpriteSheet;
  readonly object = new THREE.Group();
  readonly animator: SpriteAnimator;

  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshLambertMaterial>;
  private readonly bundle: SpriteMaterialBundle;

  private readonly contactShadow: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null;
  /** Ground heading the key light travels, and how far a body-height casts. */
  private shadowYaw = 0;
  private shadowStretch = 1;
  private readonly ring: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly turnMarker: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly statusStrip: THREE.Group;
  private readonly statusIcons: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];

  /** Fractional grid position. `z` is elevation in half-tile units. */
  readonly cell = { x: 0, y: 0, z: 0 };
  facing: Facing = 'S';
  team: Team = 'player';

  private readonly options: Required<UnitSpriteOptions>;
  private readonly frameRect = new THREE.Vector4();
  /** Flat cell index currently displayed — indexes `layout.footCenterX`. */
  private frameCell = 0;

  private walker: PathWalker | null = null;
  private walkResolve: (() => void) | null = null;
  private walkOnStep: ((index: number) => void) | null = null;

  private selection: SelectionState = 'none';
  private ringPulse = 0;
  private markerVisible = false;
  private markerPhase = 0;

  private flashTime = 0;
  private flashDuration = 0;

  private ko = false;
  private crystalPhase = -1;
  private crystalResolve: (() => void) | null = null;

  private labels: FloatingLabel[] = [];
  private labelSeed = 0;

  private readonly scratchWorld = new THREE.Vector3();
  private readonly scratchView = new THREE.Vector3();

  constructor(unitId: UnitId, sheet: SpriteSheet, options: UnitSpriteOptions = {}) {
    this.unitId = unitId;
    this.sheet = sheet;
    this.options = {
      depthBias: options.depthBias ?? 0.14,
      footSink: options.footSink ?? 1,
      castShadow: options.castShadow ?? true,
      receiveShadow: options.receiveShadow ?? true,
      contactShadow: options.contactShadow ?? true,
    };

    this.bundle = createSpriteMaterial({
      indexMap: sheet.indexTexture,
      palette: sheet.paletteTexture,
      paletteRows: sheet.paletteCount,
      sheetWidth: sheet.image.width,
      sheetHeight: sheet.image.height,
      frameWidth: sheet.layout.frameWidth,
      frameHeight: sheet.layout.frameHeight,
    });

    this.mesh = new THREE.Mesh(sheet.geometry, this.bundle.material);
    this.mesh.name = `unit:${unitId}`;
    this.mesh.castShadow = this.options.castShadow;
    this.mesh.receiveShadow = this.options.receiveShadow;
    this.mesh.customDepthMaterial = this.bundle.depthMaterial;
    // The billboard already faces the camera; three's own frustum test uses the
    // unrotated bounding sphere, which is fine, but the quad is tall so give it
    // room rather than letting units pop at the screen edge.
    this.mesh.frustumCulled = false;
    this.object.add(this.mesh);

    this.animator = new SpriteAnimator(sheet.animations);

    if (this.options.contactShadow) {
      // Lay the quad flat, then slide it so the decal's foot anchor — not its
      // centre — sits on the mesh origin. Everything after this can rotate the
      // mesh about Y and stretch it along local −Z without the contact core
      // ever leaving the boots.
      const geometry = new THREE.PlaneGeometry(SHADOW_WIDTH, SHADOW_LENGTH);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, 0, (SHADOW_FOOT_V - 0.5) * SHADOW_LENGTH);
      this.contactShadow = new THREE.Mesh(
        geometry,
        createShadowDecalMaterial(getGroundShadowTexture()),
      );
      this.contactShadow.renderOrder = 1;
      this.contactShadow.frustumCulled = false;
      this.object.add(this.contactShadow);
    } else {
      this.contactShadow = null;
    }

    {
      const size = TILE_SIZE * 1.25;
      const geometry = new THREE.PlaneGeometry(size, size);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        map: getSelectionRingTexture(),
        color: SELECTION_COLORS.selected,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        toneMapped: false,
      });
      this.ring = new THREE.Mesh(geometry, material);
      this.ring.renderOrder = 2;
      this.ring.visible = false;
      this.ring.frustumCulled = false;
      this.object.add(this.ring);
    }

    {
      // Sized from the bitmap so one source texel is exactly one sheet texel —
      // the marker then scales by the same integer factor as the sprite art.
      const map = getTurnMarkerTexture();
      const geometry = new THREE.PlaneGeometry(
        texelsToWorld(map.image.width),
        texelsToWorld(map.image.height),
      );
      const material = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        alphaTest: 0.5,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      });
      this.turnMarker = new THREE.Mesh(geometry, material);
      this.turnMarker.renderOrder = 20;
      this.turnMarker.visible = false;
      this.turnMarker.frustumCulled = false;
      this.object.add(this.turnMarker);
    }

    this.statusStrip = new THREE.Group();
    this.statusStrip.renderOrder = 21;
    this.object.add(this.statusStrip);

    this.applyFrame(0);
    this.animator.play('idle');
  }

  // ── placement ─────────────────────────────────────────────────────────────

  /** Snap to a grid cell. Accepts fractional coordinates for mid-move states. */
  setCell(x: number, y: number, z: number): void {
    this.cell.x = x;
    this.cell.y = y;
    this.cell.z = z;
  }

  setFromUnit(unit: Unit): void {
    this.setCell(unit.pos.x, unit.pos.y, unit.pos.z);
    this.facing = unit.facing;
    this.setTeam(unit.team);
    if (unit.sprite.palette > 0) this.setPaletteSlot(unit.sprite.palette);
    this.setStatuses(unit.statuses);
  }

  /** Ground height of the current cell, in world units. */
  private groundY(): number {
    return this.cell.z * HEIGHT_UNIT;
  }

  // ── colour ────────────────────────────────────────────────────────────────

  setTeam(team: Team): void {
    this.team = team;
    this.setPaletteSlot(this.sheet.slotForTeam(team));
  }

  /** Select a specific battle palette slot, overriding the team choice. */
  setPaletteSlot(slot: number): void {
    this.bundle.uniforms.uPaletteRow.value = Math.max(
      0,
      Math.min(this.sheet.paletteCount - 1, slot),
    );
  }

  /**
   * Point the impostor shading and the warm rim at the scene's key light.
   *
   * The cool counter-rim is derived rather than passed: the lighting rig always
   * places its back light at roughly `keyAzimuth + 150°` and a shallower
   * elevation, so mirroring the key through the vertical axis and flattening it
   * lands within a few degrees of the real fill without adding a second call
   * every caller would have to remember to make.
   */
  setKeyLight(direction: THREE.Vector3, rimColor?: THREE.ColorRepresentation): void {
    const key = this.bundle.uniforms.uKeyLightDir.value.copy(direction).normalize();
    this.bundle.uniforms.uFillLightDir.value
      .set(-key.x, -Math.abs(key.y) * 0.5, -key.z)
      .normalize();
    if (rimColor !== undefined) {
      // The rig hands us its *preset* rim hue, which is deliberately extreme —
      // dawn's is 0x46a6ff, a fully saturated cyan chosen to separate stone
      // silhouettes at a distance. Painted at full chroma along a 40-texel
      // figure it reads as a neon keyline rather than as light, so pull it
      // toward white before it touches the art. The hue survives; the poster
      // paint does not.
      this.bundle.uniforms.uRimColor.value.set(rimColor).lerp(WHITE, 0.45);
      this.bundle.uniforms.uBackRimColor.value.set(rimColor).lerp(WHITE, 0.6);
    }

    // Aim the grounded shadow down the same ray. The decal's tail runs along its
    // own local −Z, and rotating a mesh by θ about Y sends −Z to
    // (−sin θ, −cos θ); solving that against the key's ground heading gives the
    // yaw below. `stretch` is cot(elevation) — the ground distance one unit of
    // height throws — clamped so a near-overhead key still leaves a readable
    // contact patch and a raking one does not draw a shadow across four tiles.
    const groundLength = Math.hypot(key.x, key.z);
    if (groundLength > 1e-5) {
      this.shadowYaw = Math.atan2(-key.x / groundLength, -key.z / groundLength);
      const cot = groundLength / Math.max(1e-3, Math.abs(key.y));
      this.shadowStretch = Math.min(1.85, Math.max(0.55, 0.42 + cot * 0.78));
    } else {
      this.shadowYaw = 0;
      this.shadowStretch = 0.55;
    }
  }

  /**
   * The rest of the scene's tone: the light a shadowed unit still receives, the
   * colour the ground bounces up into its legs, and the cool back rim.
   * Defaults suit a cool-shadow dawn map; a night or lava map should override.
   */
  setSceneTone(tone: {
    ambientFloor?: THREE.ColorRepresentation;
    bounceColor?: THREE.ColorRepresentation;
    bounceStrength?: number;
    backRimColor?: THREE.ColorRepresentation;
    backRimStrength?: number;
  }): void {
    const u = this.bundle.uniforms;
    if (tone.ambientFloor !== undefined) u.uAmbientFloor.value.set(tone.ambientFloor);
    if (tone.bounceColor !== undefined) u.uBounceColor.value.set(tone.bounceColor);
    if (tone.bounceStrength !== undefined) u.uBounceStrength.value = tone.bounceStrength;
    if (tone.backRimColor !== undefined) u.uBackRimColor.value.set(tone.backRimColor);
    if (tone.backRimStrength !== undefined) u.uBackRimStrength.value = tone.backRimStrength;
  }

  setLightInfluence(value: number): void {
    this.bundle.uniforms.uLightInfluence.value = value;
  }

  /** Damage/heal flash. `duration` in seconds. */
  flash(color: THREE.ColorRepresentation = 0xffffff, duration = 0.16): void {
    this.bundle.uniforms.uFlashColor.value.set(color);
    this.flashDuration = Math.max(0.01, duration);
    this.flashTime = this.flashDuration;
  }

  /** Multiplicative tint, e.g. poison green while the status is up. */
  setTint(color: THREE.ColorRepresentation): void {
    this.bundle.uniforms.uTint.value.set(color);
  }

  setOpacity(value: number): void {
    this.bundle.uniforms.uOpacity.value = Math.max(0, Math.min(1, value));
  }

  // ── animation ─────────────────────────────────────────────────────────────

  play(name: AnimName, options: PlayOptions = {}): void {
    this.animator.play(name, options);
  }

  /** Play a one-shot and resolve when it finishes. */
  playOnce(name: AnimName, options: Omit<PlayOptions, 'onComplete'> = {}): Promise<void> {
    return new Promise((resolve) => {
      this.animator.play(name, { ...options, loop: false, restart: true, onComplete: resolve });
    });
  }

  /**
   * Walk the unit along a `move` path.
   *
   * The walk cycle is advanced by distance travelled, not by elapsed time, so the
   * feet stay planted whatever the speed; the hop arc over a height change is
   * handled by `PathWalker`, and the sprite plays `jump`/`land` around it.
   */
  walkPath(
    path: readonly Vec3[],
    options: PathWalkOptions & { onStep?: (index: number) => void } = {},
  ): Promise<void> {
    if (path.length < 2) {
      const last = path[path.length - 1];
      if (last) this.setCell(last.x, last.y, last.z);
      return Promise.resolve();
    }
    this.walker = new PathWalker(path, options);
    this.walkOnStep = options.onStep ?? null;
    const first = path[0];
    if (first) this.setCell(first.x, first.y, first.z);
    this.animator.play('walk', {
      restart: true,
      onFootfall: (index) => this.walkOnStep?.(index),
    });
    return new Promise((resolve) => {
      this.walkResolve = resolve;
    });
  }

  /** True while a path walk is in flight. */
  get isWalking(): boolean {
    return this.walker !== null;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  setSelection(state: SelectionState): void {
    this.selection = state;
    if (state === 'none') {
      this.ring.visible = false;
      return;
    }
    this.ring.visible = true;
    this.ring.material.color.set(SELECTION_COLORS[state]);
  }

  setTurnMarker(visible: boolean): void {
    this.markerVisible = visible;
    this.turnMarker.visible = visible;
  }

  /** KO: collapse, desaturate and stop casting a shadow into the light. */
  setKnockedOut(value: boolean): void {
    if (this.ko === value) return;
    this.ko = value;
    if (value) {
      this.animator.play('ko', { restart: true, loop: false });
      this.bundle.uniforms.uSaturation.value = 0.25;
      this.setSelection('none');
      this.setTurnMarker(false);
      // A body on the floor is still drawn as an upright billboard, so its
      // shadow would be a standing figure's — the one silhouette that gives the
      // trick away. Drop out of the shadow pass and let the contact patch, which
      // is on the ground where the body actually is, carry the grounding.
      this.mesh.castShadow = false;
    } else {
      this.animator.play('idle', { restart: true });
      this.bundle.uniforms.uSaturation.value = 1;
      this.mesh.castShadow = this.options.castShadow;
    }
    this.statusStrip.visible = !value;
  }

  /**
   * The crystal. Plays the collapse-and-rise pose while the dissolve uniform eats
   * the art a texel at a time, glowing along the dissolve front.
   */
  crystallise(duration = 1.1): Promise<void> {
    this.crystalPhase = 0;
    this.animator.play('crystal', { restart: true, loop: false });
    this.crystalDuration = Math.max(0.2, duration);
    this.setSelection('none');
    this.setTurnMarker(false);
    this.statusStrip.visible = false;
    return new Promise((resolve) => {
      this.crystalResolve = resolve;
    });
  }

  private crystalDuration = 1.1;

  /** Rebuild the status icon strip. */
  setStatuses(statuses: readonly ActiveStatus[]): void {
    const atlas = getStatusAtlas();
    const visible = statuses.filter((s) => !HIDDEN_STATUSES.has(s.status)).slice(0, MAX_STATUS_ICONS);

    while (this.statusIcons.length < visible.length) {
      const size = texelsToWorld(STATUS_ICON_TEXELS);
      const geometry = new THREE.PlaneGeometry(size, size);
      const material = new THREE.MeshBasicMaterial({
        map: atlas.texture,
        transparent: true,
        alphaTest: 0.05,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 21;
      mesh.frustumCulled = false;
      this.statusIcons.push(mesh);
      this.statusStrip.add(mesh);
    }

    for (let i = 0; i < this.statusIcons.length; i++) {
      const mesh = this.statusIcons[i];
      if (!mesh) continue;
      const entry = visible[i];
      mesh.visible = entry !== undefined;
      if (!entry) continue;
      const index = atlas.index.get(entry.status) ?? 0;
      // Per-icon UV window into the shared atlas.
      const geometry = mesh.geometry;
      const uv = geometry.attributes.uv;
      if (uv instanceof THREE.BufferAttribute) {
        const du = 1 / atlas.columns;
        const dv = 1 / atlas.rows;
        const u0 = (index % atlas.columns) * du;
        const v0 = 1 - (Math.floor(index / atlas.columns) + 1) * dv;
        uv.setXY(0, u0, v0 + dv);
        uv.setXY(1, u0 + du, v0 + dv);
        uv.setXY(2, u0, v0);
        uv.setXY(3, u0 + du, v0);
        uv.needsUpdate = true;
      }
    }

    // Centre the strip.
    const spacing = texelsToWorld(STATUS_ICON_TEXELS + 1);
    const start = -((visible.length - 1) * spacing) / 2;
    for (let i = 0; i < visible.length; i++) {
      this.statusIcons[i]?.position.set(start + i * spacing, 0, 0);
    }
  }

  /**
   * Floating combat text hook. Spawns a world-space, pixel-snapped label that
   * rises and fades from just above the unit's head.
   */
  popLabel(text: string, kind: LabelKind = 'damage'): void {
    const label = renderLabel(text, kind);
    const geometry = new THREE.PlaneGeometry(
      texelsToWorld(label.width),
      texelsToWorld(label.height),
    );
    const material = new THREE.MeshBasicMaterial({
      map: label.texture,
      transparent: true,
      alphaTest: 0.02,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 30;
    mesh.frustumCulled = false;
    this.object.add(mesh);

    // Alternate the drift so a multi-hit combo fans out instead of overprinting.
    this.labelSeed++;
    const drift = ((this.labelSeed % 2 === 0 ? 1 : -1) * (4 + (this.labelSeed % 3) * 3));
    this.labels.push({
      mesh,
      anchor: new THREE.Vector3(),
      age: 0,
      life: kind === 'crit' ? 1.25 : 1.0,
      drift,
      rise: kind === 'crit' ? 22 : 16,
    });
  }

  // ── per-frame ─────────────────────────────────────────────────────────────

  update(dt: number, view: SpriteViewContext): void {
    // 1 — advance the walker, which owns the grid position while it runs.
    if (this.walker) {
      const running = this.walker.update(dt);
      const sample = this.walker.current;
      this.setCell(sample.x, sample.y, sample.z);
      this.facing = sample.facing;
      this.animator.setLocomotion(sample.cycle);
      if (sample.airborne && this.animator.name !== 'jump') {
        this.animator.play('jump', { restart: true, loop: false });
      } else if (!sample.airborne && this.animator.name === 'jump') {
        this.animator.play('walk', {
          restart: true,
          onFootfall: (index) => this.walkOnStep?.(index),
        });
      }
      if (!running) {
        this.walker = null;
        this.animator.setLocomotion(null);
        this.animator.play('idle', { restart: true });
        const resolve = this.walkResolve;
        this.walkResolve = null;
        this.walkOnStep = null;
        resolve?.();
      }
    }

    this.animator.update(dt);

    // 2 — frame selection: facing combined with the *current* camera yaw, so a
    //     90° camera rotation swings the unit round to the correct pose.
    const selection = resolveView(this.facing, view.yawRadians);
    const frame = this.animator.frame(selection.view);
    const mirror = selection.mirror !== (frame.flip ?? false);
    this.applyFrame(frame.cell, mirror);

    // 3 — pose. Offsets are whole texels so the art stays pixel-locked.
    //     The pose's own offsets and the cell's foot-centre correction are both
    //     art-space, so both flip with the mirror; rounding happens once, after
    //     they are summed, so the art never lands half a texel out.
    const pose = this.animator.pose();
    const footCenter = this.sheet.layout.footCenterX[this.frameCell] ?? 0;
    const offsetX =
      Math.round(pose.offsetX + (frame.offsetX ?? 0) - footCenter) * (mirror ? -1 : 1);
    const offsetY = Math.round(pose.offsetY + (frame.offsetY ?? 0));

    // 4 — flash / crystal timers.
    if (this.flashTime > 0) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      const k = this.flashTime / this.flashDuration;
      // Sharp attack, quick release: the flash must read on a single frame.
      this.bundle.uniforms.uFlash.value = k * k;
    } else {
      this.bundle.uniforms.uFlash.value = 0;
    }

    if (this.crystalPhase >= 0) {
      this.crystalPhase += dt / this.crystalDuration;
      const t = Math.min(1, this.crystalPhase);
      // Hold the body for a beat, then eat it from the feet up.
      this.bundle.uniforms.uDissolve.value = Math.max(0, (t - 0.25) / 0.75);
      if (t >= 1) {
        this.crystalPhase = -1;
        this.object.visible = false;
        const resolve = this.crystalResolve;
        this.crystalResolve = null;
        resolve?.();
      }
    }

    this.bundle.uniforms.uBrightness.value = pose.brightness;

    // 5 — world placement, then the view-space pixel snap.
    const camera = view.camera;
    // `terrain.ts` centres tile (x, y) on world (x, y) — the top face spans
    // ±TILE_SIZE/2 about the integer coordinate. Anchoring at (x + 0.5) put every
    // unit on the corner where four tiles meet, which is why nothing looked
    // planted. Anchor on the tile centre, exactly like `tileWorldPosition`.
    const world = this.scratchWorld.set(
      this.cell.x * TILE_SIZE,
      this.groundY(),
      this.cell.y * TILE_SIZE,
    );

    const viewPos = this.scratchView.copy(world).applyMatrix4(camera.matrixWorldInverse);

    // Art-space offsets act in the screen plane; view x/y *are* screen right/up.
    viewPos.x += texelsToWorld(offsetX);
    viewPos.y += texelsToWorld(offsetY - this.options.footSink);
    viewPos.z += this.options.depthBias;

    const w = view.worldPerDevicePixel;
    if (w > 0) {
      viewPos.x = Math.round(viewPos.x / w) * w;
      viewPos.y = Math.round(viewPos.y / w) * w;
    }
    viewPos.applyMatrix4(camera.matrixWorld);
    this.mesh.position.copy(viewPos);

    // Y-locked billboard: rotate about world Y only, then roll in the view plane
    // for the procedural pose. Never pitch — a tipped sprite instantly reads wrong.
    this.mesh.rotation.set(0, view.yawRadians, pose.rotation, 'YXZ');
    this.mesh.scale.set(pose.scaleX, pose.scaleY, 1);

    // 6 — ground decals live in world space at the tile surface. `object` is a
    //     plain world-space container: everything under it is positioned in world
    //     coordinates, so the layer group must stay at the origin.
    const groundX = this.cell.x * TILE_SIZE;
    const groundZ = this.cell.y * TILE_SIZE;

    // Height of the feet above the tile they are over. Zero while standing;
    // positive over the top of a hop. Both the contact patch and the in-art foot
    // occlusion fade out with it, so nothing stays welded to a unit in mid-air.
    const walkSample = this.walker?.current;
    const shadowY = (walkSample?.groundZ ?? this.cell.z) * HEIGHT_UNIT;
    const lift = Math.max(0, this.cell.z * HEIGHT_UNIT - shadowY);
    this.bundle.uniforms.uGrounded.value = 1 / (1 + lift * 6);

    if (this.contactShadow) {
      // During a hop the sprite arcs above the tile, but its shadow has to stay
      // on the surface, spread, and soften — a blob that flies with the unit is
      // the classic "sticker on the screen" giveaway.
      const spread = 1 + lift * 0.9;
      const fade = 1 / (1 + lift * 2.2);
      this.contactShadow.position.set(groundX, shadowY + CONTACT_SHADOW_LIFT, groundZ);
      this.contactShadow.rotation.set(0, this.shadowYaw, 0, 'YXZ');
      // A body on the floor no longer has a standing silhouette to throw, so the
      // KO case collapses the directional tail and keeps only the contact patch.
      const stretch = this.ko ? 0.55 : this.shadowStretch;
      this.contactShadow.scale.set(spread, 1, stretch * spread);
      this.contactShadow.material.uniforms['uStrength']!.value = fade * (this.ko ? 0.62 : 1);
      this.contactShadow.visible = this.crystalPhase < 0;
    }

    if (this.ring.visible) {
      this.ringPulse += dt;
      const pulse = 1 + Math.sin(this.ringPulse * 3.4) * 0.04;
      const ringY = (this.walker?.current.groundZ ?? this.cell.z) * HEIGHT_UNIT;
      this.ring.position.set(groundX, ringY + 0.02, groundZ);
      this.ring.rotation.y = this.ringPulse * (this.selection === 'active' ? 0.6 : 0.25);
      this.ring.scale.setScalar(pulse);
      this.ring.material.opacity = 0.75 + Math.sin(this.ringPulse * 3.4) * 0.15;
    }

    // 7 — overhead furniture rides the sprite, billboarded like it. Anchored to
    //     the *measured* top of this pose's art, not to the top of the cell: the
    //     cell is 80 texels tall and a standing figure is about 40, so using the
    //     cell would park the chevron half a tile above an empty-looking square.
    const headTexels =
      (this.sheet.layout.headTopY[this.frameCell] || this.sheet.layout.frameHeight) -
      this.sheet.layout.groundOffset;
    const headY = this.mesh.position.y + texelsToWorld(headTexels) * pose.scaleY;

    if (this.markerVisible) {
      this.markerPhase += dt;
      const bob = Math.round(Math.sin(this.markerPhase * 2.6) * 1.5);
      this.turnMarker.position.set(
        this.mesh.position.x,
        // A third of a body-height of clear air reads as a marker hovering over
        // an empty square; the chevron wants to sit just off the crown.
        headY + texelsToWorld(7 + bob),
        this.mesh.position.z,
      );
      this.turnMarker.rotation.set(0, view.yawRadians, 0, 'YXZ');
    }

    this.statusStrip.position.set(
      this.mesh.position.x,
      headY + texelsToWorld(9),
      this.mesh.position.z,
    );
    this.statusStrip.rotation.set(0, view.yawRadians, 0, 'YXZ');

    // 8 — floating text.
    if (this.labels.length > 0) this.updateLabels(dt, view, headY);
  }

  private updateLabels(dt: number, view: SpriteViewContext, headY: number): void {
    const w = view.worldPerDevicePixel;
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const label = this.labels[i];
      if (!label) continue;
      label.age += dt;
      const t = label.age / label.life;
      if (t >= 1) {
        this.object.remove(label.mesh);
        label.mesh.geometry.dispose();
        label.mesh.material.dispose();
        this.labels.splice(i, 1);
        continue;
      }
      // Pop up fast, coast, then fall away — the classic combat-number curve.
      const rise = 1 - Math.pow(1 - Math.min(1, t / 0.55), 3);
      const sink = t > 0.8 ? Math.pow((t - 0.8) / 0.2, 2) * 5 : 0;
      const viewPos = this.scratchView.set(
        this.mesh.position.x,
        headY + texelsToWorld(6),
        this.mesh.position.z,
      );
      viewPos.applyMatrix4(view.camera.matrixWorldInverse);
      viewPos.x += texelsToWorld(label.drift * Math.min(1, t * 2));
      viewPos.y += texelsToWorld(label.rise * rise - sink);
      if (w > 0) {
        viewPos.x = Math.round(viewPos.x / w) * w;
        viewPos.y = Math.round(viewPos.y / w) * w;
      }
      viewPos.applyMatrix4(view.camera.matrixWorld);
      label.mesh.position.copy(viewPos);
      label.mesh.rotation.set(0, view.yawRadians, 0, 'YXZ');
      label.mesh.material.opacity = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
    }
  }

  private applyFrame(cell: number, mirror = false): void {
    this.frameCell = cell;
    this.sheet.frameRect(cell, this.frameRect);
    this.bundle.setFrame(
      this.frameRect.x,
      this.frameRect.y,
      this.frameRect.z,
      this.frameRect.w,
      mirror,
    );
  }

  dispose(): void {
    this.bundle.dispose();
    this.contactShadow?.material.dispose();
    this.contactShadow?.geometry.dispose();
    this.ring.material.dispose();
    this.ring.geometry.dispose();
    this.turnMarker.material.dispose();
    this.turnMarker.geometry.dispose();
    for (const icon of this.statusIcons) {
      icon.material.dispose();
      icon.geometry.dispose();
    }
    for (const label of this.labels) {
      label.mesh.geometry.dispose();
      label.mesh.material.dispose();
    }
    this.labels = [];
    this.object.removeFromParent();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SpriteLayer
// ─────────────────────────────────────────────────────────────────────────────

export interface SpriteLayerOptions {
  /** Prefix for asset URLs. Defaults to the Vite base, i.e. site root. */
  baseUrl?: string;
  /** Override asset resolution — the asset pipeline's manifest plugs in here. */
  resolve?: (key: string) => ResolvedSheetAssets;
  /** Per-sheet layout / clip overrides, keyed by logical sprite key. */
  overrides?: Record<string, SpriteSheetOverrides>;
  sprite?: UnitSpriteOptions;
}

/**
 * Owns every unit sprite plus the shared sheet cache.
 *
 * `update` must run **after** the camera has been updated for the frame and
 * before the render call: the pixel snap reads `camera.matrixWorldInverse`, and a
 * stale matrix would put every sprite half a pixel out.
 */
export class SpriteLayer {
  readonly group = new THREE.Group();

  private readonly sheets = new Map<string, Promise<SpriteSheet>>();
  private readonly sprites = new Map<UnitId, UnitSprite>();
  private readonly options: SpriteLayerOptions;
  private readonly keyLight = new THREE.Vector3(-0.5, -1, -0.35).normalize();
  private rimColor: THREE.ColorRepresentation = 0xffe6b8;
  private tone: Parameters<UnitSprite['setSceneTone']>[0] = {};

  constructor(options: SpriteLayerOptions = {}) {
    this.options = options;
    this.group.name = 'SpriteLayer';
  }

  /** Load (or reuse) a sheet by logical sprite key. */
  sheet(key: string): Promise<SpriteSheet> {
    const existing = this.sheets.get(key);
    if (existing) return existing;

    const resolved = this.options.resolve
      ? this.options.resolve(key)
      : resolveSheetAssets(key, this.options.baseUrl ?? defaultBaseUrl());

    const promise = (async () => {
      const image = await loadIndexedImage(resolved.url);
      const palettes: Uint8Array[] = [];
      if (resolved.paletteUrls.length > 0) {
        const loaded = await Promise.all(
          resolved.paletteUrls.map((url) =>
            loadActPalette(url).catch(() => null),
          ),
        );
        for (const palette of loaded) {
          if (palette) palettes.push(palette);
        }
      }
      // Always keep the baked palette as slot 0 so a sheet with no `.act` family
      // still renders in its shipped colours.
      if (palettes.length === 0) palettes.push(image.palette);
      return new SpriteSheet(key, image, palettes, this.options.overrides?.[key]);
    })();

    this.sheets.set(key, promise);
    return promise;
  }

  /** Create the sprite for a unit and add it to the scene. */
  async add(unit: Unit): Promise<UnitSprite> {
    const existing = this.sprites.get(unit.id);
    if (existing) return existing;

    const sheet = await this.sheet(unit.sprite.sheet);
    const sprite = new UnitSprite(unit.id, sheet, this.options.sprite);
    sprite.setFromUnit(unit);
    sprite.setKeyLight(this.keyLight, this.rimColor);
    sprite.setSceneTone(this.tone);
    this.sprites.set(unit.id, sprite);
    this.group.add(sprite.object);
    return sprite;
  }

  get(unitId: UnitId): UnitSprite | undefined {
    return this.sprites.get(unitId);
  }

  get all(): Iterable<UnitSprite> {
    return this.sprites.values();
  }

  remove(unitId: UnitId): void {
    const sprite = this.sprites.get(unitId);
    if (!sprite) return;
    sprite.dispose();
    this.sprites.delete(unitId);
  }

  /**
   * Point the sprites at the scene's key light so their rim and impostor shading
   * agree with the terrain. Call whenever the map's lighting is (re)built.
   */
  setKeyLight(direction: THREE.Vector3, rimColor?: THREE.ColorRepresentation): void {
    this.keyLight.copy(direction).normalize();
    if (rimColor !== undefined) this.rimColor = rimColor;
    for (const sprite of this.sprites.values()) sprite.setKeyLight(this.keyLight, this.rimColor);
  }

  /** Scene tone (shadow floor, ground bounce, cool back rim) for every unit. */
  setSceneTone(tone: Parameters<UnitSprite['setSceneTone']>[0]): void {
    this.tone = { ...this.tone, ...tone };
    for (const sprite of this.sprites.values()) sprite.setSceneTone(this.tone);
  }

  update(dt: number, view: SpriteViewContext): void {
    for (const sprite of this.sprites.values()) sprite.update(dt, view);
  }

  /** Resolves once every sheet requested so far has loaded — for the shot harness. */
  async ready(): Promise<void> {
    await Promise.all([...this.sheets.values()]);
  }

  dispose(): void {
    for (const sprite of this.sprites.values()) sprite.dispose();
    this.sprites.clear();
    for (const promise of this.sheets.values()) {
      void promise.then((sheet) => sheet.dispose()).catch(() => undefined);
    }
    this.sheets.clear();
    this.group.removeFromParent();
  }
}

export { facingFromDelta, resolveView };
export type { AnimSet, ViewKey };
