/**
 * Job & abilities screen.
 *
 * Left pane  — the job tree: tiers laid out in columns, prerequisite tracery drawn
 *              in gold behind the nodes, locked jobs engraved rather than lit.
 * Right pane — the highlighted job's detail, its learnable list with JP costs and
 *              learned state, and the four ability slot assignments.
 *
 * Panes are cycled with Tab; within the tree the arrow keys walk tiers and rows.
 */

import { play } from '../audio';
import { add, clamp, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import { portrait } from '../portraits';
import type { AbilitySlotVM, JobNodeVM, JobScreenVM, LearnableVM, UIIntent } from '../types';
import { MenuList } from '../components/MenuList';
import { Meter } from '../components/Meter';
import { divider, Panel } from '../components/Panel';
import { Screen } from './Screen';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Pane = 'tree' | 'learn' | 'slots';

export class JobScreen extends Screen {
  readonly name = 'job-screen';

  private readonly treePanel: Panel;
  private readonly treeInner: HTMLDivElement;
  private readonly linkLayer: SVGSVGElement;
  private readonly detailPanel: Panel;
  private readonly detailBody: HTMLDivElement;
  private readonly learnPanel: Panel;
  private readonly learnList: MenuList<LearnableVM>;
  private readonly slotPanel: Panel;
  private readonly slotList: MenuList<AbilitySlotVM>;
  private readonly jpMeter: Meter;

  private vm: JobScreenVM | null = null;
  private nodes: JobNodeVM[] = [];
  private nodeEls = new Map<string, HTMLDivElement>();
  private cursor = 0;
  private treeSignature = '';
  private pane: Pane = 'tree';
  private slotChoice = new Map<string, number>();

  constructor(private readonly emit: (i: UIIntent) => void) {
    super({ title: 'Jobs & Abilities', className: 'et-jobscreen' });

    this.treePanel = new Panel({ title: 'Job Tree', className: 'et-jobtree-panel', from: 'left' });
    this.treeInner = div('et-jobtree');
    this.linkLayer = document.createElementNS(SVG_NS, 'svg');
    this.linkLayer.classList.add('et-jobtree__links');
    this.treeInner.appendChild(this.linkLayer);
    this.treePanel.body.appendChild(this.treeInner);

    this.detailPanel = new Panel({ tone: 'parchment', className: 'et-jobdetail', from: 'right' });
    this.detailBody = div('et-jobdetail__body');
    this.jpMeter = new Meter({ tone: 'jp', label: 'Job Level', compact: true });
    add(this.detailPanel.body, this.detailBody, this.jpMeter.root);

    this.learnPanel = new Panel({ title: 'Abilities', className: 'et-joblearn', from: 'right' });
    this.learnList = new MenuList<LearnableVM>({
      className: 'et-joblearn__list',
      enabled: (a) => !a.learned && a.affordable,
      render: (a, row) => {
        row.classList.add('et-learn-row');
        if (a.learned) row.classList.add('is-learned');
        row.appendChild(icon(a.learned ? 'check' : a.affordable ? 'jp' : 'lock', 'et-learn-row__mark'));
        const main = div('et-learn-row__main');
        add(main, el('span', 'et-learn-row__name', a.name), el('span', 'et-learn-row__desc', a.description));
        row.appendChild(main);
        row.appendChild(el('span', 'et-learn-row__slot', slotLabel(a.slot)));
        row.appendChild(el('span', 'et-learn-row__jp', a.learned ? 'Learned' : `${a.jp} JP`));
      },
      onConfirm: (a) => {
        const vm = this.vm;
        if (!vm) return;
        this.emit({ kind: 'learn-ability', unitId: vm.unit.id, jobId: vm.selectedJob, abilityId: a.id });
      },
    });
    this.learnPanel.body.appendChild(this.learnList.root);

    this.slotPanel = new Panel({ title: 'Loadout', className: 'et-jobslots', from: 'right' });
    this.slotList = new MenuList<AbilitySlotVM>({
      className: 'et-jobslots__list',
      render: (s, row) => {
        row.classList.add('et-slot-row');
        add(
          row,
          el('span', 'et-slot-row__label', s.label),
          el('span', 'et-slot-row__value', s.assignedName ?? '— empty —'),
        );
        if (s.options.length > 0) row.appendChild(icon('chevron', 'et-slot-row__chevron'));
      },
      onConfirm: (s) => this.cycleSlot(s, 1),
    });
    this.slotPanel.body.appendChild(this.slotList.root);

    const left = div('et-jobscreen__left');
    left.appendChild(this.treePanel.root);
    const right = div('et-jobscreen__right');
    add(right, this.detailPanel.root, this.learnPanel.root, this.slotPanel.root);
    add(this.content, left, right);
    for (const p of [this.treePanel, this.detailPanel, this.learnPanel, this.slotPanel]) {
      p.root.classList.add('et-entered');
    }
  }

  set(vm: JobScreenVM): void {
    this.vm = vm;
    this.setHeading(`${vm.unit.name}`, `${vm.unit.job} · Level ${vm.unit.level}`);
    this.nodes = [...vm.jobs].sort((a, b) => (a.tier - b.tier) || a.name.localeCompare(b.name));
    const idx = this.nodes.findIndex((n) => n.id === vm.selectedJob);
    this.cursor = idx >= 0 ? idx : 0;
    // Only rebuild the tree DOM when its shape actually changed; cursor moves
    // resend the view-model every keystroke and must not thrash the layout.
    const sig = this.nodes
      .map((n) => `${n.id}:${n.tier}:${n.jobLevel}:${n.unlocked ? 1 : 0}:${n.current ? 1 : 0}:${n.learned}`)
      .join('|');
    if (sig !== this.treeSignature) {
      this.treeSignature = sig;
      this.buildTree();
    } else {
      this.syncCursor(false);
    }
    this.learnList.setItems(vm.learnables, false);
    this.slotList.setItems(vm.slots, true);
    this.renderDetail();
    this.applyPane();
  }

  private buildTree(): void {
    const tiers = new Map<number, JobNodeVM[]>();
    for (const n of this.nodes) {
      const list = tiers.get(n.tier);
      if (list) list.push(n);
      else tiers.set(n.tier, [n]);
    }
    this.nodeEls.clear();
    // Rebuild everything except the persistent link layer.
    for (const child of Array.from(this.treeInner.children)) {
      if (child !== this.linkLayer) child.remove();
    }
    const columns = div('et-jobtree__columns');
    for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
      const col = div('et-jobtree__column');
      col.appendChild(el('span', 'et-jobtree__tier', tierLabel(tier)));
      for (const node of tiers.get(tier) ?? []) {
        const nodeEl = this.buildNode(node);
        this.nodeEls.set(node.id, nodeEl);
        col.appendChild(nodeEl);
      }
      columns.appendChild(col);
    }
    this.treeInner.appendChild(columns);
    requestAnimationFrame(() => {
      this.drawLinks();
      this.syncCursor(false);
    });
  }

  private buildNode(node: JobNodeVM): HTMLDivElement {
    const nodeEl = div(`et-jobnode et-jobnode--${node.origin}`);
    nodeEl.classList.toggle('is-locked', !node.unlocked);
    nodeEl.classList.toggle('is-current', node.current);
    const crest = div('et-jobnode__crest');
    crest.appendChild(icon(node.unlocked ? 'job' : 'lock'));
    const main = div('et-jobnode__main');
    add(main, el('span', 'et-jobnode__name', node.name), el('span', 'et-jobnode__blurb', node.blurb));
    const pips = div('et-jobnode__pips');
    for (let i = 0; i < 8; i++) {
      const pip = div('et-jobnode__pip');
      if (i < node.jobLevel) pip.classList.add('is-on');
      pips.appendChild(pip);
    }
    main.appendChild(pips);
    add(nodeEl, crest, main, el('span', 'et-jobnode__origin', node.origin.toUpperCase()));

    nodeEl.addEventListener('mouseenter', () => {
      const i = this.nodes.findIndex((n) => n.id === node.id);
      if (i >= 0) this.moveCursor(i, true);
    });
    nodeEl.addEventListener('click', () => {
      const i = this.nodes.findIndex((n) => n.id === node.id);
      if (i >= 0) {
        this.pane = 'tree';
        this.applyPane();
        this.moveCursor(i, true);
        this.confirmJob();
      }
    });
    return nodeEl;
  }

  /** Draw prerequisite tracery between node edges, in tree-local coordinates. */
  private drawLinks(): void {
    const box = this.treeInner.getBoundingClientRect();
    this.linkLayer.setAttribute('viewBox', `0 0 ${box.width} ${this.treeInner.scrollHeight}`);
    this.linkLayer.setAttribute('width', String(box.width));
    this.linkLayer.setAttribute('height', String(this.treeInner.scrollHeight));
    this.linkLayer.replaceChildren();
    for (const node of this.nodes) {
      const child = this.nodeEls.get(node.id);
      if (!child) continue;
      for (const parentId of node.parents) {
        const parent = this.nodeEls.get(parentId);
        if (!parent) continue;
        const a = parent.getBoundingClientRect();
        const b = child.getBoundingClientRect();
        const x1 = a.right - box.left;
        const y1 = a.top + a.height / 2 - box.top + this.treeInner.scrollTop;
        const x2 = b.left - box.left;
        const y2 = b.top + b.height / 2 - box.top + this.treeInner.scrollTop;
        const mid = x1 + (x2 - x1) / 2;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
        path.setAttribute('class', `et-jobtree__link${node.unlocked ? ' is-open' : ''}`);
        this.linkLayer.appendChild(path);
      }
    }
  }

  private moveCursor(index: number, silent = false): void {
    const next = clamp(index, 0, Math.max(0, this.nodes.length - 1));
    if (next === this.cursor) return;
    this.cursor = next;
    if (!silent) play('cursor');
    this.syncCursor(true);
    this.renderDetail();
    const vm = this.vm;
    const node = this.nodes[this.cursor];
    if (vm && node && node.id !== vm.selectedJob) {
      this.vm = { ...vm, selectedJob: node.id };
      // The game layer answers with a fresh `learnables` list via set().
      this.emit({ kind: 'inspect-job', unitId: vm.unit.id, jobId: node.id });
    }
  }

  private syncCursor(scroll: boolean): void {
    this.nodeEls.forEach((elm) => elm.classList.remove('is-active'));
    const node = this.nodes[this.cursor];
    if (!node) return;
    const nodeEl = this.nodeEls.get(node.id);
    if (!nodeEl) return;
    nodeEl.classList.add('is-active');
    if (scroll) nodeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  private renderDetail(): void {
    const node = this.nodes[this.cursor];
    const vm = this.vm;
    this.detailBody.replaceChildren();
    if (!node || !vm) return;
    const head = div('et-jobdetail__head');
    head.appendChild(portrait(vm.unit.portrait, { size: 'md' }));
    const ident = div('et-jobdetail__ident');
    add(
      ident,
      el('h3', 'et-jobdetail__name', node.name),
      el('span', 'et-jobdetail__origin', originLabel(node.origin)),
    );
    add(head, ident);
    this.detailBody.appendChild(head);
    this.detailBody.appendChild(el('p', 'et-jobdetail__blurb', node.blurb));
    this.detailBody.appendChild(divider());
    const facts = div('et-jobdetail__facts');
    add(
      facts,
      fact('Job Level', String(node.jobLevel)),
      fact('JP', String(node.jp)),
      fact('Total JP', String(node.totalJp)),
      fact('Learned', `${node.learned} / ${node.learnable}`),
    );
    this.detailBody.appendChild(facts);
    if (!node.unlocked && node.requirement) {
      this.detailBody.appendChild(el('p', 'et-jobdetail__locked', `Requires ${node.requirement}`));
    } else if (node.current) {
      this.detailBody.appendChild(el('p', 'et-jobdetail__current', 'Currently equipped'));
    } else {
      this.detailBody.appendChild(el('p', 'et-jobdetail__hint', 'Press Enter to take this job.'));
    }
    // Job level meter: FFT job levels advance on total JP in 100-point strides.
    this.jpMeter.set(node.totalJp % 1000, 1000, false);
  }

  private confirmJob(): void {
    const node = this.nodes[this.cursor];
    const vm = this.vm;
    if (!node || !vm) return;
    if (!node.unlocked) {
      play('error');
      this.treePanel.shake();
      return;
    }
    play('confirm');
    this.emit({ kind: 'set-job', unitId: vm.unit.id, jobId: node.id });
  }

  private cycleSlot(slot: AbilitySlotVM, dir: number): void {
    const vm = this.vm;
    if (!vm) return;
    if (slot.options.length === 0) {
      play('error');
      return;
    }
    // Options plus a virtual "empty" entry at index -1.
    const span = slot.options.length + 1;
    const cur = this.slotChoice.get(slot.slot) ?? (slot.assignedId
      ? slot.options.findIndex((o) => o.id === slot.assignedId)
      : -1);
    const nextRaw = ((cur + 1 + dir) % span + span) % span;
    const next = nextRaw - 1;
    this.slotChoice.set(slot.slot, next);
    const chosen = next >= 0 ? slot.options[next] : undefined;
    play('cursor');
    this.emit({
      kind: 'assign-slot',
      unitId: vm.unit.id,
      slot: slot.slot,
      abilityId: chosen?.id ?? null,
    });
  }

  private applyPane(): void {
    this.treePanel.root.classList.toggle('is-focused', this.pane === 'tree');
    this.learnPanel.root.classList.toggle('is-focused', this.pane === 'learn');
    this.slotPanel.root.classList.toggle('is-focused', this.pane === 'slots');
    this.learnList.onFocusChange(this.pane === 'learn');
    this.slotList.onFocusChange(this.pane === 'slots');
  }

  private cyclePane(dir: number): void {
    const order: Pane[] = ['tree', 'learn', 'slots'];
    const i = order.indexOf(this.pane);
    const next = order[(i + dir + order.length) % order.length];
    if (next) this.pane = next;
    play('page');
    this.applyPane();
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'next') {
      this.cyclePane(1);
      return true;
    }
    if (key === 'prev') {
      this.cyclePane(-1);
      return true;
    }
    if (this.pane === 'learn') {
      if (key === 'left') {
        this.pane = 'tree';
        this.applyPane();
        return true;
      }
      return this.learnList.onKey(key);
    }
    if (this.pane === 'slots') {
      if (key === 'left') {
        this.pane = 'tree';
        this.applyPane();
        return true;
      }
      if (key === 'right') {
        const s = this.slotList.selected;
        if (s) this.cycleSlot(s, 1);
        return true;
      }
      return this.slotList.onKey(key);
    }
    // Tree pane.
    switch (key) {
      case 'up':
        this.moveCursor(this.neighbour(-1));
        return true;
      case 'down':
        this.moveCursor(this.neighbour(1));
        return true;
      case 'left':
        this.moveCursor(this.tierStep(-1));
        return true;
      case 'right': {
        const stepped = this.tierStep(1);
        if (stepped === this.cursor) {
          this.pane = 'learn';
          this.applyPane();
        } else this.moveCursor(stepped);
        return true;
      }
      case 'confirm':
        this.confirmJob();
        return true;
      default:
        return false;
    }
  }

  /** Next/previous node inside the same tier column. */
  private neighbour(dir: number): number {
    const cur = this.nodes[this.cursor];
    if (!cur) return this.cursor;
    const sameTier = this.nodes
      .map((n, i) => ({ n, i }))
      .filter((e) => e.n.tier === cur.tier);
    const pos = sameTier.findIndex((e) => e.i === this.cursor);
    const target = sameTier[clamp(pos + dir, 0, sameTier.length - 1)];
    return target ? target.i : this.cursor;
  }

  /** Move one tier column left/right, keeping the closest row position. */
  private tierStep(dir: number): number {
    const cur = this.nodes[this.cursor];
    if (!cur) return this.cursor;
    const tiers = [...new Set(this.nodes.map((n) => n.tier))].sort((a, b) => a - b);
    const ti = tiers.indexOf(cur.tier);
    const nextTier = tiers[clamp(ti + dir, 0, tiers.length - 1)];
    if (nextTier === undefined || nextTier === cur.tier) return this.cursor;
    const sameTier = this.nodes.map((n, i) => ({ n, i })).filter((e) => e.n.tier === cur.tier);
    const row = sameTier.findIndex((e) => e.i === this.cursor);
    const targetTier = this.nodes.map((n, i) => ({ n, i })).filter((e) => e.n.tier === nextTier);
    const target = targetTier[clamp(row, 0, targetTier.length - 1)];
    return target ? target.i : this.cursor;
  }
}

function fact(label: string, value: string): HTMLDivElement {
  const f = div('et-fact');
  add(f, el('span', 'et-fact__label', label), el('span', 'et-fact__value', value));
  return f;
}

function slotLabel(slot: LearnableVM['slot']): string {
  switch (slot) {
    case 'action': return 'Action';
    case 'reaction': return 'Reaction';
    case 'support': return 'Support';
    default: return 'Movement';
  }
}

function tierLabel(tier: number): string {
  return tier === 0 ? 'Base' : `Tier ${tier}`;
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'fft': return 'Ivalice';
    case 'eq2': return 'Norrath';
    case 'wow': return 'Azeroth';
    default: return 'Original';
  }
}
