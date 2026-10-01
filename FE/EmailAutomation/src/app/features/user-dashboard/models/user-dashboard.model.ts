/**
 * The shapes the User Dashboard renders.
 *
 * Nothing here mirrors a backend contract — the backend has no aggregation of
 * any kind. Every figure on the dashboard is counted in the browser from two
 * row-level responses that already exist: the day's receipts
 * (EmailReceiptsReportResponse) and the tickets raised for them
 * (TicketAcknowledgementResponse), joined on threadId.
 */

import { AGREEMENT_STEPS } from '../../email-automation-workflow/models/agreement-step.model';

/** One column of the intent × workflow-stage matrix. */
export type StageKey =
  | 'ack'
  | 'emailVerify'
  | 'unitMatch'
  /**
   * The Agreement Workflow's thirteen stages, as one column.
   *
   * One rather than thirteen: the matrix is intent x stage and already runs to
   * six columns, and thirteen more would make it unreadable for the sake of a
   * distinction the dashboard does not draw - it answers "what is this thread
   * waiting on", and "the agreement process" is that answer. Which of the
   * thirteen it is sits on the thread itself, in the Workflow Pipeline.
   */
  | 'agreement'
  | 'instrument'
  | 'bankReco'
  | 'finalResponse';

/** A stage column, and the data that puts a thread in it. */
export interface WorkflowStage {
  key: StageKey;
  /** Column heading, e.g. 'Unit Match'. */
  label: string;
  /**
   * The main_email_receipts.[Workflow Status] value that places a thread on this
   * stage. Empty string for Acknowledgement: a thread whose ticket has been
   * raised but which no later step has touched carries no Workflow Status yet.
   */
  workflowStatus: string;
  /** The pipeline node's own title, as the Workflow Pipeline panel names it. */
  stepTitle: string;

  /**
   * Set instead of `workflowStatus` when one column stands for several statuses.
   *
   * Only the Agreement column needs it: its thirteen stages each write their
   * own "Pending <stage>" value, and all thirteen belong in the one column.
   * Checked before `workflowStatus`, so a stage that sets both would be matched
   * by this - nothing does.
   */
  matches?: (workflowStatus: string) => boolean;
}

/**
 * The pipeline, left to right, exactly as the Workflow Pipeline panel runs it
 * (see WorkflowStepRegistryService.getSteps()).
 *
 * The stage a thread sits on is read from [Workflow Status] — written by the
 * backend as each step completes — and never from [Action]. That column is
 * serialized as `action` on the wire, so EmailReceiptRow.actionName is
 * undefined on a freshly fetched row; it is only ever set client-side by the
 * pipeline visualizer once a reviewer opens the thread.
 */
export const WORKFLOW_STAGES: WorkflowStage[] = [
  {
    key: 'ack',
    label: 'Ack',
    workflowStatus: '',
    stepTitle: 'Ticket Acknowledgement',
  },
  {
    key: 'emailVerify',
    label: 'Email Verify',
    workflowStatus: 'Pending Customer Email Match',
    stepTitle: 'Customer Email Verification',
  },
  {
    key: 'unitMatch',
    label: 'Unit Match',
    workflowStatus: 'Pending Unit Match',
    stepTitle: 'Unit Match',
  },
  {
    key: 'agreement',
    label: 'Agreement',
    // No single status of its own: it stands for all thirteen, which is what
    // `matches` is for. Left blank so nothing tries to match on it directly.
    workflowStatus: '',
    stepTitle: 'Agreement Workflow',
    matches: (workflowStatus) =>
      AGREEMENT_STEPS.some((step) => workflowStatus === `Pending ${step.title}`),
  },
  {
    key: 'instrument',
    label: 'Instrument',
    workflowStatus: 'Pending Instrument Match',
    stepTitle: 'Instrument Match',
  },
  {
    key: 'bankReco',
    label: 'Bank Reco',
    workflowStatus: 'Pending Bank Reconciliation',
    stepTitle: 'Bank Reconciliation',
  },
  {
    key: 'finalResponse',
    label: 'Final Response',
    workflowStatus: 'Pending Email Response',
    stepTitle: 'Final Email Response',
  },
];

/** The step a thread with no [Workflow Status] is on: only its ticket has been raised. */
export const ACKNOWLEDGEMENT_STEP = 'Ticket Acknowledgement';

/**
 * The pipeline's step titles, exactly as the Workflow Pipeline panel prints
 * them on its cards (routeNodes() in workflow-visualizer.ts), so a step reads
 * the same on the dashboard as on the thread it counts.
 */
export const EMAIL_VERIFICATION_STEP = 'Customer Email Verification';
export const UNIT_MATCH_STEP = 'Unit Match';
export const INSTRUMENT_MATCH_STEP = 'Instrument Match';
export const BANK_RECONCILIATION_STEP = 'Bank Reconciliation';
export const IN4_RECEIPT_STEP = 'In4 Receipt';
export const EMAIL_RESPONSE_STEP = 'Email Response';
export const FINAL_EMAIL_RESPONSE_STEP = 'Final Email Response';

const AGREEMENT_STEP_TITLES: readonly string[] = AGREEMENT_STEPS.map((step) => step.title);

/**
 * Every step a thread can be on, in pipeline order — what the matrix sorts its
 * step rows by. The Agreement Workflow's thirteen stages are listed one by one
 * here, unlike in WORKFLOW_STAGES: the matrix gives each its own row.
 */
export const STEP_ORDER: readonly string[] = [
  ACKNOWLEDGEMENT_STEP,
  EMAIL_VERIFICATION_STEP,
  UNIT_MATCH_STEP,
  ...AGREEMENT_STEP_TITLES,
  INSTRUMENT_MATCH_STEP,
  BANK_RECONCILIATION_STEP,
  IN4_RECEIPT_STEP,
  EMAIL_RESPONSE_STEP,
  FINAL_EMAIL_RESPONSE_STEP,
];

/** [Category] with its punctuation and spacing stripped, as the pipeline compares it. */
function normalizedCategory(category: string): string {
  return (category || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** True when a thread runs the Agreement Workflow's thirteen stages. */
export function isAgreementRoute(category: string, intent: string, subIntent: string): boolean {
  const isAgreement = (value: string) => (value || '').trim().toLowerCase() === 'agreement';

  return normalizedCategory(category) === 'nonpaymentcustomer' && isAgreement(intent) && isAgreement(subIntent);
}

/**
 * The steps a thread's pipeline runs, first to last.
 *
 * The same four routes the Workflow Pipeline panel draws — see the filters at
 * the end of routeNodes() in workflow-visualizer.ts, which this must be kept
 * in step with:
 *
 *   • Non-Payment - System   → ticket, then the reply.
 *   • an agreement thread    → ticket, sender, unit, the thirteen stages, reply.
 *   • Non-Payment - Customer → ticket, sender, unit, reply.
 *   • everything else        → the payment pipeline, which ends in the Final
 *                              Email Response rather than the plain reply.
 *
 * The matrix lists a sub-intent's whole route from this, so a step nobody is
 * on still shows as a row of zeros instead of being missing.
 */
export function workflowRoute(category: string, intent: string, subIntent: string): string[] {
  const kind = normalizedCategory(category);

  if (kind === 'nonpaymentsystem') {
    return [ACKNOWLEDGEMENT_STEP, EMAIL_RESPONSE_STEP];
  }

  if (kind === 'nonpaymentcustomer') {
    return [
      ACKNOWLEDGEMENT_STEP,
      EMAIL_VERIFICATION_STEP,
      UNIT_MATCH_STEP,
      ...(isAgreementRoute(category, intent, subIntent) ? AGREEMENT_STEP_TITLES : []),
      EMAIL_RESPONSE_STEP,
    ];
  }

  return [
    ACKNOWLEDGEMENT_STEP,
    EMAIL_VERIFICATION_STEP,
    UNIT_MATCH_STEP,
    INSTRUMENT_MATCH_STEP,
    BANK_RECONCILIATION_STEP,
    IN4_RECEIPT_STEP,
    FINAL_EMAIL_RESPONSE_STEP,
  ];
}

/** One count column of the matrix. */
export type ActionColumnKey = 'done' | 'verify' | 'edit' | 'processing';

/** A count column, and the [Action Status] values that put a ticket in it. */
export interface ActionColumn {
  key: ActionColumnKey;
  /** Column heading, e.g. 'User Verification'. */
  label: string;
  /** The main_email_receipts.[Action Status] values counted here. */
  statuses: string[];
}

/**
 * The matrix's columns, left to right.
 *
 * Processing is the catch-all as well as 'Pending': [Action Status] is blank
 * until a thread has been opened in the workflow screen, and a ticket nobody
 * has looked at yet is still the pipeline's to work.
 */
export const ACTION_COLUMNS: ActionColumn[] = [
  { key: 'done', label: 'Done', statuses: ['Done'] },
  { key: 'verify', label: 'User Verification', statuses: ['User Verification Required'] },
  { key: 'edit', label: 'User Edit', statuses: ['User Intervention'] },
  { key: 'processing', label: 'Processing', statuses: ['Pending'] },
];

/**
 * One open ticket, as the dashboard needs it: its receipt row and its ticket
 * row folded into a single flat record.
 *
 * Flat rather than `{ row, ticket }` so the drill-down table, its filters and
 * its free-text search all read one object with no optional chaining, and so a
 * thread that never had a ticket raised simply never becomes one of these.
 */
export interface DashboardTicket {
  threadId: string;
  /** e.g. 'TKT-2026-000201'. */
  ticketId: string;
  intent: string;
  subIntent: string;
  category: string;
  customerName: string;
  customerEmail: string;
  subject: string;

  /** Which stage column this thread falls in. */
  stage: StageKey;
  /** That stage's heading, denormalised so the table binds one field. */
  stageLabel: string;
  /** The raw [Workflow Status] the stage was derived from. '' when nothing has run. */
  workflowStatus: string;
  /**
   * The step the thread is waiting on, e.g. 'Unit Match', named as the
   * Workflow Pipeline panel names it. The matrix's third level.
   */
  step: string;
  /** Every step this thread's pipeline runs, first to last — see workflowRoute(). */
  route: string[];
  /** Which matrix column its [Action Status] counts under. */
  actionColumn: ActionColumnKey;
  /**
   * [Action Status] — 'Done', 'Pending', 'User Verification Required' or
   * 'User Intervention'. Blank until a reviewer has
   * opened the thread at least once, which is why the intervention panel
   * counts only the rows that carry one.
   */
  actionStatus: string;

  /** 'Open' or 'Closed'. */
  ticketStatus: string;
  isOpen: boolean;

  /** Display date the email arrived, e.g. '01-Sep-26'. */
  receivedOn: string;
  slaDue: string;
  /** 'On Track', 'Overdue', or 'Met' once closed. */
  slaStatus: string;
  isOverdue: boolean;
  /** Seconds left on the SLA, negative once overdue. Null with no creation stamp. */
  slaRemainingSeconds: number | null;
  /** When the ticket was raised. */
  createdDate: string;
  /**
   * When the ticket was closed, 'yyyy-MM-dd HH:mm:ss' in server time, or ''
   * while it is open or when it was closed before the stamp was written.
   */
  closedOn: string;

  /**
   * The CRM executive who owns the thread. Taken from [Assigned To] when Unit
   * Match has written it, otherwise resolved from Project + Sub Project the
   * same way the Email Receipts grid resolves it.
   */
  assignedTo: string;
  project: string;
  subProject: string;
  unit: string;

  /** Which date's report this came from — the dashboard merges several. */
  sourceDate: string;
  emailLink: string;
}

/** One arc of the intent donut. Circumference is 100, so a length *is* a percentage. */
export interface DonutSlice {
  name: string;
  total: number;
  /** Share of the donut's own total, 0–100. */
  pct: number;
  /** Arc length: pct less the surface gap separating it from its neighbour. */
  len: number;
  /** Where the arc starts, as a negative dash offset. */
  offset: number;
  /** Categorical slot 1–3, or 0 for the folded 'Other' arc. */
  slot: number;
}

/** One row of the intent legend beside the donut. */
export interface IntentCount {
  intent: string;
  total: number;
  pct: number;
  /** Colour slot 1–3, or 0 (grey) for every intent past the third. */
  slot: number;
}

/** One row of the "User Intervention Required" panel. */
export interface InterventionCount {
  status: string;
  count: number;
  /** Colour slot 1–3 in the panel's own fixed order. */
  slot: number;
}

/** One bar of the SLA / Health band. */
export interface SlaBucket {
  key: 'onTrack' | 'due8' | 'due4' | 'breach';
  label: string;
  count: number;
  /** Share of open tickets, 0–100. */
  pct: number;
}

/** One cell of the matrix: how many threads, and how many of those are overdue. */
export interface MatrixCell {
  column: ActionColumnKey | 'ALL';
  total: number;
  overdue: number;
}

/** One step line of the matrix — the third level, under a sub-intent. */
export interface StepRow {
  intent: string;
  subIntent: string;
  step: string;
  /**
   * The step's 1-based place in its route, as the Workflow Pipeline panel
   * numbers its cards — kept even when the steps before it are not listed,
   * so '02' here is STEP 02 there.
   */
  number: number;
  /** One cell per ACTION_COLUMNS entry, in that order. */
  cells: MatrixCell[];
  total: MatrixCell;
}

/** One sub-intent line of the matrix, rolled up from its step rows. */
export interface MatrixRow {
  intent: string;
  subIntent: string;
  /** One cell per ACTION_COLUMNS entry, in that order. */
  cells: MatrixCell[];
  total: MatrixCell;
  /**
   * Only the steps a ticket is on, in pipeline order. A step nobody is waiting
   * at would be a row of zeros and is left out.
   */
  steps: StepRow[];
}

/** One intent block of the matrix, rolled up from its sub-intent rows. */
export interface IntentGroup {
  intent: string;
  openCount: number;
  /** Colour slot 1–3, or 0, shared with the donut so the two agree. */
  slot: number;
  /** Aggregated column cells for the entire intent. */
  cells: MatrixCell[];
  /** Aggregated total across all columns for the intent. */
  total: MatrixCell;
  rows: MatrixRow[];
}

/** What a click on the matrix asks the drill-down to show. */
export interface DrillRequest {
  intent: string;
  /** 'ALL' when a whole intent was clicked rather than one sub-intent line. */
  subIntent: string;
  /** 'ALL' when an intent or sub-intent line was clicked rather than one step. */
  step: string;
  column: ActionColumnKey | 'ALL';
}

/** Everything the dashboard renders for the current date + user filter. */
export interface DashboardSummary {
  openCount: number;
  closedCount: number;
  overdueCount: number;
  /** Share of open tickets not overdue, 0–100. */
  slaPercent: number;
  /** Share of open tickets that are overdue, 0–100 — the Overdue tile's subtitle. */
  overduePercent: number;

  /** The Open Tickets tile's split. */
  paymentCount: number;
  nonPaymentCount: number;

  intents: IntentCount[];
  intentSlices: DonutSlice[];

  interventions: InterventionCount[];
  interventionTotal: number;

  slaBuckets: SlaBucket[];

  groups: IntentGroup[];
}

/** An empty summary, so the template binds real fields before the first load. */
export function emptyDashboardSummary(): DashboardSummary {
  return {
    openCount: 0,
    closedCount: 0,
    overdueCount: 0,
    slaPercent: 0,
    overduePercent: 0,
    paymentCount: 0,
    nonPaymentCount: 0,
    intents: [],
    intentSlices: [],
    interventions: [],
    interventionTotal: 0,
    slaBuckets: [],
    groups: [],
  };
}
