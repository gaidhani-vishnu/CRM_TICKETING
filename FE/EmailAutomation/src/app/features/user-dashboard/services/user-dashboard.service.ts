import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { ConfigService } from '../../../core/services/config.service';
import { TicketVisibilityService } from '../../../core/services/ticket-visibility.service';
import { ownerOf } from '../../../shared/models/user-filter.model';
import { EmailReceiptRow } from '../../email-automation-workflow/models/email-receipt.model';
import { isListedCategory } from '../../email-automation-workflow/models/receipt-category.model';
import { TicketAcknowledgementItem } from '../../email-automation-workflow/models/ticket-acknowledgement.model';
import { EmailAutomationService } from '../../email-automation-workflow/services/email-automation.service';
import {
  ACKNOWLEDGEMENT_STEP,
  ACTION_COLUMNS,
  ActionColumnKey,
  BANK_RECONCILIATION_STEP,
  DashboardSummary,
  EMAIL_RESPONSE_STEP,
  EMAIL_VERIFICATION_STEP,
  FINAL_EMAIL_RESPONSE_STEP,
  INSTRUMENT_MATCH_STEP,
  DashboardTicket,
  DonutSlice,
  IntentCount,
  IntentGroup,
  InterventionCount,
  MatrixCell,
  MatrixRow,
  SlaBucket,
  STEP_ORDER,
  StageKey,
  StepRow,
  WORKFLOW_STAGES,
  emptyDashboardSummary,
  isAgreementRoute,
  workflowRoute,
} from '../models/user-dashboard.model';
import { AGREEMENT_STEPS } from '../../email-automation-workflow/models/agreement-step.model';

/** Seconds in the two warning windows the SLA band splits "on track" into. */
const FOUR_HOURS = 4 * 60 * 60;
const EIGHT_HOURS = 8 * 60 * 60;

/**
 * A date as 'yyyy-MM-dd' on this browser's own calendar, the same shape as the
 * day at the front of a ticket's closedOn.
 *
 * Local rather than toISOString(), which is UTC: in India that still reads as
 * yesterday until 05:30, and tickets closed early in the morning would be missed.
 */
function localDateKey(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The [Action Status] values that mean the pipeline has stopped and is
 * waiting for a person, in the order the intervention panel lists them.
 *
 * A subset of THREAD_ACTION_STATUSES — 'Done' and 'Pending' are the machine's
 * own states and are deliberately not counted here.
 */
const INTERVENTION_STATUSES = [
  'User Verification Required',
  'User Intervention',
];

/**
 * Counts the User Dashboard's figures out of the row-level data the backend
 * already returns.
 *
 * Deliberately holds no HttpClient. The backend has no aggregate endpoint —
 * no dashboard route, no GROUP BY, no COUNT — so the dashboard is built from
 * `getReceipts` + `acknowledgeTickets` per date, which the component fetches
 * with forkJoin exactly as the Ticket Summary popup does. This service is the
 * pivot that runs over the result, plus the per-date cache that keeps changing
 * the user filter from refetching anything.
 */
@Injectable({ providedIn: 'root' })
export class UserDashboardService {
  /** date → the tickets that date resolved to, so a revisit costs nothing. */
  private readonly cache: { [date: string]: DashboardTicket[] } = {};

  /**
   * date → that date's listed-category receipt rows, the same rows the Email
   * Receipts grid shows. The user picker counts these rather than tickets, so
   * its figures match the Ticket Automation screen's picker exactly.
   */
  private readonly rowCache: { [date: string]: EmailReceiptRow[] } = {};

  private readonly summarySubject = new BehaviorSubject<DashboardSummary>(emptyDashboardSummary());
  readonly summary$: Observable<DashboardSummary> = this.summarySubject.asObservable();

  get currentSummary(): DashboardSummary {
    return this.summarySubject.value;
  }

  setSummary(summary: DashboardSummary): void {
    this.summarySubject.next(summary);
  }

  /**
   * Fills the KPI ribbon on app start, when no screen has counted anything yet.
   *
   * Every date the dropdown lists, not just the newest one. The Email Receipts
   * panel opens on All Dates, so a ribbon built from one date sat beside a
   * grid counting all of them and read low — 135 against the grid's 150. The
   * two now cover the same reports as well as the same categories.
   *
   * Deliberately fire-and-forget and best-effort: the ribbon is a readout, not
   * a screen, so a date that fails to load is dropped and the rest are still
   * counted rather than the ribbon showing nothing.
   */
  ensureSummaryLoaded(api: EmailAutomationService): void {
    if (this.summarySubject.value.openCount > 0) {
      return;
    }

    this.loadSummary(api);
  }

  /**
   * Re-counts the ribbon from the backend, whatever it is currently showing.
   *
   * Called when something on another screen has changed a figure here — a
   * ticket closed from the workflow pipeline moves both Open and Closed Today,
   * and neither the cache nor ensureSummaryLoaded's guard would have let the
   * new numbers through, so the ribbon kept the counts it was built with until
   * the page was reloaded.
   *
   * The per-date cache is dropped first: it holds the tickets as they were
   * before the close, so re-running the count over it would return the same
   * figures.
   */
  /**
   * Forgets everything counted for the signed-in user. Called on logout: the
   * rows were filtered to that user, and the next one to sign in on this tab
   * must not start from them.
   */
  reset(): void {
    this.clearCache();
    this.setSummary(emptyDashboardSummary());
  }

  refreshSummary(api: EmailAutomationService): void {
    this.clearCache();
    this.loadSummary(api);
  }

  /** Reads every listed date and republishes the ribbon from all of them. */
  private loadSummary(api: EmailAutomationService): void {
    api.getAvailableDates().subscribe({
      next: (dates) => {
        if (!dates || dates.length === 0) {
          return;
        }

        forkJoin(dates.map((d) => this.loadOne(api, d.date))).subscribe({
          next: (perDate) => {
            const all: DashboardTicket[] = [];

            for (const tickets of perDate) {
              for (const ticket of tickets) {
                all.push(ticket);
              }
            }

            this.setSummary(this.summarize(all));
          },
          error: () => {},
        });
      },
      error: () => {},
    });
  }

  /**
   * One date's tickets, from the cache when that date has already been read.
   *
   * Never errors: a date the backend cannot serve resolves to no tickets, so
   * one bad report cannot empty the whole ribbon.
   */
  private loadOne(api: EmailAutomationService, date: string): Observable<DashboardTicket[]> {
    const cached = this.getCached(date);

    if (cached) {
      return of(cached);
    }

    return forkJoin({
      receipts: api.getReceipts(date),
      tickets: api.acknowledgeTickets(date),
    }).pipe(
      map((res) =>
        this.join(
          res.receipts.rows || [],
          res.tickets.tickets || [],
          res.tickets.closedTickets || [],
          date
        )
      ),
      catchError(() => of([] as DashboardTicket[]))
    );
  }

  constructor(
    private readonly config: ConfigService,
    private readonly visibility: TicketVisibilityService
  ) {}

  /**
   * The configured CRM head — who a thread with a blank [Assigned To] belongs
   * to — by mailbox, the way the column stores it.
   */
  get crmHeadName(): string {
    return this.config.mailboxOf(this.config.fallbackUser.emailId || this.config.fallbackUser.name);
  }

  /** The mailbox an [Assigned To] value files under — an older row's name included. */
  ownerKey(value: string): string {
    return this.config.mailboxOf(value);
  }

  /** The tickets already loaded for a date, or null if it has not been read. */
  getCached(date: string): DashboardTicket[] | null {
    return this.cache[date] || null;
  }

  /** The listed receipt rows already loaded for a date, or an empty list. */
  getCachedRows(date: string): EmailReceiptRow[] {
    return this.rowCache[date] || [];
  }

  /** Drops every cached date, so the next load re-reads from the backend. */
  clearCache(): void {
    for (const key of Object.keys(this.cache)) {
      delete this.cache[key];
    }

    for (const key of Object.keys(this.rowCache)) {
      delete this.rowCache[key];
    }
  }

  /**
   * Folds one date's receipts and its tickets into flat dashboard records.
   *
   * Joined on threadId, the same key the Ticket Summary popup joins on. A
   * thread with no ticket is skipped rather than counted as an untracked one:
   * every figure on this screen is a count of tickets.
   *
   * The lookup is built from listed categories only, and a ticket that finds
   * no row in it is dropped. Node 1 raises a ticket for every thread on the
   * date whatever its Category, so without this the ribbon counted the
   * Payment - Unverified threads that the Email Receipts grid has never shown,
   * and the two numbers on the workflow screen disagreed. Nothing is lost by
   * requiring the row: both the open and the closed ticket lists are read
   * against that date's own threads.
   *
   * Payment - Loan/Bank needs nothing special either. Its rows arrive already
   * keyed on the customer rather than the email, and node 1 mints its tickets
   * on the same key, so the join lines up and one loan customer becomes one
   * ticket here — while the email they share, which the grid does not list,
   * has no ticket to find a row for.
   */
  join(
    rows: EmailReceiptRow[],
    openTickets: TicketAcknowledgementItem[],
    closedTickets: TicketAcknowledgementItem[],
    date: string
  ): DashboardTicket[] {
    const rowByThread: { [threadId: string]: EmailReceiptRow } = {};
    // A Pre_User / Pos_User counts only the threads assigned to them; their
    // tickets drop with the rows, since a ticket with no row is skipped below.
    const listed = (rows || []).filter(
      (row) => isListedCategory(row.category) && this.visibility.canSee(row.assignedTo)
    );

    for (const row of listed) {
      if (row.threadId) {
        rowByThread[row.threadId] = row;
      }
    }

    this.rowCache[date] = listed;

    const tickets: DashboardTicket[] = [];

    for (const ticket of openTickets || []) {
      const built = this.toDashboardTicket(ticket, rowByThread[ticket.threadId], date);

      if (built) {
        tickets.push(built);
      }
    }

    for (const ticket of closedTickets || []) {
      const built = this.toDashboardTicket(ticket, rowByThread[ticket.threadId], date);

      if (built) {
        tickets.push(built);
      }
    }

    this.cache[date] = tickets;

    return tickets;
  }

  /**
   * One ticket plus its receipt row, or null when the ticket has no number or
   * its thread is not one the workspace counts — see join() for why the row is
   * required rather than defaulted.
   */
  private toDashboardTicket(
    ticket: TicketAcknowledgementItem,
    row: EmailReceiptRow | undefined,
    date: string
  ): DashboardTicket | null {
    if (!ticket || !ticket.ticketId || !row) {
      return null;
    }

    const workflowStatus = ((row && row.workflowStatus) || '').trim();
    const stage = this.resolveStage(workflowStatus);
    // The raw sub-intent, not the matrix's fallback for a blank one: the
    // pipeline tests the column as stored when it decides on the agreement
    // stages, and the route here has to be the route it draws.
    const route = workflowRoute(row.category, row.intent, row.subIntent);

    return {
      threadId: ticket.threadId,
      ticketId: ticket.ticketId,
      intent: this.clean(row && row.intent, 'Unclassified'),
      subIntent: this.resolveSubIntent(row),
      category: this.clean(row && row.category, 'Others'),
      customerName: this.clean(row && row.customerName, '—'),
      customerEmail: this.clean(row && row.customerSender, ''),
      subject: this.clean(row && row.emailSubject, ''),

      stage,
      stageLabel: this.stageLabel(stage),
      workflowStatus,
      step: this.resolveStep(workflowStatus, row, route),
      route,
      actionColumn: this.resolveActionColumn(row && row.actionStatus),
      actionStatus: this.clean(row && row.actionStatus, ''),

      ticketStatus: this.clean(ticket.ticketStatus, 'Open'),
      isOpen: (ticket.ticketStatus || 'Open').trim().toLowerCase() === 'open',

      receivedOn: this.clean(ticket.emailDate || (row && row.emailDate), ''),
      slaDue: this.clean(ticket.slaDue, ''),
      slaStatus: this.clean(ticket.slaStatus, 'On Track'),
      isOverdue: (ticket.slaStatus || '').trim().toLowerCase() === 'overdue',
      slaRemainingSeconds: ticket.slaRemainingSeconds,
      createdDate: this.clean(ticket.createdDate, ''),
      closedOn: this.clean(ticket.closedOn, ''),

      assignedTo: this.resolveAssignee(row),
      project: this.clean(row && row.project, ''),
      subProject: this.clean(row && row.subProject, ''),
      unit: this.clean(row && row.unit, ''),

      sourceDate: date,
      emailLink: this.clean(ticket.emailLink || (row && row.emailLink), ''),
    };
  }

  /**
   * Which stage column a thread belongs in.
   *
   * A [Workflow Status] the pipeline has not written yet means only the ticket
   * has been raised, which is exactly the Acknowledgement column. An unknown
   * value also lands there rather than being dropped from the matrix.
   */
  private resolveStage(workflowStatus: string): StageKey {
    const match = WORKFLOW_STAGES.find((s) =>
      s.matches ? s.matches(workflowStatus) : s.workflowStatus !== '' && s.workflowStatus === workflowStatus
    );

    return match ? match.key : 'ack';
  }

  private stageLabel(stage: StageKey): string {
    const match = WORKFLOW_STAGES.find((s) => s.key === stage);

    return match ? match.label : 'Ack';
  }

  /**
   * The matrix's third level: the step the thread is waiting on.
   *
   * [Workflow Status] is written as one phrase — "Pending Unit Match" — so the
   * step is what is left once the state in front is taken off, the same way
   * the Email Receipts grid reads it (pendingStep() in email-receipts-table.ts).
   * A blank one means only the ticket has been raised.
   *
   * That name is then brought into line with the thread's own route, because
   * the column does not always spell a step the way its pipeline card does:
   *
   *   • "Customer Email Match" is the card titled Customer Email Verification.
   *   • "Email Response" on a payment thread is its Final Email Response — the
   *     plain reply is not a step of that route.
   *   • "Instrument Match" / "Bank Reconciliation" on a non-payment thread is a
   *     value left from before those threads had a route of their own; the
   *     pipeline shows such a thread at its first unfinished agreement stage,
   *     or at the reply (alignNonPaymentStatus() in workflow-visualizer.ts),
   *     and so does this.
   *
   * A value none of that recognises is kept whole rather than dropped from the
   * matrix, and gets a row of its own after the route.
   */
  private resolveStep(workflowStatus: string, row: EmailReceiptRow, route: string[]): string {
    if (workflowStatus === '') {
      return ACKNOWLEDGEMENT_STEP;
    }

    const leading = /^pending\s+(\S.*)$/i.exec(workflowStatus);
    let step = leading ? leading[1].trim() : workflowStatus;

    if (step.toLowerCase() === 'customer email match') {
      step = EMAIL_VERIFICATION_STEP;
    }

    if (route.indexOf(step) !== -1) {
      return step;
    }

    if (step === EMAIL_RESPONSE_STEP && route.indexOf(FINAL_EMAIL_RESPONSE_STEP) !== -1) {
      return FINAL_EMAIL_RESPONSE_STEP;
    }

    const isMoneyStep = step === INSTRUMENT_MATCH_STEP || step === BANK_RECONCILIATION_STEP;

    if (isMoneyStep && route.indexOf(EMAIL_RESPONSE_STEP) !== -1) {
      const verdicts = row.agreementSteps || {};
      const pending = isAgreementRoute(row.category, row.intent, row.subIntent)
        ? AGREEMENT_STEPS.find(
            (stage) => (verdicts[stage.stepKey] || '').trim().toLowerCase() !== 'match'
          )
        : undefined;

      return pending ? pending.title : EMAIL_RESPONSE_STEP;
    }

    return step;
  }

  /**
   * Which matrix column an [Action Status] counts under.
   *
   * Processing takes whatever the other three do not claim: 'Pending', a blank
   * — the column is only written once a thread has been opened in the workflow
   * screen — and any value this does not recognise, so every open ticket lands
   * in exactly one column and the row totals add up to the open count.
   */
  private resolveActionColumn(actionStatus: string | undefined): ActionColumnKey {
    const status = (actionStatus || '').trim().toLowerCase();
    const match = ACTION_COLUMNS.find((column) =>
      column.statuses.some((value) => value.toLowerCase() === status)
    );

    return match ? match.key : 'processing';
  }

  /**
   * The matrix's second level.
   *
   * [Sub-Intent] is the finer of the two AI classifications and is what the
   * matrix wants; rows the model only classified coarsely fall back to
   * [Intent] rather than collapsing into one nameless line.
   */
  private resolveSubIntent(row: EmailReceiptRow | undefined): string {
    const subIntent = ((row && row.subIntent) || '').trim();

    if (subIntent !== '') {
      return subIntent;
    }

    const intent = ((row && row.intent) || '').trim();

    return intent !== '' ? intent : 'General / Unclassified';
  }

  /**
   * The thread's CRM owner, by the same rule the Ticket Automation screen's
   * picker uses: [Assigned To], or the CRM head when it is blank. Filtering by
   * an owner here must land on the same threads it does there.
   */
  private resolveAssignee(row: EmailReceiptRow | undefined): string {
    return ownerOf(row && row.assignedTo, this.crmHeadName, (value) => this.ownerKey(value));
  }

  private clean(value: string | undefined, fallback: string): string {
    const trimmed = (value || '').trim();

    return trimmed !== '' ? trimmed : fallback;
  }

  // ── The pivot ───────────────────────────────────────────────

  /**
   * Counts every figure on the screen in one pass over the open tickets.
   *
   * Open only, for everything except the Closed tile: the donut is titled
   * "Intent Wise Open Ticket Count", the matrix answers "where is the work
   * stuck", and both would be meaningless if settled tickets were folded in.
   */
  summarize(tickets: DashboardTicket[]): DashboardSummary {
    if (!tickets || tickets.length === 0) {
      return emptyDashboardSummary();
    }

    const open = this.openTicketsOf(tickets);
    const closedCount = this.closedTodayTicketIdsOf(tickets).length;

    if (open.length === 0) {
      const empty = emptyDashboardSummary();
      empty.closedCount = closedCount;

      return empty;
    }

    const overdueCount = open.filter((t) => t.isOverdue).length;

    const byIntent: { [name: string]: number } = {};
    const byStatus: { [status: string]: number } = {};
    const groupsByIntent: { [name: string]: { [subIntent: string]: MatrixRow } } = {};

    let paymentCount = 0;
    const buckets = { onTrack: 0, due8: 0, due4: 0, breach: 0 };

    for (const ticket of open) {
      byIntent[ticket.intent] = (byIntent[ticket.intent] || 0) + 1;

      // The Open tile's Payment / Non-Payment split is the one figure still
      // read off Category: it is a property of the thread's kind, not of what
      // the customer was asking for.
      if (ticket.category.toLowerCase().indexOf('non-payment') === -1 &&
          ticket.category.toLowerCase().indexOf('payment') !== -1) {
        paymentCount++;
      }

      if (ticket.actionStatus !== '' && INTERVENTION_STATUSES.indexOf(ticket.actionStatus) !== -1) {
        byStatus[ticket.actionStatus] = (byStatus[ticket.actionStatus] || 0) + 1;
      }

      this.bucket(ticket, buckets);

      if (!groupsByIntent[ticket.intent]) {
        groupsByIntent[ticket.intent] = {};
      }

      const rows = groupsByIntent[ticket.intent];

      if (!rows[ticket.subIntent]) {
        rows[ticket.subIntent] = this.emptyMatrixRow(ticket.intent, ticket.subIntent);
      }

      const row = rows[ticket.subIntent];

      // The whole route goes in, not just the step this ticket is on, so each
      // step can be numbered by its place in the workflow (see toGroups(),
      // which then drops the steps nobody is waiting at). Tickets of one
      // sub-intent can run different routes — a system-raised one beside a
      // customer's — and the rows are then the union of them.
      for (const step of ticket.route.concat([ticket.step])) {
        if (!row.steps.some((s) => s.step === step)) {
          row.steps.push(this.emptyStepRow(ticket.intent, ticket.subIntent, step));
        }
      }

      const stepRow = row.steps.find((s) => s.step === ticket.step) as StepRow;

      // Counted once, on the step the ticket is on, and carried up to its
      // sub-intent — so a sub-intent line is always the sum of its step lines.
      this.count(stepRow, ticket);
      this.count(row, ticket);
    }

    const intents = this.toIntentCounts(byIntent, open.length);

    return {
      openCount: open.length,
      closedCount,
      overdueCount,
      slaPercent: this.percent(open.length - overdueCount, open.length),
      overduePercent: this.percent(overdueCount, open.length),
      paymentCount,
      nonPaymentCount: open.length - paymentCount,
      intents,
      intentSlices: this.toSlices(intents),
      interventions: this.toInterventions(byStatus),
      interventionTotal: INTERVENTION_STATUSES.reduce(
        (sum, status) => sum + (byStatus[status] || 0),
        0
      ),
      slaBuckets: this.toSlaBuckets(buckets, open.length),
      groups: this.toGroups(groupsByIntent, byIntent, intents),
    };
  }

  /** Adds one ticket to a matrix line: its action-status cell, and the line's total. */
  private count(line: { cells: MatrixCell[]; total: MatrixCell }, ticket: DashboardTicket): void {
    const cell = line.cells.find((c) => c.column === ticket.actionColumn);

    if (cell) {
      cell.total++;
      if (ticket.isOverdue) {
        cell.overdue++;
      }
    }

    line.total.total++;
    if (ticket.isOverdue) {
      line.total.overdue++;
    }
  }

  /**
   * The open half of the workload, by subtraction rather than by ticket status.
   *
   * Node 1 raises a fresh open ticket for a thread the moment its last one is
   * closed, so a settled thread holds two: THR-fee2d5a7 carries closed
   * TKT-2026-000093 and open TKT-2026-000194 at once. Read by status alone it
   * would be counted on both sides — Open and Closed describing the same
   * thread — and Open would run one ahead of the Email Receipts grid, which
   * has always subtracted instead (openRowsOf() in email-receipts-table.ts).
   * The same rule here is what keeps the ribbon's figure and the count beside
   * "Email Receipts" reading alike.
   */
  openTicketsOf(tickets: DashboardTicket[]): DashboardTicket[] {
    const settled: { [threadId: string]: true } = {};

    for (const ticket of tickets) {
      if (!ticket.isOpen) {
        settled[ticket.threadId] = true;
      }
    }

    return tickets.filter((t) => t.isOpen && !settled[t.threadId]);
  }

  /**
   * The distinct tickets closed today, which is the ribbon's "Closed Today".
   *
   * Only today, whichever report dates are loaded. All Dates reads every
   * report, and counting every closed ticket among them made the tile a
   * running total that only grew. The day is read off [SLA_Closed_On], and a
   * ticket closed before that stamp existed has none, so it is never today.
   *
   * By ticket rather than by row: All Dates merges every report, so a thread
   * written in on two days carries two records behind the one closed ticket
   * and would otherwise be counted twice. The grid's Closed pill dedupes the
   * same way, for the same reason.
   */
  private closedTodayTicketIdsOf(tickets: DashboardTicket[]): string[] {
    const today = localDateKey(new Date());
    const seen: { [ticketId: string]: true } = {};

    for (const ticket of tickets) {
      // closedOn is 'yyyy-MM-dd HH:mm:ss', so its first ten characters are the day.
      if (!ticket.isOpen && ticket.closedOn.slice(0, 10) === today) {
        seen[ticket.ticketId] = true;
      }
    }

    return Object.keys(seen);
  }

  /**
   * Places one ticket in an SLA bar.
   *
   * Breach is taken from the backend's own SLA_Status rather than from the
   * seconds, because that is the value the database has actually recorded;
   * the remaining seconds only split the rest into the two warning windows.
   * A ticket with no creation stamp has no countdown and counts as on track.
   */
  private bucket(
    ticket: DashboardTicket,
    buckets: { onTrack: number; due8: number; due4: number; breach: number }
  ): void {
    if (ticket.isOverdue) {
      buckets.breach++;
      return;
    }

    const seconds = ticket.slaRemainingSeconds;

    if (seconds === null) {
      buckets.onTrack++;
    } else if (seconds < 0) {
      buckets.breach++;
    } else if (seconds < FOUR_HOURS) {
      buckets.due4++;
    } else if (seconds < EIGHT_HOURS) {
      buckets.due8++;
    } else {
      buckets.onTrack++;
    }
  }

  /**
   * Intents as legend rows, biggest first.
   *
   * Every intent gets a row and an arc of its own — nothing is folded into an
   * 'Others'. The Intent table right below lists every intent by name, and a
   * legend that stopped at three and summed the rest left the two cards
   * disagreeing: 'Document' was a row in the table and nowhere in the donut.
   *
   * Only the first three are coloured, though. Those are the categorical slots
   * that clear the palette's all-pairs contrast gates, and a fourth hue is not
   * available to spend here — the palette's slot 4 is yellow, and yellow beside
   * slot 2's orange fails the normal-vision separation floor outright (ΔE 13.7
   * against a floor of 15). Every intent past the third therefore wears the
   * grey slot 0, the same one its row wears in the table; they are told apart
   * by the gap between their arcs and by their names in the legend.
   */
  private toIntentCounts(
    byIntent: { [name: string]: number },
    total: number
  ): IntentCount[] {
    const parts = Object.keys(byIntent)
      .map((intent) => ({ intent, total: byIntent[intent] }))
      .sort((a, b) => b.total - a.total || a.intent.localeCompare(b.intent));

    return parts.map((part, index) => ({
      intent: part.intent,
      total: part.total,
      pct: this.percent(part.total, total),
      slot: index < 3 ? index + 1 : 0,
    }));
  }

  /** Legend rows as donut arcs. The circle's circumference is 100, so length is percentage. */
  private toSlices(intents: IntentCount[]): DonutSlice[] {
    const total = intents.reduce((sum, item) => sum + item.total, 0);

    // The gap that separates one arc from the next, in the same units as the
    // arc lengths — the surface doing the separating, never a stroke.
    const gap = intents.length > 1 ? 1.2 : 0;

    let cursor = 0;

    return intents.map((intent) => {
      const pct = total > 0 ? (intent.total / total) * 100 : 0;
      const slice: DonutSlice = {
        name: intent.intent,
        total: intent.total,
        pct,
        len: Math.max(0, pct - gap),
        offset: -cursor,
        slot: intent.slot,
      };

      cursor += pct;

      return slice;
    });
  }

  /** The three human-gate statuses, always in the same order and always all three. */
  private toInterventions(byStatus: { [status: string]: number }): InterventionCount[] {
    return INTERVENTION_STATUSES.map((status, index) => ({
      status,
      count: byStatus[status] || 0,
      slot: index + 1,
    }));
  }

  private toSlaBuckets(
    buckets: { onTrack: number; due8: number; due4: number; breach: number },
    total: number
  ): SlaBucket[] {
    return [
      { key: 'onTrack' as const, label: 'On Track', count: buckets.onTrack },
      { key: 'due8' as const, label: 'Due in 8 Hours', count: buckets.due8 },
      { key: 'due4' as const, label: 'Due in 4 Hours', count: buckets.due4 },
      { key: 'breach' as const, label: 'Breach', count: buckets.breach },
    ].map((bucket) => ({ ...bucket, pct: this.percent(bucket.count, total) }));
  }

  /**
   * The matrix, as intent blocks each holding their sub-intent rows, each of
   * those holding the steps its tickets are on.
   *
   * Blocks follow the donut's order and carry its colour slot, so the tag
   * beside an intent name is the same colour as its arc — the two views of
   * the same split never disagree.
   */
  private toGroups(
    groupsByIntent: { [name: string]: { [subIntent: string]: MatrixRow } },
    byIntent: { [name: string]: number },
    intents: IntentCount[]
  ): IntentGroup[] {
    const slotOf: { [name: string]: number } = {};

    for (const intent of intents) {
      slotOf[intent.intent] = intent.slot;
    }

    return Object.keys(groupsByIntent)
      .map((intent) => {
        const rowsMap = groupsByIntent[intent];
        const rows = Object.keys(rowsMap)
          .map((subIntent) => rowsMap[subIntent])
          .sort((a, b) => b.total.total - a.total.total || a.subIntent.localeCompare(b.subIntent));

        for (const row of rows) {
          row.steps.sort(
            (a, b) => this.stepRank(a.step) - this.stepRank(b.step) || a.step.localeCompare(b.step)
          );

          // Numbered across the whole route first, so a step keeps the number
          // its pipeline card carries; only then are the steps nobody is on
          // dropped. A dropped row is all zeros, so no total moves.
          row.steps.forEach((step, index) => (step.number = index + 1));
          row.steps = row.steps.filter((step) => step.total.total > 0);
        }

        const cells: MatrixCell[] = ACTION_COLUMNS.map((column) => {
          let columnTotal = 0;
          let columnOverdue = 0;
          for (const r of rows) {
            const c = r.cells.find((cell) => cell.column === column.key);
            if (c) {
              columnTotal += c.total;
              columnOverdue += c.overdue;
            }
          }
          return { column: column.key, total: columnTotal, overdue: columnOverdue };
        });

        const total: MatrixCell = {
          column: 'ALL',
          total: rows.reduce((acc, r) => acc + r.total.total, 0),
          overdue: rows.reduce((acc, r) => acc + r.total.overdue, 0),
        };

        return {
          intent,
          openCount: byIntent[intent] || 0,
          // An intent the donut could not colour takes the grey slot 0 — the
          // one the donut's fourth arc wears. The matrix never folds, so every
          // intent keeps its own block whether or not it got a hue.
          slot: slotOf[intent] === undefined ? 0 : slotOf[intent],
          cells,
          total,
          rows,
        };
      })
      .sort((a, b) => b.openCount - a.openCount || a.intent.localeCompare(b.intent));
  }

  /** Where a step falls in the pipeline; one the pipeline does not list goes last. */
  private stepRank(step: string): number {
    const index = STEP_ORDER.indexOf(step);

    return index === -1 ? STEP_ORDER.length : index;
  }

  private emptyCells(): MatrixCell[] {
    return ACTION_COLUMNS.map((column) => ({ column: column.key, total: 0, overdue: 0 }));
  }

  private emptyMatrixRow(intent: string, subIntent: string): MatrixRow {
    return {
      intent,
      subIntent,
      cells: this.emptyCells(),
      total: { column: 'ALL', total: 0, overdue: 0 },
      steps: [],
    };
  }

  private emptyStepRow(intent: string, subIntent: string, step: string): StepRow {
    return {
      intent,
      subIntent,
      step,
      number: 0,
      cells: this.emptyCells(),
      total: { column: 'ALL', total: 0, overdue: 0 },
    };
  }

  /** A share as a whole number of percent, guarding the zero-total case. */
  private percent(value: number, total: number): number {
    return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  }
}
