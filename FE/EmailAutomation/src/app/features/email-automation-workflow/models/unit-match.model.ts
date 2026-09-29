import { CustomerBookingMatch } from './customer-email-verification.model';

/**
 * Result of the Unit Match pipeline step (node-3).
 * Mirrors UnitMatchResponse returned by the backend.
 */
export interface UnitMatchResponse {
  date: string;
  threadId: string;
  /** Unit from the receipt row, matched against the part of UNIT_NO after its first space. */
  unit: string;
  senderEmail: string;
  project: string;
  /** True when a booking matched on unit + email + project together. */
  matched: boolean;
  bookings: CustomerBookingMatch[];
  /** 'Instrument Match' when matched, otherwise null. */
  nextStep: string | null;
  /** Value the backend wrote into the CSV Remark column, or null when nothing was written. */
  remarkWritten: string | null;
  /**
   * When this step matched, ISO 8601, read back from the stamp the write set —
   * blank when it did not match and nothing was stamped.
   *
   * What the pipeline card prints under its title, applied to the row the moment
   * the step returns. Before this the browser had the verdict but not its time,
   * so the card stayed blank until the next page load re-read the row.
   */
  matchDate?: string;
  /** Value the backend wrote into the row's "Workflow Status" column. */
  workflowStatus: string;
  message: string;
}
