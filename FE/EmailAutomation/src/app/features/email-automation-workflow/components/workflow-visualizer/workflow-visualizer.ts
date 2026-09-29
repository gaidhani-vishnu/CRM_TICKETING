import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  Output,
  OnDestroy,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { Observable, Subscription, concat, of } from 'rxjs';
import { toArray } from 'rxjs/operators';
import { EmailReceiptDetailRow } from '../../models/email-receipt-detail.model';
import { EmailReceiptRow } from '../../models/email-receipt.model';
import {
  AGREEMENT_NODE_IDS,
  AGREEMENT_STEPS,
  AgreementStep,
  nextAgreementStep,
  previousAgreementStep,
} from '../../models/agreement-step.model';
import {
  ThreadStageCard,
  ThreadStageCardKey,
  ThreadStageView,
} from '../../models/thread-stage.model';
import { CustomerBookingMatch } from '../../models/customer-email-verification.model';
import { EmailResponseTemplate } from '../../models/email-response.model';
import { WorkflowNode, WorkflowNodeAction } from '../../models/workflow-node.model';
import { ConfigService } from '../../../../core/services/config.service';
import {
  SlotAssignmentDecision,
  SlotAssignmentService,
} from '../../../../core/services/slot-assignment.service';
import { EmailAutomationService } from '../../services/email-automation.service';
import { EmailResponseTemplateService } from '../../services/email-response-template.service';
import { BankReconciliationService } from '../../services/workflow-steps/bank-reconciliation.service';
import { CustomerEmailVerificationService } from '../../services/workflow-steps/customer-email-verification.service';
import { InstrumentMatchService } from '../../services/workflow-steps/instrument-match.service';
import { AgreementStepService } from '../../services/workflow-steps/agreement-step.service';
import { UnitMatchService } from '../../services/workflow-steps/unit-match.service';
import { WorkflowStepId, WorkflowStepResult } from '../../services/workflow-steps/workflow-step.model';
import {
  WorkflowEditGroup,
  WorkflowEditRequest,
  WorkflowEditSubmission,
} from '../workflow-edit-dialog/workflow-edit-dialog.model';

/**
 * Which Thread Details card each pipeline step drives.
 *
 * One card per step, including steps 4 and 5: they read the same payment rows
 * but they are about different things — whether a row can be receipted, and
 * whether the bank statement carries the money — and sharing one card meant
 * every pill of both steps sat on every payment at once. The step with no
 * entry (Info Receipt) has no card of its own yet, so reaching it simply
 * leaves every card shut.
 */
/**
 * The card appended once the ticket is closed.
 *
 * Deliberately absent from CARD_BY_NODE below: there is no Thread Details
 * section for it, and standing here leaves every card shut — which is the right
 * reading of a thread with nothing left to work on.
 */
const TICKET_CLOSED_NODE_ID = 'node-closed';

const CARD_BY_NODE: { [nodeId: string]: ThreadStageCardKey } = {
  'node-1': 'ticket',
  'node-2': 'customer',
  'node-3': 'unit',
  'node-4': 'payments',
  'node-5': 'bankReco',
  // Each Agreement Workflow stage owns a card of its own, keyed by its node id
  // rather than by a name: the thirteen are drawn by one *ngFor over
  // AGREEMENT_STEPS, so there is no hand-written card for a name to belong to.
  ...AGREEMENT_STEPS.reduce(
    (cards, step) => ({ ...cards, [step.nodeId]: step.nodeId as ThreadStageCardKey }),
    {} as { [nodeId: string]: ThreadStageCardKey }
  ),
};

/**
 * Workflow Visualizer Component - Renders the 10 pipeline nodes and owns which
 * one is selected. Node 2 (Customer Email Verification) is backed by its step
 * service; the rest are still static. The detail panel for the selected node is
 * delegated to <app-step-inspector>.
 */
@Component({
  selector: 'app-workflow-visualizer',
  standalone: false,
  templateUrl: './workflow-visualizer.html',
  styleUrl: './workflow-visualizer.scss',
})
export class WorkflowVisualizer implements OnChanges, OnDestroy {
  @Input() selectedRow: EmailReceiptRow | null = null;
  /** Report date of the selected row, e.g. '2026-05-13'. Needed to locate its CSV. */
  @Input() date = '';

  /**
   * Ticket raised for the selected thread by node 1, e.g. 'TKT-2026-000001'.
   * Empty until it has been resolved, or when the lookup was unavailable.
   */
  @Input() ticketId = '';

  /**
   * That ticket's status, 'Open' or 'Closed'.
   *
   * Held by the parent for every thread of the date, so it is pushed down rather
   * than looked up again here. 'Closed' takes the Ticket Close button away —
   * there is nothing left to close — and closes the pipeline out: see
   * closeOutRoute().
   */
  @Input() ticketStatus = '';

  /**
   * The SLA held against that ticket, e.g. '24 Hours'.
   *
   * Pushed down like the two above rather than written here: node 1's meta used
   * to carry a hard-coded '12 Hours' that disagreed with what the backend
   * actually stores.
   */
  @Input() ticketSla = '';

  /**
   * When that ticket was closed, 'yyyy-MM-dd HH:mm:ss', or '' while it is open.
   *
   * Pushed down beside the status for the same reason: the parent already holds
   * the ticket for every thread of the date. Shown on the Ticket Closed card —
   * see ticketClosedNode().
   */
  @Input() ticketClosedOn = '';

  /**
   * When that ticket was raised - PRIDE_TICKET_ACJNOWLEDGEMENT.Created_Date,
   * ISO 8601 - or '' when the thread has no ticket yet.
   *
   * Pushed down beside the other three for the same reason: the parent already
   * holds the ticket for every thread of the date. Shown under step 1's title,
   * and it is the same stamp the SLA counts down from.
   */
  @Input() ticketCreatedOn = '';

  private get isSelectedTicketClosed(): boolean {
    return this.ticketStatus.trim().toLowerCase() === 'closed';
  }

  /**
   * Raised when a step has rewritten main_email_receipt_details_{date}.csv, so
   * the payment cards can re-read their Match/Unmatch state.
   */
  @Output() paymentDetailsChanged = new EventEmitter<void>();

  /**
   * How far the pipeline has opened for the selected thread, and the advance
   * button of the step it is on.
   *
   * The Thread Details card reveals one section per step from this, and mirrors
   * the button, so the reviewer sees only what the current step is about and can
   * work the thread without crossing to this panel.
   */
  @Output() stageChanged = new EventEmitter<ThreadStageView>();

  /**
   * Unit Match settled who owns the thread and it has been stored on the row.
   * The receipts list renders that same row object, so it is told to look again.
   */
  @Output() assignmentChanged = new EventEmitter<void>();
  @ViewChild('scrollContainer') scrollContainer?: ElementRef<HTMLDivElement>;

  selectedNodeId = 'node-2';
  actionNotice: string | null = null;
  isThreadChanging = false;
  private toastTimeout: any;
  private animTimeout: any;

  /**
   * Latest node-2 outcome for the selected thread. Held in a field because
   * getWorkflowNodes() runs on every change-detection pass and must never
   * kick off a request of its own.
   */
  /**
   * Customer Email Verification waits for the reviewer to click through from
   * Ticket Acknowledgement — it no longer runs just because a thread was picked,
   * so the pipeline reads the same way at every step.
   */
  private isEmailVerificationStarted = false;
  private emailVerification: WorkflowStepResult | null = null;
  private isVerifying = false;

  /**
   * Unit Match only starts when the reviewer clicks through from a verified
   * Customer Email Verification — it never runs on its own. Reset whenever a
   * different thread is selected.
   */
  private isUnitMatchStarted = false;
  private unitMatch: WorkflowStepResult | null = null;
  private isMatchingUnit = false;

  /**
   * Who node 3 settled on as the thread's owner, and why.
   *
   * Kept so the card can say which slot decided it, and so the gate knows
   * whether to offer the owner edit — the booking status can be one this app
   * has no stage for, and then only a person can say who should answer for the
   * thread. Null until Unit Match has run in this visit.
   */
  private unitAssignment: SlotAssignmentDecision | null = null;

  /**
   * The Agreement Workflow's state for the selected thread.
   *
   * Which stages have passed is not held here: that lives on the row, in
   * `agreementSteps`, because it is what a later visit resumes from. These
   * three are only about this visit — which stages are open, what each run
   * answered, and which call is in flight.
   *
   * A stage is "open" once the reviewer has clicked through to it, exactly as
   * Unit Match is only started by the click-through off Customer Email
   * Verification. Verifying a stage does NOT open the next one: the stage that
   * follows appears when its "Move to …" button is pressed and not before, so
   * the reviewer is never looking at a card for work that has not been handed
   * to them yet.
   *
   * Seeded from the stored verdicts when a thread is selected — see
   * seedOpenedAgreementSteps — so a thread reopened tomorrow shows the stages
   * it finished and the one it stopped on, and nothing beyond.
   *
   * All three are cleared with the rest of the pipeline when another thread is
   * selected; a stage left open would show on a thread that never reached it.
   */
  private openedAgreementSteps: { [nodeId: string]: boolean } = {};
  private agreementResults: { [nodeId: string]: WorkflowStepResult } = {};
  private verifyingAgreementNodeId = '';

  /** Same gate one step further on: Instrument Match waits on a matched unit. */
  private isInstrumentMatchStarted = false;
  private instrumentMatch: WorkflowStepResult | null = null;
  private isMatchingInstrument = false;

  /**
   * The stamps the two payment steps returned on this visit, if they have run.
   *
   * Their cards otherwise take the time from the payment rows, which are loaded
   * by the Payment Details panel — so with that panel collapsed there were no
   * rows to read and a step that had just finished printed no time at all. The
   * step's own answer needs nothing else on screen to be open, so it is
   * preferred and the rows are the fallback.
   *
   * Cleared with the rest of the pipeline when another thread is picked: a stamp
   * left behind would be printed against the new thread's cards.
   */
  private instrumentMatchStamp = '';
  private bankRecoStamp = '';

  /** And again: Bank Reconciliation waits on every payment having matched. */
  private isBankReconciliationStarted = false;
  private bankReconciliation: WorkflowStepResult | null = null;
  private isReconciling = false;

  /**
   * A full match on Unit Match / Instrument Match / Bank Reconciliation is not
   * enough, on its own, to open the step after it — the reviewer presses
   * Verify on the match itself first. True only once that explicit click has
   * come back DONE; a run kicked off by "Move to X →" on the step before it
   * lands here false, same as one that came back short of a match.
   *
   * Read through isUnitMatchConfirmed() and its two siblings in
   * getWorkflowNodes() rather than directly — those also treat the next step
   * having already started (a resumed thread, most often) as proof the
   * confirmation already happened, so a reload does not ask for it twice.
   *
   * Customer Email Verification deliberately has no equivalent: a matched
   * sender still opens Unit Match on its own, unchanged.
   */
  private unitMatchConfirmed = false;
  private instrumentMatchConfirmed = false;
  private bankReconciliationConfirmed = false;

  /**
   * True while a newly selected thread's payment verdicts are being read back.
   *
   * Holds the "Move to Instrument Match" button off Unit Match for that moment:
   * the answer may be that the step has already run, and offering to run it again
   * in the gap would be offering the reviewer a step they have finished.
   */
  private isResumingPaymentSteps = false;

  /**
   * The correction popup currently open, or null.
   *
   * A step whose source data is missing can only ever fail, so rather than run it
   * and report a foregone failure, the pipeline asks the reviewer for the value
   * first, writes it to the row, and runs the step against the corrected data.
   */
  editRequest: WorkflowEditRequest | null = null;
  isSavingEdit = false;
  editError = '';

  /**
   * A correction has been saved and the step has not been re-run since.
   *
   * Saving writes the row and stops there, deliberately: a reviewer correcting
   * four payments should not trigger four runs. But that leaves the pipeline
   * holding a verdict reached before the edit, so Verify is marked as the thing
   * to do next until it is pressed.
   */
  private needsVerify = false;

  /**
   * Payment rows of the selected thread, as of the last time a gate needed them.
   * Re-read rather than cached across gates: a step run between two gates
   * rewrites the details table's match columns.
   */
  private paymentRows: EmailReceiptDetailRow[] = [];

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly api: EmailAutomationService,
    private readonly customerEmailVerification: CustomerEmailVerificationService,
    private readonly unitMatchStep: UnitMatchService,
    private readonly agreementStep: AgreementStepService,
    private readonly instrumentMatchStep: InstrumentMatchService,
    private readonly bankReconciliationStep: BankReconciliationService,
    private readonly emailTemplates: EmailResponseTemplateService,
    // Who owns a thread is settled here, when Unit Match lands — see assignOwner().
    private readonly slotAssignment: SlotAssignmentService,
    private readonly config: ConfigService
  ) {}

  /**
   * The pipeline call currently in flight, if any.
   *
   * Every step call reads and rewrites the date's CSV on the server, so clicking
   * quickly through threads used to leave several of them running at once and
   * fighting over the same file ("the process cannot access the file…"). Holding
   * the subscription lets a new selection cancel the previous thread's call
   * before starting its own, which also stops a late reply from a thread you have
   * already navigated away from overwriting the cards.
   */
  private stepSubscription: Subscription | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selectedRow'] || changes['date']) {
      this.resetPipelineForRow();
      return;
    }

    // The ticket lookup usually lands after the row does, and node 1 is DONE
    // only once it has. Without this the panel repainted itself — STEP 01 went
    // DONE — but the parent kept the stage built before the ticket existed, so
    // the Ticket card sat there with no green check until something else
    // emitted a stage. Microtask for the same reason as the reset path: the
    // parent is mid-change-detection when its input lands.
    if (changes['ticketId']) {
      Promise.resolve().then(() => this.repaint());
    }
  }

  ngOnDestroy(): void {
    this.cancelStepInFlight();
  }

  /** Drops any running step call so it cannot land after the selection moved on. */
  private cancelStepInFlight(): void {
    if (this.stepSubscription) {
      this.stepSubscription.unsubscribe();
      this.stepSubscription = null;
    }
  }

  /**
   * Handles the primary button on the selected node's inspector.
   * Today only node 2 offers one: the click-through into Unit Match.
   */
  onPrimaryAction(actionId: string): void {
    // The Agreement Workflow's thirteen stages are matched against
    // AGREEMENT_STEPS rather than given thirteen cases each: their ids are
    // built from the same list that builds their nodes and their buttons.
    if (this.onAgreementAction(actionId)) {
      return;
    }

    if (actionId === 'start-customer-email-verification') {
      this.startCustomerEmailVerification();
      return;
    }

    if (actionId === 'start-unit-match') {
      this.startUnitMatch();
      return;
    }

    if (actionId === 'start-instrument-match') {
      this.startInstrumentMatch();
      return;
    }

    if (actionId === 'start-bank-reconciliation') {
      this.startBankReconciliation();
      return;
    }

    const row = this.selectedRow;

    if (!row) {
      return;
    }

    // Both open the same drafting flow — draftEmailResponse() already reads
    // currentStepId() to pick the right template, node 11's included.
    if (actionId === 'email-response' || actionId === 'final-email-response') {
      this.openEmailResponse(row);
      return;
    }


    // Verify: re-runs the step the reviewer is sitting on, against whatever the
    // row now holds. This is the only thing that re-runs a step after an edit —
    // saving no longer does it on its own.
    //
    // Routed through the same start* methods the pipeline uses, so a Verify on a
    // field that is still blank parks the step again with its reason rather than
    // sending an empty lookup to the backend.
    if (actionId === 'verify-customer-email') {
      this.startCustomerEmailVerification();
      return;
    }

    // These three carry `true` through to the run* method — a match reached
    // this way is one the reviewer confirmed, not just one the pipeline
    // produced on its own. See unitMatchConfirmed and its two siblings.
    if (actionId === 'verify-unit-match') {
      this.startUnitMatch(true);
      return;
    }

    if (actionId === 'verify-instrument-match') {
      this.startInstrumentMatch(true);
      return;
    }

    if (actionId === 'verify-bank-reconciliation') {
      this.startBankReconciliation(true);
      return;
    }

    // Edit & Save opens a gate's correction popup. The same builders the steps
    // used to call by themselves, so both paths ask for the same thing.
    if (actionId === 'edit-customer-sender') {
      this.openSenderEdit(row);
      return;
    }

    if (actionId === 'edit-project-unit') {
      this.openProjectUnitEdit(row);
      return;
    }

    if (actionId === 'edit-thread-owner') {
      this.openOwnerEdit(row);
      return;
    }

    if (actionId === 'edit-instrument-number') {
      this.openInstrumentEdit(row);
      return;
    }

    if (actionId === 'edit-payment-fields') {
      this.loadPaymentRows(row.threadId, (rows) => {
        // Bank Reconciliation's dialog offers only what Bank Reconciliation
        // looks at. A payment already on the books is never reconciled, so
        // correcting its fields here would ask the reviewer to fix something
        // that cannot change this step's outcome.
        const newEntries = rows.filter((payment) => this.isNewEntryRow(payment));

        if (newEntries.length > 0) {
          this.openPaymentFieldsEdit(newEntries);
        }
      });
    }
  }

  /**
   * Runs Bank Reconciliation. Only reachable once EVERY payment on the thread
   * matched its bank statement — a partial result (e.g. 2 of 3) leaves the
   * pipeline stopped at Instrument Match.
   *
   * `explicitVerify` is true only when this run was kicked off from the gate's
   * own Verify button — see runBankReconciliation().
   */
  private startBankReconciliation(explicitVerify = false): void {
    const row = this.selectedRow;

    if (this.instrumentMatch?.status !== 'DONE' || !row || !this.date) {
      return;
    }

    // Reconciliation compares instrument number AND amount against the statement
    // row, and reports the account it settled to, so a payment missing any of the
    // three cannot reconcile. The step parks on those rather than running.
    //
    // Only the new entries are checked, because they are the only ones the step
    // reconciles: a duplicate with a blank field used to park node 5 over a
    // payment it was never going to look at.
    this.loadPaymentRows(row.threadId, (rows) => {
      // Instrument Match's verdict, re-read rather than remembered. A field can
      // change after that step passed — clearing the Pride account on a card is
      // one click — and the button that got us here was drawn from the old
      // answer. The columns are the answer.
      const unfinished = rows.filter(
        (payment) => (payment.instrumentMatch || '').trim().toLowerCase() !== 'match'
      );

      if (unfinished.length > 0) {
        this.instrumentMatchConfirmed = false;
        this.instrumentMatch = this.missingFieldResult(
          'node-4',
          `${unfinished.length} payment${unfinished.length === 1 ? '' : 's'} ` +
            'no longer carry every field a receipt needs. Fix them, then press Verify.',
          {
            'Master Database': 'SALES_RECEIPT',
            'Complete': `${rows.length - unfinished.length} of ${rows.length}`,
            'Incomplete': unfinished
              .slice(0, 3)
              .map((payment) => `#${payment.paymentNo || '?'} ${this.missingFieldsOf(payment) || 'incomplete'}`)
              .join(', '),
          }
        );
        this.selectNode('node-4');
        this.openInstrumentEdit(row);
        return;
      }

      const newEntries = rows.filter((payment) => this.isNewEntryRow(payment));
      const incomplete = newEntries.filter((payment) => this.isMissingReconciliationField(payment));

      if (incomplete.length > 0) {
        this.isBankReconciliationStarted = true;
        this.bankReconciliationConfirmed = false;
        this.bankReconciliation = this.missingFieldResult(
          'node-5',
          `${incomplete.length} payment${incomplete.length === 1 ? '' : 's'} ` +
            'missing an instrument number, amount or account number. Use Edit & Save, then Verify.',
          {
            'Payments Incomplete': `${incomplete.length} of ${newEntries.length}`,
            'Bank Reco Engine': 'Automated',
          }
        );
        this.selectNode('node-5');
        this.repaint();
        return;
      }

      this.runBankReconciliation(row, explicitVerify);
    });
  }

  /**
   * A payment card wrote a change; re-judge Instrument Match from the rows it
   * sends back.
   *
   * The step's verdict is about the row's own fields, and those are editable
   * while its card is on screen — clearing a Pride account is one click. Node 4
   * would otherwise keep the DONE it earned before the change, and go on
   * offering "Move to Bank Reconciliation" for a thread that no longer qualifies.
   *
   * Only ever downgrades. Going back to DONE is Verify's job: that is the button
   * this hands the reviewer, and it re-runs the whole check rather than trusting
   * one column.
   *
   * Also keeps paymentRows current regardless of what follows — a toggle can
   * land here before Instrument Match has even run its first check, and
   * getWorkflowNodes() reads paymentRows to know whether Bank Reconciliation
   * already has a new entry queued for it, live as the reviewer switches the
   * toggle rather than only once a gate happens to re-read the file.
   */
  applyPaymentRows(rows: EmailReceiptDetailRow[]): void {
    this.paymentRows = rows;

    if (!this.isInstrumentMatchStarted || this.instrumentMatch?.status !== 'DONE' || rows.length === 0) {
      return;
    }

    const unfinished = rows.filter(
      (payment) => (payment.instrumentMatch || '').trim().toLowerCase() !== 'match'
    );

    if (unfinished.length === 0) {
      // Every row still carries its fields, so node 4's verdict stands. What the
      // reviewer can still have changed is *which* payments the money steps are
      // for — see applyDuplicateOnlyState().
      this.applyDuplicateOnlyState(rows);
      return;
    }

    this.instrumentMatch = this.missingFieldResult(
      'node-4',
      `${unfinished.length} payment${unfinished.length === 1 ? '' : 's'} ` +
        'no longer carry every field a receipt needs. Fix them, then press Verify.',
      {
        'Master Database': 'SALES_RECEIPT',
        'Complete': `${rows.length - unfinished.length} of ${rows.length}`,
        'Incomplete': unfinished
          .slice(0, 3)
          .map((payment) => `#${payment.paymentNo || '?'} ${this.missingFieldsOf(payment) || 'incomplete'}`)
          .join(', '),
      }
    );
    this.instrumentMatchConfirmed = false;

    // Anything Bank Reconciliation concluded was reached on rows that have since
    // changed, so it is no longer an answer about this thread.
    this.isBankReconciliationStarted = false;
    this.bankReconciliation = null;
    this.bankReconciliationConfirmed = false;

    this.repaint();
  }

  /**
   * Re-judges whether the thread still has money steps to run, from the entry
   * toggles as they now stand.
   *
   * `skipsNextStep` was decided when Instrument Match ran, but the toggles that
   * decide it stay live: switching the last new entry OFF leaves nothing for Bank
   * Reconciliation to look at, and switching one back ON puts the money steps
   * back. Held on the step result rather than in a second flag, so the one place
   * that reads it — isAllDuplicateThread — keeps deciding all three of which
   * cards the pipeline draws, which step the panel works, and whether node 6 is
   * open.
   *
   * Only called with node 4 DONE on rows that all carry their fields, so the
   * verdict itself is untouched: this changes what follows it, not whether it
   * passed.
   */
  private applyDuplicateOnlyState(rows: EmailReceiptDetailRow[]): void {
    const result = this.instrumentMatch;

    if (!result) {
      return;
    }

    // Every payment already on the books: nothing to reconcile, no receipt to
    // raise, and no receipt number to confirm.
    const skipsMoneySteps = !rows.some((payment) => this.isNewEntryRow(payment));

    if ((result.skipsNextStep === true) === skipsMoneySteps) {
      return;
    }

    const meta = { ...result.meta };

    if (skipsMoneySteps) {
      meta['Money Steps'] = 'Skipped — every payment is already on the books';
    } else {
      delete meta['Money Steps'];
    }

    this.instrumentMatch = { ...result, meta, skipsNextStep: skipsMoneySteps };

    // A Verify already pressed was pressed on the entries as they stood then —
    // the toggle just changed which payments "Move to Bank Reconciliation"
    // would even be for, so that confirmation no longer answers for this set
    // and is asked for again. Harmless when the thread just became an
    // all-duplicate skip instead: isInstrumentMatchConfirmed reads that state
    // as confirmed on its own, regardless of this flag.
    this.instrumentMatchConfirmed = false;

    // Whatever Bank Reconciliation concluded, it concluded about a set of
    // payments that has since changed — so it is no longer an answer about this
    // thread, either way the toggle went.
    this.isBankReconciliationStarted = false;
    this.bankReconciliation = null;
    this.bankReconciliationConfirmed = false;

    // The card the reviewer was on may have just left the pipeline (node 5
    // when the money steps go, node 6 when they come back), so the
    // highlight moves to the step the thread now stands at.
    if (this.selectedNodeId !== 'node-4') {
      this.selectNode(skipsMoneySteps ? 'node-6' : 'node-4');
      return;
    }

    this.repaint();
  }

  /**
   * Runs node 5 against the payment rows as they now stand.
   *
   * `explicitVerify` says whether this run came from the gate's own Verify
   * button rather than the click-through off Instrument Match — that is what
   * decides whether a DONE result counts as reviewer-confirmed. See
   * bankReconciliationConfirmed.
   */
  private runBankReconciliation(row: EmailReceiptRow, explicitVerify = false): void {
    this.isBankReconciliationStarted = true;
    this.isReconciling = true;
    this.bankReconciliation = null;
    this.selectNode('node-5');
    this.clearVerifyPrompt();
    this.triggerAction('Bank Reconciliation started');

    this.cancelStepInFlight();
    this.stepSubscription = this.bankReconciliationStep.evaluate({ row, date: this.date }).subscribe({
      next: (result) => {
        this.bankReconciliation = result;
        this.isReconciling = false;
        this.bankReconciliationConfirmed = explicitVerify && result.status === 'DONE';

        this.mirrorMatchStamp(result, (stamp) => (this.bankRecoStamp = stamp));

        // The step rewrote the details file's Bank Reco / Dublicate columns, so
        // the payment cards need to re-read it to repaint their pills.
        this.mirrorWorkflowStatus(row, result);
        this.paymentDetailsChanged.emit();
        this.repaint();
      },
      error: () => {
        this.isReconciling = false;
        this.bankReconciliationConfirmed = false;
        this.repaint();
      },
    });
  }

  /**
   * Runs the Instrument Match step against the bank statements. Only reachable
   * from a matched unit.
   *
   * `explicitVerify` is true only when this run came from the gate's own
   * Verify button — see runInstrumentMatch().
   */
  private startInstrumentMatch(explicitVerify = false): void {
    const row = this.selectedRow;

    if (this.unitMatch?.status !== 'DONE' || !row || !this.date) {
      return;
    }

    this.runInstrumentMatch(row, explicitVerify);
  }

  /**
   * Runs node 4 against the payment rows as they now stand.
   *
   * A run that comes back incomplete opens the correction popup itself, naming
   * the payments and the fields they are short of: the check is only ever run by
   * a deliberate click — Move to Instrument Match, or Verify — and the answer to
   * "what is missing?" is the form that fixes it.
   *
   * `explicitVerify` says whether this run came from the gate's own Verify
   * button rather than the click-through off Unit Match — that is what decides
   * whether a DONE result counts as reviewer-confirmed. See
   * instrumentMatchConfirmed.
   */
  private runInstrumentMatch(row: EmailReceiptRow, explicitVerify = false): void {
    this.isInstrumentMatchStarted = true;
    this.isMatchingInstrument = true;
    this.instrumentMatch = null;
    this.selectNode('node-4');
    this.clearVerifyPrompt();
    this.triggerAction('Instrument Match started');

    this.cancelStepInFlight();
    this.stepSubscription = this.instrumentMatchStep.evaluate({ row, date: this.date }).subscribe({
      next: (result) => {
        this.instrumentMatch = result;
        this.isMatchingInstrument = false;
        this.instrumentMatchConfirmed = explicitVerify && result.status === 'DONE';

        this.mirrorMatchStamp(result, (stamp) => (this.instrumentMatchStamp = stamp));

        // The step rewrote the payment rows' verdict columns, so the cards need
        // to re-read them for their pills and the entry toggle.
        this.mirrorWorkflowStatus(row, result);
        this.paymentDetailsChanged.emit();
        this.repaint();

        if (result.status !== 'DONE') {
          this.openInstrumentEdit(row);
        }
      },
      error: () => {
        this.isMatchingInstrument = false;
        this.instrumentMatchConfirmed = false;
        this.repaint();
      },
    });
  }

  /**
   * Runs the Unit Match step. Only reachable from a verified Customer Email
   * Verification, so an unmatched sender can never start it.
   *
   * `explicitVerify` is true only when this run traces back to the gate's own
   * Verify button — see runUnitMatch(). Threaded through every self-call below,
   * since each is still the same request working its way to a row it can run
   * the check against.
   */
  private startUnitMatch(explicitVerify = false): void {
    const row = this.selectedRow;

    if (this.emailVerification?.status !== 'DONE' || !row || !this.date) {
      return;
    }

    // Node 2 was resumed from the verdict stored on the row rather than run, so
    // its bookings were never fetched. The row needs them — it is missing a
    // field they would fill — so they are looked up now, before the checks below
    // decide there is nothing to fill them from.
    if (
      !this.bookingCandidatesLoaded &&
      this.bookingCandidates.length === 0 &&
      this.isRowMissingUnitFields(row)
    ) {
      this.loadBookingCandidates(row, () => this.startUnitMatch(explicitVerify));
      return;
    }

    // The customer holds more than one booking that fits what this thread says.
    // Which one the payment is for is theirs to decide, not ours to guess, so
    // the step parks until the Project & Unit card gets an answer.
    if (this.bookingCandidates.length > 1 && !this.selectedBooking) {
      this.isUnitMatchStarted = true;
      this.unitMatchConfirmed = false;
      this.unitMatch = this.missingFieldResult(
        'node-3',
        `This customer has ${this.bookingCandidates.length} bookings that fit. ` +
          'Choose the one this payment is for in the Project & Unit card.',
        {
          'Unit': row.unit || '—',
          'Project': row.project || '—',
          'Bookings To Choose From': String(this.bookingCandidates.length),
          'Unit Gate': 'Awaiting booking selection',
        }
      );
      this.selectNode('node-3');
      this.repaint();
      return;
    }

    // Exactly one booking fits, so there is nothing to choose: fill whatever the
    // row is missing from it and run the step against the completed row.
    //
    // Only ever attempted once — the fill calls back into this method, and a
    // booking that cannot supply every column leaves the row "missing a field"
    // afterwards, so without the guard the two would call each other for good.
    const only = this.selectedBooking || (this.bookingCandidates.length === 1 ? this.bookingCandidates[0] : null);

    if (only && !this.bookingApplyAttempted && this.isRowMissingUnitFields(row)) {
      this.applyBookingToRow(row, only, () => this.startUnitMatch(explicitVerify));
      return;
    }

    // The lookup needs Unit + sender + Project together, so a blank Project or
    // Unit parks the step instead of running it. Sub Project is offered for
    // correction too but not required — the lookup does not use it, and many
    // rows legitimately have none.
    if (!(row.project || '').trim() || !(row.unit || '').trim()) {
      this.isUnitMatchStarted = true;
      this.unitMatchConfirmed = false;
      this.unitMatch = this.missingFieldResult(
        'node-3',
        'Project and Unit are needed for this lookup. Use Edit & Save to supply them, then Verify.',
        {
          'Unit': row.unit || '—',
          'Project': row.project || '—',
          'Unit Gate': 'Missing project or unit',
        }
      );
      this.selectNode('node-3');
      this.repaint();
      return;
    }

    this.runUnitMatch(row, explicitVerify);
  }

  /**
   * Runs node 3 against the row as it now stands.
   *
   * `explicitVerify` says whether this run came from the gate's own Verify
   * button rather than the click-through off Customer Email Verification —
   * that is what decides whether a DONE result counts as reviewer-confirmed.
   * See unitMatchConfirmed.
   */
  private runUnitMatch(row: EmailReceiptRow, explicitVerify = false): void {
    this.isUnitMatchStarted = true;
    this.isMatchingUnit = true;
    this.unitMatch = null;
    this.unitAssignment = null;
    this.selectNode('node-3');
    this.clearVerifyPrompt();
    this.triggerAction('Unit Match started');

    this.cancelStepInFlight();
    this.stepSubscription = this.unitMatchStep.evaluate({ row, date: this.date }).subscribe({
      next: (result) => {
        this.unitMatch = result;
        this.isMatchingUnit = false;
        this.unitMatchConfirmed = explicitVerify && result.status === 'DONE';

        // The backend parks an unmatched unit by writing the Remark cell; mirror
        // it onto the row so the receipts card/table pill updates without a reload.
        const excelRemark = result.meta['Excel Remark'];
        if (excelRemark && excelRemark !== '—') {
          row.remark = excelRemark;
        }

        // Same as node 2 — the verdict is what a later visit resumes from.
        row.unitMatch = result.status === 'DONE' ? 'Match' : 'Unmatch';
        this.mirrorMatchStamp(result, (stamp) => (row.unitMatchDate = stamp));
        this.mirrorWorkflowStatus(row, result);

        // The unit decides who owns the thread, so its verdict is where the
        // owner is settled and stored. The booking goes with it: its stage is
        // what picks between the CRM slots.
        this.assignOwner(row, result.status === 'DONE', result.bookings?.[0] ?? null);

        // ...and it is also where the customer is told their ticket number, now
        // that the thread has been placed against a real unit.
        if (result.status === 'DONE') {
          this.acknowledgeTicket(row);
        }

        this.repaint();
      },
      error: () => {
        this.isMatchingUnit = false;
        this.unitMatchConfirmed = false;
        this.repaint();
      },
    });
  }

  /**
   * Settles who owns the thread and stores it on the receipts row.
   *
   * The booking's own stage decides, through the slots config.json puts every
   * BOOKING_STATUS_NAME under: the project + sub-project mapping says who this
   * project's executives are, the slot narrows them to whoever works that
   * stage, and the first of those owns the thread. An unmatched unit keeps the
   * old answer, the CRM head. SlotAssignmentService holds the rule itself; this
   * only feeds it and stores what it says.
   *
   * `booking` is the matched SALES_BOOKING_DETAILS row, or null when there is
   * none to read — an unmatched unit, or a thread resumed from its stored
   * verdict. A null booking on a matched unit is what raises the intervention
   * notice, since no stage means no slot.
   *
   * Resolved here rather than on the server because the slots, the statuses and
   * the project mapping all live in config.json, which only this side reads. The
   * write is its own call and its own subscription: it must not cancel — or be
   * cancelled by — the pipeline call that triggered it.
   */
  private assignOwner(
    row: EmailReceiptRow,
    unitMatched: boolean,
    booking: CustomerBookingMatch | null
  ): void {
    const decision = this.slotAssignment.resolve({
      unitMatched,
      bookingStatusName: booking?.bookingStatusName,
      project: row.project,
      subProject: row.subProject,
    });

    this.unitAssignment = decision;
    this.describeAssignment(decision, unitMatched && !booking);

    const name = (decision.user.name || '').trim();

    if (!name || !this.date) {
      return;
    }

    this.api.assignThread(this.date, row.threadId, name).subscribe({
      next: (result) => {
        row.assignedTo = result.assignedTo;
        this.assignmentChanged.emit();
        this.repaint();
      },
      // The thread is still owned by whoever the rule says; only the stored
      // copy is missing, and the next run of this step writes it again.
      error: () => undefined,
    });
  }

  /**
   * Files the Ticket Acknowledgement mail, once Unit Match has landed on a
   * match.
   *
   * The acknowledgement tells the customer their ticket number. It used to be a
   * button on the Ticket Acknowledgement card, which meant it could go out the
   * moment a ticket was minted — before the pipeline knew whether the sender
   * was even on the customer master, let alone which unit they were writing
   * about. Written here instead: Customer Email Verification has passed and the
   * unit has matched, so the thread is one the CRM can actually act on and the
   * number is worth giving out.
   *
   * Saved, not sent — PRIDE_EMAIL_REPLY is where a reply lives and there is no
   * mail transport behind it, exactly as the reviewer's own replies work.
   *
   * Its own call and its own subscription, like assignOwner's write: it must
   * neither cancel nor be cancelled by the pipeline call that triggered it.
   */
  private acknowledgeTicket(row: EmailReceiptRow): void {
    const ticketId = (this.ticketId || '').trim();

    if (!ticketId) {
      return; // no number to give them yet — node 1 has not come back
    }

    const template = this.emailTemplates.forStep('node-1', {
      row,
      ticketId,
      payments: this.paymentRows,
    });

    if (!template) {
      return;
    }

    // Verify re-runs Unit Match against a row that has already matched, and a
    // thread can be reopened any number of times, so this asks what the thread
    // already holds rather than writing a second acknowledgement each time. The
    // ticket and the subject together are what make it the same mail: a thread
    // whose ticket was closed and reopened gets a new number, and the customer
    // is owed the acknowledgement again.
    this.api.getThreadReplies(row.threadId).subscribe({
      next: (history) => {
        const subject = template.subject.trim();

        const alreadySent = (history.replies || []).some(
          (reply) =>
            (reply.ticketId || '').trim() === ticketId &&
            (reply.subject || '').trim() === subject
        );

        if (alreadySent) {
          return;
        }

        this.api
          .saveThreadReply({
            threadId: template.threadId,
            to: template.to ? [template.to] : [],
            cc: [],
            bcc: [],
            subject: template.subject,
            body: template.body,
            from: template.from,
            ticketId,
            attachments: [],
          })
          .subscribe({
            // Nothing on screen is waiting on it. The next run of this step
            // finds no acknowledgement on the thread and writes it again, which
            // is the same way a failed owner write recovers.
            error: () => undefined,
          });
      },
      error: () => undefined,
    });
  }

  /**
   * Writes the decision onto node 3's card.
   *
   * Merged into the result's own meta — the way the Excel Remark is — so the
   * Step Inspector prints it with the rest of the match without the card
   * needing to know anything about slots.
   *
   * `resumed` marks the case where the thread was replayed from its stored
   * verdict: the owner could not be worked out for want of a booking, rather
   * than because the booking's stage is unknown, and saying so tells the
   * reviewer that Verify is the cheaper fix.
   */
  private describeAssignment(decision: SlotAssignmentDecision, resumed: boolean): void {
    const meta = this.unitMatch?.meta;

    if (!meta) {
      return;
    }

    meta['Assignment Slot'] = decision.slot || 'Unknown';
    meta['Assigned To'] = decision.user.name;
    meta['Assignment'] = this.assignmentReason(decision, resumed);
  }

  private assignmentReason(decision: SlotAssignmentDecision, resumed: boolean): string {
    const head = this.config.fallbackUser.name;

    switch (decision.reason) {
      case 'unit-unmatched':
        return `Unit did not match, so ${head} owns this thread.`;

      case 'slot-mapping':
        return `${decision.user.name} is the first ${decision.slot} owner this project maps to.`;

      case 'no-slot-user':
        return decision.pool.length > 0
          ? `None of this project's owners (${decision.pool.join(', ')}) works the ${decision.slot} stage, so ${head} has it.`
          : `Nobody is set up for the ${decision.slot} stage, so ${head} has it.`;

      default:
        return resumed
          ? `User intervention required — this thread was reopened without its booking status, so ${head} holds it. Press Verify to run Unit Match again, or use Edit & Save to pick the owner.`
          : `User intervention required — the booking status is blank or is not one config.json stages, so ${head} holds it. Use Edit & Save to pick the owner.`;
    }
  }

  /** Subtitle line for node 2, covering each stage of the gate. */
  private customerEmailDetail(): string | undefined {
    if (!this.ticketId) {
      return 'Waiting on a ticket for this thread.';
    }

    if (!this.isEmailVerificationStarted) {
      return 'Ticket raised. Use "Move to Customer Email Match" on the previous step to start.';
    }

    return this.isVerifying
      ? 'Checking the sender against the customer master…'
      : this.emailVerification?.detail;
  }

  /** Subtitle line for node 3, covering each stage of the gate. */
  private unitMatchDetail(isEmailVerified: boolean): string | undefined {
    if (!this.isEmailVerificationStarted) {
      return undefined; // pipeline has not reached this step yet
    }

    if (!isEmailVerified) {
      return 'Stopped: the sender is not in the customer master.';
    }

    if (!this.isUnitMatchStarted) {
      return 'Sender verified. Use "Move to Unit Match" on the previous step to start.';
    }

    return this.isMatchingUnit ? 'Matching the unit against the booking master…' : this.unitMatch?.detail;
  }

  /** Subtitle line for node 5, covering each stage of the gate. */
  private bankReconciliationDetail(): string | undefined {
    if (this.isBankReconciliationStarted) {
      return this.isReconciling
        ? 'Reconciling instrument numbers and amounts against the statements…'
        : this.bankReconciliation?.detail;
    }

    if (!this.isInstrumentMatchStarted) {
      return undefined;
    }

    return this.instrumentMatch?.status === 'DONE'
      ? 'All payments matched. Use "Move to Bank Reconciliation" on the previous step to start.'
      : 'Stopped: not every payment was found in the bank statements.';
  }

  /**
   * Rebuilds the pipeline's state from the verdicts already stored on the row
   * ("Customer Email Match" / "Unit Match" in main_email_receipts_{date}.csv),
   * so a thread that has run before is not re-run from the start.
   *
   * Returns true when at least one step was restored, meaning the caller should
   * not kick off node 2 again.
   */
  private resumeFromStoredVerdicts(row: EmailReceiptRow): boolean {
    const emailVerdict = this.verdictOf(row.customerEmailMatch);

    if (!emailVerdict) {
      return false; // never run before — start the pipeline normally
    }

    this.emailVerification = this.storedResult(
      'node-2',
      emailVerdict,
      'Customer Email Match',
      row.customerEmailMatch as string,
      {
        'Sender Email': row.customerSender || '—',
        'Master Database': 'SALES_BOOKING_DETAILS',
      }
    );

    const unitVerdict = this.verdictOf(row.unitMatch);

    if (unitVerdict && emailVerdict === 'Match') {
      // Unit Match has run too, so node 3 is already settled and the reviewer
      // picks up at Instrument Match.
      this.isUnitMatchStarted = true;
      this.unitMatch = this.storedResult('node-3', unitVerdict, 'Unit Match', row.unitMatch as string, {
        'Unit': row.unit || '—',
        'Project': row.project || '—',
      });

      // A thread that went through Unit Match before this column existed has a
      // verdict but no owner. Settle it now, from the same verdict — the rule
      // does not depend on anything the run held in memory.
      if (!(row.assignedTo || '').trim()) {
        // No booking to read a stage off — the verdict is all the row stored —
        // so this parks the thread with the CRM head and asks for a reviewer.
        // Pressing Verify re-runs node 3, which does have the booking and
        // writes the slot's own owner over it.
        this.assignOwner(row, unitVerdict === 'Match', null);
      }

      if (unitVerdict === 'Match' && !this.isNonPaymentThread) {
        this.resumePaymentSteps(row);
      }
    }

    this.repaint();

    return true;
  }

  /**
   * Replays nodes 4 and 5 from the verdicts already on the payment rows.
   *
   * Their verdicts live per payment in main_email_receipt_details, not on the
   * receipts row, so unlike nodes 2 and 3 they cost one read — but the read is
   * worth it: without it a thread whose payments all say [Instrument Match] =
   * "Match" comes back as PENDING and asks the reviewer to run a check that has
   * already been made, and Bank Reconciliation would re-open the statement
   * workbooks to re-highlight rows it highlighted the last time round.
   *
   * Nothing is written here and nothing is re-run — the columns are read as they
   * stand, exactly as the payment cards read them.
   */
  private resumePaymentSteps(row: EmailReceiptRow): void {
    this.isResumingPaymentSteps = true;

    this.loadPaymentRows(row.threadId, (rows) => {
      this.isResumingPaymentSteps = false;

      // The read is asynchronous, so the reviewer may have moved on by now.
      if (this.selectedRow?.threadId !== row.threadId || rows.length === 0) {
        return;
      }

      const verdicts = rows.map((payment) => (payment.instrumentMatch || '').trim().toLowerCase());

      // A blank on any payment means the step has not been run for this thread,
      // or was run before a payment was added. Either way there is no verdict to
      // replay and node 4 stays PENDING.
      if (verdicts.some((verdict) => verdict !== 'match' && verdict !== 'unmatch')) {
        return;
      }

      const completeCount = verdicts.filter((verdict) => verdict === 'match').length;
      const allComplete = completeCount === rows.length;
      const newEntries = rows.filter((payment) => this.isNewEntryRow(payment));
      const duplicateCount = rows.length - newEntries.length;

      const detail = allComplete
        ? `Already checked: all ${rows.length} payment(s) carry every field a receipt needs` +
          (duplicateCount > 0 ? `, ${duplicateCount} already on the books` : '') +
          '. Step skipped.'
        : `Already checked: ${completeCount} of ${rows.length} payment(s) are complete — ` +
          'the pipeline stopped here previously.';

      const meta: { [key: string]: string } = {
        'Master Database': 'SALES_RECEIPT',
        'Payments Checked': String(rows.length),
        'Complete': `${completeCount} of ${rows.length}`,
        'Already Receipted': `${duplicateCount} of ${rows.length}`,
        'Workflow Status': row.workflowStatus || '—',
        'Source': 'Payment rows (previous run)',
        'Status': allComplete ? 'DONE' : 'WAITING',
      };

      if (!allComplete) {
        meta['Incomplete'] = rows
          .filter((payment) => (payment.instrumentMatch || '').trim().toLowerCase() !== 'match')
          .slice(0, 3)
          .map((payment) => `#${payment.paymentNo || '?'} ${payment.instrumentNumber || '(no instrument no)'}`)
          .join(', ');
      }

      this.isInstrumentMatchStarted = true;
      this.instrumentMatch = {
        stepId: 'node-4',
        status: allComplete ? 'DONE' : 'WAITING',
        detail,
        blockingReason: allComplete ? undefined : detail,
        meta,
        // Every payment already on the books: node 5 has nothing to reconcile,
        // the same conclusion a live run would reach.
        skipsNextStep: allComplete && newEntries.length === 0,
      };

      if (allComplete && newEntries.length > 0) {
        this.resumeBankReconciliation(rows, newEntries);
      }

      this.repaint();
    },
    // The rows could not be read: leave the pipeline where it was, rather than
    // holding Unit Match's button off on a promise that never arrived.
    () => {
      this.isResumingPaymentSteps = false;
    });
  }

  /**
   * Replays node 5 when every new entry on the thread already reconciled.
   *
   * The same rule Bank Reconciliation's own gate applies — [Dublicate Match]
   * = Unmatch and [Bank Reco Match] = Match — so a thread that passed it once
   * comes back passed rather than sending the reviewer through the workbooks
   * again. Anything less is left alone: node 5 stays PENDING and the reviewer
   * runs it from the button, which is what a partial result should ask for.
   */
  private resumeBankReconciliation(
    rows: EmailReceiptDetailRow[],
    newEntries: EmailReceiptDetailRow[]
  ): void {
    const reconciled = newEntries.filter(
      (payment) => (payment.bankRecoMatch || '').trim().toLowerCase() === 'match'
    );

    if (reconciled.length !== newEntries.length) {
      return;
    }

    const detail =
      `Already reconciled: all ${newEntries.length} new entry payment(s) carry ` +
      'Bank Reco Match = "Match". Step skipped.';

    this.isBankReconciliationStarted = true;
    this.bankReconciliation = {
      stepId: 'node-5',
      status: 'DONE',
      detail,
      meta: {
        'Bank Reco Engine': 'Automated',
        'Payments Checked': String(newEntries.length),
        'Reconciled': `${reconciled.length} of ${newEntries.length}`,
        'Not Reconciled': String(rows.length - newEntries.length) + ' already on the books',
        'Source': 'Payment rows (previous run)',
        'Status': 'DONE',
      },
    };
  }

  /** A payment still to be receipted — the toggle's On state, in one place. */
  private isNewEntryRow(payment: EmailReceiptDetailRow): boolean {
    return (payment.dublicateMatch || '').trim().toLowerCase() !== 'match';
  }

  /**
   * Copies the Workflow Status the step just wrote onto the row, so the receipts
   * grid and the header badge show where the thread now sits without a reload.
   */
  private mirrorWorkflowStatus(row: EmailReceiptRow, result: WorkflowStepResult): void {
    const workflowStatus = result.meta['Workflow Status'];

    if (workflowStatus && workflowStatus !== '—') {
      row.workflowStatus = workflowStatus;
    }
  }

  /**
   * Puts the stamp a step just returned onto the row, so its pipeline card
   * prints the time straight away.
   *
   * The stamp is the stored one — the backend reads back the [<step> Match Date]
   * it wrote and sends it with the verdict — so the card shows the instant that
   * was recorded, not when this browser heard about it. Without this the card
   * had the verdict but no time and stayed blank until the next page load
   * re-read the row, which is exactly what it looked like: a DONE step with
   * nothing under it.
   *
   * Only written when the step actually returned one. A step that did not match
   * is not stamped, and a blank must never wipe a stamp from an earlier match.
   */
  private mirrorMatchStamp(
    result: WorkflowStepResult,
    apply: (stamp: string) => void
  ): void {
    const stamp = (result.matchDate || '').trim();

    if (stamp.length > 0) {
      apply(stamp);
    }
  }

  /** Reads a stored cell as a verdict, ignoring blanks and anything unexpected. */
  private verdictOf(value: string | undefined): 'Match' | 'Unmatch' | null {
    const normalized = (value || '').trim().toLowerCase();

    if (normalized === 'match') {
      return 'Match';
    }

    return normalized === 'unmatch' ? 'Unmatch' : null;
  }

  /** A step result rebuilt from the file rather than from a fresh run. */
  private storedResult(
    stepId: WorkflowStepResult['stepId'],
    verdict: 'Match' | 'Unmatch',
    columnName: string,
    cellValue: string,
    meta: { [key: string]: string }
  ): WorkflowStepResult {
    const matched = verdict === 'Match';
    const detail = matched
      ? `Already ${columnName} = "${cellValue}" on this row — step skipped.`
      : `Already ${columnName} = "${cellValue}" on this row — the pipeline stopped here previously.`;

    return {
      stepId,
      status: matched ? 'DONE' : 'WAITING',
      detail,
      blockingReason: matched ? undefined : detail,
      meta: {
        ...meta,
        [columnName]: cellValue,
        'Source': 'Excel (previous run)',
        'Status': matched ? 'DONE' : 'WAITING',
      },
    };
  }

  /**
   * Puts the pipeline back to the start for a newly selected thread.
   *
   * Nothing is run here: Customer Email Verification waits for the reviewer to
   * click through from Ticket Acknowledgement, the same as every later step.
   * The one exception is a thread that has been through the pipeline before —
   * its stored verdicts are replayed so the run picks up where it left off.
   */
  private resetPipelineForRow(): void {
    // A different thread was picked — drop whatever the last one still had running.
    this.cancelStepInFlight();
    this.isResettingForRow = true;

    this.isEmailVerificationStarted = false;
    this.emailVerification = null;
    this.isVerifying = false;
    this.bookingCandidates = [];
    this.selectedBooking = null;
    this.bookingCandidatesLoaded = false;
    this.bookingApplyAttempted = false;
    this.instrumentMatchStamp = '';
    this.bankRecoStamp = '';
    this.isUnitMatchStarted = false;
    this.unitMatch = null;
    this.unitAssignment = null;
    this.unitMatchConfirmed = false;
    this.lastScrolledStepId = '';
    this.openedAgreementSteps = {};
    this.agreementResults = {};
    this.verifyingAgreementNodeId = '';
    this.isInstrumentMatchStarted = false;
    this.instrumentMatch = null;
    this.instrumentMatchConfirmed = false;
    this.isBankReconciliationStarted = false;
    this.bankReconciliation = null;
    this.bankReconciliationConfirmed = false;
    this.isReconciling = false;
    this.isResumingPaymentSteps = false;
    this.needsVerify = false;
    // A different thread's key must never suppress this one's first push —
    // see syncActionStatus().
    this.lastPushedActionStatus = '';

    // A popup left open belongs to the thread that was selected when it opened,
    // and so does a question left unanswered.
    this.closeEdit();
    this.isClosingTicket = false;
    this.paymentRows = [];

    const row = this.selectedRow;

    // A thread whose verdict is already on the row has been through this step
    // before. Replay what the file says instead of running the whole pipeline
    // again — that also picks the run back up at whichever step is still blank.
    //
    // Skipped for a system-raised thread: those two steps are not on its
    // pipeline, so replaying a verdict from a row that once carried them (one
    // re-categorised since, most likely) would put the Customer Details and
    // Project & Unit cards back on screen for steps its pipeline does not show.
    if (row && this.date && !this.isNonPaymentSystemThread && this.resumeFromStoredVerdicts(row)) {
      this.isEmailVerificationStarted = true;
    }

    if (row) {
      // Which of the thirteen this thread has already been handed, before
      // anything else reads them. Nothing later in the reset opens a stage.
      this.seedOpenedAgreementSteps();
      this.alignNonPaymentStatus(row);
    }

    // Trigger staggered entry animation on thread switch
    this.isThreadChanging = true;
    if (this.animTimeout) {
      clearTimeout(this.animTimeout);
    }
    this.animTimeout = setTimeout(() => {
      this.isThreadChanging = false;
      this.cdr.markForCheck();
    }, 600);

    // The reset itself is done; the new thread's stage goes out on a microtask,
    // once the parent's change-detection pass that triggered it has finished.
    this.isResettingForRow = false;
    Promise.resolve().then(() => {
      this.repaint();
      this.completeUnitFieldsFromBooking();
    });
  }

  /**
   * Fills a verified thread's missing Project / Sub Project / Unit as soon as it
   * is selected, without waiting to be asked.
   *
   * A thread verified on an earlier visit comes back with node 2 already DONE,
   * so there is no "Move to Unit Match" button to press — the click that used to
   * carry the fill is not on screen. The reviewer would have to know to press
   * Verify on a step that looks like it has already run and failed, which is
   * exactly the state the missing fields caused.
   *
   * startUnitMatch() does the rest: it fetches the sender's bookings, fills the
   * blanks from the only one, and runs the match — or leaves the choice in the
   * Project & Unit card when the customer holds several.
   */
  private completeUnitFieldsFromBooking(): void {
    const row = this.selectedRow;

    if (!row || !this.date) {
      return;
    }

    // Only a verified sender has bookings to fill from, and only a thread whose
    // unit is still unsettled has anything to fill.
    if (this.emailVerification?.status !== 'DONE' || this.isUnitMatched) {
      return;
    }

    if (!this.isRowMissingUnitFields(row)) {
      return;
    }

    this.startUnitMatch();
  }

  // ── Booking selection (node 2 → node 3) ───────────────────────

  /**
   * The customer's bookings that fit this thread, from node 2.
   *
   * One is the ordinary case and needs no choosing. Several means the customer
   * holds more than one unit the thread could be about — the Project & Unit card
   * lists them and Unit Match waits until the reviewer says which.
   */
  bookingCandidates: CustomerBookingMatch[] = [];

  /** The one the reviewer picked, or null while the choice is open. */
  selectedBooking: CustomerBookingMatch | null = null;

  /**
   * Whether the bookings have been asked for on this thread.
   *
   * Tracked separately from the list because "none found" is an answer: without
   * it, a customer whose bookings cannot be resolved would be looked up again on
   * every attempt to start Unit Match.
   */
  private bookingCandidatesLoaded = false;

  /**
   * Whether the row has already been filled from a booking on this thread.
   *
   * The fill writes only blank columns, so a second attempt could never write
   * anything the first did not — and a booking that cannot supply every column
   * would otherwise be retried on every pass through startUnitMatch(). Cleared
   * when the thread changes, and when the reviewer picks a different booking.
   */
  private bookingApplyAttempted = false;

  /**
   * Fetches the sender's bookings for a thread that resumed from stored verdicts.
   *
   * A thread verified on an earlier visit rebuilds node 2 from the Customer Email
   * Match cell on its row, which is a verdict and nothing more — the bookings
   * behind it were never sent to the browser. Unit Match needs them to fill a
   * blank Project / Sub Project / Unit, so the same lookup node 2 makes is
   * repeated here. It is the step's own call, so the verdict it writes is the
   * one already stored.
   */
  private loadBookingCandidates(row: EmailReceiptRow, then: () => void): void {
    this.bookingCandidatesLoaded = true;
    this.isMatchingUnit = true;
    this.selectNode('node-3');
    this.repaint();

    this.cancelStepInFlight();
    this.stepSubscription = this.api.verifyCustomerEmail(this.date, row.threadId).subscribe({
      next: (response) => {
        const candidates = response.candidates?.length ? response.candidates : response.bookings || [];

        this.bookingCandidates = candidates;
        this.selectedBooking = candidates.length === 1 ? candidates[0] : null;
        this.isMatchingUnit = false;
        this.repaint();
        then();
      },
      error: () => {
        // Nothing to fill from; the checks below park the step on the missing
        // field, which is what the reviewer would see anyway.
        this.isMatchingUnit = false;
        this.repaint();
        then();
      },
    });
  }

  /** True while the card should show the list rather than the row's own values. */
  get hasBookingChoice(): boolean {
    return this.bookingCandidates.length > 1 && !this.isUnitMatched;
  }

  /** Stable identity for the radio group and the selected check. */
  bookingKey(booking: CustomerBookingMatch): string {
    return booking.accountItemNo || `${booking.projectName}|${booking.subProjectName}|${booking.unitNo}`;
  }

  isBookingSelected(booking: CustomerBookingMatch): boolean {
    return !!this.selectedBooking && this.bookingKey(this.selectedBooking) === this.bookingKey(booking);
  }

  /**
   * The reviewer picked a booking in the Project & Unit card: fill whatever the
   * row is missing from it, then run Unit Match against the completed row.
   */
  selectBooking(booking: CustomerBookingMatch): void {
    const row = this.selectedRow;

    if (!row || !this.date || this.isMatchingUnit) {
      return;
    }

    this.selectedBooking = booking;
    // A different booking is a different set of values to fill from, so the
    // one-attempt guard starts again.
    this.bookingApplyAttempted = false;
    this.repaint();

    this.applyBookingToRow(row, booking, () => this.runUnitMatch(row));
  }

  /**
   * Writes the booking's project, sub project and unit onto the row — the
   * backend fills only the columns that are blank — and then carries on.
   */
  private applyBookingToRow(
    row: EmailReceiptRow,
    booking: CustomerBookingMatch,
    then: () => void
  ): void {
    // Tried once per booking. Without this the fill and startUnitMatch call each
    // other for as long as the panel is open whenever the master cannot supply
    // one of the three — a blank SUBPROJECT_NAME, say — because the row stays
    // "missing a field" however many times it is written.
    if (this.bookingApplyAttempted || !this.isRowMissingUnitFields(row)) {
      then();
      return;
    }

    this.bookingApplyAttempted = true;

    this.cancelStepInFlight();
    this.stepSubscription = this.api
      .applyBooking(this.date, row.threadId, row.emailReceiptsId, {
        project: booking.projectName || '',
        // The row keeps the wing on its own ("A") and the unit as the number
        // alone ("1603"); the master spells them "A BUILDING" and "A 1603".
        subProject: this.wingLetter(booking),
        unit: this.unitNumberPart(booking.unitNo),
      })
      .subscribe({
        next: (response) => {
          this.applyReceiptRow(row, response.row);
          this.repaint();
          then();
        },
        error: () => {
          // Nothing was filled, so the step still has what it started with —
          // it reports the missing field itself when it runs.
          this.repaint();
          then();
        },
      });
  }

  /** True when the row is still missing something the unit lookup needs. */
  private isRowMissingUnitFields(row: EmailReceiptRow): boolean {
    return (
      this.editableValue(row.project) === '' ||
      this.editableValue(row.unit) === '' ||
      this.editableValue(row.subProject) === ''
    );
  }

  /** "B 703" → "703"; a UNIT_NO with no space has no number part. */
  private unitNumberPart(unitNo: string | undefined): string {
    const value = (unitNo || '').trim();
    const space = value.indexOf(' ');

    return space < 0 ? value : value.slice(space + 1).trim();
  }

  /**
   * The wing, as the row spells it: "A", not the master's "A BUILDING".
   *
   * Taken from UNIT_NO's prefix ("A 1603" → "A") because that is the same string
   * the unit number was split from, and falling back to the first word of
   * SUBPROJECT_NAME for a booking whose UNIT_NO carries no wing.
   */
  private wingLetter(booking: CustomerBookingMatch): string {
    const unitNo = (booking.unitNo || '').trim();
    const space = unitNo.indexOf(' ');

    if (space > 0) {
      return unitNo.slice(0, space).trim();
    }

    return (booking.subProjectName || '').trim().split(/\s+/)[0] || '';
  }

  /**
   * Puts a resumed non-payment thread's Workflow Status back in step with the
   * pipeline it actually has.
   *
   * Threads matched before non-payment got its own path were left waiting on
   * "Pending Instrument Match" — a step that no longer exists for them — and the
   * stored value is what the header badge and the receipts grid read. The row is
   * corrected here for display; the database catches up the next time Unit Match
   * runs, which now writes "Pending Email Response" for this category.
   */
  private alignNonPaymentStatus(row: EmailReceiptRow): void {
    if (!this.isNonPaymentThread || !this.isUnitMatched) {
      return;
    }

    const stale = ['pending instrument match', 'pending bank reconciliation'];

    if (stale.indexOf((row.workflowStatus || '').trim().toLowerCase()) !== -1) {
      // An agreement thread does not go from a matched unit to the reply: it
      // has thirteen stages in between, and the one it is waiting on is the
      // first that has not passed. Without this a stale row would be shown as
      // ready to answer when the agreement has not been drafted yet.
      const pending = this.isAgreementThread
        ? AGREEMENT_STEPS.find((step) => !this.isAgreementStepDone(step))
        : undefined;

      row.workflowStatus = pending ? `Pending ${pending.title}` : 'Pending Email Response';
    }
  }

  /**
   * Runs node 2. Only reachable once node 1 has a ticket number, so a thread
   * without a raised ticket cannot start the pipeline.
   */
  private startCustomerEmailVerification(): void {
    const row = this.selectedRow;

    if (!this.ticketId || !row || !this.date) {
      return;
    }

    // The sender address is the only thing node 2 looks up. With it blank the
    // step can only ever come back unmatched, so it parks without running and
    // offers the reviewer the gate row rather than opening a popup at them.
    if (!(row.customerSender || '').trim()) {
      this.isEmailVerificationStarted = true;
      this.emailVerification = this.missingFieldResult(
        'node-2',
        'Customer email is missing. Use Edit & Save to supply it, then Verify.',
        {
          'Sender Email': '—',
          'Master Database': 'SALES_BOOKING_DETAILS',
          'Verification Gate': 'Missing customer email',
        }
      );
      this.selectNode('node-2');
      this.repaint();
      return;
    }

    this.runCustomerEmailVerification(row);
  }

  /**
   * A step that cannot run because the row is missing something it needs.
   *
   * Parked as WAITING with the reason on the card, which is what puts the
   * Email Response / Verify / Edit & Save row in front of the reviewer. Nothing
   * is sent to the backend — there is nothing to look up yet.
   */
  private missingFieldResult(
    stepId: WorkflowStepId,
    reason: string,
    meta: { [key: string]: string }
  ): WorkflowStepResult {
    return {
      stepId,
      status: 'WAITING',
      detail: reason,
      blockingReason: reason,
      meta: { ...meta, 'Status': 'WAITING' },
    };
  }

  /** Runs node 2 against the row as it now stands. */
  private runCustomerEmailVerification(row: EmailReceiptRow): void {
    this.isEmailVerificationStarted = true;
    this.isVerifying = true;
    this.emailVerification = null;
    this.selectNode('node-2');
    this.clearVerifyPrompt();
    this.triggerAction('Customer Email Verification started');

    this.cancelStepInFlight();
    this.stepSubscription = this.customerEmailVerification.evaluate({ row, date: this.date }).subscribe({
      next: (result) => {
        this.emailVerification = result;
        this.isVerifying = false;

        // The bookings this sender holds that fit the thread. Unit Match runs
        // against one of them — see startUnitMatch().
        this.bookingCandidates = result.bookings || [];
        this.selectedBooking = this.bookingCandidates.length === 1 ? this.bookingCandidates[0] : null;
        this.bookingCandidatesLoaded = true;

        // The backend parks unverified threads by writing the Status cell; mirror
        // it onto the row so the receipts card/table pill updates without a reload.
        const excelStatus = result.meta['Excel Status'];
        if (excelStatus && excelStatus !== '—') {
          row.status = excelStatus;
        }

        // Mirror the verdict the backend wrote, so re-selecting this thread
        // resumes from here instead of running the step again.
        row.customerEmailMatch = result.status === 'DONE' ? 'Match' : 'Unmatch';
        this.mirrorMatchStamp(result, (stamp) => (row.customerEmailMatchDate = stamp));
        this.mirrorWorkflowStatus(row, result);

        this.repaint();
      },
      error: () => {
        this.isVerifying = false;
        this.repaint();
      },
    });
  }

  // ── Stage: what the Thread Details card is allowed to show ────

  /**
   * True only while ngOnChanges rebuilds for a newly selected row.
   *
   * The reset path runs inside the parent's own change-detection pass, so the
   * stage it produces is emitted on a microtask instead — pushing it to the
   * parent synchronously would change a binding the parent has already checked.
   */
  private isResettingForRow = false;

  /** Repaints this panel and tells the parent where the pipeline now stands. */
  private repaint(): void {
    this.cdr.markForCheck();

    if (!this.isResettingForRow) {
      this.stageChanged.emit(this.buildStage());
      this.syncActionStatus();
    }

    this.scrollCurrentStepIntoView();
  }

  /**
   * The step this panel last scrolled to, so a repaint that changed nothing
   * about where the thread stands does not yank the list back again.
   *
   * Cleared when another thread is selected: the new thread may stand on the
   * same step id as the one before it, and its list still has to be scrolled.
   */
  private lastScrolledStepId = '';

  /**
   * Brings the step the thread is currently on into view.
   *
   * A pipeline of seventeen steps does not fit the panel, so a thread eleven
   * steps in opened showing step 1 and the reviewer had to scroll to find the
   * one thing they could act on. The list now opens where the work is.
   *
   * Scrolled by the difference between the row and the panel rather than with
   * scrollIntoView(): that would scroll every ancestor too, and the three-part
   * layout would move with it. Centred rather than aligned to the top, so the
   * steps either side stay visible and the step keeps its place in the run.
   */
  private scrollCurrentStepIntoView(): void {
    const stepId = this.currentStepId();

    if (!stepId || stepId === this.lastScrolledStepId) {
      return;
    }

    this.tryScrollToStep(stepId, 0);
  }

  /**
   * One attempt at the scroll, retried across the next few frames.
   *
   * Change detection here is zoneless, so the frame after markForCheck() is not
   * reliably the frame the row is laid out in — a step whose card has only just
   * appeared is often not measurable on the first look. Rather than guess at a
   * delay, this retries until the row is there and the panel has something to
   * scroll, and gives up after a handful of frames so a step that genuinely has
   * no row (a filtered-out one) costs nothing.
   */
  private tryScrollToStep(stepId: string, attempt: number): void {
    requestAnimationFrame(() => {
      const container = this.scrollContainer?.nativeElement;
      const row = container?.querySelector(
        `.timeline-row[data-node-id="${stepId}"]`
      ) as HTMLElement | null;

      if (!container || !row || container.scrollHeight <= container.clientHeight) {
        // Left unrecorded, so the step is still treated as not yet shown.
        if (attempt < 5) {
          this.tryScrollToStep(stepId, attempt + 1);
        }

        return;
      }

      this.lastScrolledStepId = stepId;

      const rowBox = row.getBoundingClientRect();
      const panelBox = container.getBoundingClientRect();
      const delta = rowBox.top - panelBox.top - (panelBox.height - rowBox.height) / 2;

      // A step already sitting comfortably in view is left where it is; only a
      // real move is worth animating.
      if (Math.abs(delta) > 8) {
        container.scrollBy({ top: delta, behavior: 'smooth' });
      }
    });
  }

  /**
   * The furthest step the pipeline has opened for this thread.
   *
   * Deliberately not the *selected* card: clicking back to an earlier step to
   * read its inspector must not close sections the reviewer has already earned.
   */
  private currentStepId(): string {
    // A closed ticket stands at its own closure, whichever route it took there.
    // Without this the panel goes on presenting the step the thread stopped on
    // as the live one, and offers its row of buttons for work the closure has
    // already ended.
    if (this.isSelectedTicketClosed) {
      return TICKET_CLOSED_NODE_ID;
    }

    // An agreement thread has thirteen stages between the step that opens them
    // and the reply. While it is on one of them that stage is where it stands;
    // once all thirteen have passed the routes below take over again and land
    // it on the reply.
    const agreementNodeId = this.currentAgreementNodeId();

    if (agreementNodeId) {
      return agreementNodeId;
    }

    // A system-raised non-payment thread has only two steps — raise the ticket,
    // then reply — so it stands at the reply from the moment it has a ticket.
    if (this.isNonPaymentSystemThread) {
      return this.ticketId ? 'node-6' : 'node-1';
    }

    // A non-payment thread has no instrument to match and no receipt to draft;
    // its pipeline ends at the reply. See getWorkflowNodes().
    if (this.isNonPaymentThread) {
      if (this.isUnitMatched) return 'node-6';
      if (this.isUnitMatchStarted) return 'node-3';
      if (this.isEmailVerificationStarted) return 'node-2';

      return 'node-1';
    }

    // Every payment already on the books: the money steps are not on this
    // pipeline at all, and the thread stands at the reply. Checked before them,
    // or the panel would go on offering node 4's row for a step that is done.
    if (this.isAllDuplicateThread) return 'node-6';

    // Reconciled and confirmed: the furthest real step the pipeline has —
    // Info Receipt itself has no completion of its own to stand at instead.
    if (this.isReadyForFinalResponse) return 'node-11';
    if (this.isBankReconciliationStarted) return 'node-5';
    if (this.isInstrumentMatchStarted) return 'node-4';
    if (this.isUnitMatchStarted) return 'node-3';
    if (this.isEmailVerificationStarted) return 'node-2';

    return 'node-1';
  }

  /**
   * Handles a button belonging to one of the thirteen agreement stages.
   *
   * Returns true when the id was one of theirs, so the caller can stop. Their
   * Email Response button is not handled here — it carries the same
   * 'email-response' id the two response steps' do, and opens the same
   * drafting flow, which already reads the current step to pick its template.
   */
  private onAgreementAction(actionId: string): boolean {
    const verifyPrefix = 'verify-agreement-';
    const advancePrefix = 'advance-agreement-';

    if (actionId.indexOf(verifyPrefix) === 0) {
      const step = AGREEMENT_STEPS.find((known) => known.stepKey === actionId.slice(verifyPrefix.length));

      if (step) {
        this.verifyAgreementStep(step);
      }

      return true;
    }

    if (actionId.indexOf(advancePrefix) === 0) {
      const step = AGREEMENT_STEPS.find((known) => known.stepKey === actionId.slice(advancePrefix.length));

      if (step) {
        this.openNextAgreementStep(step);
      }

      return true;
    }

    return false;
  }

  /**
   * Instrument Match passed and every payment was already on the books.
   *
   * The one condition behind three decisions — which cards the pipeline draws,
   * which step the panel is working, and whether node 6 is open — so it is
   * computed once here rather than three times from the same three flags.
   */
  private get isAllDuplicateThread(): boolean {
    return (
      this.isInstrumentMatchStarted &&
      this.instrumentMatch?.status === 'DONE' &&
      this.instrumentMatch?.skipsNextStep === true
    );
  }

  /**
   * Node 11 — Final Email Response — the closing email that comes after
   * Info Receipt, offering to close the ticket once the RPA/ledger side is
   * done. Info Receipt itself has no real completion of its own yet (its
   * evaluate/execute are unimplemented), so this reads the furthest real
   * signal the pipeline actually has: Bank Reconciliation reconciled and
   * reviewer-confirmed.
   *
   * Only for a genuine reconciled payment thread — a non-payment thread and
   * an all-duplicate one already end at node 6's own reply, ticket-close
   * included, and Info Receipt itself is hidden for both of those the same
   * way (see getWorkflowNodes()'s nonPaymentSteps / duplicateOnlySteps).
   */
  private get isReadyForFinalResponse(): boolean {
    return (
      !this.isNonPaymentThread &&
      !this.isAllDuplicateThread &&
      this.isBankReconciliationStarted &&
      this.bankReconciliation?.status === 'DONE' &&
      this.bankReconciliationConfirmed
    );
  }

  /**
   * True when the selected thread was classified "Non-Payment - Customer".
   *
   * These threads are queries, not payments — a document request, a statement
   * ask, a complaint — so there is no instrument to trace, nothing to reconcile
   * and no receipt to raise. The pipeline ends at Unit Match with a reply to the
   * customer instead.
   *
   * Matched on the category with its punctuation stripped, since the column
   * holds display text ("Non-Payment - Customer", "Payment - Unverified")
   * rather than a code.
   *
   * The old bare "Non-Payment" was split into two categories and is no longer
   * written; "Non-Payment - System" is deliberately NOT matched here — it is a
   * separate category with no pipeline path of its own yet. Kept in step with
   * IsNonPaymentCategory() in EmailAutomationController.cs, which gates the
   * same thing on the backend.
   */
  get isNonPaymentThread(): boolean {
    return this.normalizedCategory === 'nonpaymentcustomer';
  }

  /**
   * True when the selected thread was classified "Non-Payment - System".
   *
   * Raised by the system rather than written in by a customer, so there is no
   * sender to check against the customer master and no unit to match — the
   * two middle steps of the Customer pipeline have nothing to work on. Its
   * pipeline is the two steps that remain: raise the ticket, then reply.
   *
   * Deliberately its own flag rather than folded into isNonPaymentThread():
   * that one still means the Customer half alone, and every gate reading it
   * (Unit Match's confirm gate, the reply's own blockedBy, …) is about steps
   * this category does not have.
   */
  get isNonPaymentSystemThread(): boolean {
    return this.normalizedCategory === 'nonpaymentsystem';
  }

  /**
   * True when the selected thread runs the Agreement Workflow's thirteen stages.
   *
   * All three conditions, and only all three: a category of
   * 'Non-Payment - Customer', an Intent of 'Agreement' and a Sub-Intent of
   * 'Agreement'. A Non-Payment - System thread, a Non-Payment thread about
   * anything else, or an agreement mentioned on a payment thread keeps the
   * pipeline it has today — the stages are inserted into the route, never
   * bolted onto every thread.
   *
   * The System half was included at first and the client has since scoped the
   * thirteen stages to customer-raised threads, so a System agreement thread
   * now keeps its plain two-step route (ticket, then reply).
   *
   * Kept in step with IsAgreementThread() in EmailAutomationController, which
   * makes the same test before it will write any of the thirteen columns.
   */
  get isAgreementThread(): boolean {
    return (
      this.normalizedCategory === 'nonpaymentcustomer' &&
      this.isAgreementValue(this.selectedRow?.intent) &&
      this.isAgreementValue(this.selectedRow?.subIntent)
    );
  }

  /** The one Intent/Sub-Intent value that opens the agreement stages. */
  private isAgreementValue(value: string | undefined): boolean {
    return (value || '').trim().toLowerCase() === 'agreement';
  }

  /**
   * The step the agreement stages open off the back of has passed.
   *
   * Only a Customer thread runs the stages now, and it reaches them once its
   * unit is matched — the last step it had before.
   */
  private get isAgreementWorkflowOpen(): boolean {
    return this.isAgreementThread && this.isUnitMatched;
  }

  /**
   * One agreement stage has passed.
   *
   * Read from the row rather than from this visit's results: the verdict is
   * stored, so a thread reopened tomorrow resumes exactly where it stopped
   * instead of starting the thirteen again.
   */
  private isAgreementStepDone(step: AgreementStep): boolean {
    const verdict = this.selectedRow?.agreementSteps?.[step.stepKey];

    return (verdict || '').trim().toLowerCase() === 'match';
  }

  /** When it passed, ISO 8601, or '' — only a pass is ever stamped. */
  private agreementStepDate(step: AgreementStep): string {
    return this.selectedRow?.agreementStepDates?.[step.stepKey] || '';
  }

  /**
   * The stage is next in line: everything before it has passed, and it has not.
   * This is the strict sequence, and the same one the backend enforces.
   */
  private isAgreementStepReachable(step: AgreementStep): boolean {
    if (!this.isAgreementWorkflowOpen) {
      return false;
    }

    const previous = previousAgreementStep(step.nodeId);

    return !previous || this.isAgreementStepDone(previous);
  }

  /**
   * The stage is on screen: the reviewer has clicked through to it, or it has
   * already passed.
   *
   * Deliberately NOT the same test as isAgreementStepReachable. A stage can be
   * next in line — everything before it has passed — and still not be shown,
   * because showing it is what the previous stage's "Move to …" button does.
   * Verifying a stage leaves the one after it closed; only the click-through
   * opens it. That is how Unit Match has always followed Customer Email
   * Verification, and the thirteen follow one another the same way.
   */
  private isAgreementStepOpen(step: AgreementStep): boolean {
    if (!this.isAgreementWorkflowOpen) {
      return false;
    }

    return this.openedAgreementSteps[step.nodeId] === true || this.isAgreementStepDone(step);
  }

  /**
   * Opens the stages a thread has already been through, plus the one it stopped
   * on, when it is selected.
   *
   * Without this a thread reopened tomorrow would show no stage at all — the
   * click-throughs that opened them happened in a session that is over. Every
   * stage that passed is open because it visibly did, and the first that has
   * not is open because it is the one being worked; nothing past it is, which
   * is the same line this draws during a session.
   */
  private seedOpenedAgreementSteps(): void {
    if (!this.isAgreementThread) {
      return;
    }

    const opened: { [nodeId: string]: boolean } = {};

    for (const step of AGREEMENT_STEPS) {
      opened[step.nodeId] = true;

      // The first stage that has not passed is the last one to open: it is
      // where the thread stopped, and what follows it has not been handed over.
      if (!this.isAgreementStepDone(step)) {
        break;
      }
    }

    this.openedAgreementSteps = opened;
  }

  /** Every one of the thirteen has passed, so the reply is all that is left. */
  private get areAllAgreementStepsDone(): boolean {
    return (
      this.isAgreementWorkflowOpen &&
      AGREEMENT_STEPS.every((step) => this.isAgreementStepDone(step))
    );
  }

  /**
   * The agreement stage the panel is working, or '' when the thread is not on
   * one — it has not reached them, or it has finished all thirteen.
   *
   * The reviewer's own click-through wins while it still names a stage they
   * have earned; otherwise the pipeline stands at the first stage that has not
   * passed, which is what a thread reopened later stands at.
   */
  private currentAgreementNodeId(): string {
    if (!this.isAgreementWorkflowOpen || this.areAllAgreementStepsDone) {
      return '';
    }

    const open = AGREEMENT_STEPS.filter((step) => this.isAgreementStepOpen(step));

    if (open.length === 0) {
      return '';
    }

    // The open stage still being worked. When every open stage has passed, the
    // thread stands on the last of them — which is what puts its "Move to …"
    // button on screen, and that button is the only way the next one opens.
    const working = open.find((step) => !this.isAgreementStepDone(step));

    return (working || open[open.length - 1]).nodeId;
  }

  /**
   * Verifies one agreement stage: records the reviewer's confirmation, stamps
   * it, and opens the stage after it.
   *
   * Refused when the stage is not the one in line. The backend refuses it too
   * — that is what makes the order real rather than advisory — but a button
   * that cannot work should not send a request to be told so.
   */
  private verifyAgreementStep(step: AgreementStep): void {
    const row = this.selectedRow;

    if (!row || !this.date || !this.isAgreementStepReachable(step)) {
      return;
    }

    this.verifyingAgreementNodeId = step.nodeId;
    this.selectNode(step.nodeId);
    this.clearVerifyPrompt();
    this.triggerAction(`${step.title} started`);

    this.cancelStepInFlight();
    this.stepSubscription = this.agreementStep
      .verify({ row, date: this.date }, step)
      .subscribe({
        next: (result) => {
          this.agreementResults[step.nodeId] = result;
          this.verifyingAgreementNodeId = '';

          if (result.status === 'DONE') {
            // Mirrored onto the row so the stage stays passed without a reload,
            // and so a later visit resumes from it — the row is what
            // isAgreementStepDone reads.
            row.agreementSteps = { ...(row.agreementSteps || {}), [step.stepKey]: 'Match' };
            this.mirrorMatchStamp(result, (stamp) => {
              row.agreementStepDates = { ...(row.agreementStepDates || {}), [step.stepKey]: stamp };
            });
            this.mirrorWorkflowStatus(row, result);
          }

          this.repaint();
        },
        error: () => {
          this.verifyingAgreementNodeId = '';
          this.repaint();
        },
      });
  }

  /**
   * Hands the thread on to the stage after this one.
   *
   * This is what puts the next card on screen. Until it is pressed that stage
   * has no card and no buttons, however long ago this one passed — the reviewer
   * sees the step they are on and the ones behind it, never the one they have
   * not started.
   *
   * After the thirteenth there is no next stage, so the panel moves to the
   * reply instead.
   */
  private openNextAgreementStep(step: AgreementStep): void {
    const next = nextAgreementStep(step.nodeId);

    if (next) {
      this.openedAgreementSteps = { ...this.openedAgreementSteps, [next.nodeId]: true };
    }

    this.selectNode(next ? next.nodeId : 'node-6');
    this.repaint();
  }

  /**
   * The row's Category with its punctuation and spacing stripped.
   *
   * Only the two Non-Payment halves are branched on. 'Payment - Loan/Bank'
   * normalises to 'paymentloanbank', matches neither, and so takes the
   * Payment - Customer pipeline unchanged — which is what a loan customer
   * needs: their sender still has to be verified, their unit matched, their
   * payments checked and reconciled. The only thing different about such a row
   * is where its values are stored, and the backend settles that from the
   * thread key it is handed (see ResolveBinding), so nothing here has to know.
   */
  private get normalizedCategory(): string {
    return (this.selectedRow?.category || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  /** Node 3 came back matched — what opens the step after it, either way. */
  private get isUnitMatched(): boolean {
    return this.isUnitMatchStarted && this.unitMatch?.status === 'DONE';
  }

  /**
   * Whatever the pipeline is waiting on right now, as a sentence — or '' when
   * nothing is running.
   *
   * Saving a correction counts as busy too: the save and the step re-run that
   * follows it read as one operation to the reviewer, so the indicator should not
   * blink off between them.
   */
  /**
   * True while any step's call is in flight. Drives the spinner in the panel
   * header, so a run that was kicked off from a card further down the pipeline
   * is still visible once the reviewer has scrolled away from that card.
   */
  get isPipelineBusy(): boolean {
    return this.busyLabel().length > 0;
  }

  /** Hover text for that spinner: what the pipeline is actually doing. */
  get pipelineBusyLabel(): string {
    return this.busyLabel();
  }

  private busyLabel(): string {
    if (this.isSavingEdit) return 'Saving your correction…';
    if (this.isVerifying) return 'Checking the sender against the customer master…';
    if (this.isMatchingUnit) return 'Matching the unit against the booking master…';
    if (this.isMatchingInstrument) return 'Searching the bank statement workbooks…';
    if (this.isReconciling) return 'Reconciling instrument numbers and amounts…';
    if (this.isResumingPaymentSteps) return 'Reading this thread’s payment verdicts…';

    return '';
  }

  private buildStage(): ThreadStageView {
    const nodes = this.getWorkflowNodes();
    const stepId = this.currentStepId();
    const node = nodes.find((candidate) => candidate.id === stepId);
    const busyLabel = this.busyLabel();
    const activeCard = CARD_BY_NODE[stepId] || null;
    const isDone = (nodeId: string) => nodes.find((n) => n.id === nodeId)?.status === 'DONE';

    /** One card's state: on screen at all, in focus, finished. */
    const card = (key: ThreadStageCardKey, visible: boolean, done: boolean): ThreadStageCard => ({
      visible,
      active: visible && activeCard === key,
      done: visible && done,
    });

    return {
      busy: busyLabel.length > 0,
      busyLabel,
      activeCard,
      cards: {
        // Node 1 is in play the moment a thread is selected — it is where the
        // pipeline starts, not something to wait for.
        ticket: card('ticket', !!this.selectedRow, isDone('node-1')),
        customer: card('customer', this.isEmailVerificationStarted, isDone('node-2')),
        unit: card('unit', this.isUnitMatchStarted, isDone('node-3')),
        // One card per step now: Payment Details belongs to Instrument Match and
        // is checked by node 4 alone, and Bank Reconciliation has its own below
        // it, which appears only once that step has started.
        payments: card('payments', this.isInstrumentMatchStarted, isDone('node-4')),
        bankReco: card('bankReco', this.isBankReconciliationStarted, isDone('node-5')),
      },
      // One card per agreement stage, and only for a thread that has them. A
      // stage's card appears once the pipeline can reach it — everything before
      // it has passed — which is the same test that decides whether its node is
      // WAITING rather than PENDING.
      agreement: AGREEMENT_STEPS.reduce((cards, step) => {
        const done = this.isAgreementStepDone(step);

        return {
          ...cards,
          [step.nodeId]: card(step.nodeId as ThreadStageCardKey, this.isAgreementStepOpen(step), done),
        };
      }, {} as { [nodeId: string]: ThreadStageCard }),
      currentStepTitle: node?.title || '',
      currentStepStatus: node?.status || 'PENDING',
      action: node?.primaryAction || null,
      gateActions: node?.gateActions || [],
      needsVerify: this.needsVerify,
    };
  }

  // ── Reviewer edits ────────────────────────────────────────────

  /**
   * Re-reads the thread's payment rows, then hands them to `then`.
   *
   * Always a fresh read: a step run since the last one rewrites the details
   * table's match columns, and the gates below decide what to ask for from them.
   */
  private loadPaymentRows(
    threadId: string,
    then: (rows: EmailReceiptDetailRow[]) => void,
    onError?: () => void
  ): void {
    this.cancelStepInFlight();
    this.stepSubscription = this.api.getReceiptDetails(this.date, threadId).subscribe({
      next: (response) => {
        this.paymentRows = response.rows || [];
        then(this.paymentRows);
        this.repaint();
      },
      error: () => {
        // Nothing to correct if the payments cannot be read; the step's own
        // error handling reports it when the reviewer retries. A caller holding
        // state on the read — a flag, a spinner — is told so it can let go.
        this.paymentRows = [];

        if (onError) {
          onError();
        }

        this.repaint();
      },
    });
  }

  /**
   * True when a payment is missing something Bank Reconciliation needs.
   *
   * The instrument number and the amount, and only those: the step searches
   * the statement on the two of them together. The customer's own account
   * number used to be checked here as well, but the workbook is picked by the
   * *Pride* account the payment settles to — see the account-last-four comment
   * in ReconcilePaymentsAgainstStatements — so the customer's never had a part
   * in this search, and it is no longer a required field anywhere.
   */
  private isMissingReconciliationField(payment: EmailReceiptDetailRow): boolean {
    return (
      this.editableValue(payment.amount) === '' ||
      this.editableValue(payment.instrumentNumber) === ''
    );
  }

  /**
   * A stored cell as it should appear in an edit box.
   *
   * The extractor writes "N/A" (and friends) where it found nothing, which is a
   * value as far as the required-field check is concerned — the reviewer would be
   * able to save it straight back and have the step fail for the same reason. So
   * those stand-ins come through as blank, which is what they actually mean.
   */
  /**
   * An account number as it should appear in an edit box.
   *
   * Masked numbers come through blank on top of the usual placeholders: the
   * pipeline needs the full one, and offering "XXXX0852" back to the reviewer
   * invites them to save it untouched and fail the same check twice.
   */
  private editableAccountNumber(value: string | undefined): string {
    const trimmed = this.editableValue(value);

    return /[xX*]/.test(trimmed) ? '' : trimmed;
  }

  private editableValue(value: string | undefined): string {
    const trimmed = (value || '').trim();
    const placeholders = ['n/a', 'na', 'none', 'null', '-', '--'];

    return placeholders.indexOf(trimmed.toLowerCase()) === -1 ? trimmed : '';
  }

  /** Node 2's gate: the row has no sender address to look up. */
  private openSenderEdit(row: EmailReceiptRow): void {
    this.openEdit({
      gate: 'node-2',
      title: 'Customer Email Required',
      description:
        'This thread has no Customer Sender address, so it cannot be checked against ' +
        'the customer master. Enter the address and the verification runs again straight away.',
      saveLabel: 'Save & Verify',
      groups: [
        {
          id: row.emailReceiptsId,
          fields: [
            {
              key: 'customerSender',
              label: 'Customer Sender',
              value: row.customerSender || '',
              placeholder: 'customer@example.com',
              required: true,
              hint:
                'Matched against EMAIL1, EMAIL2 and EMAIL3 by ' +
                'PRIDE_CUSTOMER_PORTAL_BOOKED_UNITS — the booking master first, ' +
                'then the co-applicant table if the sender is on no booking there.',
            },
          ],
        },
      ],
    });
  }

  /**
   * The distinct values one field takes across the sender's own bookings.
   *
   * Node 3 looks for Unit, Project and the sender together, so a thread whose
   * Project or Unit disagrees with the booking master matches nothing — and the
   * reviewer, told only "no match", has no way of knowing what to correct them
   * to without leaving the app. These are the bookings node 2 already read for
   * the same sender, so the popup can show the real values without a second
   * lookup and whether the thread was verified now or resumed from its stored
   * verdict.
   */
  private bookingValues(pick: (booking: CustomerBookingMatch) => string): string[] {
    return this.bookingCandidates
      .map((booking) => (pick(booking) || '').trim())
      .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  }

  /** One field's hint: what the master holds for it, or '' when nothing is known. */
  private bookingHint(pick: (booking: CustomerBookingMatch) => string): string {
    const values = this.bookingValues(pick);

    return values.length > 0 ? `Booking master has: ${values.join(', ')}` : '';
  }

  /**
   * Node 3's gate: the booking lookup did not land on a booking.
   *
   * Two situations reach it and the copy says which, because the fix is not the
   * same. Either a column the lookup needs is blank — the extractor found
   * nothing in the email — or all three are filled in and simply disagree with
   * the master, which is the case that used to read "Project & Unit Required"
   * over three fields that were visibly not empty.
   */
  private openProjectUnitEdit(row: EmailReceiptRow): void {
    const project = (row.project || '').trim();
    const unit = (row.unit || '').trim();

    // Sub Project is not one of them: the lookup matches on Unit, Project and
    // the sender, and node 3 never reads it.
    const isMissingAValue = project.length === 0 || unit.length === 0;

    this.openEdit({
      gate: 'node-3',
      title: isMissingAValue ? 'Project & Unit Required' : 'Project & Unit Do Not Match',
      description: isMissingAValue
        ? 'Unit Match looks for a booking matching Unit, Project and the sender together. ' +
          'Fill in what is missing and the match runs again straight away.'
        : `Unit Match looks for a booking matching Unit, Project and the sender together. ` +
          `Project "${project}" and Unit "${unit}" are both filled in, so one of them ` +
          `disagrees with the booking master — the sender owns a booking, just not this ` +
          `one. Correct them below and the match runs again straight away.`,
      saveLabel: 'Save & Match Unit',
      groups: [
        {
          id: row.emailReceiptsId,
          fields: [
            {
              key: 'project',
              label: 'Project',
              value: row.project || '',
              placeholder: 'e.g. Wellington',
              required: true,
              hint: this.bookingHint((booking) => booking.projectName),
            },
            {
              key: 'subProject',
              label: 'Sub Project',
              value: row.subProject || '',
              placeholder: 'e.g. K',
              hint:
                this.bookingHint((booking) => booking.subProjectName) ||
                'Optional — the booking lookup does not use it.',
            },
            {
              key: 'unit',
              label: 'Unit',
              value: row.unit || '',
              placeholder: 'e.g. 1106',
              required: true,
              // UNIT_NO is "<block> <number>" in the master and the number alone
              // on the row, so the hint shows both rather than a block code the
              // reviewer would type into a field that does not want it.
              hint: this.bookingHint((booking) => booking.unitNo),
            },
          ],
        },
      ],
    });
  }

  /**
   * Node 3's other gate: the unit matched, but its booking status is not one
   * config.json stages, so no slot — and no owner — could be worked out.
   *
   * The thread is already with the CRM head by the time this opens; this is how
   * the reviewer moves it to whoever should really answer for it. Every
   * configured user is offered, the head included, because the stage that would
   * have narrowed the list is exactly what is missing.
   */
  private openOwnerEdit(row: EmailReceiptRow): void {
    const head = this.config.fallbackUser.name;
    const names = this.config.users
      .map((user) => user.name)
      .concat(head)
      .filter((name, index, all) => name.trim().length > 0 && all.indexOf(name) === index);

    const status = this.unitMatch?.meta['Booking Status'] || '';

    this.openEdit({
      gate: 'assign-owner',
      title: 'Who Owns This Thread?',
      description:
        (status && status !== '—'
          ? `This unit's booking status ("${status}") is not one config.json stages, `
          : 'This unit has no booking status to read a stage from, ') +
        `so the thread is with ${head} for now. Pick the owner it should go to. ` +
        'Nothing is held up by this — the pipeline carries on either way.',
      saveLabel: 'Save Owner',
      groups: [
        {
          id: row.emailReceiptsId,
          fields: [
            {
              key: 'assignedTo',
              label: 'Assigned To',
              value: this.unitAssignment?.user.name || head,
              options: names,
              required: true,
              hint: 'Stored on the thread — the receipts list and the dashboards all read it.',
            },
          ],
        },
      ],
    });
  }

  /**
   * Node 4's gate: one or more instrument numbers were not found in the bank
   * statements. Only the unmatched payments are offered — re-editing one that
   * already matched would only undo a passing result.
   */
  private openInstrumentEdit(row: EmailReceiptRow): void {
    this.loadPaymentRows(row.threadId, (rows) => {
      const incomplete = rows.filter(
        (payment) => (payment.instrumentMatch || '').trim().toLowerCase() !== 'match'
      );

      if (incomplete.length === 0) {
        return;
      }

      this.openEdit({
        gate: 'node-4',
        title: 'Required Payment Details Missing',
        description:
          (incomplete.length === 1
            ? 'This payment cannot be receipted yet. '
            : `${incomplete.length} of these payments cannot be receipted yet. `) +
          'Each heading below names what that payment is short of. Every field marked * ' +
          'is required — a blank, an "N/A" or a masked account number (XXXX0852) does not ' +
          'count as a value. Pride AC No is chosen on the payment card itself. Fill these ' +
          'in, save, then press Verify to run the check again.',
        saveLabel: 'Save',
        // Every field the completeness check reads, so the reviewer fixes the row
        // in one pass rather than being sent back for the next missing one.
        groups: incomplete.map((payment) => ({
          id: payment.emailReceiptsDetailsId,
          // Says which payment and — in red — what it is short of, so the
          // reviewer knows what they are fixing before reading a field at all.
          title: this.paymentTitle(payment),
          missing: this.missingFieldsOf(payment),
          fields: [
            {
              key: 'instrumentNumber',
              label: 'Instrument Number',
              value: this.editableValue(payment.instrumentNumber),
              placeholder: 'e.g. 612716625067',
              required: true,
              hint: 'Looked up in SALES_RECEIPT together with the amount.',
            },
            {
              key: 'amount',
              label: 'Amount',
              value: this.editableValue(payment.amount),
              placeholder: 'e.g. 35230',
              required: true,
              hint: 'Must match the receipt to the paisa.',
            },
            {
              key: 'paymentMode',
              label: 'Payment Mode',
              value: this.editableValue(payment.paymentMode),
              placeholder: 'e.g. Online Payment',
              hint: 'Optional — left blank, it is taken as an online payment.',
            },
            {
              key: 'customerBank',
              label: 'Customer Bank',
              value: this.editableValue(payment.customerBank),
              placeholder: 'e.g. State Bank of India',
              hint: 'Optional — left blank, the payment is receipted without it.',
            },
            {
              key: 'customerAccountNumber',
              label: 'Customer Account Number',
              // A masked number opens the field empty: it reads as a value but
              // is not one, so the reviewer is offered the chance to supply the
              // full one rather than being shown "XXXX0852" as though it were.
              value: this.editableAccountNumber(payment.customerAccountNumber),
              placeholder: 'e.g. 1012655968',
              hint: 'Optional — left blank, the payment is receipted without it.',
            },
          ],
        })),
      });
    });
  }

  /**
   * Node 5's gate: a payment is missing a field reconciliation needs.
   *
   * Offered only for the new entries — the payments this step reconciles. One
   * already on the books is not on this card and not in this dialog.
   */
  private openPaymentFieldsEdit(payments: EmailReceiptDetailRow[]): void {
    this.openEdit({
      gate: 'node-5',
      title: 'Payment Details Incomplete',
      description:
        (payments.length === 1
          ? 'This payment is '
          : `These ${payments.length} payments are `) +
        'the ones Bank Reconciliation has to find in the bank statement. It matches on the ' +
        'instrument number and the amount, so fill in what is missing, save, then press ' +
        'Verify to reconcile again.',
      saveLabel: 'Save',
      // The same five fields the payment card shows, so a correction made from
      // either step's dialog offers the same row. Reconciliation itself reads
      // only the instrument number, the amount and the Pride account, but the
      // row still has to be complete before it can be receipted, and sending the
      // reviewer back to the other card for two of them helped nobody.
      groups: payments.map((payment) => ({
        id: payment.emailReceiptsDetailsId,
        title: this.paymentTitle(payment),
        missing: this.missingFieldsOf(payment),
        fields: [
          {
            key: 'instrumentNumber',
            label: 'Instrument Number',
            value: this.editableValue(payment.instrumentNumber),
            required: true,
            hint: 'Searched for in the statement’s Description column.',
          },
          {
            key: 'amount',
            label: 'Amount',
            value: this.editableValue(payment.amount),
            required: true,
            hint: 'Must equal the statement row to the paisa.',
          },
          {
            key: 'paymentMode',
            label: 'Payment Mode',
            value: this.editableValue(payment.paymentMode),
            placeholder: 'e.g. Online Payment',
            hint: 'Optional — left blank, it is taken as an online payment.',
          },
          {
            key: 'customerBank',
            label: 'Customer Bank',
            value: this.editableValue(payment.customerBank),
            placeholder: 'e.g. State Bank of India',
            hint: 'Optional — left blank, the payment is receipted without it.',
          },
          {
            key: 'customerAccountNumber',
            label: 'Customer Account Number',
            // A masked number opens the field empty: it reads as a value but is
            // not one, so the reviewer is offered the chance to supply the full
            // one rather than being shown "XXXX0852" as though it were.
            value: this.editableAccountNumber(payment.customerAccountNumber),
            placeholder: 'e.g. 1012655968',
            hint: 'Optional — left blank, the payment is receipted without it.',
          },
        ],
      })),
    });
  }

  /**
   * The required fields this payment is short of, named as the card names them.
   *
   * Mirrors the backend's completeness check: a blank, a placeholder ("N/A") or
   * a masked account number all read as nothing. Pride AC No is listed too even
   * though it is picked on the card rather than in the dialog — the reviewer
   * still has to know it is missing.
   *
   * The customer's own details — Payment Mode, Customer Bank, Customer Account
   * No — are not among them: they describe where the money came from rather
   * than what the receipt needs, and Instrument Match fills each in rather than
   * holding the receipt up for it. Kept in step with MissingReceiptFields() in
   * EmailAutomationController.cs.
   */
  private missingFieldsOf(payment: EmailReceiptDetailRow): string {
    const missing: string[] = [];

    if (this.editableValue(payment.instrumentNumber) === '') {
      missing.push('Instrument Number');
    }

    if (this.editableValue(payment.amount) === '') {
      missing.push('Amount');
    }

    if (this.editableValue(payment.cashHeaderAccount) === '') {
      missing.push('Pride AC No');
    }

    // Blank when nothing is missing: the dialog then shows the plain heading
    // rather than a red line claiming a gap that is not there.
    return missing.join(', ');
  }

  /** Heading for one payment's group in a multi-payment dialog. */
  private paymentTitle(payment: EmailReceiptDetailRow): string {
    const parts = [
      payment.paymentNo ? `Payment ${payment.paymentNo}` : 'Payment',
      payment.paymentMode,
      payment.amount,
    ];

    return parts.filter((part) => (part || '').trim().length > 0).join(' · ');
  }

  // ── Closing the ticket ────────────────────────────────────────

  /** True while the close call is in flight. */
  isClosingTicket = false;

  /**
   * The ticket has been closed; the panel header follows.
   *
   * Carries how the SLA finished with it — closing is what settles that, and
   * the header shows the outcome in place of the countdown it stops.
   */
  @Output() ticketClosed = new EventEmitter<{
    threadId: string;
    slaStatus: string;
    closedOn: string;
  }>();

  /**
   * The reviewer answered "Close this ticket?" inside the Email Response popup
   * and the reply has now been sent — the popup holds the answer back until
   * then, so the ticket is never closed for a reply that was discarded or that
   * failed to save.
   *
   * Yes closes it: the reply the customer has just been sent says the ticket is
   * closed, so the two must not disagree. No leaves it open — there is nothing
   * to undo, since a ticket is only ever closed by answering yes.
   */
  onEmailTicketCloseChoice(close: boolean): void {
    const row = this.selectedRow;

    if (!close || !row || !this.ticketId || this.isClosingTicket || this.isSelectedTicketClosed) {
      return;
    }

    this.isClosingTicket = true;
    this.repaint();

    this.api.closeTicket(row.threadId, this.ticketId).subscribe({
      next: (response) => {
        this.isClosingTicket = false;
        this.triggerAction(response.message || 'Ticket closed.');
        // The panel header reads the ticket from the parent, which holds the
        // status for every thread of the date — it is told rather than re-fetching.
        this.ticketClosed.emit({
          threadId: row.threadId,
          slaStatus: response.slaStatus || '',
          // The database's own stamp, so the card shows the instant that was
          // stored rather than when this browser happened to hear about it.
          closedOn: response.closedOn || '',
        });
        this.repaint();
      },
      error: () => {
        this.isClosingTicket = false;
        this.triggerAction('The ticket could not be closed. Please try again.');
        this.repaint();
      },
    });
  }

  // ── Email Response ────────────────────────────────────────────

  /**
   * A reply this pipeline has drafted, handed to the page to put in front of
   * the reviewer.
   *
   * It used to open a popup of its own from here. It now goes into the Alert
   * Response popup's compose instead — the drafted words belong beside the mail
   * they answer, the customer's latest reply and everything already sent on the
   * thread, none of which a second window over the first could show.
   */
  @Output() emailResponseDrafted = new EventEmitter<EmailResponseTemplate>();

  /**
   * Drafts the reply for the step the pipeline is on and sends it up.
   *
   * Which template that is follows currentStepId(), so the reviewer never has to
   * pick one — the step they are stuck on is the one being written about. Nodes
   * 4, 5 and 11 quote the payments, so those are read first when the panel has
   * not already loaded them.
   */
  private openEmailResponse(row: EmailReceiptRow): void {
    const stepId = this.currentStepId() as WorkflowStepId;
    const needsPayments = stepId === 'node-4' || stepId === 'node-5' || stepId === 'node-11';

    if (needsPayments && this.paymentRows.length === 0 && this.date) {
      this.loadPaymentRows(row.threadId, (rows) => this.draftEmailResponse(stepId, row, rows));
      return;
    }

    this.draftEmailResponse(stepId, row, this.paymentRows);
  }

  private draftEmailResponse(
    stepId: WorkflowStepId,
    row: EmailReceiptRow,
    payments: EmailReceiptDetailRow[]
  ): void {
    const template = this.emailTemplates.forStep(stepId, {
      row,
      ticketId: this.ticketId,
      payments,
    });

    if (template) {
      this.emailResponseDrafted.emit(template);
    }
  }

  private openEdit(request: WorkflowEditRequest): void {
    this.editRequest = request;
    this.editError = '';
    this.isSavingEdit = false;
    this.repaint();
  }

  onEditCancelled(): void {
    this.closeEdit();
  }

  private closeEdit(): void {
    this.editRequest = null;
    this.editError = '';
    this.isSavingEdit = false;
    this.repaint();
  }

  /**
   * Saves the reviewer's correction — and stops there.
   *
   * The step is deliberately not re-run: saving and checking are two decisions,
   * and running the step off the back of a save took the second one away. The
   * card keeps its gate row, so Verify is the reviewer's next click when they
   * are ready.
   *
   * The dialog stays open on failure so the value is not lost — the reviewer sees
   * why it did not save and can fix it in place.
   */
  onEditSaved(submission: WorkflowEditSubmission): void {
    const row = this.selectedRow;

    if (!row || !this.date) {
      return;
    }

    // Save is always offered, so it can be pressed on a form nothing has been
    // typed into. Say so rather than sending an empty write.
    if (Object.keys(submission.values).length === 0) {
      this.editError = 'Nothing to save yet — fill in at least one field.';
      this.repaint();
      return;
    }

    this.isSavingEdit = true;
    this.editError = '';
    this.repaint();

    // The owner picker writes the thread's owner, not a column of the receipt
    // row, so it takes the same call node 3 makes when it settles the owner
    // itself. Handled before the node branches below, which all go to the
    // receipt/payment update endpoints.
    if (submission.gate === 'assign-owner') {
      this.saveOwnerEdit(row, submission);
      return;
    }

    // Nodes 2 and 3 correct the receipt row itself; nodes 4 and 5 correct one or
    // more payment rows, so those go out as one call per row.
    if (submission.gate === 'node-2' || submission.gate === 'node-3') {
      const emailReceiptsId = Object.keys(submission.values)[0];

      this.api
        .updateReceipt(this.date, row.threadId, emailReceiptsId, submission.values[emailReceiptsId])
        .subscribe({
          next: (response) => {
            this.applyReceiptRow(row, response.row);
            this.closeEdit();
            this.needsVerify = true;
            this.triggerAction('Saved. Now press Verify to re-run this step.');
            this.repaint();
          },
          error: (error) => this.failEdit(error),
        });

      return;
    }

    const saves: Observable<unknown>[] = Object.keys(submission.values).map((detailsId) =>
      this.api.updateReceiptDetail(row.threadId, detailsId, submission.values[detailsId])
    );

    // One payment at a time, not all at once. Every one of these writes the same
    // table, and firing four together had them deadlocking against each other —
    // SQL Server picked one as the victim and the reviewer got a server error for
    // a save that was only asked to wait its turn.
    concat(...saves)
      .pipe(toArray())
      .subscribe({
        next: () => {
          this.closeEdit();
          this.paymentDetailsChanged.emit();
          this.needsVerify = true;
          this.triggerAction('Saved. Now press Verify to re-run this step.');
          this.repaint();
        },
        error: (error) => this.failEdit(error),
      });
  }

  /**
   * Stores the owner the reviewer picked.
   *
   * Deliberately does not set needsVerify: picking an owner says nothing about
   * the unit match, and sending the reviewer back to Verify would re-run node 3
   * and put the CRM head straight back over their choice.
   */
  private saveOwnerEdit(row: EmailReceiptRow, submission: WorkflowEditSubmission): void {
    const groupId = Object.keys(submission.values)[0];
    const name = (submission.values[groupId]['assignedTo'] || '').trim();

    if (!name || !this.date) {
      this.editError = 'Pick who should own this thread.';
      this.isSavingEdit = false;
      this.repaint();
      return;
    }

    this.api.assignThread(this.date, row.threadId, name).subscribe({
      next: (result) => {
        row.assignedTo = result.assignedTo;

        if (this.unitAssignment) {
          this.unitAssignment = {
            ...this.unitAssignment,
            user: { name, emailId: this.config.getEmailForUser(name) },
            needsIntervention: false,
          };
        }

        if (this.unitMatch) {
          this.unitMatch.meta['Assigned To'] = name;
          this.unitMatch.meta['Assignment'] = `${name} was assigned by the reviewer.`;
        }

        this.closeEdit();
        this.assignmentChanged.emit();
        this.triggerAction(`Thread assigned to ${name}.`);
        this.repaint();
      },
      error: (error) => this.failEdit(error),
    });
  }

  private failEdit(error: any): void {
    this.isSavingEdit = false;
    this.editError =
      error?.error?.message || error?.message || 'The correction could not be saved.';
    this.repaint();
  }

  /**
   * Copies the saved row back over the selected one, in place, so the receipts
   * grid and the thread header repaint from the same object without a reload.
   */
  private applyReceiptRow(target: EmailReceiptRow, fresh: EmailReceiptRow | null): void {
    if (!fresh) {
      return;
    }

    target.customerSender = fresh.customerSender;
    target.project = fresh.project;
    target.subProject = fresh.subProject;
    target.unit = fresh.unit;
  }

  isScrolledToBottom = false;

  toggleScroll(): void {
    if (!this.scrollContainer?.nativeElement) return;
    const el = this.scrollContainer.nativeElement;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;

    if (isAtBottom || this.isScrolledToBottom) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
      this.isScrolledToBottom = false;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      this.isScrolledToBottom = true;
    }
    this.repaint();
  }

  onScroll(): void {
    if (!this.scrollContainer?.nativeElement) return;
    const el = this.scrollContainer.nativeElement;
    this.isScrolledToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    this.repaint();
  }

  /**
   * A step the pipeline has not reached yet has nothing to inspect, so its card
   * is inert. Steps the pipeline has run (or is waiting on) stay clickable.
   */
  isSelectable(node: WorkflowNode): boolean {
    return node.status !== 'PENDING';
  }


  /**
   * The step the pipeline is actually sitting on right now — not the one
   * queued after it. Its row is highlighted and blinks.
   *
   * A step that started and then stopped for the reviewer (WAITING) is the
   * pipeline's current stage — that is the row with something to look at. When
   * nothing is WAITING, the pipeline has not opened the next step yet, so the
   * last one it actually finished is where it stands; the PENDING step queued
   * after it has nothing to show for itself yet and would send the reviewer to
   * an empty card. Searched from the back on both counts, since a card further
   * along is always the more advanced — and therefore the correct — position.
   *
   * Takes the already-built node list rather than calling getWorkflowNodes()
   * itself: the template resolves that once per pass and this runs per row.
   *
   * A running step already announces itself with its own blink and ring (see
   * `.is-running`), so a busy node is skipped here to avoid stacking two "look
   * here" treatments on one row.
   */
  focusStepId(nodes: WorkflowNode[]): string | null {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].status === 'WAITING' && !nodes[i].busy) {
        return nodes[i].id;
      }
    }

    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].status === 'DONE') {
        return nodes[i].id;
      }
    }

    return null;
  }

  /**
   * The status as the pill says it.
   *
   * WAITING is the pipeline's own word for "this step has stopped and cannot go
   * on by itself" — which to a reviewer only reads as "wait", when the opposite
   * is true: nothing moves until they do something. The pill names the action
   * instead, from `waitingReason`: "User Verification Required" when it
   * already matched and is only waiting on the reviewer's own confirmation.
   * Everything else — a step that found something to correct, or one blocked
   * by an earlier step — reads "User Intervention" (the client retired the
   * separate "User Edit Required" wording).
   *
   * The other three states already say what they mean and are left alone.
   */
  statusLabel(node: WorkflowNode): string {
    // A cosmetic override on a card that has not actually stopped for
    // anything — shown as its own plain word, none of the reason wording
    // below, which is for a gate the reviewer has something to actually do
    // about right now.
    if (node.pillStatus) {
      return node.pillStatus;
    }

    if (node.status !== 'WAITING') {
      return node.status;
    }

    if (node.waitingReason === 'verify') {
      return 'User Verification Required';
    }

    return 'User Intervention';
  }

  /**
   * statusLabel(), but in the exact five words main_email_receipts.[Action
   * Status] is allowed to hold — a WAITING node already returns one of them
   * verbatim, so only the raw DONE/PENDING/SKIPPED strings statusLabel()
   * otherwise passes straight through need mapping here.
   */
  private canonicalActionStatus(node: WorkflowNode): string {
    const label = this.statusLabel(node);

    switch (label) {
      case 'DONE':
        return 'Done';
      case 'PENDING':
        return 'Pending';
      // Stepped over on purpose, same as finished as far as a reviewer
      // filtering the grid for something to act on is concerned.
      case 'SKIPPED':
        return 'Done';
      default:
        return label;
    }
  }

  /**
   * The (date, thread, action, status) tuple last actually written to the
   * backend. repaint() can fire several times in a row with the same outcome
   * — e.g. a spinner clearing and then the result landing — and without this
   * each of those would be its own redundant request.
   */
  private lastPushedActionStatus = '';

  /**
   * Tells the backend which step this thread is stopped on right now, and
   * why, so the Email Receipts grid can show and filter on it without
   * recomputing the whole pipeline for every row it lists.
   *
   * Called only from repaint() — never from getWorkflowNodes() or the
   * template's own bindings, both of which run on every change-detection
   * pass and must never kick off a request of their own.
   */
  private syncActionStatus(): void {
    const row = this.selectedRow;

    if (!row?.threadId || !this.date) {
      return;
    }

    // A closed ticket is read-only history. The thread may already carry a
    // fresh open ticket — node 1 raises one the moment the last closes — so
    // writing this view's "Ticket Closed / Done" onto [Action] would tell the
    // grid a thread with live work has none.
    if (this.isSelectedTicketClosed) {
      return;
    }

    const nodes = this.getWorkflowNodes();
    const nodeId = this.focusStepId(nodes);
    const node = nodeId ? nodes.find((candidate) => candidate.id === nodeId) : undefined;

    if (!node) {
      return;
    }

    const actionStatus = this.canonicalActionStatus(node);
    const key = `${this.date}|${row.threadId}|${node.title}|${actionStatus}`;

    if (key === this.lastPushedActionStatus) {
      return;
    }

    this.lastPushedActionStatus = key;

    this.api.updateActionStatus(this.date, row.threadId, node.title, actionStatus).subscribe({
      next: () => {
        // Mirrored onto the row so a re-render before the next load reads the
        // value just written, the same way mirrorWorkflowStatus() does for
        // [Workflow Status].
        row.actionName = node.title;
        row.actionStatus = actionStatus;
      },
      // Best-effort: the grid's Action Status column simply stays stale for
      // this row if the write fails. Never surfaced to the reviewer — a
      // column nothing on this panel depends on must not interrupt the
      // pipeline, and the next repaint() with a different outcome retries it.
      error: () => {
        this.lastPushedActionStatus = '';
      },
    });
  }

  /** Card click. Ignored for steps not yet reached; the card still looks the same. */
  onCardClick(node: WorkflowNode): void {
    if (this.isSelectable(node)) {
      this.selectNode(node.id);
    }
  }

  selectNode(nodeId: string): void {
    this.selectedNodeId = nodeId;
    this.repaint();
  }

  /**
   * Clicking away from the pipeline clears the highlight, so a card does not
   * stay marked as picked once the reviewer has moved on to something else.
   *
   * Runs on the whole document rather than the panel: a click in the thread
   * list or the details card on either side has to drop the selection too.
   * Clicks that land on a card are left alone — onCardClick has already run by
   * the time this fires, and clearing here would undo it immediately.
   */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('.pipeline-node-card')) return;
    if (!this.selectedNodeId) return;

    this.selectedNodeId = '';
    this.repaint();
  }

  /**
   * A step is running, so whatever was saved is now being checked — the Verify
   * prompt has been answered and stops asking.
   */
  private clearVerifyPrompt(): void {
    this.needsVerify = false;
  }

  triggerAction(actionName: string): void {
    this.actionNotice = `Action Executed: ${actionName}`;
    this.repaint();

    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = setTimeout(() => {
      this.actionNotice = null;
      this.repaint();
    }, 4000);
  }

  /**
   * Narrows a step result to the three states the cards can draw. FAILED and
   * SKIPPED both stop the pipeline here, so they read as WAITING on the card and
   * carry their reason in the inspector meta.
   */
  private toNodeStatus(result: WorkflowStepResult | null): WorkflowNode['status'] {
    if (!result) {
      return 'WAITING';
    }

    return result.status === 'DONE' || result.status === 'PENDING' ? result.status : 'WAITING';
  }

  /**
   * The button a step offers, for the four steps that can now be corrected.
   *
   * Each reads the same way: a step that passed offers the click-through to the
   * next one, a step that stopped on bad data offers the popup that fixes it,
   * and a step still running offers nothing.
   */
  /**
   * The row a stopped step offers: re-run the check, or correct what it
   * checked. Both, in this order, so the reviewer learns one shape rather than
   * one per step.
   *
   * Writing to the customer is not among them. Every step used to carry its
   * own Email Response button, which put the same button on eight cards and
   * made it read as part of working a step rather than as the thing that ends
   * the thread. It now belongs to the two steps whose whole job is the reply —
   * node-6 Email Response and node-11 Final Email Response.
   *
   * The thirteen agreement stages keep one of their own (see agreementNodes):
   * a stage there is a conversation with the customer, not a check run against
   * data the pipeline already holds.
   */
  private gateActions(verifyId: string, editId: string, editLabel: string): WorkflowNodeAction[] {
    return [
      { id: verifyId, label: 'Verify', kind: 'verify' },
      { id: editId, label: editLabel, kind: 'edit' },
    ];
  }

  /**
   * The row a step offers when it already matched but is still waiting on the
   * reviewer's own confirmation — Verify alone, with no Edit & Save. There is
   * nothing on the row to correct; Verify here just re-runs the check and, on
   * the same DONE it already got, marks it confirmed.
   */
  private verifyOnlyGate(verifyId: string): WorkflowNodeAction[] {
    return [{ id: verifyId, label: 'Verify', kind: 'verify' }];
  }

  /**
   * Status + pill reason for the three steps that hold on a match until the
   * reviewer confirms it — Unit Match, Instrument Match, Bank Reconciliation.
   *
   * A result short of DONE behaves exactly as it always has: WAITING, with
   * 'edit' as the reason, matching the correction popup underneath it. DONE
   * only reads as DONE once `confirmed` says the reviewer pressed Verify on
   * it — until then it holds as WAITING too, with 'verify' as the reason, so
   * the pill reads "User Verification Required" instead of jumping straight
   * to the click-through.
   */
  private confirmableStatus(
    result: WorkflowStepResult | null,
    confirmed: boolean
  ): { status: WorkflowNode['status']; waitingReason?: 'edit' | 'verify' } {
    const status = this.toNodeStatus(result);

    if (status !== 'DONE') {
      return { status, waitingReason: status === 'WAITING' ? 'edit' : undefined };
    }

    return confirmed ? { status: 'DONE' } : { status: 'WAITING', waitingReason: 'verify' };
  }

  private emailVerificationAction(isEmailVerified: boolean): WorkflowNode['primaryAction'] {
    if (!isEmailVerified) {
      return undefined;
    }

    return this.isUnitMatchStarted
      ? undefined
      : { id: 'start-unit-match', label: 'Move to Unit Match →', kind: 'advance' };
  }

  private emailVerificationGate(isEmailVerified: boolean): WorkflowNodeAction[] | undefined {
    if (isEmailVerified || !this.isEmailVerificationStarted || this.isVerifying) {
      return undefined;
    }

    return this.gateActions('verify-customer-email', 'edit-customer-sender', 'Edit & Save');
  }

  private unitMatchAction(isUnitMatched: boolean, isUnitMatchConfirmed: boolean): WorkflowNode['primaryAction'] {
    // A non-payment thread has nowhere to advance to: the Email Response step
    // below it opens on its own once the unit is matched.
    //
    // A matched-but-not-yet-confirmed unit also has nothing to offer here yet —
    // the click-through only appears once the reviewer has pressed Verify on
    // the match itself. See isUnitMatchConfirmed in getWorkflowNodes().
    if (!isUnitMatched || this.isNonPaymentThread || !isUnitMatchConfirmed) {
      return undefined;
    }

    return this.isInstrumentMatchStarted || this.isResumingPaymentSteps
      ? undefined
      : { id: 'start-instrument-match', label: 'Move to Instrument Match →', kind: 'advance' };
  }

  private unitMatchGate(
    isUnitMatched: boolean,
    isUnitMatchConfirmed: boolean
  ): WorkflowNodeAction[] | undefined {
    // Not gated on the category. A non-payment thread skips the *confirm* gate
    // — isUnitMatchConfirmed is forced true for it in getWorkflowNodes(),
    // because it has no "Move to Instrument Match" button to hold back — but
    // that is only the matched half of this method. Its unmatched half is the
    // correction popup, and a unit that did not match needs correcting whatever
    // the thread is about. Excluding the whole method left a Non-Payment -
    // Customer thread stopped on Unit Match with no Verify and no Edit & Save:
    // the pipeline said User Intervention and then offered the reviewer nothing
    // to intervene with.
    if (!this.isUnitMatchStarted || this.isMatchingUnit) {
      return undefined;
    }

    if (!isUnitMatched) {
      return this.gateActions('verify-unit-match', 'edit-project-unit', 'Edit & Save');
    }

    // Matched. Verify until the reviewer has confirmed it, plus the owner
    // picker whenever the booking's stage left nobody to assign the thread to.
    // Composed rather than one shape or the other: these two are independent,
    // and either can be the only thing the card still wants.
    const actions: WorkflowNodeAction[] = [];

    if (!isUnitMatchConfirmed) {
      actions.push({ id: 'verify-unit-match', label: 'Verify', kind: 'verify' });
    }

    if (this.unitAssignment?.needsIntervention) {
      actions.push({ id: 'edit-thread-owner', label: 'Edit & Save', kind: 'edit' });
    }

    return actions.length > 0 ? actions : undefined;
  }

  private instrumentMatchAction(
    isInstrumentMatched: boolean,
    isInstrumentMatchConfirmed: boolean
  ): WorkflowNode['primaryAction'] {
    if (!isInstrumentMatched || !isInstrumentMatchConfirmed) {
      return undefined;
    }

    // Every payment already receipted: there is nothing to reconcile and no
    // receipt to raise, so the thread ends at the reply. Node 6 opens by itself
    // and carries its own Email Response button — the same way it does for a
    // non-payment thread — so there is nothing to advance to from here.
    if (this.instrumentMatch?.skipsNextStep) {
      return undefined;
    }

    return this.isBankReconciliationStarted
      ? undefined
      : { id: 'start-bank-reconciliation', label: 'Move to Bank Reconciliation →', kind: 'advance' };
  }

  private instrumentMatchGate(
    isInstrumentMatched: boolean,
    isInstrumentMatchConfirmed: boolean
  ): WorkflowNodeAction[] | undefined {
    if (!this.isInstrumentMatchStarted || this.isMatchingInstrument) {
      return undefined;
    }

    if (!isInstrumentMatched) {
      return this.gateActions('verify-instrument-match', 'edit-instrument-number', 'Edit & Save');
    }

    // Matched, but not yet confirmed: nothing to edit, just to verify. Not
    // offered at all once the all-duplicate skip already carried this thread
    // past the step — isInstrumentMatchConfirmed reads true there too.
    return isInstrumentMatchConfirmed ? undefined : this.verifyOnlyGate('verify-instrument-match');
  }

  /**
   * Bank Reconciliation has nothing left to click through to: once reconciled
   * and confirmed, its own gate offers Email Response directly (see
   * bankReconciliationGate) rather than a further "Move to X →" step.
   */
  private bankReconciliationAction(
    isBankReconciled: boolean,
    isBankReconciliationConfirmed: boolean
  ): WorkflowNode['primaryAction'] {
    return undefined;
  }

  private bankReconciliationGate(
    isBankReconciled: boolean,
    isBankReconciliationConfirmed: boolean
  ): WorkflowNodeAction[] | undefined {
    if (!this.isBankReconciliationStarted || this.isReconciling) {
      return undefined;
    }

    if (!isBankReconciled) {
      return this.gateActions('verify-bank-reconciliation', 'edit-payment-fields', 'Edit & Save');
    }

    // Matched, but not yet confirmed: nothing to edit, just to verify.
    if (!isBankReconciliationConfirmed) {
      return this.verifyOnlyGate('verify-bank-reconciliation');
    }

    // Reconciled and confirmed — nothing left for the reviewer to do on this
    // card. The reply now belongs to node-11 Final Email Response, which opens
    // on exactly this state (see isReadyForFinalResponse), so the thread is
    // answered one step down rather than from here.
    return undefined;
  }

  /**
   * The latest of one timestamp across the thread's payment rows, or ''.
   *
   * Instrument Match and Bank Reconciliation settle one payment at a time, so a
   * thread with three payments carries three stamps. The step is finished with
   * the thread when its last payment was decided, which is the newest of them -
   * and that is what the pill beside it is already claiming.
   *
   * Rows that never matched hold no stamp and are skipped rather than counted
   * as zero, so a part-matched thread reports when its matches happened instead
   * of nothing at all.
   */
  private latestPaymentStamp(pick: (row: EmailReceiptDetailRow) => string | undefined): string {
    const stamps = this.paymentRows
      .map((row) => (pick(row) || '').trim())
      .filter((stamp) => stamp.length > 0);

    if (stamps.length === 0) {
      return '';
    }

    return stamps.reduce((latest, stamp) =>
      new Date(stamp).getTime() > new Date(latest).getTime() ? stamp : latest
    );
  }

  getWorkflowNodes(): WorkflowNode[] {
    const route = this.routeNodes();

    return this.isSelectedTicketClosed ? this.closeOutRoute(route) : route;
  }

  /**
   * The route with the ticket's closure written onto it.
   *
   * A closed ticket is the pipeline's last word on the thread. Three things
   * follow from it.
   *
   * The reply step reads DONE. Closing is asked inside the reply itself — see
   * the Email Response popup's "Close this ticket?" — so a closed ticket is
   * evidence that reply went out, and leaving the step on "User Intervention"
   * asked the reviewer for a reply the customer has already had.
   *
   * No step offers a button. A step that was still mid-flight when the ticket
   * closed keeps its own status, because it genuinely did not finish and the
   * pipeline should still say so — but nothing here is actionable any more, and
   * a live Email Response button on a closed ticket sends a second reply
   * against a thread that is already answered.
   *
   * And the closure is the last card, whatever route the thread took to reach
   * it: Non-Payment - System stops after two steps, Non-Payment - Customer
   * after four, a reconciled payment thread runs the lot. The closed card is
   * appended to whichever of them the thread walked, so the pipeline always
   * ends by saying how it ended.
   */
  private closeOutRoute(route: WorkflowNode[]): WorkflowNode[] {
    // The two steps whose own job is the closing reply. Both offer to close the
    // ticket, and one of them is the last step of every route.
    const replySteps = ['node-6', 'node-11'];

    const closed: WorkflowNode[] = route.map((node) => {
      if (replySteps.indexOf(node.id) === -1) {
        return { ...node, primaryAction: undefined, gateActions: undefined };
      }

      return {
        ...node,
        status: 'DONE' as WorkflowNode['status'],
        // Cleared with the status they were describing: a pill override, the
        // reason a stop needed the reviewer, and what it was queued behind all
        // belong to a step that had not finished.
        pillStatus: undefined,
        waitingReason: undefined,
        blockedBy: undefined,
        detail: 'The reply went out and the ticket was closed.',
        primaryAction: undefined,
        gateActions: undefined,
      };
    });

    return closed.concat([this.ticketClosedNode()]);
  }

  /** The card that ends a closed thread's pipeline. */
  private ticketClosedNode(): WorkflowNode {
    return {
      id: TICKET_CLOSED_NODE_ID,
      // The close time reads like every other step's: the same line under the
      // title, through the same date pipe. It used to be spelled into the
      // subtitle instead, which put the one fact this card adds in a different
      // place and a different format from the rest of the pipeline.
      //
      // A ticket closed outside the app has no recorded time at all — both
      // paths that close one stamp SLA_Closed_On, so a NULL means it was never
      // closed through here. That card says nothing rather than borrowing
      // another date and presenting it as the close.
      completedAt: this.ticketClosedOn || undefined,
      title: 'Ticket Closed',
      subtitle: 'Nothing further to do',
      tag: 'AUTO',
      status: 'DONE',
      detail:
        'The thread is answered and its ticket is closed. Should the customer ' +
        'write again, node 1 raises a new ticket and the pipeline starts over ' +
        'on that one — this one stays as it ended.',
      meta: {
        'Ticket ID': this.ticketId || '—',
        'Ticket Status': 'Closed',
        'Closed On': this.ticketClosedOn || 'Not recorded',
        'SLA': this.ticketSla || '—',
        'Status': 'DONE',
      },
    };
  }

  private routeNodes(): WorkflowNode[] {
    const row = this.selectedRow;
    const threadId = row?.threadId || 'THR-DEFAULT';
    const sender = row?.customerSender || row?.customerName || 'Customer';

    // Node 2's outcome gates node 3 and supplies the master's unit/project;
    // node 3's outcome gates node 4 the same way.
    const isEmailVerified = this.emailVerification?.status === 'DONE';
    const verificationMeta = this.emailVerification?.meta || {};
    const isUnitMatched = this.isUnitMatchStarted && this.unitMatch?.status === 'DONE';

    // Node 4 is DONE only when EVERY payment matched its bank statement, so a
    // partial result (e.g. 2 of 3) stops the pipeline here rather than moving on.
    const isInstrumentMatched =
      this.isInstrumentMatchStarted && this.instrumentMatch?.status === 'DONE';

    /*
      Every payment is already on the books, so there is nothing to reconcile and
      no receipt to raise. The thread leaves the money side of the pipeline
      altogether and ends at the reply, the same way a non-payment thread does.

      This reverses the moment a payment is turned back into a new entry — the
      reviewer's own toggle, not a gate the pipeline runs on its own — which is
      what puts the money steps back.
    */
    const isAllDuplicateThread = this.isAllDuplicateThread;

    /**
     * Node 6 is open once the step that leads into it has passed — which for a
     * system-raised thread is Ticket Acknowledgement itself, the only step in
     * front of it.
     */
    const isReplyReady = this.isAgreementThread
      ? // An agreement thread answers the customer at the end of its thirteen
        // stages, not at the step that opened them. Checked before the plain
        // Customer branch, which would otherwise open the reply at Unit Match,
        // the step that opened the stages.
        this.areAllAgreementStepsDone
      : this.isNonPaymentSystemThread
        ? !!this.ticketId
        : this.isNonPaymentThread
          ? isUnitMatched
          : isAllDuplicateThread;

    // Node 5 is DONE only when every payment reconciled on instrument AND amount
    // — or was skipped, which clears the reply the same way.
    const isBankReconciled =
      isAllDuplicateThread ||
      (this.isBankReconciliationStarted && this.bankReconciliation?.status === 'DONE');

    /*
      A match on Unit Match, Instrument Match or Bank Reconciliation is not
      enough on its own to open the click-through into the next step — see
      unitMatchConfirmed and its two siblings. Each also reads the next step
      having already started as proof the confirmation already happened, so a
      resumed or reloaded thread is not asked to confirm the same match twice.

      Unit Match's confirm gate does not apply to a non-payment thread — it has
      no "Move to Instrument Match" button to gate in the first place, since its
      pipeline ends at the reply instead. Instrument Match's does not apply once
      the all-duplicate skip has already carried the thread past it, for the
      same reason.
    */
    const isUnitMatchConfirmed =
      this.isNonPaymentThread || this.unitMatchConfirmed || this.isInstrumentMatchStarted;
    const isInstrumentMatchConfirmed =
      this.instrumentMatchConfirmed || this.isBankReconciliationStarted || isAllDuplicateThread;
    const isBankReconciliationConfirmed = this.bankReconciliationConfirmed;

    const unitMatchView = this.isUnitMatchStarted
      ? this.confirmableStatus(this.unitMatch, isUnitMatchConfirmed)
      : { status: 'PENDING' as const, waitingReason: undefined };

    const instrumentMatchView = this.isInstrumentMatchStarted
      ? this.confirmableStatus(this.instrumentMatch, isInstrumentMatchConfirmed)
      : { status: 'PENDING' as const, waitingReason: undefined };

    const bankReconciliationView = isAllDuplicateThread
      ? { status: 'SKIPPED' as const, waitingReason: undefined }
      : this.isBankReconciliationStarted
        ? this.confirmableStatus(this.bankReconciliation, isBankReconciliationConfirmed)
        : { status: 'PENDING' as const, waitingReason: undefined };

    /*
      Bank Reconciliation has not started, but a payment on the card above it
      is already a New Entry — a toggle switched on while Instrument Match
      still sits at its own confirm gate, say. The pill alone reads WAITING
      instead of PENDING for that: there is already something queued for this
      step, even though it has not run. Everything else about the card stays
      exactly PENDING — the dot, the border, whether it is clickable — only
      the pill's word changes, and only while it would otherwise read PENDING.
    */
    const bankReconciliationPillStatus =
      bankReconciliationView.status === 'PENDING' &&
      this.paymentRows.some((payment) => this.isNewEntryRow(payment))
        ? ('WAITING' as const)
        : undefined;

    const nodes: WorkflowNode[] = [
      {
        id: 'node-1',
        completedAt: this.ticketCreatedOn || undefined,
        title: 'Ticket Acknowledgement',
        subtitle: 'Notify customer: ticket no + SLA',
        tag: 'AUTO',
        // Only DONE once the ticket actually exists in PRIDE_TICKET_ACJNOWLEDGEMENT.
        status: this.ticketId ? 'DONE' : 'WAITING',
        detail: this.ticketId
          ? undefined
          : 'Waiting for a ticket to be raised for this thread.',
        meta: {
          'Ticket No': this.ticketId || 'Not raised yet',
          'Thread ID': threadId,
          'Customer Email': sender,
          'SLA Commitment': this.ticketSla || 'Not raised yet',
          'Status': this.ticketId ? 'DONE' : 'WAITING',
        },
        // The pipeline only opens once the thread has a ticket number. A
        // system-raised thread has nowhere to advance to — Customer Email
        // Match is not on its pipeline at all — so the reply below it opens on
        // its own instead, the same way it does for an all-duplicate thread.
        primaryAction:
          this.ticketId && !this.isEmailVerificationStarted && !this.isNonPaymentSystemThread
            ? { id: 'start-customer-email-verification', label: 'Move to Customer Email Match →', kind: 'advance' }
            : undefined,
        // Nothing for the reviewer to press here. This step raises the ticket
        // and there is nothing on it to verify or correct; its Email Response
        // button was the one that made every card in the pipeline look like a
        // place to answer the customer from.
        gateActions: undefined,
      },
      {
        id: 'node-2',
        completedAt: this.selectedRow?.customerEmailMatchDate || undefined,
        title: 'Customer Email Verification',
        subtitle: 'Match customer email vs master',
        tag: 'HUMAN GATE',
        // Starts only when the reviewer clicks through from a raised ticket,
        // then is driven by CustomerEmailVerificationService.
        status: this.isEmailVerificationStarted
          ? this.toNodeStatus(this.emailVerification)
          : 'PENDING',
        busy: this.isVerifying,
        detail: this.customerEmailDetail(),
        meta: this.emailVerification?.meta || {
          'Sender Email': sender,
          'Master Database': 'SALES_BOOKING_DETAILS',
          'Verification Gate': this.isVerifying ? 'Checking master…' : 'Not started',
          'Status': this.isEmailVerificationStarted ? 'WAITING' : 'PENDING',
        },
        // No ticket means the pipeline has not opened for this thread yet.
        blockedBy: this.ticketId ? undefined : 'Ticket Acknowledgement',
        // Verified senders get the click-through into Unit Match; an unmatched
        // one gets the correction popup instead, which is the only way past it.
        primaryAction: this.emailVerificationAction(isEmailVerified),
        gateActions: this.emailVerificationGate(isEmailVerified),
      },
      {
        id: 'node-3',
        completedAt: this.selectedRow?.unitMatchDate || undefined,
        title: 'Unit Match',
        subtitle: 'Match unit; edit or ask customer',
        tag: 'HUMAN GATE',
        // Starts only when the reviewer clicks through from a verified sender,
        // then is driven by UnitMatchService.
        status: unitMatchView.status,
        waitingReason: unitMatchView.waitingReason,
        busy: this.isMatchingUnit,
        detail: this.unitMatchDetail(isEmailVerified),
        meta: this.unitMatch?.meta || {
          'Unit': row?.unit || '—',
          'Project': row?.project || '—',
          'Master Unit No': verificationMeta['Unit No'] || '—',
          'Master Project': verificationMeta['Project'] || '—',
          'Status': this.isMatchingUnit ? 'Matching…' : 'PENDING',
        },
        // A matched unit gets the click-through into Instrument Match; an
        // unmatched one gets the Project/Unit correction popup; a matched but
        // not yet reviewer-confirmed one gets the Verify-only row instead.
        primaryAction: this.unitMatchAction(isUnitMatched, isUnitMatchConfirmed),
        gateActions: this.unitMatchGate(isUnitMatched, isUnitMatchConfirmed),
        // Only a sender that was checked and failed blocks this step; a pipeline
        // that has simply not reached node 2 yet is just PENDING, not blocked.
        blockedBy:
          !this.isEmailVerificationStarted || this.isVerifying || isEmailVerified
            ? undefined
            : 'Customer Email Verification',
      },
      {
        id: 'node-4',
        completedAt:
          this.instrumentMatchStamp ||
          this.latestPaymentStamp((row) => row.instrumentMatchDate) ||
          undefined,
        title: 'Instrument Match',
        subtitle: 'Confirm instrument; Duplicate Check',
        tag: 'HUMAN GATE',
        // Starts only when the reviewer clicks through from a matched unit,
        // then is driven by InstrumentMatchService.
        status: instrumentMatchView.status,
        waitingReason: instrumentMatchView.waitingReason,
        busy: this.isMatchingInstrument,
        detail: this.isMatchingInstrument
          ? 'Searching the bank statement workbooks…'
          : this.instrumentMatch?.detail,
        meta: this.instrumentMatch?.meta || {
          'Instrument Status': this.isMatchingInstrument ? 'Searching statements…' : 'Pending Verification',
          'Deduplication Check': 'Queued',
          'Status': this.isInstrumentMatchStarted ? 'WAITING' : 'PENDING',
        },
        // Offered only at a full, reviewer-confirmed match — 2 of 3 leaves the
        // thread stopped here with the instrument-number correction popup, and
        // a full match not yet confirmed leaves it here with the Verify-only
        // row instead.
        primaryAction: this.instrumentMatchAction(isInstrumentMatched, isInstrumentMatchConfirmed),
        gateActions: this.instrumentMatchGate(isInstrumentMatched, isInstrumentMatchConfirmed),
        // An unmatched unit stops the pipeline at node 3.
        blockedBy: isUnitMatched || !this.isUnitMatchStarted ? undefined : 'Unit Match',
      },
      {
        id: 'node-5',
        completedAt:
          this.bankRecoStamp ||
          this.latestPaymentStamp((row) => row.bankRecoMatchDate) ||
          undefined,
        title: 'Bank Reconciliation',
        subtitle: 'Run bank-reco; stop if duplicate',
        tag: 'AUTO',
        // Starts only when the reviewer clicks through from a full instrument
        // match, then is driven by BankReconciliationService — unless every
        // payment is already on the books, in which case it has no rows to
        // reconcile and the pipeline steps over it.
        status: bankReconciliationView.status,
        waitingReason: bankReconciliationView.waitingReason,
        pillStatus: bankReconciliationPillStatus,
        busy: this.isReconciling && !isAllDuplicateThread,
        detail: isAllDuplicateThread
          ? 'Every payment on this thread is already on the books — nothing to reconcile.'
          : this.bankReconciliationDetail(),
        meta: isAllDuplicateThread
          ? {
              'Bank Reco Engine': 'Automated',
              'Payments to Reconcile': '0 — every payment is a duplicate entry',
              'Duplicate Check': 'Done at Instrument Match',
              'Status': 'SKIPPED',
            }
          : this.bankReconciliation?.meta || {
              'Bank Reco Engine': 'Automated',
              'Duplicate Check': this.isReconciling ? 'Reconciling…' : 'Queued',
              'Status': this.isBankReconciliationStarted ? 'WAITING' : 'PENDING',
            },
        // A full, reviewer-confirmed reconciliation offers Email Response
        // directly — there is no further step to click through to any more;
        // anything less offers the payment-fields correction popup, and a full
        // match not yet confirmed offers the Verify-only row instead.
        primaryAction: isAllDuplicateThread
          ? undefined
          : this.bankReconciliationAction(isBankReconciled, isBankReconciliationConfirmed),
        gateActions: isAllDuplicateThread
          ? undefined
          : this.bankReconciliationGate(isBankReconciled, isBankReconciliationConfirmed),
        // Anything short of every payment matching stops the pipeline at node 4.
        blockedBy:
          isInstrumentMatched || !this.isInstrumentMatchStarted ? undefined : 'Instrument Match',
      },
      {
        id: 'node-10',
        title: 'In4 Receipt',
        subtitle: 'Confirm receipt number (parallel)',
        tag: 'AUTO',
        status: 'PENDING',
        meta: {
          'RPA Bot Status': 'Queued',
          'Ledger Integration': 'ERP Synced',
          'Status': 'PENDING',
        },
      },
      {
        /*
          The pipeline's true last word on a reconciled payment thread: once
          the receipt itself has gone out (Bank Reconciliation's own gate) and
          Info Receipt has had its turn, this sends the closing email and is
          the one place that offers to close the ticket for this route — the
          receipt email earlier does not, since the RPA/ledger side was not
          settled yet when it went out.
        */
        id: 'node-11',
        title: 'Final Email Response',
        subtitle: 'Send final confirmation, close ticket',
        tag: 'HUMAN GATE',
        status: this.isReadyForFinalResponse ? 'WAITING' : 'PENDING',
        detail: this.isReadyForFinalResponse
          ? 'Every payment reconciled and the receipt was sent — send the final closing email and close the ticket.'
          : 'Opens once Bank Reconciliation is confirmed.',
        meta: {
          'Thread Category': row?.category || '—',
          'Customer Email': sender,
          'Response': this.isReadyForFinalResponse ? 'Awaiting final reply' : 'Queued',
          'Status': this.isReadyForFinalResponse ? 'WAITING' : 'PENDING',
        },
        gateActions: this.isReadyForFinalResponse
          ? [{ id: 'final-email-response', label: 'Final Response', kind: 'email' }]
          : undefined,
        blockedBy:
          this.isReadyForFinalResponse || !this.isBankReconciliationStarted
            ? undefined
            : 'Bank Reconciliation',
      },
      // The Agreement Workflow's thirteen stages, built from AGREEMENT_STEPS so
      // the pipeline, the cards and the templates cannot disagree about what
      // the stages are or what order they run in. They are filtered out again
      // below for every thread that is not an agreement thread.
      ...this.agreementNodes(),
      {
        /*
          The reply that ends a thread, for the three kinds that end in one:

            • a Non-Payment - Customer thread, which carries no money at all and
              so has nothing for Instrument Match onwards to do — it opens once
              the unit is matched;
            • a Non-Payment - System thread, which has no sender to verify and no
              unit to match either — it opens as soon as the ticket exists,
              which is the whole step before it;
            • a thread whose every payment turned out to be already on the books,
              which has nothing left to reconcile and no receipt to raise — it
              opens once Instrument Match passes.

          In each case something is being answered and the answer is the last
          step. The template says which of them it is answering.
        */
        id: 'node-6',
        title: 'Email Response',
        subtitle: 'Reply to the customer',
        tag: 'HUMAN GATE',
        status: isReplyReady ? 'WAITING' : 'PENDING',
        detail: !isReplyReady
          ? (this.isAgreementThread
              ? 'Opens once Ghoshvara Verification passes.'
              : this.isNonPaymentSystemThread
                ? 'Opens once the ticket is raised.'
                : this.isNonPaymentThread
                  ? 'Opens once the unit is matched.'
                  : 'Opens once Instrument Match passes.')
          : (this.isNonPaymentSystemThread
              ? 'System-raised thread — draft the reply and send it to the customer.'
              : this.isNonPaymentThread
                ? 'Non-payment thread — draft the reply and send it to the customer.'
                : 'Every payment is already on the books — tell the customer, and close the ticket.'),
        meta: {
          'Thread Category': row?.category || '—',
          'Customer Email': sender,
          'Response': isReplyReady ? 'Awaiting reply' : 'Queued',
          'Status': isReplyReady ? 'WAITING' : 'PENDING',
        },
        // One button. Closing the ticket is asked inside the reply, where the
        // answer also decides what the customer is told — see the Email Response
        // popup's "Close this ticket?" question.
        gateActions: isReplyReady
          ? [{ id: 'email-response', label: 'Email Response', kind: 'email' }]
          : undefined,
        blockedBy: this.isAgreementThread
          ? (this.areAllAgreementStepsDone
              ? undefined
              : AGREEMENT_STEPS[AGREEMENT_STEPS.length - 1].title)
          : this.isNonPaymentSystemThread
            ? (this.ticketId ? undefined : 'Ticket Acknowledgement')
            : this.isNonPaymentThread
              ? (isUnitMatched || !this.isUnitMatchStarted ? undefined : 'Unit Match')
              : (isInstrumentMatched || !this.isInstrumentMatchStarted ? undefined : 'Instrument Match'),
      },
    ];

    /*
      A system-raised thread is two steps: raise the ticket, then reply. It was
      not written in by a customer, so there is no sender address to check
      against the customer master and no unit for them to have asked about —
      Customer Email Verification and Unit Match have nothing to work on and are
      left off the pipeline rather than shown as steps that were stepped over.
    */
    /*
      An agreement thread runs the thirteen stages in between. Spliced into the
      Customer route rather than replacing it: the thread still verifies its
      sender and matches its unit first. Nothing else changes — a System thread,
      or a Non-Payment thread about anything other than an agreement, keeps
      exactly the route it has today, which is why these are two arrays and not
      one.
    */
    const agreementSteps = this.isAgreementThread ? AGREEMENT_NODE_IDS : [];

    // Never any agreement stages here: the gate is Customer-only, so a
    // system-raised thread is the same two steps whatever its intent says.
    const nonPaymentSystemSteps = ['node-1', 'node-6'];

    if (this.isNonPaymentSystemThread) {
      return nodes.filter((node) => nonPaymentSystemSteps.indexOf(node.id) !== -1);
    }

    // A non-payment thread ends at the reply; everything from Instrument Match
    // on is about money that this thread does not carry.
    const nonPaymentSteps = ['node-1', 'node-2', 'node-3', ...agreementSteps, 'node-6'];

    if (this.isNonPaymentThread) {
      return nodes.filter((node) => nonPaymentSteps.indexOf(node.id) !== -1);
    }

    /*
      Every payment is already on the books. Nothing is left to reconcile, no
      receipt number is confirmed and there is no separate closing email to
      send, so those three steps are left off the pipeline altogether rather
      than shown as steps that were stepped over — the thread's route really
      is Instrument Match → Email Response, and the pipeline should read as
      the route it took. Email Response's own reply already offers to close
      the ticket for this route (see its template's canCloseTicket), which is
      exactly what node 11 exists to add for the other one.

      They come back the moment a payment is turned back into a new entry: the
      gate says so, isAllDuplicateThread goes false, and the money steps return.
    */
    const duplicateOnlySteps = ['node-5', 'node-10', 'node-11'];

    return nodes.filter((node) => {
      // A payment thread is never an agreement thread - the gate requires a
      // "Non-Payment - Customer" category - so none of the thirteen belongs on
      // this route.
      if (AGREEMENT_NODE_IDS.indexOf(node.id) !== -1) {
        return false;
      }

      if (isAllDuplicateThread) {
        return duplicateOnlySteps.indexOf(node.id) === -1;
      }

      // Otherwise the reply step belongs to non-payment threads alone.
      return node.id !== 'node-6';
    });
  }

  /**
   * The Agreement Workflow's thirteen pipeline cards.
   *
   * Built by walking AGREEMENT_STEPS, so adding or reordering a stage is a
   * change to that list and to nothing else. Every card reads the same three
   * facts about its stage — has it passed, can it be reached, is its call in
   * flight — and those are the whole of the strict sequence:
   *
   *   • passed            → DONE, with the stored stamp under its title, and
   *                         the button that moves the panel on to the next.
   *   • next in line      → WAITING, with Email Response and Verify.
   *   • anything earlier  → PENDING, blocked by the stage in front of it.
   *
   * Returned for every thread and filtered out again for the ones that do not
   * run them, which is how the other conditional steps in this pipeline work.
   */
  private agreementNodes(): WorkflowNode[] {
    return AGREEMENT_STEPS.map((step, index) => {
      const done = this.isAgreementStepDone(step);
      // Open is the click-through; reachable is only that everything before it
      // has passed. A stage can be the second and not the first, which is a
      // stage waiting to be handed over, not one waiting on the reviewer.
      const open = this.isAgreementStepOpen(step);
      const reachable = this.isAgreementStepReachable(step);
      const busy = this.verifyingAgreementNodeId === step.nodeId;
      const previous = previousAgreementStep(step.nodeId);
      const next = nextAgreementStep(step.nodeId);
      const result = this.agreementResults[step.nodeId];

      return {
        id: step.nodeId,
        title: step.title,
        // The key activity, not the full description: the pipeline card has one
        // line under the title, and the whole of it is on the Thread Details
        // card beside it.
        subtitle: step.keyActivity,
        tag: 'HUMAN GATE' as const,
        // WAITING means the reviewer has something to do here now, so a stage
        // that has not been opened is PENDING however ready it is — the same
        // reading Unit Match has before the click-through off node 2.
        status: done ? ('DONE' as const) : open ? ('WAITING' as const) : ('PENDING' as const),
        busy,
        // Only a pass is stamped, so a stage that has not passed prints no line
        // rather than borrowing the time of the one before it.
        completedAt: done ? this.agreementStepDate(step) || undefined : undefined,
        // Nothing here was checked against a master, so a stage that is merely
        // waiting is waiting on the reviewer's own confirmation. That is
        // 'verify', not 'edit': there is nothing to correct.
        waitingReason: !done && open ? ('verify' as const) : undefined,
        detail:
          result?.detail ||
          (done
            ? `${step.title} verified.`
            : open
              ? `Confirm ${step.title.toLowerCase()}, then move on to ${next ? next.title : 'the reply'}.`
              : reachable
                ? `Opens from ${previous ? previous.title : 'the previous step'}.`
                : `Opens once ${previous ? previous.title : 'the previous step'} passes.`),
        meta: result?.meta || {
          'Step': `${index + 1} of ${AGREEMENT_STEPS.length}`,
          'Key Activity': step.keyActivity,
          'Thread ID': this.selectedRow?.threadId || '—',
          'Verified': done ? 'Yes' : 'No',
          'Next Step': next ? next.title : 'Email Response',
          'Status': done ? 'DONE' : open ? 'WAITING' : 'PENDING',
        },
        // A stage the pipeline has not reached names what is holding it, the
        // same way Unit Match names Customer Email Verification.
        blockedBy: !done && !open && previous ? previous.title : undefined,
        // Verify is what passes the stage; Email Response answers the customer
        // from it. Both belong to a stage still being worked, so a stage that
        // has passed drops them and offers only the button that hands the
        // thread on — there is nothing left here to confirm or to write about,
        // and leaving them on screen read as though it were still outstanding.
        //
        // The agreement stages are the one exception to the rule that only the
        // two response steps offer Email Response. A stage here is a
        // conversation with the customer in its own right — chasing a document,
        // agreeing a date — rather than a check the pipeline runs on data it
        // already holds, so the reply belongs on the stage that needs it.
        gateActions:
          open && !done
            ? [
                { id: 'email-response', label: 'Email Response', kind: 'email' as const },
                { id: `verify-agreement-${step.stepKey}`, label: 'Verify', kind: 'verify' as const },
              ]
            : undefined,
        // Moves the panel on. The stage after this one is already reachable the
        // moment this one passes, so this opens it rather than unlocking it.
        primaryAction: done
          ? {
              id: `advance-agreement-${step.stepKey}`,
              label: `Move to ${next ? next.title : 'Email Response'} →`,
              kind: 'advance' as const,
            }
          : undefined,
      };
    });
  }

  getSelectedNode(): WorkflowNode | undefined {
    const nodes = this.getWorkflowNodes();
    return nodes.find((n) => n.id === this.selectedNodeId) || nodes[0];
  }
}
