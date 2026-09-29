import { Observable } from 'rxjs';

import { CustomerBookingMatch } from '../../models/customer-email-verification.model';
import { EmailReceiptDetailRow } from '../../models/email-receipt-detail.model';
import { EmailReceiptRow } from '../../models/email-receipt.model';

/**
 * Shared contracts for the Workflow Pipeline steps.
 *
 * Each pipeline-node-card in the visualizer has exactly one service implementing
 * one of the interfaces below. Today the visualizer renders the nodes statically
 * from `WorkflowVisualizer.getWorkflowNodes()`; these services are the seam that
 * static data will be replaced by, one node at a time.
 *
 * NOTE: this is scaffolding only — every method body is an intentional stub.
 */

/** Stable ids matching the node ids rendered by WorkflowVisualizer. */
export type WorkflowStepId =
  | 'node-1'
  | 'node-2'
  | 'node-3'
  | 'node-4'
  | 'node-5'
  /** Non-payment threads only: the reply that ends the pipeline after Unit Match. */
  | 'node-6'
  /**
   * The Agreement Workflow's thirteen stages, for a Non-Payment thread whose
   * Intent and Sub-Intent are both 'Agreement'. Ids and order live in
   * AGREEMENT_STEPS; they are spelled out here because a union cannot be
   * derived from a value.
   */
  | 'node-a1'
  | 'node-a2'
  | 'node-a3'
  | 'node-a4'
  | 'node-a5'
  | 'node-a6'
  | 'node-a7'
  | 'node-a8'
  | 'node-a9'
  | 'node-a10'
  | 'node-a11'
  | 'node-a12'
  | 'node-a13'
  | 'node-10'
  /** The closing email after Info Receipt, for a genuinely reconciled payment thread. */
  | 'node-11'
  /**
   * Not drafted by any pipeline step: a blank compose opened by hand for a
   * thread with main_email_receipts.[Alert Received] set. See
   * WorkflowVisualizer.openBlankEmailDraft().
   */
  | 'manual';

/** Card badge: who drives the step. */
export type WorkflowStepTag = 'AUTO' | 'HUMAN GATE' | 'DECISION';

/** Card status line. */
export type WorkflowStepStatus = 'DONE' | 'WAITING' | 'PENDING' | 'FAILED' | 'SKIPPED';

/** Everything a step needs to judge itself for one selected thread. */
export interface WorkflowStepContext {
  /** The selected email receipt row. */
  row: EmailReceiptRow;
  /** Report date of the row, e.g. '2026-08-01'. */
  date: string;
  /** Payment/instrument rows for this thread, when already loaded. */
  paymentDetails?: EmailReceiptDetailRow[];
  /** CRM owners resolved from Project + Sub Project, when already resolved. */
  assignedEmails?: string[];
}

/** What a step reports back to the card and the Step Inspector. */
export interface WorkflowStepResult {
  stepId: WorkflowStepId;
  status: WorkflowStepStatus;
  /** Key/value rows rendered in the Step Inspector panel. */
  meta: { [key: string]: string };
  /** Optional free-text line shown under the card subtitle. */
  detail?: string;
  /** Populated when status is 'WAITING' or 'FAILED' — why the pipeline stopped here. */
  blockingReason?: string;

  /**
   * When the step matched, ISO 8601, as the backend stamped it — blank or absent
   * when it did not match, since only a match is stamped.
   *
   * Carried on the result so the card can print the time as soon as the step
   * returns. The stamp is the stored one, read back from the row the step just
   * wrote, not a time this browser made up.
   */
  matchDate?: string;

  /**
   * Bookings the step resolved for the thread (node 2 only), already narrowed by
   * what the row knows about the unit.
   *
   * Carried on the result rather than fetched again by whoever needs it: the
   * lookup that produced them is the step's own, and Unit Match runs off the
   * back of it — one of them if there is one, whichever the reviewer picks if
   * there are several.
   */
  bookings?: CustomerBookingMatch[];

  /**
   * True when the step it belongs to has nothing left for the next node to do,
   * and the pipeline should jump past it (node 4 only: every payment already on
   * the books leaves Bank Reconciliation with no rows to reconcile).
   */
  skipsNextStep?: boolean;
}

/** A human gate outcome submitted from the UI. */
export interface WorkflowStepDecision {
  approved: boolean;
  /** Who acted, e.g. 'CRM2@PRIDEWORLDCITY.COM'. */
  actedBy?: string;
  /** Optional free-text note or correction supplied by the reviewer. */
  remark?: string;
  /** Field-level corrections a reviewer made before approving (e.g. { unit: 'A-601' }). */
  corrections?: { [field: string]: string };
}

/** Base contract implemented by every pipeline-node service. */
export interface WorkflowStep {
  readonly id: WorkflowStepId;
  readonly title: string;
  readonly subtitle: string;
  readonly tag: WorkflowStepTag;

  /**
   * Computes the current status + inspector meta for this step, without
   * causing any side effect. Safe to call whenever a row is selected.
   */
  evaluate(context: WorkflowStepContext): Observable<WorkflowStepResult>;
}

/** A step the engine performs on its own (tag: AUTO). */
export interface AutomatedWorkflowStep extends WorkflowStep {
  readonly tag: 'AUTO';
  /** Performs the step's side effect and reports the new state. */
  execute(context: WorkflowStepContext): Observable<WorkflowStepResult>;
}

/** A step that blocks until a person acts (tag: HUMAN GATE). */
export interface HumanGateWorkflowStep extends WorkflowStep {
  readonly tag: 'HUMAN GATE';
  /** Applies a reviewer's approve/reject (plus any corrections) and reports the new state. */
  submitDecision(
    context: WorkflowStepContext,
    decision: WorkflowStepDecision
  ): Observable<WorkflowStepResult>;
}

/** A step that routes the pipeline down one of two paths (tag: DECISION). */
export interface DecisionWorkflowStep extends WorkflowStep {
  readonly tag: 'DECISION';
  /** Returns the id of the step to continue with, or null when the pipeline should stop. */
  resolveBranch(context: WorkflowStepContext): Observable<WorkflowStepId | null>;
}

/** Thrown by every stub below until the step is implemented. */
export function notImplemented(step: string, method: string): never {
  throw new Error(`${step}.${method}() is not implemented yet.`);
}
