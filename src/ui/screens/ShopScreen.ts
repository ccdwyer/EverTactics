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

type ShopPane = 'stock' | 'inventory';

export class ShopScreen extends Screen {
  readonly name = 'shop-screen';

  private readonly funds: HTMLSpanElement;
  private readonly stockPanel: Panel;
  private readonly inventoryPanel: Panel;
  private readonly stockList: MenuList<ShopStockItemVM>;
  private readonly inventoryList: MenuList<ShopInventoryItemVM>;
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
    add(
      heading,
      icon('gil', 'et-shop__intro-icon'),
      el('span', 'et-shop__intro-copy', 'Outfit the company for the road ahead.'),
    );
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
    this.stockList.setItems(vm.stock, true);
    this.inventoryList.setItems(vm.inventory, true);
    this.applyPane();
  }

  private applyPane(): void {
    const stock = this.pane === 'stock';
    this.stockPanel.root.classList.toggle('is-focused', stock);
    this.inventoryPanel.root.classList.toggle('is-focused', !stock);
    this.stockList.onFocusChange(stock);
    this.inventoryList.onFocusChange(!stock);
  }

  private switchPane(next: ShopPane): void {
    if (next === this.pane) return;
    this.pane = next;
    play('page');
    this.applyPane();
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'next' || key === 'prev') {
      this.switchPane(this.pane === 'stock' ? 'inventory' : 'stock');
      return true;
    }
    if (this.pane === 'stock') {
      if (key === 'right') {
        this.switchPane('inventory');
        return true;
      }
      return this.stockList.onKey(key);
    }
    if (key === 'left') {
      this.switchPane('stock');
      return true;
    }
    return this.inventoryList.onKey(key);
  }
}
