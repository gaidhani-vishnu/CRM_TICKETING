/**
 * Reviewer edits: the corrections a person makes to a row when the pipeline is
 * missing a value it needs, before the blocked step is re-run against it.
 *
 * Mirrors ReceiptUpdateRequest/Response and ReceiptDetailUpdateRequest/Response
 * on the backend.
 */

import { EmailReceiptDetailRow } from './email-receipt-detail.model';
import { EmailReceiptRow } from './email-receipt.model';

/**
 * Correctable fields on a receipt row.
 *
 * Every field is optional and only the ones present are written — an omitted
 * field is left alone rather than cleared, so the node-2 dialog can send just
 * the sender without wiping the node-3 columns.
 */
export interface ReceiptUpdateFields {
  customerSender?: string;
  project?: string;
  subProject?: string;
  unit?: string;
}

/** Response for POST {apiBaseUrl}/emailautomation/update-receipt */
export interface ReceiptUpdateResponse {
  date: string;
  threadId: string;
  /** Columns actually written, e.g. ['Customer Sender']. */
  updatedColumns: string[];
  /** The row as it now stands, for re-syncing the UI without a reload. */
  row: EmailReceiptRow;
  message: string;
}

/** Correctable fields on one payment row. */
export interface ReceiptDetailUpdateFields {
  instrumentNumber?: string;
  amount?: string;
  customerAccountNumber?: string;
  /** Read by Instrument Match's completeness check, so both are correctable. */
  paymentMode?: string;
  customerBank?: string;
  /**
   * The collection account picked on the payment card. Not a correction to
   * something a step read, but the same single-column write and audit trail.
   */
  cashHeaderAccount?: string;
}

/** Response for POST {apiBaseUrl}/emailautomation/update-receipt-detail */
export interface ReceiptDetailUpdateResponse {
  threadId: string;
  updatedColumns: string[];
  /** Every payment row of the thread, since the caller repaints the whole list. */
  rows: EmailReceiptDetailRow[];
  message: string;
}
