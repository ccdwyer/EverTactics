/**
 * EverTactics — the game.
 *
 * This is where the eleven subsystems become one program: core state on one
 * side, three.js on the other, the DOM UI over the top, and a single turn loop
 * that only ever mutates the battle by handing a `Command` to the reducer and
 * animating the `BattleEvent[]` that comes back.
 *
 * Structure:
 *   `Game.boot()`      builds the stage, camera, lighting, terrain, sprites,
 *                      VFX, post stack and UI, and blocks convergence until the
 *                      sprite sheets have decoded.
 *   `Game.beginTurn()` decides whether a human or the AI holds the turn.
 *   `Game.submit()`    the single funnel every command passes through.
 *   `Game.play()`      turns one event stream into motion, sound and floating
 *                      numbers, and resolves when the field is at rest again.
 *
 * Interaction state lives in `this.mode`. There are exactly four modes and the
 * transitions between them are the whole of the player-facing game: `idle` →
 * `command` → (`move` | `target`) → back to `command` or on to the next turn.
 */

import * as THREE from 'three';

import { SPRITE_LAYER, installPostStack, markAsSprite, type PostStackPipeline } from './render';
import { ALL_ABILITIES, bootstrapContent } from './content';
import {
  BATTLE_DROP_TABLE,
  ITEMS_BY_ID,
  findItem,
  shopStockForChapter,
} from './items';
import { actionSetOf } from './abilityIndex';
import {
  abilityTargetsTiles,
  canAimAt,
  coveredTiles,
  legalTargets,
  primaryTargetAt,
} from './targeting';
import {
  abilityById,
  abilityItemsFor,
  commandItemsFor,
  portraitFor,
  targetPreviewVM,
  turnOrderVM,
  unitVM,
} from './viewModels';
import {
  buildScenario,
  campaignToBattle,
  getEncounter,
  getScenario,
  isDiagnosticScenario,
  launchCampaignBattle,
  newGameCampaign,
  overrideScenario,
  scenarioMapDef,
  type BuiltScenario,
  type Scenario,
} from './scenarios';
import {
  campaignFormationScreenVM,
  campaignJobScreenVM,
  campaignRosterScreenVM,
  shopScreenVM,
  worldMapScreenVM,
} from './screens';
import {
  continueCampaign,
  startNewCampaign,
  titleScreenVM,
} from './onboarding';
import { loadCampaign, saveCampaign } from './save';

import { createAiWorld, decideTurn, type AiWorld } from '@core/ai';
import {
  battleToCampaign,
  createCampaign,
  unitToPersisted,
  type CampaignState,
  type FormationEntry,
} from '@core/campaign';
import { buyItem, computeBattleRewards, sellItem } from '@core/economy';
import { stockAwareWorld } from '@core/inventory';
import { WORLD_NODES, completeTravelNode, isUnlocked, type WorldNode } from '@core/world';
import { IllegalCommandError, advance, affectedTiles, applyCommand } from '@core/battle';
import {
  buildOccupancy,
  facingBetween,
  getMapDef,
  isInRange,
  pathTo,
  reachableDestinations,
  tileKey,
  tilesInBurst,
} from '@core/grid';
import { getJob } from '@core/jobs';
import {
  deriveStats,
  effectiveRange,
  isKO,
  jobProgress,
} from '@core/unit';
import type {
  Ability,
  BattleEvent,
  BattleState,
  Command,
  JobId,
  Unit,
  UnitId,
  Vec3,
} from '@core/types';
import {
  dispatchPartyIntent,
  partyEditAllowed,
  unlockContextForUnit,
  type PartyMutationIntent,
} from './partyEdit';

import {
  AbilityCameraDirector,
  abilityCameraFocus,
  abilityCameraProfile,
} from '@render/abilityCamera';
import { IsoCamera, TILE_SIZE } from '@render/camera';
import { LightingRig } from '@render/lighting';
import { SpriteLayer, type UnitSprite } from '@render/sprites';
import { Stage } from '@render/stage';
import { Terrain, buildTerrain, tileWorldPosition } from '@render/terrain';
import { VFX_KEYS, VfxSystem, type ChargeHandle } from '@render/vfx';
import { UIRoot } from '@ui/UIRoot';
import { createBattleAudioObserver } from '@ui/battleAudio';
import type {
  FloatTextVM,
  ResultScreenVM,
  ResultUnitVM,
  UIIntent,
} from '@ui/types';

// ─────────────────────────────────────────────────────────────────────────────
// Interaction state
// ─────────────────────────────────────────────────────────────────────────────

type Mode =
  /** Nothing to do — the clock is running or the AI is thinking. */
  | { kind: 'idle' }
  /** Command menu open for the active unit. */
  | { kind: 'command' }
  /** Picking a destination; the reachable set is painted on the terrain. */
  | { kind: 'move'; reach: ReturnType<typeof reachableDestinations> }
  /** Picking an aim point for a chosen ability. */
  | { kind: 'target'; ability: Ability; legal: Set<string> };

type AppSurface = 'battle' | 'title' | 'world-map';

export interface GameOptions {
  scenarioId?: string;
  /** Normal app boot: wait at the title screen for New Game or Continue. */
  title?: boolean;
  /** Normal app boot: show campaign navigation instead of entering a battle. */
  worldMap?: boolean;
  /** Container for the WebGL canvas. Defaults to `#app`. */
  container?: HTMLElement;
  /** Container for the DOM UI. Defaults to `#ui`. */
  uiMount?: HTMLElement;
  /** Screenshot mode: pose the scene and hold, do not run enemy turns. */
  shot?: boolean;
  /** Query string, for the `?lighting=` / `?grade=` / `?zoom=` critic overrides. */
  params?: URLSearchParams;
}

const SPRITE_ANIM_FOR_FORMULA: Readonly<Record<string, 'attack' | 'cast' | 'item'>> = {
  physical: 'attack',
  magical: 'cast',
  heal: 'cast',
  drain: 'cast',
  summon: 'cast',
  raise: 'cast',
  buff: 'cast',
  'status-only': 'cast',
  fixed: 'cast',
  'percent-hp': 'cast',
  special: 'attack',
  move: 'cast',
};

type ActionFeedbackEvent = Extract<
  BattleEvent,
  {
    kind:
      | 'damage'
      | 'heal'
      | 'miss'
      | 'status-add'
      | 'status-remove'
      | 'knockdown'
      | 'crystal';
  }
>;

function isActionFeedbackEvent(event: BattleEvent): event is ActionFeedbackEvent {
  switch (event.kind) {
    case 'damage':
    case 'heal':
    case 'miss':
    case 'status-add':
    case 'status-remove':
    case 'knockdown':
    case 'crystal':
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Game
// ─────────────────────────────────────────────────────────────────────────────

export class Game {
  readonly stage: Stage;
  readonly camera: IsoCamera;
  readonly abilityCamera: AbilityCameraDirector;
  readonly lighting: LightingRig;
  readonly sprites = new SpriteLayer();
  readonly vfx: VfxSystem;
  readonly ui: UIRoot;

  terrain: Terrain | null = null;
  post: PostStackPipeline | null = null;

  readonly scenario: Scenario;
  /** Reassigned when formation confirm relaunches from the campaign. */
  built: BuiltScenario;
  state: BattleState;
  /** Durable company — roster, inventory, formation. Survives refresh. */
  campaign: CampaignState;

  private mode: Mode = { kind: 'idle' };
  private readonly shot: boolean;
  private appSurface: AppSurface;
  private readonly worldNodeId: string | null;
  private pendingWorldNode: WorldNode | null = null;
  private shopNode: WorldNode | null = null;
  private busy = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly battleAudio = createBattleAudioObserver();
  private readonly chargeVfx = new Map<UnitId, ChargeHandle>();
  private battleStarted = false;
  private hoverTile: Vec3 | null = null;
  private disposed = false;
  private readonly disposers: (() => void)[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly screen = { x: 0, y: 0, depth: 0, visible: false };
  /** Working formation slate while the formation screen is open. */
  private formationDraft: FormationEntry[] = [];

  constructor(options: GameOptions = {}) {
    bootstrapContent();

    const base = getScenario(options.scenarioId);
    this.scenario = options.params ? overrideScenario(base, options.params) : base;
    this.shot = options.shot ?? false;
    this.appSurface = options.title
      ? 'title'
      : options.worldMap
        ? 'world-map'
        : 'battle';
    this.worldNodeId = options.params?.get('node') ?? null;

    // Diagnostic scenes alone keep the hardcoded cast. Every real battle,
    // including non-diagnostic screenshot scenes, selects a campaign first and
    // then enters through campaignToBattle.
    if (this.appSurface !== 'battle') {
      const loaded = this.appSurface === 'title' ? null : loadCampaign();
      this.campaign =
        loaded !== null && loaded.roster.length > 0
          ? loaded
          : newGameCampaign(getScenario('battle-open'), Date.now());
      // The map is a full-screen UI surface. Keep a real, deterministic field
      // behind it so renderer boot and tooling globals retain their normal shape,
      // but do not enter campaignToBattle or pin an unchosen destination.
      const backdrop: Scenario = {
        ...this.scenario,
        layers: { ...this.scenario.layers, sprites: false, highlights: false },
        units: [],
        openCommandMenu: false,
      };
      this.built = buildScenario(backdrop);
      this.state = this.built.state;
      this.battleOver = true;
      if (this.appSurface === 'world-map') saveCampaign(this.campaign);
    } else if (isDiagnosticScenario(this.scenario.id)) {
      this.built = buildScenario(this.scenario);
      this.state = this.built.state;
      this.campaign = this.seedCampaignFromField({ persist: false });
    } else {
      const routedNode = this.routedWorldNode();
      const launched = launchCampaignBattle(this.scenario, {
        // Tooling must never read or overwrite the player's durable company.
        campaign: this.shot ? null : loadCampaign(),
        timestamp: Date.now(),
        // Keep the authored composition while still exercising the campaign path.
        preserveScenarioPlayerPlacements: this.shot,
        ...(routedNode === undefined ? {} : { worldNodeId: routedNode.id }),
      });
      this.campaign = launched.campaign;
      this.built = launched.built;
      this.state = this.built.state;
      // Persist the node selected by the world map before play begins. Direct
      // scenario boots preserve the existing navigation value.
      if (!this.shot) saveCampaign(this.campaign);
    }
    this.snapshotProgress();

    const stageOptions: ConstructorParameters<typeof Stage>[0] = {
      autoStart: false,
      exposeGlobal: true,
      // A screenshot must not race the animation queue: hold the frame loop's
      // convergence flag until the scene is actually posed.
      stableFrames: this.shot ? 4 : 3,
    };
    if (options.container) stageOptions.container = options.container;
    this.stage = new Stage(stageOptions);

    const camOptions: ConstructorParameters<typeof IsoCamera>[0] = {
      yawIndex: this.scenario.camera.yawIndex,
    };
    if (this.scenario.camera.pixelScale !== undefined) {
      camOptions.pixelScale = this.scenario.camera.pixelScale;
    }
    if (this.scenario.camera.pitchDegrees !== undefined) {
      camOptions.pitchDegrees = this.scenario.camera.pitchDegrees;
    }
    this.camera = new IsoCamera(camOptions);
    this.abilityCamera = new AbilityCameraDirector(
      this.camera,
      typeof window === 'undefined' ? new EventTarget() : window,
    );
    this.stage.setCamera(this.camera);
    // Sprites live on their own Layers channel so post can isolate them; the
    // camera has to be told to render it or the field is empty.
    this.camera.camera.layers.enable(SPRITE_LAYER);

    this.lighting = new LightingRig(this.stage.scene, { preset: this.scenario.lighting });
    this.lighting.bindRenderer(this.stage.renderer);
    this.applyMapLighting();

    this.vfx = new VfxSystem({ tileSize: TILE_SIZE, seed: this.scenario.seed });
    this.vfx.addTo(this.stage.scene);

    const uiMount =
      options.uiMount ?? (document.getElementById('ui') as HTMLElement | null) ?? document.body;
    this.ui = new UIRoot(uiMount, { sound: !this.shot });
    this.disposers.push(this.ui.on((intent) => this.onIntent(intent)));
    if (!this.scenario.layers.ui) this.ui.setHudVisible(false);
  }

  private routedWorldNode(): WorldNode | undefined {
    if (this.worldNodeId === null) return undefined;
    return WORLD_NODES.find(
      (node) =>
        node.id === this.worldNodeId &&
        node.scenarioId === this.scenario.id,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Boot
  // ───────────────────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    const release = this.stage.hold('scenario');

    if (this.scenario.layers.post) {
      this.post = installPostStack(this.stage, {
        grade: this.scenario.grade,
        tileSize: TILE_SIZE,
        quality: 'high',
      });
      this.vfx.attachPost(this.post.stack);
      this.applyPostProfile();
    }

    if (this.scenario.layers.terrain) this.buildTerrain();
    this.fitLighting();

    if (this.scenario.layers.sprites) {
      await this.stage.addLoadBarrier(this.spawnSprites(), 'sprites');
    }

    this.installFrameCallbacks();
    this.installPointerHandling();
    this.installScreenKeys();

    // Framing has to happen after the first resize: `frameField` picks the
    // largest zoom level that fits the drawing buffer, and before `resize()` the
    // buffer is still 1x1.
    this.stage.resize();
    this.frameCamera();
    this.stage.start();

    if (this.appSurface === 'title') {
      this.showTitle();
      release();
      return;
    }

    if (this.appSurface === 'world-map') {
      this.showWorldMap();
      release();
      return;
    }

    // Run the clock to the first turn before releasing the convergence barrier,
    // so a screenshot never catches the field mid-deploy.
    await this.openingSequence();
    release();
  }

  /**
   * Push the scenario's post tuning into the stack.
   *
   * `LightingRig` writes its preset exposure to `renderer.toneMappingExposure`,
   * which is dead once `PostStack` owns tone mapping — so exposure is carried on
   * the scenario and applied here, multiplied by the preset's own value so a
   * night map still reads darker than a noon map.
   */
  private applyPostProfile(): void {
    const stack = this.post?.stack;
    if (!stack) return;
    const profile = this.scenario.post ?? {};

    // Exposure has ONE owner, not two.
    //
    // This used to be `scenario.post.exposure * lightingPreset.exposure`, a product
    // of two numbers owned by two different people. During one polish round the
    // scenario value went 2.65 -> 3.4 -> 3.9 while the preset factor was cut
    // 1.4 -> 0.95: each change was real, the product barely moved, and both parties
    // concluded their edit "wasn't reaching the frame". Two agents cancelled each
    // other twice on the same dial.
    //
    // So: when a scenario states an exposure it is FINAL — it is the composition's
    // call, which is where a DP would set it. A preset's own exposure applies only
    // to scenarios that decline to specify one. The lighting rig keeps everything
    // else (key/fill ratio, chroma, colour split, bounce), all of which is
    // ratio-based and survives whatever absolute exposure lands on.
    stack.settings.exposure = profile.exposure ?? this.lighting.current.exposure;

    // …and the surround has to be told, because post exposure multiplies the
    // composited buffer and the backdrop sits at the bottom of its range.
    //
    // Halving exposure roughly halves the board's midtones — which is the point —
    // but it pushes the distant town, its window practicals and the silhouette
    // layer under the black point entirely, and the frame reverts to a lit island
    // in a void. That is not a subtle regression: on `battle-open` the round-6
    // exposure change took the connected-component void from 0.114 to 0.246
    // against a reference band of 0.087–0.180 and a hard fail at 0.25, while
    // background detail fell 13.58 -> 7.31.
    //
    // The surround's final luminance is a composition choice, not a lighting one:
    // it should look the same however the board is exposed. So its gain is the
    // inverse of the exposure, normalised so the shipped `battle-open` value of
    // 2.1 produces a gain of 2.5 — measured, not guessed. That lands the void at
    // 0.108 and background detail at 12.26, both back inside the band, with the
    // board's own grade untouched. See `WorldEnvironment.setExposure`.
    //
    // This applies ONLY when the scenario states an exposure, because only then is
    // the number on the same scale as the reference. A preset's own exposure is a
    // mood weight in the low single digits (`dawn` is 0.78), not a composition
    // value, and dividing by it produces a gain 4-5x too high: `mandalia-ford`
    // declines to state an exposure, and running the formula on its fallback lit
    // the distant town brighter than the board it frames. A scenario that wants a
    // compensated surround should say what its exposure is.
    const SURROUND_REFERENCE = 5.25;
    if (profile.exposure !== undefined) {
      const gain = SURROUND_REFERENCE / Math.max(0.35, profile.exposure);
      this.stage.environment?.setExposure(Math.min(3.4, Math.max(0.6, gain)));
    }

    // `post.ts` derives its defocus shape from a measured reference rubric
    // (`REFERENCE_FLOOR`). A scenario should be able to say "less of that" without
    // replacing the shape, so every term scales from whatever the stack chose —
    // otherwise a tuning pass in post.ts silently stops applying here.
    const dof = profile.dof ?? 1;
    if (dof <= 0) {
      stack.setEffectEnabled('dof', false);
    } else if (dof !== 1) {
      const d = stack.settings.dof;
      d.intensity *= dof;
      d.maxCoCPixels *= dof;
      d.tiltRadial *= dof;
      // A weaker blur wants a wider sharp band, or the picture just goes soft
      // everywhere instead of having a subject.
      d.tiltBand = Math.min(0.5, d.tiltBand / dof);
      d.tiltFalloff = Math.min(0.6, d.tiltFalloff / Math.sqrt(dof));
    }
    if (profile.ao !== undefined) {
      stack.setEffectIntensity('ao', stack.getEffectIntensity('ao') * profile.ao);
    }
    if (profile.bloom !== undefined) {
      stack.setEffectIntensity('bloom', stack.getEffectIntensity('bloom') * profile.bloom);
    }
    if (profile.vignette !== undefined) {
      stack.setEffectIntensity('vignette', stack.getEffectIntensity('vignette') * profile.vignette);
    }
  }

  /**
   * Fold the map's authored lighting into the preset, then the scenario's own
   * patch on top. `MapDef.lighting` is real data the map author wrote down (sun
   * bearing, elevation, sky and ground fill, fog) and nothing was reading it.
   */
  private applyMapLighting(): void {
    const def = scenarioMapDef(this.scenario);
    if (def) {
      const m = def.lighting;
      this.lighting.tune({
        keyColor: m.sunColor,
        keyIntensity: m.sunIntensity,
        keyAzimuth: m.sunAzimuth,
        keyElevation: m.sunElevation,
        skyColor: m.skyColor,
        groundColor: m.groundColor,
        ambientIntensity: m.ambientIntensity,
        fogColor: m.fogColor,
      });
    }
    if (this.scenario.lightingTune) this.lighting.tune(this.scenario.lightingTune);
  }

  private buildTerrain(): void {
    const terrain = buildTerrain(this.state.field);
    this.terrain = terrain;
    this.stage.scene.add(terrain);

    // The map author's own sun direction, so water glint agrees with the key.
    const preset = this.lighting.current;
    const water = terrain.water;
    if (water) {
      const azimuth = THREE.MathUtils.degToRad(preset.keyAzimuth);
      const elevation = THREE.MathUtils.degToRad(preset.keyElevation);
      water.setSun(
        new THREE.Vector3(
          Math.sin(azimuth) * Math.cos(elevation),
          Math.sin(elevation),
          -Math.cos(azimuth) * Math.cos(elevation),
        ).normalize(),
        new THREE.Color(preset.keyColor),
      );
      water.setSky(new THREE.Color(preset.skyColor), new THREE.Color(preset.fogColor));
    }
  }

  private fitLighting(): void {
    const field = this.state.field;
    let maxHeight = 1;
    for (const tile of field.tiles) {
      if (tile.surface !== 'void' && tile.height > maxHeight) maxHeight = tile.height;
    }
    this.lighting.fitToGrid(field.width, field.height, maxHeight + 3);

    // Point the sprite rim/impostor shading at the same key the terrain uses.
    const direction = this.scratch
      .copy(this.lighting.key.position)
      .sub(this.lighting.key.target.position)
      .normalize()
      .multiplyScalar(-1);
    this.sprites.setKeyLight(direction.clone(), this.lighting.current.rimColor);
  }

  private async spawnSprites(): Promise<void> {
    this.stage.scene.add(this.sprites.group);
    const units = [...this.state.units.values()];
    await Promise.all(
      units.map(async (unit) => {
        try {
          const sprite = await this.sprites.add(unit);
          markAsSprite(sprite.object);
          this.syncSprite(unit, sprite);
        } catch (err) {
          console.error(`[game] sprite for ${unit.name} (${unit.sprite.sheet}) failed:`, err);
        }
      }),
    );
  }

  private frameCamera(): void {
    const cam = this.scenario.camera;
    if (cam.frameField) {
      this.camera.frameField(this.state.field, 4, {
        ...(cam.fitWholeField === true ? { fitWholeField: true } : {}),
      });
    }
    if (cam.pixelScale !== undefined) void this.camera.setPixelScale(cam.pixelScale, true);
    if (cam.focusTile) this.camera.focusTile(cam.focusTile, { immediate: true });
  }

  private installFrameCallbacks(): void {
    this.disposers.push(
      this.stage.onRender((dt) => {
        if (this.disposed) return;
        // Hit-stop scales everything downstream, so take the VFX system's dt.
        const scaled = this.vfx.update(dt, this.camera.camera);
        // Keep the key light out of the camera's own bearing. When the two come
        // within ~10 degrees every shadow falls directly behind the object
        // casting it, into pixels that object already covers — the map renders a
        // correct 2048² shadow map that the view cannot see a texel of, and the
        // scene reads as having no shadows at all. Syncing per frame (rather
        // than on the rotate handler) tracks the eased yaw through the whole
        // snap; the rig ignores sub-quarter-degree changes, so this is cheap.
        this.lighting.setViewYawDegrees(THREE.MathUtils.radToDeg(this.camera.yawRadians));
        // The rig drives preset cross-fades and its flickering practicals; with
        // nothing calling it, torches render as static blobs and a mood change
        // never completes.
        this.lighting.update(scaled);
        this.sprites.update(scaled, this.camera);
        this.terrain?.update(scaled);
        // Water refraction and contact foam need the scene captured *before*
        // the main render. Cheap no-op on a map with no water.
        if (this.terrain) {
          this.terrain.prepare(this.stage.renderer, this.stage.scene, this.camera.camera);
        }
      }),
    );

    this.disposers.push(
      this.stage.onResize(() => {
        this.ui.refreshLayout();
      }),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Opening
  // ───────────────────────────────────────────────────────────────────────────

  private async openingSequence(): Promise<void> {
    // Diagnostic scenes keep their existing banner. Authored encounters present
    // their map and encounter names after the boot splash through startBattle.
    if (
      this.scenario.banner
      && this.scenario.layers.ui
      && !this.shot
      && isDiagnosticScenario(this.scenario.id)
    ) {
      this.ui.banner(this.scenario.banner.title, {
        ...(this.scenario.banner.subtitle !== undefined
          ? { subtitle: this.scenario.banner.subtitle }
          : {}),
        duration: 2600,
      });
    }

    if (this.state.units.size === 0) {
      this.refreshHud();
      return;
    }

    // Advance to the first turn without animating: nothing has happened yet.
    advance(this.state);

    // A screenshot should always show a player's turn, so a scenario whose CT
    // roll happens to favour an enemy still poses the same way. Enemy turns are
    // burned with a bare Wait, which costs 20 CT and keeps the clock honest.
    if (this.shot) {
      for (let guard = 0; guard < 24; guard++) {
        const holder = this.activeUnit();
        if (!holder || holder.team === 'player') break;
        applyCommand(this.state, { kind: 'wait', unit: holder.id });
        advance(this.state);
      }
    }

    this.syncAll();
    this.refreshHud();

    const active = this.activeUnit();
    if (!active) return;

    // `frameField` chooses the zoom and centres the board. When the composition
    // floor crops that board (the normal case) the focus has to move onto the
    // acting unit, or the subject ends up off-frame or under a HUD panel; when
    // the scenario asked for the whole field in shot, the board centre is the
    // subject and moving off it just puts dead space on one side.
    if (this.scenario.camera.focusTile) {
      this.camera.focusTile(this.scenario.camera.focusTile, { immediate: this.shot });
    } else if (!this.scenario.camera.fitWholeField) {
      this.camera.focusTile(active.pos, { immediate: this.shot });
    }

    if (active.team === 'player' && this.scenario.openCommandMenu) {
      this.enterCommandMode(active);
      if (this.scenario.layers.ui) {
        this.ui.setInspectedUnit(unitVM(this.state, this.firstHostile(active) ?? active));
      }
    }
  }

  /**
   * Present the authored field card once the opening camera is visible, then
   * hand control to the ordinary recursive turn loop.
   */
  async startBattle(): Promise<void> {
    if (this.disposed || this.shot || this.appSurface !== 'battle' || this.battleStarted) return;
    this.battleStarted = true;

    if (this.scenario.layers.ui && !isDiagnosticScenario(this.scenario.id)) {
      const encounter = getEncounter(this.scenario.encounterId);
      const map = scenarioMapDef(this.scenario);
      if (encounter && map) {
        await this.ui.presentBattleIntro({
          mapName: map.name,
          encounterName: encounter.name,
        });
      } else if (this.scenario.banner) {
        await this.ui.presentBattleIntro({
          mapName: this.scenario.banner.title,
          encounterName: this.scenario.banner.subtitle ?? this.scenario.name,
        });
      } else if (map) {
        await this.ui.presentBattleIntro({
          mapName: map.name,
          encounterName: this.scenario.name,
        });
      }
    }

    if (!this.disposed) await this.beginTurn();
  }

  /** The nearest enemy — used to fill the inspection panel on the opening frame. */
  private firstHostile(unit: Unit): Unit | undefined {
    let best: Unit | undefined;
    let bestDistance = Infinity;
    for (const other of this.state.units.values()) {
      if (other.removed || other.team === unit.team) continue;
      const d = Math.abs(other.pos.x - unit.pos.x) + Math.abs(other.pos.y - unit.pos.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = other;
      }
    }
    return best;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Turn loop
  // ───────────────────────────────────────────────────────────────────────────

  private activeUnit(): Unit | undefined {
    return this.state.active === undefined ? undefined : this.state.units.get(this.state.active);
  }

  /**
   * The world the AI reasons about: the real ability table, plus the one rule
   * the evaluator does not know on its own — a consumable the side has run out
   * of is not an option. Without this the AI happily plans "drink a Potion" and
   * the reducer rejects the command, wasting the unit's turn.
   *
   * Rebuilt per turn because the stock it closes over changes as items are used.
   */
  private aiWorld(): AiWorld {
    return stockAwareWorld(createAiWorld({ abilities: ALL_ABILITIES, items: ITEMS_BY_ID }));
  }

  /** Hand the turn to whoever holds it. Player → menu; enemy → AI. */
  async beginTurn(): Promise<void> {
    if (this.disposed || this.shot) return;
    if (isOver(this.state)) {
      this.onBattleOver();
      return;
    }

    if (this.state.phase !== 'awaiting-command') {
      const events = advance(this.state);
      await this.play(events);
      if (isOver(this.state)) {
        this.onBattleOver();
        return;
      }
    }

    const unit = this.activeUnit();
    if (!unit) return;

    this.refreshHud();
    this.camera.focusTile(unit.pos);

    if (unit.team === 'player') {
      this.enterCommandMode(unit);
      return;
    }

    // The AI gets the real ability table and the scenario's archetypes; anything
    // it emits goes through the exact same reducer the player's input does.
    await sleep(280);
    const commands = decideTurn(this.state, unit.id, {
      world: this.aiWorld(),
      personalities: this.built.personalities,
    });
    for (const command of commands) {
      if (this.state.active !== unit.id) break;
      const ok = await this.submit(command);
      if (!ok) break;
    }
    // A rejected or incomplete deterministic plan must not be recomputed while
    // the same unit still holds the turn. The rejected command was already
    // logged by submit; waiting costs the unit its turn and lets the clock move.
    if (this.state.phase === 'awaiting-command' && this.state.active === unit.id) {
      await this.submit({ kind: 'wait', unit: unit.id });
    }
    void this.beginTurn();
  }

  /**
   * The single funnel. Every command — player, AI, scripted — goes through here,
   * so validation, animation and HUD refresh happen in exactly one place.
   *
   * Returns false when the reducer rejected the command. The UI is supposed to
   * only offer legal commands, so a rejection is a bug. It is logged once and
   * the caller decides how to recover without bypassing the reducer.
   */
  async submit(command: Command): Promise<boolean> {
    if (this.disposed) return false;
    let events: BattleEvent[];
    try {
      events = applyCommand(this.state, command);
    } catch (err) {
      if (err instanceof IllegalCommandError) {
        console.warn('[game] rejected command', command, err.message);
        return false;
      }
      throw err;
    }
    await this.play(events);
    this.refreshHud();
    return true;
  }

  private battleOver = false;

  private onBattleOver(): void {
    if (this.battleOver) return;
    this.battleOver = true;

    const victory = this.state.phase === 'victory';
    const authoredEncounter = getEncounter(this.scenario.encounterId);
    const encounter = victory ? authoredEncounter : undefined;
    const economy =
      encounter !== undefined
        ? computeBattleRewards(
            this.campaign.seed,
            this.state.campaignNodeId ?? this.scenario.id,
            encounter.enemies,
            BATTLE_DROP_TABLE,
          )
        : undefined;
    const rewards =
      encounter !== undefined && economy !== undefined
        ? {
            exp: encounter.rewards.exp,
            jp: encounter.rewards.jp,
            gil: economy.gil,
            items: economy.items,
          }
        : undefined;
    this.setMode({ kind: 'idle' });
    this.ui.closeMenus();
    // Fold field progress (JP, exp, inventory stock) back into the campaign so
    // a refresh mid-result still keeps what was earned.
    const nextCampaign = battleToCampaign(
      this.campaign,
      this.state,
      Date.now(),
      rewards,
    );
    if (isDiagnosticScenario(this.scenario.id)) {
      this.campaign = nextCampaign;
    } else {
      this.persistCampaign(nextCampaign);
    }
    if (!this.scenario.layers.ui) return;

    // The result screen counts up from the snapshot taken at deploy, so the
    // numbers on it are the real JP and EXP the reducer awarded during play.
    const units: ResultUnitVM[] = [];
    for (const [id, before] of this.progressSnapshot) {
      const unit = this.state.units.get(id);
      if (!unit || unit.team !== 'player') continue;
      const after = jobProgress(unit, unit.currentJob);
      const persisted = this.campaign.roster.find((candidate) => candidate.id === id);
      const persistedJob = persisted?.jobs[persisted.currentJob];
      units.push({
        unitId: unit.id,
        name: unit.name,
        portrait: portraitFor(unit),
        job: getJob(unit.currentJob).name,
        expGained:
          Math.max(0, unit.exp + (unit.level - before.level) * 100 - before.exp) +
          (rewards?.exp ?? 0),
        jpGained: Math.max(0, after.totalJp - before.totalJp) + (rewards?.jp ?? 0),
        levelBefore: before.level,
        levelAfter: persisted?.level ?? unit.level,
        jobLevelBefore: before.jobLevel,
        jobLevelAfter: persistedJob?.level ?? after.level,
        ...(isKO(unit) || unit.removed ? { incapacitated: true } : {}),
      });
    }

    const result: ResultScreenVM = {
      outcome: victory ? 'victory' : 'defeat',
      title: victory ? 'Victory' : 'Defeat',
      subtitle: this.scenario.name,
      units,
      turns: Math.max(1, Math.round(this.state.tick / 100)),
      ...(rewards ? { gil: rewards.gil } : {}),
      ...(rewards?.items
        ? {
            loot: Object.entries(rewards.items).map(([itemId, count]) => ({
              name: findItem(itemId)?.name ?? itemId,
              count,
              rarity: this.lootRarity(itemId),
            })),
          }
        : {}),
    };
    void this.presentBattleResult(result, victory);
  }

  private async presentBattleResult(result: ResultScreenVM, victory: boolean): Promise<void> {
    await this.ui.presentBattleOutcome({
      outcome: victory ? 'victory' : 'defeat',
      subtitle: victory ? 'The field is yours.' : 'The company is broken.',
    });
    if (!this.disposed) this.ui.showResult(result);
  }

  private lootRarity(itemId: string): 'common' | 'fine' | 'rare' {
    const price = findItem(itemId)?.price ?? 0;
    if (price >= 4_000) return 'rare';
    if (price >= 800) return 'fine';
    return 'common';
  }

  /** Level / EXP / JP at deploy, so the result screen can show real deltas. */
  private readonly progressSnapshot = new Map<
    UnitId,
    { level: number; exp: number; jobLevel: number; totalJp: number }
  >();

  private snapshotProgress(): void {
    for (const unit of this.state.units.values()) {
      const progress = jobProgress(unit, unit.currentJob);
      this.progressSnapshot.set(unit.id, {
        level: unit.level,
        exp: unit.exp,
        jobLevel: progress.level,
        totalJp: progress.totalJp,
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Event playback
  // ───────────────────────────────────────────────────────────────────────────

  /** Serialise animation so two overlapping event streams cannot interleave. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.queue.then(work).catch((err: unknown) => {
      console.error('[game] animation failed:', err);
    });
    this.queue = next;
    return next;
  }

  play(events: readonly BattleEvent[]): Promise<void> {
    return this.enqueue(async () => {
      this.busy = true;
      try {
        const attributedKnockdowns = new Set(
          events
            .filter(
              (event): event is Extract<BattleEvent, { kind: 'knockdown' }> =>
                event.kind === 'knockdown' && event.source !== undefined,
            )
            .map((event) => event.unit),
        );
        const playEvent = async (
          event: BattleEvent,
          playImpactFeedback?: () => Promise<void>,
        ): Promise<void> => {
          const unit = 'unit' in event ? this.state.units.get(event.unit) : undefined;
          const ability = 'ability' in event ? abilityById(event.ability) : undefined;
          this.battleAudio(event, {
            maxHp: unit?.stats.maxHp,
            abilitySound:
              event.kind === 'cast-fire' && ability
                ? SPRITE_ANIM_FOR_FORMULA[ability.formula] === 'attack'
                  ? 'swing'
                  : 'cast'
                : undefined,
            suppressKnockdown:
              event.kind === 'knockdown'
              && event.source === undefined
              && attributedKnockdowns.has(event.unit),
          });
          await this.playOne(event, playImpactFeedback);
        };

        for (let index = 0; index < events.length; index++) {
          const event = events[index]!;
          if (event.kind !== 'cast-fire') {
            await playEvent(event);
            continue;
          }

          const feedback: ActionFeedbackEvent[] = [];
          let next = index + 1;
          while (next < events.length) {
            const candidate = events[next]!;
            if (!isActionFeedbackEvent(candidate)) break;
            feedback.push(candidate);
            next += 1;
          }

          await playEvent(event, async () => {
            for (const impact of feedback) await playEvent(impact);
          });
          index = next - 1;
        }
      } finally {
        this.busy = false;
      }
    });
  }

  private async playOne(
    event: BattleEvent,
    playImpactFeedback: () => Promise<void> = async () => {},
  ): Promise<void> {
    const sprite = 'unit' in event ? this.sprites.get(event.unit) : undefined;
    const unit = 'unit' in event ? this.state.units.get(event.unit) : undefined;

    switch (event.kind) {
      case 'moved': {
        this.terrain?.setPath(event.path);
        if (sprite) {
          await sprite.walkPath(event.path, { tilesPerSecond: 4.2 });
        }
        this.terrain?.setPath(null);
        break;
      }

      case 'faced': {
        if (sprite) sprite.facing = event.facing;
        break;
      }

      case 'cast-start': {
        const ability = abilityById(event.ability);
        if (sprite) sprite.play('charge');
        if (ability && unit) {
          this.chargeVfx.get(event.unit)?.cancel();
          this.chargeVfx.set(
            event.unit,
            this.vfx.beginCharge(this.worldOf(unit.pos), ability.element),
          );
        }
        break;
      }

      case 'cast-fire': {
        const ability = abilityById(event.ability);
        if (!ability) break;
        if (sprite) {
          const anim = SPRITE_ANIM_FOR_FORMULA[ability.formula] ?? 'attack';
          void sprite.playOnce(anim);
        }
        this.chargeVfx.get(event.unit)?.release();
        this.chargeVfx.delete(event.unit);
        const origin = unit ? this.worldOf(unit.pos) : this.worldOf(event.target);
        const target = this.worldOf(event.target);
        const impacts = this.impactPoints(unit, ability, event.target);
        const vfxImpacts = impacts.slice(0, 8);
        const playEffect = async (): Promise<void> => {
          let feedback: Promise<void> | null = null;
          const startFeedback = (): void => {
            feedback ??= playImpactFeedback();
          };
          await this.vfx.play(resolveVfxKey(ability), {
            origin,
            target,
            targets: vfxImpacts,
            element: ability.element,
            power: powerOf(ability),
            onImpact: startFeedback,
          });
          // Effects without an authored impact cue still need their reducer
          // feedback while the target framing is held.
          startFeedback();
          await feedback;
        };
        await this.abilityCamera.present(
          abilityCameraProfile(ability.id),
          abilityCameraFocus(target, impacts),
          playEffect,
          impacts,
        );
        break;
      }

      case 'damage': {
        if (sprite) {
          sprite.flash(event.crit ? 0xffd24a : 0xff8a7a, event.crit ? 0.22 : 0.14);
          sprite.popLabel(String(event.amount), event.crit ? 'crit' : 'damage');
          if (unit && !isKO(unit)) void sprite.playOnce('hurt');
        }
        if (unit) {
          this.vfx.playHitSpark(this.worldOf(unit.pos), event.crit ? 0.9 : 0.55, event.element);
          this.floatAt(unit, {
            kind: event.crit ? 'crit' : 'damage',
            value: event.amount,
            element: event.element,
            x: 0,
            y: 0,
          });
        }
        await sleep(event.crit ? 190 : 120);
        break;
      }

      case 'heal': {
        if (sprite) {
          sprite.flash(0x8ef2a8, 0.16);
          sprite.popLabel(String(event.amount), 'heal');
        }
        if (unit) this.floatAt(unit, { kind: 'heal', value: event.amount, x: 0, y: 0 });
        await sleep(110);
        break;
      }

      case 'miss': {
        if (sprite) sprite.popLabel('MISS', 'miss');
        if (unit) this.floatAt(unit, { kind: 'miss', x: 0, y: 0 });
        await sleep(110);
        break;
      }

      case 'status-add':
      case 'status-remove': {
        if (sprite && unit) sprite.setStatuses(unit.statuses);
        break;
      }

      case 'knockdown': {
        this.chargeVfx.get(event.unit)?.cancel();
        this.chargeVfx.delete(event.unit);
        if (sprite) {
          sprite.setKnockedOut(true);
          void sprite.playOnce('ko');
        }
        if (unit) this.vfx.playBloodBurst(this.worldOf(unit.pos), 0.8);
        await sleep(320);
        break;
      }

      case 'crystal': {
        if (sprite) await sprite.crystallise();
        this.sprites.remove(event.unit);
        break;
      }

      case 'jp':
      case 'exp': {
        if (unit && event.amount > 0) {
          this.floatAt(unit, { kind: event.kind, value: event.amount, x: 0, y: 0, delay: 120 });
        }
        break;
      }

      case 'levelup': {
        if (unit) {
          this.floatAt(unit, { kind: 'status', text: `LEVEL ${event.level}`, x: 0, y: 0 });
        }
        break;
      }

      case 'turn-order-changed': {
        this.refreshHud();
        break;
      }
    }
  }

  /** Tiles an ability actually covers, in world space, for multi-hit VFX. */
  private impactPoints(actor: Unit | undefined, ability: Ability, target: Vec3): THREE.Vector3[] {
    const tiles =
      actor !== undefined
        ? affectedTiles(this.state, actor, ability, target)
        : tilesInBurst(this.state.field, target, ability.range);
    return tiles.map((t) => this.worldOf(t));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Modes
  // ───────────────────────────────────────────────────────────────────────────

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.terrain?.clearHighlights('move');
    this.terrain?.clearHighlights('attack');
    this.terrain?.clearHighlights('aoe');
    this.terrain?.setPath(null);
    if (mode.kind !== 'target') {
      this.ui.setTargetPreview(null);
      // Leaving aim mode must drop red/blue AoE rings so they do not stick on
      // the next command menu.
      this.clearAoEUnitHighlights(this.activeUnit());
    }
  }

  private enterCommandMode(unit: Unit): void {
    this.setMode({ kind: 'command' });
    this.ui.setActiveUnit(unitVM(this.state, unit));
    // Unanchored: the menu docks bottom-centre in the HUD rail. Hanging it off
    // the unit is more FFT-authentic but on a framed 14x14 board it lands on top
    // of the half of the field the player is choosing between.
    this.ui.showCommandMenu(commandItemsFor(this.state, unit));
    for (const sprite of this.sprites.all) {
      sprite.setSelection(sprite.unitId === unit.id ? 'active' : 'none');
      sprite.setTurnMarker(sprite.unitId === unit.id);
    }
  }

  private enterMoveMode(unit: Unit): void {
    const occupied = buildOccupancy(this.state.units.values());
    const reach = reachableDestinations(this.state.field, unit, occupied);
    this.setMode({ kind: 'move', reach });
    this.ui.hideCommandMenu();
    if (this.scenario.layers.highlights) {
      this.terrain?.setHighlight('move', [...reach.values()].map((n) => n.pos));
    }
    this.ui.setHints([
      { keys: ['Click'], label: 'Move here' },
      { keys: ['Esc'], label: 'Back' },
    ]);
  }

  private enterTargetMode(unit: Unit, ability: Ability): void {
    // `state/targeting.ts` owns the rule, because the UI, the reducer and the AI
    // all have to agree on it — see the note at the top of that file.
    const { tiles, keys: legal } = legalTargets(this.state, unit, ability);
    this.setMode({ kind: 'target', ability, legal });
    this.ui.hideAbilityMenu();
    this.ui.hideCommandMenu();
    if (this.scenario.layers.highlights) {
      this.terrain?.setHighlight(isBeneficial(ability) ? 'heal' : 'attack', tiles);
    }
    this.ui.setHints([
      { keys: ['Click'], label: `Cast ${ability.name}` },
      { keys: ['Esc'], label: 'Back' },
    ]);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI intents
  // ───────────────────────────────────────────────────────────────────────────

  private onIntent(intent: UIIntent): void {
    switch (intent.kind) {
      case 'title-new-game': {
        const result = startNewCampaign({
          timestamp: Date.now(),
          confirmOverwrite: intent.overwriteConfirmed,
        });
        if (result.kind === 'confirmation-required') {
          this.ui.requestTitleOverwriteConfirmation();
        } else {
          this.enterWorldMap(result.campaign);
        }
        break;
      }

      case 'title-continue': {
        const result = continueCampaign();
        if (result.kind === 'world-map') {
          this.enterWorldMap(result.campaign);
        } else {
          this.ui.sound('error');
          this.ui.updateTitleScreen({
            ...titleScreenVM(),
            continueAvailable: false,
          });
        }
        break;
      }

      case 'camera': {
        if (intent.action === 'rotate-cw') void this.camera.rotate(1);
        else if (intent.action === 'rotate-ccw') void this.camera.rotate(-1);
        else if (intent.action === 'zoom-in') void this.camera.zoomIn();
        else if (intent.action === 'zoom-out') void this.camera.zoomOut();
        else this.frameCamera();
        break;
      }

      case 'command': {
        this.onCommandRow(intent.id);
        break;
      }

      case 'ability':
      case 'item': {
        const unit = this.activeUnit();
        const ability = abilityById(intent.id);
        if (!unit || !ability) break;
        this.enterTargetMode(unit, ability);
        break;
      }

      case 'cancel': {
        this.onCancel();
        break;
      }

      case 'result-dismiss': {
        this.ui.closeScreen();
        if (!this.shot) this.returnToWorldMap();
        break;
      }

      case 'close-screen': {
        this.ui.closeScreen();
        if (intent.screen === 'world') {
          this.appSurface = 'title';
          this.showTitle();
          break;
        }
        if (intent.screen === 'shop') this.shopNode = null;
        this.screenUnit = null;
        this.screenJob = null;
        // A job change while the screen was open rewrote the unit's command set;
        // rebuild the menu rather than leaving the pre-change rows on screen.
        const active = this.activeUnit();
        if (active && active.team === 'player' && this.mode.kind === 'command') {
          this.enterCommandMode(active);
        }
        if (this.appSurface === 'world-map') this.showWorldMap();
        break;
      }

      case 'world-node-select': {
        this.onWorldNodeSelect(intent.nodeId);
        break;
      }

      case 'world-open-jobs': {
        const unitId = this.campaign.roster[0]?.id;
        if (unitId) this.openJobScreenById(unitId);
        break;
      }

      case 'world-open-roster': {
        this.ui.openRosterScreen(
          campaignRosterScreenVM(this.campaign, {
            title: 'Company Roster',
            editable: true,
          }),
        );
        break;
      }

      case 'shop-buy': {
        this.onShopBuy(intent.itemId);
        break;
      }

      case 'shop-sell': {
        this.onShopSell(intent.itemId);
        break;
      }

      case 'inspect-job': {
        this.screenJob = intent.jobId;
        this.pushJobScreen();
        break;
      }

      case 'set-job': {
        this.onSetJob(intent.unitId, intent.jobId);
        break;
      }

      case 'learn-ability': {
        this.onLearnAbility(intent.unitId, intent.jobId, intent.abilityId);
        break;
      }

      case 'assign-slot': {
        this.onAssignSlot(intent.unitId, intent.slot, intent.abilityId);
        break;
      }

      case 'open-job-screen': {
        this.openJobScreenById(intent.unitId);
        break;
      }

      case 'formation-assign': {
        this.onFormationAssign(intent.index, intent.unitId);
        break;
      }

      case 'formation-confirm': {
        this.onFormationConfirm();
        break;
      }

      case 'equip-item': {
        this.onEquipItem(intent.unitId, intent.itemId);
        break;
      }

      case 'unequip-item': {
        this.onUnequipItem(intent.unitId, intent.slot);
        break;
      }

      case 'rename-unit': {
        this.onRenameUnit(intent.unitId, intent.name);
        break;
      }

      case 'dismiss-unit': {
        this.onDismissUnit(intent.unitId);
        break;
      }

      case 'inspect-unit': {
        const unit = this.state.units.get(intent.unitId);
        if (!unit) break;
        this.ui.setInspectedUnit(unitVM(this.state, unit));
        if (intent.focus) this.camera.focusTile(unit.pos);
        break;
      }

      default:
        break;
    }
  }

  private onCommandRow(id: string): void {
    const unit = this.activeUnit();
    if (!unit || this.busy) return;

    if (id === 'move') {
      this.enterMoveMode(unit);
      return;
    }
    if (id === 'attack') {
      const attack = abilityById('attack');
      if (attack) this.enterTargetMode(unit, attack);
      return;
    }
    if (id === 'wait') {
      void this.finishTurn({ kind: 'wait', unit: unit.id });
      return;
    }
    if (id === 'defend') {
      void this.finishTurn({ kind: 'defend', unit: unit.id });
      return;
    }

    const setId = id === 'item' ? 'item' : id.startsWith('set:') ? id.slice(4) : null;
    if (setId !== null) {
      const items = abilityItemsFor(this.state, unit, setId);
      if (items.length === 0) return;
      const stats = deriveStats(unit);
      this.ui.showAbilityMenu(items, {
        title: labelForSet(unit, setId),
        mp: stats.mp,
        maxMp: stats.maxMp,
      });
    }
  }


  // ───────────────────────────────────────────────────────────────────────────
  // Full-screen panels
  //
  // The job tree, the roster and the formation slate are opened with a key
  // rather than a command row: they are meta-screens over the squad, not turn
  // actions. `J` / `F` / `P` open them, Escape closes (the screen itself is a
  // modal focus layer and swallows everything else).
  // ───────────────────────────────────────────────────────────────────────────

  /** Unit the job screen is currently showing, and the tree node it is focused on. */
  private screenUnit: UnitId | null = null;
  private screenJob: JobId | null = null;

  private showTitle(): void {
    if (this.appSurface !== 'title' || this.disposed) return;
    this.ui.setHudVisible(false);
    this.ui.openTitleScreen(titleScreenVM());
  }

  private enterWorldMap(campaign: CampaignState): void {
    this.campaign = campaign;
    this.appSurface = 'world-map';
    // Battles launch through a scene query, but the campaign map is the normal
    // app route. Leaving that query in place makes a refresh relaunch the battle
    // the player just finished instead of returning to Title -> Continue.
    if (!this.shot && typeof window !== 'undefined') {
      const currentUrl = new URL(window.location.href);
      const debug = currentUrl.searchParams.has('debug');
      currentUrl.search = '';
      if (debug) currentUrl.searchParams.set('debug', '1');
      window.history.replaceState(
        null,
        '',
        `${currentUrl.pathname}${currentUrl.search}`,
      );
    }
    this.ui.closeScreen();
    this.showWorldMap();
  }

  private showWorldMap(): void {
    if (this.appSurface !== 'world-map' || this.disposed) return;
    this.pendingWorldNode = null;
    this.shopNode = null;
    this.ui.setHudVisible(false);
    this.ui.openWorldMapScreen(worldMapScreenVM(this.campaign));
  }

  private onWorldNodeSelect(nodeId: string): void {
    if (this.appSurface !== 'world-map') return;
    const node = WORLD_NODES.find((candidate) => candidate.id === nodeId);
    const completed = node
      ? this.campaign.progress.completed.includes(node.id)
      : false;
    if (
      !node ||
      (completed && node.kind !== 'town') ||
      !isUnlocked(node, this.campaign)
    ) {
      this.ui.sound('error');
      return;
    }

    if (node.kind === 'town') {
      const progressed = completeTravelNode(this.campaign, node, Date.now());
      this.persistCampaign(progressed);
      this.shopNode = node;
      this.ui.openShopScreen(
        shopScreenVM(this.campaign, {
          chapter: node.chapter,
          townName: node.name,
        }),
      );
      this.ui.banner(node.name, {
        subtitle: 'The company makes camp and trades for the road ahead.',
        tone: 'victory',
        duration: 1800,
      });
      return;
    }

    if (node.kind === 'event') {
      const progressed = completeTravelNode(this.campaign, node, Date.now());
      this.persistCampaign(progressed);
      this.ui.updateWorldMapScreen(worldMapScreenVM(this.campaign));
      this.ui.banner(node.name, {
        subtitle: 'The road opens ahead.',
        tone: 'victory',
        duration: 1800,
      });
      return;
    }

    if (!node.scenarioId || !getScenario(node.scenarioId)) {
      this.ui.sound('error');
      return;
    }
    this.pendingWorldNode = node;
    this.openFormationScreen();
  }

  private returnToWorldMap(): void {
    this.enterWorldMap(this.campaign);
  }

  private installScreenKeys(): void {
    const onKey = (ev: KeyboardEvent): void => {
      if (this.disposed || ev.metaKey || ev.ctrlKey || ev.altKey || ev.repeat) return;
      const target = ev.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      // While a screen is up it owns the keyboard; `UIRoot`'s own focus stack
      // handles navigation and Escape.
      if (this.ui.currentScreen !== null) return;
      if (!this.scenario.layers.ui) return;
      // Mid-battle: open only during the player's command prompt (read-only).
      // Between battles (`battleOver`): always open (editable).
      if (!this.battleOver && !this.canOpenPartyScreenMidBattle()) return;

      switch (ev.code) {
        case 'KeyJ': {
          const unitId = this.screenSubjectId();
          if (unitId) this.openJobScreenById(unitId);
          break;
        }
        case 'KeyF':
          this.openFormationScreen();
          break;
        case 'KeyP':
          this.ui.openRosterScreen(
            campaignRosterScreenVM(this.campaign, {
              title: 'Company Roster',
              editable: this.partyEditingAllowed(),
            }),
          );
          break;
        default:
          return;
      }
      ev.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  /**
   * Mid-battle: party screens open only while the player holds the command
   * prompt and nothing is resolving. After the battle ends they open freely
   * (and are editable).
   */
  private canOpenPartyScreenMidBattle(): boolean {
    if (this.busy) return false;
    if (this.mode.kind !== 'command') return false;
    const unit = this.activeUnit();
    return unit !== undefined && unit.team === 'player';
  }

  /**
   * True while a fight is in progress. Party editors refuse every mutation
   * until victory/defeat folds the battle back into the campaign.
   */
  private isBattleLive(): boolean {
    return !this.battleOver;
  }

  /** Between battles only — the campaign is the sole write target. */
  private partyEditingAllowed(): boolean {
    return partyEditAllowed(this.isBattleLive());
  }

  /**
   * Route a party-screen UIIntent through the production dispatcher.
   * Mid-battle every mutation is refused; between battles the campaign updates.
   */
  private applyPartyIntent(intent: PartyMutationIntent): boolean {
    const unitId =
      'unitId' in intent && typeof intent.unitId === 'string'
        ? (intent.unitId as UnitId)
        : this.screenUnit ?? undefined;
    const result = dispatchPartyIntent(
      this.campaign,
      this.isBattleLive(),
      intent,
      {
        timestamp: Date.now(),
        ...(unitId ? { unlockCtx: unlockContextForUnit(this.campaign, unitId) } : {}),
      },
    );
    if (!result.ok) {
      this.ui.sound('error');
      return false;
    }
    this.persistCampaign(result.campaign);
    this.ui.sound('confirm');
    return true;
  }

  /**
   * Whose sheet `J` opens — active unit mid-battle, or first roster member
   * between battles.
   */
  private screenSubjectId(): UnitId | undefined {
    if (this.battleOver) {
      return this.campaign.roster[0]?.id;
    }
    if (!this.canOpenPartyScreenMidBattle()) return undefined;
    return this.activeUnit()?.id;
  }

  private openJobScreenById(unitId: UnitId): void {
    const persisted = this.campaign.roster.find((u) => u.id === unitId);
    if (!persisted) {
      this.ui.sound('error');
      return;
    }
    this.screenUnit = unitId;
    this.screenJob = persisted.currentJob;
    const vm = campaignJobScreenVM(
      this.campaign,
      unitId,
      persisted.currentJob,
      unlockContextForUnit(this.campaign, unitId),
      { editable: this.partyEditingAllowed() },
    );
    if (!vm) {
      this.ui.sound('error');
      return;
    }
    this.ui.openJobScreen(vm);
  }

  /** Re-send the job screen from the campaign (source of truth). */
  private pushJobScreen(): void {
    if (this.screenUnit === null) return;
    const vm = campaignJobScreenVM(
      this.campaign,
      this.screenUnit,
      this.screenJob ?? undefined,
      unlockContextForUnit(this.campaign, this.screenUnit),
      { editable: this.partyEditingAllowed() },
    );
    if (!vm) return;
    this.ui.updateJobScreen(vm);
  }

  private onSetJob(unitId: UnitId, jobId: JobId): void {
    const ok = this.applyPartyIntent({ kind: 'set-job', unitId, jobId });
    if (ok) this.screenJob = jobId;
    this.pushJobScreen();
  }

  private onLearnAbility(unitId: UnitId, jobId: JobId, abilityId: string): void {
    this.applyPartyIntent({ kind: 'learn-ability', unitId, jobId, abilityId });
    this.pushJobScreen();
  }

  private onAssignSlot(
    unitId: UnitId,
    slot: 'secondary' | 'reaction' | 'support' | 'movement',
    abilityId: string | null,
  ): void {
    this.applyPartyIntent({ kind: 'assign-slot', unitId, slot, abilityId });
    this.pushJobScreen();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Campaign persistence + party mutations
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * First-boot seed: copy the scenario's player cast into a new company so there
   * is something to equip, form and level. Subsequent boots load the save and
   * launch via {@link campaignToBattle}.
   */
  private seedCampaignFromField(opts: { persist?: boolean } = {}): CampaignState {
    const campaign = createCampaign(this.scenario.seed, Date.now());
    for (const unit of this.state.units.values()) {
      if (unit.team === 'player' && !unit.removed) {
        campaign.roster.push(unitToPersisted(unit));
      }
    }
    campaign.formation = campaign.roster.map((u, i) => ({
      unitId: u.id,
      startIndex: i,
    }));
    // Starter stock so the roster equip pane is not an empty box on day one.
    // Consumable ids mirror the Item skillset (`use-potion`, not `potion`).
    if (Object.keys(campaign.inventory).length === 0) {
      campaign.inventory = {
        'long-sword': 1,
        rod: 1,
        buckler: 1,
        'use-potion': 3,
      };
    }
    if (opts.persist !== false) saveCampaign(campaign);
    return campaign;
  }

  private persistCampaign(next: CampaignState): void {
    this.campaign = next;
    saveCampaign(next);
  }

  private onShopBuy(itemId: string): void {
    const node = this.shopNode;
    if (this.ui.currentScreen !== 'shop' || !node) {
      this.ui.sound('error');
      return;
    }
    const item = shopStockForChapter(node.chapter).find((candidate) => candidate.id === itemId);
    if (!item) {
      this.ui.sound('error');
      return;
    }
    const result = buyItem(this.campaign, item.id, item.price, Date.now());
    if (!result.ok) {
      this.ui.sound('error');
      this.refreshShopIfOpen();
      return;
    }
    this.persistCampaign(result.campaign);
    this.ui.sound('confirm');
    this.refreshShopIfOpen();
  }

  private onShopSell(itemId: string): void {
    const item = findItem(itemId);
    if (this.ui.currentScreen !== 'shop' || !this.shopNode || !item) {
      this.ui.sound('error');
      return;
    }
    const result = sellItem(this.campaign, item.id, item.price, Date.now());
    if (!result.ok) {
      this.ui.sound('error');
      this.refreshShopIfOpen();
      return;
    }
    this.persistCampaign(result.campaign);
    this.ui.sound('confirm');
    this.refreshShopIfOpen();
  }

  private refreshShopIfOpen(): void {
    if (this.ui.currentScreen !== 'shop' || !this.shopNode) return;
    this.ui.updateShopScreen(
      shopScreenVM(this.campaign, {
        chapter: this.shopNode.chapter,
        townName: this.shopNode.name,
      }),
    );
  }

  /** Map-authored deploy tiles — not the scenario cast's combat positions. */
  private playerStartTiles(): { x: number; y: number }[] {
    const scenario = this.formationScenario();
    const def = getMapDef(scenario.mapId) ?? scenarioMapDef(scenario);
    if (def && def.playerStarts.length > 0) {
      return def.playerStarts.map((p) => ({ x: p.x, y: p.y }));
    }
    // Fallback for maps without authored starts (tests / stubs).
    return scenario.units
      .filter((u) => u.team === 'player')
      .map((u) => ({ x: u.at.x, y: u.at.y }));
  }

  private formationScenario(): Scenario {
    const scenarioId = this.pendingWorldNode?.scenarioId;
    return scenarioId ? getScenario(scenarioId) : this.scenario;
  }

  private openFormationScreen(): void {
    const scenario = this.formationScenario();
    const startTiles = this.playerStartTiles();
    this.formationDraft = (this.campaign.formation ?? []).map((e) => ({ ...e }));
    // If the slate is empty, seed from currently deployed player units / roster.
    if (this.formationDraft.length === 0) {
      if (this.isBattleLive()) {
        const players = [...this.state.units.values()].filter(
          (u) => u.team === 'player' && !u.removed,
        );
        this.formationDraft = players.map((u, i) => ({
          unitId: u.id,
          startIndex: i,
        }));
      } else {
        const n = Math.min(this.campaign.roster.length, startTiles.length);
        this.formationDraft = this.campaign.roster.slice(0, n).map((u, i) => ({
          unitId: u.id,
          startIndex: i,
        }));
      }
    }
    this.ui.openFormationScreen(
      campaignFormationScreenVM(this.campaign, {
        startTiles,
        formation: this.formationDraft,
        subtitle: scenario.name,
        maxDeployed: startTiles.length,
        editable: this.partyEditingAllowed(),
      }),
    );
  }

  private pushFormationScreen(): void {
    const scenario = this.formationScenario();
    const startTiles = this.playerStartTiles();
    this.ui.updateFormationScreen(
      campaignFormationScreenVM(this.campaign, {
        startTiles,
        formation: this.formationDraft,
        subtitle: scenario.name,
        maxDeployed: startTiles.length,
        editable: this.partyEditingAllowed(),
      }),
    );
  }

  private onFormationAssign(index: number, unitId: string | null): void {
    // Draft edits are also campaign-bound; mid-battle the slate is read-only.
    if (!this.partyEditingAllowed()) {
      this.ui.sound('error');
      this.pushFormationScreen();
      return;
    }
    const startTiles = this.playerStartTiles();
    if (index < 0 || index >= startTiles.length) {
      this.ui.sound('error');
      return;
    }

    this.formationDraft = this.formationDraft.filter((e) => e.startIndex !== index);

    if (unitId !== null) {
      // A unit can occupy only one slot — move them if they were already placed.
      this.formationDraft = this.formationDraft.filter((e) => e.unitId !== unitId);
      this.formationDraft.push({ unitId, startIndex: index });
    }

    this.ui.sound(unitId === null ? 'cancel' : 'confirm');
    this.pushFormationScreen();
  }

  private onFormationConfirm(): void {
    const startTiles = this.playerStartTiles();
    // Campaign only — never write into a live BattleState from here.
    const result = dispatchPartyIntent(
      this.campaign,
      this.isBattleLive(),
      { kind: 'formation-confirm' },
      {
        timestamp: Date.now(),
        startTileCount: startTiles.length,
        maxDeployed: startTiles.length,
        formation: this.formationDraft,
      },
    );
    if (!result.ok) {
      this.ui.sound('error');
      return;
    }
    this.persistCampaign(result.campaign);
    this.ui.sound('confirm');
    this.ui.closeScreen();
    if (this.appSurface === 'world-map' && this.pendingWorldNode?.scenarioId) {
      const scenario = getScenario(this.pendingWorldNode.scenarioId);
      const url = new URL(window.location.href);
      const debug = url.searchParams.has('debug');
      url.search = '';
      url.searchParams.set('scene', scenario.id);
      url.searchParams.set('node', this.pendingWorldNode.id);
      if (debug) url.searchParams.set('debug', '1');
      window.location.assign(url.toString());
      return;
    }
    // Between battles: launch the next fight from the saved formation.
    void this.relaunchFromCampaign();
  }

  /**
   * Tear down the current field and rebuild it from the campaign via
   * {@link campaignToBattle}. This is the sole campaign → battle entry point
   * (paired with battleToCampaign at battle end).
   */
  private async relaunchFromCampaign(): Promise<void> {
    if (this.disposed) return;
    this.battleOver = false;
    this.battleStarted = false;
    this.setMode({ kind: 'idle' });
    this.ui.closeMenus();
    this.hoverTile = null;

    const routedNode = this.routedWorldNode();
    const built = campaignToBattle(this.campaign, this.scenario, {
      ...(routedNode === undefined ? {} : { worldNodeId: routedNode.id }),
    });
    this.built = built;
    this.state = built.state;
    this.progressSnapshot.clear();
    this.snapshotProgress();

    // Drop every field sprite and respawn from the new cast.
    for (const sprite of [...this.sprites.all]) {
      this.sprites.remove(sprite.unitId);
    }
    await this.spawnSprites();

    // Advance to the first turn the same way boot does.
    if (this.state.units.size > 0) {
      advance(this.state);
    }
    this.syncAll();
    this.refreshHud();
    if (!this.shot) void this.startBattle();
  }

  private onEquipItem(unitId: UnitId, itemId: string): void {
    if (this.applyPartyIntent({ kind: 'equip-item', unitId, itemId })) {
      this.refreshRosterIfOpen();
    }
  }

  private onUnequipItem(
    unitId: UnitId,
    slot: 'rightHand' | 'leftHand' | 'head' | 'body' | 'accessory',
  ): void {
    if (this.applyPartyIntent({ kind: 'unequip-item', unitId, slot })) {
      this.refreshRosterIfOpen();
    }
  }

  private onRenameUnit(unitId: UnitId, name: string): void {
    if (this.applyPartyIntent({ kind: 'rename-unit', unitId, name })) {
      this.refreshRosterIfOpen();
    }
  }

  private onDismissUnit(unitId: UnitId): void {
    if (!this.applyPartyIntent({ kind: 'dismiss-unit', unitId })) return;
    this.formationDraft = this.formationDraft.filter((e) => e.unitId !== unitId);
    if (this.screenUnit === unitId) {
      this.screenUnit = null;
      this.screenJob = null;
      this.ui.closeScreen();
    }
    this.refreshRosterIfOpen();
  }

  private refreshRosterIfOpen(): void {
    if (this.ui.currentScreen !== 'roster') return;
    this.ui.updateRosterScreen(
      campaignRosterScreenVM(this.campaign, {
        title: 'Company Roster',
        editable: this.partyEditingAllowed(),
      }),
    );
  }

  private onCancel(): void {
    const unit = this.activeUnit();
    if (!unit) return;
    if (this.mode.kind === 'move' || this.mode.kind === 'target') {
      this.enterCommandMode(unit);
    }
  }

  private async finishTurn(command: Command): Promise<void> {
    this.setMode({ kind: 'idle' });
    this.ui.closeMenus();
    await this.submit(command);
    void this.beginTurn();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pointer
  // ───────────────────────────────────────────────────────────────────────────

  private installPointerHandling(): void {
    const canvas = this.stage.canvas;

    const onMove = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      const tile = this.camera.screenToTile(
        event.clientX - rect.left,
        event.clientY - rect.top,
        this.state.field,
      );
      this.onHover(tile ?? null);
    };

    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const tile = this.camera.screenToTile(
        event.clientX - rect.left,
        event.clientY - rect.top,
        this.state.field,
      );
      if (tile) void this.onClick(tile);
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    this.disposers.push(() => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
    });
  }

  private onHover(tile: Vec3 | null): void {
    if (this.busy) return;
    // Unit-targeted abilities snap the cursor onto a legal occupant — empty
    // tiles are not aim points, so hover slides to the nearest valid unit.
    const aim = this.snapTargetTile(tile);
    const same =
      this.hoverTile !== null &&
      aim !== null &&
      this.hoverTile.x === aim.x &&
      this.hoverTile.y === aim.y;
    this.hoverTile = aim;
    if (same) return;

    this.terrain?.clearHighlights('cursor');
    if (aim && this.scenario.layers.highlights) {
      // Higher intensity + the shader's cursor-specific rim makes the selected
      // tile readable at gameplay zoom.
      this.terrain?.setHighlight('cursor', [aim], 1.35);
    }

    const occupant = aim ? this.unitAt(aim) : undefined;
    this.ui.setInspectedUnit(occupant ? unitVM(this.state, occupant) : null);

    if (this.mode.kind === 'move' && aim) {
      const unit = this.activeUnit();
      if (unit) {
        const occupied = buildOccupancy(this.state.units.values());
        const path = pathTo(this.state.field, unit, occupied, aim, undefined);
        this.terrain?.setPath(path.length > 1 ? path : null);
      }
    }

    if (this.mode.kind === 'target' && aim) {
      this.previewTarget(aim);
    } else if (this.mode.kind === 'target' && !aim) {
      this.ui.setTargetPreview(null);
      this.terrain?.clearHighlights('aoe');
      this.clearAoEUnitHighlights(this.activeUnit());
    }
  }

  /**
   * For unit-targeted abilities, remap a pointer tile onto a legal unit's tile
   * (prefer the occupant under the pointer, else the nearest legal unit within
   * one chebyshev step so the cursor does not stick on empty ground).
   */
  private snapTargetTile(tile: Vec3 | null): Vec3 | null {
    if (!tile) return null;
    if (this.mode.kind !== 'target') return tile;
    const unit = this.activeUnit();
    if (!unit) return tile;
    const ability = this.mode.ability;
    if (abilityTargetsTiles(ability)) return tile;
    if (canAimAt(this.state, unit, ability, tile, { tiles: [], keys: this.mode.legal })) {
      return tile;
    }
    // Nearest legal occupant by chebyshev distance; refuse if nothing is in range.
    let best: Vec3 | null = null;
    let bestDist = Infinity;
    for (const other of this.state.units.values()) {
      if (other.removed) continue;
      const key = tileKey(other.pos.x, other.pos.y);
      if (!this.mode.legal.has(key)) continue;
      const aim: Vec3 = {
        x: other.pos.x,
        y: other.pos.y,
        z: other.pos.z,
      };
      if (!canAimAt(this.state, unit, ability, aim, { tiles: [], keys: this.mode.legal })) continue;
      const d = Math.max(Math.abs(other.pos.x - tile.x), Math.abs(other.pos.y - tile.y));
      if (d < bestDist) {
        bestDist = d;
        best = aim;
      }
    }
    // Only snap when the pointer is adjacent to a valid target — otherwise leave
    // the cursor free so the player can pan across the board without it jumping.
    return bestDist <= 1 ? best : null;
  }

  private previewTarget(tile: Vec3): void {
    if (this.mode.kind !== 'target') return;
    const unit = this.activeUnit();
    if (!unit) return;
    const ability = this.mode.ability;
    if (!this.mode.legal.has(tileKey(tile.x, tile.y))) {
      this.ui.setTargetPreview(null);
      this.terrain?.clearHighlights('aoe');
      this.clearAoEUnitHighlights(unit);
      return;
    }

    const covered = coveredTiles(this.state, unit, ability, tile);
    if (this.scenario.layers.highlights) {
      this.terrain?.setHighlight('aoe', covered);
    }
    this.markAffectedUnits(unit, covered);
    const victim = primaryTargetAt(this.state, unit, ability, tile);
    this.ui.setTargetPreview(
      victim ? targetPreviewVM(this.state, unit, ability, victim) : null,
    );
  }

  /**
   * Paint every unit inside the aimed footprint from the *caster's* perspective:
   * red for enemies of the caster, blue for allies (including a player unit
   * caught in their own fireball — the highlight exists to prevent that mistake).
   */
  private markAffectedUnits(caster: Unit, covered: readonly Vec3[]): void {
    const coveredKeys = new Set(covered.map((t) => tileKey(t.x, t.y)));
    for (const sprite of this.sprites.all) {
      const other = this.state.units.get(sprite.unitId);
      if (!other || other.removed) {
        sprite.setSelection('none');
        continue;
      }
      if (other.id === caster.id) {
        // Keep the turn marker, but do not hide friendly fire behind the generic
        // active-unit gold: a caster standing in their own footprint is an
        // affected ally and must read blue like every other ally.
        sprite.setSelection(
          coveredKeys.has(tileKey(other.pos.x, other.pos.y)) ? 'ally-aoe' : 'active',
        );
        sprite.setTurnMarker(true);
        continue;
      }
      if (!coveredKeys.has(tileKey(other.pos.x, other.pos.y))) {
        sprite.setSelection('none');
        sprite.setTurnMarker(false);
        continue;
      }
      // Caster's team, not the player's: a confused ally casting on you is still
      // "enemy of the caster" and must read red.
      sprite.setSelection(other.team === caster.team ? 'ally-aoe' : 'enemy-aoe');
      sprite.setTurnMarker(false);
    }
  }

  private clearAoEUnitHighlights(caster: Unit | undefined): void {
    for (const sprite of this.sprites.all) {
      const isActive = caster !== undefined && sprite.unitId === caster.id;
      sprite.setSelection(isActive ? 'active' : 'none');
      sprite.setTurnMarker(isActive);
    }
  }

  private async onClick(tile: Vec3): Promise<void> {
    if (this.busy) return;
    const unit = this.activeUnit();

    if (this.mode.kind === 'move' && unit) {
      if (!this.mode.reach.has(tileKey(tile.x, tile.y))) return;
      const occupied = buildOccupancy(this.state.units.values());
      const path = pathTo(this.state.field, unit, occupied, tile);
      if (path.length < 2) return;
      this.setMode({ kind: 'idle' });
      const ok = await this.submit({ kind: 'move', unit: unit.id, path });
      if (ok && !isOver(this.state) && this.state.active === unit.id) {
        this.enterCommandMode(unit);
      }
      else void this.beginTurn();
      return;
    }

    if (this.mode.kind === 'target' && unit) {
      const ability = this.mode.ability;
      const aim = this.snapTargetTile(tile) ?? tile;
      if (!canAimAt(this.state, unit, ability, aim)) return;
      const victim = primaryTargetAt(this.state, unit, ability, aim);
      this.setMode({ kind: 'idle' });
      this.ui.closeMenus();
      const ok = await this.submit({
        kind: 'act',
        unit: unit.id,
        ability: ability.id,
        target: aim,
        ...(victim ? { targetUnit: victim.id } : {}),
      });
      if (ok && !isOver(this.state) && this.state.active === unit.id) {
        this.enterCommandMode(unit);
      }
      else void this.beginTurn();
      return;
    }

    // Idle click: inspect.
    const occupant = this.unitAt(tile);
    if (occupant) this.ui.setInspectedUnit(unitVM(this.state, occupant));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HUD
  // ───────────────────────────────────────────────────────────────────────────

  refreshHud(): void {
    const active = this.activeUnit();
    // While aiming, previewTarget owns red/blue AoE rings — do not clobber them
    // with the generic active-unit selection pass.
    if (this.mode.kind !== 'target') {
      for (const sprite of this.sprites.all) {
        const isActive = active !== undefined && sprite.unitId === active.id;
        sprite.setTurnMarker(isActive);
        sprite.setSelection(isActive ? (active.team === 'player' ? 'active' : 'hostile') : 'none');
      }
    }
    if (!this.scenario.layers.ui) return;
    this.ui.setTurnOrder(turnOrderVM(this.state));
    this.ui.setActiveUnit(active ? unitVM(this.state, active) : null);
  }

  /** Push every unit's live state onto its sprite. Used after a non-animated jump. */
  syncAll(): void {
    for (const unit of this.state.units.values()) {
      const sprite = this.sprites.get(unit.id);
      if (sprite) this.syncSprite(unit, sprite);
    }
  }

  private syncSprite(unit: Unit, sprite: UnitSprite): void {
    sprite.setFromUnit(unit);
    sprite.setStatuses(unit.statuses);
    sprite.setKnockedOut(isKO(unit));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────────

  private worldOf(pos: Vec3): THREE.Vector3 {
    return tileWorldPosition(this.state.field, pos.x, pos.y);
  }

  private unitAt(tile: Vec3): Unit | undefined {
    for (const unit of this.state.units.values()) {
      if (unit.removed) continue;
      if (unit.pos.x === tile.x && unit.pos.y === tile.y) return unit;
    }
    return undefined;
  }

  private firstUnitIn(actor: Unit, ability: Ability, tile: Vec3): Unit | undefined {
    for (const covered of affectedTiles(this.state, actor, ability, tile)) {
      const unit = this.unitAt(covered);
      if (unit) return unit;
    }
    return undefined;
  }

  /** Screen-space anchor above a unit, in CSS pixels. */
  private anchorFor(unit: Unit): { x: number; y: number } {
    const world = this.worldOf(unit.pos);
    world.y += 1.6;
    const point = this.camera.worldToScreen(world, this.screen);
    return { x: point.x, y: point.y };
  }

  /**
   * Anchor for the command menu: the unit's head, pulled back inside the
   * viewport. A unit on the south edge of the map projects below the bottom of
   * the canvas, and a fixed-position panel hung there simply is not on screen.
   */
  private menuAnchorFor(unit: Unit): { x: number; y: number } {
    const { x, y } = this.anchorFor(unit);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const halfPanel = MENU_PANEL_HEIGHT / 2 + 24;
    return {
      x: clamp(x, 24, Math.max(24, width - MENU_PANEL_WIDTH - 48)),
      y: clamp(y, halfPanel, Math.max(halfPanel, height - halfPanel)),
    };
  }

  private floatAt(unit: Unit, vm: Omit<FloatTextVM, 'x' | 'y'> & { x: number; y: number }): void {
    if (!this.scenario.layers.ui) return;
    const anchor = this.anchorFor(unit);
    this.ui.float({ ...vm, x: anchor.x, y: anchor.y });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.camera.cancelCinematic();
    for (const charge of this.chargeVfx.values()) charge.cancel();
    this.chargeVfx.clear();
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.ui.dispose();
    this.sprites.dispose();
    this.vfx.dispose();
    this.terrain?.dispose();
    this.lighting.dispose();
    this.post?.dispose();
    this.stage.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Measured from the shipped stylesheet; only used to keep the panel on screen. */
const MENU_PANEL_WIDTH = 290;
const MENU_PANEL_HEIGHT = 300;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function isOver(state: BattleState): boolean {
  return state.phase === 'victory' || state.phase === 'defeat';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VFX_KEY_SET = new Set(VFX_KEYS);

/**
 * Ability VFX keys were authored as paths (`black/fire`, `break/head`) while the
 * VFX system registers flat names (`fire-burst`, `slash-arc`). Fall back to an
 * elemental burst rather than rendering nothing — `vfx.play` does the same for
 * an unknown key, but resolving here keeps the element correct.
 */
/**
 * Element name -> effect archetype.
 *
 * The VFX system registers 16 archetypes; the ability table authors 340
 * path-style keys ("black/fire"), so almost every ability resolves by fallback.
 * That is the intended design — what was broken is that the element step tested
 * `VFX_KEY_SET.has('fire')` while the registry holds `'fire-burst'`, so the test
 * could never pass and EVERY elemental spell fell through to the formula switch
 * and played a generic `impact-flash`. Fire, Blizzard and Thunder were visually
 * identical.
 */
const ELEMENT_VFX: Readonly<Record<string, string>> = {
  fire: 'fire-burst',
  ice: 'ice-shard',
  lightning: 'lightning-bolt',
  wind: 'wind-vortex',
  earth: 'earth-spike',
  water: 'water-surge',
  holy: 'holy-pillar',
  dark: 'dark-tendril',
};

function resolveVfxKey(ability: Ability): string {
  if (VFX_KEY_SET.has(ability.vfx)) return ability.vfx;
  const tail = ability.vfx.split('/').pop() ?? '';
  if (VFX_KEY_SET.has(tail)) return tail;
  if (ability.element !== 'none') {
    const byElement = ELEMENT_VFX[ability.element];
    if (byElement !== undefined && VFX_KEY_SET.has(byElement)) return byElement;
  }
  switch (ability.formula) {
    case 'heal':
      return 'heal-sparkle';
    case 'buff':
      return 'buff-aura';
    case 'status-only':
      return 'debuff-drip';
    case 'summon':
      return 'summon-circle';
    case 'raise':
      return 'holy-pillar';
    case 'magical':
    case 'drain':
      return 'impact-flash';
    default:
      return 'slash-arc';
  }
}

function powerOf(ability: Ability): number {
  return Math.max(0.2, Math.min(1, ability.power / 60 + ability.range.radius * 0.15));
}

function isBeneficial(ability: Ability): boolean {
  return (
    ability.formula === 'heal' ||
    ability.formula === 'buff' ||
    ability.formula === 'raise' ||
    (ability.formula === 'status-only' && (ability.cures?.length ?? 0) > 0)
  );
}


function labelForSet(unit: Unit, setId: string): string {
  const job = getJob(unit.currentJob);
  if (setId === actionSetOf(job)) return job.name;
  return setId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
