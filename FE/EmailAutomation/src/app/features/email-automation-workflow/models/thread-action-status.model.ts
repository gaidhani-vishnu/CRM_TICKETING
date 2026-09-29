/**
 * Which pipeline step a thread is stopped on, and why.
 * Mirrors ThreadActionStatusResponse returned by the backend.
 *
 * Written by the pipeline visualizer once it settles on a thread's current
 * node, and read back from main_email_receipts.[Action] / [Action Status]
 * everywhere the Email Receipts grid shows or filters on it.
 */
export interface ThreadActionStatusResponse {
  date: string;
  threadId: string;
  /** The node's title, e.g. 'Instrument Match'. */
  action: string;
  /**
   * One of 'Done', 'Pending', 'User Verification Required' or 'User
   * Intervention' — the same words statusLabel() shows on the pipeline
   * panel's own pills.
   */
  actionStatus: string;
}

/** The only values main_email_receipts.[Action Status] is ever written as. */
export const THREAD_ACTION_STATUSES = [
  'Done',
  'Pending',
  'User Verification Required',
  'User Intervention',
] as const;

export type ThreadActionStatus = (typeof THREAD_ACTION_STATUSES)[number];
