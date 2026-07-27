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
import { ALL_ABILITIES, ALL_ITEMS, bootstrapContent } from './content';
import { actionSetOf } from './abilityIndex';
import {
  abilityById,
  commandItemsFor,
  abilityItemsFor,
  targetPreviewVM,
  turnOrderVM,
  unitVM,
} from './viewModels';
import {
  buildScenario,
  getScenario,
  overrideScenario,
  type BuiltScenario,
  type Scenario,
} from './scenarios';

import { decideTurn } from '@core/ai';
import { IllegalCommandError, advance, affectedTiles, applyCommand } from '@core/battle';
import {
  buildOccupancy,
  isInRange,
  pathTo,
  reachableDestinations,
  tileKey,
  tilesInBurst,
} from '@core/grid';
import { getJob } from '@core/jobs';
import { isKO } from '@core/unit';
import type {
  Ability,
  BattleEvent,
  BattleState,
  Command,
  Unit,
  Vec3,
} from '@core/types';

import { IsoCamera, TILE_SIZE } from '@render/camera';
import { LIGHTING_PRESETS, LightingRig } from '@render/lighting';
import { SpriteLayer, type UnitSprite } from '@render/sprites';
import { Stage } from '@render/stage';
import { Terrain, buildTerrain, tileWorldPosition } from '@render/terrain';
import { VFX_KEYS, VfxSystem } from '@render/vfx';
import { UIRoot } from '@ui/UIRoot';
import type { FloatTextVM, UIIntent } from '@ui/types';

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

export interface GameOptions {
  scenarioId?: string;
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

// ─────────────────────────────────────────────────────────────────────────────
// Game
// ─────────────────────────────────────────────────────────────────────────────

export class Game {
  readonly stage: Stage;
  readonly camera: IsoCamera;
  readonly lighting: LightingRig;
  readonly sprites = new SpriteLayer();
  readonly vfx: VfxSystem;
  readonly ui: UIRoot;

  terrain: Terrain | null = null;
  post: PostStackPipeline | null = null;

  readonly scenario: Scenario;
  readonly built: BuiltScenario;
  state: BattleState;

  private mode: Mode = { kind: 'idle' };
  private readonly shot: boolean;
  private busy = false;
  private queue: Promise<void> = Promise.resolve();
  private hoverTile: Vec3 | null = null;
  private disposed = false;
  private readonly disposers: (() => void)[] = [];
  private readonly scratch = new THREE.Vector3();
  private readonly screen = { x: 0, y: 0, depth: 0, visible: false };

  constructor(options: GameOptions = {}) {
    bootstrapContent();

    const base = getScenario(options.scenarioId);
    this.scenario = options.params ? overrideScenario(base, options.params) : base;
    this.built = buildScenario(this.scenario);
    this.state = this.built.state;
    this.shot = options.shot ?? false;

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
    this.stage.setCamera(this.camera);
    // Sprites live on their own Layers channel so post can isolate them; the
    // camera has to be told to render it or the field is empty.
    this.camera.camera.layers.enable(SPRITE_LAYER);

    this.lighting = new LightingRig(this.stage.scene, { preset: this.scenario.lighting });
    this.lighting.bindRenderer(this.stage.renderer);

    this.vfx = new VfxSystem({ tileSize: TILE_SIZE, seed: this.scenario.seed });
    this.vfx.addTo(this.stage.scene);

    const uiMount =
      options.uiMount ?? (document.getElementById('ui') as HTMLElement | null) ?? document.body;
    this.ui = new UIRoot(uiMount, { sound: !this.shot });
    this.disposers.push(this.ui.on((intent) => this.onIntent(intent)));
    if (!this.scenario.layers.ui) this.ui.setHudVisible(false);
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

    this.frameCamera();
    this.installFrameCallbacks();
    this.installPointerHandling();

    this.stage.resize();
    this.stage.start();

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
    const preset = LIGHTING_PRESETS[this.scenario.lighting];

    stack.settings.exposure = (profile.exposure ?? 1) * preset.exposure;

    const dof = profile.dof ?? 1;
    if (dof <= 0) {
      stack.setEffectEnabled('dof', false);
    } else {
      stack.settings.dof.intensity = dof;
      // Widen the sharp band as the effect is dialled down, so the readable
      // part of the board grows rather than the blur simply getting softer.
      stack.settings.dof.tiltBand = 0.12 + (1 - Math.min(1, dof)) * 0.2;
      stack.settings.dof.tiltFalloff = 0.3 + (1 - Math.min(1, dof)) * 0.18;
      stack.settings.dof.maxCoCPixels = 14 * Math.min(1, dof) + 4;
    }
    if (profile.ao !== undefined) stack.setEffectIntensity('ao', profile.ao);
    if (profile.bloom !== undefined) stack.setEffectIntensity('bloom', profile.bloom * 0.055);
    if (profile.vignette !== undefined) stack.setEffectIntensity('vignette', profile.vignette * 0.26);
  }

  private buildTerrain(): void {
    const terrain = buildTerrain(this.state.field);
    this.terrain = terrain;
    this.stage.scene.add(terrain);

    // The map author's own sun direction, so water glint agrees with the key.
    const preset = LIGHTING_PRESETS[this.scenario.lighting];
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
    this.sprites.setKeyLight(direction.clone(), LIGHTING_PRESETS[this.scenario.lighting].rimColor);
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
    if (cam.frameField) this.camera.frameField(this.state.field, 3);
    if (cam.pixelScale !== undefined) void this.camera.setPixelScale(cam.pixelScale, true);
    if (cam.focusTile) this.camera.focusTile(cam.focusTile, { immediate: true });
  }

  private installFrameCallbacks(): void {
    this.disposers.push(
      this.stage.onRender((dt) => {
        if (this.disposed) return;
        // Hit-stop scales everything downstream, so take the VFX system's dt.
        const scaled = this.vfx.update(dt, this.camera.camera);
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
    if (this.scenario.banner && this.scenario.layers.ui) {
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

    this.camera.focusTile(active.pos, { immediate: this.shot });
    if (this.scenario.camera.focusTile) {
      this.camera.focusTile(this.scenario.camera.focusTile, { immediate: true });
    }

    if (active.team === 'player' && this.scenario.openCommandMenu) {
      this.enterCommandMode(active);
      if (this.scenario.layers.ui) {
        this.ui.setInspectedUnit(unitVM(this.state, this.firstHostile(active) ?? active));
      }
    }
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
      abilities: ALL_ABILITIES,
      personalities: this.built.personalities,
    });
    for (const command of commands) {
      if (this.state.active !== unit.id) break;
      const ok = await this.submit(command);
      if (!ok) break;
    }
    void this.beginTurn();
  }

  /**
   * The single funnel. Every command — player, AI, scripted — goes through here,
   * so validation, animation and HUD refresh happen in exactly one place.
   *
   * Returns false when the reducer rejected the command. The UI is supposed to
   * only offer legal commands, so a rejection is a bug: it is logged loudly and
   * the turn is allowed to continue rather than wedging the game.
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

  private onBattleOver(): void {
    const victory = this.state.phase === 'victory';
    this.setMode({ kind: 'idle' });
    this.ui.closeMenus();
    this.ui.banner(victory ? 'Victory' : 'Defeat', {
      subtitle: victory ? 'The field is yours.' : 'The company is broken.',
      tone: victory ? 'victory' : 'defeat',
      duration: 4000,
    });
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
        for (const event of events) await this.playOne(event);
      } finally {
        this.busy = false;
      }
    });
  }

  private async playOne(event: BattleEvent): Promise<void> {
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
          this.vfx.beginCharge(this.worldOf(unit.pos), ability.element);
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
        const origin = unit ? this.worldOf(unit.pos) : this.worldOf(event.target);
        const impacts = this.impactPoints(unit, ability, event.target);
        await this.vfx.play(resolveVfxKey(ability), {
          origin,
          target: this.worldOf(event.target),
          targets: impacts,
          element: ability.element,
          power: powerOf(ability),
        });
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
    return tiles.slice(0, 8).map((t) => this.worldOf(t));
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
    if (mode.kind !== 'target') this.ui.setTargetPreview(null);
  }

  private enterCommandMode(unit: Unit): void {
    this.setMode({ kind: 'command' });
    this.ui.setActiveUnit(unitVM(this.state, unit));
    this.ui.showCommandMenu(commandItemsFor(this.state, unit), this.menuAnchorFor(unit));
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
    const legal = new Set<string>();
    const tiles: Vec3[] = [];
    for (const tile of this.state.field.tiles) {
      if (tile.surface === 'void') continue;
      const point: Vec3 = { x: tile.x, y: tile.y, z: tile.height };
      if (!isInRange(this.state.field, unit.pos, point, ability.range, { facing: unit.facing })) {
        continue;
      }
      legal.add(tileKey(tile.x, tile.y));
      tiles.push(point);
    }
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
      if (attack) this.enterTargetMode(unit, this.rangedAttack(unit, attack));
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
      this.ui.showAbilityMenu(items, { title: labelForSet(unit, setId) });
    }
  }

  /** Attack inherits the equipped weapon's reach — a bow hits at five tiles. */
  private rangedAttack(unit: Unit, attack: Ability): Ability {
    const weapon = unit.equipment.rightHand ?? unit.equipment.leftHand;
    const reach = weapon !== undefined ? weaponReach(unit) : 1;
    if (reach <= attack.range.range) return attack;
    return { ...attack, range: { ...attack.range, range: reach, los: true } };
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
    const same =
      this.hoverTile !== null &&
      tile !== null &&
      this.hoverTile.x === tile.x &&
      this.hoverTile.y === tile.y;
    this.hoverTile = tile;
    if (same) return;

    this.terrain?.clearHighlights('cursor');
    if (tile && this.scenario.layers.highlights) {
      this.terrain?.setHighlight('cursor', [tile]);
    }

    const occupant = tile ? this.unitAt(tile) : undefined;
    this.ui.setInspectedUnit(occupant ? unitVM(this.state, occupant) : null);

    if (this.mode.kind === 'move' && tile) {
      const unit = this.activeUnit();
      if (unit) {
        const occupied = buildOccupancy(this.state.units.values());
        const path = pathTo(this.state.field, unit, occupied, tile, undefined);
        this.terrain?.setPath(path.length > 1 ? path : null);
      }
    }

    if (this.mode.kind === 'target' && tile) {
      this.previewTarget(tile);
    }
  }

  private previewTarget(tile: Vec3): void {
    if (this.mode.kind !== 'target') return;
    const unit = this.activeUnit();
    if (!unit) return;
    const ability = this.mode.ability;
    if (!this.mode.legal.has(tileKey(tile.x, tile.y))) {
      this.ui.setTargetPreview(null);
      this.terrain?.clearHighlights('aoe');
      return;
    }

    if (this.scenario.layers.highlights) {
      this.terrain?.setHighlight('aoe', affectedTiles(this.state, unit, ability, tile));
    }
    const victim = this.unitAt(tile) ?? this.firstUnitIn(unit, ability, tile);
    this.ui.setTargetPreview(
      victim ? targetPreviewVM(this.state, unit, ability, victim) : null,
    );
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
      if (ok && this.state.active === unit.id) this.enterCommandMode(unit);
      else void this.beginTurn();
      return;
    }

    if (this.mode.kind === 'target' && unit) {
      if (!this.mode.legal.has(tileKey(tile.x, tile.y))) return;
      const ability = this.mode.ability;
      const victim = this.unitAt(tile);
      if (ability.range.radius === 0 && !ability.targetsTiles && !victim) return;
      this.setMode({ kind: 'idle' });
      this.ui.closeMenus();
      const ok = await this.submit({
        kind: 'act',
        unit: unit.id,
        ability: ability.id,
        target: tile,
        ...(victim ? { targetUnit: victim.id } : {}),
      });
      if (ok && this.state.active === unit.id) this.enterCommandMode(unit);
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
    if (!this.scenario.layers.ui) return;
    this.ui.setTurnOrder(turnOrderVM(this.state));
    const active = this.activeUnit();
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
function resolveVfxKey(ability: Ability): string {
  if (VFX_KEY_SET.has(ability.vfx)) return ability.vfx;
  const tail = ability.vfx.split('/').pop() ?? '';
  if (VFX_KEY_SET.has(tail)) return tail;
  if (ability.element !== 'none' && VFX_KEY_SET.has(ability.element)) return ability.element;
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

function weaponReach(unit: Unit): number {
  let reach = 1;
  for (const id of [unit.equipment.rightHand, unit.equipment.leftHand]) {
    if (id === undefined) continue;
    const item = ALL_ITEMS.get(id);
    if (item?.range !== undefined && item.range > reach) reach = item.range;
  }
  return reach;
}

function labelForSet(unit: Unit, setId: string): string {
  const job = getJob(unit.currentJob);
  if (setId === actionSetOf(job)) return job.name;
  return setId
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

