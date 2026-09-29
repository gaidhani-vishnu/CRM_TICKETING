import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { Subscription } from 'rxjs';

import { ConfigService } from '../../core/services/config.service';
import { EmailAutomationService } from './services/email-automation.service';
import { EmailReceiptsTable } from './components/email-receipts-table/email-receipts-table';
import { WorkflowVisualizer } from './components/workflow-visualizer/workflow-visualizer';
import { EmailReceiptDetailRow } from './models/email-receipt-detail.model';
import { EmailReceiptRow } from './models/email-receipt.model';
import { EmailResponseTemplate } from './models/email-response.model';
import {
  EMPTY_THREAD_STAGE,
  ThreadStageCard,
  ThreadStageCardKey,
  ThreadStageView,
} from './models/thread-stage.model';
import { AGREEMENT_STEPS, agreementStepByNodeId } from './models/agreement-step.model';

/**
 * What a stage's card reads as on a thread that does not run the Agreement
 * Workflow: not on screen at all. One shared object rather than a fresh one per
 * call, since nothing ever writes to it.
 */
const HIDDEN_AGREEMENT_CARD: ThreadStageCard = { visible: false, active: false, done: false };
import { TicketAcknowledgementItem } from './models/ticket-acknowledgement.model';
import { DashboardSummary, emptyDashboardSummary } from '../user-dashboard/models/user-dashboard.model';
import { UserDashboardService } from '../user-dashboard/services/user-dashboard.service';
import { AssigneeFilterService } from '../../core/services/assignee-filter.service';
import { ALL_USERS, UserFilterOption } from '../../shared/models/user-filter.model';

@Component({
  selector: 'app-email-automation-workflow',
  standalone: false,
  templateUrl: './email-automation-workflow.html',
  styleUrl: './email-automation-workflow.scss',
})
export class EmailAutomationWorkflow implements OnInit, OnDestroy {
  @Output() switchScreen = new EventEmitter<void>();

  /**
   * A thread to open on, when the screen was reached by clicking Open on a
   * dashboard ticket rather than from the nav button.
   *
   * Only ever read while no row is selected yet: the receipts table already
   * prefers a row matching [selectedThreadId] over the first one when a load
   * settles, so handing it this is enough to land on the right thread, and
   * the pipeline then runs for that thread like any other selection.
   */
  @Input() openThreadId: string | null = null;

  /**
   * The header picker's rows, as the receipts panel last reported them.
   *
   * The panel is the only thing that knows which threads are loaded, so the
   * owners it can offer come from there rather than being counted twice.
   */
  ownerOptions: UserFilterOption[] = [];

  /** Whose threads this screen is scoped to — shared with the dashboard. */
  ownerFilter: string = ALL_USERS;

  onOwnersChanged(options: UserFilterOption[]): void {
    this.ownerOptions = options;

    // An owner who holds nothing on this screen cannot stay chosen, or the
    // grid would read empty with the header still naming a person.
    this.assigneeFilter.keepIfPresent(options.map((option) => option.value));
    this.cdr.markForCheck();
  }

  onOwnerChange(value: string): void {
    this.assigneeFilter.select(value);
  }

  summary: DashboardSummary = emptyDashboardSummary();
  private summarySubscription: Subscription | null = null;
  private ownerSubscription: Subscription | null = null;

  goToDashboard(): void {
    this.switchScreen.emit();
  }

  ngOnInit(): void {
    this.summary = this.dashboardService.currentSummary;
    this.summarySubscription = this.dashboardService.summary$.subscribe((s) => {
      this.summary = s;
      this.cdr.markForCheck();
    });
    this.dashboardService.ensureSummaryLoaded(this.api);

    // Whoever the dashboard was scoped to is who this screen opens on.
    this.ownerSubscription = this.assigneeFilter.selected$.subscribe((owner) => {
      this.ownerFilter = owner;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.stopSlaCountdown();
    this.slaSubscription?.unsubscribe();
    this.summarySubscription?.unsubscribe();
    this.ownerSubscription?.unsubscribe();
  }

  /**
   * The date whose report the pipeline is currently working — e.g. '2026-05-13'.
   * Always a concrete date once a thread is selected: every pipeline call
   * (Verify, Edit & Save, payment details, the SLA popup's default) needs to
   * know exactly which main_email_receipts_{date}.csv it is reading, All
   * Dates view or not. Set from the selected row's own row.sourceDate in
   * onRowSelected — not from the dropdown directly — since a row picked out
   * of the merged All Dates list rarely shares the dropdown's own date.
   */
  selectedDate = '';

  /**
   * The report date the Email Receipts panel displays — null for "All Dates",
   * every report merged into one list. This is the dropdown's own choice, and
   * it drives only what that panel shows; it is deliberately not what the
   * pipeline reads, which stays on selectedDate regardless of this value.
   */
  tableDate: string | null = null;

  /** Currently selected thread email receipt row. */
  selectedRow: EmailReceiptRow | null = null;

  /**
   * The owner shown on the Ticket card, as stored on the selected row.
   *
   * Written by Unit Match into main_email_receipts.[Assigned To] — the first CRM
   * user the thread's Project + Sub Project map to, or the configured CRM head
   * when the unit did not match. Blank until that step has run, and the card's
   * Assigned To box is left off entirely rather than showing a name resolved on
   * the spot for a thread nobody has placed.
   */
  get assignedTo(): string {
    return (this.selectedRow?.assignedTo || '').trim();
  }

  /** That owner's mailbox, from the master users list. '' when it has none. */
  get assignedToEmail(): string {
    const name = this.assignedTo;

    return name ? this.config.getEmailForUser(name) : '';
  }

  /** Total loaded rows count for statistics badge. */
  totalReceiptsCount = 0;

  /**
   * Threads currently on screen in the receipts list, after its search box and
   * filter pills. Shown beside the panel title, so that number describes the
   * list rather than the day.
   */
  visibleReceiptsCount = 0;

  onVisibleCountChanged(count: number): void {
    this.visibleReceiptsCount = count;
    this.cdr.markForCheck();
  }
  actionRequiredCount = 0;

  /** Active folder filter in left sidebar rail. */
  activeFolder: 'inbox' | 'important' | 'action' | 'completed' = 'inbox';

  /** Toast action message notification text. */
  actionNotice: string | null = null;

  /**
   * Bumped whenever a pipeline step rewrites the payment details file, which
   * makes <app-email-payment-details> re-read it and repaint its match pills.
   */
  paymentRefreshToken = 0;

  onPaymentDetailsChanged(): void {
    this.paymentRefreshToken++;
  }

  /**
   * Thread whose attachments popup is open, or null.
   *
   * Held rather than a plain boolean so the popup loads the folder for the thread
   * it was opened on, and so selecting a different thread closes it — the files
   * behind it would no longer be the ones on screen.
   */
  attachmentsThreadId: string | null = null;

  /**
   * Which of the two popups over part 1 was opened most recently.
   *
   * Attachments and Alert Response cover the same area at the same depth, so
   * with nothing to separate them the DOM order decides and Alert Response —
   * the later element — is always in front. Opening Attachments from behind it
   * then looked like the button did nothing. The one opened last comes forward.
   *
   * Both stay open: the popup underneath keeps its state, so closing the top
   * one puts the reviewer back where they were rather than losing a half
   * written reply.
   */
  lastOpenedPopup: 'attachments' | 'alert' | null = null;

  openAttachments(): void {
    // The email's thread, not the row's. Attachments are saved one folder per
    // Thread ID by the ingestion pipeline, and a loan row is one customer of a
    // shared email: its own customer thread id names no folder, and the files
    // being asked for are the email's.
    this.attachmentsThreadId =
      this.selectedRow?.parentThreadId || this.selectedRow?.threadId || null;
    this.lastOpenedPopup = 'attachments';
  }

  closeAttachments(): void {
    this.attachmentsThreadId = null;

    if (this.lastOpenedPopup === 'attachments') {
      this.lastOpenedPopup = null;
    }
  }

  /**
   * Row whose Alert Response popup is open, or null.
   *
   * Held as the row itself rather than a thread id, so the popup can read the
   * body and the reply straight off it. The bell selects its row on the way
   * in (see EmailReceiptsTable.openAlertPopup()), which is why onRowSelected
   * below leaves this one alone where it closes the attachments popup: the
   * selection that just happened is this popup's own.
   */
  alertPopupRow: EmailReceiptRow | null = null;

  /**
   * A reply the pipeline drafted, waiting to fill the popup's compose, or null
   * when the popup was opened from the bell with nothing to write in it.
   *
   * Held beside the row rather than pushed at the popup imperatively: both are
   * set in the same tick when Email Response opens it, and the popup needs them
   * together — the row to know whose thread it is showing, the draft to know
   * what is being said back.
   */
  alertPopupDraft: EmailResponseTemplate | null = null;

  openAlertPopup(row: EmailReceiptRow): void {
    this.alertPopupRow = row;
    this.alertPopupDraft = null;
    this.lastOpenedPopup = 'alert';
  }

  /**
   * The pipeline's Email Response button: opens the Alert Response popup on the
   * thread being worked, with the step's drafted reply already in its compose.
   *
   * The draft is for the selected row by construction — the pipeline only ever
   * drafts for the thread it is running — so that is the row the popup opens on.
   */
  openDraftedReply(template: EmailResponseTemplate): void {
    this.alertPopupRow = this.selectedRow;
    this.alertPopupDraft = template;
    this.lastOpenedPopup = 'alert';
  }

  closeAlertPopup(): void {
    this.alertPopupRow = null;
    this.alertPopupDraft = null;

    if (this.lastOpenedPopup === 'alert') {
      this.lastOpenedPopup = null;
    }
  }

  /**
   * A reply was saved from the Alert Response panel's inline compose.
   *
   * The popup owns the call and the list it repaints; all that is left up here
   * is saying so. The wording comes from the server, which is careful to say
   * "saved" and not "sent" — there is still no mail transport behind any of
   * this, and the reviewer should not be left thinking the customer has it.
   */
  onAlertReplySaved(message: string): void {
    this.triggerAction(message);

    // Answering the customer clears [Alert Received] on the server; the bell
    // follows now rather than at the next refresh. Read before the popup's
    // close, which comes straight after this and drops alertPopupRow.
    if (this.alertPopupRow) {
      this.receiptsTable?.clearAlert(this.alertPopupRow);
    }

    // A sent reply moves the thread off User Intervention, which the ribbon
    // counts. Re-read for the same reason onTicketClosed does — the ribbon's
    // per-date cache still holds the thread as it was before the reply.
    this.dashboardService.refreshSummary(this.api);
  }

  /**
   * Date the ticket summary is open on, or null.
   *
   * Opened from the receipts toolbar. The popup then owns its own date, so the
   * summary can be read for another day without moving the workflow off the
   * thread currently being worked.
   */
  summaryDate: string | null = null;

  openSummary(): void {
    this.summaryDate = this.selectedDate || null;
  }

  closeSummary(): void {
    this.summaryDate = null;
  }

  /**
   * How much of the Thread Details card is open, and which pipeline button it
   * mirrors. Driven entirely by <app-workflow-visualizer>, so the card and the
   * pipeline panel can never disagree about where the thread is.
   *
   * The card opens one section per step rather than everything at once: showing
   * the whole case up front is what made the screen hard to read.
   */
  stage: ThreadStageView = EMPTY_THREAD_STAGE;

  /** The pipeline panel, so the card's mirrored button can drive it. */
  @ViewChild(WorkflowVisualizer) private workflowVisualizer?: WorkflowVisualizer;

  @ViewChild('receiptsTable') private receiptsTable?: EmailReceiptsTable;

  /** The Thread Details scroll column, so the active card can be scrolled to. */
  @ViewChild('threadBodyContent') private threadBodyContent?: ElementRef<HTMLDivElement>;

  /**
   * Unit Match settled the thread's owner and wrote it to the receipts row.
   *
   * The row object is the one the list is rendering, so the value is already
   * there — the list just has to be told to look again, which an OnPush child
   * does not do because a parent's markForCheck.
   */
  onAssignmentChanged(): void {
    this.receiptsTable?.refreshRows();
    this.cdr.markForCheck();
  }

  /**
   * A payment card wrote a change — an account picked or cleared, a toggle
   * flipped.
   *
   * Two things follow. The pipeline re-judges the step from the rows, so its
   * buttons stop offering a move the thread no longer qualifies for; and both
   * payment cards re-read, because the two show the same payments through
   * different rules and a change on one belongs on the other. Switching a
   * payment off in Payment Details is what takes it out of Bank Reconciliation.
   */
  onPaymentRowsChanged(rows: EmailReceiptDetailRow[]): void {
    this.workflowVisualizer?.applyPaymentRows(rows);
    this.paymentRefreshToken++;
    this.cdr.markForCheck();
  }

  /**
   * The stage line's status, worded as the pipeline cards word it: WAITING is a
   * step that has stopped and needs the reviewer, so it says so.
   */
  get stageStatusLabel(): string {
    return this.stage.currentStepStatus === 'WAITING'
      ? 'User Intervention'
      : this.stage.currentStepStatus;
  }

  onStageChanged(stage: ThreadStageView): void {
    this.stage = stage;
    this.followActiveCard(stage.activeCard);
    this.cdr.markForCheck();
  }

  /**
   * The card the panel last opened by itself, so a step change can shut it again.
   *
   * Tracked rather than derived from `stage` on every pass because the stage is
   * re-emitted for things that are not step changes (a scroll, a click landing
   * outside the pipeline). Re-applying the focus on those would spring open a
   * card the reviewer had just collapsed by hand.
   */
  private activeCardKey: ThreadStageCardKey | null = null;

  /**
   * Whether `activeCardKey` has been applied for the thread on screen yet.
   *
   * `null` is a real value here — the steps past the last card (the reply, the
   * closure) have no card of their own, and the panel still has to move to
   * their action row. Without this flag a thread that opens straight onto one
   * of them reads as "already on null" and is never focused at all.
   */
  private hasAppliedActiveCard = false;

  /**
   * Moves the open card along with the pipeline: the step now in focus opens,
   * the one it came from shuts. Only ever fires on an actual step change, so a
   * card the reviewer opened or closed themselves stays as they left it.
   */
  private followActiveCard(activeCard: ThreadStageCardKey | null): void {
    if (this.hasAppliedActiveCard && activeCard === this.activeCardKey) {
      return;
    }

    if (this.activeCardKey) {
      this.setCardExpanded(this.activeCardKey, false);
    }

    if (activeCard) {
      this.setCardExpanded(activeCard, true);
    }

    this.activeCardKey = activeCard;
    this.hasAppliedActiveCard = true;

    // A step with no card of its own still has its action row at the foot of
    // the panel — that row is what the reviewer is being asked to work, so it
    // is what the panel moves to. See the fallback stageActionButton outlet.
    this.scrollActiveCardIntoView();
  }

  /**
   * Brings the card the pipeline is on into view.
   *
   * The same reason the pipeline panel scrolls itself: an agreement thread has
   * up to eighteen cards here, and one opened showing Ticket and Subject while
   * the step that was actually open sat well below the fold. The panel now
   * opens on the card the reviewer is being asked to work.
   *
   * Scrolled by the difference between the card and the panel rather than with
   * scrollIntoView(), which would scroll the page around it as well.
   */
  private scrollActiveCardIntoView(attempt = 0): void {
    // After the change-detection pass that expands the card, which under
    // zoneless CD is not reliably the very next frame - and the card grows as
    // it opens, so measuring it shut would land the scroll short. Retried for a
    // few frames, then dropped.
    requestAnimationFrame(() => {
      const panel = this.threadBodyContent?.nativeElement;

      // Matched on the marker class alone rather than on `.ai-insights-card`:
      // Payment Details and Bank Reconciliation are a component of their own and
      // carry the marker on `.payment-details-card`, so a selector naming the
      // plain card class walked straight past both of them.
      //
      // With no card in focus the target is the fallback action row instead.
      const card = (this.activeCardKey
        ? panel?.querySelector('.is-active-step')
        : panel?.querySelector(':scope > .stage-action')) as HTMLElement | null;

      if (!panel || !card || panel.scrollHeight <= panel.clientHeight) {
        if (attempt < 5) {
          this.scrollActiveCardIntoView(attempt + 1);
        }

        return;
      }

      const cardBox = card.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();

      // Aligned near the top rather than centred: a card carries its fields and
      // its row of buttons, and centring a tall one pushes the buttons off.
      const delta = cardBox.top - panelBox.top - 12;

      if (Math.abs(delta) > 8) {
        panel.scrollBy({ top: delta, behavior: 'smooth' });
      }
    });
  }

  private setCardExpanded(card: ThreadStageCardKey, expanded: boolean): void {
    // An agreement stage's card is keyed by its own node id, and there are
    // thirteen of them, so they are held in a map rather than as thirteen more
    // fields - see expandedAgreementSteps.
    if (agreementStepByNodeId(card)) {
      this.expandedAgreementSteps = { ...this.expandedAgreementSteps, [card]: expanded };
      return;
    }

    if (card === 'ticket') this.isTicketCardExpanded = expanded;
    else if (card === 'customer') this.isCustomerDetailsExpanded = expanded;
    else if (card === 'unit') this.isProjectUnitExpanded = expanded;
    else if (card === 'bankReco') this.isBankRecoExpanded = expanded;
    else this.isPaymentDetailsExpanded = expanded;
  }

  /**
   * Puts every pipeline-driven card back to shut, for a thread that has just
   * been selected. Without this a card left open on the previous thread would
   * stay open on the new one, whose pipeline may not even have reached it — the
   * stage that follows re-opens whichever step the new thread is actually on.
   */
  private resetCardExpansion(): void {
    this.activeCardKey = null;
    this.hasAppliedActiveCard = false;
    this.isTicketCardExpanded = false;
    this.isCustomerDetailsExpanded = false;
    this.isProjectUnitExpanded = false;
    this.isPaymentDetailsExpanded = false;
    this.isBankRecoExpanded = false;
    this.isSubjectExpanded = false;
    this.isMessageBodyExpanded = false;
    this.expandedAgreementSteps = {};
  }

  /**
   * The card's mirrored advance button. Handing the id straight to the pipeline
   * panel keeps one implementation of what each action does, wherever it is
   * clicked from.
   */
  onStageAction(actionId?: string): void {
    const id = actionId || this.stage.action?.id;

    if (id) {
      this.workflowVisualizer?.onPrimaryAction(id);
    }
  }

  /** Thread ID → its ticket for the loaded date, from pipeline node 1. */
  private ticketByThread: { [threadId: string]: TicketAcknowledgementItem } = {};

  /**
   * A ticket the pipeline panel just closed.
   *
   * The status lives here, one entry per thread of the date, so the panel tells
   * this component rather than every reader re-fetching: the header chip, the
   * SLA clock and the receipts grid all read from this map.
   */
  onTicketClosed(threadId: string, slaStatus = '', closedOn = ''): void {
    const ticket = this.ticketByThread[threadId];

    if (ticket) {
      ticket.ticketStatus = 'Closed';

      // Closing settled the SLA — 'Met' if the answer went out inside the
      // window, 'Overdue' if it had already run past it.
      if (slaStatus) {
        ticket.slaStatus = slaStatus;
      }

      // And when, so the pipeline's closing card can say so without waiting
      // for the date to be loaded again.
      if (closedOn) {
        ticket.closedOn = closedOn;
      }
    }

    // Nothing left to count down to on a closed ticket, and its deadline must
    // not come back if the thread is selected again.
    delete this.slaDeadlineByThread[threadId];
    this.stopSlaCountdown();
    this.cdr.markForCheck();

    // The KPI ribbon above counts this ticket in Open and, now, in Closed
    // Today. It is built once on app start and cached per date, so without
    // this it kept the figures it was born with until the page was reloaded.
    this.dashboardService.refreshSummary(this.api);
  }

  onTicketsResolved(tickets: { [threadId: string]: TicketAcknowledgementItem }): void {
    this.ticketByThread = tickets;
    this.captureSlaDeadlines(tickets);
    this.startSlaCountdown();
  }

  /**
   * Which ticket the receipts grid is showing for the selected row.
   *
   * A thread that has had a ticket closed holds two, and the grid picks
   * between them by which pill is in force. Everything here follows that
   * choice rather than resolving by thread again — the header chip and the
   * grid row have to be the same ticket.
   */
  private selectedTicketOverride: TicketAcknowledgementItem | null = null;

  onSelectedTicketChanged(ticket: TicketAcknowledgementItem | null): void {
    this.selectedTicketOverride = ticket;
    // A closed ticket has no clock left to run; a reopened selection has its
    // own. Either way the countdown is re-decided from the new ticket.
    this.startSlaCountdown();
    this.cdr.markForCheck();
  }

  /** The selected thread's ticket, or null until node 1 has resolved it. */
  private get selectedTicket(): TicketAcknowledgementItem | null {
    const threadId = this.selectedRow?.threadId;

    if (!threadId) {
      return null;
    }

    // Only while it belongs to the row on screen: the override arrives with a
    // selection and the thread can change under it.
    if (this.selectedTicketOverride?.threadId === threadId) {
      return this.selectedTicketOverride;
    }

    return this.ticketByThread[threadId] || null;
  }

  /** Ticket number for the selected thread, or '' until node 1 has resolved it. */
  get selectedTicketId(): string {
    return this.selectedTicket?.ticketId || '';
  }

  /** SLA held against the selected thread's ticket, e.g. '24 Hours'. */
  get selectedTicketSla(): string {
    return this.selectedTicket?.sla || '';
  }

  /** 'Open' / 'Closed' on the selected thread's ticket. */
  get selectedTicketStatus(): string {
    return this.selectedTicket?.ticketStatus || '';
  }

  /** True when the selected thread's ticket has been closed. */
  get isSelectedTicketClosed(): boolean {
    return this.selectedTicketStatus.trim().toLowerCase() === 'closed';
  }

  /** When the ticket was raised — where its countdown started from. */
  get selectedTicketCreatedDate(): string {
    return this.selectedTicket?.createdDate || '';
  }

  /** When its SLA runs out. */
  get selectedTicketSlaDue(): string {
    return this.selectedTicket?.slaDue || '';
  }

  /** 'On Track', 'Overdue' or 'Met', as stored against the ticket. */
  get selectedTicketSlaStatus(): string {
    return this.selectedTicket?.slaStatus || '';
  }

  /** When the selected ticket was closed, or '' while it is still open. */
  get selectedTicketClosedOn(): string {
    return this.selectedTicket?.closedOn || '';
  }

  /**
   * When the selected ticket was raised, or '' when the thread has none yet.
   *
   * The same Created_Date the SLA counts down from, shown under step 1 of the
   * pipeline - see WorkflowVisualizer.ticketCreatedOn.
   */
  get selectedTicketCreatedOn(): string {
    return this.selectedTicket?.createdDate || '';
  }

  /**
   * The SLA has run out on the selected ticket.
   *
   * True from the stored status as well as from the clock, so a ticket that was
   * already overdue when the page loaded reads as overdue immediately rather
   * than waiting for its own countdown to reach zero.
   */
  get isSelectedTicketOverdue(): boolean {
    return this.slaIsExpired || this.selectedTicketSlaStatus.trim().toLowerCase() === 'overdue';
  }

  /** The ticket was closed inside its SLA window — nothing left to count. */
  get isSelectedTicketSlaMet(): boolean {
    return this.selectedTicketSlaStatus.trim().toLowerCase() === 'met';
  }

  // ── SLA countdown ────────────────────────────────────────────

  /**
   * Live "time left" on the selected thread's SLA, e.g. "11:59:03", counting up
   * again once it has run out.
   *
   * The clock is anchored to a real instant: the ticket row's Created_Date,
   * stamped by the database when the ticket number and SLA were written. The
   * backend hands that down as slaRemainingSeconds — seconds rather than a
   * timestamp, since the browser's clock and timezone are not the server's —
   * and captureSlaDeadlines turns it into an absolute deadline once, when the
   * tickets land.
   *
   * So the same thread shows the same deadline however often it is clicked, and
   * a refresh picks it up where it was rather than starting a fresh 24 hours.
   */
  slaRemaining = '';
  slaIsExpired = false;

  /**
   * Thread ID → the wall-clock instant its SLA runs out, in this browser's own
   * time. Worked out once from the response, not per click: re-deriving it on
   * every selection is exactly what used to restart the clock.
   */
  private slaDeadlineByThread: { [threadId: string]: number } = {};

  private slaDeadline: number | null = null;
  private slaTimer: any = null;

  /** The thread whose clock is running, so a late response cannot cross wires. */
  private slaThreadId = '';

  /** The breach has been sent to the backend; it is recorded once, not per tick. */
  private slaBreachReported = false;

  private slaSubscription: Subscription | null = null;

  /**
   * Turns each ticket's "seconds left" into a deadline on this browser's clock.
   *
   * Anchored to the moment the response arrived rather than to the moment a
   * thread is clicked — otherwise a thread opened half an hour into the session
   * would be given half an hour too much.
   */
  private captureSlaDeadlines(tickets: { [threadId: string]: TicketAcknowledgementItem }): void {
    const receivedAt = Date.now();

    this.slaDeadlineByThread = {};

    Object.keys(tickets).forEach((threadId) => {
      const remaining = tickets[threadId]?.slaRemainingSeconds;

      if (remaining !== null && remaining !== undefined) {
        this.slaDeadlineByThread[threadId] = receivedAt + remaining * 1000;
      }
    });
  }

  /** Points the clock at the selected thread's deadline. */
  private startSlaCountdown(): void {
    this.stopSlaCountdown();

    const threadId = this.selectedRow?.threadId || '';
    const ticket = this.selectedTicket;
    const deadline = this.slaDeadlineByThread[threadId];

    // A closed ticket has nothing left to count: its SLA was settled when it
    // was closed. A ticket with no creation stamp yet has nothing to count from.
    if (!ticket || this.isSelectedTicketClosed || deadline === undefined) {
      this.cdr.markForCheck(); // clears any clock left from the previous thread
      return;
    }

    this.slaThreadId = threadId;
    this.slaDeadline = deadline;

    // Already recorded as breached, so reaching zero here has nothing to report.
    this.slaBreachReported = (ticket.slaStatus || '').trim().toLowerCase() === 'overdue';

    this.tickSla();
    this.slaTimer = setInterval(() => this.tickSla(), 1000);
  }

  private stopSlaCountdown(): void {
    if (this.slaTimer) {
      clearInterval(this.slaTimer);
      this.slaTimer = null;
    }

    this.slaDeadline = null;
    this.slaThreadId = '';
    this.slaBreachReported = false;
    this.slaRemaining = '';
    this.slaIsExpired = false;
  }

  private tickSla(): void {
    if (this.slaDeadline === null) {
      return;
    }

    const msLeft = this.slaDeadline - Date.now();
    this.slaIsExpired = msLeft <= 0;
    this.slaRemaining = this.formatDuration(Math.abs(msLeft));

    // This app runs zoneless (no zone.js), so a timer writing to a field does
    // not tell Angular anything — without this the clock would only visibly
    // move when some other event happened to trigger a render.
    this.cdr.markForCheck();

    // The clock keeps running past zero, counting up: how far past the SLA a
    // ticket has gone is what the reviewer needs once it has breached.
    if (this.slaIsExpired && !this.slaBreachReported) {
      this.slaBreachReported = true;
      this.reportSlaBreach(this.slaThreadId);
    }
  }

  /**
   * Records the breach against the ticket, once, at the moment it happens.
   *
   * Nothing else would notice until the next date load — the backend has no
   * scheduler — so the screen watching the clock run out is what tells it. Only
   * this one transition is sent; a ticking clock makes no calls at all.
   */
  private reportSlaBreach(threadId: string): void {
    const ticket = this.ticketByThread[threadId];

    if (!ticket?.ticketId) {
      return;
    }

    this.slaSubscription?.unsubscribe();

    this.slaSubscription = this.api.refreshSla(ticket.ticketId).subscribe({
      next: (response) => {
        if (response.slaStatus) {
          ticket.slaStatus = response.slaStatus;
        }

        this.cdr.markForCheck();
      },
      // Left as it is on screen: the next date load sweeps it anyway, and a
      // failed write is no reason to stop showing the reviewer it has run out.
      error: () => {},
    });
  }

  /** Milliseconds → HH:MM:SS. Hours are not capped — an SLA can run past 24. */
  private formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  private toastTimeout: any;

  constructor(
    private readonly config: ConfigService,
    private readonly api: EmailAutomationService,
    private readonly cdr: ChangeDetectorRef,
    private readonly dashboardService: UserDashboardService,
    private readonly assigneeFilter: AssigneeFilterService
  ) {}

  /** Controls expandable accordion for Message Body (default collapsed = false) */
  isMessageBodyExpanded = false;

  toggleMessageBody(): void {
    this.isMessageBodyExpanded = !this.isMessageBodyExpanded;
  }

  /**
   * The pipeline-driven accordions. All start shut and are opened by whichever
   * step the pipeline is on — see followActiveCard(). Toggling one by hand
   * still works and is left alone until the pipeline moves to another step.
   */
  isTicketCardExpanded = false;

  toggleTicketCard(): void {
    this.isTicketCardExpanded = !this.isTicketCardExpanded;
  }

  /* Shut by default, like every other card: the chip in its title row carries
     the whole subject, so opening it adds nothing until the reviewer asks. */
  isSubjectExpanded = false;

  toggleSubjectCard(): void {
    this.isSubjectExpanded = !this.isSubjectExpanded;
  }

  isCustomerDetailsExpanded = false;

  toggleCustomerDetailsCard(): void {
    this.isCustomerDetailsExpanded = !this.isCustomerDetailsExpanded;
  }

  /**
   * The card Unit Match opens. Assigned To no longer has an accordion of its
   * own — it is a block inside the Ticket card, so it follows that card.
   */
  isProjectUnitExpanded = false;

  toggleProjectUnitCard(): void {
    this.isProjectUnitExpanded = !this.isProjectUnitExpanded;
  }

  /**
   * The Agreement Workflow's thirteen accordions, keyed by node id.
   *
   * A map rather than thirteen fields, for the same reason the cards themselves
   * are one *ngFor and not thirteen blocks: the stages are a list, and adding
   * one should not mean adding a field, a toggle and a branch. Missing means
   * shut, which is how every card starts.
   */
  expandedAgreementSteps: { [nodeId: string]: boolean } = {};

  /** The thirteen stages, in order, for the panel to draw a card per stage. */
  readonly agreementSteps = AGREEMENT_STEPS;

  isAgreementStepExpanded(nodeId: string): boolean {
    return this.expandedAgreementSteps[nodeId] === true;
  }

  /**
   * When one stage was verified, ISO 8601, or '' when it has not been.
   *
   * Read from the row, which is where the backend's stamp is mirrored - only a
   * pass is ever stamped, so a value here always names a moment the stage
   * actually passed.
   */
  agreementStepDate(stepKey: string): string {
    return this.selectedRow?.agreementStepDates?.[stepKey] || '';
  }

  toggleAgreementStepCard(nodeId: string): void {
    this.expandedAgreementSteps = {
      ...this.expandedAgreementSteps,
      [nodeId]: !this.isAgreementStepExpanded(nodeId),
    };
  }

  /**
   * One stage's card state, or a hidden one when the thread does not run the
   * stages at all - which is what every non-agreement thread reads here.
   */
  agreementCard(nodeId: string): ThreadStageCard {
    return this.stage.agreement?.[nodeId] || HIDDEN_AGREEMENT_CARD;
  }

  /**
   * Payment Details lives in its own component, so its accordion is pushed down
   * as an input rather than read from a local field on the template.
   */
  isPaymentDetailsExpanded = false;

  /**
   * Bank Reconciliation's own card, one step further on.
   *
   * When that step becomes active this opens and Payment Details above it
   * collapses — collapses, not disappears: the card keeps its header and the
   * reviewer can open it again to read the field values while the reconciliation
   * result is on screen. followActiveCard() does the moving.
   */
  isBankRecoExpanded = false;

  /**
   * The dropdown's own choice: a real date narrows the receipts panel to it,
   * an empty one (its "All Dates" entry) puts it back to everything merged.
   * Only ever touches tableDate — the pipeline's own selectedDate is read off
   * whichever row is actually selected, not off this.
   */
  onDateSelected(dateStr: string): void {
    this.tableDate = dateStr || null;
  }

  onRowSelected(row: EmailReceiptRow): void {
    // Clicking the row that is already selected re-emits the same object, and
    // the pipeline panel — which only reacts to a changed [selectedRow] — would
    // not send a stage back. Resetting the cards on that would leave the panel
    // shut with nothing to re-open it.
    const isSameThread = this.selectedRow === row;

    this.selectedRow = row;

    // The row carries which report it came from — stamped by the receipts
    // table whether it loaded one date or merged every one of them — so the
    // pipeline always opens the file this thread actually lives in, All Dates
    // view or not.
    if (row?.sourceDate) {
      this.selectedDate = row.sourceDate;
    }

    // The open popup belongs to the thread that was selected when it opened.
    this.closeAttachments();

    if (!isSameThread) {
      // Whatever was open belonged to the previous thread's run. The pipeline
      // re-emits its stage for the new one straight after, which opens the card
      // for whichever step this thread is actually on.
      this.stage = EMPTY_THREAD_STAGE;
      this.resetCardExpansion();
    }

    this.startSlaCountdown();
  }

  onRowsLoaded(rows: EmailReceiptRow[]): void {
    this.totalReceiptsCount = rows.length;
    this.actionRequiredCount = rows.filter((r) => {
      const action = (r.actionRequired || '').trim().toLowerCase();
      return action !== '' && action !== 'no' && action !== 'none' && action !== 'n/a';
    }).length;
  }

  selectFolder(folder: 'inbox' | 'important' | 'action' | 'completed'): void {
    this.activeFolder = folder;
  }

  triggerAction(actionName: string): void {
    this.actionNotice = `Action Executed: ${actionName}`;
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = setTimeout(() => {
      this.actionNotice = null;
    }, 4000);
  }

  parseConfidence(conf: string | undefined): number {
    if (!conf) return 85;
    const val = parseFloat(conf);
    if (isNaN(val)) return 85;
    if (val <= 1.0) return Math.round(val * 100);
    return Math.round(val);
  }

  getInitials(name: string | undefined, sender: string | undefined): string {
    const target = (name || sender || 'Customer').trim();
    const parts = target.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return target.slice(0, 2).toUpperCase();
  }

  getAiDraftText(row: EmailReceiptRow): string {
    if (row.aiCustomerEmail && row.aiCustomerEmail.trim()) {
      return row.aiCustomerEmail;
    }
    const customer = row.customerName || row.customerSender || 'Valued Customer';
    const project = row.project || 'Wellington';
    return `Dear ${customer},\n\nThank you for your email regarding "${row.emailSubject || 'your inquiry'}". We have logged your request under Project ${project} (Unit: ${row.unit || 'General'}). Our automated AI Workflow Engine has classified your request as "${row.intent || 'General Ingestion'}" and routed it for immediate processing.\n\nBest regards,\nCRM Email Automation Support`;
  }
}
