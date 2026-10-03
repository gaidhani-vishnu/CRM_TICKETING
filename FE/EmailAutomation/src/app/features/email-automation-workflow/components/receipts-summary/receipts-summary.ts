import {
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
} from '@angular/core';
import { forkJoin } from 'rxjs';

import { ProjectAssignmentService } from '../../../../core/services/project-assignment.service';
import { TicketVisibilityService } from '../../../../core/services/ticket-visibility.service';
import { EmailDateDropdownItem } from '../../models/email-date.model';
import { EmailReceiptRow } from '../../models/email-receipt.model';
import { TicketAcknowledgementItem } from '../../models/ticket-acknowledgement.model';
import { EmailAutomationService } from '../../services/email-automation.service';
import {
  AssigneeSummary,
  CategorySummary,
  DonutSlice,
  TicketSummary,
} from './receipts-summary.model';

/**
 * Ticket summary popup — the Excel pivot the CRM team maintains by hand, built
 * from the day's data instead.
 *
 * Opened from the Email Receipts toolbar. Owns its own date so the summary can be
 * read for any day without moving the workflow off the thread being worked, and
 * its own Category filter, which scopes every figure below it at once.
 */
@Component({
  selector: 'app-receipts-summary',
  standalone: false,
  templateUrl: './receipts-summary.html',
  styleUrl: './receipts-summary.scss',
})
export class ReceiptsSummary implements OnChanges {
  /** Date to open on. The popup shows while this is set. */
  @Input() date: string | null = null;

  @Output() closed = new EventEmitter<void>();

  /** Dates to choose between, newest first. */
  dates: EmailDateDropdownItem[] = [];
  selectedDate = '';

  /** Categories present in the loaded day, plus the implicit "All". */
  categories: string[] = [];
  selectedCategory = 'ALL';

  summary: TicketSummary = this.emptySummary();

  /**
   * Donut arcs, computed once per slice change rather than in the template.
   *
   * A getter would hand *ngFor a new array on every change-detection pass, which
   * restarts the draw-in animation continuously.
   */
  categorySlices: DonutSlice[] = [];
  stageSlices: DonutSlice[] = [];

  isLoading = false;
  /** True while re-reading for a new date: the previous render is held, dimmed. */
  isRefreshing = false;
  errorMessage = '';

  /** Table view — the WCAG-clean twin of the charts, and the pivot itself. */
  showTable = false;

  /** The day's rows and tickets, kept so the category filter re-slices without refetching. */
  private rows: EmailReceiptRow[] = [];
  private ticketByThread: { [threadId: string]: TicketAcknowledgementItem } = {};

  constructor(
    private readonly api: EmailAutomationService,
    private readonly projectAssignment: ProjectAssignmentService,
    private readonly cdr: ChangeDetectorRef,
    private readonly visibility: TicketVisibilityService
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['date'] && this.date) {
      this.selectedDate = this.date;
      this.selectedCategory = 'ALL';
      this.loadDates();
      this.load(this.selectedDate, false);
    }
  }

  onClose(): void {
    this.closed.emit();
  }

  onDateChange(date: string): void {
    if (date && date !== this.selectedDate) {
      this.selectedDate = date;
      this.selectedCategory = 'ALL';
      this.load(date, true);
    }
  }

  onCategoryChange(category: string): void {
    this.selectedCategory = category;
    this.rebuild();
  }

  /** Recomputes the summary and the donut geometry that depends on it. */
  private rebuild(): void {
    this.summary = this.build();
    this.categorySlices = this.toSlices(this.summary.categories);
    this.stageSlices = this.toSlices(this.summary.stages);
  }

  /**
   * Turns a name→count breakdown into donut arcs.
   *
   * Capped at three coloured arcs plus a folded "Other": only the first three
   * categorical slots clear the all-pairs colour gates, and a donut is read by
   * comparing any slice against any other. Nothing is lost — the folded rows stay
   * in the table view.
   */
  private toSlices(items: CategorySummary[]): DonutSlice[] {
    const top = items.slice(0, 3);
    const folded = items.slice(3);
    const foldedTotal = folded.reduce((sum, item) => sum + item.total, 0);

    const parts: CategorySummary[] =
      foldedTotal > 0 ? top.concat([{ name: 'Other', total: foldedTotal }]) : top;

    const total = parts.reduce((sum, item) => sum + item.total, 0);

    // The gap that separates one arc from the next, in the same units as the
    // arc lengths — the surface doing the separating, never a stroke.
    const gap = parts.length > 1 ? 1.2 : 0;

    let cursor = 0;

    return parts.map((part, index) => {
      const pct = total > 0 ? (part.total / total) * 100 : 0;
      const slice: DonutSlice = {
        name: part.name,
        total: part.total,
        pct,
        len: Math.max(0, pct - gap),
        offset: -cursor,
        slot: index < 3 ? index + 1 : 0,
      };

      cursor += pct;

      return slice;
    });
  }

  toggleTable(): void {
    this.showTable = !this.showTable;
  }

  // ── Chart geometry ──────────────────────────────────────────

  /**
   * Bar width as a percentage of the widest row.
   *
   * Scaled to the largest value rather than the total: these bars compare
   * magnitudes between people, so the biggest bar should fill the track.
   */
  barWidth(value: number, max: number): number {
    return max > 0 ? Math.max(value > 0 ? 2 : 0, (value / max) * 100) : 0;
  }

  get maxAssigneeTotal(): number {
    return this.summary.assignees.reduce((max, a) => Math.max(max, a.total), 0);
  }

  get maxCategoryTotal(): number {
    return this.summary.categories.reduce((max, c) => Math.max(max, c.total), 0);
  }

  /**
   * Axis ticks for the owner chart: the quarters of the scale, rounded.
   *
   * Five labels rather than just the endpoints, aligned to the gridlines behind
   * the bars, so a bar can be read to roughly the right value without hovering.
   */
  get axisTicks(): number[] {
    const max = this.maxAssigneeTotal;

    return [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(max * fraction));
  }

  get maxStageTotal(): number {
    return this.summary.stages.reduce((max, s) => Math.max(max, s.total), 0);
  }

  /**
   * Share of the whole day, as a whole number.
   *
   * Rides beside the count as muted text: the bar carries the comparison, the
   * count carries the exact figure, and this answers "of what?" without the
   * reader doing the division.
   */
  share(value: number): number {
    return this.summary.totalTickets > 0
      ? Math.round((value / this.summary.totalTickets) * 100)
      : 0;
  }

  /**
   * Share of one assignee's bar taken by a status, as a percentage of that
   * person's own total — the stack's internal split.
   */
  segmentWidth(assignee: AssigneeSummary, status: string): number {
    const value = assignee.byStatus[status] || 0;

    return assignee.total > 0 ? (value / assignee.total) * 100 : 0;
  }

  /**
   * Categorical slot for a status. Fixed by the status's position in the stable
   * status list, so a filter that removes one never repaints the others.
   */
  statusClass(status: string): string {
    const index = this.summary.statuses.indexOf(status);

    return `series-${Math.min(index + 1, 8)}`;
  }

  /** Initials for the assignee chip, e.g. 'KAILASH D' → 'KD'. */
  initials(name: string): string {
    const parts = (name || '').trim().split(/\s+/);

    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    return (name || '?').slice(0, 2).toUpperCase();
  }

  /** Tooltip for a stacked segment — the value a too-small segment cannot label. */
  segmentTitle(assignee: AssigneeSummary, status: string): string {
    return `${assignee.name} · ${status}: ${assignee.byStatus[status] || 0}`;
  }

  // ── Loading ─────────────────────────────────────────────────

  private loadDates(): void {
    this.api.getAvailableDates().subscribe({
      next: (dates) => {
        this.dates = dates || [];
        this.cdr.markForCheck();
      },
      error: () => {
        // The popup still works on the date it was opened with.
        this.dates = [];
      },
    });
  }

  /**
   * Reads the day's receipts and their tickets together.
   *
   * `isRefresh` holds the previous render at reduced opacity instead of blanking
   * to a skeleton, so changing the date does not flash the layout away.
   */
  private load(date: string, isRefresh: boolean): void {
    this.errorMessage = '';
    this.isLoading = !isRefresh;
    this.isRefreshing = isRefresh;

    forkJoin({
      receipts: this.api.getReceipts(date),
      tickets: this.api.acknowledgeTickets(date),
    }).subscribe({
      next: (result) => {
        const rows = result.receipts.rows || [];

        // Admin / Pre_Admin count only their own threads; every other role
        // keeps the whole day here, as before.
        this.rows = this.visibility.isAssignedOnlyAdmin()
          ? rows.filter((row) => this.visibility.canSee(row.assignedTo))
          : rows;

        this.ticketByThread = {};
        for (const ticket of result.tickets.tickets || []) {
          this.ticketByThread[ticket.threadId] = ticket;
        }

        this.categories = this.distinctCategories();
        this.rebuild();
        this.isLoading = false;
        this.isRefreshing = false;
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.isLoading = false;
        this.isRefreshing = false;
        this.errorMessage =
          error?.error?.message || error?.message || 'The summary could not be built.';
        this.cdr.markForCheck();
      },
    });
  }

  private distinctCategories(): string[] {
    const seen: string[] = [];

    for (const row of this.rows) {
      const category = (row.category || '').trim();

      if (category && seen.indexOf(category) === -1) {
        seen.push(category);
      }
    }

    return seen.sort();
  }

  // ── The pivot ───────────────────────────────────────────────

  /**
   * Counts the filtered rows into the three breakdowns the popup draws.
   *
   * One pass over the rows: a thread contributes its ticket to its first CRM
   * owner (the same owner the grid's "Assigned To" column shows) and to its
   * category. Threads with no ticket yet are left out — the pivot counts tickets.
   */
  private build(): TicketSummary {
    const statuses: string[] = [];
    const byAssignee: { [name: string]: AssigneeSummary } = {};
    const byCategory: { [name: string]: CategorySummary } = {};
    const byStage: { [name: string]: CategorySummary } = {};
    const countByStatus: { [status: string]: number } = {};

    let totalTickets = 0;
    let unmappedCount = 0;

    for (const row of this.rows) {
      if (!this.matchesCategory(row)) {
        continue;
      }

      const ticket = this.ticketByThread[row.threadId];

      if (!ticket || !ticket.ticketId) {
        continue;
      }

      const status = (ticket.ticketStatus || 'Unknown').trim() || 'Unknown';

      if (statuses.indexOf(status) === -1) {
        statuses.push(status);
      }

      countByStatus[status] = (countByStatus[status] || 0) + 1;
      totalTickets++;

      const assignment = this.projectAssignment.getAssignment(row.project, row.subProject);
      // One owner per sub-project; more than one is a config clash, not a pick.
      const name =
        assignment.users.length === 1
          ? assignment.users[0].name
          : assignment.users.length > 1
            ? 'Multiple owners'
            : 'Unassigned';

      if (assignment.matchLevel === 'fallback') {
        unmappedCount++;
      }

      if (!byAssignee[name]) {
        byAssignee[name] = { name, byStatus: {}, total: 0 };
      }

      byAssignee[name].byStatus[status] = (byAssignee[name].byStatus[status] || 0) + 1;
      byAssignee[name].total++;

      const category = (row.category || 'Uncategorised').trim() || 'Uncategorised';

      if (!byCategory[category]) {
        byCategory[category] = { name: category, total: 0 };
      }

      byCategory[category].total++;

      const stage = (row.workflowStatus || 'Not started').trim() || 'Not started';

      if (!byStage[stage]) {
        byStage[stage] = { name: stage, total: 0 };
      }

      byStage[stage].total++;
    }

    return {
      // Open first, then the rest alphabetically: the status order fixes the
      // colour slots, so it must not depend on which day is loaded.
      statuses: statuses.sort((a, b) => this.statusRank(a) - this.statusRank(b) || a.localeCompare(b)),
      assignees: Object.keys(byAssignee)
        .map((name) => byAssignee[name])
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      categories: Object.keys(byCategory)
        .map((name) => byCategory[name])
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      stages: Object.keys(byStage)
        .map((name) => byStage[name])
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      totalTickets,
      countByStatus,
      unmappedCount,
    };
  }

  private statusRank(status: string): number {
    const normalized = status.trim().toLowerCase();

    if (normalized === 'open') return 0;
    if (normalized === 'closed') return 1;

    return 2;
  }

  private matchesCategory(row: EmailReceiptRow): boolean {
    if (this.selectedCategory === 'ALL') {
      return true;
    }

    return (row.category || '').trim() === this.selectedCategory;
  }

  private emptySummary(): TicketSummary {
    return {
      statuses: [],
      assignees: [],
      categories: [],
      stages: [],
      totalTickets: 0,
      countByStatus: {},
      unmappedCount: 0,
    };
  }
}
