/**
 * Result of the Customer Email Verification pipeline step (node-2).
 * Mirrors CustomerEmailVerificationResponse returned by the backend.
 */
export interface CustomerBookingMatch {
  accountItemNo: string;
  bookingStatusName: string;
  projectId: string;
  projectName: string;
  subProjectId: string;
  subProjectName: string;
  unitId: string;
  unitNo: string;
  floorNo: string;
  unitTypeName: string;
  customerId: string;
  customerName: string;
}

export interface CustomerEmailVerificationResponse {
  date: string;
  threadId: string;
  /** The Customer Sender address the booked-units lookup was run with. */
  senderEmail: string;
  /** True when the sender owns at least one live booked unit. */
  matched: boolean;
  bookings: CustomerBookingMatch[];
  /**
   * The bookings above, narrowed by whatever Project / Sub Project / Unit the
   * receipt row already carries.
   *
   * One means the thread's booking is settled and Unit Match can run against it;
   * several mean the customer holds more than one unit that fits, and the
   * Project & Unit card asks the reviewer which.
   */
  candidates: CustomerBookingMatch[];
  /** 'Unit Match' when verified, otherwise null. */
  nextStep: string | null;
  /** Value the backend wrote into the CSV Status column, or null when nothing was written. */
  statusWritten: string | null;
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
