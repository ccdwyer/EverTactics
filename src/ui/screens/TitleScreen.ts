/**
 * Front door for a campaign.
 *
 * This screen owns only presentation and confirmation UI. Save inspection and
 * campaign creation remain in the state layer; choices leave as UIIntent values.
 */

import { add, div, el } from '../dom';
import type { UIKey } from '../input';
import type { TitleScreenVM, UIIntent } from '../types';
import { MenuList } from '../components/MenuList';
import { Panel, divider } from '../components/Panel';
import { Screen } from './Screen';

type TitleChoiceId = 'new' | 'continue' | 'confirm-new' | 'keep-save';

interface TitleChoice {
  id: TitleChoiceId;
  label: string;
  detail: string;
  enabled: boolean;
}

export class TitleScreen extends Screen {
  readonly name = 'title-screen';

  private readonly panel: Panel;
  private readonly brand: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly menu: MenuList<TitleChoice>;
  private vm: TitleScreenVM | null = null;
  private confirmingOverwrite = false;

  constructor(private readonly emit: (intent: UIIntent) => void) {
    super({
      title: 'EverTactics',
      subtitle: 'A Chronicle of Steel and Starlight',
      className: 'et-title',
      closable: false,
    });

    this.panel = new Panel({
      className: 'et-title__panel',
      from: 'scale',
    });
    const crest = div('et-title__crest');
    crest.appendChild(el('span', '', 'ET'));
    const eyebrow = el('span', 'et-title__eyebrow', 'The Lion War Chronicles');
    this.brand = el('h1', 'et-title__brand', 'EverTactics');
    this.subtitle = el(
      'p',
      'et-title__subtitle',
      'A Chronicle of Steel and Starlight',
    );
    this.notice = el('p', 'et-title__notice');

    this.menu = new MenuList<TitleChoice>({
      className: 'et-title__menu',
      enabled: (choice) => choice.enabled,
      render: (choice, row) => {
        row.setAttribute('role', 'button');
        row.setAttribute('aria-disabled', String(!choice.enabled));
        add(
          row,
          el('span', 'et-title__choice-label', choice.label),
          el('span', 'et-title__choice-detail', choice.detail),
        );
      },
      onConfirm: (choice) => this.confirm(choice.id),
      onCancel: () => this.cancelConfirmation(),
      wrap: true,
    });

    add(
      this.panel.body,
      crest,
      eyebrow,
      this.brand,
      this.subtitle,
      divider(),
      this.notice,
      this.menu.root,
      el('p', 'et-title__footnote', 'Arrow keys or W/S to choose · Enter to confirm'),
    );
    this.content.appendChild(this.panel.root);
    this.panel.root.classList.add('et-entered');
  }

  set(vm: TitleScreenVM): void {
    this.vm = vm;
    this.confirmingOverwrite = false;
    this.setHeading(vm.title, vm.subtitle);
    this.brand.textContent = vm.title;
    this.subtitle.textContent = vm.subtitle ?? '';
    this.renderChoices();
  }

  requestOverwriteConfirmation(): void {
    if (!this.vm) return;
    this.confirmingOverwrite = true;
    this.renderChoices();
  }

  private renderChoices(): void {
    const vm = this.vm;
    if (!vm) return;
    if (this.confirmingOverwrite) {
      this.notice.textContent =
        'A campaign is already recorded. Beginning again will replace it.';
      this.notice.classList.add('is-warning');
      this.menu.setItems([
        {
          id: 'confirm-new',
          label: 'Begin Anew',
          detail: 'Replace the existing campaign',
          enabled: true,
        },
        {
          id: 'keep-save',
          label: 'Keep Campaign',
          detail: 'Return without changing the save',
          enabled: true,
        },
      ], false);
      return;
    }

    this.notice.textContent = vm.continueAvailable
      ? 'A company waits to resume its march.'
      : 'No campaign is recorded on this device.';
    this.notice.classList.remove('is-warning');
    this.menu.setItems([
      {
        id: 'new',
        label: 'New Game',
        detail: vm.overwriteConfirmationRequired
          ? 'Begin a new chronicle'
          : 'Raise a company in Chapter I',
        enabled: true,
      },
      {
        id: 'continue',
        label: 'Continue',
        detail: vm.continueAvailable
          ? 'Return to the world map'
          : 'No saved campaign',
        enabled: vm.continueAvailable,
      },
    ], false);
  }

  private confirm(id: TitleChoiceId): void {
    switch (id) {
      case 'new':
        this.emit({ kind: 'title-new-game', overwriteConfirmed: false });
        break;
      case 'continue':
        this.emit({ kind: 'title-continue' });
        break;
      case 'confirm-new':
        this.emit({ kind: 'title-new-game', overwriteConfirmed: true });
        break;
      case 'keep-save':
        this.cancelConfirmation();
        break;
    }
  }

  private cancelConfirmation(): void {
    if (!this.confirmingOverwrite) return;
    this.confirmingOverwrite = false;
    this.renderChoices();
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'cancel') {
      this.cancelConfirmation();
      return true;
    }
    return this.menu.onKey(key);
  }
}
