/**
 * View model for one pipeline-node-card in the Workflow Pipeline panel, and for
 * the Step Inspector that renders the selected card in detail.
 *
 * Kept deliberately narrow (only what the cards draw). The richer execution-side
 * contracts live in `services/workflow-steps/workflow-step.model.ts`; once those
 * services are implemented, their results will be mapped into this shape.
 */
export interface WorkflowNode {
  id: string;
  title: string;
  subtitle: string;
  tag: 'AUTO' | 'HUMAN GATE' | 'DECISION';
  /**
   * SKIPPED is a step the pipeline stepped over on purpose — it had nothing to
   * do for this thread — as opposed to one still waiting its turn (PENDING).
   */
  status: 'DONE' | 'WAITING' | 'PENDING' | 'SKIPPED';
  detail?: string;
  meta?: { [key: string]: string };
  /**
   * The one call-to-action that moves this node forward, e.g. "Move to Unit
   * Match →" once the sender is verified. Rendered by the Step Inspector as its
   * primary button; absent when the node has nothing to advance to.
   */
  primaryAction?: WorkflowNodeAction;

  /**
   * What a stopped step offers instead: Email Response, Verify, Edit & Save,
   * rendered as one row.
   *
   * A step that is missing a field, or whose check came back unmatched, no
   * longer throws the correction popup at the reviewer — it parks here and lets
   * them choose. Edit & Save only saves; Verify is what re-runs the step against
   * the saved values, and only a pass turns this back into a primaryAction.
   */
  gateActions?: WorkflowNodeAction[];

  /** Set when the node cannot run because an earlier step stopped the pipeline. */
  blockedBy?: string;

  /**
   * When this step finished, ISO 8601, for the line under the card title.
   *
   * Only ever set from a stored timestamp - the ticket's Created_Date, or the
   * step's own [<step> Match Date], which the backend writes on a match and
   * only on a match. A step with nothing recorded leaves this undefined and
   * prints no line, rather than borrowing another step's time.
   */
  completedAt?: string;

  /**
   * Why a WAITING step stopped, so the pill can say which action clears it:
   *
   *   • 'edit' — the step's own check came back incomplete or unmatched, and a
   *     correction is what unblocks it. Pill reads "User Intervention".
   *   • 'verify' — everything already matched, but the pipeline holds here for
   *     the reviewer's own confirmation before the next step opens. Pill reads
   *     "User Verification Required".
   *
   * Left undefined for a WAITING node with neither — a step blocked by an
   * earlier one, say — which keeps the generic "User Intervention" wording.
   */
  waitingReason?: 'edit' | 'verify';

  /**
   * Overrides what the pill alone shows, when a card that has not started yet
   * already has something queued for it — Bank Reconciliation reading WAITING
   * instead of PENDING once a payment is a New Entry, even though the step
   * itself has not run. Nothing else about the card follows this: the dot
   * stays hollow, the card stays unclickable, `status` is still what every
   * other reader (blockedBy, isSelectable, focusStepId, …) goes by. Only the
   * pill's colour and word read this instead, when it is set — and read it
   * plainly, with none of `waitingReason`'s wording, since nothing has
   * actually stopped here for the reviewer to act on yet.
   */
  pillStatus?: WorkflowNode['status'];

  /**
   * True while this step's call is in flight. The card shows a spinner instead of
   * its status pill — a lookup against the booking master can take a while, and
   * without it the panel is indistinguishable from one that is simply idle.
   */
  busy?: boolean;
}

/** A single button offered on a node. */
export interface WorkflowNodeAction {
  /** Stable id the visualizer switches on, e.g. 'start-unit-match'. */
  id: string;
  /** Button text, e.g. 'Move to Unit Match →'. */
  label: string;
  /**
   * How the button is drawn. 'advance' is the filled green one that moves the
   * pipeline on; the rest are the outlined choices a stopped step offers.
   */
  kind?: 'advance' | 'email' | 'verify' | 'edit' | 'close';
}
