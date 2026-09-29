import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  QueryList,
  SimpleChanges,
  ViewChildren,
} from '@angular/core';
import { Observable, Subscription, forkJoin, map, of, switchMap } from 'rxjs';

import { ConfigService } from '../../../../core/services/config.service';
import { TicketVisibilityService } from '../../../../core/services/ticket-visibility.service';
import { UserDirectoryService } from '../../../../core/services/user-directory.service';
import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailReceiptRow, EmailReceiptsReportResponse } from '../../models/email-receipt.model';
import { isListedCategory } from '../../models/receipt-category.model';
import { THREAD_ACTION_STATUSES } from '../../models/thread-action-status.model';
import { TicketAcknowledgementItem } from '../../models/ticket-acknowledgement.model';
import {
  ALL_USERS,
  UserFilterOption,
  buildOwnerOptions,
  ownerOf,
} from '../../../../shared/models/user-filter.model';

/**
 * A column the search box can be narrowed to. '' is every column at once —
 * what the box does when the funnel has not been touched.
 */
export type SearchFieldKey =
  | ''
  | 'ticketId'
  | 'actionStatus'
  | 'category'
  | 'ticketStatus'
  | 'assignedTo'
  | 'workflowStatus'
  | 'status'
  | 'remark';

@Component({
  selector: 'app-email-receipts-table',
  standalone: false,
  templateUrl: './email-receipts-table.html',
  styleUrl: './email-receipts-table.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmailReceiptsTable implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  /** How often the list re-reads main_email_receipts for rows written since. */
  private static readonly AUTO_REFRESH_MS = 30 * 1000;

  private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshSubscription: Subscription | null = null;

  /**
   * Bumped by every full load, so a refresh or a ticket lookup that was still
   * in flight when the date changed cannot land its rows on the new date's list.
   */
  private loadGeneration = 0;

  /**
   * The report date to show, or null/'' for "All Dates" — every report the
   * dropdown lists, merged into one list. The default: the reviewer sees
   * everything on open, and narrows to one date only by picking it.
   */
  @Input() date: string | null = null;
  @Input() selectedThreadId: string | null = null;

  @Output() rowSelected = new EventEmitter<EmailReceiptRow>();
  @Output() rowsLoaded = new EventEmitter<EmailReceiptRow[]>();
  /** Thread ID → its ticket for the loaded date, once node 1 has run. */
  @Output() ticketsResolved = new EventEmitter<{ [threadId: string]: TicketAcknowledgementItem }>();

  /**
   * The ticket the selected row is standing for.
   *
   * A thread can hold two — the one that was closed and the one node 1 raised
   * afterwards — and which of them the grid is showing depends on the pill.
   * The panels beside this one resolve a ticket by thread, so without being
   * told they would answer with the open one while the row on screen reads the
   * closed one: the same row, two ticket numbers.
   */
  @Output() selectedTicketChanged = new EventEmitter<TicketAcknowledgementItem | null>();

  /**
   * How many threads are on screen after the search and the pills have had their
   * say. The panel header shows it beside "Email Receipts", so the one number up
   * there always describes the list underneath rather than the whole day.
   */
  @Output() visibleCountChanged = new EventEmitter<number>();

  /**
   * Whose threads to show, from the picker in the screen header — ALL_USERS
   * for everyone's. Owned up there rather than here because the same choice
   * scopes the User Dashboard, and the two must agree.
   */
  @Input() ownerFilter: string = ALL_USERS;

  /**
   * The owners on the loaded threads, for the header's picker to render.
   *
   * Emitted rather than read: only this panel knows which rows are loaded,
   * and the picker cannot offer a person who holds nothing on screen.
   */
  @Output() ownersChanged = new EventEmitter<UserFilterOption[]>();

  rows: EmailReceiptRow[] = [];
  filteredRows: EmailReceiptRow[] = [];
  fileName = '';
  isLoading = false;
  errorMessage = '';

  // Controls view mode: 'list' (Gmail/Outlook card style) vs 'table' (classic wide grid)
  viewMode: 'list' | 'table' = 'table';
  searchTerm = '';

  /**
   * Whether the grid is scrolled off its left edge — i.e. whether anything is
   * actually passing under the frozen Ticket ID column.
   *
   * Drives that column's divider and shadow. A grid sitting at the left has
   * nothing hidden behind the column, and drawing the line there would give
   * one column a vertical rule none of the others have.
   */
  isScrolledX = false;

  /**
   * Which grid column the search box is looking at, or '' for every one of
   * them.
   *
   * The funnel beside the search box picks it. Scoping matters on this list
   * because the same words turn up in more than one column — a ticket number
   * typed with 'Ticket ID' chosen can only ever match a ticket number, not a
   * subject line that happens to quote one.
   */
  searchField: SearchFieldKey = '';

  /** Whether the funnel's menu is on screen. */
  isSearchFieldMenuOpen = false;

  /**
   * Which column's values the flyout beside the column list is showing.
   *
   * Set by hovering a column, so the values can be read without committing to
   * anything — distinct from `searchField`, which is the column actually
   * filtering. Hovering down the list previews one column after another and
   * changes nothing until a value is clicked.
   */
  previewField: SearchFieldKey = '';

  /**
   * The flyout's own filter box. A column like Ticket ID has a value per
   * thread, so the list has to be searchable to be usable at all.
   */
  valueSearch = '';

  /**
   * The one value the chosen column is pinned to, from the funnel's second
   * panel; '' is all of them. Applied the moment it is picked — there is no
   * confirm step.
   */
  columnValueFilter = '';

  /** The columns the funnel offers, in the order the grid shows them. */
  readonly searchFields: ReadonlyArray<{ key: SearchFieldKey; label: string }> = [
    { key: '', label: 'All columns' },
    { key: 'ticketId', label: 'Ticket ID' },
    // The step and its state now live inside the Action Status cell rather
    // than in a column of their own, but they are still their own column to
    // search: matched against the whole 'Pending Unit Match' phrase, so both
    // the state and the step name find the row.
    { key: 'workflowStatus', label: 'Pending Step' },
    { key: 'actionStatus', label: 'Action Status' },
    { key: 'category', label: 'Category' },
    { key: 'ticketStatus', label: 'Ticket Status' },
    { key: 'assignedTo', label: 'Assigned To' },
    { key: 'status', label: 'Status' },
    { key: 'remark', label: 'Remark' },
  ];

  /**
   * Which of the choices under the search box is in force.
   *
   * One choice, not four checkboxes: a reviewer is either working the whole day,
   * the tickets of one status, the threads waiting on one step, or one person's
   * threads. 'alert' is the icon at the end of the row — a pill
   * in every way except that their label would not fit (or, for 'alert', is not
   * a label at all — it is one fact, on or off).
   */
  activePill: 'all' | 'ticket' | 'action' | 'result' | 'alert' = 'all';

  /**
   * Which side of the ticket pill is showing.
   *
   * Closed, because the two pills now split the day between them: All is the
   * open work, and this pill is what has been closed. The Open / Closed switch
   * that used to choose between them is hidden (see the template), so this is
   * effectively fixed — it stays a field so re-showing that row still works.
   */
  ticketPillStatus: 'Open' | 'Closed' = 'Closed';

  /** The Workflow Status the Action Needed pill is filtering on; '' = all of them. */
  actionStatus = '';

  /** Whether the Action Needed menu is on screen. */
  isActionMenuOpen = false;

  /**
   * The main_email_receipts.[Action Status] value the Action Status pill is
   * filtering on; '' = all of them. Kept apart from `actionStatus` above,
   * which filters on the raw per-step [Workflow Status] text instead — the
   * two pills answer different questions and a thread can match one without
   * matching the other.
   */
  resultStatusFilter = '';

  /** Whether the Action Status menu is on screen. */
  isResultMenuOpen = false;

  /**
   * Where the fill behind the active pill sits.
   *
   * Measured rather than expressed in CSS: the three pills are sized to their
   * own labels, so a thumb cannot be "a third" of anything. Read after the click
   * has been painted, then transitioned to.
   */
  pillThumbLeft = 0;
  pillThumbWidth = 0;

  @ViewChildren('pillButton') private pillButtons?: QueryList<ElementRef<HTMLElement>>;

  ngAfterViewInit(): void {
    this.movePillThumb();

    // Web fonts land after the first paint and change how wide the labels are,
    // so the thumb is measured again once the pills have settled.
    this.pillButtons?.changes.subscribe(() => this.movePillThumb());
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.movePillThumb();
  }

  /** Puts the thumb under whichever pill is active, on the next frame. */
  private movePillThumb(): void {
    requestAnimationFrame(() => {
      // 'alert' is not among these pills — its icon carries its own fill —
      // so the thumb is simply left where it was and hidden behind it.
      const index = ['all', 'ticket', 'action', 'result'].indexOf(this.activePill);
      const button = this.pillButtons?.get(index)?.nativeElement;

      if (!button) {
        return;
      }

      this.pillThumbLeft = button.offsetLeft;
      this.pillThumbWidth = button.offsetWidth;
      this.cdr.markForCheck();
    });
  }

  /**
   * Tells the list to re-read its rows.
   *
   * Called by the parent when the pipeline writes a thread's owner: the row
   * object is the one being rendered here, so the value has already changed —
   * only an OnPush component has no way of knowing it.
   */
  refreshRows(): void {
    this.cdr.markForCheck();
  }

  /**
   * Stops the bell on a thread whose alert has just been answered.
   *
   * The server has already set [Alert Received] back to NULL; this is the same
   * change on screen, so the bell stops at once rather than at the next
   * auto-refresh. Every row of the same email goes quiet together, since a loan
   * email's customers all share the one alert.
   */
  clearAlert(row: EmailReceiptRow): void {
    const email = row.parentThreadId || row.threadId;

    for (const r of this.rows) {
      if ((r.parentThreadId || r.threadId) === email) {
        r.alertReceived = false;
      }
    }

    this.applyFilters();
  }

  /** Thread ID → its ticket, filled in once node 1 has run for the loaded date. */
  private ticketByThread: { [threadId: string]: TicketAcknowledgementItem } = {};

  /**
   * Thread ID → the last ticket that thread had closed, where there is one.
   *
   * Kept apart from ticketByThread because a thread can hold both: node 1
   * raises a new ticket for every thread on the date, so a thread whose ticket
   * was closed yesterday shows an open one today and its closed one only here.
   * Without this the Closed pill had nothing to show — every row's current
   * ticket is open by construction.
   */
  private closedTicketByThread: { [threadId: string]: TicketAcknowledgementItem } = {};

  /**
   * The ticket this row is being shown for.
   *
   * The Closed pill is a list of closed tickets, so on it a row stands for its
   * closed ticket rather than the open one node 1 has since raised — the
   * number and the status in the grid both follow from this.
   */
  private ticketOf(row: EmailReceiptRow): TicketAcknowledgementItem | undefined {
    if (this.isShowingClosedTickets) {
      return this.closedTicket(row) || this.ticketByThread[row.threadId];
    }

    return this.ticketByThread[row.threadId];
  }

  /**
   * Whether the list on screen is a list of closed tickets.
   *
   * Two ways in — the Closed pill, and the funnel's Ticket Status = Closed —
   * and the rows have to read the same either way: the closed ticket's number
   * and status, not the open one node 1 raised for the thread afterwards.
   */
  /**
   * Whether the funnel has been pointed at one Ticket Status.
   *
   * When it has, it decides that column on its own: Open Ticket is where the
   * list sits until something is chosen, so its own open-only rule must not
   * also run and take the closed rows the funnel just asked for straight back
   * out again — which left the list empty.
   */
  private get isTicketStatusPinned(): boolean {
    return this.searchField === 'ticketStatus' && !!this.columnValueFilter.trim();
  }

  get isShowingClosedTickets(): boolean {
    return (
      this.activePill === 'ticket' ||
      (this.searchField === 'ticketStatus' &&
        this.columnValueFilter.trim().toLowerCase() === 'closed')
    );
  }

  /**
   * Tracks the grid's horizontal scroll for the frozen column's divider.
   *
   * Change detection is OnPush and this fires on every scroll frame, so it
   * only marks the component when the answer actually flips — once on leaving
   * the left edge, once on returning to it, rather than a render per frame.
   */
  onTableScroll(event: Event): void {
    const scrolled = (event.target as HTMLElement).scrollLeft > 0;

    if (scrolled !== this.isScrolledX) {
      this.isScrolledX = scrolled;
      this.cdr.markForCheck();
    }
  }

  /** The row's ticket number, or '' while it is still unresolved. */
  ticketId(row: EmailReceiptRow): string {
    return this.ticketOf(row)?.ticketId || '';
  }

  /** The row's ticket status ('Open' / 'Closed'), or '' while unresolved. */
  ticketStatus(row: EmailReceiptRow): string {
    return this.ticketOf(row)?.ticketStatus || '';
  }

  /**
   * The closed ticket behind this row, if it has one.
   *
   * Also true of a ticket closed in this session: the pipeline panel marks the
   * current ticket Closed in place, and that row has to reach the Closed pill
   * without waiting for a reload.
   */
  closedTicket(row: EmailReceiptRow): TicketAcknowledgementItem | undefined {
    const current = this.ticketByThread[row.threadId];

    if (current && (current.ticketStatus || '').trim().toLowerCase() === 'closed') {
      return current;
    }

    return this.closedTicketByThread[row.threadId];
  }

  /** Whether this thread has ever had a ticket closed. */
  hasClosedTicket(row: EmailReceiptRow): boolean {
    return !!this.closedTicket(row);
  }

  /**
   * Whether the ticket this row is being shown for has been closed.
   *
   * Reads ticketOf() rather than the row, so it answers for the same ticket the
   * Ticket ID and Ticket Status cells beside it are showing: its closed one on
   * the Closed pill, its current one everywhere else. That is what makes a
   * closed row read as finished on this list while the same thread's fresh open
   * ticket still reads as live work on the others.
   *
   * Distinct from hasClosedTicket(), which asks whether the thread has ever had
   * one closed — a thread almost always has, since node 1 raises a new ticket
   * the moment the last one closes.
   */
  isClosedTicketRow(row: EmailReceiptRow): boolean {
    return this.ticketStatus(row).trim().toLowerCase() === 'closed';
  }

  /**
   * The open half of the day: every row the closed list did not take.
   *
   * Defined by subtraction rather than by reading each row's ticket status,
   * because node 1 raises a fresh open ticket for a thread as soon as its last
   * one is closed — by that reading every row on the date is open, and Open
   * and Closed would both count the same threads.
   */
  private openRowsOf(rows: EmailReceiptRow[]): EmailReceiptRow[] {
    const closed = new Set(this.closedRows);

    return rows.filter((row) => !closed.has(row));
  }

  /** Pill class for a ticket status. */
  ticketStatusClass(status: string): string {
    return status.trim().toLowerCase() === 'closed'
      ? 'ticket-status-pill closed'
      : 'ticket-status-pill open';
  }

  /**
   * CSS modifier for an [Action Status] pill, e.g. 'user-intervention' for
   * 'User Intervention'. Falls back to 'unknown' for anything outside the
   * values THREAD_ACTION_STATUSES lists — a row from before this column
   * existed, say — so an unrecognised value still renders as a plain pill
   * instead of an unstyled one.
   */
  actionStatusClass(status: string | undefined): string {
    const trimmed = (status || '').trim();

    if (!THREAD_ACTION_STATUSES.includes(trimmed as (typeof THREAD_ACTION_STATUSES)[number])) {
      return 'unknown';
    }

    return trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  /**
   * The pipeline step the thread is waiting on, read out of
   * main_email_receipts.[Workflow Status].
   *
   * The backend writes that column as one phrase — "Pending Unit Match",
   * "Pending Email Response" — where the first word is the state and the rest
   * is the step. The grid shows them as two things side by side, so the state
   * is stripped here and pendingState() returns it separately.
   *
   * Falls back to [Action] when Workflow Status is blank: the pipeline panel
   * writes that one the first time a thread is opened, so a row can name its
   * step from either column.
   */
  pendingStep(row: EmailReceiptRow): string {
    // A closed ticket is not stopped on anything. The stored columns still
    // name a step because syncActionStatus() deliberately stops writing once a
    // ticket closes — the thread may already carry a fresh open ticket, so
    // [Workflow Status] goes on describing that live work. On a row standing
    // for the closed ticket that value is somebody else's, so it is not shown.
    // The row names the step it actually ended on instead, the pipeline's last
    // one, rather than being left blank.
    if (this.isClosedTicketRow(row)) {
      return 'Ticket Closed';
    }

    const status = (row.workflowStatus || '').trim();
    const leading = /^pending\s+(\S.*)$/i.exec(status);

    if (leading) {
      return leading[1].trim();
    }

    return status || (row.actionName || '').trim();
  }

  /**
   * The state in front of the step in [Workflow Status] — 'Pending' on every
   * value the pipeline writes today.
   *
   * '' when the column holds something that does not lead with one, so a value
   * this doesn't recognise renders as a bare step name rather than being
   * labelled with a state it never claimed.
   */
  pendingState(row: EmailReceiptRow): string {
    // The one state that is not read off [Workflow Status]: the ticket being
    // closed is what settles it, and the column has stopped tracking this
    // ticket by then. See pendingStep() for why it is stale rather than wrong.
    if (this.isClosedTicketRow(row)) {
      return 'Done';
    }

    return /^pending\s+\S/i.test((row.workflowStatus || '').trim()) ? 'Pending' : '';
  }

  /**
   * The row's [Action Status], as its cell shows it.
   *
   * 'Done' on a closed ticket whatever the column holds — the work the stored
   * value was last describing is over, and a closed ticket that still reads
   * "User Intervention" is asking the reviewer for something nobody can give.
   * Named rowActionStatus rather than actionStatus because the field of that
   * name is the funnel's own filter value.
   */
  rowActionStatus(row: EmailReceiptRow): string {
    if (this.isClosedTicketRow(row)) {
      return 'Done';
    }

    return (row.actionStatus || '').trim();
  }

  constructor(
    private readonly emailAutomationService: EmailAutomationService,
    private readonly config: ConfigService,
    private readonly cdr: ChangeDetectorRef,
    private readonly elementRef: ElementRef,
    private readonly userDirectory: UserDirectoryService,
    private readonly visibility: TicketVisibilityService
  ) {}

  /**
   * The thread's owner, as stored on the row by the pipeline.
   *
   * Read, never resolved: Unit Match settles who owns the thread and writes the
   * name into main_email_receipts.[Assigned To]. A thread that has not been
   * through that step has no owner yet and the cell stays empty, which is the
   * honest answer — it used to show a name computed on the spot for every row,
   * including ones the pipeline had never looked at.
   */
  assignedTo(row: EmailReceiptRow): string {
    return (row.assignedTo || '').trim();
  }

  /**
   * Asks the parent to open the ticket summary.
   *
   * The popup is rendered by the parent rather than here: a `position: fixed`
   * dialog inside this panel would be trapped by the panel's own backdrop-filter,
   * which makes it the containing block for fixed descendants.
   */
  @Output() summaryRequested = new EventEmitter<void>();

  openSummary(): void {
    this.summaryRequested.emit();
  }

  /**
   * Asks the parent to open the Alert Response popup for one row.
   *
   * Rendered by the parent for the same reason the ticket summary is: it
   * opens over part 1 (this panel and the pipeline), not inside this panel
   * alone, and a `position: fixed`/absolute dialog nested in here would be
   * trapped by ancestors of its own.
   */
  @Output() alertPopupRequested = new EventEmitter<EmailReceiptRow>();

  /**
   * Opens the popup for whichever row the bell sits on, and selects that row
   * too — reading a thread's alert and working the thread are the same errand,
   * so Thread Details follows the popup rather than staying on whatever was
   * open before.
   *
   * selectRow is called here rather than left to the click bubbling up to the
   * row's own handler, so the keyboard route (Enter on the focused bell) does
   * the same thing as the mouse — a keydown never reaches that handler.
   * stopPropagation is what keeps the two from both firing on a click.
   */
  openAlertPopup(row: EmailReceiptRow, event: Event): void {
    event.stopPropagation();
    this.selectRow(row);
    this.alertPopupRequested.emit(row);
  }

  /** Initials for the assignee avatar, e.g. 'KAILASH D' → 'KD'. */
  assigneeInitials(name: string): string {
    const parts = (name || '').trim().split(/\s+/);

    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    return (name || '?').slice(0, 2).toUpperCase();
  }

  /**
   * Hover text for the chip: the owner's mailbox where the master users list
   * knows it. Only the name is stored on the row, so the address is looked up
   * from the same config that supplied the name.
   */
  assigneeTitle(name: string): string {
    return this.config.getEmailForUser(name) || name;
  }

  ngOnInit(): void {
    this.autoRefreshTimer = setInterval(
      () => this.refreshReceipts(),
      EmailReceiptsTable.AUTO_REFRESH_MS
    );
  }

  ngOnDestroy(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }

    this.refreshSubscription?.unsubscribe();
  }

  ngOnChanges(changes: SimpleChanges): void {
    // A new owner needs no refetch — the rows are already in hand and the
    // filter is arithmetic over them.
    if (changes['ownerFilter'] && !changes['ownerFilter'].firstChange) {
      this.applyFilters();
    }

    if (!changes['date']) {
      return;
    }

    if (this.date) {
      this.loadReceipts(this.date);
    } else {
      this.loadAllReceipts();
    }
  }

  trackByThreadId(index: number, row: EmailReceiptRow): string {
    return row.threadId || index.toString();
  }

  selectRow(row: EmailReceiptRow): void {
    // A row that was chosen — by the reviewer clicking it, or by the parent
    // asking for it — is not the default pick and is never revised out from
    // under them. selectDefaultRow() sets the flag back for its own picks.
    this.isDefaultSelection = false;
    this.selectedThreadId = row.threadId;
    // Before the row itself: the panels read the ticket while they take the
    // row, and the SLA clock is one of the things they decide from it.
    this.selectedTicketChanged.emit(this.ticketOf(row) || null);
    this.rowSelected.emit(row);
    this.cdr.markForCheck();
  }

  setViewMode(mode: 'list' | 'table'): void {
    this.viewMode = mode;
    this.cdr.markForCheck();
  }

  onSearchChange(term: string): void {
    this.searchTerm = term;
    this.applyFilters();
  }

  /** The funnel's menu. */
  toggleSearchFieldMenu(): void {
    this.isSearchFieldMenuOpen = !this.isSearchFieldMenuOpen;

    // Opens where the reviewer left off: the flyout already showing the values
    // of the column in force, rather than making them find it again.
    this.previewField = this.isSearchFieldMenuOpen ? this.searchField : '';
    this.valueSearch = '';

    // One menu at a time, or the funnel's list opens over a pill's.
    this.isActionMenuOpen = false;
    this.isResultMenuOpen = false;
    this.cdr.markForCheck();
  }

  /**
   * Opens one column's values in the flyout. Hovering is enough — nothing is
   * filtered by looking.
   */
  previewColumn(field: SearchFieldKey): void {
    if (this.previewField === field) {
      return;
    }

    this.previewField = field;
    // Another column's values, so the box that was narrowing the last set has
    // nothing to say about these.
    this.valueSearch = '';
    this.cdr.markForCheck();
  }

  /**
   * Clicking a column, rather than hovering it. 'All columns' is a whole
   * answer, so it applies and closes; any other column scopes the search box
   * to itself and leaves the flyout open on its values — the click is also how
   * this is reached without a mouse.
   */
  selectSearchField(field: SearchFieldKey): void {
    this.searchField = field;
    // The old column's value cannot describe the new one.
    this.columnValueFilter = '';

    if (!field) {
      this.previewField = '';
      this.isSearchFieldMenuOpen = false;
      this.applyFilters();
      return;
    }

    this.previewColumn(field);
    this.applyFilters();
  }

  /** The flyout's filter box. */
  onValueSearchChange(term: string): void {
    this.valueSearch = term;
    this.cdr.markForCheck();
  }

  /**
   * Pins a column to one value; '' is all of them. Applied at once — the value
   * clicked is the whole choice, so there is nothing to confirm.
   *
   * The click settles the column too: whichever one the flyout is showing is
   * the one being filtered on, hovered into place or not.
   */
  selectColumnValue(value: string): void {
    this.searchField = this.previewField;
    this.columnValueFilter = value;
    this.isSearchFieldMenuOpen = false;
    this.applyFilters();
    // Ticket Status = Closed turns the list into a list of closed tickets, so
    // the panels beside it have to be told which ticket the row now stands for.
    this.emitSelectedTicket();
  }

  /** Drops the value but stays on the column — the chip's ✕. */
  clearColumnValue(): void {
    this.selectColumnValue('');
  }

  /**
   * The values actually present in the chosen column, with how many rows carry
   * each. Built from the loaded rows, so the menu can only offer what is
   * there — the same rule the status and owner menus follow.
   */
  get columnValues(): { value: string; count: number }[] {
    if (!this.previewField) {
      return [];
    }

    // Ticket Status is not discovered in the rows like the other columns: its
    // two values are fixed, and Closed is counted from the thread's history
    // rather than the ticket it holds now — the same rule the pills follow, so
    // the two can never disagree. Both are offered even at 0.
    const counts: { [value: string]: number } =
      this.previewField === 'ticketStatus'
        ? { Open: this.openTicketCount, Closed: this.closedTicketCount }
        : {};

    if (this.previewField !== 'ticketStatus') {
      for (const row of this.rows) {
        const value = this.columnValue(row, this.previewField).trim();

        if (value) {
          counts[value] = (counts[value] || 0) + 1;
        }
      }
    }

    const term = this.valueSearch.trim().toLowerCase();

    // A seeded entry stays on the list at 0 rather than being dropped: the
    // empty list it leads to is the answer to "what has been closed today?".
    return Object.keys(counts)
      .filter((value) => !term || value.toLowerCase().includes(term))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((value) => ({ value, count: counts[value] }));
  }

  /** Rows the chosen column has no value for — 'Ticket ID' before node 1 runs. */
  get columnBlankCount(): number {
    if (!this.previewField) {
      return 0;
    }

    return this.rows.filter((row) => !this.columnValue(row, this.previewField).trim()).length;
  }

  /** The chosen column's label, for the placeholder and the funnel's title. */
  get searchFieldLabel(): string {
    return this.searchFields.find((f) => f.key === this.searchField)?.label || 'All columns';
  }

  /** What the search box invites, once a column has been picked. */
  get searchPlaceholder(): string {
    return this.searchField
      ? `Search ${this.searchFieldLabel}...`
      : 'Search ticket ID, customer, subject...';
  }

  /** The column the flyout is showing. */
  get previewFieldLabel(): string {
    return this.searchFields.find((f) => f.key === this.previewField)?.label || '';
  }

  /** 'All Category' and the like — the flyout's first entry. */
  get allColumnValuesLabel(): string {
    return `All ${this.previewFieldLabel}`;
  }

  /** Whether the funnel is narrowing anything at all right now. */
  get isSearchFiltered(): boolean {
    return !!this.searchField || !!this.columnValueFilter;
  }

  /**
   * Whether anything at all is narrowing the list — the funnel, the typed
   * term, or any of the pills. What the ✕ beside the funnel exists for, and
   * why it is not on screen when there is nothing to clear.
   */
  get hasActiveFilters(): boolean {
    return !!this.searchTerm.trim() || this.isSearchFiltered || this.activePill !== 'all';
  }

  /**
   * Back to the whole day in one click: the search box, the funnel and the
   * pill row all let go together.
   *
   * One button rather than three, because a list narrowed by two filters at
   * once looks the same as a list narrowed by one — the reviewer who cannot
   * find a thread needs a way back that does not depend on remembering what
   * they set.
   */
  clearAllFilters(): void {
    this.searchTerm = '';
    this.searchField = '';
    // Set before emitSelectedTicket() below reads it back through ticketOf().
    this.columnValueFilter = '';
    this.previewField = '';
    this.valueSearch = '';
    this.isSearchFieldMenuOpen = false;

    this.activePill = 'all';
    // The ticket pill is the closed half; All is the open one.
    this.ticketPillStatus = 'Closed';
    this.actionStatus = '';
    this.isActionMenuOpen = false;
    this.resultStatusFilter = '';
    this.isResultMenuOpen = false;

    this.movePillThumb();
    this.applyFilters();
    this.emitSelectedTicket();
  }

  // ── The three filter pills ────────────────────────────────────

  /** Every row on the date — the open ones and the closed ones together. */
  get allCount(): number {
    return this.rows.length;
  }

  /**
   * The rows the closed list claims: one per closed ticket, latest report
   * first. Everything else on the date is the open half, so these two are a
   * split of the day rather than two overlapping questions — 11 closed out of
   * 151 leaves 140 open, which is what both counts have to say.
   */
  private get closedRows(): EmailReceiptRow[] {
    return this.oneRowPerClosedTicket(this.rows.filter((row) => this.hasClosedTicket(row)));
  }

  /** Both sides at once, for the Open / Closed row under the pills. */
  get openTicketCount(): number {
    return this.rows.length - this.closedTicketCount;
  }

  get closedTicketCount(): number {
    // Tickets, not rows: All Dates merges every day's report, so a thread that
    // was written in on two days carries two rows behind the one closed
    // ticket. The count has to be what the database would answer.
    return this.closedRows.length;
  }

  /**
   * One row per closed ticket.
   *
   * The Closed pill is a list of tickets, and a ticket is one thing however
   * many days its thread turns up on — the merged All Dates list would
   * otherwise show the same ticket number two or three times over. The row
   * kept is the one from the latest report, so what is on screen beside the
   * ticket is the thread's most recent state.
   */
  private oneRowPerClosedTicket(rows: EmailReceiptRow[]): EmailReceiptRow[] {
    const latest: { [ticketId: string]: EmailReceiptRow } = {};

    for (const row of rows) {
      const key = this.closedTicket(row)?.ticketId || row.threadId;
      const held = latest[key];

      if (!held || (row.sourceDate || '') > (held.sourceDate || '')) {
        latest[key] = row;
      }
    }

    const kept = new Set(Object.keys(latest).map((key) => latest[key]));

    // Filtered rather than rebuilt from the map, so the list keeps the order it
    // was loaded in.
    return rows.filter((row) => kept.has(row));
  }

  /**
   * Threads with main_email_receipts.[Alert Received] set, for the bell's badge.
   *
   * Scoped to the header's owner the same way applyFilters() scopes the list,
   * so the number is exactly what clicking the bell shows.
   */
  get alertCount(): number {
    return this.rows.filter(
      (row) =>
        row.alertReceived === true &&
        (!this.ownerFilter || this.ownerFilter === ALL_USERS || this.ownerOf(row) === this.ownerFilter)
    ).length;
  }

  /** Threads the Action Needed pill would show as it currently stands. */
  get actionCount(): number {
    return this.actionStatus === ''
      ? this.rows.length
      : this.rows.filter((row) => this.matchesWorkflowStatus(row)).length;
  }

  /** Threads the Action Status pill would show as it currently stands. */
  get resultCount(): number {
    return this.resultStatusFilter === ''
      ? this.rows.length
      : this.rows.filter((row) => this.matchesResultStatus(row)).length;
  }

  /**
   * The main_email_receipts.[Action Status] values actually present on the
   * loaded rows, each with its count, in pipeline order (Done last — it is
   * what a reviewer filtering for something to act on wants to see least).
   *
   * Built from the data rather than always offering all five: a day where
   * nothing has been opened yet has no values at all, and the menu says so
   * rather than offering five choices that would all show nothing.
   */
  get resultStatusOptions(): { status: string; count: number }[] {
    const counts: { [status: string]: number } = {};

    for (const row of this.rows) {
      const status = (row.actionStatus || '').trim();

      if (status !== '') {
        counts[status] = (counts[status] || 0) + 1;
      }
    }

    const order = [
      'User Verification Required',
      'User Intervention',
      'Pending',
      'Done',
    ];

    return Object.keys(counts)
      .sort((a, b) => {
        const left = order.indexOf(a);
        const right = order.indexOf(b);

        if (left === -1 && right === -1) return a.localeCompare(b);
        if (left === -1) return 1;
        if (right === -1) return -1;

        return left - right;
      })
      .map((status) => ({ status, count: counts[status] }));
  }

  /** The configured CRM head, the one owner that is not read off the row. */
  get crmHeadName(): string {
    return this.config.fallbackUser.name;
  }

  /**
   * Who the menu files a thread under.
   *
   * A blank [Assigned To] is the CRM head's rather than an owner of its own:
   * the head is who holds a thread Unit Match has not settled, and a failed
   * unit match writes that same name onto the row outright. Listing the two
   * apart put "CRM head" and "CRM_Head" in the menu as separate people — one
   * with 127 threads, one with 4 — for what is one person either way.
   *
   * Matched without case so a row spelled differently from config.json still
   * files under the one entry, and the entry is always named the way
   * config.json spells it.
   */
  private ownerOf(row: EmailReceiptRow): string {
    return ownerOf(row.assignedTo, this.crmHeadName);
  }

  /**
   * The Workflow Status values actually present on the loaded rows, each with
   * its count, in the order the pipeline runs them.
   *
   * Built from the data rather than a fixed list, so a status the backend starts
   * writing tomorrow appears without a code change; anything not in the known
   * order is appended alphabetically rather than dropped.
   */
  get actionStatuses(): { status: string; count: number }[] {
    const counts: { [status: string]: number } = {};

    for (const row of this.rows) {
      const status = (row.workflowStatus || '').trim();

      if (status !== '') {
        counts[status] = (counts[status] || 0) + 1;
      }
    }

    const order = [
      'Pending Customer Email Match',
      'Pending Unit Match',
      'Pending Instrument Match',
      'Pending Bank Reconciliation',
      'Pending Email Response',
    ];

    return Object.keys(counts)
      .sort((a, b) => {
        const left = order.indexOf(a);
        const right = order.indexOf(b);

        if (left === -1 && right === -1) return a.localeCompare(b);
        if (left === -1) return 1;
        if (right === -1) return -1;

        return left - right;
      })
      .map((status) => ({ status, count: counts[status] }));
  }

  /**
   * Picks a pill.
   *
   * Each of the two narrowing pills brings its own way of choosing: Pending
   * Ticket opens the Open / Closed row beneath, Action Needed its menu of
   * workflow statuses. All has nothing to choose and closes both.
   */
  /** Re-tells the panels which ticket the selected row is standing for. */
  private emitSelectedTicket(): void {
    const row = this.rows.find((r) => r.threadId === this.selectedThreadId);
    this.selectedTicketChanged.emit(row ? this.ticketOf(row) || null : null);
  }

  selectPill(pill: 'all' | 'ticket' | 'action' | 'result' | 'alert'): void {
    const wasActive = this.activePill === pill;

    this.activePill = pill;

    // Each opens its line shut: picking the pill says "narrow by status", not
    // "show me the statuses" — the reviewer opens the list when they want to
    // choose one. Clicking the same pill again toggles its list.
    this.isActionMenuOpen = pill === 'action' && wasActive && !this.isActionMenuOpen;
    this.isResultMenuOpen = pill === 'result' && wasActive && !this.isResultMenuOpen;

    this.movePillThumb();
    this.applyFilters();
    // The Closed pill shows a row's closed ticket where the others show its
    // open one, so switching pills changes which ticket the panels are on.
    this.emitSelectedTicket();
  }

  /** Open or Closed, from the row that opens under the Pending Ticket pill. */
  selectTicketStatus(status: 'Open' | 'Closed'): void {
    this.ticketPillStatus = status;
    this.applyFilters();
  }

  /**
   * The picker's rows for the loaded threads: everyone first, then each owner.
   *
   * Read from main_email_receipts.[Assigned To] — the owner Unit Match settled —
   * so the list can only ever offer people who actually have threads loaded.
   * Built by the same function the User Dashboard uses, so the two menus agree.
   */
  private toOwnerOptions(): UserFilterOption[] {
    return buildOwnerOptions(this.rows, this.crmHeadName, (name) =>
      this.userDirectory.displayName(name)
    );
  }


  /** The workflow-status menu on the second line. */
  toggleActionMenu(): void {
    this.isActionMenuOpen = !this.isActionMenuOpen;
    this.cdr.markForCheck();
  }

  /** Chooses one Workflow Status from the Action Needed menu; '' is all of them. */
  selectActionStatus(status: string): void {
    this.actionStatus = status;
    this.isActionMenuOpen = false;
    this.applyFilters();
  }

  /** The Action Status menu. */
  toggleResultMenu(): void {
    this.isResultMenuOpen = !this.isResultMenuOpen;
    this.cdr.markForCheck();
  }

  /** Chooses one [Action Status] value from that menu; '' is all of them. */
  selectResultStatus(status: string): void {
    this.resultStatusFilter = status;
    this.isResultMenuOpen = false;
    this.applyFilters();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event): void {
    if (!this.elementRef.nativeElement.contains(event.target)) {
      this.isActionMenuOpen = false;
      this.isResultMenuOpen = false;
      this.isSearchFieldMenuOpen = false;
      this.cdr.markForCheck();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.isActionMenuOpen = false;
    this.isResultMenuOpen = false;
    this.isSearchFieldMenuOpen = false;
    this.cdr.markForCheck();
  }

  private matchesWorkflowStatus(row: EmailReceiptRow): boolean {
    return (row.workflowStatus || '').trim() === this.actionStatus;
  }

  private matchesResultStatus(row: EmailReceiptRow): boolean {
    return (row.actionStatus || '').trim() === this.resultStatusFilter;
  }

  /** Ticket text with the separators dropped, so 'TKT-2026-1' == 'tkt20261'. */
  private looseMatchKey(value: string): string {
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  /**
   * One column's text for a row, read the same way its cell reads it — Ticket
   * ID, Ticket Status and Assigned To come from lookups rather than straight
   * off the row, so searching them means going through the same helpers.
   */
  private columnValue(row: EmailReceiptRow, field: SearchFieldKey): string {
    switch (field) {
      case 'ticketId':
        return this.ticketId(row);
      case 'ticketStatus':
        // A ticket node 1 has not raised yet is open work, which is the rule
        // the All pill follows — the funnel cannot call the same row blank.
        return this.ticketStatus(row).trim() || 'Open';
      case 'assignedTo':
        return this.assignedTo(row);
      case 'actionStatus':
        return this.rowActionStatus(row);
      case 'category':
        return row.category || '';
      case 'workflowStatus':
        return row.workflowStatus || '';
      case 'status':
        return row.status || '';
      case 'remark':
        return row.remark || '';
      default:
        return '';
    }
  }

  /** Whether one row's chosen column carries what was typed. */
  private matchesColumn(
    row: EmailReceiptRow,
    field: SearchFieldKey,
    term: string,
    loose: string
  ): boolean {
    const value = this.columnValue(row, field).toLowerCase();

    if (!value) {
      return false;
    }

    // Ticket numbers are the one column typed both ways, dashes and all.
    return value.includes(term) || (!!loose && this.looseMatchKey(value).includes(loose));
  }

  applyFilters(): void {
    let result = [...this.rows];

    // The owner scope comes from the screen header and holds across every
    // pill, unlike the narrowing below it: picking a person asks "show me
    // their work", not "show me their work instead of the closed tickets".
    if (this.ownerFilter && this.ownerFilter !== ALL_USERS) {
      result = result.filter((row) => this.ownerOf(row) === this.ownerFilter);
    }

    // The funnel's own choice, applied the moment it is picked. An exact match
    // rather than a contains: the value came from the column itself, so
    // 'Payment' must not also drag in 'Payment Query'.
    if (this.searchField && this.columnValueFilter) {
      const wanted = this.columnValueFilter.trim().toLowerCase();

      result =
        this.searchField === 'ticketStatus'
          ? wanted === 'closed'
            ? this.oneRowPerClosedTicket(result.filter((row) => this.hasClosedTicket(row)))
            : this.openRowsOf(result)
          : result.filter(
              (row) => this.columnValue(row, this.searchField).trim().toLowerCase() === wanted
            );
    }

    if (this.searchTerm.trim()) {
      const term = this.searchTerm.trim().toLowerCase();
      // Typed with or without the dashes: 'TKT-2026-000037', 'tkt2026000037'
      // and '000037' all have to land on the same row.
      const loose = this.looseMatchKey(term);

      if (this.searchField) {
        result = result.filter((r) => this.matchesColumn(r, this.searchField, term, loose));
      } else if (/^[0-9]+$/.test(loose)) {
        // Digits on their own are a ticket number being typed — nothing else on
        // a row is a number a reviewer would go looking for. Searched against
        // Ticket ID alone, because as a free-text term a single digit turns up
        // inside a date, an amount or a unit on nearly every row: typing '1'
        // used to return most of the day rather than TKT-…-000001.
        result = result.filter((r) => this.matchesColumn(r, 'ticketId', term, loose));
      } else {
        // Free text, across what the reviewer can actually read on the row.
        // threadId is deliberately not among them: it is the pipeline's own
        // opaque key, never on screen, and long enough to contain most short
        // terms by accident.
        result = result.filter(
          (r) =>
            this.matchesColumn(r, 'ticketId', term, loose) ||
            (r.customerSender && r.customerSender.toLowerCase().includes(term)) ||
            (r.customerName && r.customerName.toLowerCase().includes(term)) ||
            (r.emailSubject && r.emailSubject.toLowerCase().includes(term)) ||
            (r.intent && r.intent.toLowerCase().includes(term)) ||
            (r.category && r.category.toLowerCase().includes(term))
        );
      }
    }

    // The pills narrow whatever the search left, so the two work together
    // rather than one replacing the other.
    //
    // All and the ticket pill are the two halves of the day: All is the open
    // work — everything still to be dealt with — and the ticket pill is what
    // has been closed. A thread whose ticket has not resolved yet counts as
    // open: node 1 raises one for every thread, so "no status yet" only ever
    // means "waiting on node 1", never "closed".
    if (this.activePill === 'all' && !this.isTicketStatusPinned) {
      result = this.openRowsOf(result);
    } else if (this.activePill === 'ticket') {
      // Threads with a closed ticket behind them, whether or not node 1 has
      // since raised a new open one for the same thread — one row each, since
      // this is a list of tickets rather than of report rows.
      result = this.oneRowPerClosedTicket(result.filter((row) => this.hasClosedTicket(row)));
    } else if (this.activePill === 'action' && this.actionStatus !== '') {
      result = result.filter((row) => this.matchesWorkflowStatus(row));
    } else if (this.activePill === 'result' && this.resultStatusFilter !== '') {
      result = result.filter((row) => this.matchesResultStatus(row));
    }


    if (this.activePill === 'alert') {
      result = result.filter((row) => row.alertReceived === true);
    }

    this.filteredRows = this.newestTicketFirst(result);
    this.visibleCountChanged.emit(this.filteredRows.length);
    this.cdr.markForCheck();
  }

  /**
   * The list with the most recently raised ticket on top.
   *
   * Ordered on the ticket number rather than on Created_Date: the two are
   * written in the same statement, so the number is already in creation order,
   * and it is on every ticket — createdDate is empty on one raised before that
   * stamp existed, which would sort a real ticket to the bottom.
   *
   * A plain string compare is enough. TKT-YYYY-NNNNNN is fixed width and
   * zero-padded on both halves, so it orders correctly within a year and across
   * one, which a number parsed out of the sequence alone would not.
   *
   * Read through ticketId(), so on the Closed pill a row is placed by the closed
   * ticket it stands for rather than by the open one node 1 has since raised —
   * the same ticket its Ticket ID cell is showing.
   *
   * Rows whose ticket has not resolved yet sort last, keeping the order they
   * came in: they have no number to be the latest by, and while node 1 is still
   * running that is every row, which leaves the list exactly as the backend
   * sent it rather than shuffling it.
   */
  private newestTicketFirst(rows: EmailReceiptRow[]): EmailReceiptRow[] {
    return rows
      .map((row, index) => ({ row, index, ticket: this.ticketId(row).trim() }))
      .sort((a, b) => {
        if (a.ticket === b.ticket) {
          return a.index - b.index; // stable: equal keys keep the backend's order
        }

        if (!a.ticket || !b.ticket) {
          return a.ticket ? -1 : 1;
        }

        return b.ticket.localeCompare(a.ticket);
      })
      .map((entry) => entry.row);
  }

  getSentimentClass(sentiment: string | undefined): string {
    if (!sentiment) return 'sentiment-neutral';
    const s = sentiment.toLowerCase();
    if (s.includes('pos')) return 'sentiment-positive';
    if (s.includes('neg')) return 'sentiment-negative';
    return 'sentiment-neutral';
  }

  getConfidenceBadge(conf: string | undefined): string {
    if (!conf) return 'Low';
    const val = parseFloat(conf);
    if (val > 1 ? val >= 80 : val >= 0.8) return 'High';
    if (val > 1 ? val >= 50 : val >= 0.5) return 'Medium';
    return 'Low';
  }

  getAvatarInitials(name: string | undefined, sender: string | undefined): string {
    const target = (name || sender || 'Customer').trim();
    const parts = target.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return target.slice(0, 2).toUpperCase();
  }

  getAvatarColor(threadId: string | undefined): string {
    const colors = [
      'linear-gradient(135deg, #6366f1, #4f46e5)',
      'linear-gradient(135deg, #ec4899, #d946ef)',
      'linear-gradient(135deg, #3b82f6, #2563eb)',
      'linear-gradient(135deg, #10b981, #059669)',
      'linear-gradient(135deg, #f59e0b, #d97706)',
      'linear-gradient(135deg, #8b5cf6, #7c3aed)',
    ];
    let hash = 0;
    const str = threadId || '0';
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  }

  /**
   * Runs pipeline node 1 for every date passed in: each thread gets (or keeps)
   * a ticket. One date in single-date mode, every loaded date in All Dates
   * mode — All Dates shows every one of these threads, so every one of them
   * needs to be checked the same way a single date's load always has.
   *
   * Deliberately fire-and-forget — a database problem here must not stop the
   * receipts grid from rendering, so a failure only leaves the ticket numbers
   * unresolved.
   */
  private acknowledgeTickets(dates: string[], isRefresh = false): void {
    if (!dates.length) {
      return;
    }

    const generation = this.loadGeneration;

    forkJoin(dates.map((date) => this.emailAutomationService.acknowledgeTickets(date))).subscribe({
      next: (responses) => {
        // The date changed while this was in flight: these tickets belong to a
        // list that is no longer on screen.
        if (generation !== this.loadGeneration) {
          return;
        }


        const byThread: { [threadId: string]: TicketAcknowledgementItem } = {};
        const closedByThread: { [threadId: string]: TicketAcknowledgementItem } = {};

        for (const response of responses) {
          for (const ticket of response.tickets || []) {
            byThread[ticket.threadId] = ticket;
          }

          // Newest first from the server, so the first one seen for a thread is
          // the ticket it had closed most recently.
          for (const ticket of response.closedTickets || []) {
            if (!closedByThread[ticket.threadId]) {
              closedByThread[ticket.threadId] = ticket;
            }
          }
        }

        this.ticketByThread = byThread;
        this.closedTicketByThread = closedByThread;
        this.ticketsResolved.emit(byThread);
        this.emitSelectedTicket();

        // Tickets resolve after the rows do, so the Pending Ticket pill only
        // has anything to count from here on — and the list has to be re-filtered
        // if that pill is already the one in force.
        this.applyFilters();

        // The list only falls into ticket order here: until the numbers landed,
        // newestTicketFirst() had nothing to sort on and finishLoad() opened
        // whatever row the backend happened to send first. Re-pick against the
        // sorted list so a refresh lands on the latest ticket — and so the
        // panels get the ticket itself, which was still unresolved when they
        // were first handed the row. Skipped once the reviewer has chosen a row
        // of their own.
        //
        // Never on an auto-refresh: the row on screen stays selected, and a
        // ticket that has just arrived must not take the selection because it
        // now sorts to the top.
        if (!isRefresh && this.isDefaultSelection) {
          this.selectDefaultRow();
        }

        this.cdr.markForCheck();
      },
      error: (err) => {
        console.warn('Ticket acknowledgement failed; ticket numbers unavailable.', err);
      },
    });
  }

  /** Everything both loaders reset before firing their own request. */
  private resetForNewLoad(): void {
    this.loadGeneration++;
    this.refreshSubscription?.unsubscribe();
    this.isLoading = true;
    this.errorMessage = '';
    this.rows = [];
    this.filteredRows = [];
    // Dropped so the previous load's tickets cannot show against these rows.
    this.ticketByThread = {};
    this.closedTicketByThread = {};

    // A fresh load starts on everything: a pill narrowed to the last load's
    // workload would otherwise open on a list that looks empty for no visible
    // reason.
    this.activePill = 'all';
    // The ticket pill is the closed half; All is the open one.
    this.ticketPillStatus = 'Closed';
    this.actionStatus = '';
    this.isActionMenuOpen = false;
    this.resultStatusFilter = '';
    this.isResultMenuOpen = false;
    // A fresh load has its own owners; a name held over from the last one
    // could filter the list down to nothing with no obvious reason why.
    // The column survives a reload — every load has a Category column — but the
    // value picked out of the last load's rows may not exist in these.
    this.columnValueFilter = '';
    this.isSearchFieldMenuOpen = false;
    this.previewField = '';
    this.valueSearch = '';
    this.movePillThumb();
  }

  /** Whatever the two loaders do once their rows are actually in hand. */
  private finishLoad(): void {
    this.applyFilters();
    this.isLoading = false;
    this.rowsLoaded.emit(this.rows);
    this.ownersChanged.emit(this.toOwnerOptions());

    this.selectDefaultRow();
    this.cdr.markForCheck();
  }

  /**
   * Whether the selected row is one this component picked rather than one the
   * reviewer or the parent asked for.
   *
   * Only a default pick may be revised. The ticket numbers arrive after the
   * rows do, so the first pick is made against a list that is not yet in ticket
   * order — but by then the reviewer may already have clicked something, and
   * moving them off it would be the panel changing under their hands.
   */
  private isDefaultSelection = false;

  /**
   * Opens the panels on a row without the reviewer having to click one.
   *
   * The parent's [selectedThreadId] wins whenever it names a row that is
   * actually here — a thread asked for by name has to be the one that opens.
   * Otherwise the top of the list does, which after newestTicketFirst() is the
   * most recently raised ticket.
   *
   * Reads filteredRows rather than rows: "the top" means the top of what is on
   * screen, in the order and under the pill the reviewer is looking at. Falls
   * back to the backing array only when a filter has emptied the view, where
   * selecting nothing would leave the pipeline and details panels blank with
   * nothing on the list to fill them from.
   */
  private selectDefaultRow(): void {
    const source = this.filteredRows.length > 0 ? this.filteredRows : this.rows;

    if (source.length === 0) {
      this.rowSelected.emit(undefined);
      return;
    }

    // Only the parent's own request counts as a thread asked for by name. This
    // method writes its own pick into selectedThreadId through selectRow(), and
    // reading that back on the next call would pin the list to whichever row
    // was on top before the ticket numbers arrived to sort it.
    const wanted = this.isDefaultSelection
      ? undefined
      : source.find((r) => r.threadId === this.selectedThreadId);

    this.selectRow(wanted || source[0]);

    // After selectRow(), which clears it: a pick made here is the default one
    // and may be revised once the tickets land — unless it was a thread asked
    // for by name, which stands.
    this.isDefaultSelection = !wanted;

    // A thread asked for by name can be anywhere in a merged All Dates list,
    // and landing on it silently three hundred rows down reads as nothing
    // having happened. The first row needs no scrolling — it is already in
    // view — so only a found one is chased.
    if (wanted) {
      this.scrollSelectedRowIntoView();
    }
  }

  /**
   * Brings the selected row into view, once it has actually been rendered.
   *
   * Queried out of the DOM rather than held as a ViewChild: the list draws
   * as cards or as table rows depending on the view mode, and this is the one
   * thing that does not care which of the two is on screen.
   */
  private scrollSelectedRowIntoView(): void {
    requestAnimationFrame(() => {
      const row = this.elementRef.nativeElement.querySelector(
        '.email-item-card.selected, tr.selected-row'
      ) as HTMLElement | null;

      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  /**
   * The only categories this panel shows — every other Category value the
   * classifier writes (Payment - Unverified, and whatever else may show up
   * later) is filtered out at load, before the pills and counts ever see it.
   *
   * The rule itself lives in receipt-category.model.ts because the KPI ribbon
   * has to apply the same one: the ribbon's Open figure and the count beside
   * "Email Receipts" describe the same threads, and they can only agree while
   * both are drawn through a single predicate.
   *
   * A Payment - Loan/Bank row is listed like any other and needs nothing
   * special here: the backend has already replaced each loan email with one row
   * per customer on it, so what arrives is an ordinary row whose threadId is
   * that customer's — see EmailReceiptRow.customerThreadId.
   */
  private isAllowedCategory(row: EmailReceiptRow): boolean {
    return isListedCategory(row.category);
  }

  /**
   * One report's rows as the panel lists them: the unlisted categories dropped,
   * each row stamped with the date it came from. Shared by both loaders and the
   * auto-refresh, so a refreshed row is keyed exactly like a loaded one.
   */
  private listedRows(response: EmailReceiptsReportResponse, date: string): EmailReceiptRow[] {
    return (response.rows || [])
      .filter((row) => this.isAllowedCategory(row))
      // A Pre_User / Pos_User gets only the threads assigned to them.
      .filter((row) => this.visibility.canSee(row.assignedTo))
      .map((row) => ({ ...row, sourceDate: date }));
  }

  // ── Auto-refresh ─────────────────────────────────────────────

  /**
   * Re-reads the list in place every AUTO_REFRESH_MS, so a receipt written to
   * main_email_receipts since the last load turns up without a reload.
   *
   * Deliberately not a full load. resetForNewLoad() throws away the pills, the
   * funnel and the tickets, and finishLoad() picks a row, both right for a new
   * date and both wrong here: the reviewer is part-way through a thread and the
   * list has only grown under them. Nothing is re-selected. The row on screen
   * stays the one on screen, and a new receipt is only added to the list.
   */
  private refreshReceipts(): void {
    // A full load already in progress is about to bring the same rows, and a
    // refresh still running from the last tick has not finished yet.
    if (this.isLoading || (this.refreshSubscription && !this.refreshSubscription.closed)) {
      return;
    }

    const generation = this.loadGeneration;

    this.refreshSubscription = this.fetchRows(this.date).subscribe({
      next: ({ dates, rows }) => {
        if (generation !== this.loadGeneration) {
          return;
        }

        this.mergeRefreshedRows(rows);
        // New threads have no ticket until node 1 runs for them, and the list
        // sorts on the ticket number, so the new rows move into place from here.
        this.acknowledgeTickets(dates, true);
      },
      // A failed tick leaves the list as it was; the next one tries again.
      error: (err) => console.warn('Email receipts auto-refresh failed.', err),
    });
  }

  /** The rows for one date, or for every date when there is none, with the dates read. */
  private fetchRows(date: string | null): Observable<{ dates: string[]; rows: EmailReceiptRow[] }> {
    if (date) {
      return this.emailAutomationService
        .getReceipts(date)
        .pipe(map((response) => ({ dates: [date], rows: this.listedRows(response, date) })));
    }

    return this.emailAutomationService.getAvailableDates().pipe(
      switchMap((dates) =>
        dates.length
          ? forkJoin(dates.map((d) => this.emailAutomationService.getReceipts(d.date))).pipe(
              map((responses) => ({
                dates: dates.map((d) => d.date),
                rows: responses.flatMap((response, i) => this.listedRows(response, dates[i].date)),
              }))
            )
          : of({ dates: [] as string[], rows: [] as EmailReceiptRow[] })
      )
    );
  }

  /**
   * Swaps the freshly read rows in, keeping every existing row's object.
   *
   * Identity is what carries the selection. The parent tells a re-click from a
   * new thread by comparing the row object (see
   * EmailAutomationWorkflow.onRowSelected), and the pipeline panel only reacts
   * to a changed [selectedRow]. A fresh copy of the selected row would read as
   * a different thread and reset every card. So a row that was already here
   * keeps its object and has the new values copied onto it, and only a row
   * that is actually new comes in as a new object.
   *
   * The selected row is not written to at all. The pipeline is working on it
   * and writes to it as it goes, and a refresh landing half-way through a step
   * must not overwrite that with whatever the table held a moment before.
   */
  private mergeRefreshedRows(fresh: EmailReceiptRow[]): void {
    // Thread and date together: All Dates can hold the same thread once per report.
    const keyOf = (row: EmailReceiptRow) => `${row.sourceDate || ''}|${row.threadId}`;
    const held = new Map(this.rows.map((row) => [keyOf(row), row]));

    this.rows = fresh.map((row) => {
      const existing = held.get(keyOf(row));

      if (!existing) {
        return row;
      }

      if (existing.threadId !== this.selectedThreadId) {
        Object.assign(existing, row);
      } else {
        // The one field that is safe on the selected row: the pipeline never
        // writes it, and a customer reply landing (or a sent response clearing
        // it) has to reach the bell of the thread being worked as well.
        existing.alertReceived = row.alertReceived;
      }

      return existing;
    });

    this.applyFilters();
    this.rowsLoaded.emit(this.rows);
    this.ownersChanged.emit(this.toOwnerOptions());

    // Clear the selection only when its thread has gone from the table
    // altogether. A thread that is still loaded but hidden by a pill stays
    // selected, the same as it would without a refresh.
    if (this.selectedThreadId && !this.rows.some((r) => r.threadId === this.selectedThreadId)) {
      this.selectedThreadId = null;
      this.isDefaultSelection = false;
      this.selectedTicketChanged.emit(null);
      this.rowSelected.emit(undefined);
    }

    this.cdr.markForCheck();
  }

  private loadReceipts(date: string): void {
    this.resetForNewLoad();

    this.emailAutomationService.getReceipts(date).subscribe({
      next: (response) => {
        // Stamped even in single-date mode, so a row picked here and one
        // picked from an All Dates list carry the same field either way — the
        // parent reads row.sourceDate for the pipeline date regardless of
        // which mode found the row.
        this.rows = this.listedRows(response, date);
        this.fileName = response.fileName || '';
        this.acknowledgeTickets([date]);
        this.finishLoad();
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage =
          err.status === 404
            ? `No report file found for ${date}.`
            : 'Could not load the report. Please try again.';
        this.cdr.markForCheck();
      },
    });
  }

  /**
   * All Dates: every report the dropdown lists, merged into one list — the
   * panel's default. Fetches the date list itself rather than taking one from
   * the caller, since the date dropdown loads its own copy independently and
   * the two are not guaranteed to ask at the same moment.
   */
  private loadAllReceipts(): void {
    this.resetForNewLoad();
    this.fileName = '';

    this.emailAutomationService.getAvailableDates().subscribe({
      next: (dates) => {
        if (!dates.length) {
          this.finishLoad();
          return;
        }

        forkJoin(dates.map((d) => this.emailAutomationService.getReceipts(d.date))).subscribe({
          next: (responses) => {
            this.rows = responses.flatMap((response, i) =>
              this.listedRows(response, dates[i].date)
            );
            this.acknowledgeTickets(dates.map((d) => d.date));
            this.finishLoad();
          },
          error: () => {
            this.isLoading = false;
            this.errorMessage = 'Could not load the reports. Please try again.';
            this.cdr.markForCheck();
          },
        });
      },
      error: () => {
        this.isLoading = false;
        this.errorMessage = 'Could not load the list of report dates.';
        this.cdr.markForCheck();
      },
    });
  }
}

