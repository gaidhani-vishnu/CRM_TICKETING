import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  OnInit,
  Output,
} from '@angular/core';

import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailDateDropdownItem } from '../../models/email-date.model';

@Component({
  selector: 'app-email-date-dropdown',
  standalone: false,
  templateUrl: './email-date-dropdown.html',
  styleUrl: './email-date-dropdown.scss',
})
export class EmailDateDropdown implements OnInit {
  /** Emits the selected date's machine value, e.g. '2026-05-13'. */
  @Output() dateSelected = new EventEmitter<string>();

  dates: EmailDateDropdownItem[] = [];
  selectedDate = '';
  isLoading = false;
  errorMessage = '';

  /** Controls floating dropdown menu state */
  isOpen = false;

  constructor(
    private readonly emailAutomationService: EmailAutomationService,
    private readonly elementRef: ElementRef,
    private readonly cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadDates();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.isOpen = false;
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.isOpen = false;
  }

  toggleDropdown(): void {
    if (this.isLoading || !this.dates.length) return;
    this.isOpen = !this.isOpen;
  }

  selectDate(item: EmailDateDropdownItem): void {
    this.selectedDate = item.date;
    this.isOpen = false;
    this.dateSelected.emit(item.date);
  }

  /**
   * The dropdown's own "All Dates" entry — back to every report merged, the
   * same state the panel opens in. Emits '', which the parent reads as
   * "no date chosen" the same way it does before any pick has been made.
   */
  selectAllDates(): void {
    this.selectedDate = '';
    this.isOpen = false;
    this.dateSelected.emit('');
  }

  loadDates(): void {
    this.isLoading = true;
    this.errorMessage = '';

    // This app runs zoneless — the HTTP response lands outside any
    // Angular-scheduled event, so nothing repaints the trigger button on its
    // own without markForCheck(). Without it "Loading dates…" stuck there
    // until some unrelated click elsewhere in the app happened to trigger a
    // change-detection pass that finally picked up the already-loaded dates.
    this.emailAutomationService.getAvailableDates().subscribe({
      next: (dates) => {
        this.dates = dates;
        this.isLoading = false;

        // No date is picked automatically: the receipts panel opens on All
        // Dates — every report merged — and only narrows once the reviewer
        // actually picks one from this list.
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoading = false;
        this.errorMessage = 'Could not load report dates. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }

  getSelectedDisplayDate(): string {
    if (!this.selectedDate) {
      return 'All Dates';
    }

    const found = this.dates.find((d) => d.date === this.selectedDate);
    return found ? found.displayDate : this.selectedDate;
  }

  trackByDate(index: number, item: EmailDateDropdownItem): string {
    return item.date;
  }
}
