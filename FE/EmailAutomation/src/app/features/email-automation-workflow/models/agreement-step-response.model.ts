/**
 * Result of POST api/emailautomation/verify-agreement-step — one stage of the
 * Agreement Workflow, verified for one thread.
 *
 * Its own file rather than a second export from agreement-step.model.ts, which
 * holds the stage list itself and is imported by the templates, the dashboard
 * and the panel; the wire shape is only of interest to the service and the step
 * that calls it.
 */
export interface AgreementStepResponse {
  date: string;
  threadId: string;

  /** The stage that was verified, echoed back, e.g. 'agreement-drafting'. */
  stepKey: string;

  /** Its display title, e.g. 'Agreement Drafting'. */
  stepTitle: string;

  /**
   * Always true on a 200.
   *
   * These stages carry no lookup that could come back unmatched — verifying one
   * is the reviewer confirming it — so a stage that cannot pass yet is refused
   * with a 409 rather than answered with a false here. Present so this response
   * reads like every other step's.
   */
  matched: boolean;

  /** The stage after this one, or 'Email Response' after the thirteenth. */
  nextStep: string;

  /** What the backend wrote into the row's [Workflow Status]. */
  workflowStatus: string;

  /**
   * When the stage was verified, ISO 8601, read back from the stamp the write
   * set — so the card can print the time without fetching the row again.
   */
  matchDate: string;

  message: string;
}
