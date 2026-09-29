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
  DashboardSummary,
  DashboardTicket,
  DonutSlice,
  IntentCount,
  IntentGroup,
  InterventionCount,
  MatrixCell,
  MatrixRow,
  SlaBucket,
  StageKey,
  WORKFLOW_STAGES,
  emptyDashboardSummary,
} from '../models/user-dashboard.model';

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

  /** The configured CRM head — who a thread with a blank [Assigned To] belongs to. */
  get crmHeadName(): string {
    return this.config.fallbackUser.name;
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
    return ownerOf(row && row.assignedTo, this.crmHeadName);
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

    const byCategory: { [name: string]: number } = {};
    const byStatus: { [status: string]: number } = {};
    const groupsByCategory: { [name: string]: { [subIntent: string]: MatrixRow } } = {};

    let paymentCount = 0;
    const buckets = { onTrack: 0, due8: 0, due4: 0, breach: 0 };

    for (const ticket of open) {
      byCategory[ticket.category] = (byCategory[ticket.category] || 0) + 1;

      if (ticket.category.toLowerCase().indexOf('non-payment') === -1 &&
          ticket.category.toLowerCase().indexOf('payment') !== -1) {
        paymentCount++;
      }

      if (ticket.actionStatus !== '' && INTERVENTION_STATUSES.indexOf(ticket.actionStatus) !== -1) {
        byStatus[ticket.actionStatus] = (byStatus[ticket.actionStatus] || 0) + 1;
      }

      this.bucket(ticket, buckets);

      if (!groupsByCategory[ticket.category]) {
        groupsByCategory[ticket.category] = {};
      }

      const rows = groupsByCategory[ticket.category];

      if (!rows[ticket.subIntent]) {
        rows[ticket.subIntent] = this.emptyMatrixRow(ticket.category, ticket.subIntent);
      }

      const row = rows[ticket.subIntent];
      const cell = row.cells.find((c) => c.stage === ticket.stage);

      if (cell) {
        cell.total++;
        if (ticket.isOverdue) {
          cell.overdue++;
        }
      }

      row.total.total++;
      if (ticket.isOverdue) {
        row.total.overdue++;
      }
    }

    const intents = this.toIntentCounts(byCategory, open.length);

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
      groups: this.toGroups(groupsByCategory, byCategory, intents),
    };
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
   * Categories as legend rows, biggest first.
   *
   * Capped at three coloured slots plus a fourth, de-emphasised one: only the
   * first three categorical slots clear the palette's all-pairs contrast gates,
   * and a donut is read by comparing any arc against any other. A fourth hue is
   * not available to spend here — the palette's slot 4 is yellow, and yellow
   * beside slot 2's orange fails the normal-vision separation floor outright
   * (ΔE 13.7 against a floor of 15), which no amount of direct labelling
   * excuses.
   *
   * So the fourth arc stays grey — but it is named. Folding is only honest when
   * there is a tail to fold: with four categories the fourth arc *is* one
   * category, and calling it 'Others' hides a name the reader is looking for
   * while the Intent table right below it spells that same name out. One folded
   * category therefore keeps its own label and only two or more become 'Others'.
   */
  private toIntentCounts(
    byCategory: { [name: string]: number },
    total: number
  ): IntentCount[] {
    const ordered = Object.keys(byCategory)
      .map((intent) => ({ intent, total: byCategory[intent] }))
      .sort((a, b) => b.total - a.total || a.intent.localeCompare(b.intent));

    const top = ordered.slice(0, 3);
    const folded = ordered.slice(3);
    const foldedTotal = folded.reduce((sum, item) => sum + item.total, 0);

    // One category in the fold is not a tail — it is that category, so it is
    // named. Two or more genuinely are 'Others'.
    const foldedName = folded.length === 1 ? folded[0].intent : 'Others';

    const parts = foldedTotal > 0 ? top.concat([{ intent: foldedName, total: foldedTotal }]) : top;

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
   * The matrix, as intent blocks each spanning their sub-intent rows.
   *
   * Blocks follow the donut's order and carry its colour slot, so the tag
   * beside an intent name is the same colour as its arc — the two views of
   * the same split never disagree.
   */
  private toGroups(
    groupsByCategory: { [name: string]: { [subIntent: string]: MatrixRow } },
    byCategory: { [name: string]: number },
    intents: IntentCount[]
  ): IntentGroup[] {
    const slotOf: { [name: string]: number } = {};

    for (const intent of intents) {
      slotOf[intent.intent] = intent.slot;
    }

    return Object.keys(groupsByCategory)
      .map((category) => {
        const rowsMap = groupsByCategory[category];
        const rows = Object.keys(rowsMap)
          .map((subIntent) => rowsMap[subIntent])
          .sort((a, b) => b.total.total - a.total.total || a.subIntent.localeCompare(b.subIntent));

        const cells: MatrixCell[] = WORKFLOW_STAGES.map((stage) => {
          let stageTotal = 0;
          let stageOverdue = 0;
          for (const r of rows) {
            const c = r.cells.find((cell) => cell.stage === stage.key);
            if (c) {
              stageTotal += c.total;
              stageOverdue += c.overdue;
            }
          }
          return { stage: stage.key, total: stageTotal, overdue: stageOverdue };
        });

        const total: MatrixCell = {
          stage: 'ALL',
          total: rows.reduce((acc, r) => acc + r.total.total, 0),
          overdue: rows.reduce((acc, r) => acc + r.total.overdue, 0),
        };

        return {
          intent: category,
          openCount: byCategory[category] || 0,
          // A category the donut could not colour takes the grey slot 0 — the
          // one the donut's fourth arc wears. The matrix never folds, so every
          // category keeps its own block whether or not it got a hue.
          slot: slotOf[category] === undefined ? 0 : slotOf[category],
          cells,
          total,
          rows,
        };
      })
      .sort((a, b) => b.openCount - a.openCount || a.intent.localeCompare(b.intent));
  }

  private emptyMatrixRow(intent: string, subIntent: string): MatrixRow {
    return {
      intent,
      subIntent,
      cells: WORKFLOW_STAGES.map((stage) => ({ stage: stage.key, total: 0, overdue: 0 })),
      total: { stage: 'ALL' as const, total: 0, overdue: 0 } as MatrixCell,
    };
  }

  /** A share as a whole number of percent, guarding the zero-total case. */
  private percent(value: number, total: number): number {
    return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  }
}
