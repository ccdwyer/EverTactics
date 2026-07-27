/**
 * A resource bar with a trailing "ghost" fill.
 *
 * When HP drops, the coloured fill snaps to the new value while a pale ghost
 * drains after it — the reader sees exactly how much was lost. When it rises,
 * the ghost leads and the fill catches up. The numeric read-out counts.
 */

import { countTo, easeOutCubic, tween, type TweenHandle } from '../anim';
import { add, div, el } from '../dom';

export type MeterTone = 'hp' | 'mp' | 'ct' | 'exp' | 'jp' | 'brave' | 'faith';

export interface MeterOptions {
  tone: MeterTone;
  label?: string;
  /** Show "cur / max" numerals. Default true. */
  numerals?: boolean;
  /** Compact height for dense panels. */
  compact?: boolean;
}

export class Meter {
  readonly root: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private readonly curNode: HTMLSpanElement | null = null;
  private readonly maxNode: HTMLSpanElement | null = null;
  private cur = 0;
  private max = 1;
  private ghostTween: TweenHandle | null = null;
  private countTween: TweenHandle | null = null;
  private ghostRatio = 0;

  constructor(private readonly opts: MeterOptions) {
    this.root = div(`et-meter et-meter--${opts.tone}${opts.compact ? ' et-meter--compact' : ''}`);
    const head = div('et-meter__head');
    if (opts.label) head.appendChild(el('span', 'et-meter__label', opts.label));
    if (opts.numerals !== false) {
      const nums = div('et-meter__nums');
      this.curNode = el('span', 'et-meter__cur', '0');
      this.maxNode = el('span', 'et-meter__max', '/ 0');
      add(nums, this.curNode, this.maxNode);
      head.appendChild(nums);
    }
    const track = div('et-meter__track');
    this.ghost = div('et-meter__ghost');
    this.fill = div('et-meter__fill');
    add(track, this.ghost, this.fill, div('et-meter__sheen'));
    add(this.root, head, track);
  }

  /** Set values. `animate: false` snaps (used when swapping which unit is shown). */
  set(cur: number, max: number, animate = true): void {
    const clampedMax = Math.max(1, max);
    const clamped = Math.max(0, Math.min(cur, clampedMax));
    const prev = this.cur;
    const prevRatio = this.max > 0 ? prev / this.max : 0;
    this.cur = clamped;
    this.max = clampedMax;
    const ratio = clamped / clampedMax;

    this.fill.style.width = `${ratio * 100}%`;
    this.root.classList.toggle('is-critical', this.opts.tone === 'hp' && ratio > 0 && ratio <= 0.25);
    this.root.classList.toggle('is-empty', ratio <= 0);

    this.ghostTween?.cancel();
    if (!animate) {
      this.ghostRatio = ratio;
      this.ghost.style.width = `${ratio * 100}%`;
      this.ghost.classList.remove('is-loss', 'is-gain');
    } else {
      const loss = ratio < prevRatio;
      this.ghost.classList.toggle('is-loss', loss);
      this.ghost.classList.toggle('is-gain', !loss);
      const from = loss ? Math.max(prevRatio, this.ghostRatio) : ratio;
      if (!loss) {
        // Gain: ghost jumps ahead, fill grows into it.
        this.ghost.style.width = `${ratio * 100}%`;
        this.ghostRatio = ratio;
      } else {
        this.ghost.style.width = `${from * 100}%`;
        this.ghostTween = tween({
          from,
          to: ratio,
          duration: 520,
          delay: 220,
          ease: easeOutCubic,
          step: (v) => {
            this.ghostRatio = v;
            this.ghost.style.width = `${v * 100}%`;
          },
        });
      }
    }

    if (this.maxNode) this.maxNode.textContent = `/ ${clampedMax}`;
    if (this.curNode) {
      this.countTween?.cancel();
      if (animate) this.countTween = countTo(this.curNode, prev, clamped, { duration: 420 });
      else this.curNode.textContent = String(clamped);
    }
  }

  get value(): number {
    return this.cur;
  }
}
