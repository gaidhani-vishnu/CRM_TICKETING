/**
 * One row from main_email_receipts_{date}.csv.
 * Mirrors EmailReceiptRow returned by the backend.
 */
export interface EmailReceiptRow {
  /**
   * The table's own key. Needed to write a reviewer's correction back to exactly
   * this row rather than to every row the thread has across dates.
   */
  emailReceiptsId: string;
  /**
   * The row's own thread key: a main_email_receipts.[Thread ID] for every
   * category but 'Payment - Loan/Bank', and for that one the customer's
   * [Customer Thread ID]. What the ticket is minted on, what the payment panel
   * asks for, and what every write keys on — so everything downstream stays
   * keyed on this one field whichever kind of row it is looking at.
   */
  threadId: string;
  /**
   * Set only on a 'Payment - Loan/Bank' row, where it repeats threadId: one loan
   * email covers many customers, and this row is one of them. Blank for every
   * other category, which is how a consumer recognises a loan row without
   * reading the shape of an id.
   */
  customerThreadId?: string;
  /**
   * The email itself — main_email_receipts.[Thread ID]. The same as threadId
   * except on a loan row, where it is the email the customer was one of. What is
   * still the email's own is named after it: its attachment folder, its subject.
   */
  parentThreadId?: string;
  category: string;
  runDate: string;
  emailDate: string;
  emailSubject: string;
  customerName: string;
  project: string;
  subProject: string;
  unit: string;
  customerSender: string;
  emailLink: string;
  emailBody: string;
  forwardDetails: string;
  intent: string;
  subIntent: string;
  sentiment: string;
  actionRequired: string;
  reason: string;
  confidence: string;
  customerSpecific: string;
  aiCustomerEmail: string;
  workflowStatus: string;
  turnAroundDateTime: string;
  remark?: string;
  status?: string;
  /**
   * Per-step verdicts ('Match' / 'Unmatch') written back by the pipeline. A row
   * already carrying one has had that step run, so the pipeline resumes from it
   * instead of running it again.
   */
  customerEmailMatch?: string;
  unitMatch?: string;

  /**
   * When each step matched, ISO 8601, or absent/'' when it has not.
   *
   * Written by the backend only on a match, so a value here always names a
   * moment the step actually matched - which is why the pipeline card can print
   * it under the title without checking the verdict again.
   */
  customerEmailMatchDate?: string;
  unitMatchDate?: string;

  /**
   * The Agreement Workflow's verdicts, keyed by step key ('booking-kyc',
   * 'agreement-drafting', ...) - 'Match' once that stage has been verified.
   *
   * A map rather than thirteen fields because the stages are a list and every
   * reader walks them as one - see AGREEMENT_STEPS, which is the only place
   * they are written down. Only stages that have actually been decided appear,
   * so a thread that runs none of them - which is every thread that is not an
   * agreement thread - carries an empty object or nothing at all.
   */
  agreementSteps?: { [stepKey: string]: string };

  /**
   * When each agreement stage was verified, ISO 8601, keyed the same way.
   *
   * Written by the backend only on a pass, exactly as unitMatchDate is, so a
   * value here always names a moment the stage actually passed - which is why
   * its card can print it under the title without checking the verdict again.
   */
  agreementStepDates?: { [stepKey: string]: string };
  /**
   * The CRM executive who owns the thread, written when Unit Match settles: the
   * first user its Project + Sub Project map to, or the configured CRM head when
   * the unit did not match. Blank until that step has run, and shown as stored —
   * never recomputed for display.
   */
  assignedTo?: string;

  /**
   * Which pipeline step the thread is currently stopped on, e.g. "Instrument
   * Match" — from main_email_receipts.[Action]. Written by the FE itself, the
   * moment it settles on the thread's current node (see the pipeline
   * visualizer's syncActionStatus()); blank until a thread has been opened at
   * least once.
   */
  actionName?: string;

  /**
   * Why it is stopped there, from main_email_receipts.[Action Status]: one of
   * 'Done', 'Pending', 'User Verification Required' or 'User Intervention' —
   * the exact words the pipeline panel's own pills show
   * (see statusLabel() in workflow-visualizer.ts). Blank until that step has
   * been opened and evaluated.
   */
  actionStatus?: string;

  /**
   * From the appended "Alert Received" bit column: whether an alert has come
   * in for this thread. Shown as a pulsing bell icon beside the Ticket ID and
   * filterable in the grid.
   */
  alertReceived?: boolean;

  /**
   * From the appended "Latest Customer Reply" column: the most recent reply
   * the customer sent on this thread. Shown in the Alert Response popup
   * underneath the original Email Body, and only when alertReceived is set.
   */
  latestCustomerReply?: string;

  /**
   * Which date's report (main_email_receipts_{sourceDate}.csv) this row came
   * from. Not a backend field — the table stamps it on every row as it loads,
   * single date or All Dates alike, so a row picked from a merged All Dates
   * list still says which file the pipeline has to open for it.
   */
  sourceDate?: string;
}

/** Response for GET {apiBaseUrl}/emailautomation/receipts?date=... */
export interface EmailReceiptsReportResponse {
  date: string;
  fileName: string;
  rows: EmailReceiptRow[];
}
