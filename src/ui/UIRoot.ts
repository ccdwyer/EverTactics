/**
 * UIRoot — the single object the game layer talks to.
 *
 * Data goes in through the `set*` / `show*` methods; player intent comes out
 * through `on(handler)`. The UI holds no reference to `BattleState`, never
 * mutates game data, and can be driven entirely from replayed view-models.
 */

import './styles.css';

import { setReducedMotion } from './anim';
import { play, setSoundEnabled } from './audio';
import { AbilityMenu } from './components/AbilityMenu';
import { BannerLayer, HintBar, PromptBar, type BannerTone, type HintDef } from './components/Banner';
import { CommandMenu } from './components/CommandMenu';
import { FloatingTextLayer } from './components/FloatingText';
import { TargetPreview } from './components/TargetPreview';
import { TurnOrderBar } from './components/TurnOrderBar';
import { UnitInfoPanel } from './components/UnitInfoPanel';
import { add, div } from './dom';
import { InputRouter, type FocusLayer, type UIKey } from './input';
import { setPortraitBase } from './portraits';
import {
  BattlePresentationScreen,
  type BattleIntroVM,
  type BattleOutcomeVM,
} from './screens/BattlePresentationScreen';
import { FormationScreen } from './screens/FormationScreen';
import { JobScreen } from './screens/JobScreen';
import { RecruitScreen } from './screens/RecruitScreen';
import { ResultScreen } from './screens/ResultScreen';
import { RosterScreen } from './screens/RosterScreen';
import { ShopScreen } from './screens/ShopScreen';
import { TitleScreen } from './screens/TitleScreen';
import { WorldMapScreen } from './screens/WorldMapScreen';
import type {
  AbilityItemVM,
  CommandItemVM,
  FloatTextVM,
  FormationScreenVM,
  IntentHandler,
  JobScreenVM,
  RecruitScreenVM,
  ResultScreenVM,
  RosterScreenVM,
  ScreenName,
  ShopScreenVM,
  TargetPreviewVM,
  TitleScreenVM,
  TurnEntryVM,
  UIIntent,
  UIOptions,
  UnitVM,
  WorldMapScreenVM,
} from './types';

/** Default hint rail for normal field play. */
/**
 * Default hint rail for normal field play.
 *
 * Four groups, not five. Both reference games run three or four prompts and no
 * more — FFT's corner reads "Move Here / Cancel / Zoom / Change Display" — and a
 * five-group rail was wide enough to reach a third of the way across the frame,
 * which is part of what the critics meant by the chrome crowding the board. The
 * two camera binds fold into one group.
 */
const CAMERA_HINT: HintDef = { keys: ['IJKL', 'Q/E', '±'], label: 'Camera' };

const FIELD_HINTS: readonly HintDef[] = [
  { keys: ['↑', '↓'], label: 'Select' },
  { keys: ['Enter'], label: 'Confirm' },
  { keys: ['Esc'], label: 'Back' },
  CAMERA_HINT,
];

export class UIRoot {
  readonly root: HTMLDivElement;

  private readonly handlers = new Set<IntentHandler>();
  private readonly input = new InputRouter();

  private readonly hud: HTMLDivElement;
  private readonly menus: HTMLDivElement;
  private menuDock: 'left' | 'right' = 'right';
  private readonly turnOrder: TurnOrderBar;
  private readonly activeInfo: UnitInfoPanel;
  private readonly inspectInfo: UnitInfoPanel;
  private readonly commandMenu: CommandMenu;
  private readonly abilityMenu: AbilityMenu;
  private readonly targetPreview: TargetPreview;
  private readonly floats: FloatingTextLayer;
  private readonly banners: BannerLayer;
  private readonly hints: HintBar;
  private readonly prompt: PromptBar;
  /** Name of the unit whose turn it is — the step prompt addresses them by name. */
  private activeName = '';

  private readonly jobScreen: JobScreen;
  private readonly formationScreen: FormationScreen;
  private readonly rosterScreen: RosterScreen;
  private readonly shopScreen: ShopScreen;
  private readonly recruitScreen: RecruitScreen;
  private readonly resultScreen: ResultScreen;
  private readonly battlePresentation: BattlePresentationScreen;
  private readonly titleScreen: TitleScreen;
  private readonly worldMapScreen: WorldMapScreen;

  /** Base layer: owns the camera keybinds and the "cancel with nothing open" case. */
  private readonly fieldLayer: FocusLayer;
  private openScreen: ScreenName | null = null;
  /** Last unit handed to setInspectedUnit, restored when targeting ends. */
  private inspected: UnitVM | null = null;
  private targeting = false;
  private motionQuery: MediaQueryList | null = null;
  private readonly disposers: (() => void)[] = [];

  constructor(mount: HTMLElement, opts: UIOptions = {}) {
    if (opts.portraitBase) setPortraitBase(opts.portraitBase);
    setSoundEnabled(opts.sound !== false);

    if (opts.respectReducedMotion !== false && typeof window.matchMedia === 'function') {
      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      setReducedMotion(this.motionQuery.matches);
      const onChange = (): void => setReducedMotion(this.motionQuery?.matches ?? false);
      this.motionQuery.addEventListener('change', onChange);
      this.disposers.push(() => this.motionQuery?.removeEventListener('change', onChange));
    }

    this.root = div('et-root');
    this.root.dataset['theme'] = 'ivalice';
    // index.html declares `#ui > * { pointer-events: auto }`, which would make the
    // whole overlay swallow mouse input meant for the 3D scene. An inline style
    // outranks that id rule; individual panels opt back in via the stylesheet.
    this.root.style.pointerEvents = 'none';

    // ── battle HUD ──────────────────────────────────────────────────────────
    this.hud = div('et-hud');
    this.turnOrder = new TurnOrderBar({
      onFocus: (unitId) => this.emit({ kind: 'inspect-unit', unitId, focus: false }),
      onSelect: (unitId) => this.emit({ kind: 'inspect-unit', unitId, focus: true }),
    });
    // `band: true` — the battle HUD's two cards are wide, short bands pinned to
    // screen corners. Every other consumer (the roster detail pane) keeps the
    // stacked card, which is the right shape for a narrow sidebar.
    this.activeInfo = new UnitInfoPanel({ variant: 'full', side: 'left', band: true });
    this.inspectInfo = new UnitInfoPanel({
      variant: 'compact',
      side: 'right',
      band: true,
      showLoadout: true,
    });
    this.commandMenu = new CommandMenu({
      onConfirm: (id) => this.emit({ kind: 'command', id }),
      onHighlight: (id) => this.emit({ kind: 'command-highlight', id }),
      onCancel: () => this.emit({ kind: 'cancel' }),
    });
    this.abilityMenu = new AbilityMenu({
      onConfirm: (id) => this.emit({ kind: 'ability', id }),
      onHighlight: (id) => this.emit({ kind: 'ability-highlight', id }),
      onCancel: () => this.emit({ kind: 'cancel' }),
    });
    this.targetPreview = new TargetPreview();
    this.floats = new FloatingTextLayer();
    this.banners = new BannerLayer();
    this.hints = new HintBar();
    this.hints.set(FIELD_HINTS);
    this.prompt = new PromptBar();

    const left = div('et-hud__left');
    const right = div('et-hud__right');
    const menus = div('et-hud__menus');
    this.menus = menus;
    this.activeInfo.mount(left);
    this.inspectInfo.mount(right);
    this.targetPreview.mount(right);
    add(menus, this.commandMenu.root, this.abilityMenu.root);
    this.commandMenu.hide();
    this.abilityMenu.hide();
    add(this.hud, this.prompt.root, this.turnOrder.root, left, right, menus, this.hints.root);

    // ── screens ─────────────────────────────────────────────────────────────
    const emit = (i: UIIntent): void => this.emit(i);
    this.jobScreen = new JobScreen(emit);
    this.formationScreen = new FormationScreen(emit);
    this.rosterScreen = new RosterScreen(emit);
    this.shopScreen = new ShopScreen(emit);
    this.recruitScreen = new RecruitScreen(emit);
    this.resultScreen = new ResultScreen(emit);
    this.battlePresentation = new BattlePresentationScreen();
    this.titleScreen = new TitleScreen(emit);
    this.worldMapScreen = new WorldMapScreen(emit);

    add(this.root, this.hud, this.floats.root, this.banners.root);
    mount.appendChild(this.root);

    this.fieldLayer = {
      name: 'field',
      onKey: (key: UIKey) => {
        switch (key) {
          case 'rotate-cw':
            this.emit({ kind: 'camera', action: 'rotate-cw' });
            return true;
          case 'rotate-ccw':
            this.emit({ kind: 'camera', action: 'rotate-ccw' });
            return true;
          case 'zoom-in':
            this.emit({ kind: 'camera', action: 'zoom-in' });
            return true;
          case 'zoom-out':
            this.emit({ kind: 'camera', action: 'zoom-out' });
            return true;
          case 'reset-view':
            this.emit({ kind: 'camera', action: 'reset' });
            return true;
          case 'pan-up':
          case 'pan-down':
          case 'pan-left':
          case 'pan-right':
            this.emit({ kind: 'camera', action: key });
            return true;
          case 'cancel':
            play('cancel');
            this.emit({ kind: 'cancel' });
            return true;
          default:
            return false;
        }
      },
    };
    this.input.push(this.fieldLayer);
    this.input.attach(window);

    const onResize = (): void => this.refreshLayout();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));

    // Fonts change metrics; re-place the menu carets once they land.
    if ('fonts' in document) {
      void document.fonts.ready.then(() => this.refreshLayout());
    }
  }

  // ── intents ───────────────────────────────────────────────────────────────

  /** Subscribe to player intent. Returns an unsubscribe function. */
  on(handler: IntentHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(intent: UIIntent): void {
    for (const h of this.handlers) h(intent);
  }

  // ── battle HUD ────────────────────────────────────────────────────────────

  setHudVisible(visible: boolean): void {
    this.hud.classList.toggle('is-hidden', !visible);
  }

  /** The unit whose turn it is — drives the left panel. */
  setActiveUnit(unit: UnitVM | null): void {
    this.activeInfo.set(unit);
    this.activeName = unit?.name ?? '';
    this.refreshPrompt();
  }

  /**
   * Restate what the player is being asked for.
   *
   * Derived rather than pushed, so the game layer cannot leave a stale
   * instruction on screen: whichever of the three battle modes is live wins, and
   * "nothing open" falls back to the field step. See the note on `PromptBar`.
   */
  private refreshPrompt(): void {
    const who = this.activeName ? ` for ${this.activeName}` : '';
    if (this.targeting) this.prompt.set('Choose a target and press %k to commit.', 'Enter');
    else if (this.abilityMenu.isOpen) this.prompt.set('Choose an ability, or press %k to go back.', 'Esc');
    else if (this.commandMenu.isOpen) this.prompt.set(`Choose a command${who} and press %k to confirm.`, 'Enter');
    else if (this.activeName) this.prompt.set(`${this.activeName} is ready to act.`);
    else this.prompt.set(null);
  }

  /** Override the derived step prompt; `null` restores the derived one. */
  setPrompt(text: string | null, key?: string): void {
    if (text === null) this.refreshPrompt();
    else this.prompt.set(text, key);
  }

  /**
   * The unit under the cursor / hovered in the turn bar — drives the right panel.
   *
   * Suppressed while a target preview is up. The preview already names the
   * target, shows its HP and the predicted result, so running the inspect card
   * above it duplicates the same unit twice in the same column — and stacked
   * they are tall enough to run into the command window docked below (measured:
   * the column reached y=782 against a menu top of y=769 on a 1080 frame).
   * Collapsing to one card is also the fix the critics asked for by name: "fold
   * the key legend away and only show the enemy card on hover/target".
   */
  setInspectedUnit(unit: UnitVM | null): void {
    this.inspected = unit;
    this.inspectInfo.set(this.targeting ? null : unit);
  }

  setTurnOrder(entries: readonly TurnEntryVM[]): void {
    this.turnOrder.setEntries(entries);
  }

  /**
   * Open the command menu. `anchor` is an optional screen-space point (usually the
   * active unit projected by the renderer) that the menu tucks itself beside.
   */
  showCommandMenu(items: readonly CommandItemVM[], anchor?: { x: number; y: number }): void {
    this.commandMenu.setItems(items);
    if (anchor) this.commandMenu.placeAt(anchor.x, anchor.y);
    else this.commandMenu.clearAnchor();
    this.dockMenusAwayFrom(anchor);
    this.commandMenu.show(this.menus);
    this.input.push(this.commandMenu);
    this.refreshPrompt();
    this.hints.set([
      { keys: ['↑', '↓'], label: 'Select' },
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['Esc'], label: 'Back' },
      CAMERA_HINT,
    ]);
  }

  hideCommandMenu(): void {
    this.commandMenu.hide();
    this.input.remove(this.commandMenu);
    this.refreshPrompt();
    if (!this.abilityMenu.isOpen) this.hints.set(FIELD_HINTS);
  }

  showAbilityMenu(
    items: readonly AbilityItemVM[],
    opts: { title?: string; mp?: number; maxMp?: number } = {},
  ): void {
    this.abilityMenu.setItems(items, opts);
    this.abilityMenu.show(this.menus);
    this.input.push(this.abilityMenu);
    this.refreshPrompt();
    this.hints.set([
      { keys: ['↑', '↓'], label: 'Select' },
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['Esc'], label: 'Back' },
      CAMERA_HINT,
    ]);
  }

  hideAbilityMenu(): void {
    this.abilityMenu.hide();
    this.input.remove(this.abilityMenu);
    this.refreshPrompt();
    if (!this.commandMenu.isOpen) this.hints.set(FIELD_HINTS);
  }

  /** Close every open battle menu — used when a command resolves. */
  closeMenus(): void {
    this.hideAbilityMenu();
    this.hideCommandMenu();
    this.setTargetPreview(null);
  }

  setTargetPreview(vm: TargetPreviewVM | null): void {
    this.targeting = vm !== null;
    this.targetPreview.set(vm);
    this.inspectInfo.set(this.targeting ? null : this.inspected);
    this.refreshPrompt();
  }

  /** Spawn floating combat text at a screen-space point. */
  float(vm: FloatTextVM): void {
    this.floats.spawn(vm);
  }

  floatBurst(items: readonly FloatTextVM[], stepMs?: number): void {
    this.floats.spawnBurst(items, stepMs);
  }

  clearFloats(): void {
    this.floats.clear();
  }

  banner(title: string, opts: { subtitle?: string; tone?: BannerTone; duration?: number } = {}): void {
    this.banners.show(title, opts);
  }

  setHints(hints: readonly HintDef[]): void {
    this.hints.set(hints);
  }

  /** Play one of the interface sounds directly (used for game-driven feedback). */
  sound = play;

  // ── full-screen overlays ──────────────────────────────────────────────────

  openJobScreen(vm: JobScreenVM): void {
    this.jobScreen.set(vm);
    this.presentScreen('job', this.jobScreen);
  }

  openTitleScreen(vm: TitleScreenVM): void {
    this.titleScreen.set(vm);
    this.presentScreen('title', this.titleScreen);
  }

  updateTitleScreen(vm: TitleScreenVM): void {
    this.titleScreen.set(vm);
  }

  requestTitleOverwriteConfirmation(): void {
    this.titleScreen.requestOverwriteConfirmation();
  }

  openWorldMapScreen(vm: WorldMapScreenVM): void {
    this.worldMapScreen.set(vm);
    this.presentScreen('world', this.worldMapScreen);
  }

  updateWorldMapScreen(vm: WorldMapScreenVM): void {
    this.worldMapScreen.set(vm);
  }

  openShopScreen(vm: ShopScreenVM): void {
    this.shopScreen.set(vm);
    this.presentScreen('shop', this.shopScreen);
  }

  updateShopScreen(vm: ShopScreenVM): void {
    this.shopScreen.set(vm);
  }

  openRecruitScreen(vm: RecruitScreenVM): void {
    this.recruitScreen.set(vm);
    this.presentScreen('recruit', this.recruitScreen);
  }

  updateRecruitScreen(vm: RecruitScreenVM): void {
    this.recruitScreen.set(vm);
  }

  /** Push new data into an already-open job screen (after learning, job change…). */
  updateJobScreen(vm: JobScreenVM): void {
    this.jobScreen.set(vm);
  }

  openFormationScreen(vm: FormationScreenVM): void {
    this.formationScreen.set(vm);
    this.presentScreen('formation', this.formationScreen);
  }

  updateFormationScreen(vm: FormationScreenVM): void {
    this.formationScreen.set(vm);
  }

  openRosterScreen(vm: RosterScreenVM): void {
    this.rosterScreen.set(vm);
    this.presentScreen('roster', this.rosterScreen);
  }

  updateRosterScreen(vm: RosterScreenVM): void {
    this.rosterScreen.set(vm);
  }

  showResult(vm: ResultScreenVM): void {
    this.resultScreen.set(vm);
    this.presentScreen('result', this.resultScreen);
  }

  presentBattleIntro(vm: BattleIntroVM): Promise<void> {
    return this.battlePresentation.showIntro(this.root, vm);
  }

  presentBattleOutcome(vm: BattleOutcomeVM): Promise<void> {
    return this.battlePresentation.showOutcome(this.root, vm);
  }

  get currentScreen(): ScreenName | null {
    return this.openScreen;
  }

  closeScreen(): void {
    if (!this.openScreen) return;
    const screen = this.screenFor(this.openScreen);
    screen.hide();
    this.input.remove(screen);
    this.openScreen = null;
    this.hud.classList.remove('is-behind-screen');
    this.refreshPrompt();
    this.hints.set(FIELD_HINTS);
  }

  private presentScreen(
    name: ScreenName,
    screen:
      | WorldMapScreen
      | TitleScreen
      | ShopScreen
      | RecruitScreen
      | JobScreen
      | FormationScreen
      | RosterScreen
      | ResultScreen,
  ): void {
    if (this.openScreen && this.openScreen !== name) this.closeScreen();
    screen.show(this.root, () => {
      this.emit({ kind: 'close-screen', screen: name });
    });
    if (!this.input.has(screen)) this.input.push(screen);
    this.openScreen = name;
    this.hud.classList.add('is-behind-screen');
    this.prompt.setVisible(false);
    this.hints.set(name === 'title'
      ? [
          { keys: ['↑', '↓'], label: 'Choose' },
          { keys: ['Enter'], label: 'Confirm' },
        ]
      : [
          { keys: ['Tab'], label: 'Switch pane' },
          { keys: ['↑', '↓', '←', '→'], label: 'Navigate' },
          { keys: ['Enter'], label: 'Confirm' },
          { keys: ['Esc'], label: 'Close' },
        ]);
  }

  private screenFor(
    name: ScreenName,
  ):
    | TitleScreen
    | WorldMapScreen
    | ShopScreen
    | RecruitScreen
    | JobScreen
    | FormationScreen
    | RosterScreen
    | ResultScreen {
    switch (name) {
      case 'title': return this.titleScreen;
      case 'world': return this.worldMapScreen;
      case 'shop': return this.shopScreen;
      case 'recruit': return this.recruitScreen;
      case 'job': return this.jobScreen;
      case 'formation': return this.formationScreen;
      case 'roster': return this.rosterScreen;
      case 'result': return this.resultScreen;
    }
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /**
   * Which corner the command / ability windows dock to.
   *
   * They live in the bottom-RIGHT by default. The one thing that must never
   * happen is the window covering the unit the player is commanding, so if the
   * renderer tells us where that unit is on screen and it falls under the docked
   * corner, the whole menu row flips to the bottom-left instead.
   */
  setMenuDock(side: 'left' | 'right'): void {
    if (this.menuDock === side) return;
    this.menuDock = side;
    this.menus.classList.toggle('is-dock-left', side === 'left');
  }

  /** Which corner the battle menus are currently docked to. */
  get menuDockSide(): 'left' | 'right' {
    return this.menuDock;
  }

  private dockMenusAwayFrom(anchor?: { x: number; y: number }): void {
    if (!anchor) {
      this.setMenuDock('right');
      return;
    }
    const w = window.innerWidth || 1920;
    const h = window.innerHeight || 1080;
    // The docked stack occupies roughly the right 34% and bottom 38% of the
    // frame; anything inside that box would be hidden behind it.
    const overlaps = anchor.x > w * 0.62 && anchor.y > h * 0.58;
    this.setMenuDock(overlaps ? 'left' : 'right');
  }

  /** Re-measure anything that depends on layout (menu carets, tree tracery). */
  refreshLayout(): void {
    this.commandMenu.refreshLayout();
    this.abilityMenu.refreshLayout();
  }

  dispose(): void {
    this.battlePresentation.dispose();
    this.input.dispose();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.handlers.clear();
    this.root.remove();
  }
}
