/**
 * One row from main_email_receipt_details_{date}.csv, already filtered to a
 * single Thread ID. A thread can have several of these (e.g. one per
 * payment instrument mentioned in that email).
 * Mirrors EmailReceiptDetailRow returned by the backend.
 */
export interface EmailReceiptDetailRow {
  /** The details table's own key, for the same reason as EmailReceiptRow.emailReceiptsId. */
  emailReceiptsDetailsId: string;
  threadId: string;
  /**
   * Which customer of a loan email this payment belongs to, from
   * PRIDE_LOAN_MAIN_EMAIL_RECEIPT_DETAILS.[Customer Thread ID]. Blank for every
   * other category, whose payments are keyed on threadId alone.
   */
  customerThreadId?: string;
  /**
   * Blank on a loan payment: the loan table has no [Run Date] column, and
   * nothing renders a payment row's run date — only the receipt row's.
   */
  runDate: string;
  paymentNo: string;
  customerName: string;
  project: string;
  subProject: string;
  unit: string;
  instrumentNumber: string;
  amount: string;
  paymentMode: string;
  customerBank: string;
  customerAccountNumber: string;
  verificationFlag: string;
  workflowStatus: string;
  remark: string;
  /** Appended workflow columns. Blank until the matching pipeline step fills them in. */
  instrumentMatch?: string;
  bankRecoMatch?: string;

  /**
   * When each of the two payment-level steps matched THIS row, ISO 8601.
   *
   * Per payment, like the verdicts beside them: a thread with three payments
   * settles them one at a time. The pipeline card shows the latest across a
   * thread's rows - see WorkflowVisualizer.latestPaymentStamp().
   */
  instrumentMatchDate?: string;
  bankRecoMatchDate?: string;
  dublicateMatch?: string;
  /**
   * The collection account this payment is receipted against, picked by the
   * reviewer on the payment card. Blank until picked.
   */
  cashHeaderAccount?: string;
  /**
   * 'New Entry' or 'Duplicate Entry' — what [Dublicate Match] means in the words
   * the payment card shows. Written by Instrument Match, and by the reviewer's
   * own toggle. Blank until that step has run.
   */
  entryStatus?: string;
  /**
   * 'Automate' or 'Manual' — who last settled the duplicate verdict.
   *
   * The pipeline writes 'Automate' when it reads the verdict from SALES_RECEIPT
   * or confirms the payment against the bank statement; the toggle writes
   * 'Manual'. It is what decides whether the toggle can still be moved: the
   * system's verdicts are not the reviewer's to override, their own are theirs
   * to undo. Blank until Instrument Match has run.
   */
  editType?: string;
  /**
   * Raw facts, not a finished sentence: which statement workbook Bank
   * Reconciliation searched, and its last record's Value Date — stored as
   * "file|date", e.g. "KOTAK_SOHO_5968.xlsm|31-05-2026" — plus, only when no
   * statement could actually be checked, why: "file|date|reason". Parsed by
   * bankRecoStatementFile()/bankRecoLastValueDate()/bankRecoReason()
   * in email-payment-details.ts, which is also where what reads bold is
   * decided — this field is deliberately just the data. Set only when
   * bankRecoMatch is 'Unmatch'; blank once a later run finds the payment.
   */
  bankRecoNote?: string;
}

/** Response for GET {apiBaseUrl}/emailautomation/receipt-details?date=...&threadId=... */
export interface EmailReceiptDetailsResponse {
  date: string;
  threadId: string;
  fileName: string;
  rows: EmailReceiptDetailRow[];
}
