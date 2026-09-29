/**
 * Result of the Instrument Match pipeline step (node-4).
 * Mirrors InstrumentMatchResponse returned by the backend.
 *
 * The step asks two separate questions of every payment, and answers them in two
 * columns: is it already receipted (SALES_RECEIPT → [Dublicate Match]), and does
 * the row carry every field a receipt needs ([Instrument Match]).
 */
export interface InstrumentMatchPayment {
  emailReceiptsDetailsId: string;
  paymentNo: string;
  instrumentNumber: string;
  amount: string;
  /** The Pride account on the row, filled in from the receipt when it had none. */
  cashHeaderAccount: string;
  /** True when this run wrote that account onto the row. */
  cashHeaderAccountFilled: boolean;
  /** 'Match' when SALES_RECEIPT already holds this payment. */
  dublicateMatch: string;
  /** 'New Entry' / 'Duplicate Entry' — dublicateMatch in words. */
  entryStatus: string;
  /** 'Automate' for a verdict this run reached, or the stored value if untouched. */
  editType: string;
  /** 'Match' when the row carries every field a receipt needs. */
  instrumentMatch: string;
  matched: boolean;
  /** The receipt the payment was found on, when it was. */
  receiptId: string;
  receiptStatus: string;
  /** Fields the row is missing, e.g. ['Customer Account Number']. */
  missingFields: string[];
  /** Why the row is not ready, in one line. */
  reason: string;
}

export interface InstrumentMatchResponse {
  date: string;
  threadId: string;
  payments: InstrumentMatchPayment[];
  /** Payments whose row carries every field a receipt needs. */
  matchedCount: number;
  totalCount: number;
  /** Payments already on the books. */
  duplicateCount: number;
  /** Rows whose Pride account this run filled in from the receipt. */
  accountsFilledCount: number;
  /** True only when every payment on the thread is complete. */
  allMatched: boolean;
  /**
   * True when every payment is already on the books. Bank Reconciliation only
   * looks at new entries, so the thread skips it and goes to Email Response.
   */
  allDuplicates: boolean;
  /**
   * 'Bank Reconciliation' normally, 'Email Response' when every payment is
   * a duplicate, otherwise null.
   */
  nextStep: string | null;
  /**
   * When this step matched, ISO 8601, read back from the stamp the write set —
   * blank when it did not match and nothing was stamped.
   *
   * What the pipeline card prints under its title, applied to the row the moment
   * the step returns. Before this the browser had the verdict but not its time,
   * so the card stayed blank until the next page load re-read the row.
   */
  matchDate?: string;
  /** Value the backend wrote into the receipts row's "Workflow Status" column. */
  workflowStatus: string;
  message: string;
}

/** Response for POST {apiBaseUrl}/emailautomation/set-entry-status */
export interface EntryStatusResponse {
  threadId: string;
  emailReceiptsDetailsId: string;
  /** 'Unmatch' for a new entry, 'Match' for one already on the books. */
  dublicateMatch: string;
  entryStatus: string;
  /** Always 'Manual' — this endpoint is the reviewer's own verdict. */
  editType: string;
  message: string;
}
