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
import { BannerLayer, HintBar, type BannerTone, type HintDef } from './components/Banner';
import { CommandMenu } from './components/CommandMenu';
import { FloatingTextLayer } from './components/FloatingText';
import { TargetPreview } from './components/TargetPreview';
import { TurnOrderBar } from './components/TurnOrderBar';
import { UnitInfoPanel } from './components/UnitInfoPanel';
import { add, div } from './dom';
import { InputRouter, type FocusLayer, type UIKey } from './input';
import { setPortraitBase } from './portraits';
import { FormationScreen } from './screens/FormationScreen';
import { JobScreen } from './screens/JobScreen';
import { ResultScreen } from './screens/ResultScreen';
import { RosterScreen } from './screens/RosterScreen';
import type {
  AbilityItemVM,
  CommandItemVM,
  FloatTextVM,
  FormationScreenVM,
  IntentHandler,
  JobScreenVM,
  ResultScreenVM,
  RosterScreenVM,
  ScreenName,
  TargetPreviewVM,
  TurnEntryVM,
  UIIntent,
  UIOptions,
  UnitVM,
} from './types';

/** Default hint rail for normal field play. */
const FIELD_HINTS: readonly HintDef[] = [
  { keys: ['↑', '↓'], label: 'Select' },
  { keys: ['Enter'], label: 'Confirm' },
  { keys: ['Esc'], label: 'Back' },
  { keys: ['Q', 'E'], label: 'Rotate' },
  { keys: ['+', '−'], label: 'Zoom' },
];

export class UIRoot {
  readonly root: HTMLDivElement;

  private readonly handlers = new Set<IntentHandler>();
  private readonly input = new InputRouter();

  private readonly hud: HTMLDivElement;
  private readonly turnOrder: TurnOrderBar;
  private readonly activeInfo: UnitInfoPanel;
  private readonly inspectInfo: UnitInfoPanel;
  private readonly commandMenu: CommandMenu;
  private readonly abilityMenu: AbilityMenu;
  private readonly targetPreview: TargetPreview;
  private readonly floats: FloatingTextLayer;
  private readonly banners: BannerLayer;
  private readonly hints: HintBar;

  private readonly jobScreen: JobScreen;
  private readonly formationScreen: FormationScreen;
  private readonly rosterScreen: RosterScreen;
  private readonly resultScreen: ResultScreen;

  /** Base layer: owns the camera keybinds and the "cancel with nothing open" case. */
  private readonly fieldLayer: FocusLayer;
  private openScreen: ScreenName | null = null;
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
    this.activeInfo = new UnitInfoPanel({ variant: 'full', side: 'left' });
    this.inspectInfo = new UnitInfoPanel({ variant: 'compact', side: 'right' });
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

    const left = div('et-hud__left');
    const right = div('et-hud__right');
    const menus = div('et-hud__menus');
    this.activeInfo.mount(left);
    this.inspectInfo.mount(right);
    this.targetPreview.mount(right);
    add(menus, this.commandMenu.root, this.abilityMenu.root);
    this.commandMenu.hide();
    this.abilityMenu.hide();
    add(this.hud, this.turnOrder.root, left, right, menus, this.hints.root);

    // ── screens ─────────────────────────────────────────────────────────────
    const emit = (i: UIIntent): void => this.emit(i);
    this.jobScreen = new JobScreen(emit);
    this.formationScreen = new FormationScreen(emit);
    this.rosterScreen = new RosterScreen(emit);
    this.resultScreen = new ResultScreen(emit);

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
          case 'cancel':
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
  }

  /** The unit under the cursor / hovered in the turn bar — drives the right panel. */
  setInspectedUnit(unit: UnitVM | null): void {
    this.inspectInfo.set(unit);
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
    this.commandMenu.show(this.hud.querySelector('.et-hud__menus') ?? this.hud);
    this.input.push(this.commandMenu);
    this.hints.set([
      { keys: ['↑', '↓'], label: 'Select' },
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['Esc'], label: 'Back' },
    ]);
  }

  hideCommandMenu(): void {
    this.commandMenu.hide();
    this.input.remove(this.commandMenu);
    if (!this.abilityMenu.isOpen) this.hints.set(FIELD_HINTS);
  }

  showAbilityMenu(
    items: readonly AbilityItemVM[],
    opts: { title?: string; mp?: number; maxMp?: number } = {},
  ): void {
    this.abilityMenu.setItems(items, opts);
    this.abilityMenu.show(this.hud.querySelector('.et-hud__menus') ?? this.hud);
    this.input.push(this.abilityMenu);
    this.hints.set([
      { keys: ['↑', '↓'], label: 'Select' },
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['Esc'], label: 'Back' },
    ]);
  }

  hideAbilityMenu(): void {
    this.abilityMenu.hide();
    this.input.remove(this.abilityMenu);
    if (!this.commandMenu.isOpen) this.hints.set(FIELD_HINTS);
  }

  /** Close every open battle menu — used when a command resolves. */
  closeMenus(): void {
    this.hideAbilityMenu();
    this.hideCommandMenu();
    this.setTargetPreview(null);
  }

  setTargetPreview(vm: TargetPreviewVM | null): void {
    this.targetPreview.set(vm);
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
    this.hints.set(FIELD_HINTS);
  }

  private presentScreen(name: ScreenName, screen: JobScreen | FormationScreen | RosterScreen | ResultScreen): void {
    if (this.openScreen && this.openScreen !== name) this.closeScreen();
    screen.show(this.root, () => {
      this.emit({ kind: 'close-screen', screen: name });
    });
    if (!this.input.has(screen)) this.input.push(screen);
    this.openScreen = name;
    this.hud.classList.add('is-behind-screen');
    this.hints.set([
      { keys: ['Tab'], label: 'Switch pane' },
      { keys: ['↑', '↓', '←', '→'], label: 'Navigate' },
      { keys: ['Enter'], label: 'Confirm' },
      { keys: ['Esc'], label: 'Close' },
    ]);
  }

  private screenFor(name: ScreenName): JobScreen | FormationScreen | RosterScreen | ResultScreen {
    switch (name) {
      case 'job': return this.jobScreen;
      case 'formation': return this.formationScreen;
      case 'roster': return this.rosterScreen;
      default: return this.resultScreen;
    }
  }

  // ── housekeeping ──────────────────────────────────────────────────────────

  /** Re-measure anything that depends on layout (menu carets, tree tracery). */
  refreshLayout(): void {
    this.commandMenu.refreshLayout();
    this.abilityMenu.refreshLayout();
  }

  dispose(): void {
    this.input.dispose();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.handlers.clear();
    this.root.remove();
  }
}
