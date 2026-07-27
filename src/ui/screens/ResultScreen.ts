/**
 * Battle result screen.
 *
 * Rows reveal one at a time, EXP and JP count up, level-ups punch in with a
 * chime, then loot and gil settle at the bottom. Confirm once to skip the
 * sequence to its end; confirm again to dismiss.
 */

import { countTo, delay, type TweenHandle } from '../anim';
import { play } from '../audio';
import { add, div, el, reflow } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import { portrait } from '../portraits';
import type { ResultScreenVM, ResultUnitVM, UIIntent } from '../types';
import { divider, Panel } from '../components/Panel';
import { Screen } from './Screen';

interface RowRefs {
  root: HTMLDivElement;
  exp: HTMLSpanElement;
  jp: HTMLSpanElement;
  levelBadge: HTMLDivElement;
  vm: ResultUnitVM;
}

export class ResultScreen extends Screen {
  readonly name = 'result-screen';

  private readonly awardPanel: Panel;
  private readonly rowsBox: HTMLDivElement;
  private readonly lootPanel: Panel;
  private readonly lootBox: HTMLDivElement;
  private readonly crest: HTMLDivElement;
  private rows: RowRefs[] = [];
  private tweens: TweenHandle[] = [];
  private sequencing = false;
  private sequenceToken = 0;

  constructor(private readonly emit: (i: UIIntent) => void) {
    super({ title: 'Battle Report', className: 'et-result', closable: false });

    this.crest = div('et-result__crest');
    this.awardPanel = new Panel({ title: 'Spoils of the Field', className: 'et-result__awards', from: 'bottom' });
    this.rowsBox = div('et-result__rows');
    this.awardPanel.body.appendChild(this.rowsBox);

    this.lootPanel = new Panel({ tone: 'parchment', className: 'et-result__loot', from: 'bottom' });
    this.lootBox = div('et-result__loot-body');
    this.lootPanel.body.appendChild(this.lootBox);

    const hint = el('span', 'et-result__hint', 'Enter — continue');
    add(this.awardPanel.footer(), hint);

    add(this.content, this.crest, this.awardPanel.root, this.lootPanel.root);
    this.awardPanel.root.classList.add('et-entered');
    this.lootPanel.root.classList.add('et-entered');
  }

  set(vm: ResultScreenVM): void {
    this.cancelTweens();
    this.sequenceToken++;
    this.setHeading(vm.title, vm.subtitle);
    this.root.dataset['outcome'] = vm.outcome;
    this.crest.replaceChildren();
    add(
      this.crest,
      icon(vm.outcome === 'victory' ? 'crown' : 'ko', 'et-result__crest-icon'),
      el('span', 'et-result__crest-text', vm.outcome === 'victory' ? 'Victory' : 'Defeat'),
    );
    if (vm.turns !== undefined) {
      this.crest.appendChild(el('span', 'et-result__turns', `${vm.turns} turns`));
    }

    this.rowsBox.replaceChildren();
    this.rows = vm.units.map((u) => this.buildRow(u));
    for (const r of this.rows) this.rowsBox.appendChild(r.root);

    this.lootBox.replaceChildren();
    if (vm.loot && vm.loot.length > 0) {
      this.lootBox.appendChild(el('h3', 'et-result__loot-title', 'Recovered'));
      const list = div('et-result__loot-list');
      for (const l of vm.loot) {
        const item = div(`et-loot et-loot--${l.rarity ?? 'common'}`);
        add(item, icon('item', 'et-loot__icon'), el('span', 'et-loot__name', l.name));
        if (l.count > 1) item.appendChild(el('span', 'et-loot__count', `×${l.count}`));
        list.appendChild(item);
      }
      this.lootBox.appendChild(list);
    }
    if (vm.gil !== undefined) {
      this.lootBox.appendChild(divider());
      const gil = div('et-result__gil');
      const value = el('span', 'et-result__gil-value', '0');
      add(gil, icon('gil', 'et-result__gil-icon'), value, el('span', 'et-result__gil-label', 'gil'));
      this.lootBox.appendChild(gil);
      this.gilNode = value;
      this.gilTotal = vm.gil;
    } else {
      this.gilNode = null;
      this.gilTotal = 0;
    }
    this.lootPanel.root.classList.toggle('is-hidden', this.lootBox.childElementCount === 0);

    void this.runSequence(this.sequenceToken);
  }

  private gilNode: HTMLSpanElement | null = null;
  private gilTotal = 0;

  private buildRow(u: ResultUnitVM): RowRefs {
    const root = div('et-resultrow');
    if (u.incapacitated) root.classList.add('is-down');
    root.appendChild(portrait(u.portrait, { size: 'sm', className: 'et-resultrow__face' }));

    const ident = div('et-resultrow__ident');
    add(ident, el('span', 'et-resultrow__name', u.name), el('span', 'et-resultrow__job', u.job));
    root.appendChild(ident);

    const exp = el('span', 'et-award__value', '0');
    const jp = el('span', 'et-award__value', '0');
    add(root, award('EXP', exp, 'exp'), award('JP', jp, 'jp'));

    const levelBadge = div('et-resultrow__level');
    levelBadge.textContent = `Lv ${u.levelBefore}`;
    root.appendChild(levelBadge);

    if (u.learned && u.learned.length > 0) {
      root.appendChild(el('span', 'et-resultrow__learned', `Learned ${u.learned.join(', ')}`));
    }
    return { root, exp, jp, levelBadge, vm: u };
  }

  private async runSequence(token: number): Promise<void> {
    this.sequencing = true;
    for (const row of this.rows) {
      if (token !== this.sequenceToken) return;
      row.root.classList.add('is-in');
      play('page');
      await delay(120);
      if (token !== this.sequenceToken) return;
      this.tweens.push(countTo(row.exp, 0, row.vm.expGained, { duration: 520 }));
      this.tweens.push(countTo(row.jp, 0, row.vm.jpGained, { duration: 520 }));
      await delay(420);
      if (token !== this.sequenceToken) return;
      if (row.vm.levelAfter > row.vm.levelBefore) {
        row.levelBadge.textContent = `Lv ${row.vm.levelAfter}`;
        row.levelBadge.classList.add('is-up');
        row.root.classList.add('is-levelup');
        play('levelup');
        await delay(360);
      } else if (row.vm.jobLevelAfter > row.vm.jobLevelBefore) {
        row.levelBadge.textContent = `Job Lv ${row.vm.jobLevelAfter}`;
        row.levelBadge.classList.add('is-up');
        play('award');
        await delay(240);
      }
    }
    if (token !== this.sequenceToken) return;
    if (this.gilNode) {
      play('award');
      this.tweens.push(
        countTo(this.gilNode, 0, this.gilTotal, {
          duration: 700,
          format: (v) => Math.round(v).toLocaleString(),
        }),
      );
      await delay(700);
    }
    this.sequencing = false;
  }

  /** Jump the whole reveal to its end state. */
  private finishSequence(): void {
    this.sequenceToken++;
    for (const t of this.tweens) t.finish();
    this.tweens = [];
    for (const row of this.rows) {
      row.root.classList.add('is-in');
      row.exp.textContent = String(row.vm.expGained);
      row.jp.textContent = String(row.vm.jpGained);
      if (row.vm.levelAfter > row.vm.levelBefore) {
        row.levelBadge.textContent = `Lv ${row.vm.levelAfter}`;
        row.levelBadge.classList.add('is-up');
      } else if (row.vm.jobLevelAfter > row.vm.jobLevelBefore) {
        row.levelBadge.textContent = `Job Lv ${row.vm.jobLevelAfter}`;
        row.levelBadge.classList.add('is-up');
      }
    }
    if (this.gilNode) this.gilNode.textContent = this.gilTotal.toLocaleString();
    this.sequencing = false;
  }

  private cancelTweens(): void {
    for (const t of this.tweens) t.cancel();
    this.tweens = [];
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'confirm' || key === 'cancel') {
      if (this.sequencing) {
        this.finishSequence();
        play('confirm');
        return true;
      }
      play('confirm');
      this.emit({ kind: 'result-dismiss' });
      return true;
    }
    return false;
  }
}

function award(label: string, valueNode: HTMLSpanElement, iconName: string): HTMLDivElement {
  const a = div(`et-award et-award--${iconName}`);
  add(a, icon(iconName, 'et-award__icon'), valueNode, el('span', 'et-award__label', label));
  return a;
}
