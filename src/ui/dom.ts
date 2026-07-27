/**
 * Minimal DOM helpers. No framework — the UI is a hand-built DOM overlay so that
 * text stays crisp and layout stays cheap while the 3D scene renders behind it.
 */

export type Cleanup = () => void;

/** Create an element with an optional class list and text content. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Create a `<div>`; the overwhelmingly common case. */
export function div(className?: string, text?: string): HTMLDivElement {
  return el('div', className, text);
}

/** Append children, skipping nulls, and return the parent for chaining. */
export function add<T extends HTMLElement>(parent: T, ...children: (Node | null | undefined)[]): T {
  for (const c of children) if (c) parent.appendChild(c);
  return parent;
}

/** Replace all children of a node. */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Parse a trusted SVG source string into an element. Used only for our own icon set. */
export function svgFromSource(source: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  const imported = document.importNode(root, true);
  return imported as unknown as SVGSVGElement;
}

/** addEventListener that returns its own disposer. */
export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): Cleanup;
export function on<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  handler: (ev: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
): Cleanup;
export function on(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
): Cleanup {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Force a style recalculation so a freshly-added class animates from its start state. */
export function reflow(node: HTMLElement): void {
  void node.offsetWidth;
}

/** Toggle a class and return the element. */
export function cls<T extends Element>(node: T, name: string, active: boolean): T {
  node.classList.toggle(name, active);
  return node;
}

/**
 * Remove a node after its CSS exit transition finishes, with a hard timeout so a
 * dropped `transitionend` (element hidden mid-transition) can never leak nodes.
 */
export function removeAfterTransition(node: HTMLElement, fallbackMs = 600): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    node.remove();
  };
  node.addEventListener('transitionend', finish);
  node.addEventListener('animationend', finish);
  window.setTimeout(finish, fallbackMs);
}

/** Clamp helper used by every list/cursor in the UI. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap an index into [0, length). Returns 0 for an empty range. */
export function wrapIndex(i: number, length: number): number {
  if (length <= 0) return 0;
  return ((i % length) + length) % length;
}
