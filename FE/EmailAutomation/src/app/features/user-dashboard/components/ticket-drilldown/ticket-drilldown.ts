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
  DashboardTicket,
  DrillRequest,
  StageKey,
  WORKFLOW_STAGES,
  WorkflowStage,
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
  stageFilter: StageKey | 'ALL' = 'ALL';
  slaFilter = 'ALL';

  /** Tickets in the clicked intent, before the panel's own four filters. */
  private scoped: DashboardTicket[] = [];

  /** What the table renders. */
  filtered: DashboardTicket[] = [];

  /** Sub-intents present in the scoped intent, for the select. */
  subIntents: string[] = [];

  readonly stages: WorkflowStage[] = WORKFLOW_STAGES;

  ngOnChanges(changes: SimpleChanges): void {
    // A new request re-seeds the filters from what was actually clicked.
    if (changes['request'] && this.request) {
      this.subIntentFilter = this.request.subIntent;
      this.stageFilter = this.request.stage;
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

  onStageChange(value: string): void {
    this.stageFilter = value as StageKey | 'ALL';
    this.applyFilters();
  }

  onSlaChange(value: string): void {
    this.slaFilter = value;
    this.applyFilters();
  }

  clearFilters(): void {
    this.search = '';
    this.subIntentFilter = 'ALL';
    this.stageFilter = 'ALL';
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

  trackByStageOption(index: number, stage: WorkflowStage): string {
    return stage.key;
  }

  // ── Filtering ───────────────────────────────────────────────

  /** Narrows to the clicked intent and collects the sub-intents inside it. */
  private rescope(): void {
    const request = this.request;

    if (!request) {
      this.scoped = [];
      this.subIntents = [];
      return;
    }

    this.scoped = this.tickets.filter((t) => t.category === request.intent);

    const seen: string[] = [];

    for (const ticket of this.scoped) {
      if (seen.indexOf(ticket.subIntent) === -1) {
        seen.push(ticket.subIntent);
      }
    }

    this.subIntents = seen.sort((a, b) => a.localeCompare(b));
  }

  private applyFilters(): void {
    const query = this.search.trim().toLowerCase();

    this.filtered = this.scoped.filter(
      (ticket) =>
        (this.subIntentFilter === 'ALL' || ticket.subIntent === this.subIntentFilter) &&
        (this.stageFilter === 'ALL' || ticket.stage === this.stageFilter) &&
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
        ticket.stageLabel,
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

    if (this.stageFilter !== 'ALL') {
      const stage = this.stages.find((s) => s.key === this.stageFilter);
      parts.push(stage ? stage.label : this.stageFilter);
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
