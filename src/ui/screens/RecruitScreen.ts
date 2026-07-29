/**
 * Town recruitment — stable candidate cards in, one explicit hire intent out.
 *
 * The screen owns only draft identity choices. Candidate generation, job
 * availability, pricing, roster limits, id minting, and persistence all remain
 * in the pure core/state layers.
 */

import { play } from '../audio';
import { MenuList } from '../components/MenuList';
import { Panel, divider, statRow } from '../components/Panel';
import { add, div, el } from '../dom';
import type { UIKey } from '../input';
import { portrait, portraitForUnit } from '../portraits';
import type {
  RecruitJobOptionVM,
  RecruitOfferVM,
  RecruitScreenVM,
  UIIntent,
} from '../types';
import { Screen } from './Screen';

type RecruitPane = 'offers' | 'details';

export class RecruitScreen extends Screen {
  readonly name = 'recruit-screen';

  private readonly funds: HTMLSpanElement;
  private readonly companySize: HTMLSpanElement;
  private readonly offersPanel: Panel;
  private readonly offersList: MenuList<RecruitOfferVM>;
  private readonly detailsPanel: Panel;
  private readonly face: HTMLDivElement;
  private readonly candidateName: HTMLSpanElement;
  private readonly candidateMeta: HTMLSpanElement;
  private readonly stats: HTMLDivElement;
  private readonly maleButton: HTMLButtonElement;
  private readonly femaleButton: HTMLButtonElement;
  private readonly jobSelect: HTMLSelectElement;
  private readonly nameInput: HTMLInputElement;
  private readonly equipment: HTMLSpanElement;
  private readonly price: HTMLSpanElement;
  private readonly reason: HTMLDivElement;
  private readonly hireButton: HTMLButtonElement;

  private vm: RecruitScreenVM | null = null;
  private selectedIndex = 0;
  private gender: 'male' | 'female' = 'male';
  private jobId = '';
  private pane: RecruitPane = 'offers';

  constructor(private readonly emit: (intent: UIIntent) => void) {
    super({ title: 'Recruit', className: 'et-recruit' });

    this.funds = el('span', 'et-recruit__funds');
    this.companySize = el('span', 'et-recruit__company-size');
    this.rail().insertBefore(this.companySize, this.rail().firstChild);
    this.rail().insertBefore(this.funds, this.companySize);

    this.offersPanel = new Panel({
      title: 'Candidates',
      className: 'et-recruit__offers-panel',
      from: 'left',
    });
    this.offersList = new MenuList<RecruitOfferVM>({
      className: 'et-recruit__offers',
      render: (offer, row) => {
        row.classList.add('et-recruit-card');
        row.dataset['offerIndex'] = String(offer.index);
        row.appendChild(
          portrait(
            portraitForUnit(offer.id, {
              job: offer.defaultJobName,
              gender: offer.defaultGender,
            }),
            { size: 'md', className: 'et-recruit-card__face' },
          ),
        );
        const copy = div('et-recruit-card__copy');
        add(
          copy,
          el('span', 'et-recruit-card__name', offer.defaultName),
          el(
            'span',
            'et-recruit-card__meta',
            `${offer.defaultJobName} · ${titleCase(offer.zodiac)}`,
          ),
          el(
            'span',
            'et-recruit-card__traits',
            `Brave ${offer.brave} · Faith ${offer.faith}`,
          ),
        );
        add(
          row,
          copy,
          el(
            'span',
            'et-recruit-card__price',
            `Default · ${offer.price.toLocaleString()} gil`,
          ),
        );
      },
      onHighlight: (offer) => {
        if (offer) this.selectOffer(offer.index);
      },
      onConfirm: (offer) => {
        this.selectOffer(offer.index);
        this.pane = 'details';
        this.applyPane();
        this.nameInput.focus();
        this.nameInput.select();
      },
    });
    this.offersPanel.body.appendChild(this.offersList.root);

    this.detailsPanel = new Panel({
      title: 'Shape This Recruit',
      className: 'et-recruit__details-panel',
      from: 'right',
    });

    this.face = div('et-recruit__portrait');
    const identity = div('et-recruit__identity');
    this.candidateName = el('span', 'et-recruit__candidate-name');
    this.candidateMeta = el('span', 'et-recruit__candidate-meta');
    add(identity, this.candidateName, this.candidateMeta);
    const hero = div('et-recruit__hero');
    add(hero, this.face, identity);

    this.stats = div('et-recruit__stats');

    this.maleButton = el('button', 'et-recruit__gender', 'Male');
    this.maleButton.type = 'button';
    this.maleButton.addEventListener('click', () => this.setGender('male'));
    this.femaleButton = el('button', 'et-recruit__gender', 'Female');
    this.femaleButton.type = 'button';
    this.femaleButton.addEventListener('click', () => this.setGender('female'));
    const genderButtons = div('et-recruit__gender-buttons');
    add(genderButtons, this.maleButton, this.femaleButton);

    this.jobSelect = el('select', 'et-recruit__select');
    this.jobSelect.setAttribute('aria-label', 'Starting job');
    this.jobSelect.addEventListener('change', () => {
      this.jobId = this.jobSelect.value;
      this.renderDraft();
    });

    this.nameInput = el('input', 'et-recruit__name');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 24;
    this.nameInput.autocomplete = 'off';
    this.nameInput.spellcheck = false;
    this.nameInput.setAttribute('aria-label', 'Recruit name');
    this.nameInput.addEventListener('input', () => {
      const offer = this.currentOffer();
      if (offer) {
        this.candidateName.textContent =
          this.nameInput.value.trim() || offer.defaultNames[this.gender];
      }
    });
    this.nameInput.addEventListener('focus', () => {
      this.detailsPanel.root.classList.add('is-naming');
    });
    this.nameInput.addEventListener('blur', () => {
      this.detailsPanel.root.classList.remove('is-naming');
    });

    const form = div('et-recruit__form');
    add(
      form,
      labelledField('Gender', genderButtons),
      labelledField('Starting job', this.jobSelect),
      labelledField('Name', this.nameInput),
    );

    this.equipment = el('span', 'et-recruit__equipment');
    const kit = div('et-recruit__kit');
    add(kit, el('span', 'et-recruit__field-label', 'Starting kit'), this.equipment);

    this.price = el('span', 'et-recruit__hire-price');
    this.hireButton = el('button', 'et-recruit__hire', 'Hire');
    this.hireButton.type = 'button';
    this.hireButton.addEventListener('click', () => this.hire());
    const action = div('et-recruit__action');
    add(action, this.price, this.hireButton);

    this.reason = div('et-recruit__reason');
    add(
      this.detailsPanel.body,
      hero,
      this.stats,
      divider('Terms'),
      form,
      kit,
      this.reason,
      action,
    );

    add(this.content, this.offersPanel.root, this.detailsPanel.root);
    this.offersPanel.root.classList.add('et-entered');
    this.detailsPanel.root.classList.add('et-entered');
  }

  set(vm: RecruitScreenVM): void {
    const previousBatch = this.vm?.offers.map((offer) => offer.id).join('|');
    const nextBatch = vm.offers.map((offer) => offer.id).join('|');
    this.vm = vm;
    this.setHeading(vm.title, vm.subtitle);
    this.funds.textContent = `${vm.gil.toLocaleString()} gil`;
    this.companySize.textContent = `${vm.rosterCount}/${vm.rosterCap} members`;
    this.offersList.setItems(vm.offers, previousBatch === nextBatch);
    if (previousBatch !== nextBatch) this.selectedIndex = 0;
    this.selectOffer(vm.offers[this.selectedIndex]?.index ?? 0);
    this.applyPane();
  }

  private selectOffer(index: number): void {
    const offer = this.vm?.offers.find((candidate) => candidate.index === index);
    if (!offer) return;
    this.selectedIndex = offer.index;
    this.gender = offer.defaultGender;
    this.jobId = offer.defaultJobId;
    this.nameInput.value = offer.defaultName;
    this.rebuildJobs();
    this.renderDraft();
  }

  private setGender(gender: 'male' | 'female'): void {
    const offer = this.currentOffer();
    if (!offer || gender === this.gender) return;
    const oldDefault = offer.defaultNames[this.gender];
    const keepCustomName =
      this.nameInput.value.trim() !== '' &&
      this.nameInput.value.trim() !== oldDefault;
    this.gender = gender;
    if (!keepCustomName) this.nameInput.value = offer.defaultNames[gender];
    this.rebuildJobs();
    this.renderDraft();
    play('page');
  }

  private rebuildJobs(): void {
    const options = this.currentJobs();
    if (!options.some((job) => job.id === this.jobId)) {
      const offer = this.currentOffer();
      this.jobId =
        options.find((job) => job.id === offer?.defaultJobId)?.id ??
        options[0]?.id ??
        '';
    }
    this.jobSelect.replaceChildren(
      ...options.map((job) => {
        const option = el('option');
        option.value = job.id;
        option.textContent = job.name;
        option.selected = job.id === this.jobId;
        return option;
      }),
    );
  }

  private renderDraft(): void {
    const offer = this.currentOffer();
    const job = this.currentJobs().find((candidate) => candidate.id === this.jobId);
    if (!offer || !job) return;

    this.face.replaceChildren(
      portrait(
        portraitForUnit(offer.id, { job: job.name, gender: this.gender }),
        { size: 'lg' },
      ),
    );
    this.candidateName.textContent =
      this.nameInput.value.trim() || offer.defaultNames[this.gender];
    this.candidateMeta.textContent = `${job.name} · ${titleCase(offer.zodiac)}`;
    this.stats.replaceChildren(
      statRow('HP', String(offer.raw.hp)),
      statRow('MP', String(offer.raw.mp)),
      statRow('PA', String(offer.raw.pa)),
      statRow('MA', String(offer.raw.ma)),
      statRow('Speed', String(offer.raw.spd)),
      statRow('Brave', String(offer.brave)),
      statRow('Faith', String(offer.faith)),
    );
    this.maleButton.classList.toggle('is-selected', this.gender === 'male');
    this.femaleButton.classList.toggle('is-selected', this.gender === 'female');
    this.jobSelect.value = this.jobId;
    this.equipment.textContent =
      job.equipment.length > 0 ? job.equipment.join(' · ') : 'No starting gear';
    this.price.textContent = `${job.price.toLocaleString()} gil`;
    const gil = this.vm?.gil ?? 0;
    const reason =
      this.vm?.unavailableReason ??
      (gil < job.price
        ? `Need ${(job.price - gil).toLocaleString()} more gil to hire.`
        : undefined);
    this.reason.textContent = reason ?? '';
    this.reason.hidden = reason === undefined;
    this.hireButton.disabled = reason !== undefined;
    this.hireButton.textContent = reason ? 'Hiring unavailable' : 'Hire recruit';
  }

  private currentOffer(): RecruitOfferVM | undefined {
    return this.vm?.offers.find((offer) => offer.index === this.selectedIndex);
  }

  private currentJobs(): readonly RecruitJobOptionVM[] {
    return this.vm?.jobs[this.gender] ?? [];
  }

  private hire(): void {
    const offer = this.currentOffer();
    if (!offer || !this.jobId || this.vm?.unavailableReason) {
      play('error');
      this.detailsPanel.shake();
      return;
    }
    this.emit({
      kind: 'recruit-hire',
      offerIndex: offer.index,
      jobId: this.jobId,
      gender: this.gender,
      name: this.nameInput.value,
    });
  }

  private applyPane(): void {
    this.offersPanel.root.classList.toggle('is-focused', this.pane === 'offers');
    this.detailsPanel.root.classList.toggle('is-focused', this.pane === 'details');
    this.offersList.onFocusChange(this.pane === 'offers');
  }

  protected handleKey(key: UIKey): boolean {
    if (key === 'next' || key === 'prev') {
      this.pane = this.pane === 'offers' ? 'details' : 'offers';
      this.applyPane();
      play('page');
      return true;
    }
    if (this.pane === 'offers') {
      if (key === 'right') {
        this.pane = 'details';
        this.applyPane();
        this.nameInput.focus();
        return true;
      }
      return this.offersList.onKey(key);
    }
    if (key === 'left') {
      this.pane = 'offers';
      this.applyPane();
      return true;
    }
    if (key === 'confirm') {
      this.hire();
      return true;
    }
    return false;
  }
}

function labelledField(label: string, control: HTMLElement): HTMLLabelElement {
  const field = el('label', 'et-recruit__field');
  add(field, el('span', 'et-recruit__field-label', label), control);
  return field;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
