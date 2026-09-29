import { AgreementNodeId } from './agreement-step.model';
import { WorkflowNodeAction } from './workflow-node.model';

/**
 * How much of the Thread Details card is open, driven by how far the Workflow
 * Pipeline has run for the selected thread.
 *
 * The card used to show everything the moment a thread was picked, which put the
 * whole case in front of the reviewer at once. It now tracks the pipeline one
 * step at a time: each pipeline step owns one card, the card only appears once
 * its step is in play, and only the step in focus is open and highlighted. The
 * step's own advance button is mirrored into that card, so the reviewer can work
 * the thread without moving across to the pipeline panel.
 */
export interface ThreadStageView {
  /** Per-step cards: whether each is on screen, in focus, and finished. */
  cards: ThreadStageCards;

  /**
   * One card per Agreement Workflow stage, keyed by node id.
   *
   * Its own field rather than thirteen more keys on ThreadStageCards: the
   * stages are a list the panel renders by walking AGREEMENT_STEPS, and a
   * thread that does not run them - which is most threads - carries an empty
   * object here, not thirteen hidden cards.
   */
  agreement: { [nodeId: string]: ThreadStageCard };

  /**
   * Which card the pipeline is on right now, or null when the step in focus has
   * no card of its own (Info Receipt). The Thread Details panel opens this one
   * and collapses whichever it was on before.
   */
  activeCard: ThreadStageCardKey | null;

  /** Step currently in focus, e.g. 'Unit Match'. Shown as the card's stage line. */
  currentStepTitle: string;

  /** The step's own PENDING/DONE/WAITING/SKIPPED state, for the stage line's pill. */
  currentStepStatus: 'DONE' | 'WAITING' | 'PENDING' | 'SKIPPED';

  /**
   * The current step's advance button, mirrored from the pipeline panel so the
   * thread can be worked from either side. Null when the step offers none.
   */
  action: WorkflowNodeAction | null;

  /**
   * The current step's Email Response / Verify / Edit & Save row, mirrored the
   * same way, and empty whenever the step is not stopped on something.
   */
  gateActions: WorkflowNodeAction[];

  /**
   * A correction was saved and the step has not been re-run against it yet.
   *
   * Saving deliberately does not re-run anything — the reviewer may be fixing
   * several payments over several passes — so the pipeline still holds the
   * verdict from before the edit. This marks Verify as the thing to do next, so
   * a saved correction cannot sit there looking finished.
   */
  needsVerify: boolean;

  /** True while the current step's call is in flight. */
  busy: boolean;

  /** What it is doing, e.g. 'Checking the sender against the customer master…' */
  busyLabel: string;
}

/**
 * The Thread Details cards the pipeline drives, keyed by their step.
 *
 * The five named ones each have their own card written out in the panel's
 * template. An agreement stage is keyed by its own node id instead, because
 * there are thirteen of them and they are drawn by one *ngFor over
 * AGREEMENT_STEPS rather than thirteen hand-written blocks.
 */
export type ThreadStageCardKey =
  | 'ticket'
  | 'customer'
  | 'unit'
  | 'payments'
  | 'bankReco'
  | AgreementNodeId;

export interface ThreadStageCards {
  /** Step 1 · Ticket Acknowledgement → the Ticket Acknowledgement card. */
  ticket: ThreadStageCard;
  /** Step 2 · Customer Email Verification → the Customer Details card. */
  customer: ThreadStageCard;
  /** Step 3 · Unit Match → the Project & Unit card (and Assigned To with it). */
  unit: ThreadStageCard;
  /** Step 4 · Instrument Match → the Payment Details card. */
  payments: ThreadStageCard;
  /**
   * Step 5 · Bank Reconciliation → its own card, listing only the payments that
   * step processes. One card served both steps once, which made the two look
   * like the same screen shown twice.
   */
  bankReco: ThreadStageCard;
}

export interface ThreadStageCard {
  /**
   * On screen at all. False until the pipeline reaches the card's step, which is
   * why a freshly selected thread shows only Subject, Message Body and Email
   * Analysis.
   */
  visible: boolean;

  /**
   * The step the pipeline is sitting on. Its card is expanded and pulses, and it
   * carries the mirrored "move to next step" button; every other card is shut.
   */
  active: boolean;

  /** The step finished, so the card gets its green check beside the chevron. */
  done: boolean;
}

/** A card whose step the pipeline has not reached. */
const HIDDEN_CARD: ThreadStageCard = { visible: false, active: false, done: false };

/** Nothing reached yet — the state before a thread is selected. */
export const EMPTY_THREAD_STAGE: ThreadStageView = {
  cards: {
    ticket: HIDDEN_CARD,
    customer: HIDDEN_CARD,
    unit: HIDDEN_CARD,
    payments: HIDDEN_CARD,
    bankReco: HIDDEN_CARD,
  },
  // No thread selected, so no stage has been reached - and a thread that is
  // not an agreement thread leaves this empty for good.
  agreement: {},
  activeCard: null,
  currentStepTitle: '',
  currentStepStatus: 'PENDING',
  action: null,
  gateActions: [],
  needsVerify: false,
  busy: false,
  busyLabel: '',
};
