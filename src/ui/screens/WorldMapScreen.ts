/**
 * World map — campaign destinations, progression state, and between-battle tools.
 *
 * The screen receives plain data and emits intents. It has no campaign or battle
 * reference, so all travel and progression decisions remain in the game layer.
 */

import { play } from '../audio';
import { add, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import type { UIIntent, WorldMapScreenVM, WorldNodeVM } from '../types';
import { Panel } from '../components/Panel';
import { Screen } from './Screen';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class WorldMapScreen extends Screen {
  readonly name = 'world-map-screen';

  private readonly mapPanel: Panel;
  private readonly map: HTMLDivElement;
  private readonly links: SVGSVGElement;
  private readonly nodesLayer: HTMLDivElement;
  private readonly objectivePanel: Panel;
  private readonly objectiveBody: HTMLDivElement;
  private readonly funds: HTMLSpanElement;

  private vm: WorldMapScreenVM | null = null;
  private nodeEls: HTMLButtonElement[] = [];
  private cursor = 0;

  constructor(private readonly emit: (intent: UIIntent) => void) {
    super({ title: 'World Map', className: 'et-worldmap' });

    this.funds = el('span', 'et-worldmap__funds');
    this.rail().appendChild(this.funds);

    this.mapPanel = new Panel({
      title: 'Ivalice',
      className: 'et-worldmap__map-panel',
      from: 'left',
    });
    this.map = div('et-worldmap__map');
    this.links = document.createElementNS(SVG_NS, 'svg');
    this.links.classList.add('et-worldmap__links');
    this.nodesLayer = div('et-worldmap__nodes');
    add(this.map, this.links, this.nodesLayer);
    this.mapPanel.body.appendChild(this.map);

    this.objectivePanel = new Panel({
      tone: 'parchment',
      title: 'Campaign',
      className: 'et-worldmap__objective-panel',
      from: 'right',
    });
    this.objectiveBody = div('et-worldmap__objective');
    this.objectivePanel.body.appendChild(this.objectiveBody);

    const actions = div('et-worldmap__actions');
    const jobs = el('button', 'et-worldmap__action', 'Jobs & Abilities');
    jobs.type = 'button';
    jobs.appendChild(icon('job'));
    jobs.addEventListener('click', () => {
      play('confirm');
      this.emit({ kind: 'world-open-jobs' });
    });
    const roster = el('button', 'et-worldmap__action', 'Company Roster');
    roster.type = 'button';
    roster.appendChild(icon('banner'));
    roster.addEventListener('click', () => {
      play('confirm');
      this.emit({ kind: 'world-open-roster' });
    });
    add(actions, jobs, roster);
    this.objectivePanel.body.appendChild(actions);

    add(this.content, this.mapPanel.root, this.objectivePanel.root);
    this.mapPanel.root.classList.add('et-entered');
    this.objectivePanel.root.classList.add('et-entered');
  }

  set(vm: WorldMapScreenVM): void {
    this.vm = vm;
    this.setHeading(vm.title, vm.subtitle);
    this.funds.replaceChildren(icon('gil'), document.createTextNode(`${vm.gil} gil`));
    this.renderMap();
    this.renderObjective();
  }

  private renderMap(): void {
    const vm = this.vm;
    this.nodesLayer.replaceChildren();
    this.links.replaceChildren();
    this.nodeEls = [];
    if (!vm) return;

    const byId = new Map(vm.nodes.map((node) => [node.id, node]));
    for (const node of vm.nodes) {
      for (const required of node.requires) {
        const from = byId.get(required);
        if (!from) continue;
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', `${from.position.x * 100}%`);
        line.setAttribute('y1', `${from.position.y * 100}%`);
        line.setAttribute('x2', `${node.position.x * 100}%`);
        line.setAttribute('y2', `${node.position.y * 100}%`);
        line.classList.toggle(
          'is-open',
          from.state === 'completed' && node.state !== 'locked',
        );
        this.links.appendChild(line);
      }
    }

    vm.nodes.forEach((node, index) => {
      const button = el('button', `et-worldnode is-${node.state}`);
      button.type = 'button';
      button.style.left = `${node.position.x * 100}%`;
      button.style.top = `${node.position.y * 100}%`;
      button.dataset['nodeId'] = node.id;
      button.setAttribute('aria-label', `${node.name}, ${node.state}`);
      const marker = div('et-worldnode__marker');
      marker.appendChild(icon(this.iconFor(node)));
      const text = div('et-worldnode__text');
      add(
        text,
        el('span', 'et-worldnode__name', node.name),
        el('span', 'et-worldnode__state', `${node.kind} · ${node.state}`),
      );
      add(button, marker, text);
      button.addEventListener('mouseenter', () => this.moveCursor(index));
      button.addEventListener('click', () => {
        this.moveCursor(index);
        this.confirm();
      });
      this.nodesLayer.appendChild(button);
      this.nodeEls.push(button);
    });

    const firstAvailable = vm.nodes.findIndex((node) => node.state === 'available');
    this.cursor = firstAvailable >= 0 ? firstAvailable : 0;
    this.syncCursor();
  }

  private iconFor(node: WorldNodeVM): string {
    if (node.state === 'locked') return 'lock';
    if (node.state === 'completed') return 'check';
    if (node.kind === 'battle') return 'sword';
    if (node.kind === 'town') return 'banner';
    return 'crown';
  }

  private renderObjective(): void {
    const objective = this.vm?.objective;
    this.objectiveBody.replaceChildren();
    if (!objective) {
      add(
        this.objectiveBody,
        el('span', 'et-worldmap__eyebrow', 'Campaign complete'),
        el('h2', 'et-worldmap__objective-name', 'Ivalice remembers'),
        el('p', 'et-worldmap__objective-copy', 'Every destination in the v0.1 arc is complete.'),
      );
      return;
    }
    add(
      this.objectiveBody,
      el('span', 'et-worldmap__eyebrow', `Chapter ${objective.chapter} objective`),
      el('h2', 'et-worldmap__objective-name', objective.name),
      el(
        'p',
        'et-worldmap__objective-copy',
        objective.kind === 'battle'
          ? 'Choose this destination, arrange the formation, and deploy.'
          : 'Travel here to advance the company along the campaign route.',
      ),
    );

    const legend = div('et-worldmap__legend');
    for (const state of ['available', 'completed', 'locked'] as const) {
      const row = div(`et-worldmap__legend-row is-${state}`);
      add(row, div('et-worldmap__legend-dot'), el('span', '', state));
      legend.appendChild(row);
    }
    this.objectiveBody.appendChild(legend);
  }

  private moveCursor(index: number): void {
    const count = this.vm?.nodes.length ?? 0;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    if (next !== this.cursor) play('cursor');
    this.cursor = next;
    this.syncCursor();
  }

  private syncCursor(): void {
    this.nodeEls.forEach((node, index) => {
      node.classList.toggle('is-active', index === this.cursor);
    });
  }

  private confirm(): void {
    const node = this.vm?.nodes[this.cursor];
    const canVisit =
      node?.state === 'available' ||
      (node?.kind === 'town' && node.state === 'completed');
    if (!node || !canVisit) {
      play('error');
      this.mapPanel.shake();
      return;
    }
    play('confirm');
    this.emit({ kind: 'world-node-select', nodeId: node.id });
  }

  protected handleKey(key: UIKey): boolean {
    switch (key) {
      case 'left':
      case 'up':
        this.moveCursor(this.cursor - 1);
        return true;
      case 'right':
      case 'down':
        this.moveCursor(this.cursor + 1);
        return true;
      case 'home':
        this.moveCursor(0);
        return true;
      case 'end':
        this.moveCursor((this.vm?.nodes.length ?? 1) - 1);
        return true;
      case 'confirm':
        this.confirm();
        return true;
      default:
        return false;
    }
  }
}
