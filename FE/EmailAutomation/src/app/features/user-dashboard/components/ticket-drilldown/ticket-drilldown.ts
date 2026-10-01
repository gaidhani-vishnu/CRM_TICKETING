import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';

import {
  ACTION_COLUMNS,
  ActionColumn,
  ActionColumnKey,
  DashboardTicket,
  DrillRequest,
  STEP_ORDER,
} from '../../models/user-dashboard.model';

/**
 * The tickets behind a number in the matrix.
 *
 * Opens with the matrix's own filters already applied, then lets them be
 * widened — the intent stays fixed as the panel's scope, because that is what
 * was clicked and what the heading claims to be showing.
 *
 * Filters write into a `filtered` field rather than being read through a
 * getter: a getter would hand *ngFor a new array on every change-detection
 * pass, which restarts the row rendering continuously.
 */
@Component({
  selector: 'app-ticket-drilldown',
  standalone: false,
  templateUrl: './ticket-drilldown.html',
  styleUrl: './ticket-drilldown.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketDrilldown implements OnChanges {
  /** Every open ticket in the current dashboard scope. */
  @Input() tickets: DashboardTicket[] = [];

  /** What the matrix asked for. The panel shows while this is set. */
  @Input() request: DrillRequest | null = null;

  /** Open — take this ticket's thread to the Email Automation screen. */
  @Output() ticketOpened = new EventEmitter<DashboardTicket>();
  @Output() closed = new EventEmitter<void>();

  search = '';
  subIntentFilter = 'ALL';
  stepFilter = 'ALL';
  columnFilter: ActionColumnKey | 'ALL' = 'ALL';
  slaFilter = 'ALL';

  /** Tickets in the clicked intent, before the panel's own five filters. */
  private scoped: DashboardTicket[] = [];

  /** What the table renders. */
  filtered: DashboardTicket[] = [];

  /** Sub-intents present in the scoped intent, for the select. */
  subIntents: string[] = [];

  /** Steps a ticket of the scoped intent is on, in pipeline order, for the select. */
  steps: string[] = [];

  readonly columns: ActionColumn[] = ACTION_COLUMNS;

  ngOnChanges(changes: SimpleChanges): void {
    // A new request re-seeds the filters from what was actually clicked.
    if (changes['request'] && this.request) {
      this.subIntentFilter = this.request.subIntent;
      this.stepFilter = this.request.step;
      this.columnFilter = this.request.column;
      this.slaFilter = 'ALL';
      this.search = '';
    }

    this.rescope();
    this.applyFilters();
  }

  onSearchChange(value: string): void {
    this.search = value;
    this.applyFilters();
  }

  onSubIntentChange(value: string): void {
    this.subIntentFilter = value;
    this.applyFilters();
  }

  onStepChange(value: string): void {
    this.stepFilter = value;
    this.applyFilters();
  }

  onColumnChange(value: string): void {
    this.columnFilter = value as ActionColumnKey | 'ALL';
    this.applyFilters();
  }

  onSlaChange(value: string): void {
    this.slaFilter = value;
    this.applyFilters();
  }

  clearFilters(): void {
    this.search = '';
    this.subIntentFilter = 'ALL';
    this.stepFilter = 'ALL';
    this.columnFilter = 'ALL';
    this.slaFilter = 'ALL';
    this.applyFilters();
  }

  onClose(): void {
    this.closed.emit();
  }

  onOpen(ticket: DashboardTicket): void {
    this.ticketOpened.emit(ticket);
  }

  trackByTicket(index: number, ticket: DashboardTicket): string {
    return ticket.ticketId;
  }

  trackByColumnOption(index: number, column: ActionColumn): string {
    return column.key;
  }

  /** The column heading a ticket's [Action Status] counts under, e.g. 'User Edit'. */
  columnLabel(ticket: DashboardTicket): string {
    const match = this.columns.find((column) => column.key === ticket.actionColumn);

    return match ? match.label : '';
  }

  // ── Filtering ───────────────────────────────────────────────

  /** Narrows to the clicked intent and collects the sub-intents and steps inside it. */
  private rescope(): void {
    const request = this.request;

    if (!request) {
      this.scoped = [];
      this.subIntents = [];
      this.steps = [];
      return;
    }

    this.scoped = this.tickets.filter((t) => t.intent === request.intent);

    const seen: string[] = [];
    const seenSteps: string[] = [];

    for (const ticket of this.scoped) {
      if (seen.indexOf(ticket.subIntent) === -1) {
        seen.push(ticket.subIntent);
      }

      if (seenSteps.indexOf(ticket.step) === -1) {
        seenSteps.push(ticket.step);
      }
    }

    this.subIntents = seen.sort((a, b) => a.localeCompare(b));
    this.steps = seenSteps.sort(
      (a, b) => this.stepRank(a) - this.stepRank(b) || a.localeCompare(b)
    );
  }

  /** Where a step falls in the pipeline; one the pipeline does not list goes last. */
  private stepRank(step: string): number {
    const index = STEP_ORDER.indexOf(step);

    return index === -1 ? STEP_ORDER.length : index;
  }

  private applyFilters(): void {
    const query = this.search.trim().toLowerCase();

    this.filtered = this.scoped.filter(
      (ticket) =>
        (this.subIntentFilter === 'ALL' || ticket.subIntent === this.subIntentFilter) &&
        (this.stepFilter === 'ALL' || ticket.step === this.stepFilter) &&
        (this.columnFilter === 'ALL' || ticket.actionColumn === this.columnFilter) &&
        (this.slaFilter === 'ALL' || ticket.slaStatus === this.slaFilter) &&
        (query === '' || this.matchesQuery(ticket, query))
    );
  }

  private matchesQuery(ticket: DashboardTicket, query: string): boolean {
    return (
      [
        ticket.ticketId,
        ticket.subIntent,
        ticket.customerName,
        ticket.customerEmail,
        ticket.step,
        ticket.assignedTo,
        ticket.unit,
        ticket.project,
      ]
        .join(' ')
        .toLowerCase()
        .indexOf(query) !== -1
    );
  }

  // ── Template helpers ────────────────────────────────────────

  /** What the panel is scoped to, spelled out under its heading. */
  get subtitle(): string {
    if (!this.request) {
      return '';
    }

    const parts: string[] = [];

    if (this.subIntentFilter !== 'ALL') {
      parts.push(this.subIntentFilter);
    }

    if (this.stepFilter !== 'ALL') {
      parts.push(this.stepFilter);
    }

    if (this.columnFilter !== 'ALL') {
      const column = this.columns.find((c) => c.key === this.columnFilter);
      parts.push(column ? column.label : this.columnFilter);
    }

    if (this.slaFilter !== 'ALL') {
      parts.push(this.slaFilter);
    }

    return parts.length > 0
      ? `Filtered: ${parts.join(' · ')}`
      : `All ${this.scoped.length} open tickets`;
  }

  get scopedCount(): number {
    return this.scoped.length;
  }

  get overdueCount(): number {
    return this.filtered.filter((t) => t.isOverdue).length;
  }
}
