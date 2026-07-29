/**
 * Keyboard routing.
 *
 * The UI is a stack of focus layers: the topmost layer that claims a key wins.
 * Opening the ability submenu pushes a layer; cancelling pops it. This is what
 * makes deep menu trees feel right without any component knowing about another.
 */

export type UIKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'cancel'
  | 'next'
  | 'prev'
  | 'page-up'
  | 'page-down'
  | 'home'
  | 'end'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'zoom-in'
  | 'zoom-out'
  | 'reset-view'
  | 'pan-up'
  | 'pan-down'
  | 'pan-left'
  | 'pan-right'
  | 'menu';

export interface FocusLayer {
  /** Return true when the key was consumed. */
  onKey(key: UIKey, ev: KeyboardEvent): boolean;
  /** Called when the layer becomes / stops being the top of the stack. */
  onFocusChange?(active: boolean): void;
  /** Debug label. */
  name: string;
}

const KEY_MAP: Readonly<Record<string, UIKey>> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Space: 'confirm',
  KeyZ: 'confirm',
  Escape: 'cancel',
  Backspace: 'cancel',
  KeyX: 'cancel',
  Tab: 'next',
  PageUp: 'page-up',
  PageDown: 'page-down',
  Home: 'home',
  End: 'end',
  KeyQ: 'rotate-ccw',
  KeyE: 'rotate-cw',
  Equal: 'zoom-in',
  NumpadAdd: 'zoom-in',
  Minus: 'zoom-out',
  NumpadSubtract: 'zoom-out',
  KeyR: 'reset-view',
  KeyI: 'pan-up',
  KeyK: 'pan-down',
  KeyJ: 'pan-left',
  KeyL: 'pan-right',
  KeyC: 'menu',
};

export class InputRouter {
  private readonly stack: FocusLayer[] = [];
  private detach: (() => void) | null = null;

  attach(target: Window | HTMLElement = window): void {
    if (this.detach) return;
    const handler = (ev: Event): void => this.handle(ev as KeyboardEvent);
    target.addEventListener('keydown', handler);
    this.detach = () => target.removeEventListener('keydown', handler);
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.stack.length = 0;
  }

  push(layer: FocusLayer): void {
    const prev = this.top();
    if (prev === layer) return;
    prev?.onFocusChange?.(false);
    this.stack.push(layer);
    layer.onFocusChange?.(true);
  }

  /** Remove a layer wherever it sits in the stack. */
  remove(layer: FocusLayer): void {
    const i = this.stack.lastIndexOf(layer);
    if (i < 0) return;
    const wasTop = i === this.stack.length - 1;
    this.stack.splice(i, 1);
    if (wasTop) {
      layer.onFocusChange?.(false);
      this.top()?.onFocusChange?.(true);
    }
  }

  pop(): FocusLayer | undefined {
    const layer = this.stack.pop();
    layer?.onFocusChange?.(false);
    this.top()?.onFocusChange?.(true);
    return layer;
  }

  top(): FocusLayer | undefined {
    return this.stack[this.stack.length - 1];
  }

  has(layer: FocusLayer): boolean {
    return this.stack.includes(layer);
  }

  private handle(ev: KeyboardEvent): void {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }
    let key = KEY_MAP[ev.code];
    if (key === 'next' && ev.shiftKey) key = 'prev';
    if (!key) return;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const layer = this.stack[i];
      if (!layer) continue;
      if (layer.onKey(key, ev)) {
        ev.preventDefault();
        return;
      }
    }
  }
}
