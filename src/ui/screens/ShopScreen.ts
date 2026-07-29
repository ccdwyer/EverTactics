/**
 * Town shop — plain view model in, purchase and sale intents out.
 *
 * This screen never reads campaign state or item tables. Affordability, stock,
 * prices, and ownership are already resolved by the state-layer view model.
 */

import { play } from '../audio';
import { MenuList } from '../components/MenuList';
import { Panel } from '../components/Panel';
import { add, div, el } from '../dom';
import { icon } from '../icons';
import type { UIKey } from '../input';
import type {
  ShopInventoryItemVM,
  ShopScreenVM,
  ShopStockItemVM,
  UIIntent,
} from '../types';
import { Screen } from './Screen';
import { shopPaneTransition, type ShopPane } from './shopNavigation';

export class ShopScreen extends Screen {
  readonly name = 'shop-screen';

  private readonly funds: HTMLSpanElement;
  private readonly stockPanel: Panel;
  private readonly inventoryPanel: Panel;
  private readonly stockList: MenuList<ShopStockItemVM>;
  private readonly inventoryList: MenuList<ShopInventoryItemVM>;
  private readonly recruitButton: HTMLButtonElement;
  private pane: ShopPane = 'stock';

  constructor(private readonly emit: (intent: UIIntent) => void) {
    super({ title: 'Provisioner', className: 'et-shop' });

    this.funds = el('span', 'et-shop__funds');
    this.rail().insertBefore(this.funds, this.rail().firstChild);

    this.stockPanel = new Panel({
      title: 'Buy',
      className: 'et-shop__panel et-shop__panel--stock',
      from: 'left',
    });
    this.stockList = new MenuList<ShopStockItemVM>({
      className: 'et-shop__list et-shop__stock',
      enabled: (item) => item.affordable,
      render: (item, row) => {
        row.classList.add('et-shop-row', 'et-shop-stock-row');
        row.dataset['itemId'] = item.id;
        if (!item.affordable) row.classList.add('is-unaffordable');
        const main = div('et-shop-row__main');
        add(
          main,
          el('span', 'et-shop-row__name', item.name),
          el('span', 'et-shop-row__description', item.description),
        );
        const value = div('et-shop-row__value');
        add(
          value,
          el('span', 'et-shop-row__price', `${item.price.toLocaleString()} gil`),
          el('span', 'et-shop-row__owned', `Owned ${item.owned}`),
        );
        add(row, main, value);
      },
      onConfirm: (item) => this.emit({ kind: 'shop-buy', itemId: item.id }),
    });
    this.stockPanel.body.appendChild(this.stockList.root);

    this.inventoryPanel = new Panel({
      tone: 'parchment',
      title: 'Sell',
      className: 'et-shop__panel et-shop__panel--inventory',
      from: 'right',
    });
    this.inventoryList = new MenuList<ShopInventoryItemVM>({
      className: 'et-shop__list et-shop__inventory',
      render: (item, row) => {
        row.classList.add('et-shop-row', 'et-shop-inventory-row');
        row.dataset['itemId'] = item.id;
        const main = div('et-shop-row__main');
        add(
          main,
          el('span', 'et-shop-row__name', item.name),
          el('span', 'et-shop-row__description', item.description),
        );
        const value = div('et-shop-row__value');
        add(
          value,
          el('span', 'et-shop-row__price', `${item.price.toLocaleString()} gil`),
          el('span', 'et-shop-row__owned', `×${item.count}`),
        );
        add(row, main, value);
      },
      onConfirm: (item) => this.emit({ kind: 'shop-sell', itemId: item.id }),
    });
    this.inventoryPanel.body.appendChild(this.inventoryList.root);

    const heading = div('et-shop__intro');
    const introCopy = div('et-shop__intro-copy');
    add(
      introCopy,
      icon('gil', 'et-shop__intro-icon'),
      el('span', undefined, 'Outfit the company for the road ahead.'),
    );
    this.recruitButton = el('button', 'et-shop__recruit', 'Recruit');
    this.recruitButton.type = 'button';
    this.recruitButton.addEventListener('click', () => this.openRecruitment());
    add(heading, introCopy, this.recruitButton);
    add(this.content, heading, this.stockPanel.root, this.inventoryPanel.root);
    this.stockPanel.root.classList.add('et-entered');
    this.inventoryPanel.root.classList.add('et-entered');
  }

  set(vm: ShopScreenVM): void {
    this.setHeading(vm.title, vm.subtitle);
    this.funds.replaceChildren(
      icon('gil'),
      document.createTextNode(`${vm.gil.toLocaleString()} gil`),
    );
    this.recruitButton.textContent =
      vm.rosterCount >= vm.rosterCap
        ? `Roster full · ${vm.rosterCount}/${vm.rosterCap}`
        : `Recruit · ${vm.rosterCount}/${vm.rosterCap}`;
    this.stockList.setItems(vm.stock, true);
    this.inventoryList.setItems(vm.inventory, true);
    this.applyPane();
  }

  private applyPane(): void {
    const stock = this.pane === 'stock';
    const inventory = this.pane === 'inventory';
    this.stockPanel.root.classList.toggle('is-focused', stock);
    this.inventoryPanel.root.classList.toggle('is-focused', inventory);
    this.recruitButton.classList.toggle('is-focused', this.pane === 'recruit');
    this.stockList.onFocusChange(stock);
    this.inventoryList.onFocusChange(inventory);
  }

  private switchPane(next: ShopPane): void {
    if (next === this.pane) return;
    this.pane = next;
    play('page');
    this.applyPane();
  }

  protected handleKey(key: UIKey): boolean {
    const nextPane = shopPaneTransition(this.pane, key);
    if (nextPane) {
      this.switchPane(nextPane);
      return true;
    }
    if (this.pane === 'stock') {
      return this.stockList.onKey(key);
    }
    if (this.pane === 'inventory') {
      return this.inventoryList.onKey(key);
    }
    if (key === 'confirm') {
      this.openRecruitment();
      return true;
    }
    return false;
  }

  private openRecruitment(): void {
    play('confirm');
    this.emit({ kind: 'shop-open-recruit' });
  }
}
