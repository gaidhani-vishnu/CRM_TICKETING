/**
 * Result of the Bank Reconciliation pipeline step (node-5).
 * Mirrors BankReconciliationResponse returned by the backend.
 */
export interface BankReconciliationPayment {
  paymentNo: string;
  instrumentNumber: string;
  amount: string;
  customerAccountNumber: string;
  accountLastFour: string;
  statementFile: string;
  sheetName: string;
  /** 'Match' or 'Unmatch' — written to the "Bank Reco Match" column. */
  bankRecoMatch: string;
  /** 'Match' when a duplicate entry was found, otherwise 'Unmatch'. */
  dublicateMatch: string;
  matched: boolean;
  duplicateFound: boolean;
  /** How many statement rows carried this instrument and amount. */
  matchCount: number;
  /** Amount cells filled yellow, e.g. ['G205']. */
  matchedCells: string[];
  reason: string;
  /**
   * "file|date" — which statement workbook was searched and its last record's
   * Value Date — or "file|date|reason" when no statement could be checked;
   * not a finished sentence (see EmailReceiptDetailRow.bankRecoNote
   * for how it gets read). Empty on a match; also persisted to
   * main_email_receipt_details.[Bank Reco Note] so the payment card reads it
   * without re-running the step.
   */
  bankRecoNote: string;
}

export interface BankReconciliationResponse {
  date: string;
  threadId: string;
  monthFolder: string;
  payments: BankReconciliationPayment[];
  matchedCount: number;
  totalCount: number;
  duplicateCount: number;
  /** True only when every payment on the thread reconciled. */
  allMatched: boolean;
  nextStep: string | null;
  workflowStatus: string;
  /**
   * When this step matched, ISO 8601 — the latest [Bank Reco Match Date] across
   * the thread's payment rows, read back from the stamps the write set. Blank
   * when nothing reconciled and nothing was stamped.
   *
   * What the pipeline card prints under its title, so the time is there the
   * moment the step returns rather than after the rows are fetched again.
   */
  matchDate?: string;
  message: string;
}
