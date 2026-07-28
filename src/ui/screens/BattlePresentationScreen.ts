/**
 * Brief field presentation between navigation, battle, and results.
 *
 * Unlike the full management screens this never emits game intent. It resolves
 * a promise when its short hold ends or any player input skips it, leaving the
 * battle state and result routing entirely in the game layer.
 */

import { play } from '../audio';
import { add, div, el, reflow } from '../dom';

export const BATTLE_INTRO_DURATION_MS = 2_200;
export const BATTLE_OUTCOME_DURATION_MS = 2_000;

export interface BattleIntroVM {
  mapName: string;
  encounterName: string;
}

export interface BattleOutcomeVM {
  outcome: 'victory' | 'defeat';
  subtitle: string;
}

export function listenForPresentationSkip(
  target: EventTarget,
  onSkip: () => void,
): () => void {
  const skip = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    onSkip();
  };
  const capture = { capture: true };
  const wheel = { capture: true, passive: false };
  target.addEventListener('keydown', skip, capture);
  target.addEventListener('pointerdown', skip, capture);
  target.addEventListener('wheel', skip, wheel);
  return () => {
    target.removeEventListener('keydown', skip, capture);
    target.removeEventListener('pointerdown', skip, capture);
    target.removeEventListener('wheel', skip, wheel);
  };
}

export class BattlePresentationScreen {
  readonly root = div('et-battle-presentation');

  private timer = 0;
  private resolve: (() => void) | null = null;
  private stopListening: (() => void) | null = null;

  constructor() {
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
  }

  showIntro(
    parent: HTMLElement,
    vm: BattleIntroVM,
    duration = BATTLE_INTRO_DURATION_MS,
  ): Promise<void> {
    return this.show(parent, {
      kind: 'intro',
      eyebrow: vm.mapName,
      title: vm.encounterName,
      subtitle: 'Engagement',
      duration,
    });
  }

  showOutcome(
    parent: HTMLElement,
    vm: BattleOutcomeVM,
    duration = BATTLE_OUTCOME_DURATION_MS,
  ): Promise<void> {
    return this.show(parent, {
      kind: vm.outcome,
      eyebrow: 'Battle concluded',
      title: vm.outcome === 'victory' ? 'Victory' : 'Defeat',
      subtitle: vm.subtitle,
      duration,
    });
  }

  dispose(): void {
    this.finish();
    this.root.remove();
  }

  private show(
    parent: HTMLElement,
    vm: {
      kind: 'intro' | 'victory' | 'defeat';
      eyebrow: string;
      title: string;
      subtitle: string;
      duration: number;
    },
  ): Promise<void> {
    this.finish();
    if (this.root.parentElement !== parent) parent.appendChild(this.root);
    this.root.dataset['kind'] = vm.kind;

    const card = div('et-battle-presentation__card');
    add(
      card,
      el('span', 'et-battle-presentation__eyebrow', vm.eyebrow),
      el('span', 'et-battle-presentation__title', vm.title),
      el('span', 'et-battle-presentation__subtitle', vm.subtitle),
      div('et-battle-presentation__rule'),
      el('span', 'et-battle-presentation__skip', 'Any input — skip'),
    );
    this.root.replaceChildren(card);
    reflow(this.root);
    this.root.classList.add('is-open');
    this.stopListening = listenForPresentationSkip(window, () => this.finish());
    if (vm.kind !== 'intro') {
      play(vm.kind === 'defeat' ? 'error' : 'award');
    }

    return new Promise<void>((resolve) => {
      this.resolve = resolve;
      this.timer = window.setTimeout(() => this.finish(), vm.duration);
    });
  }

  private finish(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.stopListening?.();
    this.stopListening = null;
    this.root.classList.remove('is-open');
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.();
  }
}
