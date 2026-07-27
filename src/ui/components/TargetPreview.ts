/**
 * Target preview — the panel players actually make decisions with.
 *
 * Shows the hit chance as a large numeral over an arc gauge, the predicted damage
 * (or healing) band, the target's HP bar with the predicted loss shaded in, the
 * chance of each inflicted status, and a facing rosette that makes front / side /
 * back attacks unmistakable.
 */

import { countTo } from '../anim';
import { add, div, el } from '../dom';
import { elementColor, elementIcon, icon } from '../icons';
import type { TargetPreviewVM } from '../types';
import { divider, Panel } from './Panel';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_RADIUS = 26;
const ARC_LENGTH = 2 * Math.PI * ARC_RADIUS;

export class TargetPreview {
  readonly root: HTMLDivElement;
  private readonly panel: Panel;
  private readonly body: HTMLDivElement;
  private readonly hitNumber: HTMLSpanElement;
  private readonly arcValue: SVGCircleElement;
  private readonly gauge: HTMLDivElement;
  private lastHit = 0;
  private visible = false;

  constructor() {
    this.panel = new Panel({ className: 'et-target', from: 'right', title: 'Target' });
    this.root = this.panel.root;
    this.body = div('et-target__body');

    const { wrap, circle, label } = buildArc();
    this.gauge = wrap;
    this.arcValue = circle;
    this.hitNumber = label;

    this.panel.body.appendChild(this.body);
  }

  mount(parent: HTMLElement): void {
    this.panel.mount(parent);
    this.setVisible(false);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('is-hidden', !v);
    this.root.classList.toggle('et-entered', v);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  set(vm: TargetPreviewVM | null): void {
    if (!vm) {
      this.setVisible(false);
      return;
    }
    this.panel.setTitle(vm.actionName, vm.targetName);
    this.body.replaceChildren();

    // ── hit chance gauge ────────────────────────────────────────────────────
    const chanceRow = div('et-target__chance');
    const hit = Math.max(0, Math.min(100, Math.round(vm.hitChance)));
    this.arcValue.style.strokeDasharray = `${ARC_LENGTH} ${ARC_LENGTH}`;
    this.arcValue.style.strokeDashoffset = String(ARC_LENGTH * (1 - hit / 100));
    this.gauge.dataset['band'] = hit >= 85 ? 'high' : hit >= 55 ? 'mid' : 'low';
    countTo(this.hitNumber, this.lastHit, hit, { duration: 380, format: (v) => `${Math.round(v)}` });
    this.lastHit = hit;
    const chanceMeta = div('et-target__chance-meta');
    add(
      chanceMeta,
      el('span', 'et-target__chance-label', 'Hit Chance'),
      el('span', 'et-target__vs', `${vm.attackerName} → ${vm.targetName}`),
    );
    if (vm.critChance !== undefined && vm.critChance > 0) {
      chanceMeta.appendChild(el('span', 'et-target__crit', `Critical ${Math.round(vm.critChance)}%`));
    }
    add(chanceRow, this.gauge, chanceMeta, this.buildRosette(vm.relative));
    this.body.appendChild(chanceRow);

    // ── damage / healing band ───────────────────────────────────────────────
    if (vm.amountMin !== undefined && vm.amountMax !== undefined) {
      const healing = vm.amountMin < 0 || vm.amountMax < 0;
      const lo = Math.abs(healing ? vm.amountMax : vm.amountMin);
      const hi = Math.abs(healing ? vm.amountMin : vm.amountMax);
      const band = div(`et-target__amount${healing ? ' is-heal' : ''}`);
      const value = div('et-target__amount-value');
      value.appendChild(el('span', 'et-target__amount-num', lo === hi ? String(hi) : `${lo}–${hi}`));
      if (vm.element && vm.element !== 'none') {
        const crest = div('et-target__element');
        crest.style.color = elementColor(vm.element);
        crest.appendChild(icon(elementIcon(vm.element)));
        value.appendChild(crest);
      }
      add(band, el('span', 'et-target__amount-label', healing ? 'Restores' : 'Damage'), value);
      this.body.appendChild(band);
    }

    // ── resulting HP ────────────────────────────────────────────────────────
    const hpRow = div('et-target__hp');
    const track = div('et-target__hp-track');
    const maxHp = Math.max(1, vm.targetMaxHp);
    const resultLow = vm.resultHpMin ?? vm.targetHp;
    const resultHigh = vm.resultHpMax ?? vm.targetHp;
    const worst = Math.max(0, Math.min(resultLow, resultHigh));
    const best = Math.max(0, Math.max(resultLow, resultHigh));
    const safe = div('et-target__hp-safe');
    safe.style.width = `${(Math.min(worst, vm.targetHp) / maxHp) * 100}%`;
    const risk = div('et-target__hp-risk');
    const riskStart = Math.min(worst, vm.targetHp, best);
    const riskEnd = Math.max(vm.targetHp, best);
    risk.style.left = `${(riskStart / maxHp) * 100}%`;
    risk.style.width = `${(Math.max(0, Math.min(riskEnd, maxHp) - riskStart) / maxHp) * 100}%`;
    risk.classList.toggle('is-heal', best > vm.targetHp);
    add(track, safe, risk);
    const hpText = div('et-target__hp-text');
    add(
      hpText,
      el('span', 'et-target__hp-label', 'HP'),
      el(
        'span',
        'et-target__hp-value',
        worst === best
          ? `${vm.targetHp} → ${worst} / ${vm.targetMaxHp}`
          : `${vm.targetHp} → ${worst}–${best} / ${vm.targetMaxHp}`,
      ),
    );
    if (worst <= 0) hpText.appendChild(el('span', 'et-target__lethal', 'Lethal'));
    add(hpRow, hpText, track);
    this.body.appendChild(hpRow);

    // ── statuses ────────────────────────────────────────────────────────────
    if (vm.statusChances && vm.statusChances.length > 0) {
      this.body.appendChild(divider());
      const list = div('et-target__statuses');
      for (const s of vm.statusChances) {
        const pip = div(`et-target__status${s.cures ? ' is-cure' : ''}`);
        add(
          pip,
          el('span', 'et-target__status-name', `${s.cures ? 'Cures ' : ''}${s.name}`),
          el('span', 'et-target__status-chance', `${Math.round(s.chance)}%`),
        );
        list.appendChild(pip);
      }
      this.body.appendChild(list);
    }

    // ── accuracy breakdown ──────────────────────────────────────────────────
    if (vm.breakdown && vm.breakdown.length > 0) {
      const table = div('et-target__breakdown');
      for (const b of vm.breakdown) {
        const r = div('et-stat');
        add(r, el('span', 'et-stat__label', b.label), el('span', 'et-stat__value', b.value));
        table.appendChild(r);
      }
      this.body.appendChild(table);
    }

    if (vm.warning) this.body.appendChild(el('p', 'et-target__warning', vm.warning));

    this.setVisible(true);
  }

  /** Compass rosette: the attacked side is lit, the other three sit dark. */
  private buildRosette(relative: 'front' | 'side' | 'back'): HTMLDivElement {
    const wrap = div(`et-rosette is-${relative}`);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 56 56');
    svg.setAttribute('aria-hidden', 'true');
    // Four wedges around a centre; the target faces up (toward "front").
    const wedges: { key: string; d: string }[] = [
      { key: 'front', d: 'M28 6 L44 20 L28 24 L12 20 Z' },
      { key: 'side', d: 'M50 28 L36 44 L32 28 L36 12 Z' },
      { key: 'back', d: 'M28 50 L12 36 L28 32 L44 36 Z' },
      { key: 'side2', d: 'M6 28 L20 12 L24 28 L20 44 Z' },
    ];
    for (const w of wedges) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', w.d);
      const isLit = w.key === relative || (relative === 'side' && w.key === 'side2');
      p.setAttribute('class', `et-rosette__wedge${isLit ? ' is-lit' : ''}`);
      svg.appendChild(p);
    }
    const core = document.createElementNS(SVG_NS, 'circle');
    core.setAttribute('cx', '28');
    core.setAttribute('cy', '28');
    core.setAttribute('r', '4.5');
    core.setAttribute('class', 'et-rosette__core');
    svg.appendChild(core);
    wrap.appendChild(svg);
    wrap.appendChild(
      el('span', 'et-rosette__label', relative === 'front' ? 'Front' : relative === 'side' ? 'Side' : 'Back'),
    );
    return wrap;
  }
}

function buildArc(): { wrap: HTMLDivElement; circle: SVGCircleElement; label: HTMLSpanElement } {
  const wrap = div('et-arc');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('aria-hidden', 'true');
  const mk = (cls: string): SVGCircleElement => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '32');
    c.setAttribute('cy', '32');
    c.setAttribute('r', String(ARC_RADIUS));
    c.setAttribute('class', cls);
    return c;
  };
  const bg = mk('et-arc__bg');
  const value = mk('et-arc__value');
  value.style.strokeDasharray = `${ARC_LENGTH} ${ARC_LENGTH}`;
  value.style.strokeDashoffset = String(ARC_LENGTH);
  svg.appendChild(bg);
  svg.appendChild(value);
  const label = el('span', 'et-arc__label', '0');
  const pct = el('span', 'et-arc__pct', '%');
  const centre = div('et-arc__centre');
  add(centre, label, pct);
  add(wrap, svg, centre);
  return { wrap, circle: value, label };
}
