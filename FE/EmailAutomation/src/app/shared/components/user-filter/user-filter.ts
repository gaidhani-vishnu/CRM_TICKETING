import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
} from '@angular/core';

import { ALL_USERS, UserFilterOption } from '../../models/user-filter.model';

/**
 * The "whose threads" picker, as it appears in both screens' headers.
 *
 * A menu of our own rather than a <select>, because the browser draws a
 * select's list itself and no stylesheet reaches inside it — and the rows here
 * carry an avatar and a count, which is what makes one owner tellable from
 * another at a glance.
 *
 * Holds no data of its own: it renders the options it is given and says which
 * one was picked. The two screens count their owners differently — the Email
 * Automation screen off [Assigned To] on the loaded rows, the User Dashboard
 * off its joined tickets — and neither belongs in here.
 */
@Component({
  selector: 'app-user-filter',
  standalone: false,
  templateUrl: './user-filter.html',
  styleUrl: './user-filter.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserFilter {
  /** Every row of the menu, "all users" included, in the order to show them. */
  @Input() options: UserFilterOption[] = [];

  /** The chosen row's value — ALL_USERS, or an owner's name. */
  @Input() selected: string = ALL_USERS;

  @Input() disabled = false;

  @Output() selectedChange = new EventEmitter<string>();

  isOpen = false;

  readonly ALL_USERS = ALL_USERS;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly elementRef: ElementRef<HTMLElement>
  ) {}

  /** The trigger's label — the chosen option's, or a fallback while empty. */
  get label(): string {
    const match = this.options.find((option) => option.value === this.selected);

    if (match) {
      return match.label;
    }

    return this.selected === ALL_USERS ? 'All users' : this.selected;
  }

  /** The trigger's avatar. Blank for "all users", which shows an icon. */
  get initials(): string {
    const match = this.options.find((option) => option.value === this.selected);

    return match ? match.initials : '';
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.cdr.markForCheck();
  }

  select(value: string): void {
    this.isOpen = false;
    this.selected = value;
    this.selectedChange.emit(value);
    this.cdr.markForCheck();
  }

  trackByValue(index: number, option: UserFilterOption): string {
    return option.value;
  }

  /**
   * Shuts the menu on a click outside it.
   *
   * Measured against this component's own host, which is exactly the picker —
   * the reason it is a component rather than markup inside a screen, where
   * "outside" would have meant outside the whole page.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.isOpen) {
      return;
    }

    if (!this.elementRef.nativeElement.contains(event.target as Node)) {
      this.isOpen = false;
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) {
      this.isOpen = false;
      this.cdr.markForCheck();
    }
  }
}
