import { ChangeDetectorRef, Component, EventEmitter, OnInit, Output } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { map } from 'rxjs/operators';

import { EmailDateDropdownItem } from '../email-automation-workflow/models/email-date.model';
import { EmailAutomationService } from '../email-automation-workflow/services/email-automation.service';
import {
  DashboardSummary,
  DashboardTicket,
  DrillRequest,
  emptyDashboardSummary,
} from './models/user-dashboard.model';
import { UserDashboardService } from './services/user-dashboard.service';
import { AssigneeFilterService } from '../../core/services/assignee-filter.service';
import { UserDirectoryService } from '../../core/services/user-directory.service';
import {
  ALL_USERS,
  UserFilterOption,
  buildOwnerOptions,
} from '../../shared/models/user-filter.model';

/** The date filter's "every report merged" option. */
const ALL_DATES = 'ALL';


/**
 * The second screen of the workspace: where the whole queue stands, rather
 * than the one thread being worked.
 *
 * Every figure is counted in the browser. The backend has no aggregate
 * endpoint of any kind, so the screen reads the same two calls the Email
 * Automation screen already uses — the day's receipts and the tickets raised
 * for them — and pivots them through UserDashboardService.
 *
 * The top bar here is a rebuild of the Email Automation screen's own
 * `.top-app-header`, made sticky. Deliberately a copy and not a shared
 * component: lifting that header out of the automation screen would mean
 * editing it, and this screen was added on the condition that it is not
 * touched.
 */
@Component({
  selector: 'app-user-dashboard',
  standalone: false,
  templateUrl: './user-dashboard.html',
  styleUrl: './user-dashboard.scss',
})
export class UserDashboard implements OnInit {
  @Output() switchScreen = new EventEmitter<void>();

  /**
   * A ticket to open on the Email Automation screen.
   *
   * Handled by the shell rather than here, because it is the shell that owns
   * which of the two screens is mounted; this screen only says which thread
   * the reader asked for.
   */
  @Output() openInWorkflow = new EventEmitter<DashboardTicket>();

  goToAutomation(): void {
    this.switchScreen.emit();
  }

  /** Report dates to choose between, newest first, plus the implicit "All Dates". */
  dates: EmailDateDropdownItem[] = [];
  selectedDate = ALL_DATES;

  /** CRM owners present across everything loaded, plus the implicit "All users". */
  assignees: string[] = [];
  selectedAssignee = ALL_USERS;

  /**
   * The CRM Executive menu's rows, rebuilt whenever the loaded set changes.
   *
   * Held as a field rather than read from a getter: the menu renders a row per
   * executive and change detection would otherwise re-count every open ticket
   * on every pass.
   */
  assigneeOptions: UserFilterOption[] = [];


  /** Every ticket loaded so far, across every date read. */
  private allTickets: DashboardTicket[] = [];

  /** The dates the current load covers — whose receipt rows the picker counts. */
  private scopeDates: string[] = [];

  /** Open tickets after the user filter — what the drill-down works from. */
  openTickets: DashboardTicket[] = [];

  summary: DashboardSummary = emptyDashboardSummary();

  /** True on the very first paint, when there is nothing to hold on screen. */
  isLoading = false;
  /** True while the remaining dates fan in behind an already-rendered screen. */
  isRefreshing = false;
  errorMessage = '';

  /** Progress of the fan-out, shown while isRefreshing. */
  loadedDates = 0;
  totalDates = 0;

  lastUpdated: Date | null = null;

  /** What the matrix last asked to drill into, or null while it is closed. */
  drill: DrillRequest | null = null;

  /** The ticket whose drawer is open, or null. */
  drawerTicket: DashboardTicket | null = null;

  constructor(
    private readonly api: EmailAutomationService,
    private readonly dashboard: UserDashboardService,
    private readonly cdr: ChangeDetectorRef,
    private readonly assigneeFilter: AssigneeFilterService,
    private readonly userDirectory: UserDirectoryService
  ) {}

  ngOnInit(): void {
    // Whoever the Email Automation screen was scoped to is who this page opens
    // on, and rebuild() re-slices what is already loaded whenever it changes.
    this.assigneeFilter.selected$.subscribe((owner) => {
      if (owner === this.selectedAssignee) {
        return;
      }

      this.selectedAssignee = owner;
      this.rebuild();
      this.cdr.markForCheck();
    });

    this.loadDates();
  }

  // ── Filters ─────────────────────────────────────────────────

  onDateChange(date: string): void {
    if (date === this.selectedDate) {
      return;
    }

    this.selectedDate = date;
    this.closeDrill();
    this.load();
  }

  /**
   * Re-slices everything already loaded. No refetch: the whole point of
   * holding the joined tickets is that narrowing to one CRM executive is
   * arithmetic, not another round-trip.
   */
  onAssigneeChange(assignee: string): void {
    this.assigneeFilter.select(assignee);
  }

  reload(): void {
    this.dashboard.clearCache();
    this.closeDrill();

    // Nothing was ever read, so the dates themselves are what failed.
    if (this.dates.length === 0) {
      this.loadDates();
      return;
    }

    this.load();
  }

  // ── Drill-down and drawer ───────────────────────────────────

  onDrillRequested(request: DrillRequest): void {
    this.drill = request;
  }

  closeDrill(): void {
    this.drill = null;
    this.drawerTicket = null;
  }

  /** Open — hand the thread to the shell, which switches screens for it. */
  onTicketOpened(ticket: DashboardTicket): void {
    this.openInWorkflow.emit(ticket);
  }

  closeDrawer(): void {
    this.drawerTicket = null;
  }

  // ── Loading ─────────────────────────────────────────────────

  private loadDates(): void {
    this.isLoading = true;

    this.api.getAvailableDates().subscribe({
      next: (dates) => {
        this.dates = dates || [];

        if (this.dates.length === 0) {
          this.isLoading = false;
          this.errorMessage = 'No email reports are available yet.';
          this.cdr.markForCheck();
          return;
        }

        this.load();
      },
      error: (error) => {
        this.isLoading = false;
        this.errorMessage = this.messageFor(error, 'The report dates could not be read.');
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Reads the selected scope.
   *
   * On All Dates the newest report is read on its own first and rendered, then
   * the rest fan in behind it. Two reasons: the screen is useful after one
   * round-trip instead of after N, and acknowledge-tickets is a write — it
   * raises a ticket for any thread that has none — so the cost of sweeping
   * every date shows as visible progress rather than a silent stall.
   */
  private load(): void {
    const dates =
      this.selectedDate === ALL_DATES
        ? this.dates.map((item) => item.date)
        : [this.selectedDate];

    if (dates.length === 0) {
      this.isLoading = false;
      this.errorMessage = 'No email reports are available yet.';
      this.cdr.markForCheck();
      return;
    }

    this.errorMessage = '';
    this.isLoading = true;
    this.isRefreshing = false;
    this.allTickets = [];
    this.scopeDates = dates;
    this.totalDates = dates.length;
    this.loadedDates = 0;

    const first = dates[0];
    const rest = dates.slice(1);

    this.loadOne(first).subscribe({
      next: (tickets) => {
        this.allTickets = tickets;
        this.loadedDates = 1;
        this.isLoading = false;
        this.lastUpdated = new Date();
        this.rebuild();
        this.cdr.markForCheck();

        if (rest.length > 0) {
          this.loadRest(rest);
        }
      },
      error: (error) => {
        this.isLoading = false;
        this.errorMessage = this.messageFor(error, `The report for ${first} could not be read.`);
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * Folds the remaining dates in behind the rendered screen.
   *
   * A failure here is deliberately not fatal: the newest date is already on
   * screen and correct for itself, so the counts stop growing and the progress
   * note says so, rather than the whole dashboard collapsing to an error.
   */
  private loadRest(rest: string[]): void {
    this.isRefreshing = true;
    this.cdr.markForCheck();

    forkJoin(rest.map((date) => this.loadOne(date))).subscribe({
      next: (results) => {
        for (const tickets of results) {
          this.allTickets = this.allTickets.concat(tickets);
        }

        this.loadedDates = this.totalDates;
        this.isRefreshing = false;
        this.lastUpdated = new Date();
        this.rebuild();
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.isRefreshing = false;
        this.errorMessage = this.messageFor(
          error,
          'Some earlier dates could not be read. The figures below cover the dates that loaded.'
        );
        this.cdr.markForCheck();
      },
    });
  }

  /** One date's joined tickets, from the cache when it has already been read. */
  private loadOne(date: string): Observable<DashboardTicket[]> {
    const cached = this.dashboard.getCached(date);

    if (cached) {
      return of(cached);
    }

    return forkJoin({
      receipts: this.api.getReceipts(date),
      tickets: this.api.acknowledgeTickets(date),
    }).pipe(
      map((result) =>
        this.dashboard.join(
          result.receipts.rows || [],
          result.tickets.tickets || [],
          result.tickets.closedTickets || [],
          date
        )
      )
    );
  }

  /** Applies the user filter and recounts every figure on the screen. */
  private rebuild(): void {
    this.assigneeOptions = this.toAssigneeOptions();
    this.assignees = this.assigneeOptions
      .filter((option) => option.value !== ALL_USERS)
      .map((option) => option.value);

    this.selectedAssignee = this.assigneeFilter.selected;

    // The chosen person may not appear in the newly loaded scope at all. The
    // local field is set first so the subscription's own guard sees the value
    // it is about to be handed and does not re-enter this method.
    if (
      this.selectedAssignee !== ALL_USERS &&
      this.assignees.indexOf(this.selectedAssignee) === -1
    ) {
      this.selectedAssignee = ALL_USERS;
      this.assigneeFilter.select(ALL_USERS);
    }

    const scoped =
      this.selectedAssignee === ALL_USERS
        ? this.allTickets
        : this.allTickets.filter((t) => t.assignedTo === this.selectedAssignee);

    this.summary = this.dashboard.summarize(scoped);
    this.dashboard.setSummary(this.summary);
    this.openTickets = this.dashboard.openTicketsOf(scoped);
  }

  /**
   * The menu's rows: everyone first, then each executive with what they hold.
   *
   * Built from the loaded dates' receipt rows through the same function the
   * Ticket Automation screen uses, so both pickers show identical figures.
   * Counted off the unscoped set, so the numbers stay put as the reader moves
   * between executives.
   */
  private toAssigneeOptions(): UserFilterOption[] {
    const rows = this.scopeDates.reduce(
      (all, date) => all.concat(this.dashboard.getCachedRows(date)),
      [] as { assignedTo?: string }[]
    );

    return buildOwnerOptions(rows, this.dashboard.crmHeadName, (name) =>
      this.userDirectory.displayName(name)
    );
  }

  private messageFor(error: unknown, fallback: string): string {
    const shaped = error as { error?: { message?: string }; message?: string } | null;

    return shaped?.error?.message || shaped?.message || fallback;
  }

  // ── Template helpers ────────────────────────────────────────

  get hasData(): boolean {
    return !this.isLoading && this.errorMessage === '' && this.summary.openCount > 0;
  }

  get isEmpty(): boolean {
    return (
      !this.isLoading &&
      this.errorMessage === '' &&
      this.summary.openCount === 0 &&
      this.summary.closedCount === 0
    );
  }

  /** SLA health reads as healthy at or above the 90% target. */
  get isSlaHealthy(): boolean {
    return this.summary.slaPercent >= 90;
  }

  /** Bar colour for one SLA row, by how urgent that window is. */
  slaFill(key: string): string {
    if (key === 'breach') return '#dc2626';
    if (key === 'due4') return '#f97316';
    if (key === 'due8') return '#f59e0b';

    return '#16a34a';
  }
}
