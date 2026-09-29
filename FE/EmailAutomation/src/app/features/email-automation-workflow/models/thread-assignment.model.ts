/**
 * Who owns a thread.
 * Mirrors ThreadAssignmentResponse returned by the backend.
 *
 * Written when Unit Match settles — the first CRM user the thread's Project +
 * Sub Project map to in config.json, or the configured fallback user when the
 * unit did not match — and read back from main_email_receipts.[Assigned To]
 * everywhere it is shown.
 */
export interface ThreadAssignmentResponse {
  date: string;
  threadId: string;
  /** The name as config.json spells it, e.g. 'KAILASH D'. */
  assignedTo: string;
  message: string;
}
